// Rome's Joy admin Worker: /api/admin artworks — the gallery's catalog of pieces and their photos.
// Each piece may hang in an exhibition (an events row of the same business). Photos are links: uploads land in
// R2 through /api/admin/media first. Deleting a piece keeps the files, so History → Restore brings it all back.
import { bad, conflict, notFound, readBody } from './http.js';
import { all, batch, first, insertRow, pick, run, sqlNow, stmt, updateRow, withIsoTimes } from './db.js';
import { readFields } from './validate.js';
import { requireBusiness } from './auth.js';
import { audit, changedKeys, quote } from './audit.js';
import { ARTWORK_STATUS_TEXT, formatUsd, imagesByArtwork, shapeArtworkImage } from './public.js';

export const ARTWORK_STATUSES = Object.keys(ARTWORK_STATUS_TEXT);
export const PRICE_DISPLAYS = ['show', 'on_request', 'hidden'];
export const MAX_IMAGES = 12;

export const ARTWORK_FIELDS = {
  title: { type: 'text', required: true, max: 200 },
  artist: { type: 'text', max: 200 },
  year: { type: 'text', max: 40 },
  medium: { type: 'text', max: 200 },
  dimensions: { type: 'text', max: 120 },
  description: { type: 'text', max: 5000 },
  price: { type: 'number', min: 0 },
  // Required with a default: left out means the default, sent empty is an error (the columns are NOT NULL).
  price_display: { type: 'text', required: true, oneOf: PRICE_DISPLAYS, default: 'on_request', label: 'price display' },
  status: { type: 'text', required: true, oneOf: ARTWORK_STATUSES, default: 'available' },
  featured: { type: 'bool' },
  published: { type: 'bool', default: 1 },
  event_id: { type: 'int', min: 1, label: 'exhibition' },
};
export const ARTWORK_COLUMNS = ['business_slug', ...Object.keys(ARTWORK_FIELDS), 'sort_order', 'created_at', 'updated_at'];
export const IMAGE_COLUMNS = ['artwork_id', 'url', 'thumb_url', 'alt', 'width', 'height', 'sort_order', 'created_at'];

export const IMAGE_FIELDS = {
  url: { type: 'text', required: true, max: 2000, label: 'photo link' },
  thumb_url: { type: 'text', max: 2000, label: 'thumbnail link' },
  alt: { type: 'text', max: 500, label: 'photo description' },
  width: { type: 'int', min: 1, max: 100000 },
  height: { type: 'int', min: 1, max: 100000 },
};

/* -------------------------------------------------------------------------
   Shapes and loaders
   ------------------------------------------------------------------------- */
const adminOpts = { admin: true };

/** Every column, booleans as booleans, ISO times, the photos in order and the exhibition's title. */
function shapeArtwork(row, images) {
  const { event_title = null, ...rest } = withIsoTimes(row);
  return {
    ...rest,
    featured: Boolean(row.featured),
    published: Boolean(row.published),
    event_title,
    images: images.map((i) => shapeArtworkImage(i, adminOpts)),
  };
}

const ARTWORK_SELECT = 'SELECT a.*, e.title AS event_title FROM artworks a LEFT JOIN events e ON e.id = a.event_id';

/** One piece with its photos, ready to return. */
async function artworkResponse(env, id) {
  const [rows, images] = await batch(env, [
    stmt(env, `${ARTWORK_SELECT} WHERE a.id = ?`, [id]),
    stmt(env, 'SELECT * FROM artwork_images WHERE artwork_id = ? ORDER BY sort_order, id', [id]),
  ]);
  return { artwork: shapeArtwork(rows.results[0], images.results) };
}

/** The artwork named by :id, after checking the user may edit its business (404 unknown, 403 not theirs). */
async function loadArtwork(ctx, id = ctx.params.id) {
  const row = await first(ctx.env, 'SELECT * FROM artworks WHERE id = ?', [Number(id) || 0]);
  if (!row) throw notFound('No such artwork.');
  await requireBusiness(ctx, row.business_slug);
  return row;
}

async function loadImage(ctx) {
  const row = await first(ctx.env, `SELECT i.*, a.business_slug, a.title AS artwork_title FROM artwork_images i
    JOIN artworks a ON a.id = i.artwork_id WHERE i.id = ?`, [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such photo.');
  await requireBusiness(ctx, row.business_slug);
  const { business_slug, artwork_title, ...image } = row;
  return { image, business_slug, artwork_title };
}

/** event_id must be an exhibition (any event) of the same business, or null. */
async function checkEvent(env, slug, eventId) {
  if (eventId == null) return;
  const ev = await first(env, 'SELECT business_slug FROM events WHERE id = ?', [eventId]);
  if (!ev || ev.business_slug !== slug) throw bad('That exhibition is not one of this business’s events.', 'invalid_event');
}

/**
 * Photo links: https anywhere, or this site's own /api/media/... (as a path, or absolute on this Worker). Each is
 * checked in the form a browser resolves it to, and stored that way: "/api/media/%2e%2e/admin/" (which browsers
 * read as "/admin/") and "https:evil.example" (a relative link under https, another site under http) are refused.
 */
const parseUrl = (s, base) => { try { return new URL(s, base); } catch { return null; } };
const mediaPath = (path) => /^\/api\/media\/[^\s\\?#]+$/.test(path) && !path.split('/').includes('..');
const PATH_BASE = 'https://path.invalid';

export function checkPhotoUrl(value, name, ctx) {
  if (value == null) return null;
  if (!/[\s\\]/.test(value)) {
    if (value.startsWith('/')) {
      // A path counts only when it is already in plain form: no dot segments, encoded or not, no "//host".
      const url = parseUrl(value, PATH_BASE);
      if (url && url.origin === PATH_BASE && url.pathname === value && mediaPath(value)) return value;
    } else if (/^https?:\/\//i.test(value)) {
      const url = parseUrl(value);
      // An absolute link to this Worker's own media is fine over http too (local dev answers on http://localhost).
      const own = [ctx.url.origin, parseUrl(ctx.env.PUBLIC_BASE_URL || '')?.origin];
      if (url && url.protocol === 'https:' && url.hostname) return url.href;
      if (url && own.includes(url.origin) && mediaPath(url.pathname)) return url.href;
    }
  }
  throw bad(`The ${name} must be an https:// link or an uploaded photo (/api/media/…).`, 'invalid_field');
}

function idList(value, what) {
  if (!Array.isArray(value) || !value.length) throw bad(`${what} must be a list of ids.`, 'invalid_field');
  const ids = value.map(Number);
  if (ids.some((n) => !Number.isInteger(n)) || new Set(ids).size !== ids.length) throw bad(`${what} must be distinct ids.`, 'invalid_field');
  return ids;
}

const nextSort = async (env, sql, binds) => (await first(env, `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${sql}`, binds)).n;

/** Writes sort_order = position for each id; `scopeSql` keeps the update inside one business or one artwork. */
export function sortStatements(env, table, order, scopeSql, scopeBind) {
  return Object.entries(order).map(([id, n]) => stmt(env, `UPDATE ${table} SET sort_order = ? WHERE id = ? AND ${scopeSql}`, [n, Number(id), scopeBind]));
}

const STATUS_WORDS = { available: 'available', reserved: 'reserved', sold: 'sold', not_for_sale: 'not for sale' };

/** "Marked 'X' sold", "Changed the price of 'X' to $1,800", or "Edited 'X'". */
function editSummary(changed, values, title) {
  if (changed.length === 1 && changed[0] === 'status') return `Marked ${quote(title)} ${STATUS_WORDS[values.status]}`;
  if (changed.length === 1 && changed[0] === 'price') {
    return values.price == null ? `Removed the price of ${quote(title)}` : `Changed the price of ${quote(title)} to ${formatUsd(values.price)}`;
  }
  return `Edited ${quote(title)}`;
}

/* -------------------------------------------------------------------------
   Artworks
   ------------------------------------------------------------------------- */

/** GET /api/admin/businesses/:slug/artworks?event_id=<id|none>&status=<status>&q=<text> — includes unpublished. */
export async function list(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const params = ctx.url.searchParams;
  const where = ['a.business_slug = ?'];
  const binds = [business.slug];
  const eventId = params.get('event_id');
  if (eventId === 'none') where.push('a.event_id IS NULL');
  else if (eventId) {
    const n = Number(eventId);
    if (!Number.isInteger(n) || n < 1) throw bad('event_id must be an event id or "none".');
    where.push('a.event_id = ?');
    binds.push(n);
  }
  const status = params.get('status');
  if (status && status !== 'all') {
    if (!ARTWORK_STATUSES.includes(status)) throw bad(`status must be one of: ${ARTWORK_STATUSES.join(', ')}.`);
    where.push('a.status = ?');
    binds.push(status);
  }
  const q = (params.get('q') || '').trim().slice(0, 200);
  if (q) {
    // LIKE is case-insensitive for ASCII in SQLite; % and _ typed by staff are matched literally.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(a.title LIKE ? ESCAPE '\\' OR a.artist LIKE ? ESCAPE '\\')");
    binds.push(pattern, pattern);
  }
  const whereSql = where.join(' AND ');
  const [rows, images] = await batch(ctx.env, [
    stmt(ctx.env, `${ARTWORK_SELECT} WHERE ${whereSql} ORDER BY a.sort_order, a.id`, binds),
    stmt(ctx.env, `SELECT i.* FROM artwork_images i JOIN artworks a ON a.id = i.artwork_id
      WHERE ${whereSql} ORDER BY i.sort_order, i.id`, binds),
  ]);
  const byArtwork = imagesByArtwork(images.results);
  return { artworks: rows.results.map((r) => shapeArtwork(r, byArtwork.get(r.id) || [])) };
}

/** POST /api/admin/businesses/:slug/artworks — added last. */
export async function create(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), ARTWORK_FIELDS, 'create');
  await checkEvent(ctx.env, business.slug, fields.event_id);
  const sort_order = await nextSort(ctx.env, 'artworks WHERE business_slug = ?', [business.slug]);
  const id = await insertRow(ctx.env, 'artworks', { business_slug: business.slug, ...fields, sort_order });
  const row = await first(ctx.env, 'SELECT * FROM artworks WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: business.slug, entity: 'artwork', entity_id: id, action: 'create',
    summary: `Added artwork ${quote(row.title)}${row.artist ? ` by ${row.artist}` : ''}`, after: row,
  });
  return artworkResponse(ctx.env, id);
}

/** GET /api/admin/artworks/:id */
export async function get(ctx) {
  const row = await loadArtwork(ctx);
  return artworkResponse(ctx.env, row.id);
}

/** PATCH /api/admin/artworks/:id — any subset of the fields. */
export async function patch(ctx) {
  const row = await loadArtwork(ctx);
  const fields = readFields(await readBody(ctx.request), ARTWORK_FIELDS, 'patch');
  if ('event_id' in fields) await checkEvent(ctx.env, row.business_slug, fields.event_id);
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'artworks', { ...values, updated_at: sqlNow() }, 'id = ?', [row.id]);
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'artwork', entity_id: row.id, action: 'update',
      summary: editSummary(changed, values, values.title ?? row.title), before: pick(row, changed), after: values,
    });
  }
  return artworkResponse(ctx.env, row.id);
}

/** DELETE /api/admin/artworks/:id — its photo rows go too (kept in the history entry; the files stay in R2). */
export async function remove(ctx) {
  const row = await loadArtwork(ctx);
  const images = await all(ctx.env, 'SELECT * FROM artwork_images WHERE artwork_id = ? ORDER BY sort_order, id', [row.id]);
  await batch(ctx.env, [
    stmt(ctx.env, 'DELETE FROM artwork_images WHERE artwork_id = ?', [row.id]),
    stmt(ctx.env, 'DELETE FROM artworks WHERE id = ?', [row.id]),
  ]);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'artwork', entity_id: row.id, action: 'delete',
    summary: `Deleted artwork ${quote(row.title)}${images.length ? ` (${images.length} photo${images.length === 1 ? '' : 's'})` : ''}`,
    before: { ...row, images },
  });
  return { ok: true };
}

/**
 * POST /api/admin/businesses/:slug/artworks/reorder { ids } — position i gets sort_order i. A subset is fine
 * (e.g. the pieces of one exhibition). History keeps { order: { id: sort_order } } before and after.
 */
export async function reorder(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const ids = idList((await readBody(ctx.request)).ids, 'ids');
  const current = await all(ctx.env, 'SELECT id, sort_order FROM artworks WHERE business_slug = ?', [business.slug]);
  const was = new Map(current.map((r) => [r.id, r.sort_order]));
  if (ids.some((id) => !was.has(id))) throw bad('One of those artworks belongs to another business.', 'invalid_field');
  const before = { order: Object.fromEntries(ids.map((id) => [id, was.get(id)])) };
  const after = { order: Object.fromEntries(ids.map((id, i) => [id, i])) };
  await batch(ctx.env, sortStatements(ctx.env, 'artworks', after.order, 'business_slug = ?', business.slug));
  await audit(ctx, {
    business_slug: business.slug, entity: 'artwork', entity_id: null, action: 'update',
    summary: `Reordered the artworks of ${business.short_name || business.name}`, before, after,
  });
  return { ok: true };
}

/* -------------------------------------------------------------------------
   Photos of a piece (first = main photo)
   ------------------------------------------------------------------------- */

/** POST /api/admin/artworks/:id/images { url, thumb_url, alt, width, height } — added last, at most 12. */
export async function addImage(ctx) {
  const artwork = await loadArtwork(ctx);
  const fields = readFields(await readBody(ctx.request), IMAGE_FIELDS, 'create');
  fields.url = checkPhotoUrl(fields.url, 'photo link', ctx);
  fields.thumb_url = checkPhotoUrl(fields.thumb_url, 'thumbnail link', ctx);
  const { n } = await first(ctx.env, 'SELECT COUNT(*) AS n FROM artwork_images WHERE artwork_id = ?', [artwork.id]);
  if (n >= MAX_IMAGES) throw conflict(`A piece can have at most ${MAX_IMAGES} photos. Remove one first.`, 'too_many_images');
  const sort_order = await nextSort(ctx.env, 'artwork_images WHERE artwork_id = ?', [artwork.id]);
  const id = await insertRow(ctx.env, 'artwork_images', { artwork_id: artwork.id, ...fields, sort_order });
  const row = await first(ctx.env, 'SELECT * FROM artwork_images WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: artwork.business_slug, entity: 'artwork_image', entity_id: id, action: 'create',
    summary: `Added a photo to ${quote(artwork.title)}`, after: row,
  });
  return { image: shapeArtworkImage(row, adminOpts) };
}

/** PATCH /api/admin/artwork-images/:id { alt } */
export async function patchImage(ctx) {
  const { image, business_slug, artwork_title } = await loadImage(ctx);
  const fields = readFields(await readBody(ctx.request), { alt: IMAGE_FIELDS.alt }, 'patch');
  if ((image.alt ?? null) !== fields.alt) {
    await updateRow(ctx.env, 'artwork_images', fields, 'id = ?', [image.id]);
    await audit(ctx, {
      business_slug, entity: 'artwork_image', entity_id: image.id, action: 'update',
      summary: `Changed the photo description on ${quote(artwork_title)}`, before: { alt: image.alt }, after: fields,
    });
  }
  return { image: shapeArtworkImage(await first(ctx.env, 'SELECT * FROM artwork_images WHERE id = ?', [image.id]), adminOpts) };
}

/** DELETE /api/admin/artwork-images/:id — the file stays in R2, so Restore can bring the photo back. */
export async function removeImage(ctx) {
  const { image, business_slug, artwork_title } = await loadImage(ctx);
  await run(ctx.env, 'DELETE FROM artwork_images WHERE id = ?', [image.id]);
  await audit(ctx, {
    business_slug, entity: 'artwork_image', entity_id: image.id, action: 'delete',
    summary: `Removed a photo from ${quote(artwork_title)}`, before: image,
  });
  return { ok: true };
}

/** POST /api/admin/artworks/:id/images/reorder { ids } — the first becomes the main photo. */
export async function reorderImages(ctx) {
  const artwork = await loadArtwork(ctx);
  const ids = idList((await readBody(ctx.request)).ids, 'ids');
  const current = await all(ctx.env, 'SELECT id, sort_order FROM artwork_images WHERE artwork_id = ?', [artwork.id]);
  const was = new Map(current.map((r) => [r.id, r.sort_order]));
  if (ids.some((id) => !was.has(id))) throw bad('One of those photos belongs to another piece.', 'invalid_field');
  const before = { artwork_id: artwork.id, order: Object.fromEntries(ids.map((id) => [id, was.get(id)])) };
  const after = { artwork_id: artwork.id, order: Object.fromEntries(ids.map((id, i) => [id, i])) };
  await batch(ctx.env, sortStatements(ctx.env, 'artwork_images', after.order, 'artwork_id = ?', artwork.id));
  await audit(ctx, {
    business_slug: artwork.business_slug, entity: 'artwork_image', entity_id: null, action: 'update',
    summary: `Reordered the photos of ${quote(artwork.title)}`, before, after,
  });
  return { ok: true };
}
