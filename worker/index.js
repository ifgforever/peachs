// Serves byte ranges of the site's video files.
//
// Cloudflare's static-asset server answers every request with the whole file, even when the browser asks for
// part of it with a Range header. Chrome copes, but Safari (iPhone, iPad, Mac) won't play a video unless the
// server returns 206 Partial Content for those requests. wrangler.jsonc runs this Worker first for video paths
// only; every other file is served straight from static assets, as before.
//
// It also answers /loop, a short address to type with a TV remote (the Downloader app on Fire TV, a TV browser):
// it saves the 1080p entrance loop as a file, to play offline in VLC. Any video URL with ?dl=1 does the same.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/loop') {
      url.pathname = '/signage/peachs-entrance-loop-tv.mp4';
      url.search = '?dl=1';
      request = new Request(url, request);
    }
    const res = await serve(request, env, ctx);
    if (!url.searchParams.has('dl') || res.status >= 300) return res;
    const out = new Response(res.body, res);
    out.headers.set('Content-Disposition', `attachment; filename="${url.pathname.split('/').pop()}"`);
    return out;
  },
};

// Serves a video file, answering a Range header itself (see the top of this file).
async function serve(request, env, ctx) {
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
  ctx.waitUntil(copySlice(full.body, body.writable, r.start, r.end, size));
  return new Response(body.readable, { status: 206, headers: out });
}

// Streams are read in 1 MiB blocks. A plain reader.read() returns 4 KiB at a time, and looping over a 25 MB video
// that way costs far more CPU than a Worker request is allowed.
const BLOCK = 1 << 20;

// The asset response inside a Worker carries no Content-Length, so measure the file once by reading a copy to the
// end, and remember the size per ETag (the ETag is a hash of the file, so a changed file is measured again).
const sizes = new Map();
async function sizeOf(res, fetchCopy) {
  const len = Number(res.headers.get('Content-Length') ?? NaN);
  if (Number.isSafeInteger(len)) return len;
  const etag = res.headers.get('ETag');
  if (etag && sizes.has(etag)) return sizes.get(etag);
  const reader = (await fetchCopy()).body.getReader({ mode: 'byob' });
  let n = 0;
  let view = new Uint8Array(BLOCK);
  for (;;) {
    const { done, value } = await reader.readAtLeast(BLOCK, view);
    n += value?.byteLength ?? 0;
    if (done) break;
    view = new Uint8Array(value.buffer);   // reuse the block; nothing else holds it
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

// Streams bytes start..end (inclusive) of a stream into a writable. JavaScript only handles the blocks before
// `start` (to skip them) and the block where the range begins. When the range runs to the end of the file, as it
// does whenever a browser plays or seeks, the runtime pipes the rest without JavaScript in the loop. Only a range
// that stops short of the end (Safari's 2-byte probe, for one) is finished block by block.
async function copySlice(source, writable, start, end, size) {
  const toEnd = end === size - 1;
  if (start === 0 && toEnd) return source.pipeTo(writable).catch(() => {});
  const reader = source.getReader({ mode: 'byob' });
  const writer = writable.getWriter();
  let pos = 0;
  try {
    while (pos <= end) {
      // A fresh block each time: a block handed to writer.write() may still be queued when the next read starts.
      const { done, value } = await reader.readAtLeast(BLOCK, new Uint8Array(BLOCK));
      const got = value?.byteLength ?? 0;
      const a = Math.max(start - pos, 0);
      const b = Math.min(end + 1 - pos, got);
      if (a < b) await writer.write(value.subarray(a, b));
      pos += got;
      if (toEnd && pos > start && !done) {
        reader.releaseLock();
        writer.releaseLock();
        return source.pipeTo(writable).catch(() => {});
      }
      if (done) break;
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
  }
  reader.cancel().catch(() => {});
}

function withAcceptRanges(res, method) {
  if (res.status !== 200) return res;
  const out = new Response(method === 'HEAD' ? null : res.body, res);
  out.headers.set('Accept-Ranges', 'bytes');
  return out;
}
