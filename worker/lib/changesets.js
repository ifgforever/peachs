// Change sets: drafts, previews, double-checks, publish, verify, undo (docs/assistant-api.md §1).
// A change set is a list of ops the Assistant (or the Claude app) wants to make. Proposing one changes nothing: every op
// is applied in memory to the rows the public bundle is built from (the "simulation"), which validates it and gives the
// before → after summary, the double-checks and the website preview. Publishing runs each op through the existing admin
// handler, so validation, permissions and History are exactly those of a manual edit; if one fails, the ones already
// made are put back from History, newest first. Nothing is live until a person publishes.
import { ApiError, bad, conflict, forbidden, intParam, json, notFound, readBody } from './http.js';
import { all, first, isoTime, parseJson, pick, run, sqlNow } from './db.js';
import { readFields } from './validate.js';
import { assertCanEdit, canEdit, isManager, requireManager } from './auth.js';
import { audit, changedKeys, fieldLabel, fieldLabels, listWords, quote } from './audit.js';
import { DAY_LABELS, chicagoNow, eventDateText, eventTimeText, hoursText, minutesToText, parseDate, shapeHours, shortDate, timeToMinutes, weekdayOf } from './time.js';
import { ARTWORK_STATUS_TEXT, artworkPrice, buildBundle, formatUsd, loadBundleRows, renderBundle } from './public.js';
import { restoreEntry } from './admin-history.js';
import * as businesses from './admin-businesses.js';
import * as events from './admin-events.js';
import * as menu from './admin-menu.js';
import * as announcements from './admin-announcements.js';
import * as artworks from './admin-artworks.js';
import * as settings from './admin-settings.js';

const MAX_OPS = 40;
const BIG_CHANGE = 15;           // more ops than this gets a "check the preview carefully" warning
const DRAFT_HOURS = 48;
const UNDO_DAYS = 30;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const STATUSES = ['draft', 'published', 'discarded', 'expired', 'failed', 'undone'];
/** What History says made the change: "Assistant: Changed Saturday hours …". */
const SOURCES = { assistant: 'Assistant', mcp: 'Claude app' };
/** Where each business's website lives, for the preview links. */
const SITE_PATHS = {
  romesjoy: '/romesjoy/', peachs: '/peachs.html', catering: '/catering/', 'parkway-social': '/parkway-social/',
  'mise-en-place': '/mise-en-place/', blanc: '/blanc/', 'rjc-sausage': '/rjc-sausage/',
};
const ENTITY_WORDS = {
  hours_exception: 'special hours entry', event: 'event', menu_section: 'menu section', menu_item: 'menu item',
  announcement: 'announcement', artwork: 'artwork', artwork_image: 'artwork photo',
};
const PRICE_DISPLAY_TEXT = { show: 'Show the price', on_request: 'Price on request', hidden: "Don't show the price" };
const HIDDEN_DETAIL = 'Saved. Not on the website right now: it is hidden, a draft, or outside its dates.';

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRef = (v) => isObject(v) && '$ref' in v;
const capitalize = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const displayName = (b) => b.short_name || b.name;
const nulls = (columns) => Object.fromEntries(columns.map((c) => [c, null]));
const nextPosition = (list) => list.reduce((max, r) => Math.max(max, Number(r.sort_order) || 0), -1) + 1;
const removeRow = (list, row) => list.splice(list.indexOf(row), 1);
const photoName = (url) => String(url || '').split(/[?#]/)[0].split('/').pop() || 'photo';
const messageOf = (err) => (err instanceof ApiError ? err.message : 'Something went wrong on our side.');
/** Rows made by a draft get negative ids in the simulation and the preview: -1 for op 0, -2 for op 1, … */
const virtualId = (index) => -(index + 1);

/** "Thu, Nov 26, 2026". */
function dayText(date) {
  const p = parseDate(date);
  return p ? `${shortDate(date)}, ${p.y}` : String(date);
}

/** 22 URL-safe characters from 16 random bytes (128 bits): the id is also the preview link's secret. */
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A draft whose 48 hours have passed reads as expired, whether or not the row has been updated yet. */
const effectiveStatus = (row) => (row.status === 'draft' && row.expires_at <= sqlNow() ? 'expired' : row.status);

/** A stand-in for the request an admin handler reads its JSON body from (readBody uses these). */
const jsonRequest = (body) => ({
  headers: new Headers({ 'Content-Type': 'application/json' }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** One value as staff read it in a before → after line; null means "nothing". */
function shown(key, value, c) {
  if (value == null || value === '') return null;
  switch (key) {
    case 'price': return formatUsd(Number(value));
    case 'prices_json': return parseJson(value, []).map((p) => `${p.label} ${formatUsd(p.value)}`).join(' · ') || null;
    case 'tags_json': case 'allergens_json': { const list = parseJson(value, []); return list.length ? list.join(', ') : 'none'; }
    case 'featured': case 'show_on_tv': return value ? 'Yes' : 'No';
    case 'published': return value ? 'Shown on the website' : 'Hidden (draft)';
    case 'available': return value ? 'On the menu' : 'Hidden (not available)';
    case 'status': return ARTWORK_STATUS_TEXT[value] || String(value);
    case 'price_display': return PRICE_DISPLAY_TEXT[value] || String(value);
    case 'event_id': return c.rows.events.find((e) => e.id === value)?.title ?? `event #${value}`;
    case 'start_time': case 'end_time': return minutesToText(timeToMinutes(value));
    case 'start_date': case 'end_date': case 'starts_at': case 'ends_at': case 'notice_until': return dayText(value);
    default: {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return text.length > 140 ? `${text.slice(0, 139)}…` : text;
    }
  }
}

/* -------------------------------------------------------------------------
   Applying one op to rows in memory. `c` is { index, vid, today, ctx, rows, slug, name, lines, checks }; apply()
   validates with the admin modules' own rules (throwing their ApiErrors), adds the before → after lines and the
   double-checks, changes c.rows, and returns the new row's id for creates.
   ------------------------------------------------------------------------- */
const addLine = (c, line, before, after, field = null) => c.lines.push({ line, before, after, field });
const warn = (c, message) => c.checks.push({ level: 'warn', message });
const block = (c, message) => c.checks.push({ level: 'block', message });

function findRow(c, list, id, entity) {
  const row = (list || []).find((r) => r.id === id);
  if (!row) throw notFound(`There is no ${ENTITY_WORDS[entity]} #${id} at ${c.name}. Check the id with the read tools.`);
  return row;
}

function artworksOf(c) {
  if (!c.rows.artworks) throw bad('The artwork catalog is not set up on this server yet.', 'database_missing');
  return c.rows.artworks;
}

/** One line per changed field ("<prefix>: <field>"), then the row takes the new values. Returns the changed keys. */
function patchLines(c, row, values, prefix) {
  const changed = changedKeys(row, values);
  for (const key of changed) addLine(c, prefix ? `${prefix}: ${fieldLabel(key)}` : capitalize(fieldLabel(key)), shown(key, row[key], c), shown(key, values[key], c), key);
  if (!changed.length) warn(c, `${prefix || c.name}: nothing changes; it already says that.`);
  Object.assign(row, pick(values, changed));
  return changed;
}

/** A price must be above $0 (block); more than 3× or less than ⅓ of the old one is worth a second look (warn). */
function priceCheck(c, what, before, after) {
  if (after == null) return;
  if (!(after > 0)) block(c, `The price of ${what} would be ${formatUsd(after)}. Prices must be more than $0.`);
  else if (before > 0 && (after > before * 3 || after < before / 3)) {
    warn(c, `The price of ${what} goes from ${formatUsd(before)} to ${formatUsd(after)}. Please double-check it.`);
  }
}

function pricesCheck(c, what, beforeJson, afterJson) {
  const old = new Map(parseJson(beforeJson, []).map((p) => [String(p.label).toLowerCase(), p.value]));
  for (const p of parseJson(afterJson, [])) priceCheck(c, `${what} (${p.label})`, old.get(String(p.label).toLowerCase()) ?? null, p.value);
}

/** Losing an allergen or a GF / V / DF label is easy to do by accident and matters to guests. */
function labelCheck(c, item, values) {
  for (const [column, what] of [['allergens_json', 'Allergen info'], ['tags_json', 'Dietary info']]) {
    if (!(column in values)) continue;
    const kept = new Set(parseJson(values[column], []).map((s) => String(s).toLowerCase()));
    const lost = parseJson(item[column], []).filter((s) => !kept.has(String(s).toLowerCase()));
    if (lost.length) warn(c, `${what} removed from ${quote(item.name)}: ${lost.join(', ')}. Make sure that is right.`);
  }
}

/** Deleting something with photos, or that is featured, also takes those off the website. */
function deleteCheck(c, what, photos, featured) {
  const parts = [photos ? (photos === 1 ? 'has a photo' : `has ${photos} photos`) : null, featured ? 'is featured' : null].filter(Boolean);
  if (parts.length) warn(c, `${what} ${listWords(parts)}; deleting it takes that off the website too.`);
}

const eventWhen = (ev) => [eventDateText(ev.start_date, ev.end_date), eventTimeText(ev.start_time, ev.end_time)].filter(Boolean).join(' · ');
const eventName = (ev) => `${capitalize(ev.kind || 'event')} ${quote(ev.title)}`;

function pastEventCheck(c, ev) {
  if ((ev.end_date || ev.start_date) < c.today) warn(c, `${eventName(ev)} is entirely in the past, so it will only show under past events.`);
}

function itemText(item) {
  const price = item.price != null ? formatUsd(item.price) : shown('prices_json', item.prices_json, null);
  const tags = parseJson(item.tags_json, []);
  return [price, tags.length ? tags.join(', ') : null, item.available ? null : 'hidden (not available)'].filter(Boolean).join(' · ') || 'no price';
}

function announcementText(a) {
  return [`${dayText(a.starts_at)}${a.ends_at ? ` – ${dayText(a.ends_at)}` : ' onward'}`, a.show_on_tv ? 'also on the TV' : null,
    a.published ? null : 'hidden (draft)'].filter(Boolean).join(' · ');
}

function endedCheck(c, a) {
  if (a.ends_at && a.ends_at < c.today) warn(c, `Announcement ${quote(a.title)} ended on ${dayText(a.ends_at)}, so it will not show.`);
}

function findAnnouncement(c, id) {
  const row = findRow(c, c.rows.announcements, id, 'announcement');
  if ((row.business_slug ?? null) !== c.slug) {
    throw bad(row.business_slug ? `Announcement #${id} belongs to ${row.business_slug}.` : `Announcement #${id} is family-wide: send it with business_slug null.`);
  }
  return row;
}

function artworkText(a, c) {
  const event = a.event_id != null ? c.rows.events.find((e) => e.id === a.event_id) : null;
  return [ARTWORK_STATUS_TEXT[a.status] || a.status, artworkPrice(a).price_text || 'no price shown',
    event ? `in ${quote(event.title)}` : null, a.published ? null : 'hidden (draft)'].filter(Boolean).join(' · ');
}

function checkExhibition(c, eventId) {
  if (eventId != null && !c.rows.events.some((e) => e.id === eventId)) throw bad('That exhibition is not one of this business’s events.', 'invalid_event');
}

/** Artwork fields; an exhibition made earlier in the same draft ($ref) has a temporary negative id until publish. */
function artworkFields(args, mode) {
  const draftShow = Number.isInteger(args.event_id) && args.event_id < 0;
  const fields = readFields(draftShow ? { ...args, event_id: null } : args, artworks.ARTWORK_FIELDS, mode);
  if (draftShow) fields.event_id = args.event_id;
  return fields;
}

/** Price above $0, big jumps, and a sold piece set to show its price (the website hides it). */
function artworkChecks(c, art, beforePrice, values) {
  if ('price' in values && values.price != null) priceCheck(c, quote(art.title), beforePrice, values.price);
  if (('status' in values || 'price_display' in values) && art.status === 'sold' && art.price_display === 'show') {
    warn(c, `${quote(art.title)} is marked sold, so its price will be hidden on the website.`);
  }
}

const isClosedFlag = (v) => v === true || v === 1 || v === '1' || v === 'true';
const usualHours = (c, date) => `Usual hours: ${shapeHours(c.rows.hours).find((h) => h.weekday === weekdayOf(date))?.text || 'Closed'}`;
const exceptionLine = (row) => `Special hours on ${dayText(row.date)}${row.label ? ` (${row.label})` : ''}`;

/** TV settings flattened one level ("scenes.menu"), for the before → after lines. */
function flatSettings(value) {
  const out = {};
  for (const [key, v] of Object.entries(isObject(value) ? value : {})) {
    if (isObject(v)) for (const [k, x] of Object.entries(v)) out[`${key}.${k}`] = x;
    else out[key] = v;
  }
  return out;
}
const settingLabel = (key) => (key.startsWith('scenes.') ? `${key.slice(7)} scene` : key.replace(/[._]/g, ' '));
const settingText = (v) => (v === undefined || v === null ? null : v === true ? 'On' : v === false ? 'Off' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* -------------------------------------------------------------------------
   The ops. Each maps to one existing admin handler (see the route it mirrors in docs/assistant-api.md):
     handler   the admin module's function, called on publish with a synthesized ctx
     route     'slug' (params.slug = business_slug), 'id' (params.id = args.id, the rest is the body) or 'settings'
     refs      args keys that may be { "$ref": <index> }, and what the referenced op must create
     creates   the entity a create op makes (and createdId(result) its new id), for $ref and verify
     kind      create | update | delete, for verify; list = the rows key the entity lives in
     entity    what the public bundle shows it as (verify checks it is on the website)
   ------------------------------------------------------------------------- */
const OPS = {
  'business.patch': {
    handler: businesses.patch, route: 'slug', kind: 'update',
    apply(c, args) {
      const fields = readFields(args, businesses.BUSINESS_FIELDS, 'patch');
      const biz = c.rows.business;
      const changed = patchLines(c, biz, fields, null);
      if ((changed.includes('notice') || changed.includes('notice_until')) && biz.notice && biz.notice_until && biz.notice_until < c.today) {
        block(c, `The notice's end date (${dayText(biz.notice_until)}) has already passed, so the notice would not show. Pick a later date or leave it empty.`);
      }
    },
  },

  'hours.put': {
    handler: businesses.putHours, route: 'slug', kind: 'update',
    apply(c, args) {
      const week = businesses.readWeekHours(args);
      const before = shapeHours(c.rows.hours);
      const after = shapeHours(week);
      let changes = 0;
      after.forEach((day, i) => {
        if (day.text === before[i].text) return;
        changes++;
        addLine(c, `${day.label} hours`, before[i].text, day.text, `weekday:${day.weekday}`);
      });
      for (const raw of args.hours) {
        if (isClosedFlag(raw?.closed) && [raw.open_min, raw.close_min, raw.open, raw.close].some((v) => v != null && v !== '')) {
          warn(c, `${DAY_LABELS[Number(raw.weekday)]} is marked closed but also has times; it will show as Closed.`);
        }
      }
      if (!changes) warn(c, `${c.name}: the weekly hours stay the same.`);
      c.rows.hours = week.map((r) => ({ business_slug: c.slug, ...r }));
    },
  },

  'hours_exception.create': {
    handler: businesses.createException, route: 'slug', kind: 'create', list: 'exceptions', entity: 'hours_exception',
    creates: 'hours_exception', createdId: (r) => r.exception.id,
    expect: (c, args) => businesses.readException(args),
    apply(c, args) {
      const ex = businesses.readException(args);
      if (c.rows.exceptions.some((e) => e.date === ex.date)) {
        throw conflict(`There are already special hours for ${dayText(ex.date)}. Remove them first (hours_exception.delete).`, 'duplicate_date');
      }
      addLine(c, exceptionLine(ex), usualHours(c, ex.date), hoursText(ex));
      if (ex.date < c.today) block(c, `The special hours for ${dayText(ex.date)} are in the past, so they would never show. Check the date.`);
      c.rows.exceptions.push({ id: c.vid, business_slug: c.slug, ...ex });
      return c.vid;
    },
  },
  'hours_exception.delete': {
    handler: businesses.deleteException, route: 'id', refs: { id: 'hours_exception' }, kind: 'delete', list: 'exceptions',
    apply(c, { id }) {
      const row = findRow(c, c.rows.exceptions, id, 'hours_exception');
      addLine(c, exceptionLine(row), hoursText(row), usualHours(c, row.date));
      removeRow(c.rows.exceptions, row);
    },
  },

  'event.create': {
    handler: events.create, route: 'slug', kind: 'create', list: 'events', entity: 'event',
    creates: 'event', createdId: (r) => r.event.id,
    expect: (c, args) => readFields(args, events.EVENT_FIELDS, 'patch'),
    apply(c, args) {
      const fields = readFields(args, events.EVENT_FIELDS, 'create');
      events.checkDates(fields);
      const row = { ...nulls(events.EVENT_COLUMNS), id: c.vid, business_slug: c.slug, ...fields };
      addLine(c, `New ${row.kind} ${quote(row.title)}`, null, `${eventWhen(row)}${row.published ? '' : ' · hidden (draft)'}`);
      pastEventCheck(c, row);
      c.rows.events.push(row);
      return c.vid;
    },
  },
  'event.patch': {
    handler: events.patch, route: 'id', refs: { id: 'event' }, kind: 'update', entity: 'event',
    apply(c, { id, ...rest }) {
      const row = findRow(c, c.rows.events, id, 'event');
      const fields = readFields(rest, events.EVENT_FIELDS, 'patch');
      events.checkDates({ ...row, ...fields });
      const changed = patchLines(c, row, fields, eventName(row));
      if (changed.some((k) => k === 'start_date' || k === 'end_date')) pastEventCheck(c, row);
    },
  },
  'event.delete': {
    handler: events.remove, route: 'id', refs: { id: 'event' }, kind: 'delete', list: 'events',
    apply(c, { id }) {
      const row = findRow(c, c.rows.events, id, 'event');
      addLine(c, `Delete ${row.kind} ${quote(row.title)}`, eventWhen(row), null);
      deleteCheck(c, eventName(row), row.image_url ? 1 : 0, row.featured);
      const pieces = (c.rows.artworks || []).filter((a) => a.event_id === row.id);
      if (pieces.length) warn(c, `${pieces.length === 1 ? 'One artwork hangs' : `${pieces.length} artworks hang`} in ${quote(row.title)}; ${pieces.length === 1 ? 'it stays' : 'they stay'} in the catalog, "not in a show".`);
      for (const a of pieces) a.event_id = null;
      removeRow(c.rows.events, row);
    },
  },

  'menu_section.create': {
    handler: menu.createSection, route: 'slug', kind: 'create', list: 'sections', entity: 'menu_section',
    creates: 'menu_section', createdId: (r) => r.section.id,
    expect: (c, args) => readFields(args, menu.SECTION_FIELDS, 'patch'),
    apply(c, args) {
      const fields = readFields(args, menu.SECTION_FIELDS, 'create');
      if (fields.sort_order == null) fields.sort_order = nextPosition(c.rows.sections);
      const row = { ...nulls(menu.SECTION_COLUMNS), id: c.vid, business_slug: c.slug, ...fields };
      addLine(c, `New menu section ${quote(row.title)}`, null, shown('published', row.published, c));
      c.rows.sections.push(row);
      return c.vid;
    },
  },
  'menu_section.patch': {
    handler: menu.patchSection, route: 'id', refs: { id: 'menu_section' }, kind: 'update', entity: 'menu_section',
    apply(c, { id, ...rest }) {
      const row = findRow(c, c.rows.sections, id, 'menu_section');
      patchLines(c, row, readFields(rest, menu.SECTION_FIELDS, 'patch'), `Menu section ${quote(row.title)}`);
    },
  },
  'menu_section.delete': {
    handler: menu.deleteSection, route: 'id', refs: { id: 'menu_section' }, kind: 'delete', list: 'sections',
    apply(c, { id }) {
      const row = findRow(c, c.rows.sections, id, 'menu_section');
      const items = c.rows.items.filter((i) => i.section_id === row.id);
      addLine(c, `Delete menu section ${quote(row.title)}`, items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'empty', null);
      if (items.length) warn(c, `Deleting menu section ${quote(row.title)} also removes its ${items.length === 1 ? 'item' : `${items.length} items`}.`);
      for (const item of items) removeRow(c.rows.items, item);
      removeRow(c.rows.sections, row);
    },
  },

  'menu_item.create': {
    handler: menu.createItem, route: 'id', refs: { id: 'menu_section' }, kind: 'create', list: 'items', entity: 'menu_item',
    creates: 'menu_item', createdId: (r) => r.item.id,
    expect: (c, { id, ...rest }) => menu.itemColumns(readFields(rest, menu.ITEM_FIELDS, 'patch')),
    apply(c, { id, ...rest }) {
      const section = findRow(c, c.rows.sections, id, 'menu_section');
      const cols = menu.itemColumns(readFields(rest, menu.ITEM_FIELDS, 'create'));
      if (cols.sort_order == null) cols.sort_order = nextPosition(c.rows.items.filter((i) => i.section_id === section.id));
      const row = { ...nulls(menu.ITEM_COLUMNS), id: c.vid, ...cols, section_id: section.id };
      addLine(c, `New menu item ${quote(row.name)} in ${section.title}`, null, itemText(row));
      priceCheck(c, quote(row.name), null, row.price);
      pricesCheck(c, quote(row.name), null, row.prices_json);
      c.rows.items.push(row);
      return c.vid;
    },
  },
  'menu_item.patch': {
    handler: menu.patchItem, route: 'id', refs: { id: 'menu_item' }, kind: 'update', entity: 'menu_item',
    apply(c, { id, ...rest }) {
      const item = findRow(c, c.rows.items, id, 'menu_item');
      const values = menu.itemColumns(readFields(rest, menu.ITEM_FIELDS, 'patch'));
      if ('price' in values) priceCheck(c, quote(item.name), item.price, values.price);
      if ('prices_json' in values) pricesCheck(c, quote(item.name), item.prices_json, values.prices_json);
      labelCheck(c, item, values);
      patchLines(c, item, values, `Menu item ${quote(item.name)}`);
    },
  },
  'menu_item.delete': {
    handler: menu.deleteItem, route: 'id', refs: { id: 'menu_item' }, kind: 'delete', list: 'items',
    apply(c, { id }) {
      const item = findRow(c, c.rows.items, id, 'menu_item');
      const section = c.rows.sections.find((s) => s.id === item.section_id);
      addLine(c, `Remove ${quote(item.name)}${section ? ` from ${section.title}` : ''}`, itemText(item), null);
      deleteCheck(c, quote(item.name), 0, item.featured);
      removeRow(c.rows.items, item);
    },
  },

  'announcement.create': {
    handler: (ctx) => (ctx.params.slug ? announcements.createBusiness(ctx) : announcements.createFamily(ctx)),
    route: 'slug', family: true, kind: 'create', list: 'announcements', entity: 'announcement',
    creates: 'announcement', createdId: (r) => r.announcement.id,
    expect: (c, args) => readFields(args, announcements.ANNOUNCEMENT_FIELDS, 'patch'),
    apply(c, args) {
      const fields = readFields(args, announcements.ANNOUNCEMENT_FIELDS, 'create');
      if (!fields.starts_at) fields.starts_at = c.today;
      announcements.checkDates(fields);
      const row = { ...nulls(announcements.ANNOUNCEMENT_COLUMNS), id: c.vid, ...fields, business_slug: c.slug };
      addLine(c, `New ${c.slug ? '' : 'family-wide '}announcement ${quote(row.title)}`, null, announcementText(row));
      endedCheck(c, row);
      c.rows.announcements.push(row);
      return c.vid;
    },
  },
  'announcement.patch': {
    handler: announcements.patch, route: 'id', refs: { id: 'announcement' }, family: true, kind: 'update', entity: 'announcement',
    apply(c, { id, ...rest }) {
      const row = findAnnouncement(c, id);
      const fields = readFields(rest, announcements.ANNOUNCEMENT_FIELDS, 'patch');
      announcements.checkDates({ ...row, ...fields });
      const changed = patchLines(c, row, fields, `Announcement ${quote(row.title)}`);
      if (changed.includes('ends_at')) endedCheck(c, row);
    },
  },
  'announcement.delete': {
    handler: announcements.remove, route: 'id', refs: { id: 'announcement' }, family: true, kind: 'delete', list: 'announcements',
    apply(c, { id }) {
      const row = findAnnouncement(c, id);
      addLine(c, `Delete announcement ${quote(row.title)}`, announcementText(row), null);
      deleteCheck(c, `Announcement ${quote(row.title)}`, row.image_url ? 1 : 0, false);
      removeRow(c.rows.announcements, row);
    },
  },

  'artwork.create': {
    handler: artworks.create, route: 'slug', refs: { event_id: 'event' }, kind: 'create', list: 'artworks', entity: 'artwork',
    creates: 'artwork', createdId: (r) => r.artwork.id,
    expect: (c, args) => readFields(args, artworks.ARTWORK_FIELDS, 'patch'),
    apply(c, args) {
      const list = artworksOf(c);
      const fields = artworkFields(args, 'create');
      checkExhibition(c, fields.event_id);
      const row = { ...nulls(artworks.ARTWORK_COLUMNS), id: c.vid, business_slug: c.slug, ...fields, sort_order: nextPosition(list) };
      addLine(c, `New artwork ${quote(row.title)}${row.artist ? ` by ${row.artist}` : ''}`, null, artworkText(row, c));
      artworkChecks(c, row, null, fields);
      list.push(row);
      return c.vid;
    },
  },
  'artwork.patch': {
    handler: artworks.patch, route: 'id', refs: { id: 'artwork', event_id: 'event' }, kind: 'update', entity: 'artwork',
    apply(c, { id, ...rest }) {
      const row = findRow(c, artworksOf(c), id, 'artwork');
      const fields = artworkFields(rest, 'patch');
      if ('event_id' in fields) checkExhibition(c, fields.event_id);
      const beforePrice = row.price;
      patchLines(c, row, fields, `Artwork ${quote(row.title)}`);
      artworkChecks(c, row, beforePrice, fields);
    },
  },
  'artwork.delete': {
    handler: artworks.remove, route: 'id', refs: { id: 'artwork' }, kind: 'delete', list: 'artworks',
    apply(c, { id }) {
      const row = findRow(c, artworksOf(c), id, 'artwork');
      const images = c.rows.artworkImages.filter((i) => i.artwork_id === row.id);
      addLine(c, `Delete artwork ${quote(row.title)}`, artworkText(row, c), null);
      deleteCheck(c, `Artwork ${quote(row.title)}`, images.length, row.featured);
      for (const image of images) removeRow(c.rows.artworkImages, image);
      removeRow(c.rows.artworks, row);
    },
  },

  'artwork_image.add': {
    handler: artworks.addImage, route: 'id', refs: { id: 'artwork' }, kind: 'create', list: 'artworkImages', entity: 'artwork_image',
    creates: 'artwork_image', createdId: (r) => r.image.id,
    expect: (c, { id, ...rest }) => imageFields(c, readFields(rest, artworks.IMAGE_FIELDS, 'patch')),
    apply(c, { id, ...rest }) {
      const art = findRow(c, artworksOf(c), id, 'artwork');
      const fields = imageFields(c, readFields(rest, artworks.IMAGE_FIELDS, 'create'));
      const images = c.rows.artworkImages.filter((i) => i.artwork_id === art.id);
      if (images.length >= artworks.MAX_IMAGES) throw conflict(`A piece can have at most ${artworks.MAX_IMAGES} photos. Remove one first.`, 'too_many_images');
      const row = { ...nulls(artworks.IMAGE_COLUMNS), id: c.vid, ...fields, artwork_id: art.id, sort_order: nextPosition(images) };
      addLine(c, `Add a photo to ${quote(art.title)}`, null, row.alt || photoName(row.url));
      if (!row.alt) warn(c, `The new photo of ${quote(art.title)} has no description. Add one for people who use screen readers.`);
      c.rows.artworkImages.push(row);
      return c.vid;
    },
  },
  'artwork_image.patch': {
    handler: artworks.patchImage, route: 'id', refs: { id: 'artwork_image' }, kind: 'update', entity: 'artwork_image',
    apply(c, { id, ...rest }) {
      const image = findRow(c, c.rows.artworkImages, id, 'artwork_image');
      const art = artworksOf(c).find((a) => a.id === image.artwork_id);
      patchLines(c, image, readFields(rest, { alt: artworks.IMAGE_FIELDS.alt }, 'patch'), `Photo of ${quote(art?.title)}`);
    },
  },
  'artwork_image.delete': {
    handler: artworks.removeImage, route: 'id', refs: { id: 'artwork_image' }, kind: 'delete', list: 'artworkImages',
    apply(c, { id }) {
      const image = findRow(c, c.rows.artworkImages, id, 'artwork_image');
      const art = artworksOf(c).find((a) => a.id === image.artwork_id);
      addLine(c, `Remove a photo from ${quote(art?.title)}`, image.alt || photoName(image.url), null);
      removeRow(c.rows.artworkImages, image);
    },
  },

  'screen_settings.put': {
    handler: settings.put, route: 'settings', kind: 'update', entity: 'settings',
    apply(c, args) {
      if (!('value' in args)) throw bad('Send { value }.', 'missing_field');
      if (!isObject(args.value)) throw bad('The TV settings must be an object, e.g. {"seconds_per_scene": 12}.', 'invalid_field');
      if (JSON.stringify(args.value).length > 100000) throw bad('That value is too large.', 'invalid_field');
      if (!('signage' in c.rows)) return; // a website preview does not show the TV settings
      const before = flatSettings(c.rows.signage);
      const after = flatSettings(args.value);
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) addLine(c, `TV screens: ${settingLabel(key)}`, settingText(before[key]), settingText(after[key]), key);
      }
      const dropped = Object.keys(before).filter((k) => !(k in after));
      if (dropped.length) warn(c, `This removes the TV setting${dropped.length === 1 ? '' : 's'} ${listWords(dropped.map(settingLabel))}. Keep every setting you are not changing.`);
      if (!c.lines.length) warn(c, `${c.name}: the TV settings stay the same.`);
      c.rows.signage = args.value;
    },
  },
};

/** The definition of an op by name (own keys only, so "constructor" and the like are just unknown). */
const opDef = (name) => (typeof name === 'string' && Object.hasOwn(OPS, name) ? OPS[name] : null);

/** Photo links are checked the way the artworks module checks them (https, or this site's own uploads). */
function imageFields(c, fields) {
  if ('url' in fields) fields.url = artworks.checkPhotoUrl(fields.url, 'photo link', c.ctx);
  if ('thumb_url' in fields) fields.thumb_url = artworks.checkPhotoUrl(fields.thumb_url, 'thumbnail link', c.ctx);
  return fields;
}

/* -------------------------------------------------------------------------
   Reading ops: shape, $ref and ids
   ------------------------------------------------------------------------- */
function readOp(op) {
  if (!isObject(op)) throw bad('Each change must be an object { op, business_slug, args }.');
  const def = opDef(op.op);
  if (!def) throw bad(`"${op.op}" is not a change this tool can make. Use one of: ${Object.keys(OPS).join(', ')}.`, 'unknown_op');
  const slug = op.business_slug ?? null;
  if (slug == null && !def.family) throw bad('Say which business this is for (business_slug).', 'missing_field');
  if (slug != null && typeof slug !== 'string') throw bad('business_slug must be text, like "peachs".', 'invalid_field');
  if (op.args != null && !isObject(op.args)) throw bad('args must be an object.', 'invalid_field');
  return { def, slug };
}

/**
 * Replaces { "$ref": i } with the id op i created (`lookup(i)` → { entity, id }) and checks the id of ops that change
 * an existing row: a positive whole number, or a $ref.
 */
function resolveRefs(def, args, index, lookup) {
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (!isRef(value)) continue;
    const entity = def.refs?.[key];
    if (!entity) throw bad(`"${key}" cannot use $ref here.`, 'invalid_ref');
    const target = Number(value.$ref);
    if (!Number.isInteger(target) || target < 0 || target >= index) throw bad(`{"$ref": ${JSON.stringify(value.$ref)}} must be the index of an earlier change in this draft.`, 'invalid_ref');
    const ref = lookup(target);
    if (ref?.failed) throw bad(`{"$ref": ${target}} points to change ${target + 1}, which needs fixing first.`, 'invalid_ref');
    if (!ref || ref.entity !== entity || ref.id == null) throw bad(`{"$ref": ${target}} does not point to a new ${ENTITY_WORDS[entity]}.`, 'invalid_ref');
    out[key] = ref.id;
  }
  for (const [key, entity] of Object.entries(def.refs || {})) {
    if (isRef(args[key])) continue;
    if (key === 'id' && (out.id == null || out.id === '')) throw bad(`Give the id of the ${ENTITY_WORDS[entity]} (as "id").`, 'missing_field');
    if (out[key] == null || out[key] === '') continue;
    const n = Number(out[key]);
    if (!Number.isInteger(n) || n < 1) throw bad(`The id of the ${ENTITY_WORDS[entity]} ("${key}") must be a whole number.`, 'invalid_field');
    out[key] = n;
  }
  return out;
}

/** The params and body the op's admin route would have received. */
function routeFor(def, op, args) {
  const slug = op.business_slug ?? null;
  if (def.route === 'slug') return { params: { slug }, body: args };
  if (def.route === 'settings') return { params: { key: `signage:${slug}` }, body: args };
  const { id, ...body } = args;
  return { params: { id: String(id) }, body };
}

/* -------------------------------------------------------------------------
   The simulation: every op applied in order to the rows of the businesses it touches
   ------------------------------------------------------------------------- */
const FAMILY = '*';

/** The rows of one business (everything, drafts included), or of the family-wide announcements (slug null). */
async function rowsFor(env, slug, now, cache) {
  const key = slug ?? FAMILY;
  if (!cache.has(key)) {
    cache.set(key, slug == null
      ? { business: null, announcements: await all(env, 'SELECT * FROM announcements WHERE business_slug IS NULL') }
      : await loadBundleRows(env, slug, now, { signage: true, artworks: true }));
  }
  const rows = cache.get(key);
  if (!rows) throw notFound(`There is no business called "${slug}".`, 'unknown_business');
  return rows;
}

const opContext = (ctx, index, rows, slug) => ({
  index, vid: virtualId(index), today: ctx.now.date, ctx: { url: ctx.url, env: ctx.env }, rows, slug,
  name: slug == null ? 'Every business' : displayName(rows.business), lines: [], checks: [],
});

/**
 * Checks every op as the current user against the current data: → { summary, checks, businesses, problems }.
 * Problems are [{ op_index, message }]; nothing is written.
 */
async function simulate(ctx, ops) {
  const cache = new Map();
  const refs = [];
  const summary = [];
  const checks = [];
  const problems = [];
  const touched = new Set();
  for (let index = 0; index < ops.length; index++) {
    try {
      const { def, slug } = readOp(ops[index]);
      if (slug == null) {
        if (!isManager(ctx.user)) throw forbidden('Only owners and admins can change family-wide announcements.');
      } else if (!canEdit(ctx.user, slug)) {
        throw forbidden(`You can only change the businesses assigned to you, and "${slug}" is not one of them. An owner or admin can make this change.`);
      }
      const rows = await rowsFor(ctx.env, slug, ctx.now, cache);
      const c = opContext(ctx, index, rows, slug);
      const args = resolveRefs(def, ops[index].args || {}, index, (i) => refs[i]);
      const created = def.apply(c, args);
      if (def.creates) refs[index] = { entity: def.creates, id: created };
      if (slug) touched.add(slug);
      for (const l of c.lines) summary.push({ business_slug: slug, business_name: c.name, line: l.line, before: l.before, after: l.after, op_index: index, field: l.field });
      for (const k of c.checks) checks.push({ ...k, op_index: index });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      problems.push({ op_index: index, message: err.message });
      refs[index] = { failed: true };
    }
  }
  if (ops.length > BIG_CHANGE) checks.push({ level: 'warn', message: 'This is a big change; check the preview carefully.', op_index: null });
  if (!checks.length) checks.push({ level: 'ok', message: 'Checked: nothing unusual.', op_index: null });
  return { summary, checks, businesses: [...touched], problems };
}

/** 400 invalid_change_set with details [{ op_index, message }] for the model (or the admin) to fix. */
function invalidChangeSet(problems, lead = 'Some changes need fixing') {
  const list = problems.map((p) => `change ${p.op_index + 1}: ${p.message}`).join(' ');
  const err = bad(`${lead}. ${list}`, 'invalid_change_set');
  err.details = problems;
  return err;
}

/* -------------------------------------------------------------------------
   The change set as the API returns it
   ------------------------------------------------------------------------- */
const businessNames = async (env) => Object.fromEntries((await all(env, 'SELECT slug, name, short_name FROM businesses')).map((b) => [b.slug, displayName(b)]));

/** Website and TV preview links: absolute with PUBLIC_BASE_URL, else same-site paths. */
function previewUrls(env, id, slugs, ops, names) {
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const token = encodeURIComponent(id);
  // A family-wide announcement shows on every site; the family (hub) site stands for them.
  const family = ops.some((op) => isObject(op) && op.business_slug == null);
  const list = family && !slugs.includes('romesjoy') ? [...slugs, 'romesjoy'] : slugs;
  const urls = [];
  for (const slug of list) {
    if (SITE_PATHS[slug]) urls.push({ business_slug: slug, label: `${names[slug] || slug} website`, url: `${base}${SITE_PATHS[slug]}?preview=${token}` });
    urls.push({ business_slug: slug, label: 'TV screen', url: `${base}/signage/live.html?business=${encodeURIComponent(slug)}&preview=${token}` });
  }
  return urls;
}

function shapeChangeSet(env, row, names) {
  const slugs = parseJson(row.businesses_json, []);
  const ops = parseJson(row.ops_json, []);
  const result = parseJson(row.result_json, null);
  return {
    id: row.id,
    title: row.title,
    status: effectiveStatus(row),
    source: row.source,
    conversation_id: row.conversation_id,
    user_id: row.user_id,
    created_at: isoTime(row.created_at),
    updated_at: isoTime(row.updated_at),
    expires_at: isoTime(row.expires_at),
    published_at: isoTime(row.published_at),
    businesses: slugs,
    ops,
    summary: parseJson(row.summary_json, []),
    checks: parseJson(row.checks_json, []),
    preview_urls: previewUrls(env, row.id, slugs, ops, names),
    error: result?.error ?? null,
  };
}

async function shapeOne(env, id) {
  return shapeChangeSet(env, await first(env, 'SELECT * FROM change_sets WHERE id = ?', [id]), await businessNames(env));
}

/** Marks drafts past their 48 hours as expired (reads also treat them so before this runs). */
const expireDrafts = (env) => run(env, "UPDATE change_sets SET status = 'expired', updated_at = datetime('now') WHERE status = 'draft' AND expires_at <= datetime('now')");

/** The change set named by id, for its creator or an owner/admin (404 for anyone else: the id is a secret). */
async function loadChangeSet(ctx, id) {
  const row = ID_RE.test(String(id ?? '')) ? await first(ctx.env, 'SELECT * FROM change_sets WHERE id = ?', [id]) : null;
  if (!row || (row.user_id !== ctx.user.id && !isManager(ctx.user))) throw notFound('No such change set.');
  if (effectiveStatus(row) !== row.status) {
    await run(ctx.env, "UPDATE change_sets SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'draft'", [row.id]);
    row.status = 'expired';
  }
  return row;
}

const NOT_A_DRAFT = {
  published: 'This change set was already published.',
  discarded: 'This draft was discarded.',
  expired: 'This draft expired (drafts last 48 hours). Ask for the changes again to make a new draft.',
  failed: 'This draft could not be published earlier. Ask for the changes again to make a new draft.',
  undone: 'This change set was published and then undone.',
};
function assertDraft(row) {
  if (row.status === 'draft') return;
  throw conflict(NOT_A_DRAFT[row.status] || 'This is not a draft.', row.status === 'expired' ? 'change_set_expired' : 'not_a_draft');
}

/* -------------------------------------------------------------------------
   Exported functions (used by the routes below, assistant-tools.js, assistant.js and mcp.js)
   ------------------------------------------------------------------------- */

/**
 * Validates, checks and stores a draft: → { change_set }, or throws 400 invalid_change_set with details. With
 * replace_id (a draft of the same user) that draft is overwritten; if it is no longer a draft a new one is made.
 */
export async function proposeChangeSet(ctx, { title, ops, source = 'assistant', conversation_id = null, replace_id = null } = {}) {
  const fields = readFields({ title }, { title: { type: 'text', required: true, max: 200 } });
  if (!Object.hasOwn(SOURCES, String(source))) throw bad('source must be assistant or mcp.', 'invalid_field');
  if (!Array.isArray(ops) || !ops.length) throw bad('Send at least one change (ops).', 'invalid_change_set');
  if (ops.length > MAX_OPS) throw bad(`A draft can hold at most ${MAX_OPS} changes. Split it into smaller drafts.`, 'too_many_ops');
  const sim = await simulate(ctx, ops);
  if (sim.problems.length) throw invalidChangeSet(sim.problems);
  const values = [fields.title, source, conversation_id == null ? null : String(conversation_id).slice(0, 100), JSON.stringify(ops),
    JSON.stringify(sim.summary), JSON.stringify(sim.checks), JSON.stringify(sim.businesses)];

  if (replace_id != null && replace_id !== '') {
    const old = ID_RE.test(String(replace_id)) ? await first(ctx.env, 'SELECT id, user_id FROM change_sets WHERE id = ?', [replace_id]) : null;
    if (!old || old.user_id !== ctx.user.id) throw notFound('There is no draft with that id to replace.');
    const { meta } = await run(ctx.env, `UPDATE change_sets SET title = ?, source = ?, conversation_id = COALESCE(?, conversation_id), ops_json = ?,
      summary_json = ?, checks_json = ?, businesses_json = ?, updated_at = datetime('now'), expires_at = datetime('now', '+${DRAFT_HOURS} hours')
      WHERE id = ? AND status = 'draft' AND expires_at > datetime('now')`, [...values, old.id]);
    if (meta.changes) return { change_set: await shapeOne(ctx.env, old.id) };
  }
  const id = newId();
  await run(ctx.env, `INSERT INTO change_sets (id, user_id, title, source, conversation_id, ops_json, summary_json, checks_json, businesses_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${DRAFT_HOURS} hours'))`, [id, ctx.user.id, ...values]);
  return { change_set: await shapeOne(ctx.env, id) };
}

/** → the change set (its creator, or an owner/admin). */
export async function getChangeSet(ctx, id) {
  const row = await loadChangeSet(ctx, id);
  return shapeChangeSet(ctx.env, row, await businessNames(ctx.env));
}

/** Puts back audit entries newest first (rollback and Undo all). → { restored, failed }. */
async function restoreAll(ctx, auditIds, done = new Set()) {
  const restored = [];
  const failed = [];
  for (const auditId of [...auditIds].filter((x) => !done.has(x)).sort((a, b) => b - a)) {
    try {
      const entry = await first(ctx.env, 'SELECT * FROM audit_log WHERE id = ?', [auditId]);
      if (!entry) throw notFound('That history entry is gone.');
      await restoreEntry(ctx, entry);
      restored.push(auditId);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('Change set restore failed:', err);
      failed.push({ audit_id: auditId, error: messageOf(err) });
    }
  }
  return { restored, failed };
}

/**
 * Publishes a draft (its creator, or an owner/admin): checks it again against today's data, then runs each op through
 * its admin handler as this user. → { change_set, results }. A failing op rolls back the earlier ones (409 publish_failed).
 */
export async function publishChangeSet(ctx, id) {
  const row = await loadChangeSet(ctx, id);
  assertDraft(row);
  const ops = parseJson(row.ops_json, []);
  const sim = await simulate(ctx, ops);
  if (sim.problems.length) throw invalidChangeSet(sim.problems, 'The data changed since this draft was made, so it needs fixing first');
  const blocking = sim.checks.filter((k) => k.level === 'block');
  if (blocking.length) throw conflict(`This draft has a problem to fix before it can be published: ${blocking.map((k) => k.message).join(' ')}`, 'change_set_blocked');

  // Claim the draft first, so a second tap on Publish cannot run the same ops twice.
  const claim = await run(ctx.env, `UPDATE change_sets SET status = 'published', published_at = datetime('now'), updated_at = datetime('now'),
    summary_json = ?, checks_json = ?, businesses_json = ? WHERE id = ? AND status = 'draft' AND expires_at > datetime('now')`,
  [JSON.stringify(sim.summary), JSON.stringify(sim.checks), JSON.stringify(sim.businesses), row.id]);
  if (!claim.meta.changes) throw conflict('This draft is already being published, or it has just expired.', 'not_a_draft');

  const auditSource = SOURCES[row.source] || SOURCES.assistant;
  const results = [];
  const lookup = (i) => results[i] && { entity: opDef(ops[i].op).creates, id: results[i].created_id };
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const def = opDef(op.op);
    const opCtx = { ...ctx, auditSource, auditIds: [] };
    try {
      const { params, body } = routeFor(def, op, resolveRefs(def, op.args || {}, index, lookup));
      Object.assign(opCtx, { params, request: jsonRequest(body) });
      const out = await def.handler(opCtx);
      results.push({ op_index: index, op: op.op, business_slug: op.business_slug ?? null, ok: true, created_id: def.creates ? def.createdId(out) : null, audit_ids: opCtx.auditIds });
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(`Change set ${row.id}: op ${index} (${op.op}) failed:`, err);
      const error = `Change ${index + 1} could not be made: ${messageOf(err)}`;
      results.push({ op_index: index, op: op.op, business_slug: op.business_slug ?? null, ok: false, error: messageOf(err), audit_ids: opCtx.auditIds });
      const rollback = await restoreAll(ctx, results.flatMap((r) => r.audit_ids));
      await run(ctx.env, "UPDATE change_sets SET status = 'failed', updated_at = datetime('now'), result_json = ? WHERE id = ?",
        [JSON.stringify({ error, results, rollback }), row.id]);
      const after = rollback.failed.length
        ? ` ${rollback.failed.length} earlier change${rollback.failed.length === 1 ? '' : 's'} could not be put back automatically; check History.`
        : ' Nothing was changed: the earlier changes were put back.';
      throw conflict(`${error}${after}`, 'publish_failed');
    }
  }

  const auditIds = results.flatMap((r) => r.audit_ids);
  const published = { ...ctx, auditIds: [] };
  await audit(published, {
    business_slug: sim.businesses.length === 1 ? sim.businesses[0] : null, entity: 'change_set', entity_id: row.id, action: 'update',
    summary: `Published "${row.title}" (${ops.length} change${ops.length === 1 ? '' : 's'})`, after: { audit_ids: auditIds },
  });
  await run(ctx.env, "UPDATE change_sets SET result_json = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify({ results, audit_ids: auditIds, published_audit_id: published.auditIds[0] ?? null }), row.id]);
  return { change_set: await shapeOne(ctx.env, row.id), results };
}

/** → { change_set } with status discarded (a draft or an expired draft). */
export async function discardChangeSet(ctx, id) {
  const row = await loadChangeSet(ctx, id);
  if (row.status !== 'draft' && row.status !== 'expired') assertDraft(row);
  await run(ctx.env, "UPDATE change_sets SET status = 'discarded', updated_at = datetime('now') WHERE id = ? AND status IN ('draft', 'expired')", [row.id]);
  return { change_set: await shapeOne(ctx.env, row.id) };
}

/**
 * Undo all: restores every History entry the publish wrote, newest first, within 30 days. → { change_set } (undone).
 * When some cannot be put back (edited or deleted since), the rest are, and a retry carries on where it stopped.
 */
export async function undoChangeSet(ctx, id) {
  const row = await loadChangeSet(ctx, id);
  if (row.status !== 'published') throw conflict(row.status === 'undone' ? 'This change set was already undone.' : 'Only published changes can be undone.', 'not_published');
  if (Date.parse(isoTime(row.published_at)) < Date.now() - UNDO_DAYS * 86400000) {
    throw conflict(`Changes published more than ${UNDO_DAYS} days ago cannot be undone all at once. Use History to restore single changes.`, 'undo_too_late');
  }
  const result = parseJson(row.result_json, {}) || {};
  const auditIds = Array.isArray(result.audit_ids) ? result.audit_ids : [];
  const done = new Set(result.undone_audit_ids || []);
  // Undo needs the same rights as restoring each entry by hand.
  const entries = auditIds.length ? await all(ctx.env, 'SELECT id, business_slug FROM audit_log WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(auditIds)]) : [];
  for (const e of entries) {
    if (e.business_slug) assertCanEdit(ctx.user, e.business_slug);
    else requireManager(ctx.user, 'undo family-wide changes');
  }
  const claim = await run(ctx.env, "UPDATE change_sets SET status = 'undone', updated_at = datetime('now') WHERE id = ? AND status = 'published'", [row.id]);
  if (!claim.meta.changes) throw conflict('This change set is already being undone.', 'not_published');

  const { restored, failed } = await restoreAll(ctx, auditIds, done);
  for (const x of restored) done.add(x);
  const next = { ...result, undone_audit_ids: [...done], undo_failed: failed };
  if (failed.length) {
    await run(ctx.env, "UPDATE change_sets SET status = 'published', updated_at = datetime('now'), result_json = ? WHERE id = ?", [JSON.stringify(next), row.id]);
    throw conflict(`${done.size} of ${auditIds.length} changes were put back, but ${failed.length} could not be: ${failed[0].error} Try again, or use History.`, 'undo_failed');
  }
  const slugs = parseJson(row.businesses_json, []);
  const n = parseJson(row.ops_json, []).length;
  await audit(ctx, {
    business_slug: slugs.length === 1 ? slugs[0] : null, entity: 'change_set', entity_id: row.id, action: 'update',
    summary: `Undid "${row.title}" (${n} change${n === 1 ? '' : 's'})`, after: { restored_audit_ids: [...done] },
  });
  await run(ctx.env, "UPDATE change_sets SET result_json = ? WHERE id = ?", [JSON.stringify(next), row.id]);
  return { change_set: await shapeOne(ctx.env, row.id) };
}

/** Which bundle lists hold each entity, to say whether a change is on the website. */
const ON_WEBSITE = {
  event: (b, id) => ['current', 'upcoming', 'past'].some((k) => b.events[k].some((e) => e.id === id)),
  announcement: (b, id) => b.announcements.some((a) => a.id === id),
  menu_section: (b, id) => b.menu.sections.some((s) => s.id === id),
  menu_item: (b, id) => b.menu.sections.some((s) => s.items.some((i) => i.id === id)),
  artwork: (b, id) => (b.artworks || []).some((a) => a.id === id),
  artwork_image: (b, id) => (b.artworks || []).some((a) => a.images.some((i) => i.id === id)),
  hours_exception: (b, id) => b.exceptions.some((e) => e.id === id),
};

function liveDetail(def, bundle, id, field) {
  if (def.entity === 'settings') return 'Saved. The TV screens pick it up within a few minutes.';
  if (field === 'inquiry_emails') return 'Saved. Form emails go there; it is not shown on the website.';
  const check = ON_WEBSITE[def.entity];
  return !check || check(bundle, id) ? 'Live on the website.' : HIDDEN_DETAIL;
}

/** Checks one published op against the live data and the live public bundle. */
async function verifyOp(ctx, ops, index, createdIds, stateFor) {
  const op = ops[index];
  const def = opDef(op.op);
  const slug = op.business_slug ?? null;
  const { rows, bundle } = await stateFor(slug);
  if (!rows) throw notFound('That business no longer exists.', 'unknown_business');
  const args = resolveRefs(def, op.args || {}, index, (i) => ({ entity: opDef(ops[i]?.op)?.creates, id: createdIds[i] }));
  const c = opContext(ctx, index, rows, slug);
  if (def.kind === 'delete') {
    const still = (rows[def.list] || []).some((r) => r.id === args.id);
    return { ok: !still, detail: still ? 'Still there: it was not removed.' : 'Gone from the website.' };
  }
  if (def.kind === 'create') {
    const row = (rows[def.list] || []).find((r) => r.id === createdIds[index]);
    if (!row) return { ok: false, detail: 'Not found in the live data.' };
    const wrong = changedKeys(row, def.expect(c, args));
    if (wrong.length) return { ok: false, detail: `Saved, but its ${fieldLabels(wrong)} ${wrong.length === 1 ? 'is' : 'are'} not what was drafted.` };
    return { ok: true, detail: liveDetail(def, bundle, row.id) };
  }
  // An update is live when applying it again changes nothing: any line that comes back is still different.
  def.apply(c, args);
  return { ok: true, still: new Map(c.lines.map((l) => [l.field, l.before])), id: args.id };
}

/** → { ok, lines: [{ business_slug, line, ok, detail }] }: each summary line checked against the live website. */
export async function verifyChangeSet(ctx, id) {
  const row = await loadChangeSet(ctx, id);
  if (row.status !== 'published') throw conflict('Only published changes can be checked against the live website.', 'not_published');
  const ops = parseJson(row.ops_json, []);
  const result = parseJson(row.result_json, {}) || {};
  const createdIds = (result.results || []).map((r) => r?.created_id ?? null);
  const states = new Map();
  // Family-wide announcements show on every site; the first business's bundle stands for them.
  const probe = async () => (await first(ctx.env, 'SELECT slug FROM businesses ORDER BY sort_order, slug LIMIT 1'))?.slug;
  const stateFor = async (slug) => {
    const key = slug ?? await probe();
    if (!states.has(key)) {
      const rows = await loadBundleRows(ctx.env, key, ctx.now, { signage: true, artworks: true });
      states.set(key, { rows, bundle: rows && renderBundle(rows, ctx.now) });
    }
    return states.get(key);
  };
  const outcomes = [];
  for (let index = 0; index < ops.length; index++) {
    try {
      outcomes[index] = await verifyOp(ctx, ops, index, createdIds, stateFor);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      outcomes[index] = { ok: false, detail: `Could not check it: ${err.message}` };
    }
  }
  const lines = [];
  for (const s of parseJson(row.summary_json, [])) {
    const o = outcomes[s.op_index] || { ok: false, detail: 'Could not check it.' };
    let { ok, detail } = o;
    if (o.still) {
      const def = opDef(ops[s.op_index].op);
      ok = !o.still.has(s.field);
      detail = ok ? liveDetail(def, (await stateFor(ops[s.op_index].business_slug ?? null)).bundle, o.id, s.field)
        : `Not live yet: it still shows ${o.still.get(s.field) ?? 'nothing'}.`;
    }
    lines.push({ business_slug: s.business_slug, line: s.line, ok, detail });
  }
  return { ok: lines.every((l) => l.ok), lines };
}

/**
 * The public bundle (or, with { signage: true }, the TV bundle) of one business with a draft applied in memory, or
 * null when id is not a draft that is still open and touches this business. Nothing is written.
 */
export async function previewBundle(env, slug, id, { now = chicagoNow(), origin = null, signage = false } = {}) {
  if (!ID_RE.test(String(id ?? ''))) return null;
  let row;
  try {
    row = await first(env, 'SELECT id, title, status, expires_at, ops_json, businesses_json FROM change_sets WHERE id = ?', [id]);
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return null; // before the assistant migration has run
    throw err;
  }
  if (!row || effectiveStatus(row) !== 'draft') return null;
  const ops = parseJson(row.ops_json, []);
  const family = ops.some((op) => isObject(op) && op.business_slug == null);
  if (!family && !parseJson(row.businesses_json, []).includes(slug)) return null;
  const ctx = { env, now, url: new URL(origin || env.PUBLIC_BASE_URL || 'https://preview.invalid') };
  const data = await buildBundle(env, slug, now, { signage, overlay: (rows) => applyDraft(ctx, rows, slug, ops) });
  if (!data) return null;
  data.preview = { id: row.id, title: row.title, expires_at: isoTime(row.expires_at) };
  return data;
}

/** The preview's row overlay: this business's ops (and family-wide ones) applied in order; one that no longer fits is skipped. */
function applyDraft(ctx, rows, slug, ops) {
  const refs = [];
  ops.forEach((op, index) => {
    const def = isObject(op) && opDef(op.op);
    const opSlug = isObject(op) ? op.business_slug ?? null : undefined;
    if (!def || (opSlug !== slug && opSlug !== null)) return;
    try {
      const c = opContext(ctx, index, rows, opSlug);
      const created = def.apply(c, resolveRefs(def, op.args || {}, index, (i) => refs[i]));
      if (def.creates) refs[index] = { entity: def.creates, id: created };
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(`Preview: op ${index} (${op.op}) failed:`, err);
    }
  });
}

/* -------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------- */

/** Answers an ApiError that carries details (invalid_change_set) with them: { error, code, details }. */
const withDetails = (handler) => async (ctx) => {
  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof ApiError && Array.isArray(err.details)) return json({ error: err.message, code: err.code, details: err.details }, err.status);
    throw err;
  }
};

/** GET /api/admin/change-sets?status=draft|published|…|all — own; owners and admins see everyone's. */
async function listRoute(ctx) {
  const status = ctx.url.searchParams.get('status') || 'all';
  if (status !== 'all' && !STATUSES.includes(status)) throw bad(`status must be all or one of: ${STATUSES.join(', ')}.`);
  await expireDrafts(ctx.env);
  const where = [];
  const binds = [];
  if (!isManager(ctx.user)) { where.push('user_id = ?'); binds.push(ctx.user.id); }
  if (status !== 'all') { where.push('status = ?'); binds.push(status); }
  const rows = await all(ctx.env, `SELECT * FROM change_sets${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, created_at DESC LIMIT ?`, [...binds, intParam(ctx.url, 'limit', 50)]);
  const names = await businessNames(ctx.env);
  return { change_sets: rows.map((r) => shapeChangeSet(ctx.env, r, names)) };
}

/** POST /api/admin/change-sets { title, ops, replace_id?, source? } — the same drafting the tools do. */
async function createRoute(ctx) {
  const body = await readBody(ctx.request);
  return proposeChangeSet(ctx, { title: body.title, ops: body.ops, source: body.source || 'assistant', conversation_id: body.conversation_id ?? null, replace_id: body.replace_id ?? null });
}

/** Adds this module's routes. `admin` wraps a handler so it requires a signed-in user. */
export function register(router, admin) {
  router.get('/api/admin/change-sets', admin(listRoute));
  router.post('/api/admin/change-sets', admin(withDetails(createRoute)));
  router.get('/api/admin/change-sets/:id', admin(async (ctx) => ({ change_set: await getChangeSet(ctx, ctx.params.id) })));
  router.post('/api/admin/change-sets/:id/publish', admin(withDetails((ctx) => publishChangeSet(ctx, ctx.params.id))));
  router.post('/api/admin/change-sets/:id/discard', admin((ctx) => discardChangeSet(ctx, ctx.params.id)));
  router.post('/api/admin/change-sets/:id/undo', admin((ctx) => undoChangeSet(ctx, ctx.params.id)));
  router.get('/api/admin/change-sets/:id/verify', admin((ctx) => verifyChangeSet(ctx, ctx.params.id)));
}
