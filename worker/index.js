// Serves byte ranges of the site's video files.
//
// Cloudflare's static-asset server answers every request with the whole file, even when the browser asks for
// part of it with a Range header. Chrome copes, but Safari (iPhone, iPad, Mac) won't play a video unless the
// server returns 206 Partial Content for those requests. wrangler.jsonc runs this Worker first for video paths
// only; every other file is served straight from static assets, as before.

export default {
  async fetch(request, env, ctx) {
    const range = request.headers.get('Range');
    if (!range || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return withAcceptRanges(await env.ASSETS.fetch(request));
    }

    // Ask for the whole file, then cut out the requested bytes.
    const headers = new Headers(request.headers);
    headers.delete('Range');
    headers.delete('If-Range');
    const full = await env.ASSETS.fetch(new Request(request.url, { method: 'GET', headers }));
    if (full.status !== 200) return full;
    const size = await sizeOf(full, () => env.ASSETS.fetch(new Request(request.url)));

    // If-Range: only send part of the file if the browser's copy is still current.
    const ifRange = request.headers.get('If-Range');
    if (ifRange && ifRange !== full.headers.get('ETag')) return withAcceptRanges(full, request.method);

    const r = parseRange(range, size);
    if (r === null) return withAcceptRanges(full, request.method);   // malformed or multi-range: ignore it
    if (r === 'unsatisfiable') {
      full.body?.cancel();
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
    }

    const out = new Headers(full.headers);
    out.set('Content-Range', `bytes ${r.start}-${r.end}/${size}`);
    out.set('Accept-Ranges', 'bytes');
    const length = r.end - r.start + 1;
    if (request.method === 'HEAD') {
      full.body?.cancel();
      out.set('Content-Length', String(length));
      return new Response(null, { status: 206, headers: out });
    }
    const body = new FixedLengthStream(length);
    ctx.waitUntil(copySlice(full.body, body.writable, r.start, r.end));
    return new Response(body.readable, { status: 206, headers: out });
  },
};

// The asset response inside a Worker carries no Content-Length, so measure the file once by reading a copy to the
// end, and remember the size per ETag (the ETag is a hash of the file, so a changed file is measured again).
const sizes = new Map();
async function sizeOf(res, fetchCopy) {
  const len = Number(res.headers.get('Content-Length') ?? NaN);
  if (Number.isSafeInteger(len)) return len;
  const etag = res.headers.get('ETag');
  if (etag && sizes.has(etag)) return sizes.get(etag);
  const reader = (await fetchCopy()).body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
  }
  if (etag) sizes.set(etag, n);
  return n;
}

// Parses a single "bytes=" range (RFC 9110 §14.1.2). Returns {start, end} (inclusive), 'unsatisfiable',
// or null when the header should be ignored and the whole file sent.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {                                  // suffix range: the last N bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

// Copies bytes start..end (inclusive) of a stream into a writable, then stops reading.
async function copySlice(source, writable, start, end) {
  const reader = source.getReader();
  const writer = writable.getWriter();
  let pos = 0;
  try {
    while (pos <= end) {
      const { done, value } = await reader.read();
      if (done) break;
      const a = Math.max(start - pos, 0);
      const b = Math.min(end + 1 - pos, value.byteLength);
      if (a < b) await writer.write(value.subarray(a, b));
      pos += value.byteLength;
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
  } finally {
    reader.cancel().catch(() => {});
  }
}

function withAcceptRanges(res, method) {
  if (res.status !== 200) return res;
  const out = new Response(method === 'HEAD' ? null : res.body, res);
  out.headers.set('Accept-Ranges', 'bytes');
  return out;
}
