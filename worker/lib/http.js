// Rome's Joy admin Worker: HTTP helpers shared by every route.

/** An error the client caused; the entry point turns it into { error, code } JSON. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const bad = (message, code = 'bad_request') => new ApiError(400, code, message);
export const unauthorized = (message = 'Please log in.') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You are not allowed to do that.', code = 'forbidden') => new ApiError(403, code, message);
export const notFound = (message = 'Not found.', code = 'not_found') => new ApiError(404, code, message);
export const conflict = (message, code = 'conflict') => new ApiError(409, code, message);
export const tooMany = (message = 'Too many tries. Please wait a few minutes.') => new ApiError(429, 'rate_limited', message);
export const notConfigured = (message, code = 'not_configured') => new ApiError(501, code, message);

export const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=60' };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Reads a JSON, form-encoded or multipart body into a plain object (repeated keys are joined). */
export async function readBody(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form) {
      if (typeof value !== 'string') continue; // files are handled by the media route
      data[key] = key in data ? `${data[key]}, ${value}` : value;
    }
    return data;
  }
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw bad('The request body must be a JSON object.', 'invalid_json');
  }
}

/** The visitor's IP as Cloudflare reports it; "local" in wrangler dev. */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || request.headers.get('X-Real-IP')
    || 'local';
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Reads ?limit= within [1, max] with a default. */
export function intParam(url, name, fallback, max = 200) {
  const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Reads ?before=<id> (a positive integer) or null. */
export function idParam(url, name) {
  const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
