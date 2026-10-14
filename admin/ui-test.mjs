// Admin panel UI check: serves the repo plus a fake /api from memory, then drives
// the panel with Playwright at phone and desktop widths and saves screenshots.
//
//   node admin/ui-test.mjs [--out <dir>]
//
// The fake API follows docs/admin-api.md closely enough for the UI; the real
// integration later just points the panel at the Worker. Nothing here touches
// the network or a database.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(tmpdir(), 'rj-admin-ui-test');
const BOOTSTRAP_TOKEN = 'test-setup-token';
const TODAY = '2026-10-13';
const HEIC_MESSAGE = "This photo format isn't supported by this browser. On iPhone, set Camera → Formats → Most Compatible, or upload a JPEG.";
const until = async (check, what, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/* -------------------------------------------------------------------------
   Fake API: in-memory data seeded from the public fixture
   ------------------------------------------------------------------------- */
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'docs/fixtures/public-peachs.json'), 'utf8'));
// Photos "picked" in the browser: a big landscape one (must shrink to 2000 px) and a portrait one already under 2000 px.
const PNG_WIDE = makePng(3000, 2000, 2);
const PNG_TALL = makePng(1200, 1800, 5);
let db;
let nextId = 1000;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function freshState() {
  const b = fixture.business;
  db = {
    users: [],
    sessions: new Map(),
    businesses: [
      {
        slug: 'peachs', name: b.name, short_name: b.short_name, tagline: b.tagline, description: b.description,
        address1: b.address.line1, address2: b.address.line2, city: b.address.city, state: b.address.state, zip: b.address.zip,
        phone: b.phone, public_email: b.public_email, inquiry_emails: 'ordering@romesjoy.com, manager@example.com',
        website_url: b.website_url, instagram_url: b.instagram_url, facebook_url: b.facebook_url, map_url: b.map_url,
        order_url: b.order_url, book_url: b.book_url, hours_note: b.hours_note, notice: b.notice?.text || null, notice_until: b.notice?.until || null, sort_order: 1,
      },
      {
        slug: 'blanc', name: 'Blanc Gallery', short_name: 'Blanc', tagline: 'Contemporary art in Bronzeville', description: null,
        address1: '4445 S. King Drive', address2: null, city: 'Chicago', state: 'IL', zip: '60653', phone: '773.373.4320', public_email: null, inquiry_emails: null,
        website_url: 'https://blancchicago.com/', instagram_url: null, facebook_url: null, map_url: null, order_url: null, book_url: null, hours_note: null, notice: null, notice_until: null, sort_order: 6,
      },
    ],
    hours: {
      peachs: fixture.hours.map((r) => ({ weekday: r.weekday, closed: r.closed ? 1 : 0, open_min: r.open_min, close_min: r.close_min })),
      blanc: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, closed: weekday === 6 || weekday === 0 ? 0 : 1, open_min: weekday === 6 || weekday === 0 ? 660 : null, close_min: weekday === 6 || weekday === 0 ? 900 : null })),
    },
    exceptions: fixture.exceptions.map((x) => ({ id: nextId++, business_slug: 'peachs', date: x.date, closed: x.closed ? 1 : 0, open_min: null, close_min: null, label: x.label })),
    events: [...fixture.events.current, ...fixture.events.upcoming, ...fixture.events.past].map((e) => ({
      id: e.id, business_slug: 'peachs', kind: e.kind, title: e.title, subtitle: e.subtitle, description: e.description, start_date: e.start_date, end_date: e.end_date,
      start_time: e.start_time, end_time: e.end_time, location: e.location, link_url: e.link_url, link_label: e.link_label, image_url: e.image_url,
      featured: e.featured ? 1 : 0, published: 1, sort_order: 0, created_at: now(), updated_at: now(),
    })),
    sections: fixture.menu.sections.map((s, i) => ({ id: s.id, business_slug: 'peachs', title: s.title, short_title: s.short_title, description: s.description, published: 1, sort_order: i })),
    items: fixture.menu.sections.flatMap((s) => s.items.map((it, i) => ({ id: it.id, section_id: s.id, name: it.name, portion: it.portion, price: it.price, prices: it.prices, description: it.description, tags: it.tags, allergens: it.allergens, featured: it.featured ? 1 : 0, available: 1, sort_order: i }))),
    announcements: fixture.announcements.map((a, i) => ({ ...a, business_slug: i === 0 ? null : 'peachs', show_on_tv: 1, published: 1, created_at: now(), updated_at: now() })),
    inquiries: [
      { id: 501, business_slug: 'peachs', form_type: 'event', name: 'Dana Whitfield', email: 'dana@example.com', phone: '312-555-0144', message: 'Hi! Could we book the back room for a baby shower brunch on Nov 8? About 25 people. Is there a minimum?', fields: { party_size: '25', preferred_date: '2026-11-08' }, source_url: 'https://peachson47th.com/#catering', status: 'new', emailed_at: null, email_error: 'Email is not configured', created_at: '2026-10-12 14:22:10' },
      { id: 500, business_slug: 'peachs', form_type: 'contact', name: 'Marcus Lee', email: 'marcus@example.com', phone: null, message: 'Do you still sell the coffee beans by the pound?', fields: {}, source_url: 'https://peachson47th.com/#contact', status: 'handled', emailed_at: '2026-10-10 09:01:00', email_error: null, created_at: '2026-10-10 09:00:12' },
    ],
    audit: [
      { id: 1, user_email: 'owner@example.com', business_slug: 'peachs', entity: 'hours', entity_id: 'peachs', action: 'update', summary: 'Changed Saturday hours', before_json: '{}', after_json: '{}', created_at: '2026-10-09 16:40:00' },
    ],
    settings: {},
    // Artwork catalog: on for Blanc only (settings key features:<slug>), photo storage (R2) configured.
    features: { blanc: { artworks: true } },
    mediaConfigured: true,
    media: new Map(),   // key -> { type, bytes }, served at /api/media/<key>
    uploads: [],        // every POST /api/admin/media, with the image size read from the bytes
    artworks: [
      { id: 901, business_slug: 'blanc', event_id: 803, title: 'Untitled (Family Portrait)', artist: "Raja'Nee Hamilton", year: '2026', medium: 'Archival pigment print', dimensions: '24 × 30 in.', description: null, price: 1800, price_display: 'show', status: 'available', featured: 1, published: 1, sort_order: 0 },
      { id: 902, business_slug: 'blanc', event_id: 804, title: 'Raised In It, No. 3', artist: 'Marcus Hale', year: '2025', medium: 'Acrylic on panel', dimensions: '18 × 24 in.', description: null, price: 950.5, price_display: 'show', status: 'sold', featured: 0, published: 1, sort_order: 1 },
      { id: 903, business_slug: 'blanc', event_id: null, title: 'Study in Blue', artist: 'Ana Ortiz', year: 'c. 1998', medium: 'Gouache on paper', dimensions: null, description: null, price: null, price_display: 'hidden', status: 'not_for_sale', featured: 0, published: 0, sort_order: 2 },
      { id: 904, business_slug: 'blanc', event_id: 803, title: 'Permanent Rebellion (Banner)', artist: 'Cole Ellis', year: '2026', medium: 'Screenprint on canvas', dimensions: '60 × 96 in.', description: null, price: 4200, price_display: 'on_request', status: 'reserved', featured: 0, published: 1, sort_order: 3 },
    ].map((a) => ({ ...a, created_at: now(), updated_at: now() })),
    images: [
      { id: 951, artwork_id: 901, url: '/api/media/uploads/blanc/seed-901-full.png', thumb_url: '/api/media/uploads/blanc/seed-901-thumb.png', alt: 'A family of four on a porch, in warm evening light', width: 1200, height: 900, sort_order: 0 },
      { id: 952, artwork_id: 904, url: '/api/media/uploads/blanc/seed-904-full.png', thumb_url: '/api/media/uploads/blanc/seed-904-full.png', alt: null, width: 900, height: 1350, sort_order: 0 },
    ],
  };
  db.media.set('uploads/blanc/seed-901-full.png', { type: 'image/png', bytes: makePng(1200, 900, 1) });
  db.media.set('uploads/blanc/seed-901-thumb.png', { type: 'image/png', bytes: makePng(640, 480, 1) });
  db.media.set('uploads/blanc/seed-904-full.png', { type: 'image/png', bytes: makePng(600, 900, 3) });
  // Blanc's exhibitions (and one reception) for the exhibition pickers.
  const blancEvent = (id, kind, title, start_date, end_date, start_time = null, end_time = null) => ({
    id, business_slug: 'blanc', kind, title, subtitle: null, description: null, start_date, end_date, start_time, end_time, location: 'Blanc Gallery',
    link_url: null, link_label: null, image_url: null, featured: 0, published: 1, sort_order: 0, created_at: now(), updated_at: now(),
  });
  db.events.push(
    blancEvent(801, 'exhibition', 'What Shall I Do With My Dead?', '2026-10-24', '2026-12-05'),
    blancEvent(802, 'event', 'Opening reception: What Shall I Do With My Dead?', '2026-10-24', null, '18:00', '21:00'),
    blancEvent(803, 'exhibition', 'This Could Be//The Permanent Rebellion', '2026-08-01', '2026-10-18'),
    blancEvent(804, 'exhibition', 'Raised In It!', '2026-03-01', '2026-05-30'),
  );
  // Photo library (docs/assistant-api.md §5): starter albums, and one photo an event already uses.
  db.albums = [
    { id: 61, business_slug: 'peachs', name: 'Food', sort_order: 1 }, { id: 62, business_slug: 'peachs', name: 'Dining room', sort_order: 2 },
    { id: 63, business_slug: 'peachs', name: 'Team', sort_order: 3 }, { id: 64, business_slug: 'peachs', name: 'Events', sort_order: 4 },
    { id: 65, business_slug: 'blanc', name: 'Artworks', sort_order: 1 },
  ];
  db.media.set('uploads/peachs/seed-brunch-full.png', { type: 'image/png', bytes: makePng(1200, 800, 4) });
  db.media.set('uploads/peachs/seed-brunch-thumb.png', { type: 'image/png', bytes: makePng(640, 427, 4) });
  db.library = [{
    id: 71, business_slug: 'peachs', album_id: 61, url: '/api/media/uploads/peachs/seed-brunch-full.png', thumb_url: '/api/media/uploads/peachs/seed-brunch-thumb.png',
    r2_key: 'uploads/peachs/seed-brunch-full.png', thumb_r2_key: 'uploads/peachs/seed-brunch-thumb.png', note: 'Saturday brunch table', alt: 'Chicken and waffles with peach butter',
    width: 1200, height: 800, bytes: 90000, taken_at: '2026-10-11T10:20:00', uploaded_by: null, created_at: '2026-10-11 15:21:00',
  }];
  db.events[0].image_url = db.library[0].url;
  // TV screens (§6), the Assistant (§3) and its drafts (§1), the Claude app connector (§4).
  db.screens = [];
  db.assistantConfigured = true;
  db.conversations = [];
  db.changeSets = new Map();
  db.connectedApps = [{ id: 'grant-claude-1', name: 'Claude', host: 'claude.ai', connected_at: '2026-10-12T15:04:00Z', expires_at: null, needs_sign_in: false }];
  nextId = 2000;
}

/** A plain RGB PNG with a pattern (so the browser has something real to decode and re-encode). */
function makePng(width, height, seed = 0) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = (x * 255 / width + seed * 40) & 255;
      raw[o + 1] = (y * 255 / height) & 255;
      raw[o + 2] = (((x >> 4) ^ (y >> 4)) * 9 + seed * 60) & 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Width and height read from the image bytes themselves (WebP, JPEG or PNG), to check what the admin really sent. */
function imageSize(buf) {
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const bits = buf.readUInt32LE(21); return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { format: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  return null;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, error, code) => json(res, status, { error, code });

function audit(user, business_slug, entity, entity_id, action, summary, before, after) {
  db.audit.unshift({ id: nextId++, user_email: user?.email || null, business_slug, entity, entity_id: String(entity_id), action, summary, before_json: JSON.stringify(before ?? null), after_json: JSON.stringify(after ?? null), created_at: now() });
}

const fmtMin = (m) => { const hh = Math.floor(m / 60); const mm = m % 60; return `${hh % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${hh < 12 ? 'am' : 'pm'}`; };
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const eventStatus = (e) => ((e.end_date || e.start_date) < TODAY ? 'past' : e.start_date > TODAY ? 'upcoming' : 'current');

function publicBundle(slug) {
  const biz = db.businesses.find((b) => b.slug === slug);
  const hours = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
    const r = db.hours[slug].find((x) => x.weekday === wd) || { closed: 1 };
    return { weekday: wd, label: DAY[wd], short: DAY[wd].slice(0, 3), closed: Boolean(r.closed), open_min: r.open_min, close_min: r.close_min, open: r.closed ? null : fmtMin(r.open_min), close: r.closed ? null : fmtMin(r.close_min), text: r.closed ? 'Closed' : `${fmtMin(r.open_min)} – ${fmtMin(r.close_min)}` };
  });
  const events = db.events.filter((e) => e.business_slug === slug && e.published).map((e) => ({ ...e, status: eventStatus(e), featured: Boolean(e.featured) }));
  return {
    ...fixture,
    business: { ...fixture.business, slug, name: biz.name, tagline: biz.tagline, notice: biz.notice ? { text: biz.notice, until: biz.notice_until } : null },
    hours,
    exceptions: db.exceptions.filter((x) => x.business_slug === slug).map((x) => ({ date: x.date, closed: Boolean(x.closed), open: x.closed ? null : fmtMin(x.open_min), close: x.closed ? null : fmtMin(x.close_min), label: x.label })),
    events: { current: events.filter((e) => e.status === 'current'), upcoming: events.filter((e) => e.status === 'upcoming'), past: events.filter((e) => e.status === 'past') },
  };
}

const adminBusiness = (b) => ({
  ...b, hours_summary: fixture.hours_summary, features: db.features[b.slug] || {},
  counts: {
    new_inquiries: db.inquiries.filter((q) => q.business_slug === b.slug && q.status === 'new').length,
    upcoming_events: db.events.filter((e) => e.business_slug === b.slug && e.published && eventStatus(e) === 'upcoming').length,
    current_events: db.events.filter((e) => e.business_slug === b.slug && e.published && eventStatus(e) === 'current').length,
    artworks: db.artworks.filter((a) => a.business_slug === b.slug).length,
    artworks_available: db.artworks.filter((a) => a.business_slug === b.slug && a.status === 'available').length,
  },
});

/** JSON bodies become an object; multipart bodies (photo uploads) also come back as FormData in form. */
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const type = req.headers['content-type'] || '';
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    return { body: Object.fromEntries([...form].filter(([, v]) => typeof v === 'string')), form };
  }
  if (!raw.length) return { body: {}, form: null };
  try { return { body: JSON.parse(raw.toString('utf8')), form: null }; } catch { return { body: {}, form: null }; }
}

function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const userId = m ? db.sessions.get(m[1]) : null;
  return userId ? db.users.find((u) => u.id === userId) : null;
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/auth\/status$/, (c) => json(c.res, 200, { has_users: db.users.length > 0, email_configured: false, media_configured: db.mediaConfigured }));
route('POST', /^\/api\/auth\/bootstrap$/, (c) => {
  if (db.users.length || c.body.token !== BOOTSTRAP_TOKEN) return fail(c.res, 403, 'Bad token', 'forbidden');
  const user = { id: 1, email: String(c.body.email).toLowerCase(), name: c.body.name, role: 'owner', businesses: [], active: 1, must_change_password: 0, password: c.body.password, last_login_at: now() };
  db.users.push(user);
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  db.sessions.set(token, user.id);
  json(c.res, 200, { token, user: publicUser(user) });
});
const publicUser = ({ id, email, name, role, businesses, must_change_password, active, last_login_at }) => ({ id, email, name, role, businesses, must_change_password, active, last_login_at });
route('POST', /^\/api\/auth\/login$/, (c) => {
  const user = db.users.find((u) => u.email === String(c.body.email || '').toLowerCase() && u.password === c.body.password && u.active);
  if (!user) return fail(c.res, 401, 'That email and password do not match.', 'invalid_credentials');
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  db.sessions.set(token, user.id);
  user.last_login_at = now();
  json(c.res, 200, { token, user: publicUser(user) });
});
route('POST', /^\/api\/auth\/logout$/, (c) => json(c.res, 200, { ok: true }));
route('GET', /^\/api\/auth\/me$/, (c) => (c.user ? json(c.res, 200, { user: publicUser(c.user) }) : fail(c.res, 401, 'Not signed in', 'unauthorized')));
route('POST', /^\/api\/auth\/change-password$/, (c) => {
  if (!c.user) return fail(c.res, 401, 'Not signed in', 'unauthorized');
  if (c.user.password !== c.body.current_password) return fail(c.res, 400, 'Your current password is not right.', 'wrong_password');
  if (String(c.body.new_password || '').length < 8) return fail(c.res, 400, 'Password too short', 'bad_input');
  c.user.password = c.body.new_password;
  c.user.must_change_password = 0;
  json(c.res, 200, { ok: true });
});
route('GET', /^\/api\/public\/([a-z-]+)$/, (c) => {
  if (c.m[1] === 'catering') return json(c.res, 200, { ...publicBundle('peachs'), business: { ...publicBundle('peachs').business, slug: 'catering' } }); // the TV page's side bundle
  return db.businesses.some((b) => b.slug === c.m[1]) ? json(c.res, 200, publicBundle(c.m[1])) : fail(c.res, 404, 'No such business', 'not_found');
});
// The TV page in the screens panel's mini previews reads this.
route('GET', /^\/api\/public\/signage\/([a-z-]+)$/, (c) => (db.businesses.some((b) => b.slug === c.m[1])
  ? json(c.res, 200, { ...publicBundle(c.m[1]), signage: db.settings[`signage:${c.m[1]}`] || {}, family: db.businesses.map((b) => ({ slug: b.slug, name: b.name, tagline: b.tagline, hours_summary: fixture.hours_summary })) })
  : fail(c.res, 404, 'No such business', 'not_found')));

// Everything below needs a signed-in user.
const admin = (method, pattern, handler) => route(method, pattern, (c) => (c.user ? handler(c) : fail(c.res, 401, 'Not signed in', 'unauthorized')));
const manager = (c) => c.user.role === 'owner' || c.user.role === 'admin';

admin('GET', /^\/api\/admin\/businesses$/, (c) => json(c.res, 200, { businesses: db.businesses.filter((b) => manager(c) || c.user.businesses.includes(b.slug)).map(adminBusiness) }));
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)$/, (c) => {
  const b = db.businesses.find((x) => x.slug === c.m[1]);
  if (!b) return fail(c.res, 404, 'No such business', 'not_found');
  json(c.res, 200, { business: b, hours: [1, 2, 3, 4, 5, 6, 0].map((wd) => db.hours[b.slug].find((x) => x.weekday === wd)), exceptions: db.exceptions.filter((x) => x.business_slug === b.slug && x.date >= TODAY) });
});
admin('PATCH', /^\/api\/admin\/businesses\/([a-z-]+)$/, (c) => {
  const b = db.businesses.find((x) => x.slug === c.m[1]);
  if (!b) return fail(c.res, 404, 'No such business', 'not_found');
  const before = { ...b };
  for (const k of Object.keys(c.body)) if (k in b && k !== 'slug' && k !== 'sort_order') b[k] = c.body[k];
  audit(c.user, b.slug, 'business', b.slug, 'update', 'Changed business details', before, b);
  json(c.res, 200, { business: b });
});
admin('PUT', /^\/api\/admin\/businesses\/([a-z-]+)\/hours$/, (c) => {
  const rows = c.body.hours;
  if (!Array.isArray(rows) || rows.length !== 7) return fail(c.res, 400, 'Need 7 rows', 'bad_input');
  for (const r of rows) if (!r.closed && !(r.open_min >= 0 && r.open_min < r.close_min && r.close_min <= 1440)) return fail(c.res, 400, 'Bad times', 'bad_input');
  const before = db.hours[c.m[1]];
  db.hours[c.m[1]] = rows.map((r) => ({ weekday: r.weekday, closed: r.closed ? 1 : 0, open_min: r.closed ? null : r.open_min, close_min: r.closed ? null : r.close_min }));
  audit(c.user, c.m[1], 'hours', c.m[1], 'update', 'Changed weekly hours', before, db.hours[c.m[1]]);
  json(c.res, 200, { hours: db.hours[c.m[1]] });
});
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/hours\/exceptions$/, (c) => json(c.res, 200, { exceptions: db.exceptions.filter((x) => x.business_slug === c.m[1]) }));
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/hours\/exceptions$/, (c) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.body.date || '')) return fail(c.res, 400, 'Bad date', 'bad_input');
  const x = { id: nextId++, business_slug: c.m[1], date: c.body.date, closed: c.body.closed ? 1 : 0, open_min: c.body.open_min ?? null, close_min: c.body.close_min ?? null, label: c.body.label ?? null };
  db.exceptions.push(x);
  audit(c.user, c.m[1], 'hours_exception', x.id, 'create', `Added special day ${x.date}`, null, x);
  json(c.res, 200, { exception: x });
});
admin('DELETE', /^\/api\/admin\/hours\/exceptions\/(\d+)$/, (c) => {
  const i = db.exceptions.findIndex((x) => x.id === Number(c.m[1]));
  if (i < 0) return fail(c.res, 404, 'Not found', 'not_found');
  audit(c.user, db.exceptions[i].business_slug, 'hours_exception', c.m[1], 'delete', `Deleted special day ${db.exceptions[i].date}`, db.exceptions[i], null);
  db.exceptions.splice(i, 1);
  json(c.res, 200, { ok: true });
});

const EVENT_COLS = ['kind', 'title', 'subtitle', 'description', 'start_date', 'end_date', 'start_time', 'end_time', 'location', 'link_url', 'link_label', 'image_url', 'featured', 'published', 'sort_order'];
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/events$/, (c) => {
  const status = c.url.searchParams.get('status') || 'all';
  const list = db.events.filter((e) => e.business_slug === c.m[1]).map((e) => ({ ...e, status: eventStatus(e) })).filter((e) => status === 'all' || e.status === status);
  json(c.res, 200, { events: list });
});
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/events$/, (c) => {
  if (!c.body.title || !c.body.start_date) return fail(c.res, 400, 'title and start_date are required', 'bad_input');
  if (c.body.end_date && c.body.end_date < c.body.start_date) return fail(c.res, 400, 'end_date before start_date', 'bad_input');
  const e = { id: nextId++, business_slug: c.m[1], kind: 'event', featured: 0, published: 1, sort_order: 0, created_at: now(), updated_at: now() };
  for (const k of EVENT_COLS) if (k in c.body) e[k] = c.body[k];
  db.events.push(e);
  audit(c.user, c.m[1], 'event', e.id, 'create', `Added event "${e.title}"`, null, e);
  json(c.res, 200, { event: { ...e, status: eventStatus(e) } });
});
admin('PATCH', /^\/api\/admin\/events\/(\d+)$/, (c) => {
  const e = db.events.find((x) => x.id === Number(c.m[1]));
  if (!e) return fail(c.res, 404, 'Not found', 'not_found');
  const before = { ...e };
  for (const k of EVENT_COLS) if (k in c.body) e[k] = c.body[k];
  e.updated_at = now();
  audit(c.user, e.business_slug, 'event', e.id, 'update', `Changed event "${e.title}"`, before, e);
  json(c.res, 200, { event: { ...e, status: eventStatus(e) } });
});
admin('DELETE', /^\/api\/admin\/events\/(\d+)$/, (c) => {
  const i = db.events.findIndex((x) => x.id === Number(c.m[1]));
  if (i < 0) return fail(c.res, 404, 'Not found', 'not_found');
  audit(c.user, db.events[i].business_slug, 'event', c.m[1], 'delete', `Deleted event "${db.events[i].title}"`, db.events[i], null);
  db.events.splice(i, 1);
  json(c.res, 200, { ok: true });
});

admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/menu$/, (c) => {
  const sections = db.sections.filter((s) => s.business_slug === c.m[1]).sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => ({ ...s, items: db.items.filter((i) => i.section_id === s.id).sort((a, b) => a.sort_order - b.sort_order) }));
  json(c.res, 200, { sections });
});
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/menu\/sections$/, (c) => {
  if (!c.body.title) return fail(c.res, 400, 'title is required', 'bad_input');
  const s = { id: nextId++, business_slug: c.m[1], title: c.body.title, short_title: c.body.short_title ?? null, description: c.body.description ?? null, published: c.body.published ?? 1, sort_order: db.sections.length };
  db.sections.push(s);
  audit(c.user, c.m[1], 'menu_section', s.id, 'create', `Added menu section "${s.title}"`, null, s);
  json(c.res, 200, { section: s });
});
admin('PATCH', /^\/api\/admin\/menu\/sections\/(\d+)$/, (c) => {
  const s = db.sections.find((x) => x.id === Number(c.m[1]));
  if (!s) return fail(c.res, 404, 'Not found', 'not_found');
  for (const k of ['title', 'short_title', 'description', 'published']) if (k in c.body) s[k] = c.body[k];
  json(c.res, 200, { section: s });
});
admin('DELETE', /^\/api\/admin\/menu\/sections\/(\d+)$/, (c) => {
  db.sections = db.sections.filter((x) => x.id !== Number(c.m[1]));
  db.items = db.items.filter((x) => x.section_id !== Number(c.m[1]));
  json(c.res, 200, { ok: true });
});
admin('POST', /^\/api\/admin\/menu\/sections\/(\d+)\/items$/, (c) => {
  const s = db.sections.find((x) => x.id === Number(c.m[1]));
  if (!s) return fail(c.res, 404, 'Not found', 'not_found');
  if (!c.body.name) return fail(c.res, 400, 'name is required', 'bad_input');
  const it = { id: nextId++, section_id: s.id, name: c.body.name, portion: c.body.portion ?? null, price: c.body.price ?? null, prices: c.body.prices ?? null, description: c.body.description ?? null, tags: c.body.tags || [], allergens: c.body.allergens || [], featured: c.body.featured ? 1 : 0, available: c.body.available ?? 1, sort_order: db.items.filter((i) => i.section_id === s.id).length };
  db.items.push(it);
  audit(c.user, s.business_slug, 'menu_item', it.id, 'create', `Added menu item "${it.name}"`, null, it);
  json(c.res, 200, { item: it });
});
admin('PATCH', /^\/api\/admin\/menu\/items\/(\d+)$/, (c) => {
  const it = db.items.find((x) => x.id === Number(c.m[1]));
  if (!it) return fail(c.res, 404, 'Not found', 'not_found');
  for (const k of ['name', 'portion', 'price', 'prices', 'description', 'tags', 'allergens', 'featured', 'available']) if (k in c.body) it[k] = c.body[k];
  json(c.res, 200, { item: it });
});
admin('DELETE', /^\/api\/admin\/menu\/items\/(\d+)$/, (c) => { db.items = db.items.filter((x) => x.id !== Number(c.m[1])); json(c.res, 200, { ok: true }); });
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/menu\/reorder$/, (c) => {
  if (Array.isArray(c.body.sections)) c.body.sections.forEach((id, i) => { const s = db.sections.find((x) => x.id === id); if (s) s.sort_order = i; });
  if (c.body.items) for (const [sid, ids] of Object.entries(c.body.items)) ids.forEach((id, i) => { const it = db.items.find((x) => x.id === id && x.section_id === Number(sid)); if (it) it.sort_order = i; });
  json(c.res, 200, { ok: true });
});

const ANN_COLS = ['title', 'body', 'link_url', 'link_label', 'image_url', 'starts_at', 'ends_at', 'show_on_tv', 'published'];
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/announcements$/, (c) => json(c.res, 200, { announcements: db.announcements.filter((a) => a.business_slug === c.m[1]) }));
admin('GET', /^\/api\/admin\/announcements$/, (c) => (manager(c) ? json(c.res, 200, { announcements: db.announcements.filter((a) => a.business_slug == null) }) : fail(c.res, 403, 'Owners and admins only', 'forbidden')));
const createAnn = (c, slug) => {
  if (!c.body.title) return fail(c.res, 400, 'title is required', 'bad_input');
  const a = { id: nextId++, business_slug: slug, starts_at: TODAY, ends_at: null, show_on_tv: 1, published: 1, created_at: now(), updated_at: now() };
  for (const k of ANN_COLS) if (k in c.body) a[k] = c.body[k];
  db.announcements.push(a);
  audit(c.user, slug, 'announcement', a.id, 'create', `Added announcement "${a.title}"`, null, a);
  json(c.res, 200, { announcement: a });
};
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/announcements$/, (c) => createAnn(c, c.m[1]));
admin('POST', /^\/api\/admin\/announcements$/, (c) => (manager(c) ? createAnn(c, null) : fail(c.res, 403, 'Owners and admins only', 'forbidden')));
admin('PATCH', /^\/api\/admin\/announcements\/(\d+)$/, (c) => {
  const a = db.announcements.find((x) => x.id === Number(c.m[1]));
  if (!a) return fail(c.res, 404, 'Not found', 'not_found');
  for (const k of ANN_COLS) if (k in c.body) a[k] = c.body[k];
  json(c.res, 200, { announcement: a });
});
admin('DELETE', /^\/api\/admin\/announcements\/(\d+)$/, (c) => { db.announcements = db.announcements.filter((x) => x.id !== Number(c.m[1])); json(c.res, 200, { ok: true }); });

admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/inquiries$/, (c) => {
  const status = c.url.searchParams.get('status') || 'new';
  const before = Number(c.url.searchParams.get('before') || 0);
  const limit = Number(c.url.searchParams.get('limit') || 50);
  const list = db.inquiries.filter((q) => q.business_slug === c.m[1] && (status === 'all' || q.status === status) && (!before || q.id < before)).sort((a, b) => b.id - a.id).slice(0, limit);
  json(c.res, 200, { inquiries: list });
});
admin('GET', /^\/api\/admin\/inquiries\/(\d+)$/, (c) => {
  const q = db.inquiries.find((x) => x.id === Number(c.m[1]));
  return q ? json(c.res, 200, { inquiry: q }) : fail(c.res, 404, 'No such inquiry', 'not_found');
});
admin('PATCH', /^\/api\/admin\/inquiries\/(\d+)$/, (c) => {
  const q = db.inquiries.find((x) => x.id === Number(c.m[1]));
  if (!q) return fail(c.res, 404, 'Not found', 'not_found');
  if (!['new', 'handled', 'spam'].includes(c.body.status)) return fail(c.res, 400, 'Bad status', 'bad_input');
  q.status = c.body.status;
  json(c.res, 200, { inquiry: q });
});
admin('POST', /^\/api\/admin\/inquiries\/(\d+)\/resend$/, (c) => json(c.res, 200, { emailed: false, error: 'Email is not configured' }));

admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/history$/, (c) => json(c.res, 200, { entries: db.audit.filter((e) => e.business_slug === c.m[1]).map((e) => ({ ...e, can_restore: e.action !== 'restore' })) }));
admin('GET', /^\/api\/admin\/history$/, (c) => (manager(c) ? json(c.res, 200, { entries: db.audit.map((e) => ({ ...e, can_restore: e.action !== 'restore' })) }) : fail(c.res, 403, 'Owners and admins only', 'forbidden')));
admin('GET', /^\/api\/admin\/history\/(\d+)$/, (c) => { const e = db.audit.find((x) => x.id === Number(c.m[1])); return e ? json(c.res, 200, { entry: { ...e, before: JSON.parse(e.before_json), after: JSON.parse(e.after_json) } }) : fail(c.res, 404, 'Not found', 'not_found'); });
admin('POST', /^\/api\/admin\/history\/(\d+)\/restore$/, (c) => { audit(c.user, 'peachs', 'event', c.m[1], 'restore', 'Restored an earlier version', null, null); json(c.res, 200, { ok: true }); });

admin('GET', /^\/api\/admin\/users$/, (c) => (manager(c) ? json(c.res, 200, { users: db.users.map(publicUser) }) : fail(c.res, 403, 'Owners and admins only', 'forbidden')));
admin('POST', /^\/api\/admin\/users$/, (c) => {
  if (!manager(c)) return fail(c.res, 403, 'Owners and admins only', 'forbidden');
  if (db.users.some((u) => u.email === String(c.body.email).toLowerCase())) return fail(c.res, 409, 'That email already has an account', 'conflict');
  const u = { id: nextId++, email: String(c.body.email).toLowerCase(), name: c.body.name, role: c.body.role || 'editor', businesses: c.body.businesses || [], active: 1, must_change_password: 1, password: c.body.password, last_login_at: null };
  db.users.push(u);
  json(c.res, 200, { user: publicUser(u) });
});
admin('PATCH', /^\/api\/admin\/users\/(\d+)$/, (c) => {
  const u = db.users.find((x) => x.id === Number(c.m[1]));
  if (!u) return fail(c.res, 404, 'Not found', 'not_found');
  for (const k of ['name', 'role', 'businesses', 'active', 'password']) if (k in c.body) u[k] = c.body[k];
  json(c.res, 200, { user: publicUser(u) });
});
admin('DELETE', /^\/api\/admin\/users\/(\d+)$/, (c) => { db.users = db.users.filter((x) => x.id !== Number(c.m[1])); json(c.res, 200, { ok: true }); });
admin('GET', /^\/api\/admin\/settings\/([\w:-]+)$/, (c) => json(c.res, 200, { value: db.settings[c.m[1]] || {} }));
admin('PUT', /^\/api\/admin\/settings\/([\w:-]+)$/, (c) => { db.settings[c.m[1]] = c.body.value; json(c.res, 200, { ok: true }); });

// --- Photo uploads (R2 in the real Worker) ---
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
admin('POST', /^\/api\/admin\/media$/, async (c) => {
  if (!db.mediaConfigured) return fail(c.res, 501, 'Photo uploads are not set up. Paste an image link instead.', 'media_not_configured');
  const file = c.form?.get('file');
  const slug = String(c.form?.get('business') || '');
  if (!db.businesses.some((b) => b.slug === slug)) return fail(c.res, 404, 'No such business.', 'unknown_business');
  if (!file || typeof file.arrayBuffer !== 'function') return fail(c.res, 400, 'No file was attached.', 'missing_field');
  if (!IMAGE_TYPES[file.type]) return fail(c.res, 400, 'Photos must be JPEG, PNG, WebP or GIF.', 'unsupported_type');
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) return fail(c.res, 400, 'Photos must be 8 MB or smaller.', 'too_large');
  const variant = ['full', 'thumb'].includes(c.body.variant) ? c.body.variant : 'full';
  const width = c.body.width ? Number(c.body.width) : null;
  const height = c.body.height ? Number(c.body.height) : null;
  const name = String(file.name || 'photo').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'photo';
  const key = `uploads/${slug}/${Date.now()}-${name}-${variant}.${IMAGE_TYPES[file.type]}`;
  db.media.set(key, { type: file.type, bytes });
  db.uploads.push({ key, slug, variant, type: file.type, size: bytes.length, width, height, fileName: file.name, decoded: imageSize(bytes) });
  json(c.res, 200, { url: `http://${c.req.headers.host}/api/media/${key}`, key, width, height });
});
route('GET', /^\/api\/media\/(.+)$/, (c) => {
  const item = db.media.get(decodeURIComponent(c.m[1]));
  if (!item) return fail(c.res, 404, 'No such file.', 'not_found');
  c.res.writeHead(200, { 'Content-Type': item.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
  c.res.end(item.bytes);
});

// --- Artworks (docs/admin-api.md, "Artwork catalog") ---
const ART_COLS = ['event_id', 'title', 'artist', 'year', 'medium', 'dimensions', 'description', 'price', 'price_display', 'status', 'featured', 'published'];
const byOrder = (a, b) => a.sort_order - b.sort_order || a.id - b.id;
const artImages = (id) => db.images.filter((i) => i.artwork_id === id).sort(byOrder);
const shapeArtwork = (a) => ({ ...a, images: artImages(a.id), event_title: db.events.find((e) => e.id === a.event_id)?.title || null });
const isPhotoUrl = (u, c) => typeof u === 'string' && (/^https:\/\/\S+$/.test(u) || /^\/api\/media\/\S+$/.test(u) || u.startsWith(`http://${c.req.headers.host}/api/media/`));
function artworkProblem(c, slug, body, create) {
  if (create && !String(body.title || '').trim()) return 'Title is required.';
  if ('title' in body && !String(body.title || '').trim()) return 'Title is required.';
  if ('price' in body && body.price != null && !(typeof body.price === 'number' && body.price >= 0)) return 'price must be 0 or more.';
  if ('price_display' in body && !['show', 'on_request', 'hidden'].includes(body.price_display)) return 'price_display is not valid.';
  if ('status' in body && !['available', 'reserved', 'sold', 'not_for_sale'].includes(body.status)) return 'status is not valid.';
  if ('event_id' in body && body.event_id != null && !db.events.some((e) => e.id === body.event_id && e.business_slug === slug)) return 'That exhibition belongs to another business.';
  return null;
}
const findArtwork = (c) => db.artworks.find((a) => a.id === Number(c.m[1]));
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/artworks$/, (c) => {
  const ev = c.url.searchParams.get('event_id');
  const status = c.url.searchParams.get('status');
  const q = (c.url.searchParams.get('q') || '').toLowerCase();
  const list = db.artworks.filter((a) => a.business_slug === c.m[1]
    && (!ev || (ev === 'none' ? a.event_id == null : a.event_id === Number(ev)))
    && (!status || a.status === status)
    && (!q || a.title.toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q)));
  json(c.res, 200, { artworks: list.sort(byOrder).map(shapeArtwork) });
});
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/artworks$/, (c) => {
  const problem = artworkProblem(c, c.m[1], c.body, true);
  if (problem) return fail(c.res, 400, problem, 'invalid_field');
  const a = { id: nextId++, business_slug: c.m[1], event_id: null, artist: null, year: null, medium: null, dimensions: null, description: null, price: null, price_display: 'on_request', status: 'available', featured: 0, published: 1, sort_order: db.artworks.length, created_at: now(), updated_at: now() };
  for (const k of ART_COLS) if (k in c.body) a[k] = c.body[k];
  db.artworks.push(a);
  audit(c.user, a.business_slug, 'artwork', a.id, 'create', `Added '${a.title}'`, null, a);
  json(c.res, 200, { artwork: shapeArtwork(a) });
});
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/artworks\/reorder$/, (c) => {
  const ids = c.body.ids;
  if (!Array.isArray(ids) || !ids.every((id) => db.artworks.some((a) => a.id === id && a.business_slug === c.m[1]))) return fail(c.res, 400, 'ids must all be artworks of this business.', 'invalid_field');
  ids.forEach((id, i) => { db.artworks.find((a) => a.id === id).sort_order = i; });
  json(c.res, 200, { ok: true });
});
admin('GET', /^\/api\/admin\/artworks\/(\d+)$/, (c) => { const a = findArtwork(c); return a ? json(c.res, 200, { artwork: shapeArtwork(a) }) : fail(c.res, 404, 'No such artwork.', 'not_found'); });
admin('PATCH', /^\/api\/admin\/artworks\/(\d+)$/, (c) => {
  const a = findArtwork(c);
  if (!a) return fail(c.res, 404, 'No such artwork.', 'not_found');
  const problem = artworkProblem(c, a.business_slug, c.body, false);
  if (problem) return fail(c.res, 400, problem, 'invalid_field');
  const before = { ...a };
  for (const k of ART_COLS) if (k in c.body) a[k] = c.body[k];
  a.updated_at = now();
  audit(c.user, a.business_slug, 'artwork', a.id, 'update', a.status === 'sold' && before.status !== 'sold' ? `Marked '${a.title}' sold` : `Edited '${a.title}'`, before, a);
  json(c.res, 200, { artwork: shapeArtwork(a) });
});
admin('DELETE', /^\/api\/admin\/artworks\/(\d+)$/, (c) => {
  const a = findArtwork(c);
  if (!a) return fail(c.res, 404, 'No such artwork.', 'not_found');
  audit(c.user, a.business_slug, 'artwork', a.id, 'delete', `Deleted '${a.title}'`, shapeArtwork(a), null);
  db.artworks = db.artworks.filter((x) => x !== a);
  db.images = db.images.filter((i) => i.artwork_id !== a.id);
  json(c.res, 200, { ok: true });
});
admin('POST', /^\/api\/admin\/artworks\/(\d+)\/images$/, (c) => {
  const a = findArtwork(c);
  if (!a) return fail(c.res, 404, 'No such artwork.', 'not_found');
  if (!isPhotoUrl(c.body.url, c) || (c.body.thumb_url != null && !isPhotoUrl(c.body.thumb_url, c))) return fail(c.res, 400, 'Photo links must start with https://.', 'invalid_field');
  const mine = artImages(a.id);
  if (mine.length >= 12) return fail(c.res, 409, 'An artwork can have at most 12 photos.', 'too_many_images');
  const img = { id: nextId++, artwork_id: a.id, url: c.body.url, thumb_url: c.body.thumb_url ?? null, alt: c.body.alt ?? null, width: c.body.width ?? null, height: c.body.height ?? null, sort_order: mine.length ? Math.max(...mine.map((i) => i.sort_order)) + 1 : 0 };
  db.images.push(img);
  audit(c.user, a.business_slug, 'artwork_image', img.id, 'create', `Added a photo of '${a.title}'`, null, img);
  json(c.res, 200, { image: img });
});
admin('POST', /^\/api\/admin\/artworks\/(\d+)\/images\/reorder$/, (c) => {
  const a = findArtwork(c);
  if (!a) return fail(c.res, 404, 'No such artwork.', 'not_found');
  const ids = c.body.ids;
  if (!Array.isArray(ids) || !ids.every((id) => db.images.some((i) => i.id === id && i.artwork_id === a.id))) return fail(c.res, 400, 'ids must all be photos of this artwork.', 'invalid_field');
  ids.forEach((id, k) => { db.images.find((i) => i.id === id).sort_order = k; });
  json(c.res, 200, { ok: true });
});
admin('PATCH', /^\/api\/admin\/artwork-images\/(\d+)$/, (c) => {
  const img = db.images.find((i) => i.id === Number(c.m[1]));
  if (!img) return fail(c.res, 404, 'No such photo.', 'not_found');
  if ('alt' in c.body) img.alt = c.body.alt;
  json(c.res, 200, { image: img });
});
admin('DELETE', /^\/api\/admin\/artwork-images\/(\d+)$/, (c) => {
  const img = db.images.find((i) => i.id === Number(c.m[1]));
  if (!img) return fail(c.res, 404, 'No such photo.', 'not_found');
  db.images = db.images.filter((i) => i !== img);
  json(c.res, 200, { ok: true });
});

// --- Photo library (docs/assistant-api.md §5) ---
const mediaKey = (link) => { const m = /\/api\/media\/(.+)$/.exec(String(link || '')); return m ? m[1] : null; };
const inUse = (p) => {
  const keys = new Set([p.url, p.thumb_url].map(mediaKey).filter(Boolean));
  const places = [];
  for (const e of db.events) if (keys.has(mediaKey(e.image_url))) places.push({ kind: 'event', id: e.id, title: e.title, business_slug: e.business_slug });
  for (const a of db.announcements) if (keys.has(mediaKey(a.image_url))) places.push({ kind: 'announcement', id: a.id, title: a.title, business_slug: a.business_slug });
  for (const i of db.images) if (keys.has(mediaKey(i.url)) || keys.has(mediaKey(i.thumb_url))) { const a = db.artworks.find((x) => x.id === i.artwork_id); places.push({ kind: 'artwork', id: a.id, title: a.title, business_slug: a.business_slug }); }
  return places;
};
const shapePhoto = (p) => ({
  ...p, business_name: db.businesses.find((b) => b.slug === p.business_slug)?.name, thumb_url: p.thumb_url || p.url,
  album_name: db.albums.find((a) => a.id === p.album_id)?.name || null, created_at: `${p.created_at.replace(' ', 'T')}Z`, uploaded_by_name: db.users.find((u) => u.id === p.uploaded_by)?.name || null, in_use: inUse(p),
});
const albumsOf = (slug) => db.albums.filter((a) => a.business_slug === slug).sort((a, b) => a.sort_order - b.sort_order).map((a) => ({ ...a, count: db.library.filter((p) => p.album_id === a.id).length }));
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/media$/, (c) => {
  const slug = c.m[1];
  const album = c.url.searchParams.get('album_id');
  const q = (c.url.searchParams.get('q') || '').toLowerCase();
  const before = Number(c.url.searchParams.get('before') || 0);
  const limit = Number(c.url.searchParams.get('limit') || 60);
  const list = db.library.filter((p) => p.business_slug === slug
    && (!album || (album === 'none' ? p.album_id == null : p.album_id === Number(album)))
    && (!q || [p.note, p.alt, db.albums.find((a) => a.id === p.album_id)?.name].some((t) => (t || '').toLowerCase().includes(q)))
    && (!before || p.id < before)).sort((a, b) => b.id - a.id);
  const page = list.slice(0, limit);
  json(c.res, 200, {
    photos: page.map(shapePhoto), albums: albumsOf(slug), total: db.library.filter((p) => p.business_slug === slug).length,
    no_album: db.library.filter((p) => p.business_slug === slug && p.album_id == null).length, next_before: list.length > limit ? page[page.length - 1].id : null,
  });
});
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/media$/, (c) => {
  const b = c.body;
  if (!b.url) return fail(c.res, 400, 'The photo link is required.', 'missing_field');
  if (b.album_id != null && !db.albums.some((a) => a.id === b.album_id && a.business_slug === c.m[1])) return fail(c.res, 400, 'That album is not one of this business’s albums.', 'invalid_album');
  if (b.r2_key != null && b.r2_key !== mediaKey(b.url)) return fail(c.res, 400, 'The photo key does not match its link.', 'invalid_field');
  if (db.library.some((p) => p.url === b.url)) return fail(c.res, 409, 'That photo is already in the library.', 'already_in_library');
  const p = { id: nextId++, business_slug: c.m[1], album_id: b.album_id ?? null, url: b.url, thumb_url: b.thumb_url ?? null, r2_key: b.r2_key ?? null, thumb_r2_key: b.thumb_r2_key ?? null, note: b.note ?? null, alt: b.alt ?? null, width: b.width ?? null, height: b.height ?? null, bytes: b.bytes ?? null, taken_at: b.taken_at ?? null, uploaded_by: c.user.id, created_at: now() };
  db.library.push(p);
  audit(c.user, p.business_slug, 'photo', p.id, 'create', `Added photo "${p.note || 'photo'}" to the photo library`, null, p);
  json(c.res, 200, { photo: shapePhoto(p) });
});
admin('PATCH', /^\/api\/admin\/media\/(\d+)$/, (c) => {
  const p = db.library.find((x) => x.id === Number(c.m[1]));
  if (!p) return fail(c.res, 404, 'No such photo.', 'not_found');
  if ('business_slug' in c.body && c.body.business_slug !== p.business_slug) {
    if (!db.businesses.some((b) => b.slug === c.body.business_slug)) return fail(c.res, 404, 'No such business.', 'unknown_business');
    p.business_slug = c.body.business_slug;
    if (!('album_id' in c.body)) p.album_id = null;
  }
  if ('album_id' in c.body) {
    if (c.body.album_id != null && !db.albums.some((a) => a.id === c.body.album_id && a.business_slug === p.business_slug)) return fail(c.res, 400, 'That album is not one of this business’s albums.', 'invalid_album');
    p.album_id = c.body.album_id;
  }
  for (const k of ['note', 'alt']) if (k in c.body) p[k] = c.body[k];
  json(c.res, 200, { photo: shapePhoto(p) });
});
admin('DELETE', /^\/api\/admin\/media\/(\d+)$/, (c) => {
  const p = db.library.find((x) => x.id === Number(c.m[1]));
  if (!p) return fail(c.res, 404, 'No such photo.', 'not_found');
  const places = inUse(p);
  if (places.length) return json(c.res, 409, { error: `This photo is used by the ${places[0].kind} "${places[0].title}". Take it off there first, then delete it.`, code: 'in_use', in_use: places });
  db.library = db.library.filter((x) => x !== p);
  for (const k of [p.r2_key, p.thumb_r2_key]) if (k) db.media.delete(k);
  json(c.res, 200, { ok: true });
});
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/albums$/, (c) => json(c.res, 200, { albums: albumsOf(c.m[1]) }));
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/albums$/, (c) => {
  const name = String(c.body.name || '').trim();
  if (!name) return fail(c.res, 400, 'The album name is required.', 'missing_field');
  if (db.albums.some((a) => a.business_slug === c.m[1] && a.name.toLowerCase() === name.toLowerCase())) return fail(c.res, 409, `There is already an album called "${name}".`, 'album_exists');
  const a = { id: nextId++, business_slug: c.m[1], name, sort_order: Math.max(0, ...db.albums.filter((x) => x.business_slug === c.m[1]).map((x) => x.sort_order)) + 1 };
  db.albums.push(a);
  json(c.res, 200, { album: { ...a, count: 0 } });
});
admin('PATCH', /^\/api\/admin\/albums\/(\d+)$/, (c) => {
  const a = db.albums.find((x) => x.id === Number(c.m[1]));
  if (!a) return fail(c.res, 404, 'No such album.', 'not_found');
  if ('name' in c.body) a.name = String(c.body.name).trim();
  json(c.res, 200, { album: a });
});
admin('DELETE', /^\/api\/admin\/albums\/(\d+)$/, (c) => {
  const id = Number(c.m[1]);
  let moved = 0;
  db.library.forEach((p) => { if (p.album_id === id) { p.album_id = null; moved++; } });
  db.albums = db.albums.filter((x) => x.id !== id);
  json(c.res, 200, { ok: true, photos_moved: moved });
});

// --- TV screens (§6) ---
const screenSettings = (slug) => {
  const raw = db.settings[`signage:${slug}`] || {};
  const scenes = {};
  for (const name of ['welcome', 'notice', 'announcements', 'featured', 'menu', 'catering', 'events', 'artworks']) scenes[name] = raw.scenes?.[name] !== false;
  return { ...raw, seconds_per_scene: raw.seconds_per_scene || 10, scenes, refresh_version: raw.refresh_version || 0 };
};
const shapeScreen = (s, c) => {
  const seen = s.last_seen_at ? Date.parse(s.last_seen_at) : null;
  const base = `http://${c.req.headers.host}/signage/live.html?business=${s.business_slug}`;
  return { ...s, status: seen == null ? 'never' : Date.now() - seen < 600000 ? 'online' : 'offline', preview_url: base, player_url: `${base}&screen=${s.id}` };
};
admin('GET', /^\/api\/admin\/businesses\/([a-z-]+)\/screens$/, (c) => json(c.res, 200, { screens: db.screens.filter((s) => s.business_slug === c.m[1]).map((s) => shapeScreen(s, c)), settings: screenSettings(c.m[1]) }));
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/screens$/, (c) => {
  if (!String(c.body.name || '').trim()) return fail(c.res, 400, 'The screen name is required.', 'missing_field');
  const s = { id: `scr${nextId++}abc`, business_slug: c.m[1], name: c.body.name.trim(), notes: c.body.notes ?? null, last_seen_at: null, last_scene: null, last_version: null, created_at: now() };
  db.screens.push(s);
  json(c.res, 200, { screen: shapeScreen(s, c) });
});
admin('POST', /^\/api\/admin\/businesses\/([a-z-]+)\/screens\/refresh$/, (c) => {
  const key = `signage:${c.m[1]}`;
  db.settings[key] = { ...(db.settings[key] || {}), refresh_version: (db.settings[key]?.refresh_version || 0) + 1 };
  json(c.res, 200, { settings: screenSettings(c.m[1]), refresh_version: db.settings[key].refresh_version });
});
admin('PATCH', /^\/api\/admin\/screens\/([a-z0-9]+)$/, (c) => {
  const s = db.screens.find((x) => x.id === c.m[1]);
  if (!s) return fail(c.res, 404, 'No such screen.', 'not_found');
  for (const k of ['name', 'notes']) if (k in c.body) s[k] = c.body[k];
  json(c.res, 200, { screen: shapeScreen(s, c) });
});
admin('DELETE', /^\/api\/admin\/screens\/([a-z0-9]+)$/, (c) => { db.screens = db.screens.filter((x) => x.id !== c.m[1]); json(c.res, 200, { ok: true }); });

// --- The Assistant (§3), streamed as Server-Sent Events, and its change sets (§1) ---
const ASSISTANT_OFF = { error: 'The Assistant is not switched on yet. An owner needs to add the Anthropic API key.', code: 'assistant_not_configured' };
const assistantAdmin = (method, pattern, handler) => admin(method, pattern, (c) => (db.assistantConfigured ? handler(c) : json(c.res, 501, ASSISTANT_OFF)));
const iso = () => new Date().toISOString().slice(0, 19) + 'Z';
const randomId = () => Array.from({ length: 22 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[Math.floor(Math.random() * 64)]).join('');
/** Writes the events one by one with a short pause, like a real reply arriving. */
function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  res.write(': still working\n\n');
  let i = 0;
  const next = () => {
    if (i >= events.length) return res.end();
    const [event, data] = events[i++];
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    setTimeout(next, 25);
  };
  setTimeout(next, 25);
}
function fakeDraft(conversationId, text) {
  const id = randomId();
  const blocked = /yesterday/i.test(text);
  const cs = blocked ? {
    title: 'Notice until yesterday', ops: [{ op: 'business.patch', business_slug: 'peachs', args: { notice: 'Closed for a private event', notice_until: '2026-10-12' } }],
    summary: [{ business_slug: 'peachs', business_name: "Peach's", line: 'Notice', before: null, after: 'Closed for a private event' }],
    checks: [{ level: 'block', message: 'The notice would end on Oct 12, which has already passed.', op_index: 0 }],
  } : {
    title: 'Close early Friday', ops: [{ op: 'hours_exception.create', business_slug: 'peachs', args: { date: '2026-10-16', closed: 0, open_min: 480, close_min: 720, label: 'Closing early' } }],
    summary: [{ business_slug: 'peachs', business_name: "Peach's", line: 'Special hours on Friday, October 16 (Closing early)', before: 'Usual hours: 8 am – 2 pm', after: '8 am – 12 pm' }],
    checks: [{ level: 'ok', message: 'Checked: nothing unusual.', op_index: null }],
  };
  Object.assign(cs, {
    id, version: `v-${id.slice(0, 6)}`, status: 'draft', source: 'assistant', conversation_id: conversationId, created_at: iso(), updated_at: iso(), expires_at: new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 19) + 'Z',
    published_at: null, businesses: ['peachs'], error: null,
    preview_urls: [{ business_slug: 'peachs', label: "Peach's website", url: `/peachs.html?preview=${id}` }, { business_slug: 'peachs', label: 'TV screen', url: `/signage/live.html?business=peachs&preview=${id}` }],
  });
  db.changeSets.set(id, cs);
  return cs;
}
const findConversation = (c) => db.conversations.find((x) => x.id === c.m[1] && x.user_id === c.user.id);
assistantAdmin('GET', /^\/api\/admin\/assistant\/conversations$/, (c) => json(c.res, 200, { conversations: db.conversations.filter((x) => x.user_id === c.user.id).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).map(({ messages, ...x }) => x) }));
assistantAdmin('POST', /^\/api\/admin\/assistant\/conversations$/, (c) => {
  const conv = { id: randomId(), user_id: c.user.id, business_slug: c.body.business_slug ?? null, title: null, created_at: iso(), updated_at: iso(), messages: [] };
  db.conversations.push(conv);
  const { messages, ...shape } = conv;
  json(c.res, 200, { conversation: shape });
});
assistantAdmin('GET', /^\/api\/admin\/assistant\/conversations\/([\w-]+)$/, (c) => {
  const conv = findConversation(c);
  if (!conv) return fail(c.res, 404, 'No such chat.', 'not_found');
  const { messages, ...shape } = conv;
  json(c.res, 200, { conversation: shape, messages });
});
assistantAdmin('POST', /^\/api\/admin\/assistant\/conversations\/([\w-]+)\/messages$/, (c) => {
  const conv = findConversation(c);
  if (!conv) return fail(c.res, 404, 'No such chat.', 'not_found');
  const text = String(c.body.text || '').trim();
  const images = Array.isArray(c.body.images) ? c.body.images : [];
  if (/daily limit/i.test(text)) return fail(c.res, 429, "You have used today's 60 Assistant messages. It resets at midnight. You can still make changes by hand.", 'assistant_limit');
  if (images.some((img) => img.media_type !== 'image/jpeg' || !/^[A-Za-z0-9+/]+=*$/.test(img.data_base64 || '') || img.data_base64.length * 0.75 > 1.5 * 1024 * 1024)) return fail(c.res, 400, 'Photos must be JPEG, at most 1.5 MB.', 'invalid_field');
  db.lastImages = images;
  conv.title = conv.title || text.slice(0, 80) || 'Photo';
  conv.updated_at = iso();
  conv.messages.push({ id: nextId++, role: 'user', text, attachments_count: images.length, created_at: iso(), tools: [], drafts: [] });
  const cs = fakeDraft(conv.id, text);
  const reply = cs.checks.some((k) => k.level === 'block')
    ? 'I drafted the notice, but it would end yesterday, so it cannot be published. Which day should it show until?'
    : 'Here is the draft: Peach’s closes at 12 pm on Friday, October 16. Use the preview to check it. Nothing is live until you tap Publish.';
  conv.messages.push({ id: nextId++, role: 'assistant', text: reply, attachments_count: 0, created_at: iso(), tools: ["Looking at the details and hours for Peach's…", 'Drafting the changes…'], drafts: [cs.id] });
  const words = reply.match(/\S+\s*/g);
  sse(c.res, [
    ['tool', { name: 'get_business', label: "Looking at the details and hours for Peach's…" }],
    ['tool', { name: 'propose_changes', label: 'Drafting the changes…' }],
    ['draft', { change_set: cs }],
    ...words.map((w) => ['text', { delta: w }]),
    ['done', { message_id: conv.messages.length, usage: { input_tokens: 1200, output_tokens: 90 } }],
  ]);
});
assistantAdmin('POST', /^\/api\/admin\/assistant\/conversations\/([\w-]+)\/published$/, (c) => {
  const conv = findConversation(c);
  const cs = db.changeSets.get(c.body.change_set_id);
  if (!conv || !cs) return fail(c.res, 404, 'No such chat.', 'not_found');
  if (cs.status !== 'published') return fail(c.res, 409, 'That draft has not been published.', 'not_published');
  const reply = 'Checked the live website: Friday’s early closing is now live.';
  // The real server stores a system note here, which the chat does not show; only the reply comes back.
  conv.messages.push({ id: nextId++, role: 'assistant', text: reply, attachments_count: 0, created_at: iso(), tools: ['Checking the live website…'], drafts: [] });
  db.followUps = (db.followUps || 0) + 1;
  sse(c.res, [['tool', { name: 'verify_change_set', label: 'Checking the live website…' }], ...reply.match(/\S+\s*/g).map((w) => ['text', { delta: w }]), ['done', { message_id: 1, usage: {} }]]);
});
assistantAdmin('GET', /^\/api\/admin\/assistant\/usage$/, (c) => (manager(c) ? json(c.res, 200, {
  days: 30, since: '2026-09-14',
  totals: { turns: 14, calls: 33, input_tokens: 90000, output_tokens: 4000, cache_read_tokens: 300000, cache_write_tokens: 20000, cost_usd: 1.4 },
  this_month: { since: '2026-10-01', turns: 12, calls: 30, input_tokens: 80000, output_tokens: 3600, cache_read_tokens: 250000, cache_write_tokens: 18000, cost_usd: 1.234 },
  by_day: [], by_user: [{ user_id: 1, name: 'Cliff Rome', email: 'owner@example.com', turns: 14, calls: 33, cost_usd: 1.4 }],
}) : fail(c.res, 403, 'Owners and admins only', 'forbidden')));
const findChangeSet = (c) => db.changeSets.get(c.m[1]);
admin('GET', /^\/api\/admin\/change-sets\/([\w-]+)$/, (c) => { const cs = findChangeSet(c); return cs ? json(c.res, 200, { change_set: cs }) : fail(c.res, 404, 'No such change set.', 'not_found'); });
admin('POST', /^\/api\/admin\/change-sets\/([\w-]+)\/publish$/, (c) => {
  const cs = findChangeSet(c);
  if (!cs) return fail(c.res, 404, 'No such change set.', 'not_found');
  if (cs.status !== 'draft') return fail(c.res, 409, 'This change set was already published.', 'not_a_draft');
  // The card sends the version it shows, so a draft replaced since is not published under the old summary.
  if (c.body.version !== cs.version) return fail(c.res, 409, 'This draft changed since you looked at it. Check the new version, then publish.', 'change_set_changed');
  if (cs.checks.some((k) => k.level === 'block')) return fail(c.res, 409, 'This draft has a problem to fix before it can be published.', 'change_set_blocked');
  Object.assign(cs, { status: 'published', published_at: iso(), updated_at: iso() });
  audit(c.user, 'peachs', 'change_set', cs.id, 'update', `Published "${cs.title}" (1 change)`, null, null);
  json(c.res, 200, { change_set: cs, results: [{ op_index: 0, ok: true }] });
});
admin('POST', /^\/api\/admin\/change-sets\/([\w-]+)\/discard$/, (c) => {
  const cs = findChangeSet(c);
  if (!cs || cs.status !== 'draft') return fail(c.res, 409, 'This is not a draft.', 'not_a_draft');
  Object.assign(cs, { status: 'discarded', updated_at: iso() });
  json(c.res, 200, { change_set: cs });
});
admin('POST', /^\/api\/admin\/change-sets\/([\w-]+)\/undo$/, (c) => {
  const cs = findChangeSet(c);
  if (!cs || cs.status !== 'published') return fail(c.res, 409, 'Only published changes can be undone.', 'not_published');
  Object.assign(cs, { status: 'undone', updated_at: iso() });
  json(c.res, 200, { change_set: cs });
});
admin('GET', /^\/api\/admin\/change-sets\/([\w-]+)\/verify$/, (c) => {
  const cs = findChangeSet(c);
  if (!cs || cs.status !== 'published') return fail(c.res, 409, 'Only published changes can be checked against the live website.', 'not_published');
  json(c.res, 200, { ok: true, lines: cs.summary.map((l) => ({ business_slug: l.business_slug, line: l.line, ok: true, detail: 'Live on the website.' })) });
});

// --- The Claude app connector (§4): the Account screen's list ---
admin('GET', /^\/api\/admin\/connected-apps$/, (c) => json(c.res, 200, { connected_apps: db.connectedApps }));
admin('DELETE', /^\/api\/admin\/connected-apps\/([\w-]+)$/, (c) => {
  if (!db.connectedApps.some((a) => a.id === c.m[1])) return fail(c.res, 404, 'That connected app was not found.', 'not_found');
  db.connectedApps = db.connectedApps.filter((a) => a.id !== c.m[1]);
  json(c.res, 200, { ok: true });
});

/* -------------------------------------------------------------------------
   Static files + API dispatch
   ------------------------------------------------------------------------- */
const TYPES = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const apiCalls = [];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const { body, form } = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : { body: {}, form: null };
    apiCalls.push({ method: req.method, path: url.pathname, body });
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (m && r.method === req.method) return r.handler({ req, res, url, m, body, form, user: authUser(req) });
    }
    return fail(res, 404, `No route for ${req.method} ${url.pathname}`, 'not_found');
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
}

/* -------------------------------------------------------------------------
   The browser run
   ------------------------------------------------------------------------- */
async function run() {
  await mkdir(OUT, { recursive: true });
  const server = createServer((req, res) => handle(req, res).catch((err) => { console.error(err); res.writeHead(500); res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const problems = [];
  let shots = 0;
  let lastPage = null;

  try {
    for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Chicago' });
      lastPage = null;
      // Keep the run offline: Google Fonts fall back to system fonts.
      await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const page = await context.newPage();
      lastPage = page;
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const where = msg.location().url || '';
        if (/fonts\.g(oogleapis|static)/.test(where)) return;                       // offline run: fonts fall back
        if (where.endsWith('/api/auth/login') && /\b401\b/.test(msg.text())) return; // the deliberate wrong password
        if (where.endsWith('/api/admin/media') && /\b503\b/.test(msg.text())) return; // the deliberate failed upload
        if (/\/api\/admin\/media\/71$/.test(where) && /\b409\b/.test(msg.text())) return; // deleting a photo in use
        if (/\/messages$/.test(where) && /\b429\b/.test(msg.text())) return; // the Assistant's daily limit
        if (/\/api\/admin\/assistant\//.test(where) && /\b501\b/.test(msg.text()) && !db.assistantConfigured) return; // switched off on purpose
        problems.push(`[${name}] console: ${msg.text()} (${where})`);
      });
      page.on('pageerror', (err) => problems.push(`[${name}] page error: ${err.message}`));
      // full: false keeps the picture to the screen, for the panels and dialogs that sit over the page.
      const shot = async (label, { keepToast = /saved/.test(label), full = true } = {}) => {
        shots++;
        // Scroll to the top and drop stale toasts (the run is far faster than a person) so the picture shows the layout.
        if (full) await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate((keep) => { if (!keep) document.querySelectorAll('.toast').forEach((t) => t.remove()); }, keepToast);
        await page.screenshot({ path: path.join(OUT, `${name}-${String(shots).padStart(2, '0')}-${label}.png`), fullPage: full });
      };
      // Phones show four items in the bottom bar; everything else is behind "More".
      const nav = async (id) => {
        const direct = page.locator(`[data-nav="${id}"]:visible`).first();
        if (await direct.count()) return direct.click();
        await page.click('.bottomnav button:has-text("More")');
        await page.getByRole('dialog').locator(`[data-nav="${id}"]`).click();
      };
      const heading = (text) => page.getByRole('heading', { level: 1, name: text });
      const toastSaved = () => page.getByText('Saved. Websites update within a minute.').first().waitFor({ timeout: 5000 });

      if (name === 'phone') {
        // --- First run: no users yet, so the bootstrap screen shows ---
        freshState();
        await page.goto(`${base}/admin/`);
        await heading('Create the first account').waitFor();
        await shot('bootstrap');
        await page.fill('input[name="token"]', BOOTSTRAP_TOKEN);
        await page.fill('input[name="name"]', 'Cliff Rome');
        await page.fill('input[name="email"]', 'owner@example.com');
        await page.fill('input[name="password"]', 'correct horse battery');
        await page.click('button:has-text("Create account")');
      } else {
        // --- Second run: the account exists, so sign in ---
        await page.goto(`${base}/admin/`);
        await heading('Sign in').waitFor();
        await shot('login');
        await page.fill('input[name="email"]', 'owner@example.com');
        await page.fill('input[name="password"]', 'wrong password');
        await page.click('button:has-text("Sign in")');
        await page.getByText('do not match').waitFor();
        await page.fill('input[name="password"]', 'correct horse battery');
        await page.click('button:has-text("Sign in")');
      }

      // --- Overview renders from the public bundle ---
      await heading("Peach's on 47th").waitFor();
      await page.getByText('Closed · opens Wed 8 am').waitFor();
      await page.getByText('FIXTURE NOTICE', { exact: false }).first().waitFor();
      assert.equal(await page.locator('#business-select').inputValue(), 'peachs');
      await shot('overview');

      // --- Hours: change Saturday, save ---
      await nav('hours');
      await heading('Hours').waitFor();
      // The desktop run reuses the phone run's data, so Saturday already ends later.
      const [wasClose, newClose, newCloseMin] = name === 'phone' ? ['15:00', '16:00', 960] : ['16:00', '17:00', 1020];
      assert.equal(await page.inputValue('input[name="close-6"]'), wasClose);
      await page.fill('input[name="close-6"]', newClose);
      await page.click('button:has-text("Save hours")');
      await toastSaved();
      const saved = db.hours.peachs.find((r) => r.weekday === 6);
      assert.deepEqual({ closed: saved.closed, open_min: saved.open_min, close_min: saved.close_min }, { closed: 0, open_min: 480, close_min: newCloseMin });
      await shot('hours-saved');
      // Special day
      const [exDate, exText] = name === 'phone' ? ['2026-12-25', 'Friday, Dec 25, 2026 · Christmas Day'] : ['2026-12-31', 'Thursday, Dec 31, 2026 · Christmas Day'];
      await page.fill('input[name="date"]', exDate);
      await page.fill('input[name="label"]', 'Christmas Day');
      await page.click('button:has-text("Add special day")');
      await page.getByText(exText).waitFor();

      // --- Events: add one ---
      await nav('events');
      await heading('Events').waitFor();
      await page.locator('a.btn', { hasText: 'Add event' }).first().click();
      await heading('Add an event').waitFor();
      await page.click('button:has-text("Add event")'); // validation: nothing filled in
      await page.getByText('Give the event a title.').waitFor();
      const eventTitle = `Holiday market brunch (${name})`;
      await page.fill('input[name="title"]', eventTitle);
      await page.fill('input[name="start_date"]', '2026-12-20');
      await page.fill('input[name="start_time"]', '10:00');
      await page.fill('input[name="end_time"]', '14:00');
      await page.fill('input[name="location"]', 'Peach’s patio');
      await page.check('input[name="featured"]');
      // Event photo: shrunk in the browser to at most 2000 px, uploaded as one "full" copy, link put in the field.
      const eventUploads = db.uploads.length;
      await page.setInputFiles('input[type="file"]:not([multiple])', { name: 'brunch-table.png', mimeType: 'image/png', buffer: PNG_WIDE });
      await page.getByText('Uploaded. Save the form to keep it.').waitFor();
      const eventPhoto = db.uploads.slice(eventUploads);
      assert.equal(eventPhoto.length, 1);
      assert.ok(['image/webp', 'image/jpeg'].includes(eventPhoto[0].type), eventPhoto[0].type);
      assert.deepEqual([eventPhoto[0].variant, eventPhoto[0].slug, eventPhoto[0].width, eventPhoto[0].height], ['full', 'peachs', 2000, 1333]);
      assert.deepEqual([eventPhoto[0].decoded.width, eventPhoto[0].decoded.height], [2000, 1333]);
      assert.match(await page.inputValue('input[name="image_url"]'), /\/api\/media\/uploads\/peachs\/.+-full\.(webp|jpg)$/);
      await page.locator('img.photo-preview:visible').waitFor();
      await shot('event-form');
      await page.click('button:has-text("Add event")');
      await toastSaved();
      await heading('Events').waitFor();
      await page.getByRole('tab', { name: /Upcoming/ }).click();
      await page.getByText(eventTitle).waitFor();
      await page.getByText('Dec 20, 2026 · 10 am – 2 pm · Peach’s patio').first().waitFor();
      assert.ok(db.events.some((e) => e.title === eventTitle && e.featured === 1 && e.published === 1 && /\/api\/media\//.test(e.image_url || '')));
      await shot('events');

      // --- Inquiries: list, open one, mark handled ---
      db.inquiries.find((q) => q.id === 501).status = 'new'; // the phone run handled it
      await nav('inquiries');
      await heading('Inquiries').waitFor();
      await page.getByText('Form emails are not set up yet').waitFor();
      await page.getByText('Dana Whitfield').waitFor();
      await shot('inquiries');
      await page.locator('.list__open', { hasText: 'Dana Whitfield' }).click();
      await heading('Dana Whitfield').waitFor();
      await page.getByText('baby shower brunch').waitFor();
      await page.getByText('party size').waitFor();
      await shot('inquiry');
      await page.click('button:has-text("Mark handled")');
      await page.getByText('Marked as handled.').waitFor();
      assert.equal(db.inquiries.find((q) => q.id === 501).status, 'handled');

      // --- Menu: open, edit an item inline ---
      await nav('menu');
      await heading('Menu').waitFor();
      await page.getByText('Fried Catfish, Greens & Grits').waitFor();
      await shot('menu');
      const catfish = page.locator('.menu-item', { hasText: 'Fried Catfish' });
      await catfish.locator('button', { hasText: 'Edit' }).click();
      const newPrice = name === 'phone' ? 24 : 25;
      await page.fill('form.menu-item__form input[name="price"]', String(newPrice));
      await page.click('form.menu-item__form button:has-text("Save")');
      await toastSaved();
      await page.getByText(`$${newPrice}`).waitFor();
      assert.equal(db.items.find((i) => i.id === 10).price, newPrice);

      // --- A few more screens render without errors ---
      await nav('notice');
      await heading('Notice').waitFor();
      await page.getByText('This is how it looks').waitFor();
      await shot('notice');
      await nav('contact');
      await heading('Contact & links').waitFor();
      assert.equal(await page.inputValue('input[name="inquiry_emails"]'), 'ordering@romesjoy.com, manager@example.com');
      await nav('announcements');
      await heading('Announcements').waitFor();
      await page.getByRole('tab', { name: 'Whole family' }).click();
      await page.getByText('Obama Presidential Center').waitFor();
      await nav('history');
      await heading('History').waitFor();
      await page.getByText('Changed Saturday hours').waitFor();
      await nav('users');
      await heading('Users').waitFor();
      await page.getByText('owner@example.com').first().waitFor();
      await shot('users');
      // --- Unsaved changes: the browser's confirm is auto-dismissed here, so the page must stay ---
      await nav('contact');
      await heading('Contact & links').waitFor();
      await page.fill('input[name="tagline"]', 'Edited but not saved');
      await nav('hours');
      await page.waitForTimeout(300);
      await heading('Contact & links').waitFor();
      assert.equal(await page.inputValue('input[name="tagline"]'), 'Edited but not saved');
      await page.click('button:has-text("Save changes")');
      await toastSaved();
      assert.equal(db.businesses[0].tagline, 'Edited but not saved');
      await nav('users');
      await heading('Users').waitFor();

      if (name === 'phone') {
        await page.click('.bottomnav button:has-text("More")');
        await page.getByRole('dialog').getByText('All pages').waitFor();
        await shot('more-sheet');
        await page.keyboard.press('Escape');
      }
      // Switch business and check the overview follows. Artworks is a Blanc feature: hidden for Peach's.
      assert.equal(await page.locator('[data-nav="artworks"]').count(), 0);
      await page.selectOption('#business-select', 'blanc');
      await heading('Users').waitFor(); // Users is not per business, so the page stays
      assert.ok(await page.locator('[data-nav="artworks"]:visible').count() >= 1, 'Artworks is in the nav for Blanc');
      await nav('overview');
      await heading('Blanc Gallery').waitFor();
      await page.getByText('Usual week', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('rj_admin_business')), 'blanc');
      const blancArt = () => db.artworks.filter((a) => a.business_slug === 'blanc');
      await page.getByText(`${blancArt().length} artworks · ${blancArt().filter((a) => a.status === 'available').length} available`).waitFor();
      await shot('overview-blanc');

      // --- Artworks: list, add one with two photos, mark it sold, reorder, filter ---
      await nav('artworks');
      await heading('Artworks').waitFor();
      await page.locator('.art-card', { hasText: 'Untitled (Family Portrait)' }).waitFor();
      await page.locator('.art-card', { hasText: 'Study in Blue' }).getByText('Draft').waitFor();
      await shot('artworks');
      await page.locator('a.btn', { hasText: 'Add artwork' }).first().click();
      await heading('Add an artwork').waitFor();
      await page.click('button:has-text("Add artwork")'); // validation: nothing filled in
      await page.getByText('Give the artwork a title.').waitFor();
      // "Add photos" before there is a title: the picker stays shut (picked photos would be thrown away) and the title asks first.
      let pickerOpened = false;
      const onChooser = () => { pickerOpened = true; };
      page.on('filechooser', onChooser);
      await page.locator('label', { hasText: 'Add photos' }).click();
      await page.getByText('Give the artwork a title first, then add photos.').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'title');
      await page.waitForTimeout(300);
      page.off('filechooser', onChooser);
      assert.equal(pickerOpened, false, 'the photo picker must not open without a title');
      const artTitle = `Evening on King Drive (${name})`;
      await page.fill('input[name="title"]', artTitle);
      await page.fill('input[name="artist"]', 'Jordan Avery');
      await page.fill('input[name="year"]', '2026');
      await page.fill('input[name="medium"]', 'Oil on linen');
      await page.fill('input[name="dimensions"]', '30 × 40 in.');
      await page.fill('textarea[name="description"]', 'Streetlights on King Drive just after the rain.');
      await page.selectOption('select[name="event_id"]', '801');
      await page.fill('input[name="price"]', '2400');
      await page.check('input[name="price_display"][value="show"]');
      await page.check('input[name="featured"]');
      await shot('artwork-form');
      // A new artwork is saved first when photos are added; then each photo is shrunk and uploaded twice (full + thumb).
      const uploadsBefore = db.uploads.length;
      await page.setInputFiles('input[type="file"][multiple]', [
        { name: 'gallery-wall.png', mimeType: 'image/png', buffer: PNG_WIDE },
        { name: 'detail-shot.png', mimeType: 'image/png', buffer: PNG_TALL },
      ]);
      await page.locator('.upload-progress__row.is-done').nth(1).waitFor({ timeout: 15000 });
      await page.locator('.photo-row').nth(1).waitFor();
      const created = db.artworks.find((a) => a.title === artTitle);
      assert.ok(created, 'the new artwork was saved before its photos');
      assert.ok(page.url().endsWith(`#/artworks/${created.id}`), page.url());
      await heading(artTitle).waitFor();
      const posted = db.uploads.slice(uploadsBefore);
      assert.deepEqual(posted.map((u) => [u.variant, u.width, u.height]), [['full', 2000, 1333], ['thumb', 640, 427], ['full', 1200, 1800], ['thumb', 427, 640]]);
      for (const u of posted) {
        assert.ok(['image/webp', 'image/jpeg'].includes(u.type), `uploaded as ${u.type}`);
        assert.equal(u.slug, 'blanc');
        assert.ok(Math.max(u.width, u.height) <= (u.variant === 'full' ? 2000 : 640));
        assert.deepEqual([u.decoded?.format, u.decoded?.width, u.decoded?.height], [u.type === 'image/webp' ? 'webp' : 'jpeg', u.width, u.height]); // the bytes match the fields
      }
      const createdImages = () => db.images.filter((i) => i.artwork_id === created.id).sort((a, b) => a.sort_order - b.sort_order);
      assert.equal(createdImages().length, 2);
      assert.deepEqual(createdImages().map((i) => [i.width, i.height, /-thumb\.(webp|jpg)$/.test(i.thumb_url)]), [[2000, 1333, true], [1200, 1800, true]]);
      // A photo the browser cannot read (HEIC on most browsers) gets the plain-language message and is not uploaded.
      await page.setInputFiles('input[type="file"][multiple]', { name: 'IMG_2041.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really a HEIC photo') });
      await page.locator('.upload-progress__row.is-error', { hasText: HEIC_MESSAGE }).waitFor();
      assert.equal(db.uploads.length, uploadsBefore + 4);
      // Describe the second photo, then make it the main one: the description typed so far moves with it.
      await page.getByLabel('Photo 2: what it shows').fill('Close-up of the brushwork on the wet street');
      await page.locator('.photo-row').nth(1).getByRole('button', { name: /Make main/ }).click();
      await page.getByText('Main photo changed.').waitFor();
      await until(() => createdImages()[0].width === 1200, 'the reorder');
      assert.equal(await page.getByLabel('Photo 1: what it shows').inputValue(), 'Close-up of the brushwork on the wet street');
      await shot('artwork-photos');
      if (name === 'phone') {
        // Typing a description while another photo uploads: the new row is added below, so the focus and every
        // keystroke stay. Rows say which photo of the batch they are (iPhones call them all image.jpg), and a
        // failed upload keeps its file for "Try that photo again".
        let failFirst = true;
        let releaseUpload;
        const uploadHeld = new Promise((resolve) => { releaseUpload = resolve; });
        await page.route('**/api/admin/media', async (r) => {
          if (failFirst) { failFirst = false; return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Busy' }) }); }
          await uploadHeld;
          return r.continue();
        });
        await page.setInputFiles('input[type="file"][multiple]', [
          { name: 'image.jpg', mimeType: 'image/png', buffer: PNG_WIDE },
          { name: 'image.jpg', mimeType: 'image/png', buffer: PNG_TALL },
        ]);
        await page.locator('.upload-progress__row.is-error', { hasText: 'Photo 1 of 2 · image.jpg' }).waitFor();
        await page.locator('.upload-progress__row', { hasText: 'Photo 2 of 2 · image.jpg' }).getByText('Uploading…').waitFor();
        const alt2 = page.getByLabel('Photo 2: what it shows');
        await alt2.click();
        await alt2.pressSequentially('Gallery wall');
        releaseUpload();
        await page.locator('.photo-row').nth(2).waitFor();
        await alt2.pressSequentially(' at dusk');
        assert.equal(await page.evaluate(() => document.activeElement?.id), await alt2.getAttribute('id'), 'focus stays in the description');
        assert.equal(await alt2.inputValue(), 'Gallery wall at dusk');
        assert.equal(createdImages().length, 3);
        await page.getByRole('button', { name: 'Try that photo again' }).click();
        await page.locator('.upload-progress__row.is-done', { hasText: 'Photo 1 of 1 · image.jpg' }).waitFor({ timeout: 15000 });
        await page.locator('.photo-row').nth(3).waitFor();
        assert.equal(createdImages().length, 4);
        assert.equal(await page.getByRole('button', { name: /Try .* again/ }).count(), 0);
        await page.unroute('**/api/admin/media');
        await shot('artwork-photos-retried');
      }
      await page.click('button:has-text("Save changes")');
      await page.getByText('Saved. The website updates within a minute.').first().waitFor();
      await heading('Artworks').waitFor();
      const savedArt = db.artworks.find((a) => a.id === created.id);
      assert.deepEqual(
        [savedArt.artist, savedArt.year, savedArt.medium, savedArt.dimensions, savedArt.event_id, savedArt.price, savedArt.price_display, savedArt.status, savedArt.featured, savedArt.published],
        ['Jordan Avery', '2026', 'Oil on linen', '30 × 40 in.', 801, 2400, 'show', 'available', 1, 1]);
      assert.equal(createdImages()[0].alt, 'Close-up of the brushwork on the wet street');
      if (name === 'phone') assert.equal(createdImages()[1].alt, 'Gallery wall at dusk');
      // Mark sold from the card, undo, then sell it for good.
      const card = page.locator('.art-card', { hasText: artTitle });
      await card.getByText('$2,400').waitFor();
      await card.getByRole('button', { name: /^Mark sold/ }).click();
      await page.getByText(`"${artTitle}" is now sold.`).waitFor();
      assert.equal(db.artworks.find((a) => a.id === created.id).status, 'sold');
      await card.getByText('No price shown').waitFor();
      await shot('artworks-sold', { keepToast: true });
      await page.getByRole('button', { name: 'Undo' }).click();
      await card.getByRole('button', { name: /^Mark sold/ }).waitFor();
      assert.equal(db.artworks.find((a) => a.id === created.id).status, 'available');
      await card.getByRole('button', { name: /^Mark sold/ }).click();
      await card.getByRole('button', { name: /^Mark available/ }).waitFor();
      assert.equal(db.artworks.find((a) => a.id === created.id).status, 'sold');
      // Up moves it one place earlier, saves the whole order, and keeps the focus on the button.
      const blancOrder = () => blancArt().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((a) => a.id);
      const orderBefore = blancOrder();
      await page.getByRole('button', { name: `Move ${artTitle} up` }).click();
      await until(() => blancOrder().indexOf(created.id) === orderBefore.indexOf(created.id) - 1, 'the artwork reorder');
      await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, `Move ${artTitle} up`);
      // Filters: exhibition, "Not in a show", search.
      const cardTitles = async () => (await page.locator('.art-card__title a').allTextContents()).sort();
      await page.selectOption('select[name="event"]', '801');
      await page.getByText(/showing \d+/).waitFor();
      assert.deepEqual(await cardTitles(), blancArt().filter((a) => a.event_id === 801).map((a) => a.title).sort());
      assert.ok((await cardTitles()).includes(artTitle));
      await shot('artworks-filtered');
      await page.selectOption('select[name="event"]', 'none');
      await page.locator('.art-card', { hasText: 'Study in Blue' }).waitFor();
      assert.deepEqual(await cardTitles(), ['Study in Blue']);
      await page.selectOption('select[name="event"]', 'all');
      await page.fill('input[name="q"]', 'hale');
      await page.locator('.art-card', { hasText: 'Raised In It, No. 3' }).waitFor();
      assert.deepEqual(await cardTitles(), ['Raised In It, No. 3']);
      await page.locator('button', { hasText: 'Clear filters' }).first().click();
      await page.locator('.art-card', { hasText: 'Untitled (Family Portrait)' }).waitFor();
      assert.equal(await page.locator('.art-card').count(), blancArt().length);

      if (name === 'desktop') {
        // Without photo storage the form takes a photo link instead; removing a photo asks first.
        db.mediaConfigured = false;
        await page.reload();
        await heading('Artworks').waitFor();
        await page.locator('.art-card__title a', { hasText: artTitle }).click();
        await heading(artTitle).waitFor();
        await page.getByText('Photo uploads are not set up on the server yet', { exact: false }).first().waitFor();
        assert.equal(await page.locator('input[type="file"]').count(), 0);
        await page.fill('input[name="photo_link"]', '/api/media/uploads/blanc/seed-901-full.png');
        await page.click('button:has-text("Add photo")');
        await page.getByText('Photo added.').waitFor();
        assert.equal(createdImages().length, 3);
        await shot('artwork-photo-link');
        await page.locator('.photo-row').nth(2).getByRole('button', { name: /^Remove/ }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
        await page.getByText('Photo removed.').waitFor();
        assert.equal(createdImages().length, 2);
        db.mediaConfigured = true;
        // Delete asks first, then goes back to the list.
        await page.click('button:has-text("Delete")');
        await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
        await page.getByText('Artwork deleted.').waitFor();
        await heading('Artworks').waitFor();
        assert.equal(db.artworks.some((a) => a.id === created.id), false);
        await page.reload(); // pick up media_configured again
        await heading('Artworks').waitFor();
      }
      await page.selectOption('#business-select', 'peachs');
      await heading("Peach's on 47th").waitFor();

      // --- AI usage card (owners and admins) on the Overview ---
      await page.getByText('AI usage this month').waitFor();
      await page.getByText('$1.23').waitFor();

      // --- Assistant: open from the top bar, ask, watch it work, the draft card, preview, Publish, live check, Undo ---
      await page.click('#assist-toggle');
      const panel = page.locator('#assist');
      await panel.getByRole('heading', { name: 'What should we change?' }).waitFor();
      assert.equal(await page.getAttribute('#assist-toggle', 'aria-expanded'), 'true');
      if (name === 'phone') {
        // A full-screen sheet: the page behind it cannot be reached by keyboard or screen reader.
        assert.equal(await page.locator('#app > .frame[inert]').count(), 1);
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'assist-title');
      } else {
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'assist-input');
        const box = await panel.boundingBox();
        assert.ok(box.x >= 1440 - 421 && box.width <= 421, `panel on the right ${JSON.stringify(box)}`);
        assert.ok((await page.locator('#main').boundingBox()).x + (await page.locator('#main').boundingBox()).width <= box.x + 1, 'the page stays beside the panel');
      }
      await shot('assistant-welcome', { full: false });
      await panel.getByRole('button', { name: 'Close early this Friday at noon' }).click();
      assert.equal(await page.inputValue('#assist-input'), 'Close early this Friday at noon');
      await page.fill('#assist-input', "Close Peach's early this Friday at noon");
      if (name === 'desktop') {
        // A photo for the Assistant to read is shrunk to a JPEG of at most 1600 px first.
        await page.setInputFiles('#assist-photo', { name: 'menu-board.png', mimeType: 'image/png', buffer: PNG_WIDE });
        await panel.locator('.assist__attachment img').waitFor();
      }
      await panel.getByRole('button', { name: 'Send' }).click();
      await panel.locator('.msg--user', { hasText: "Close Peach's early this Friday at noon" }).waitFor();
      await panel.locator('.msg__tool', { hasText: "Looking at the details and hours for Peach's" }).waitFor();
      const draftCard = panel.locator('.draft').last();
      await draftCard.getByText('Special hours on Friday, October 16').waitFor();
      await draftCard.getByText('8 am – 12 pm').waitFor();
      await draftCard.getByText('Checked: nothing unusual.').waitFor();
      await panel.getByText('Nothing is live until you tap Publish.').waitFor(); // the streamed reply
      const conv = db.conversations[db.conversations.length - 1];
      const draftId = [...db.changeSets.values()].pop().id;
      assert.equal(conv.business_slug, 'peachs');
      if (name === 'desktop') {
        assert.equal(db.lastImages.length, 1);
        const sent = imageSize(Buffer.from(db.lastImages[0].data_base64, 'base64'));
        assert.deepEqual([sent.format, sent.width, sent.height], ['jpeg', 1600, 1067]);
        assert.equal(await panel.locator('.assist__attachment').count(), 0, 'sent photos leave the composer');
      }
      const previewHref = await draftCard.getByRole('link', { name: /Preview the Peach's website/ }).getAttribute('href');
      assert.equal(previewHref, `${base}/peachs.html?preview=${draftId}`);
      assert.equal(await draftCard.getByRole('link', { name: /TV screen/ }).getAttribute('target'), '_blank');
      await draftCard.getByRole('button', { name: /Copy preview link/ }).waitFor();
      await shot('assistant-draft', { full: false });
      await draftCard.getByRole('button', { name: 'Publish' }).click();
      await page.getByRole('dialog', { name: 'Publish this change?' }).getByRole('button', { name: 'Publish' }).click();
      await draftCard.getByText('Checked: it is all live.').waitFor();
      await panel.getByText('Friday’s early closing is now live.').waitFor(); // the follow-up turn after publishing
      assert.equal(db.changeSets.get(draftId).status, 'published');
      await shot('assistant-published', { full: false });
      await draftCard.getByRole('button', { name: 'Undo' }).click();
      await page.getByRole('dialog', { name: 'Undo this change?' }).getByRole('button', { name: 'Undo' }).click();
      await draftCard.getByText('These changes were undone').waitFor();
      assert.equal(db.changeSets.get(draftId).status, 'undone');

      if (name === 'desktop') {
        // A blocking check keeps Publish off; Discard asks first.
        await page.fill('#assist-input', 'Put up a notice until yesterday');
        await page.keyboard.press('Enter');
        const blocked = panel.locator('.draft', { hasText: 'Notice until yesterday' });
        await blocked.getByText('Must fix:').waitFor();
        assert.equal(await blocked.getByRole('button', { name: 'Publish' }).isDisabled(), true);
        await blocked.getByText('Publish is off until').waitFor();
        await shot('assistant-blocked', { full: false });
        await blocked.getByRole('button', { name: 'Discard' }).click();
        await page.getByRole('dialog', { name: 'Discard this draft?' }).getByRole('button', { name: 'Discard' }).click();
        await blocked.getByText('Discarded. Nothing was changed.').waitFor();
        // The daily limit: said plainly, and the words stay in the box.
        await page.fill('#assist-input', 'Over the daily limit now');
        await panel.getByRole('button', { name: 'Send' }).click();
        await panel.getByText("You have used today's 60 Assistant messages.", { exact: false }).waitFor();
        assert.equal(await page.inputValue('#assist-input'), 'Over the daily limit now');
        await page.fill('#assist-input', '');
        // The chat list, and reopening a chat with its draft card.
        await panel.getByRole('button', { name: 'Chats' }).click();
        await panel.getByRole('heading', { name: 'Your chats' }).waitFor();
        await shot('assistant-chats', { full: false });
        await panel.locator('.assist__chat', { hasText: "Close Peach's early" }).first().click();
        await panel.locator('.draft', { hasText: 'Close early Friday' }).getByText('These changes were undone').waitFor();
        assert.equal(await panel.locator('.draft').count(), 2);
      }
      await panel.getByRole('button', { name: 'Close the Assistant' }).click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'assist-toggle');
      assert.equal(await page.locator('[inert]').count(), 0);

      // --- A draft link from the Claude app: the same card on a page of its own; Publish there ---
      const linked = fakeDraft(null, 'Close early');
      linked.source = 'mcp';
      await page.evaluate((id) => { location.hash = `#/draft/${id}`; }, linked.id);
      await heading('Review a draft').waitFor();
      await page.getByText('A draft made in the Claude app.', { exact: false }).waitFor();
      const pageCard = page.locator('main .draft');
      await pageCard.getByRole('heading', { level: 2, name: 'Close early Friday' }).waitFor();
      assert.equal(await page.locator('.sidenav__link', { hasText: 'Review a draft' }).count(), 0, 'not in the nav');
      await shot('draft-page');
      await pageCard.getByRole('button', { name: 'Publish' }).click();
      await page.getByRole('dialog', { name: 'Publish this change?' }).getByRole('button', { name: 'Publish' }).click();
      await pageCard.getByText('tell Claude you published it', { exact: false }).waitFor();
      assert.equal(db.changeSets.get(linked.id).status, 'published');

      // --- Photos: albums, two photos into "Food", move one to "Team", edit, delete, in-use refusal ---
      await nav('photos');
      await heading('Photos').waitFor();
      await page.locator('.photo-tile', { hasText: 'Saturday brunch table' }).waitFor();
      await page.locator('.album-chip', { hasText: 'Food' }).click();
      await page.waitForFunction(() => document.querySelector('.album-chip[aria-pressed="true"]')?.textContent.startsWith('Food'));
      assert.equal(await page.inputValue('select[name="upload_album"]'), '61'); // new photos go in the album on screen
      const libraryBefore = db.library.length;
      const uploadsBefore2 = db.uploads.length;
      await page.fill('input[name="upload_note"]', `Fried catfish special (${name})`);
      await page.setInputFiles('.upload-card input[type="file"]', [
        { name: 'catfish.png', mimeType: 'image/png', buffer: PNG_WIDE },
        { name: 'catfish-close.png', mimeType: 'image/png', buffer: PNG_TALL },
      ]);
      await page.getByText('2 photos added to “Food”.').waitFor({ timeout: 15000 });
      const added = db.library.slice(libraryBefore);
      assert.equal(added.length, 2);
      assert.deepEqual(db.uploads.slice(uploadsBefore2).map((u) => u.variant), ['full', 'thumb', 'full', 'thumb']);
      for (const p of added) {
        assert.equal(p.album_id, 61);
        assert.equal(p.note, `Fried catfish special (${name})`);
        assert.ok(p.r2_key && p.url.endsWith(p.r2_key) && p.thumb_r2_key && p.thumb_url.endsWith(p.thumb_r2_key), 'file keys are recorded');
        assert.ok(p.width && p.height && p.bytes > 0);
      }
      await page.locator('.photo-tile', { hasText: `Fried catfish special (${name})` }).nth(1).waitFor();
      await shot('photos');
      // Tick one, move it to "Team".
      await page.locator('.photo-tile').first().locator('input[type="checkbox"]').check();
      await page.locator('.select-bar').getByText('1 photo selected').waitFor();
      await page.selectOption('.select-bar select', 'album:63');
      await shot('photos-selected', { full: false });
      await page.locator('.select-bar').getByRole('button', { name: 'Move' }).click();
      await page.getByText('Moved 1 photo to “Team”.').waitFor();
      assert.equal(db.library.find((p) => p.id === added[1].id).album_id, 63);
      // Edit the other one's note, then delete it.
      await page.locator('.photo-tile', { hasText: `Fried catfish special (${name})` }).getByRole('button', { name: /^Edit/ }).click();
      const photoDialog = page.locator('dialog.dialog--photo');
      await photoDialog.getByLabel('Note').fill(`Catfish plate (${name})`);
      await photoDialog.getByLabel('Description').fill('Fried catfish with greens and grits');
      await shot('photo-dialog', { full: false });
      await photoDialog.getByRole('button', { name: 'Save' }).click();
      await page.getByText('Photo saved.').waitFor();
      assert.equal(db.library.find((p) => p.id === added[0].id).alt, 'Fried catfish with greens and grits');
      await page.locator('.photo-tile', { hasText: `Catfish plate (${name})` }).getByRole('button', { name: /^Edit/ }).click();
      await photoDialog.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: 'Delete this photo?' }).getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Photo deleted.').waitFor();
      assert.equal(db.library.some((p) => p.id === added[0].id), false);
      // A photo an event uses: the delete is refused and says where (with a link to the event).
      await page.locator('.album-chip', { hasText: 'All photos' }).click();
      await page.locator('.photo-tile', { hasText: 'Saturday brunch table' }).getByRole('button', { name: /^Edit/ }).click();
      await photoDialog.getByText(`Event: ${db.events[0].title}`).first().waitFor();
      await photoDialog.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: 'Delete this photo?' }).getByRole('button', { name: 'Delete' }).click();
      await photoDialog.getByRole('alert').getByText('Take it off there first', { exact: false }).waitFor();
      assert.ok(db.library.some((p) => p.id === 71));
      await photoDialog.getByRole('button', { name: 'Cancel' }).click();
      if (name === 'phone') {
        // Albums: add one, rename it, delete it (its photos stay).
        await page.getByRole('button', { name: 'New album' }).click();
        await page.getByRole('dialog', { name: 'New album' }).getByLabel('Album name').fill('Specials');
        await page.getByRole('dialog', { name: 'New album' }).getByRole('button', { name: 'Add album' }).click();
        await page.getByText('Album “Specials” added.').waitFor();
        await page.getByRole('button', { name: /^Rename album/ }).click();
        await page.getByRole('dialog', { name: 'Rename album' }).getByLabel('Album name').fill('Daily specials');
        await page.getByRole('dialog', { name: 'Rename album' }).getByRole('button', { name: 'Rename' }).click();
        await page.locator('.album-chip', { hasText: 'Daily specials' }).waitFor();
        await page.getByRole('button', { name: /^Delete album/ }).click();
        await page.getByRole('dialog', { name: 'Delete the album “Daily specials”?' }).getByRole('button', { name: 'Delete album' }).click();
        await page.getByText('Album “Daily specials” deleted.').waitFor();
        assert.equal(db.albums.some((a) => a.name === 'Daily specials'), false);
      }
      // Search
      await page.fill('input[name="q"]', 'brunch');
      await page.getByText('shown here').waitFor();
      assert.deepEqual(await page.locator('.photo-tile__note').allTextContents(), ['Saturday brunch table']);
      await page.fill('input[name="q"]', '');

      // --- "Choose from library" in a photo field (an event): the photo's link lands in the field ---
      await nav('events');
      await heading('Events').waitFor();
      await page.locator('a.btn', { hasText: 'Add event' }).first().click();
      await heading('Add an event').waitFor();
      await page.getByRole('button', { name: 'Choose from library' }).click();
      const pickerDialog = page.getByRole('dialog', { name: 'Choose a photo' });
      await pickerDialog.locator('.picker__photo', { hasText: 'Saturday brunch table' }).waitFor();
      await shot('library-picker', { full: false });
      await pickerDialog.locator('.picker__photo', { hasText: 'Saturday brunch table' }).click();
      await page.getByText('Photo chosen from the library.').waitFor();
      assert.equal(await page.inputValue('input[name="image_url"]'), db.library.find((p) => p.id === 71).url);
      await page.fill('input[name="title"]', `Library photo event (${name})`);
      await page.fill('input[name="start_date"]', '2026-12-12');
      await page.click('button:has-text("Add event")');
      await toastSaved();
      assert.equal(db.events.find((e) => e.title === `Library photo event (${name})`).image_url, db.library.find((p) => p.id === 71).url);

      // --- TV screens: add one, it reports in, scene switches, refresh all ---
      await nav('screens');
      await heading('TV screens').waitFor();
      if (name === 'phone') await page.getByText('No TV screens yet').waitFor();
      await page.getByRole('button', { name: 'Add screen' }).click();
      await page.fill('input[name="name"]', `Counter (${name})`);
      await page.getByRole('form', { name: 'Add a TV screen' }).getByRole('button', { name: 'Add screen' }).click();
      const screenCard = page.locator('.screen-card', { hasText: `Counter (${name})` });
      await screenCard.getByText('Not connected yet').waitFor();
      const created2 = db.screens.find((s) => s.name === `Counter (${name})`);
      assert.match(await screenCard.locator('input.copy-field__input').inputValue(), new RegExp(`/signage/live\\.html\\?business=peachs&screen=${created2.id}$`));
      // The mini preview is the TV page without ?screen=, loaded once it is on screen.
      await page.waitForFunction((id) => document.querySelector(`[data-screen="${id}"] iframe`)?.getAttribute('src')?.includes('/signage/live.html?business=peachs'), created2.id);
      assert.equal((await screenCard.locator('iframe').getAttribute('src')).includes('screen='), false);
      created2.last_seen_at = new Date().toISOString(); // as if the TV had just sent its heartbeat
      await page.getByRole('button', { name: 'Check again' }).click();
      await screenCard.getByText('Online').waitFor();
      await screenCard.getByText('last seen just now').waitFor();
      await page.locator('label.switch', { hasText: 'Catering' }).click();
      await page.fill('input[name="seconds_per_scene"]', '12');
      await page.click('button:has-text("Save screen settings")');
      await page.getByText('Saved. The screens show it within a few minutes', { exact: false }).waitFor();
      assert.equal(db.settings['signage:peachs'].scenes.catering, name === 'desktop'); // phone switched it off, desktop on again
      assert.equal(db.settings['signage:peachs'].seconds_per_scene, 12);
      const versionBefore = db.settings['signage:peachs'].refresh_version || 0;
      await page.getByRole('button', { name: 'Refresh all screens now' }).click();
      await page.getByText('Asked every screen to reload.', { exact: false }).waitFor();
      assert.equal(db.settings['signage:peachs'].refresh_version, versionBefore + 1);
      await page.waitForTimeout(600); // let the mini preview paint
      await shot('screens');

      // --- Account: the Claude app connector and connected apps ---
      await nav('account');
      await heading('Account').waitFor();
      await page.getByText('Connector address', { exact: true }).waitFor();
      assert.equal(await page.locator('input.copy-field__input').inputValue(), `${base}/mcp`);
      if (name === 'phone') {
        await page.locator('.list__row', { hasText: 'claude.ai' }).waitFor();
        await shot('account');
        await page.getByRole('button', { name: /^Disconnect/ }).click();
        await page.getByRole('dialog', { name: 'Disconnect Claude?' }).getByRole('button', { name: 'Disconnect' }).click();
        await page.getByText('Nothing connected yet.').waitFor();
        assert.equal(db.connectedApps.length, 0);
      } else {
        await shot('account');
      }

      // --- Not switched on (no API key): the panel says so plainly ---
      if (name === 'phone') {
        db.assistantConfigured = false;
        await page.reload();
        await heading('Account').waitFor();
        await page.click('#assist-toggle');
        await panel.getByRole('heading', { name: 'The Assistant is not switched on yet' }).waitFor();
        assert.equal(await panel.locator('.assist__composer').isHidden(), true);
        await shot('assistant-off', { full: false });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
        db.assistantConfigured = true;
        await page.reload();
        await heading('Account').waitFor();
      }
      await nav('overview');
      await heading("Peach's on 47th").waitFor();

      if (name === 'desktop') {
        // --- Add an editor, sign out, sign in as them: they must change the temporary password first ---
        await nav('users');
        await page.locator('a.btn', { hasText: 'Add user' }).click();
        await page.fill('input[name="email"]', 'editor@example.com');
        await page.fill('input[name="name"]', 'Jordan Park');
        await page.check('input[name="biz-peachs"]');
        await page.fill('input[name="password"]', 'temporary-1234');
        await shot('add-user');
        await page.click('button:has-text("Add user")');
        await page.getByText('Jordan Park').first().waitFor();
        assert.deepEqual(db.users.find((u) => u.email === 'editor@example.com').businesses, ['peachs']);
        await nav('account');
        await page.click('button:has-text("Sign out")');
        await heading('Sign in').waitFor();
        await page.fill('input[name="email"]', 'editor@example.com');
        await page.fill('input[name="password"]', 'temporary-1234');
        await page.click('button:has-text("Sign in")');
        await heading('Account').waitFor();
        await page.getByText('Please choose a new password').waitFor();
        await shot('must-change-password');
        await page.fill('input[name="current_password"]', 'temporary-1234');
        await page.fill('input[name="new_password"]', 'my own password now');
        await page.fill('input[name="confirm"]', 'my own password now');
        await page.click('button:has-text("Change password")');
        await heading("Peach's on 47th").waitFor();
        assert.equal(await page.locator('[data-nav="users"]').count(), 0); // editors do not see Users
        assert.equal(await page.locator('[data-nav="artworks"]').count(), 0); // nor Artworks: Peach's has no catalog
        assert.equal(await page.locator('#business-select option').count(), 1);
      }

      await context.close();
    }
  } catch (err) {
    // Keep a picture of where it went wrong.
    if (lastPage) await lastPage.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
    if (problems.length) console.error('Problems so far:\n' + problems.join('\n'));
    throw err;
  } finally {
    await browser.close();
    server.close();
  }

  const bad = apiCalls.filter((c) => c.method === 'GET' && /\/api\/admin\/(?!businesses$)/.test(c.path) && !c.path.includes('/'));
  assert.equal(bad.length, 0);
  if (problems.length) {
    console.error('Problems:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log(`OK: ${apiCalls.length} API calls, ${shots} screenshots in ${OUT}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
