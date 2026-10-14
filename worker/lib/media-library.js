// Rome's Joy admin Worker: the photo library — albums and photos per business (docs/assistant-api.md §5).
// Staff snap a photo on a phone now and use it later. The file goes up through POST /api/admin/media (R2) first;
// this module keeps the list: a note, a description and an album per photo, where each photo is used, moving photos
// between businesses, and deleting them (the row and both R2 files), which is refused while a photo is in use.
// Photo, album and screen History entries are a record only: Restore does not apply to them (the files are gone).
import { bad, conflict, forbidden, idParam, intParam, json, notFound, readBody } from './http.js';
import { all, batch, first, insertRow, isoTime, pick, run, stmt, updateRow } from './db.js';
import { isDate, readFields } from './validate.js';
import { canEdit, isManager, requireBusiness } from './auth.js';
import { audit, changedKeys, listWords, quote } from './audit.js';
import { checkPhotoUrl } from './admin-artworks.js';

const MEDIA_PATH = '/api/media/';
const PATH_BASE = 'https://path.invalid';
const MAX_ALBUM_NAME = 60;
const USED_BY_SHOWN = 5; // places named in the "in use" message; the rest are counted

export const PHOTO_FIELDS = {
  url: { type: 'text', required: true, max: 2000, label: 'photo link' },
  thumb_url: { type: 'text', max: 2000, label: 'thumbnail link' },
  r2_key: { type: 'text', max: 500, label: 'file key' },
  thumb_r2_key: { type: 'text', max: 500, label: 'thumbnail file key' },
  note: { type: 'text', max: 500 },
  alt: { type: 'text', max: 500, label: 'photo description' },
  album_id: { type: 'int', min: 1, label: 'album' },
  width: { type: 'int', min: 1, max: 100000 },
  height: { type: 'int', min: 1, max: 100000 },
  bytes: { type: 'int', min: 0, max: 100 * 1024 * 1024 },
  taken_at: { type: 'text', max: 40, label: 'date taken' },
};
const PHOTO_PATCH_FIELDS = {
  note: PHOTO_FIELDS.note,
  alt: PHOTO_FIELDS.alt,
  album_id: PHOTO_FIELDS.album_id,
  business_slug: { type: 'text', max: 64, label: 'business' },
};
const ALBUM_FIELDS = {
  name: { type: 'text', required: true, max: MAX_ALBUM_NAME, label: 'album name' },
  sort_order: { type: 'int', min: -1000000, max: 1000000, label: 'order' },
};

/* -------------------------------------------------------------------------
   Links and files
   ------------------------------------------------------------------------- */
const originOf = (s) => { try { return new URL(s).origin; } catch { return null; } };

/** The R2 key behind a link to this Worker's own /api/media/… (a path, or absolute on this host), else null. */
function ownKey(link, ctx) {
  let url;
  try { url = new URL(link, PATH_BASE); } catch { return null; }
  const own = [PATH_BASE, ctx.url.origin, originOf(ctx.env.PUBLIC_BASE_URL || '')];
  if (!own.includes(url.origin) || !url.pathname.startsWith(MEDIA_PATH)) return null;
  return url.pathname.slice(MEDIA_PATH.length) || null;
}

/**
 * What a link is matched on when looking for where a photo is used: the R2 key for any …/api/media/… link (the same
 * file can be linked as a path, on the workers.dev host or on PUBLIC_BASE_URL), else the link itself.
 */
function matchKey(link) {
  if (!link) return null;
  try {
    const url = new URL(link, PATH_BASE);
    if (url.pathname.startsWith(MEDIA_PATH) && url.pathname.length > MEDIA_PATH.length) return `key:${url.pathname.slice(MEDIA_PATH.length)}`;
  } catch { /* not a link: compared as text */ }
  return `url:${link}`;
}

/**
 * A file key sent with a new photo, or the one its link points at. Only files uploaded for this business (and still
 * in R2) are taken: the key decides which file is deleted with the photo, so it can never name someone else's file.
 * A link to a file this business does not own is kept as a plain link (deleting the photo then leaves the file).
 */
async function fileKey(ctx, slug, link, given, what) {
  if (!ctx.env.MEDIA || !link) return null;
  const fromLink = ownKey(link, ctx);
  if (given != null && given !== fromLink) throw bad(`The ${what} key does not match its link.`, 'invalid_field');
  const key = given ?? fromLink;
  const prefix = `uploads/${slug}/`;
  if (!key || !key.startsWith(prefix)) {
    if (given != null) throw bad(`The ${what} was not uploaded for this business.`, 'invalid_field');
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key.slice(prefix.length)) || !(await ctx.env.MEDIA.head(key))) {
    throw bad(`The ${what} was not found in storage. Upload it again.`, 'invalid_field');
  }
  return key;
}

/** "2026-10-13", "2026-10-13T09:14", "2026-10-13T09:14:22.000Z", "2026-10-13 09:14:22-05:00" … or null. */
const TAKEN_RE = /^(\d{4}-\d{2}-\d{2})([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function takenAt(value) {
  if (value == null) return null;
  const m = TAKEN_RE.exec(value);
  if (!m || !isDate(m[1])) throw bad('The date taken must look like 2026-10-13 or 2026-10-13T09:15.', 'invalid_field');
  return value;
}

/** Removes a photo's files from R2, unless another photo still points at them. */
async function deleteFiles(ctx, row) {
  const keys = [...new Set([row.r2_key, row.thumb_r2_key].filter(Boolean))];
  if (!ctx.env.MEDIA || !keys.length) return;
  const shared = await all(ctx.env, `SELECT r2_key, thumb_r2_key FROM media
    WHERE r2_key IN (SELECT value FROM json_each(?)) OR thumb_r2_key IN (SELECT value FROM json_each(?))`, [JSON.stringify(keys), JSON.stringify(keys)]);
  const stillUsed = new Set(shared.flatMap((r) => [r.r2_key, r.thumb_r2_key]));
  const gone = keys.filter((k) => !stillUsed.has(k));
  try {
    if (gone.length) await ctx.env.MEDIA.delete(gone);
  } catch (err) {
    // The row is already gone; a file left behind costs a little storage and nothing else.
    console.error('Could not delete photo files from R2:', gone, err);
  }
}

/* -------------------------------------------------------------------------
   Where photos are used: event and announcement photos, artwork photos, links in a notice
   ------------------------------------------------------------------------- */

/** Every place a photo link is used, indexed by matchKey(); notices are searched as text. */
async function loadUsage(env) {
  const [events, news, images, notices] = await batch(env, [
    stmt(env, "SELECT id, business_slug, title, image_url FROM events WHERE image_url IS NOT NULL AND image_url <> ''"),
    stmt(env, "SELECT id, business_slug, title, image_url FROM announcements WHERE image_url IS NOT NULL AND image_url <> ''"),
    stmt(env, 'SELECT a.id, a.business_slug, a.title, i.url, i.thumb_url FROM artwork_images i JOIN artworks a ON a.id = i.artwork_id'),
    stmt(env, "SELECT slug, name, notice FROM businesses WHERE notice IS NOT NULL AND notice <> ''"),
  ]);
  const byKey = new Map();
  const add = (link, place) => {
    const key = matchKey(link);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(place);
  };
  for (const e of events.results) add(e.image_url, { kind: 'event', id: e.id, title: e.title, business_slug: e.business_slug });
  for (const a of news.results) add(a.image_url, { kind: 'announcement', id: a.id, title: a.title, business_slug: a.business_slug });
  for (const i of images.results) {
    const place = { kind: 'artwork', id: i.id, title: i.title, business_slug: i.business_slug };
    add(i.url, place);
    if (i.thumb_url && i.thumb_url !== i.url) add(i.thumb_url, place);
  }
  return { byKey, notices: notices.results };
}

/**
 * The places one photo is used: [{ kind, id, title, business_slug }]. A place in a business the person cannot edit
 * is named only by its kind, so the list never shows them another business's unpublished titles.
 */
function usageOf(photo, usage, user) {
  const keys = new Set([photo.url, photo.thumb_url].map(matchKey).filter(Boolean));
  for (const k of [photo.r2_key, photo.thumb_r2_key]) if (k) keys.add(`key:${k}`);
  const seen = new Set();
  const places = [];
  const push = (place) => {
    const id = `${place.kind}:${place.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    const mine = place.business_slug == null ? isManager(user) : canEdit(user, place.business_slug);
    places.push(mine ? place : { kind: place.kind, id: null, title: null, business_slug: place.business_slug });
  };
  for (const key of keys) for (const place of usage.byKey.get(key) || []) push(place);
  // A notice is plain text; it counts when it contains the photo's link or its file path.
  const needles = [photo.url, photo.thumb_url, ...[photo.r2_key, photo.thumb_r2_key].filter(Boolean).map((k) => `${MEDIA_PATH}${k}`)].filter(Boolean);
  for (const b of usage.notices) {
    if (needles.some((n) => b.notice.includes(n))) push({ kind: 'notice', id: b.slug, title: b.name, business_slug: b.slug });
  }
  return places;
}

/**
 * Open drafts (change sets not yet published) that use the photo: publishing one after the photo was deleted would put a
 * broken image on the website. Matched on the photo's file path or link inside the draft's ops. Someone else's draft is
 * named only to owners and admins.
 */
async function draftUses(ctx, photo) {
  const needles = [...new Set([
    ...[photo.r2_key, photo.thumb_r2_key].filter(Boolean).map((k) => `${MEDIA_PATH}${k}`),
    ...(photo.r2_key ? [] : [photo.url, photo.thumb_url].filter(Boolean)),
  ])].map((n) => JSON.stringify(n).slice(1, -1)); // as the text appears inside ops_json
  if (!needles.length) return [];
  let rows;
  try {
    rows = await all(ctx.env, `SELECT id, title, user_id FROM change_sets WHERE status = 'draft' AND expires_at > datetime('now')
      AND EXISTS (SELECT 1 FROM json_each(?) n WHERE instr(change_sets.ops_json, n.value) > 0) ORDER BY updated_at DESC LIMIT 20`, [JSON.stringify(needles)]);
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return []; // before the assistant migration
    throw err;
  }
  return rows.map((r) => (r.user_id === ctx.user.id || isManager(ctx.user)
    ? { kind: 'draft', id: r.id, title: r.title, business_slug: photo.business_slug }
    : { kind: 'draft', id: null, title: null, business_slug: photo.business_slug }));
}

/** "the event 'Holiday brunch'", "a family-wide announcement", "an artwork of another business", "a draft: Close early". */
function placeText(place) {
  if (place.kind === 'draft') return place.title ? `a draft: ${place.title}` : 'a draft someone is working on';
  if (place.kind === 'notice') return place.title ? `the notice of ${place.title}` : 'the notice of another business';
  if (place.title == null) return `an ${place.kind} of another business`;
  return `the ${place.business_slug == null ? 'family-wide ' : ''}${place.kind} ${quote(place.title)}`;
}

/* -------------------------------------------------------------------------
   Shapes and loaders
   ------------------------------------------------------------------------- */
const PHOTO_SELECT = `SELECT m.*, a.name AS album_name, COALESCE(NULLIF(u.name, ''), u.email) AS uploaded_by_name, b.name AS business_name
  FROM media m JOIN businesses b ON b.slug = m.business_slug
  LEFT JOIN media_albums a ON a.id = m.album_id LEFT JOIN users u ON u.id = m.uploaded_by`;

/** The file name at the end of a link, for summaries of photos without a note. */
const fileName = (link) => String(link || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || 'photo';
const photoLabel = (row) => quote(row.note || fileName(row.url));

function shapePhoto(row, inUse) {
  return {
    id: row.id,
    business_slug: row.business_slug,
    business_name: row.business_name,
    url: row.url,
    thumb_url: row.thumb_url || row.url,
    note: row.note,
    alt: row.alt,
    album_id: row.album_id,
    album_name: row.album_name || null,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    taken_at: row.taken_at,
    created_at: isoTime(row.created_at),
    uploaded_by_name: row.uploaded_by_name || null,
    in_use: inUse,
  };
}

async function shapePhotos(ctx, rows) {
  if (!rows.length) return [];
  const usage = await loadUsage(ctx.env);
  return rows.map((r) => shapePhoto(r, usageOf(r, usage, ctx.user)));
}

async function photoResponse(ctx, id) {
  const [photo] = await shapePhotos(ctx, await all(ctx.env, `${PHOTO_SELECT} WHERE m.id = ?`, [id]));
  return { photo };
}

/** The photo named by :id, after checking the person may edit its business (404 unknown, 403 not theirs). */
async function loadPhoto(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM media WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such photo.');
  await requireBusiness(ctx, row.business_slug);
  return row;
}

async function loadAlbum(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM media_albums WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such album.');
  await requireBusiness(ctx, row.business_slug);
  return row;
}

/** An album of this business, or null for "No album"; 400 for an album of another business. */
async function albumOf(env, slug, albumId) {
  if (albumId == null) return null;
  const album = await first(env, 'SELECT * FROM media_albums WHERE id = ? AND business_slug = ?', [albumId, slug]);
  if (!album) throw bad('That album is not one of this business’s albums.', 'invalid_album');
  return album;
}

/** Search words (note, description or album name), with % and _ matched literally. */
function searchClause(ctx, where, binds) {
  const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 200);
  if (!q) return;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  where.push("(m.note LIKE ? ESCAPE '\\' OR m.alt LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')");
  binds.push(pattern, pattern, pattern);
}

/** Newest first, `limit` at a time; next_before is the ?before= for the next page (null on the last). */
async function pageOfPhotos(ctx, where, binds) {
  const limit = intParam(ctx.url, 'limit', 60, 200);
  const before = idParam(ctx.url, 'before');
  if (before) { where.push('m.id < ?'); binds.push(before); }
  const rows = await all(ctx.env, `${PHOTO_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, [...binds, limit + 1]);
  const page = rows.slice(0, limit);
  return { photos: await shapePhotos(ctx, page), next_before: rows.length > limit ? page[page.length - 1].id : null };
}

const albumList = (env, slug) => all(env, `SELECT a.id, a.name, a.sort_order, COUNT(m.id) AS count
  FROM media_albums a LEFT JOIN media m ON m.album_id = a.id WHERE a.business_slug = ? GROUP BY a.id ORDER BY a.sort_order, a.name, a.id`, [slug]);

/* -------------------------------------------------------------------------
   Photos
   ------------------------------------------------------------------------- */

/**
 * GET /api/admin/businesses/:slug/media?album_id=<id|none>&q=<text>&before=<id>&limit=60
 * → { photos, albums: [{ id, name, sort_order, count }], total, no_album, next_before }
 */
export async function list(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const where = ['m.business_slug = ?'];
  const binds = [business.slug];
  const album = (ctx.url.searchParams.get('album_id') || '').trim();
  if (album === 'none') where.push('m.album_id IS NULL');
  else if (album) {
    const id = Number(album);
    if (!Number.isInteger(id) || id < 1) throw bad('album_id must be an album id or "none".');
    where.push('m.album_id = ?');
    binds.push(id);
  }
  searchClause(ctx, where, binds);
  const [page, albums, counts] = await Promise.all([
    pageOfPhotos(ctx, where, binds),
    albumList(ctx.env, business.slug),
    first(ctx.env, 'SELECT COUNT(*) AS total, COALESCE(SUM(album_id IS NULL), 0) AS no_album FROM media WHERE business_slug = ?', [business.slug]),
  ]);
  return { photos: page.photos, albums, total: counts.total, no_album: counts.no_album, next_before: page.next_before };
}

/** GET /api/admin/media?q=&before=&limit= — every business the person can edit (owners and admins: all of them). */
export async function listAll(ctx) {
  const where = [];
  const binds = [];
  if (!isManager(ctx.user)) {
    where.push('m.business_slug IN (SELECT value FROM json_each(?))');
    binds.push(JSON.stringify(ctx.user.businesses));
  }
  searchClause(ctx, where, binds);
  if (!where.length) where.push('1 = 1');
  const page = await pageOfPhotos(ctx, where, binds);
  return { photos: page.photos, next_before: page.next_before };
}

/** POST /api/admin/businesses/:slug/media — adds a photo (usually just uploaded) to the library. */
export async function create(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), PHOTO_FIELDS, 'create');
  const url = checkPhotoUrl(fields.url, 'photo link', ctx);
  const thumbUrl = checkPhotoUrl(fields.thumb_url, 'thumbnail link', ctx);
  const album = await albumOf(ctx.env, business.slug, fields.album_id);
  const r2Key = await fileKey(ctx, business.slug, url, fields.r2_key, 'photo');
  const thumbKey = await fileKey(ctx, business.slug, thumbUrl, fields.thumb_r2_key, 'thumbnail');
  const keys = [r2Key, thumbKey].filter(Boolean);
  const twin = await first(ctx.env, `SELECT id FROM media WHERE (business_slug = ? AND url = ?)
    OR r2_key IN (SELECT value FROM json_each(?)) OR thumb_r2_key IN (SELECT value FROM json_each(?)) LIMIT 1`,
  [business.slug, url, JSON.stringify(keys), JSON.stringify(keys)]);
  if (twin) throw conflict('That photo is already in the library.', 'already_in_library');
  const values = {
    business_slug: business.slug, album_id: album?.id ?? null, url, thumb_url: thumbUrl, r2_key: r2Key, thumb_r2_key: thumbKey,
    note: fields.note, alt: fields.alt, width: fields.width, height: fields.height, bytes: fields.bytes,
    taken_at: takenAt(fields.taken_at), uploaded_by: ctx.user.id,
  };
  const id = await insertRow(ctx.env, 'media', values);
  await audit(ctx, {
    business_slug: business.slug, entity: 'photo', entity_id: id, action: 'create',
    summary: `Added photo ${photoLabel(values)} to the photo library${album ? ` (${album.name})` : ''}`, after: { id, ...values },
  });
  return photoResponse(ctx, id);
}

/**
 * PATCH /api/admin/media/:id { note, alt, album_id, business_slug }. Moving a photo to another business needs edit
 * rights on both; it leaves its album (albums belong to one business) unless album_id names one of the new business.
 */
export async function patch(ctx) {
  const row = await loadPhoto(ctx);
  const fields = readFields(await readBody(ctx.request), PHOTO_PATCH_FIELDS, 'patch');
  let target = null;
  if ('business_slug' in fields) {
    if (!fields.business_slug) throw bad('Choose the business to move the photo to.', 'missing_field');
    if (fields.business_slug !== row.business_slug) {
      target = await first(ctx.env, 'SELECT slug, name FROM businesses WHERE slug = ?', [fields.business_slug]);
      if (!target) throw notFound('No such business.', 'unknown_business');
      if (!canEdit(ctx.user, target.slug)) throw forbidden('You can only move photos to businesses you can edit.');
      if (!('album_id' in fields)) fields.album_id = null;
    }
  }
  const slug = target ? target.slug : row.business_slug;
  const album = 'album_id' in fields ? await albumOf(ctx.env, slug, fields.album_id) : null;
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'media', values, 'id = ?', [row.id]);
    const edits = [changed.includes('note') ? 'note' : null, changed.includes('alt') ? 'description' : null].filter(Boolean);
    let summary = null;
    if (target) summary = `Moved photo ${photoLabel(row)} to the photo library of ${target.name}${album ? ` (${album.name})` : ''}`;
    else if (changed.includes('album_id')) summary = album ? `Put photo ${photoLabel(row)} in the album ${quote(album.name)}` : `Took photo ${photoLabel(row)} out of its album`;
    if (edits.length) summary = summary ? `${summary} and changed its ${listWords(edits)}` : `Changed the ${listWords(edits)} of photo ${photoLabel(row)}`;
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'photo', entity_id: row.id, action: 'update',
      summary, before: pick(row, changed), after: values,
    });
  }
  return photoResponse(ctx, row.id);
}

/**
 * DELETE /api/admin/media/:id — refused with 409 in_use (and where) while an event, announcement, artwork, notice or
 * open Assistant draft uses the photo; otherwise removes the row and its files.
 */
export async function remove(ctx) {
  const row = await loadPhoto(ctx);
  const places = [...usageOf(row, await loadUsage(ctx.env), ctx.user), ...await draftUses(ctx, row)];
  if (places.length) {
    const named = places.slice(0, USED_BY_SHOWN).map(placeText);
    if (places.length > USED_BY_SHOWN) named.push(`${places.length - USED_BY_SHOWN} more`);
    return json({
      error: `This photo is used by ${listWords(named)}. Take it off there first, then delete it.`,
      code: 'in_use', in_use: places,
    }, 409);
  }
  await run(ctx.env, 'DELETE FROM media WHERE id = ?', [row.id]);
  await deleteFiles(ctx, row);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'photo', entity_id: row.id, action: 'delete',
    summary: `Deleted photo ${photoLabel(row)} from the photo library`, before: row,
  });
  return { ok: true };
}

/* -------------------------------------------------------------------------
   Albums
   ------------------------------------------------------------------------- */
async function checkAlbumName(env, slug, name, exceptId = 0) {
  const twin = await first(env, 'SELECT id FROM media_albums WHERE business_slug = ? AND name = ? COLLATE NOCASE AND id <> ?', [slug, name, exceptId]);
  if (twin) throw conflict(`There is already an album called ${quote(name)}.`, 'album_exists');
}

const albumResponse = async (env, id) => ({
  album: await first(env, `SELECT a.id, a.business_slug, a.name, a.sort_order, COUNT(m.id) AS count
    FROM media_albums a LEFT JOIN media m ON m.album_id = a.id WHERE a.id = ? GROUP BY a.id`, [id]),
});

/** GET /api/admin/businesses/:slug/albums → { albums: [{ id, name, sort_order, count }] } */
export async function listAlbums(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  return { albums: await albumList(ctx.env, business.slug) };
}

/** POST /api/admin/businesses/:slug/albums { name, sort_order? } — new albums go last unless an order is given. */
export async function createAlbum(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), ALBUM_FIELDS, 'create');
  await checkAlbumName(ctx.env, business.slug, fields.name);
  if (fields.sort_order == null) {
    const { last } = await first(ctx.env, 'SELECT COALESCE(MAX(sort_order), 0) AS last FROM media_albums WHERE business_slug = ?', [business.slug]);
    fields.sort_order = last + 1;
  }
  const id = await insertRow(ctx.env, 'media_albums', { business_slug: business.slug, ...fields });
  await audit(ctx, {
    business_slug: business.slug, entity: 'album', entity_id: id, action: 'create',
    summary: `Added the photo album ${quote(fields.name)}`, after: { id, business_slug: business.slug, ...fields },
  });
  return albumResponse(ctx.env, id);
}

/** PATCH /api/admin/albums/:id { name, sort_order } */
export async function patchAlbum(ctx) {
  const row = await loadAlbum(ctx);
  const fields = readFields(await readBody(ctx.request), ALBUM_FIELDS, 'patch');
  if ('name' in fields) await checkAlbumName(ctx.env, row.business_slug, fields.name, row.id);
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'media_albums', values, 'id = ?', [row.id]);
    const summary = changed.includes('name')
      ? `Renamed the photo album ${quote(row.name)} to ${quote(values.name)}`
      : `Moved the photo album ${quote(row.name)} in the album order`;
    await audit(ctx, { business_slug: row.business_slug, entity: 'album', entity_id: row.id, action: 'update', summary, before: pick(row, changed), after: values });
  }
  return albumResponse(ctx.env, row.id);
}

/** DELETE /api/admin/albums/:id — its photos stay in the library, under "No album". */
export async function removeAlbum(ctx) {
  const row = await loadAlbum(ctx);
  const [moved] = await batch(ctx.env, [
    stmt(ctx.env, 'UPDATE media SET album_id = NULL WHERE album_id = ?', [row.id]),
    stmt(ctx.env, 'DELETE FROM media_albums WHERE id = ?', [row.id]),
  ]);
  const n = moved.meta.changes || 0;
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'album', entity_id: row.id, action: 'delete',
    summary: `Deleted the photo album ${quote(row.name)}${n ? ` (its ${n} photo${n === 1 ? '' : 's'} stay in the library, with no album)` : ''}`,
    before: row,
  });
  return { ok: true, photos_moved: n };
}

/** Adds this module's routes. `admin` wraps a handler so it requires a signed-in user. */
export function register(router, admin) {
  router.get('/api/admin/media', admin(listAll));
  router.get('/api/admin/businesses/:slug/media', admin(list));
  router.post('/api/admin/businesses/:slug/media', admin(create));
  router.patch('/api/admin/media/:id', admin(patch));
  router.delete('/api/admin/media/:id', admin(remove));
  router.get('/api/admin/businesses/:slug/albums', admin(listAlbums));
  router.post('/api/admin/businesses/:slug/albums', admin(createAlbum));
  router.patch('/api/admin/albums/:id', admin(patchAlbum));
  router.delete('/api/admin/albums/:id', admin(removeAlbum));
}
