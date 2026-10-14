// Rome's Joy admin Worker: the tool layer shared by the admin Assistant and the Claude app connector
// (docs/assistant-api.md §2). Each tool is defined once: a name, a plain description, a JSON Schema that works with
// strict tool use, and a handler that runs as the signed-in person. Reads go through the existing admin handlers and
// writes only ever become a draft change set, so a tool can never do more than that person could do by hand.
import { ApiError } from './http.js';
import { all, first, isoTime, parseJson } from './db.js';
import { requireBusiness } from './auth.js';
import { isDate } from './validate.js';
import { chicagoModifier, chicagoNow } from './time.js';
import { listBusinesses } from './public.js';
import * as businesses from './admin-businesses.js';
import * as events from './admin-events.js';
import * as menu from './admin-menu.js';
import * as announcements from './admin-announcements.js';
import * as artworks from './admin-artworks.js';
import * as inquiries from './admin-inquiries.js';
import * as history from './admin-history.js';
import { discardChangeSet, getChangeSet, proposeChangeSet, verifyChangeSet } from './changesets.js';

const LIST_CAP = 50;
const ONLINE_MINUTES = 10;

/** The op names a change set understands (docs/assistant-api.md §1). */
export const OPS = [
  'business.patch', 'hours.put', 'hours_exception.create', 'hours_exception.delete',
  'event.create', 'event.patch', 'event.delete',
  'menu_section.create', 'menu_section.patch', 'menu_section.delete',
  'menu_item.create', 'menu_item.patch', 'menu_item.delete',
  'announcement.create', 'announcement.patch', 'announcement.delete',
  'artwork.create', 'artwork.patch', 'artwork.delete',
  'artwork_image.add', 'artwork_image.patch', 'artwork_image.delete',
  'screen_settings.put',
];

/* -------------------------------------------------------------------------
   Schema helpers. Strict tool use wants every object closed (additionalProperties: false) and, per the contract,
   every property listed in `required`; optional values are typed as [type, "null"]. The API caps union-typed
   parameters at 16 across all strict tools, so nullable fields are kept to the few that need them.
   ------------------------------------------------------------------------- */
const prop = (type, description, extra = {}) => ({ type, description, ...extra });
const nullable = (type, description, extra = {}) => ({ type: [type, 'null'], description, ...extra });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SLUG = prop('string', 'The business slug, e.g. "peachs" (from list_businesses).');
const CHANGE_SET_ID = prop('string', 'The change set id that propose_changes returned.');

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */

/** Runs an existing admin handler as the same person, with route params and query string filled in. */
function asHandler(ctx, params = {}, query = {}) {
  const url = new URL('/', ctx.url?.origin || 'https://assistant.invalid');
  for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
  return { ...ctx, params, url, request: new Request(url) };
}

/** Caps a list at 50 and says so, so the model knows there is more. */
function capped(key, list, what = key) {
  const out = { [key]: list.slice(0, LIST_CAP) };
  if (list.length > LIST_CAP) out.note = `Showing the first ${LIST_CAP} of ${list.length} ${what}. Ask a narrower question to see others.`;
  return out;
}

/** Long text cut to `max` characters with an ellipsis, so results stay compact. */
const clip = (text, max) => (typeof text === 'string' && text.length > max ? `${text.slice(0, max).trimEnd()}…` : text ?? null);

/** Copies only the keys that are set (null, undefined and '' left out) to keep results small. */
function compact(obj, keys) {
  const out = {};
  for (const key of keys) {
    const value = obj[key];
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/** "Peach's" for a slug, from a { slug: name } map; falls back to the slug. */
const nameOf = (names, slug) => (slug && names?.[slug]) || slug || 'the business';

/** The table is created by the assistant migration; before it runs the photo and screen tools answer politely. */
const missingTable = (err) => /no such table/i.test(String(err?.message));

/** "2026-10-13 09:14" in Chicago for a UTC time (SQLite's or ISO); null when it cannot be read. */
function chicagoStamp(value) {
  const ms = Date.parse(isoTime(value));
  if (Number.isNaN(ms)) return null;
  const local = chicagoNow(new Date(ms));
  return `${local.date} ${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
}

/**
 * When a photo was taken, as Chicago time: the camera's own clock when the time has no zone (what phones write), else
 * converted. "2026-10-13 09:14", or just the date.
 */
function takenLocal(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return chicagoStamp(text);
  return text.replace('T', ' ').slice(0, 16);
}

/** getChangeSet may hand back the change set itself or { change_set }. */
const unwrap = (result) => result?.change_set ?? result;

/** The compact draft shape both front doors show the model. */
function draftResult(cs) {
  return {
    change_set_id: cs.id,
    title: cs.title,
    status: cs.status,
    expires_at: cs.expires_at,
    published_at: cs.published_at ?? null,
    summary: cs.summary,
    checks: cs.checks,
    preview_urls: cs.preview_urls,
  };
}

/* -------------------------------------------------------------------------
   Read tools
   ------------------------------------------------------------------------- */
const BUSINESS_KEYS = ['slug', 'name', 'short_name', 'tagline', 'description', 'address1', 'address2', 'city', 'state', 'zip',
  'phone', 'public_email', 'inquiry_emails', 'website_url', 'instagram_url', 'facebook_url', 'map_url', 'order_url', 'book_url',
  'hours_note', 'notice', 'notice_until'];
const EVENT_KEYS = ['id', 'kind', 'title', 'subtitle', 'description', 'start_date', 'end_date', 'start_time', 'end_time', 'date_text',
  'time_text', 'location', 'link_url', 'link_label', 'image_url', 'featured', 'published', 'status'];
const ITEM_KEYS = ['id', 'name', 'portion', 'price', 'prices', 'description', 'tags', 'allergens', 'featured', 'available'];
const ANNOUNCEMENT_KEYS = ['id', 'business_slug', 'title', 'body', 'link_url', 'link_label', 'image_url', 'starts_at', 'ends_at',
  'show_on_tv', 'published'];
const ARTWORK_KEYS = ['id', 'title', 'artist', 'year', 'medium', 'dimensions', 'description', 'price', 'price_display', 'status',
  'featured', 'published', 'event_id', 'event_title'];

async function listBusinessesTool(ctx) {
  const [{ businesses: rows }, open] = await Promise.all([
    businesses.list(asHandler(ctx)),
    listBusinesses(ctx.env, ctx.now),
  ]);
  const openBySlug = new Map(open.map((b) => [b.slug, b.open_now?.text]));
  return {
    businesses: rows.map((b) => ({
      ...compact(b, ['slug', 'name', 'short_name', 'hours_summary', 'notice', 'notice_until']),
      open_now: openBySlug.get(b.slug) || null,
      new_inquiries: b.counts?.new_inquiries ?? 0,
      artwork_catalog: Boolean(b.features?.artworks),
    })),
  };
}

async function getBusinessTool(ctx, { slug }) {
  const { business, hours, exceptions } = await businesses.get(asHandler(ctx, { slug }));
  const noticeShowing = Boolean(business.notice) && (!business.notice_until || business.notice_until >= ctx.now.date);
  return {
    business: { ...compact(business, BUSINESS_KEYS), notice_showing: noticeShowing },
    weekly_hours: hours.map((h) => ({ weekday: h.weekday, day: h.label, closed: h.closed, open_min: h.open_min, close_min: h.close_min, text: h.text })),
    special_days: exceptions.map((e) => compact(e, ['id', 'date', 'label', 'closed', 'open_min', 'close_min', 'text'])),
  };
}

async function listEventsTool(ctx, { slug, status }) {
  const { events: rows } = await events.list(asHandler(ctx, { slug }, { status }));
  return capped('events', rows.map((e) => ({ ...compact(e, EVENT_KEYS), description: clip(e.description, 500) })));
}

async function getMenuTool(ctx, { slug }) {
  const { sections } = await menu.list(asHandler(ctx, { slug }));
  const shaped = sections.map((s) => ({
    ...compact(s, ['id', 'title', 'short_title', 'description', 'published']),
    ...capped('items', s.items.map((i) => compact(i, ITEM_KEYS)), `items in ${s.title}`),
  }));
  return capped('sections', shaped, 'sections');
}

async function listAnnouncementsTool(ctx, { slug }) {
  const result = slug
    ? await announcements.listBusiness(asHandler(ctx, { slug }))
    : await announcements.listFamily(asHandler(ctx, {}, { scope: 'family' }));
  const today = ctx.now.date;
  return capped('announcements', result.announcements.map((a) => ({
    ...compact(a, ANNOUNCEMENT_KEYS),
    body: clip(a.body, 500),
    showing_now: Boolean(a.published) && (!a.starts_at || a.starts_at <= today) && (!a.ends_at || a.ends_at >= today),
  })));
}

async function listArtworksTool(ctx, { slug, status, event_id: eventId }) {
  const { artworks: rows } = await artworks.list(asHandler(ctx, { slug }, { status, event_id: eventId }));
  return capped('artworks', rows.map((a) => ({
    ...compact(a, ARTWORK_KEYS),
    description: clip(a.description, 300),
    images: a.images.map((i) => compact(i, ['id', 'url', 'alt'])),
  })));
}

async function listInquiriesTool(ctx, { slug, status, include_contact: includeContact }) {
  const { inquiries: rows } = await inquiries.list(asHandler(ctx, { slug }, { status, limit: LIST_CAP }));
  return {
    inquiries: rows.map((q) => ({
      id: q.id,
      form_type: q.form_type,
      name: q.name,
      message: clip(q.message, 200),
      date: q.created_at,
      status: q.status,
      ...(includeContact ? compact(q, ['email', 'phone']) : {}),
    })),
    ...(rows.length >= LIST_CAP ? { note: `Showing the newest ${LIST_CAP}.` } : {}),
  };
}

async function getHistoryTool(ctx, { slug, limit }) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), LIST_CAP);
  const { entries } = await history.listBusiness(asHandler(ctx, { slug }, { limit: n }));
  return { changes: entries.map((e) => ({ id: e.id, when: e.created_at, who: e.user_email, summary: e.summary })) };
}

async function listPhotosTool(ctx, { slug, album, query, since }) {
  const business = await requireBusiness(ctx, slug);
  if (since != null && !isDate(since)) return { error: 'since must be a date like 2026-10-13.' };
  const where = ['m.business_slug = ?'];
  const binds = [business.slug];
  const albumName = typeof album === 'string' ? album.trim() : '';
  if (albumName && albumName.toLowerCase() === 'none') where.push('m.album_id IS NULL');
  else if (albumName) { where.push('a.name = ? COLLATE NOCASE'); binds.push(albumName); }
  const q = typeof query === 'string' ? query.trim().slice(0, 200) : '';
  if (q) {
    // % and _ typed by staff are matched literally.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(m.note LIKE ? ESCAPE '\\' OR m.alt LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')");
    binds.push(pattern, pattern, pattern);
  }
  if (since) {
    // taken_at is the camera's (Chicago) date; created_at is UTC, so it is turned into a Chicago date first.
    where.push("(CASE WHEN m.taken_at IS NOT NULL AND m.taken_at <> '' THEN substr(m.taken_at, 1, 10) ELSE date(m.created_at, ?) END) >= ?");
    binds.push(chicagoModifier(), since);
  }
  let rows;
  let albums;
  try {
    rows = await all(ctx.env, `SELECT m.*, a.name AS album_name FROM media m LEFT JOIN media_albums a ON a.id = m.album_id
      WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, [...binds, LIST_CAP + 1]);
    albums = await all(ctx.env, `SELECT a.name, COUNT(m.id) AS count FROM media_albums a LEFT JOIN media m ON m.album_id = a.id
      WHERE a.business_slug = ? GROUP BY a.id ORDER BY a.sort_order, a.name`, [business.slug]);
  } catch (err) {
    if (missingTable(err)) return { photos: [], albums: [], note: 'The photo library is not set up yet.' };
    throw err;
  }
  return {
    photos: rows.slice(0, LIST_CAP).map((p) => ({
      ...compact(p, ['id', 'url', 'thumb_url', 'note', 'alt', 'width', 'height']),
      album: p.album_name || null,
      taken_at_local: takenLocal(p.taken_at),
      added_at_local: chicagoStamp(p.created_at),
    })),
    albums,
    ...(rows.length > LIST_CAP ? { note: `Showing the newest ${LIST_CAP}. Narrow it down with album, query or since.` } : {}),
  };
}

async function getScreensTool(ctx, { slug }) {
  const business = await requireBusiness(ctx, slug);
  const setting = await first(ctx.env, 'SELECT value_json FROM settings WHERE key = ?', [`signage:${business.slug}`]);
  let rows;
  try {
    rows = await all(ctx.env, 'SELECT * FROM screens WHERE business_slug = ? ORDER BY name, id', [business.slug]);
  } catch (err) {
    if (!missingTable(err)) throw err;
    rows = [];
  }
  const now = Date.now();
  return {
    screens: rows.map((s) => {
      const seen = s.last_seen_at ? Date.parse(isoTime(s.last_seen_at)) : null;
      const status = seen == null ? 'never' : now - seen <= ONLINE_MINUTES * 60000 ? 'online' : 'offline';
      return { id: s.id, name: s.name, notes: s.notes || null, status, last_seen_at: isoTime(s.last_seen_at) || null, last_scene: s.last_scene || null };
    }),
    tv_settings: parseJson(setting?.value_json, {}) ?? {},
  };
}

/* -------------------------------------------------------------------------
   Draft, commit and verify tools
   ------------------------------------------------------------------------- */
async function proposeTool(ctx, { title, ops, replace_change_set_id: replaceId }) {
  const parsed = [];
  const problems = [];
  ops.forEach((op, index) => {
    let args;
    try { args = JSON.parse(op.args_json); } catch { args = undefined; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      problems.push({ op_index: index, message: 'args_json must be a JSON object, e.g. {"id": 12, "price": 14}.' });
      return;
    }
    parsed.push({ op: op.op, business_slug: op.business_slug, args });
  });
  if (problems.length) return { error: 'Some changes could not be read. Fix them and call propose_changes again.', details: problems };
  const { change_set: cs } = await proposeChangeSet(ctx, {
    title, ops: parsed, source: ctx.surface === 'assistant' ? 'assistant' : 'mcp',
    conversation_id: ctx.conversationId ?? null, replace_id: replaceId || null,
  });
  ctx.onDraft?.(cs);
  return draftResult(cs);
}

async function getChangeSetTool(ctx, { id }) {
  return draftResult(unwrap(await getChangeSet(ctx, id)));
}

async function discardTool(ctx, { id }) {
  const cs = unwrap(await discardChangeSet(ctx, id));
  return { change_set_id: cs.id, status: cs.status };
}

/**
 * The Claude app cannot publish: anything the model can see (an inquiry, a photo note) could talk it into a confirmation
 * step it runs itself. It hands the person a link to the draft in the back office instead, where they tap Publish while
 * signed in.
 */
async function publishLinkTool(ctx, { id }) {
  const cs = unwrap(await getChangeSet(ctx, id));
  if (cs.status !== 'draft') {
    const why = {
      published: 'This draft is already published. Call verify_change_set to check what is live.',
      expired: 'This draft expired (drafts last 48 hours). Draft it again with propose_changes.',
    };
    return { error: why[cs.status] || `This draft is ${cs.status}, so it cannot be published. Draft it again if the person still wants it.`, status: cs.status };
  }
  const base = String(ctx.env.PUBLIC_BASE_URL || ctx.url?.origin || '').replace(/\/+$/, '');
  return {
    ...draftResult(cs),
    publish_url: `${base}/admin/#/draft/${encodeURIComponent(cs.id)}`,
    next: 'Nothing is live yet. Give the person this link. They open it in the back office (signed in), check the summary and '
      + 'the preview, and tap Publish there. When they say it is published, call verify_change_set and tell them what is live.',
  };
}

const verifyTool = (ctx, { id }) => verifyChangeSet(ctx, id);

/* -------------------------------------------------------------------------
   The tools
   ------------------------------------------------------------------------- */
const OP_GUIDE = `Each op is {"op", "business_slug", "args_json"}. args_json is a JSON object written as text: the fields to set. \
Patches send "id" plus only the fields that change; sending null clears a field. Take ids from the read tools. To point at \
something created earlier in the same draft, use {"$ref": <index of that op>} in place of the id.

Ops and their args:
- business.patch: any of phone, public_email, inquiry_emails (comma-separated), website_url, instagram_url, facebook_url, \
map_url, order_url, book_url, address1, address2, city, state, zip, hours_note, tagline, description, notice (the banner at \
the top of the website and TV, up to 300 characters), notice_until (YYYY-MM-DD, the last day it shows; null = until removed). \
To take a notice down, set notice and notice_until to null.
- hours.put: {"hours": [all 7 days: {"weekday": 0-6 (0 = Sunday), "closed": true|false, "open_min", "close_min"}]}. \
Copy unchanged days from get_business. Times are minutes after midnight: 8 am = 480, 2:30 pm = 870, midnight = 1440.
- hours_exception.create: {"date", "closed", "open_min", "close_min", "label"} for one special day (a holiday, closing early). \
hours_exception.delete: {"id"}.
- event.create: {"title", "start_date", and any of "kind" (event|exhibition|program), "subtitle", "description", "end_date", \
"start_time", "end_time" ("HH:MM", 24-hour), "location", "link_url", "link_label", "image_url", "featured", "published"}. \
event.patch: {"id", ...fields}. event.delete: {"id"}.
- menu_section.create: {"title", "short_title", "description", "published"}. menu_section.patch: {"id", ...fields}. \
menu_section.delete: {"id"} (its dishes go too).
- menu_item.create: {"id": <section id>, "name", "price" (a number) or "prices" ([{"label", "value"}]), "portion", \
"description", "tags" (any of "GF", "V", "DF"), "allergens" (list of words), "featured", "available"}. \
menu_item.patch: {"id": <item id>, ...fields}; "available": false hides a dish without deleting it. menu_item.delete: {"id"}.
- announcement.create: {"title", "body", "link_url", "link_label", "image_url", "starts_at", "ends_at" (YYYY-MM-DD), \
"show_on_tv", "published"}; business_slug null makes it family-wide (owners and admins only). announcement.patch: \
{"id", ...fields}. announcement.delete: {"id"}.
- artwork.create: {"title", "artist", "year", "medium", "dimensions", "description", "price", "price_display" \
(show|on_request|hidden), "status" (available|reserved|sold|not_for_sale), "featured", "published", "event_id"}. \
artwork.patch: {"id", ...fields}. artwork.delete: {"id"}.
- artwork_image.add: {"id": <artwork id>, "url", "thumb_url", "alt", "width", "height"} with url and thumb_url from \
list_photos. artwork_image.patch: {"id": <image id>, "alt"}. artwork_image.delete: {"id": <image id>}.
- screen_settings.put: {"value": {...}} replaces the TV settings of the business: start from tv_settings in get_screens, \
keep every key you are not changing, and set "seconds_per_scene" or "scenes" ({"welcome", "notice", "announcements", \
"featured", "menu", "catering", "events", "artworks": true|false}).`;

export const TOOLS = [
  {
    name: 'list_businesses',
    kind: 'read',
    description: 'Lists the businesses this person can edit, with whether each is open right now, a summary of the weekly '
      + 'hours, the notice banner, and the number of new website inquiries. Call it first when you do not yet know which '
      + 'business a request is about.',
    input_schema: object({}),
    label: () => 'Looking at your businesses…',
    handler: listBusinessesTool,
  },
  {
    name: 'get_business',
    kind: 'read',
    description: 'Gets one business: contact details and links, the notice banner, the weekly hours and the upcoming '
      + 'special days (holidays, early closings). Call it before changing hours, contact details, links or the notice.',
    input_schema: object({ slug: SLUG }),
    label: (input, names) => `Looking at the details and hours for ${nameOf(names, input.slug)}…`,
    handler: getBusinessTool,
  },
  {
    name: 'list_events',
    kind: 'read',
    description: 'Lists the events, exhibitions and programs of a business, with their ids, dates, times, links, photos '
      + 'and whether they are published. Call it before adding, changing or removing an event.',
    input_schema: object({
      slug: SLUG,
      status: prop('string', 'Which events: current (on now), upcoming, past, or all.', { enum: ['current', 'upcoming', 'past', 'all'] }),
    }),
    label: (input, names) => `Looking at the events for ${nameOf(names, input.slug)}…`,
    handler: listEventsTool,
  },
  {
    name: 'get_menu',
    kind: 'read',
    description: 'Gets the full menu of a business: sections and dishes with ids, prices, descriptions, dietary tags, '
      + 'allergens and whether each is available. Call it before changing anything on a menu.',
    input_schema: object({ slug: SLUG }),
    label: (input, names) => `Reading the menu for ${nameOf(names, input.slug)}…`,
    handler: getMenuTool,
  },
  {
    name: 'list_announcements',
    kind: 'read',
    description: 'Lists the announcements (news and promotions on the website and TV) of a business, or the family-wide '
      + 'ones when slug is null (owners and admins only). Call it before changing an announcement.',
    input_schema: object({ slug: nullable('string', 'The business slug, or null for family-wide announcements.') }),
    label: (input, names) => (input.slug ? `Looking at the announcements for ${nameOf(names, input.slug)}…` : 'Looking at the family-wide announcements…'),
    handler: listAnnouncementsTool,
  },
  {
    name: 'list_artworks',
    kind: 'read',
    description: 'Lists the pieces in the art catalog of a business (Blanc), with ids, artist, price, how the price shows, '
      + 'status, exhibition and photos. Call it before changing an artwork.',
    input_schema: object({
      slug: SLUG,
      status: prop('string', 'Only pieces with this status, or all.', { enum: ['available', 'reserved', 'sold', 'not_for_sale', 'all'] }),
      event_id: nullable('integer', 'Only pieces in this exhibition (an event id), or null for every piece.'),
    }),
    label: (input, names) => `Looking at the artworks for ${nameOf(names, input.slug)}…`,
    handler: listArtworksTool,
  },
  {
    name: 'list_inquiries',
    kind: 'read',
    description: 'Lists recent website form submissions (contact, quotes, events, applications) for a business: who, which '
      + 'form, the start of the message, the date and the status. Customers\' email and phone are left out unless '
      + 'include_contact is true; only ask for them when the person wants them. Use it only when the person asks about inquiries.',
    input_schema: object({
      slug: SLUG,
      status: prop('string', 'Which inquiries: new, handled, spam, or all.', { enum: ['new', 'handled', 'spam', 'all'] }),
      include_contact: prop('boolean', 'true to include the email address and phone number of each inquiry.'),
    }),
    label: (input, names) => `Checking the website inquiries for ${nameOf(names, input.slug)}…`,
    handler: listInquiriesTool,
  },
  {
    name: 'get_history',
    kind: 'read',
    description: 'Lists recent changes to a business (who changed what, and when), newest first. Use it when the person '
      + 'asks what changed or who changed something.',
    input_schema: object({ slug: SLUG, limit: prop('integer', 'How many changes to show, 1 to 50 (20 is a good default).') }),
    label: (input, names) => `Checking the recent changes for ${nameOf(names, input.slug)}…`,
    handler: getHistoryTool,
  },
  {
    name: 'list_photos',
    kind: 'read',
    description: 'Searches the photo library of a business (photos staff took or uploaded), most recently added first, '
      + 'with the note staff typed, the album, added_at_local (when it was added, Chicago time) and taken_at_local (when it '
      + 'was taken, from the camera\'s clock, Chicago time; missing for some photos). Use it whenever a change needs a photo, '
      + 'for example "the photo I took this morning"; use the url (and thumb_url) it returns. If more than one photo could '
      + 'fit, ask which one.',
    input_schema: object({
      slug: SLUG,
      album: nullable('string', 'Only this album (by name), "none" for photos without an album, or null for all albums.'),
      query: nullable('string', 'Words to look for in the photo note, description or album name, or null.'),
      since: nullable('string', 'Only photos taken or added on or after this date (YYYY-MM-DD), or null.'),
    }),
    label: (input, names) => `Looking through the photos for ${nameOf(names, input.slug)}…`,
    handler: listPhotosTool,
  },
  {
    name: 'get_screens',
    kind: 'read',
    description: 'Lists the in-store TV screens of a business (online, offline or never connected, and when each was last '
      + 'seen) and the current TV settings (seconds per scene and which scenes show). Call it before changing TV settings.',
    input_schema: object({ slug: SLUG }),
    label: (input, names) => `Checking the TV screens for ${nameOf(names, input.slug)}…`,
    handler: getScreensTool,
  },
  {
    name: 'propose_changes',
    kind: 'draft',
    description: 'Drafts changes for the person to review; nothing goes live. The draft gets a plain before → after summary, '
      + 'automatic checks (ok, warn, block) and preview links that show the website and TV as they would look, and a person '
      + 'must publish it. Call it whenever the person wants something changed, after reading the current data and confirming '
      + 'the details. Put everything for this conversation in one draft; to change it, call again with replace_change_set_id. '
      + 'If it returns an error with details, fix those ops and call it again.\n\n' + OP_GUIDE,
    input_schema: object({
      title: prop('string', 'One short line saying what the draft does, e.g. "Close early Friday + add Juneteenth brunch".'),
      ops: prop('array', 'The changes, in the order they should happen (at most 40).', {
        items: object({
          op: prop('string', 'Which change.', { enum: OPS }),
          business_slug: nullable('string', 'The business it changes; null only for a family-wide announcement.'),
          args_json: prop('string', 'The args for this op as a JSON object, e.g. {"id": 12, "price": 14}.'),
        }),
      }),
      replace_change_set_id: nullable('string', 'The id of this conversation\'s current draft to replace, or null for a new draft.'),
    }),
    label: () => 'Drafting the changes…',
    handler: proposeTool,
  },
  {
    name: 'get_change_set',
    kind: 'read',
    description: 'Gets a draft or published change set: its status, summary, checks and preview links.',
    input_schema: object({ id: CHANGE_SET_ID }),
    label: () => 'Looking at the draft…',
    handler: getChangeSetTool,
  },
  {
    name: 'discard_change_set',
    kind: 'draft',
    description: 'Throws away a draft change set. Only do this when the person says they no longer want it.',
    input_schema: object({ id: CHANGE_SET_ID }),
    label: () => 'Discarding the draft…',
    handler: discardTool,
  },
  {
    name: 'get_publish_link',
    kind: 'read',
    only: 'mcp',
    description: 'Gets the back office link where the person publishes a draft. You cannot publish: the person opens the '
      + 'link, signed in to the back office, checks the draft and taps Publish there. Call it when they have seen the '
      + 'summary and the preview and want the change live, and give them the link. After they say it is published, call '
      + 'verify_change_set.',
    input_schema: object({ id: CHANGE_SET_ID }),
    label: () => 'Getting the link to publish…',
    handler: publishLinkTool,
  },
  {
    name: 'verify_change_set',
    kind: 'verify',
    description: 'After a change set was published, re-reads the live website data and reports whether each change is now '
      + 'showing. Call it after every publish and tell the person the result; never say something is live without it.',
    input_schema: object({ id: CHANGE_SET_ID }),
    label: () => 'Checking the live website…',
    handler: verifyTool,
  },
];

/**
 * The tools each front door offers. Neither publishes: people tap Publish in the back office. The Claude app also gets
 * get_publish_link, because its drafts are not on a card in front of the person.
 */
export function toolsFor(surface) {
  return surface === 'mcp' ? TOOLS : TOOLS.filter((t) => t.only !== 'mcp');
}

/* -------------------------------------------------------------------------
   Input checking. Strict tool use already guarantees the shape for the admin Assistant; the Claude app connector
   (and anything else) goes through the same check so a handler only ever sees well-formed input.
   ------------------------------------------------------------------------- */
const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array'
  : Number.isInteger(value) ? 'integer' : typeof value);

function checkInput(schema, value, path = 'input') {
  const types = [].concat(schema.type || []);
  const actual = typeOf(value);
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
    return `${path} must be ${types.join(' or ')}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.filter((v) => v !== null).join(', ')}`;
  if (actual === 'object' && schema.properties) {
    for (const key of schema.required || []) if (!(key in value)) return `${path}.${key} is missing`;
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !(key in schema.properties));
      if (extra) return `${path}.${extra} is not expected`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) {
        const problem = checkInput(sub, value[key], `${path}.${key}`);
        if (problem) return problem;
      }
    }
  }
  if (actual === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = checkInput(schema.items, value[i], `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Runs one tool as ctx.user. Returns the tool's JSON-serializable result, or { error, code?, details? } when the input
 * does not fit, the person may not do it, or the data says no; never throws for those, so the model can adjust.
 * ctx.surface ('assistant' | 'mcp', default 'mcp') and ctx.conversationId tag drafts with where they came from;
 * ctx.onDraft(change_set), when set, hears about every successful draft.
 */
export async function runTool(ctx, name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `There is no tool called ${name}.` };
  if (!ctx.user) return { error: 'Please sign in again.', code: 'unauthorized' };
  if (tool.only === 'mcp' && ctx.surface === 'assistant') {
    return { error: 'The person publishes with the Publish button on the draft card in this chat.' };
  }
  const problem = checkInput(tool.input_schema, input ?? {});
  if (problem) return { error: `That does not fit the ${name} tool: ${problem}.` };
  try {
    return await tool.handler(ctx, input);
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: err.message, code: err.code, ...(Array.isArray(err.details) && err.details.length ? { details: err.details } : {}) };
    }
    console.error(`Tool ${name} failed:`, err);
    return { error: 'Something went wrong on our side while doing that.', code: 'internal' };
  }
}

/** A friendly progress line for a tool call ("Looking at the details and hours for Peach's…"). */
export function toolLabel(name, input, names) {
  const tool = TOOLS.find((t) => t.name === name);
  try { return tool ? tool.label(input || {}, names) : 'Working…'; } catch { return 'Working…'; }
}

/** { slug: short display name } for every business, in site order, for progress labels (names are public anyway). */
export async function businessNames(env) {
  const rows = await all(env, 'SELECT slug, name, short_name FROM businesses ORDER BY sort_order, slug');
  return Object.fromEntries(rows.map((row) => [row.slug, row.short_name || row.name]));
}
