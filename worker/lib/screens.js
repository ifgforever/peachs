// Rome's Joy admin Worker: TV screens — named players, heartbeats, scene settings, "refresh now" (docs/assistant-api.md §6).
// Each physical TV gets a row and a player link (signage/live.html?business=<slug>&screen=<id>). The player reports in
// every minute (POST /api/public/screens/:id/heartbeat), so the admin can show which screens are on, and learns from the
// answer when staff asked every screen to reload. Scene settings stay in the existing signage:<slug> setting.
import { json, notFound, readBody } from './http.js';
import { all, batch, first, insertRow, isoTime, parseJson, pick, run, stmt, updateRow } from './db.js';
import { readFields } from './validate.js';
import { requireBusiness } from './auth.js';
import { audit, changedKeys, fieldLabels, quote } from './audit.js';
import { writeSetting } from './admin-settings.js';

/** The scenes staff can switch off, in the order the player shows them. */
export const SCENES = ['welcome', 'notice', 'announcements', 'featured', 'menu', 'catering', 'events', 'artworks'];
// The flat keys the TV setting used before `scenes` (signage/README.md). A scene not named in `scenes` still follows them.
const LEGACY_KEYS = {
  announcements: 'show_announcements', featured: 'show_featured', menu: 'show_menu_board',
  catering: 'show_catering', events: 'show_events', artworks: 'show_artworks',
};
const ONLINE_MINUTES = 10;      // a heartbeat within this long = online
const HEARTBEAT_GAP = 20;       // seconds; heartbeats closer together than this are refused (429)
const SECONDS = { default: 10, min: 4, max: 60 }; // per scene; the same clamp as signage/live.js
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 characters, none that look alike (l/1, o/0)
const ID_RE = /^[a-z0-9]{6,32}$/;

export const SCREEN_FIELDS = {
  name: { type: 'text', required: true, max: 80, label: 'screen name' },
  notes: { type: 'text', max: 500 },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const off = (v) => v === false || v === 0 || v === 'false';

/**
 * The TV setting with every key the screens panel shows filled in: { ...stored keys, seconds_per_scene,
 * scenes: { welcome … artworks: true|false }, refresh_version }. Other stored keys (show_blanc, say) are kept, so
 * the value can go straight back to PUT /api/admin/settings/signage:<slug>.
 */
export function screenSettings(value) {
  const raw = isObject(value) ? value : {};
  const given = isObject(raw.scenes) ? raw.scenes : {};
  const scenes = {};
  for (const name of SCENES) scenes[name] = !off(name in given ? given[name] : raw[LEGACY_KEYS[name]]);
  const seconds = Math.round(Math.min(SECONDS.max, Math.max(SECONDS.min, Number(raw.seconds_per_scene) || SECONDS.default)));
  // `Number(x) || 0` here and in signage/live.js, so both sides read the same version from any stored value.
  return { ...raw, seconds_per_scene: seconds, scenes, refresh_version: Number(raw.refresh_version) || 0 };
}

const readSettings = async (env, slug) => {
  const row = await first(env, 'SELECT value_json FROM settings WHERE key = ?', [`signage:${slug}`]);
  return row ? parseJson(row.value_json, {}) : {};
};

function newScreenId() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => ID_CHARS[b & 31]).join('');
}

/** The player link (absolute, so it can be typed into a TV), and the same page without ?screen= for previews. */
function playerLinks(ctx, slug, id) {
  const base = String(ctx.env.PUBLIC_BASE_URL || ctx.url.origin).replace(/\/+$/, '');
  const preview = `${base}/signage/live.html?business=${encodeURIComponent(slug)}`;
  return { player_url: `${preview}&screen=${encodeURIComponent(id)}`, preview_url: preview };
}

/**
 * { id, business_slug, name, notes, status: online|offline|never, last_seen_at, last_scene, last_version, player_url,
 * preview_url, created_at }. preview_url sends no heartbeats: the admin's mini preview uses it, so a screen never
 * looks online just because someone has the admin open.
 */
function shapeScreen(ctx, row) {
  const seen = row.last_seen_at ? Date.parse(isoTime(row.last_seen_at)) : null;
  const status = seen == null ? 'never' : Date.now() - seen <= ONLINE_MINUTES * 60000 ? 'online' : 'offline';
  return {
    id: row.id,
    business_slug: row.business_slug,
    name: row.name,
    notes: row.notes,
    status,
    last_seen_at: isoTime(row.last_seen_at) || null,
    last_scene: row.last_scene || null,
    last_version: row.last_version || null,
    ...playerLinks(ctx, row.business_slug, row.id),
    created_at: isoTime(row.created_at),
  };
}

/** The screen named by :id, after checking the person may edit its business (404 unknown, 403 not theirs). */
async function loadScreen(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM screens WHERE id = ?', [String(ctx.params.id)]);
  if (!row) throw notFound('No such screen.');
  await requireBusiness(ctx, row.business_slug);
  return row;
}

/* -------------------------------------------------------------------------
   Admin routes
   ------------------------------------------------------------------------- */

/** GET /api/admin/businesses/:slug/screens → { screens, settings } */
export async function list(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const [rows, value] = await Promise.all([
    all(ctx.env, 'SELECT * FROM screens WHERE business_slug = ? ORDER BY name COLLATE NOCASE, created_at, id', [business.slug]),
    readSettings(ctx.env, business.slug),
  ]);
  return { screens: rows.map((r) => shapeScreen(ctx, r)), settings: screenSettings(value) };
}

/** POST /api/admin/businesses/:slug/screens { name, notes } → { screen } */
export async function create(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), SCREEN_FIELDS, 'create');
  const id = newScreenId();
  await insertRow(ctx.env, 'screens', { id, business_slug: business.slug, ...fields });
  const row = await first(ctx.env, 'SELECT * FROM screens WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: business.slug, entity: 'screen', entity_id: id, action: 'create',
    summary: `Added the TV screen ${quote(row.name)}`, after: row,
  });
  return { screen: shapeScreen(ctx, row) };
}

/** PATCH /api/admin/screens/:id { name, notes } → { screen } */
export async function patch(ctx) {
  const row = await loadScreen(ctx);
  const fields = readFields(await readBody(ctx.request), SCREEN_FIELDS, 'patch');
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'screens', values, 'id = ?', [row.id]);
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'screen', entity_id: row.id, action: 'update',
      summary: `Changed ${fieldLabels(changed)} of the TV screen ${quote(row.name)}`, before: pick(row, changed), after: values,
    });
  }
  return { screen: shapeScreen(ctx, await first(ctx.env, 'SELECT * FROM screens WHERE id = ?', [row.id])) };
}

/** DELETE /api/admin/screens/:id — the TV keeps playing; it just no longer reports in. */
export async function remove(ctx) {
  const row = await loadScreen(ctx);
  await run(ctx.env, 'DELETE FROM screens WHERE id = ?', [row.id]);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'screen', entity_id: row.id, action: 'delete',
    summary: `Removed the TV screen ${quote(row.name)}`, before: row,
  });
  return { ok: true };
}

/**
 * POST /api/admin/businesses/:slug/screens/refresh → { settings, refresh_version }. Bumps refresh_version in the TV
 * setting; each player sees the new number in its next heartbeat (within a minute) and fetches its data again.
 */
export async function refresh(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const { before, version, value } = await bumpRefreshVersion(ctx.env, business.slug);
  await audit(ctx, {
    business_slug: business.slug, entity: 'screen', entity_id: business.slug, action: 'update',
    summary: `Asked every TV screen of ${business.name} to reload`,
    before: { refresh_version: before }, after: { refresh_version: version },
  });
  return { settings: screenSettings(value), refresh_version: version };
}

/** The refresh_version the TV setting of one business holds now (0 when unset). */
export async function refreshVersion(env, slug) {
  const stored = await readSettings(env, slug);
  return Number(isObject(stored) ? stored.refresh_version : 0) || 0;
}

/**
 * Bumps refresh_version in the TV setting of one business, so each named screen fetches its data again at its next
 * heartbeat (within a minute). The new number is above both the stored one and `floor`: change sets pass the number
 * the screens had before a publish or undo, because putting back an older TV setting can also put back an older number.
 * Writes no History entry (the caller says it in its own). → { before, version, value }
 */
export async function bumpRefreshVersion(env, slug, floor = 0) {
  const stored = await readSettings(env, slug);
  const current = isObject(stored) ? stored : {};
  const before = Number(current.refresh_version) || 0;
  const version = Math.max(before, Number(floor) || 0) + 1;
  const value = { ...current, refresh_version: version };
  await writeSetting(env, `signage:${slug}`, value);
  return { before, version, value };
}

/* -------------------------------------------------------------------------
   Public: the player's heartbeat
   ------------------------------------------------------------------------- */

/**
 * POST /api/public/screens/:id/heartbeat { scene, version } → { refresh_version, seconds_per_scene }. No login (the
 * screen id is the secret); at most one every 20 seconds per screen (429 otherwise); 404 for an unknown id.
 */
export async function heartbeat(ctx) {
  const id = String(ctx.params.id);
  if (!ID_RE.test(id)) throw notFound('No such screen.');
  const body = await readBody(ctx.request);
  const scene = typeof body.scene === 'string' ? body.scene.trim().slice(0, 80) || null : null;
  const version = body.version == null ? null : String(body.version).slice(0, 40);
  const agent = (ctx.request.headers.get('User-Agent') || '').slice(0, 300) || null;
  // One round trip: record the beat unless the last one was under HEARTBEAT_GAP seconds ago, then read the settings.
  const [beat, read] = await batch(ctx.env, [
    stmt(ctx.env, `UPDATE screens SET last_seen_at = datetime('now'), last_seen_ip = ?, last_user_agent = ?, last_scene = ?, last_version = ?
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= datetime('now', '-${HEARTBEAT_GAP} seconds'))`, [ctx.ip, agent, scene, version, id]),
    stmt(ctx.env, `SELECT s.id, st.value_json FROM screens s LEFT JOIN settings st ON st.key = 'signage:' || s.business_slug
      WHERE s.id = ?`, [id]),
  ]);
  const row = read.results[0];
  if (!row) throw notFound('No such screen.');
  if (!beat.meta.changes) {
    return json({ error: `One heartbeat every ${HEARTBEAT_GAP} seconds is enough.`, code: 'rate_limited' }, 429, { 'Retry-After': String(HEARTBEAT_GAP) });
  }
  const settings = screenSettings(parseJson(row.value_json, {}));
  return { refresh_version: settings.refresh_version, seconds_per_scene: settings.seconds_per_scene };
}

/** Adds this module's routes. `admin` wraps a handler so it requires a signed-in user. */
export function register(router, admin) {
  router.post('/api/public/screens/:id/heartbeat', heartbeat);
  router.get('/api/admin/businesses/:slug/screens', admin(list));
  router.post('/api/admin/businesses/:slug/screens', admin(create));
  router.post('/api/admin/businesses/:slug/screens/refresh', admin(refresh));
  router.patch('/api/admin/screens/:id', admin(patch));
  router.delete('/api/admin/screens/:id', admin(remove));
}
