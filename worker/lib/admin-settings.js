// Rome's Joy admin Worker: /api/admin/settings (TV screen settings etc.) and photo uploads to R2.
import { bad, forbidden, notConfigured, notFound, readBody } from './http.js';
import { first, parseJson, run } from './db.js';
import { canEdit, isManager } from './auth.js';
import { audit } from './audit.js';

const KEY_RE = /^[a-z0-9][a-z0-9:_.-]{0,79}$/i;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_UPLOAD = 8 * 1024 * 1024;
const VARIANTS = ['full', 'thumb'];
const MAX_DIMENSION = 100000;
const PUBLIC_PREFIX = 'uploads/';   // the only part of the MEDIA bucket GET /api/media/* serves

const signageSlug = (key) => (key.startsWith('signage:') ? key.slice('signage:'.length) : null);

function checkKey(key) {
  if (!KEY_RE.test(key)) throw bad('That settings key is not valid.', 'invalid_key');
  return key;
}

/** GET /api/admin/settings/:key → { value } ({} when unset) — same reach as put(). */
export async function get(ctx) {
  const key = checkKey(ctx.params.key);
  const slug = signageSlug(key);
  if (!isManager(ctx.user) && !(slug && canEdit(ctx.user, slug))) throw forbidden('You can only see the TV settings of your own businesses.');
  const row = await first(ctx.env, 'SELECT value_json FROM settings WHERE key = ?', [key]);
  return { value: row ? parseJson(row.value_json, {}) : {} };
}

/** PUT /api/admin/settings/:key { value } — owner/admin, or an editor for signage:<their slug>. */
export async function put(ctx) {
  const key = checkKey(ctx.params.key);
  const slug = signageSlug(key);
  if (!isManager(ctx.user) && !(slug && canEdit(ctx.user, slug))) throw forbidden('You can only change the TV settings of your own businesses.');
  const body = await readBody(ctx.request);
  if (!('value' in body)) throw bad('Send { value }.', 'missing_field');
  const text = JSON.stringify(body.value ?? null);
  if (text.length > 100000) throw bad('That value is too large.', 'invalid_field');
  const previous = await first(ctx.env, 'SELECT value_json FROM settings WHERE key = ?', [key]);
  const business = slug ? await first(ctx.env, 'SELECT name FROM businesses WHERE slug = ?', [slug]) : null;
  await run(ctx.env, `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, [key, text]);
  await audit(ctx, {
    business_slug: slug, entity: 'settings', entity_id: key, action: 'update',
    summary: slug ? `Changed the TV screen settings for ${business?.name || slug}` : `Changed the setting ${key}`,
    // No stored row reads as {} (all defaults), so History → Restore and Undo all can put "nothing set" back.
    before: previous ? parseJson(previous.value_json, null) : {}, after: body.value ?? null,
  });
  return { value: body.value ?? null };
}

/** Writes a setting value (or removes it when value is null); used by History → Restore. */
export async function writeSetting(env, key, value) {
  if (value == null) return run(env, 'DELETE FROM settings WHERE key = ?', [key]);
  return run(env, `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, [key, JSON.stringify(value)]);
}

/* -------------------------------------------------------------------------
   Media (R2). Without the MEDIA binding uploads answer 501 and the admin shows a URL field instead.
   ------------------------------------------------------------------------- */
const safeName = (name) => String(name || 'photo').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'photo';
/** "IMG 1234.HEIC.jpg" → "img-1234" (the extension comes from the file type instead). */
const baseName = (name) => safeName(name).replace(/(\.[a-z0-9]{1,5})+$/, '').replace(/[._-]+$/, '') || 'photo';

/** An optional width/height form field: a positive whole number, or null when it was left out. */
function dimension(form, key) {
  const raw = form.get(key);
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DIMENSION) throw bad(`${key} must be a whole number of pixels.`, 'invalid_field');
  return n;
}

/**
 * POST /api/admin/media multipart { file, business, variant?, width?, height? } → { url, key, width, height }.
 * The admin uploads a browser-resized "full" copy and a "thumb" of each photo; the key is
 * uploads/<slug>/<timestamp>-<name>-<variant>.<ext> (no "-<variant>" when none was sent). Only uploads without a
 * variant write a History entry of their own.
 */
export async function upload(ctx) {
  if (!ctx.env.MEDIA) throw notConfigured('Photo uploads are not set up. Paste an image link instead.', 'media_not_configured');
  const type = (ctx.request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('multipart/form-data')) throw bad('Send the photo as multipart/form-data with a "file" field.');
  const form = await ctx.request.formData();
  const file = form.get('file');
  const slug = String(form.get('business') || form.get('slug') || '').trim();
  if (!slug || !(await first(ctx.env, 'SELECT slug FROM businesses WHERE slug = ?', [slug]))) throw notFound('No such business.', 'unknown_business');
  if (!canEdit(ctx.user, slug)) throw forbidden('Choose one of your businesses for the upload.');
  if (!(file && typeof file === 'object' && typeof file.arrayBuffer === 'function')) throw bad('No file was attached.', 'missing_field');
  const ext = IMAGE_TYPES[file.type];
  if (!ext) throw bad('Photos must be JPEG, PNG, WebP or GIF.', 'unsupported_type');
  if (file.size > MAX_UPLOAD) throw bad('Photos must be 8 MB or smaller.', 'too_large');
  const variant = String(form.get('variant') || '').trim() || null;
  if (variant && !VARIANTS.includes(variant)) throw bad('variant must be full or thumb.', 'invalid_field');
  const width = dimension(form, 'width');
  const height = dimension(form, 'height');
  const name = `${baseName(file.name)}${variant ? `-${variant}` : ''}.${ext}`;
  const key = `uploads/${slug}/${Date.now()}-${name}`;
  await ctx.env.MEDIA.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  // An absolute link, so a copy of a site hosted elsewhere (GitHub Pages) shows the photo too.
  const url = new URL(`/api/media/${key}`, ctx.env.PUBLIC_BASE_URL || ctx.url.origin).toString();
  // A sized copy (variant) is only half of a photo: the artwork photo, or the saved event or announcement link, gets
  // the History entry. Without that rule every artwork photo wrote three rows and pushed real changes off the page.
  if (!variant) await audit(ctx, { business_slug: slug, entity: 'media', entity_id: key, action: 'create', summary: `Uploaded photo ${name}`, after: { key, url, size: file.size, type: file.type, width, height } });
  return { url, key, width, height };
}

/**
 * GET /api/media/<key> — public, cached for a year. Only uploads/… (photos uploaded for the websites) are served;
 * anything else in the bucket, such as photos sent in an Assistant chat (assistant/…), stays private.
 */
export async function serve(ctx) {
  if (!ctx.env.MEDIA) throw notConfigured('Media storage is not set up.', 'media_not_configured');
  const key = ctx.params.rest || '';
  const object = key.startsWith(PUBLIC_PREFIX) ? await ctx.env.MEDIA.get(key) : null;
  if (!object) throw notFound('No such file.');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}
