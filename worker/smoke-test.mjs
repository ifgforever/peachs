#!/usr/bin/env node
// Rome's Joy admin: end-to-end smoke test against a running local server.
//   npx wrangler dev --local --port 8787        (in another terminal, after applying worker/schema.sql)
//   node worker/smoke-test.mjs [http://localhost:8787]
// Env: ADMIN_BOOTSTRAP_TOKEN (default local-dev-token), SMOKE_EMAIL / SMOKE_PASSWORD (the owner account it
// creates on an empty database, or logs in with when users already exist), SMOKE_SLUG (a business to use;
// defaults to the first one the owner may edit). Prints PASS/FAIL per step and exits 1 on any failure.
// Form posts carry a random CF-Connecting-IP so repeated runs do not trip the per-IP limit on a local server
// (Cloudflare replaces that header in production, so it has no effect there).
// The artwork steps use the business whose features.artworks is on (Blanc, from the artworks migration).
import { crc32, deflateSync } from 'node:zlib';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');
const BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || 'local-dev-token';
const EMAIL = (process.env.SMOKE_EMAIL || 'smoke-owner@example.com').toLowerCase();
const PASSWORD = process.env.SMOKE_PASSWORD || 'smoke-test-password-1';
const EDITOR_EMAIL = `smoke-editor-${Date.now()}@example.com`;
const EDITOR_PASSWORD = 'smoke-editor-pass-1';
const FORM_IP = { 'CF-Connecting-IP': `198.51.100.${1 + Math.floor(Math.random() * 250)}` };
const OPEN_NOW_RE = /^(Open now · until .+|Closed · opens today .+|Closed · opens (Sun|Mon|Tue|Wed|Thu|Fri|Sat) .+|Closed today)$/;

let token = null;
const results = [];

/* ---------- tiny client ---------- */
async function api(method, path, body, { auth = token, headers = {}, raw = false, redirect = 'manual' } = {}) {
  const init = { method, headers: { ...headers }, redirect };
  if (auth) init.headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  }
  const res = await fetch(`${BASE}${path}`, init);
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: `not JSON: ${text.slice(0, 120)}` }; }
  return { status: res.status, data, headers: res.headers };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const expectStatus = (res, status, what) => expect(res.status === status, `${what}: expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.data)}`);

async function step(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${note ? `  (${note})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** A real width×height RGB PNG (peach coloured), generated so the upload step needs no fixture file. */
function tinyPng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const rowLength = 1 + width * 3; // a filter byte, then the pixels
  const pixels = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([0xf4, 0xa2, 0x61], y * rowLength + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const chicagoToday = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/* ---------- state shared between steps ---------- */
const state = { slug: null, otherSlug: null, originalHours: null, businessEntryId: null, originalTagline: null,
  events: {}, sectionId: null, itemIds: [], announcementIds: [], inquiryId: null, editorId: null, editorToken: null, exceptionId: null,
  artSlug: null, plainSlug: null, artEventId: null, artworkIds: {}, imageIds: [], artEditorId: null, draftShowId: null };

const TEST_HOURS = [
  { weekday: 1, closed: true }, { weekday: 2, closed: true },
  { weekday: 3, closed: false, open_min: 480, close_min: 840 }, { weekday: 4, closed: false, open_min: 480, close_min: 840 },
  { weekday: 5, closed: false, open_min: 480, close_min: 840 }, { weekday: 6, closed: false, open_min: 480, close_min: 900 },
  { weekday: 0, closed: false, open_min: 480, close_min: 840 },
];

/* =========================================================================
   Steps
   ========================================================================= */
await step('GET /api/auth/status', async () => {
  const res = await api('GET', '/api/auth/status');
  expectStatus(res, 200, 'status');
  expect(typeof res.data.has_users === 'boolean' && 'email_configured' in res.data && 'media_configured' in res.data, 'status shape');
  state.hasUsers = res.data.has_users;
  return `has_users=${res.data.has_users}`;
});

await step('Unknown API path is a JSON 404', async () => {
  const res = await api('GET', '/api/nothing/here');
  expectStatus(res, 404, '404');
  expect(res.data.code === 'not_found', 'code not_found');
});

await step('CORS preflight on a public route', async () => {
  const res = await api('OPTIONS', '/api/public/businesses', undefined, { raw: true, headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' } });
  expect(res.status === 204, `expected 204, got ${res.status}`);
  expect(res.headers.get('access-control-allow-origin') === '*', 'public ACAO *');
  const adminRes = await api('OPTIONS', '/api/admin/businesses', undefined, { raw: true, headers: { Origin: 'https://admin.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  expect(adminRes.headers.get('access-control-allow-origin') === 'https://admin.example.com', 'admin ACAO echoes origin');
  expect(/authorization/i.test(adminRes.headers.get('access-control-allow-headers') || ''), 'admin allows Authorization header');
});

await step(state.hasUsers ? 'POST /api/auth/login (users already exist)' : 'POST /api/auth/bootstrap (first owner)', async () => {
  if (!state.hasUsers) {
    const bad = await api('POST', '/api/auth/bootstrap', { token: 'wrong-token', email: EMAIL, password: PASSWORD, name: 'Smoke Owner' });
    expectStatus(bad, 403, 'wrong bootstrap token');
    // Guessing is capped per IP: five wrong tokens from one address, then 429 (a different address is still fine).
    const guesser = { 'CF-Connecting-IP': '203.0.113.77' };
    for (let i = 0; i < 5; i++) await api('POST', '/api/auth/bootstrap', { token: `guess-${i}`, email: EMAIL, password: PASSWORD }, { headers: guesser });
    const capped = await api('POST', '/api/auth/bootstrap', { token: BOOTSTRAP_TOKEN, email: EMAIL, password: PASSWORD }, { headers: guesser });
    expectStatus(capped, 429, 'bootstrap guesses capped per IP');
    const res = await api('POST', '/api/auth/bootstrap', { token: BOOTSTRAP_TOKEN, email: EMAIL, password: PASSWORD, name: 'Smoke Owner' });
    expectStatus(res, 200, 'bootstrap');
    expect(res.data.token && res.data.user?.role === 'owner', 'bootstrap returns token + owner');
    token = res.data.token;
    const again = await api('POST', '/api/auth/bootstrap', { token: BOOTSTRAP_TOKEN, email: 'x@example.com', password: PASSWORD }, { auth: null });
    expectStatus(again, 403, 'bootstrap twice');
  } else {
    const res = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    expectStatus(res, 200, `login as ${EMAIL} (set SMOKE_EMAIL / SMOKE_PASSWORD)`);
    expect(res.data.token && res.data.user, 'login returns token + user');
    token = res.data.token;
  }
  const wrong = await api('POST', '/api/auth/login', { email: EMAIL, password: 'definitely-wrong' }, { auth: null });
  expectStatus(wrong, 401, 'wrong password');
});

await step('GET /api/auth/me', async () => {
  const res = await api('GET', '/api/auth/me');
  expectStatus(res, 200, 'me');
  expect(res.data.user.email === EMAIL, `me.email is ${res.data.user.email}`);
  expect(Array.isArray(res.data.user.businesses), 'me.businesses is an array');
  state.role = res.data.user.role;
  const noAuth = await api('GET', '/api/auth/me', undefined, { auth: null });
  expectStatus(noAuth, 401, 'me without token');
  return `${res.data.user.role}`;
});

await step('GET /api/admin/businesses (pick a slug)', async () => {
  const res = await api('GET', '/api/admin/businesses');
  expectStatus(res, 200, 'businesses');
  const list = res.data.businesses;
  expect(list.length > 0, 'No businesses in the database. Seed one first (wrangler d1 execute ... --command "INSERT INTO businesses ...").');
  const wanted = process.env.SMOKE_SLUG;
  const chosen = wanted ? list.find((b) => b.slug === wanted) : list[0];
  expect(chosen, `SMOKE_SLUG ${wanted} is not a business this user may edit`);
  state.slug = chosen.slug;
  state.otherSlug = list.find((b) => b.slug !== chosen.slug)?.slug || null;
  expect(typeof chosen.hours_summary === 'string' && chosen.counts && 'new_inquiries' in chosen.counts, 'list rows carry hours_summary + counts');
  expect(Number.isInteger(chosen.counts.upcoming_events) && Number.isInteger(chosen.counts.current_events), 'event counts are numbers');
  return `${state.slug}${state.otherSlug ? `, other=${state.otherSlug}` : ''}`;
});

await step('PATCH /api/admin/businesses/:slug', async () => {
  const before = await api('GET', `/api/admin/businesses/${state.slug}`);
  expectStatus(before, 200, 'detail');
  expect(before.data.hours.length === 7 && before.data.hours[0].weekday === 1, 'detail has 7 hours rows, Monday first');
  state.originalTagline = before.data.business.tagline;
  state.originalHours = before.data.hours.map((h) => ({ weekday: h.weekday, closed: h.closed, open_min: h.open_min, close_min: h.close_min }));
  const tagline = `Smoke test ${Date.now()}`;
  const res = await api('PATCH', `/api/admin/businesses/${state.slug}`, { tagline, website_url: 'not a url' });
  expectStatus(res, 400, 'bad URL rejected');
  const ok = await api('PATCH', `/api/admin/businesses/${state.slug}`, { tagline });
  expectStatus(ok, 200, 'patch');
  expect(ok.data.business.tagline === tagline, 'tagline saved');
  state.tagline = tagline;
});

await step('PUT hours and read them back', async () => {
  const bad = await api('PUT', `/api/admin/businesses/${state.slug}/hours`, { hours: TEST_HOURS.map((h) => (h.weekday === 3 ? { ...h, open_min: 900, close_min: 480 } : h)) });
  expectStatus(bad, 400, 'open after close rejected');
  const res = await api('PUT', `/api/admin/businesses/${state.slug}/hours`, { hours: TEST_HOURS });
  expectStatus(res, 200, 'put hours');
  const sat = res.data.hours.find((h) => h.weekday === 6);
  expect(sat.text === '8 am – 3 pm' && sat.open === '8 am' && sat.close === '3 pm', `Saturday text is ${sat.text}`);
  const back = await api('GET', `/api/admin/businesses/${state.slug}`);
  const wed = back.data.hours.find((h) => h.weekday === 3);
  expect(wed.text === '8 am – 2 pm' && back.data.hours.find((h) => h.weekday === 1).text === 'Closed', 'read back');
  const late = await api('PUT', `/api/admin/businesses/${state.slug}/hours`, { hours: TEST_HOURS.map((h) => (h.weekday === 5 ? { ...h, close_min: 1440 } : h)) });
  expectStatus(late, 200, 'closing at midnight (1440)');
  expect(late.data.hours.find((h) => h.weekday === 5).close_min === 1440, 'midnight close kept');
  const again = await api('PUT', `/api/admin/businesses/${state.slug}/hours`, { hours: TEST_HOURS });
  expectStatus(again, 200, 'put hours back');
});

await step('Hours exception: create, list, delete', async () => {
  const date = chicagoToday(30);
  const res = await api('POST', `/api/admin/businesses/${state.slug}/hours/exceptions`, { date, closed: true, label: 'Smoke holiday' });
  expectStatus(res, 200, 'create exception');
  expect(res.data.exception.text === 'Closed' && res.data.exception.date === date, 'exception shape');
  state.exceptionId = res.data.exception.id;
  const dup = await api('POST', `/api/admin/businesses/${state.slug}/hours/exceptions`, { date, closed: true });
  expectStatus(dup, 409, 'duplicate date');
  const pub = await api('GET', `/api/public/${state.slug}`);
  expect(pub.data.exceptions.some((e) => e.date === date && e.closed === true && e.label === 'Smoke holiday'), 'public bundle lists the exception');
  const del = await api('DELETE', `/api/admin/hours/exceptions/${state.exceptionId}`);
  expectStatus(del, 200, 'delete exception');
});

await step('GET /api/public/:slug reflects hours + open_now shape', async () => {
  const res = await api('GET', `/api/public/${state.slug}`);
  expectStatus(res, 200, 'public bundle');
  const b = res.data;
  expect(res.headers.get('access-control-allow-origin') === '*', 'public CORS *');
  expect(/max-age=60/.test(res.headers.get('cache-control') || ''), 'public cache header');
  expect(b.hours.length === 7 && b.hours[0].weekday === 1 && b.hours[6].weekday === 0, 'hours Monday → Sunday');
  expect(b.hours_summary === 'Wed – Fri & Sun · 8 am – 2 pm · Sat · 8 am – 3 pm', `hours_summary is "${b.hours_summary}"`);
  expect(typeof b.open_now.open === 'boolean' && OPEN_NOW_RE.test(b.open_now.text) && b.open_now.checked_at, `open_now is ${JSON.stringify(b.open_now)}`);
  expect(b.business.slug === state.slug && b.business.tagline === state.tagline && b.business.address && 'formatted' in b.business.address, 'business block');
  expect(/^\d{4}-\d{2}-\d{2}$/.test(b.today.date) && b.dietary.GF === 'Gluten free', 'today + dietary');
  expect(b.events && Array.isArray(b.events.current) && b.menu && Array.isArray(b.menu.sections), 'events + menu shape');
  const list = await api('GET', '/api/public/businesses');
  expectStatus(list, 200, 'public businesses');
  expect(list.data.businesses.some((x) => x.slug === state.slug && x.open_now && typeof x.hours_summary === 'string'), 'public list has the business');
  const missing = await api('GET', '/api/public/no-such-business');
  expectStatus(missing, 404, 'unknown slug');
  return b.open_now.text;
});

await step('GET /api/public/signage/:slug', async () => {
  const res = await api('GET', `/api/public/signage/${state.slug}`);
  expectStatus(res, 200, 'signage');
  expect(res.data.signage && typeof res.data.signage === 'object' && Array.isArray(res.data.family) && res.data.family.length > 0, 'signage + family');
  expect('hours_summary' in res.data.family[0] && 'tagline' in res.data.family[0], 'family rows');
});

await step('Events: create / patch / delete with status buckets', async () => {
  const base = `/api/admin/businesses/${state.slug}/events`;
  const bad = await api('POST', base, { title: 'Backwards', start_date: chicagoToday(5), end_date: chicagoToday(2) });
  expectStatus(bad, 400, 'end before start rejected');
  const noTitle = await api('POST', base, { start_date: chicagoToday(5) });
  expectStatus(noTitle, 400, 'missing title rejected');
  const make = async (title, start, end, extra = {}) => {
    const res = await api('POST', base, { title, start_date: start, end_date: end, ...extra });
    expectStatus(res, 200, `create ${title}`);
    return res.data.event;
  };
  const upcoming = await make('Smoke upcoming', chicagoToday(10), null, { start_time: '17:00', end_time: '20:00', kind: 'exhibition' });
  const current = await make('Smoke current', chicagoToday(-1), chicagoToday(1), { start_time: '11:00', end_time: '15:00' });
  const past = await make('Smoke past', chicagoToday(-10), null, { start_time: '19:00' });
  const hidden = await make('Smoke hidden', chicagoToday(3), null, { published: false });
  state.events = { upcoming: upcoming.id, current: current.id, past: past.id, hidden: hidden.id };
  expect(upcoming.status === 'upcoming' && current.status === 'current' && past.status === 'past', `statuses ${upcoming.status}/${current.status}/${past.status}`);
  expect(upcoming.time_text === '5–8 pm' && current.time_text === '11 am – 3 pm' && past.time_text === '7 pm', `time_text ${upcoming.time_text} / ${current.time_text} / ${past.time_text}`);
  expect(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(upcoming.date_text), `date_text ${upcoming.date_text}`);
  const list = await api('GET', `${base}?status=upcoming`);
  expect(list.data.events.some((e) => e.id === upcoming.id) && list.data.events.some((e) => e.id === hidden.id), 'admin list includes unpublished upcoming');
  const pub = await api('GET', `/api/public/${state.slug}`);
  const ev = pub.data.events;
  expect(ev.upcoming.some((e) => e.id === upcoming.id) && ev.current.some((e) => e.id === current.id) && ev.past.some((e) => e.id === past.id), 'public buckets');
  expect(!JSON.stringify(ev).includes('Smoke hidden'), 'unpublished event is not public');
  const patched = await api('PATCH', `/api/admin/events/${upcoming.id}`, { title: 'Smoke upcoming (renamed)', featured: true });
  expectStatus(patched, 200, 'patch event');
  expect(patched.data.event.title === 'Smoke upcoming (renamed)' && patched.data.event.featured === true, 'patch applied');
  for (const id of Object.values(state.events)) {
    const del = await api('DELETE', `/api/admin/events/${id}`);
    expectStatus(del, 200, `delete event ${id}`);
  }
  const gone = await api('DELETE', `/api/admin/events/${upcoming.id}`);
  expectStatus(gone, 404, 'deleting twice');
});

await step('Menu: section + items + reorder', async () => {
  const sec = await api('POST', `/api/admin/businesses/${state.slug}/menu/sections`, { title: 'Smoke Plates', short_title: 'Smoke' });
  expectStatus(sec, 200, 'create section');
  state.sectionId = sec.data.section.id;
  const a = await api('POST', `/api/admin/menu/sections/${state.sectionId}/items`, { name: 'Smoke Catfish', price: 23, tags: ['GF'], allergens: ['Fish'] });
  const b = await api('POST', `/api/admin/menu/sections/${state.sectionId}/items`, { name: 'Smoke Pancakes', prices: [{ label: 'Short stack', value: 9 }, { label: 'Full stack', value: 12 }], featured: true });
  expectStatus(a, 200, 'item a'); expectStatus(b, 200, 'item b');
  expect(a.data.item.tags[0] === 'GF' && a.data.item.allergens[0] === 'Fish' && a.data.item.price === 23 && a.data.item.prices === null, 'item a parsed');
  expect(b.data.item.prices.length === 2 && b.data.item.price === null && b.data.item.featured === true, 'item b parsed');
  state.itemIds = [a.data.item.id, b.data.item.id];
  const badPrice = await api('POST', `/api/admin/menu/sections/${state.sectionId}/items`, { name: 'Bad', price: 'free' });
  expectStatus(badPrice, 400, 'bad price rejected');
  const re = await api('POST', `/api/admin/businesses/${state.slug}/menu/reorder`, { items: { [state.sectionId]: [b.data.item.id, a.data.item.id] } });
  expectStatus(re, 200, 'reorder');
  const menu = await api('GET', `/api/admin/businesses/${state.slug}/menu`);
  const section = menu.data.sections.find((s) => s.id === state.sectionId);
  expect(section && section.items[0].id === b.data.item.id && section.items[1].id === a.data.item.id, 'reorder applied');
  const pub = await api('GET', `/api/public/${state.slug}`);
  const pubSection = pub.data.menu.sections.find((s) => s.id === state.sectionId);
  expect(pubSection && pubSection.items.length === 2 && pubSection.items[0].name === 'Smoke Pancakes', 'public menu reflects it');
  const hide = await api('PATCH', `/api/admin/menu/items/${a.data.item.id}`, { available: false });
  expectStatus(hide, 200, 'hide item');
  const pub2 = await api('GET', `/api/public/${state.slug}`);
  expect(pub2.data.menu.sections.find((s) => s.id === state.sectionId).items.length === 1, 'unavailable item hidden');
  const foreign = await api('POST', `/api/admin/businesses/${state.slug}/menu/reorder`, { sections: [999999] });
  expectStatus(foreign, 400, 'foreign section rejected');
});

await step('Announcements: business-specific and family-wide', async () => {
  const res = await api('POST', `/api/admin/businesses/${state.slug}/announcements`, { title: 'Smoke announcement', body: 'Hello', ends_at: chicagoToday(7) });
  expectStatus(res, 200, 'create announcement');
  state.announcementIds.push(res.data.announcement.id);
  expect(res.data.announcement.starts_at === chicagoToday(), 'starts today by default');
  const fam = await api('POST', '/api/admin/announcements', { title: 'Smoke family-wide', show_on_tv: true });
  if (state.role === 'editor') expectStatus(fam, 403, 'editor cannot post family-wide');
  else { expectStatus(fam, 200, 'family-wide'); state.announcementIds.push(fam.data.announcement.id); expect(fam.data.announcement.business_slug === null, 'family row has no slug'); }
  const pub = await api('GET', `/api/public/${state.slug}`);
  expect(pub.data.announcements.some((a) => a.title === 'Smoke announcement'), 'public has the announcement');
  if (state.role !== 'editor') expect(pub.data.announcements.some((a) => a.title === 'Smoke family-wide'), 'public has the family-wide one');
  const old = await api('PATCH', `/api/admin/announcements/${state.announcementIds[0]}`, { starts_at: chicagoToday(-3), ends_at: chicagoToday(-1) });
  expectStatus(old, 200, 'expire it');
  const pub2 = await api('GET', `/api/public/${state.slug}`);
  expect(!pub2.data.announcements.some((a) => a.title === 'Smoke announcement'), 'expired announcement hidden');
  const list = await api('GET', `/api/admin/businesses/${state.slug}/announcements`);
  expect(list.data.announcements.some((a) => a.id === state.announcementIds[0]), 'admin list still has it');
});

await step('POST /api/forms (JSON, urlencoded, honeypot, limits)', async () => {
  const countInquiries = async () => (await api('GET', `/api/admin/businesses/${state.slug}/inquiries?status=all&limit=200`)).data.inquiries.length;
  const before = await countInquiries();
  const res = await api('POST', `/api/forms/${state.slug}/contact`, { name: 'Smoke Tester', email: 'smoke@example.com', message: 'Hello from the smoke test', party_size: '6' }, { auth: null, headers: FORM_IP });
  expectStatus(res, 200, 'JSON form');
  expect(res.data.ok === true && Number.isInteger(res.data.id) && typeof res.data.emailed === 'boolean', `form response ${JSON.stringify(res.data)}`);
  expect(res.headers.get('access-control-allow-origin') === '*', 'forms CORS *');
  state.inquiryId = res.data.id;
  const form = new URLSearchParams({ name: 'Form Tester', message: 'Posted from a plain form', _redirect: '/thanks.html' }).toString();
  const enc = await api('POST', `/api/forms/${state.slug}/quote`, form, { auth: null, raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...FORM_IP } });
  expect(enc.status === 303, `urlencoded + _redirect: expected 303, got ${enc.status}`);
  expect((enc.headers.get('location') || '').endsWith('/thanks.html'), `redirect location ${enc.headers.get('location')}`);
  for (const evil of ['/\\evil.example', '//evil.example', 'https://evil.example/']) {
    const body = new URLSearchParams({ message: 'redirect probe', _redirect: evil }).toString();
    const r = await api('POST', `/api/forms/${state.slug}/contact`, body, { auth: null, raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...FORM_IP } });
    expect(r.status === 200 && !r.headers.get('location'), `_redirect=${evil} must not redirect (got ${r.status} ${r.headers.get('location')})`);
  }
  const bot = await api('POST', `/api/forms/${state.slug}/contact`, { message: 'spam', website: 'http://spam.example' }, { auth: null, headers: FORM_IP });
  expectStatus(bot, 200, 'honeypot');
  expect(bot.data.ok === true && bot.data.id === undefined, 'honeypot answers ok without saving');
  const empty = await api('POST', `/api/forms/${state.slug}/contact`, { name: 'Nobody' }, { auth: null, headers: FORM_IP });
  expectStatus(empty, 400, 'no message/email');
  const unknown = await api('POST', '/api/forms/no-such-business/contact', { message: 'x' }, { auth: null, headers: FORM_IP });
  expectStatus(unknown, 404, 'unknown business');
  const long = await api('POST', `/api/forms/${state.slug}/contact`, { message: 'x'.repeat(5001) }, { auth: null, headers: FORM_IP });
  expectStatus(long, 400, 'too long');
  const after = await countInquiries();
  expect(after === before + 5, `expected 5 new inquiries, got ${after - before}`);
});

await step('Inquiries list shows it; mark handled', async () => {
  const res = await api('GET', `/api/admin/businesses/${state.slug}/inquiries?status=new`);
  expectStatus(res, 200, 'inquiries');
  const mine = res.data.inquiries.find((i) => i.id === state.inquiryId);
  expect(mine && mine.name === 'Smoke Tester' && mine.fields.party_size === '6' && mine.status === 'new', 'inquiry row with parsed fields');
  expect(!('ip' in mine), 'visitor IP is not returned');
  const one = await api('GET', `/api/admin/inquiries/${state.inquiryId}`);
  expectStatus(one, 200, 'single inquiry');
  expect(one.data.inquiry.id === state.inquiryId && one.data.inquiry.fields.party_size === '6' && !('ip' in one.data.inquiry), 'single inquiry shape');
  const missing = await api('GET', '/api/admin/inquiries/999999999');
  expectStatus(missing, 404, 'unknown inquiry');
  const patched = await api('PATCH', `/api/admin/inquiries/${state.inquiryId}`, { status: 'handled' });
  expectStatus(patched, 200, 'mark handled');
  expect(patched.data.inquiry.status === 'handled', 'status updated');
  const resend = await api('POST', `/api/admin/inquiries/${state.inquiryId}/resend`);
  expectStatus(resend, 200, 'resend');
  expect(typeof resend.data.emailed === 'boolean', 'resend shape');
  return `emailed=${resend.data.emailed}${resend.data.error ? ` (${resend.data.error})` : ''}`;
});

await step('History list has plain-English entries', async () => {
  const res = await api('GET', `/api/admin/businesses/${state.slug}/history?limit=100`);
  expectStatus(res, 200, 'history');
  const entries = res.data.entries;
  expect(entries.length > 5 && entries.every((e) => e.summary && e.entity && e.action && e.created_at), 'entries shape');
  const hours = entries.find((e) => e.entity === 'hours');
  expect(hours && /^Changed .*hours/.test(hours.summary), `hours summary: ${hours?.summary}`);
  expect(entries.some((e) => e.summary === `Marked inquiry #${state.inquiryId} handled`), 'inquiry summary');
  expect(entries.some((e) => e.summary === "Added menu section 'Smoke Plates'"), 'menu section summary');
  const biz = entries.find((e) => e.entity === 'business' && e.action === 'update' && e.can_restore);
  expect(biz, 'business update entry exists');
  state.businessEntryId = biz.id;
  const detail = await api('GET', `/api/admin/history/${biz.id}`);
  expectStatus(detail, 200, 'history detail');
  expect(detail.data.entry.before && detail.data.entry.after && detail.data.entry.after.tagline === state.tagline, 'detail has before/after');
  return biz.summary;
});

await step('Restore an update', async () => {
  const res = await api('POST', `/api/admin/history/${state.businessEntryId}/restore`);
  expectStatus(res, 200, 'restore');
  const biz = await api('GET', `/api/admin/businesses/${state.slug}`);
  expect(biz.data.business.tagline === state.originalTagline, `tagline back to ${JSON.stringify(state.originalTagline)}`);
  const hist = await api('GET', `/api/admin/businesses/${state.slug}/history?limit=5`);
  expect(hist.data.entries[0].action === 'restore' && hist.data.entries[0].can_restore === false, 'restore entry written');
  // A deleted menu section comes back with its items.
  const del = await api('DELETE', `/api/admin/menu/sections/${state.sectionId}`);
  expectStatus(del, 200, 'delete section');
  const h2 = await api('GET', `/api/admin/businesses/${state.slug}/history?limit=5`);
  const delEntry = h2.data.entries.find((e) => e.entity === 'menu_section' && e.action === 'delete');
  const undo = await api('POST', `/api/admin/history/${delEntry.id}/restore`);
  expectStatus(undo, 200, 'restore deleted section');
  const menu = await api('GET', `/api/admin/businesses/${state.slug}/menu`);
  const section = menu.data.sections.find((s) => s.id === state.sectionId);
  expect(section && section.items.length === 2 && section.items[0].id === state.itemIds[1], 'section and items back with their ids and order');
});

await step('Settings: PUT and GET signage:<slug>', async () => {
  const key = `signage:${state.slug}`;
  const put = await api('PUT', `/api/admin/settings/${key}`, { value: { rotation_seconds: 12, show_menu: true } });
  expectStatus(put, 200, 'put setting');
  const get = await api('GET', `/api/admin/settings/${key}`);
  expect(get.data.value.rotation_seconds === 12, 'setting read back');
  const sig = await api('GET', `/api/public/signage/${state.slug}`);
  expect(sig.data.signage.rotation_seconds === 12, 'signage bundle carries it');
  const unset = await api('GET', '/api/admin/settings/never-set-key');
  expect(JSON.stringify(unset.data.value) === '{}', 'unset → {}');
});

await step('Media upload answers 501 or 200', async () => {
  const fd = new FormData();
  fd.append('business', state.slug);
  fd.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'smoke.png');
  const res = await fetch(`${BASE}/api/admin/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = await res.json();
  expect(res.status === 501 || (res.status === 200 && data.url), `media: ${res.status} ${JSON.stringify(data)}`);
  return res.status === 501 ? 'not configured' : data.url;
});

await step('Users: create an editor who gets 403 elsewhere', async () => {
  if (state.role === 'editor') return 'skipped (logged in as an editor)';
  const editorBusinesses = state.otherSlug ? [state.otherSlug] : [];
  const res = await api('POST', '/api/admin/users', { email: EDITOR_EMAIL, name: 'Smoke Editor', role: 'editor', businesses: editorBusinesses, password: EDITOR_PASSWORD });
  expectStatus(res, 200, 'create editor');
  expect(res.data.user.role === 'editor' && res.data.user.must_change_password === true, 'editor must change password');
  state.editorId = res.data.user.id;
  const weak = await api('POST', '/api/admin/users', { email: 'weak@example.com', role: 'editor', password: 'short' });
  expectStatus(weak, 400, 'weak password rejected');
  const dup = await api('POST', '/api/admin/users', { email: EDITOR_EMAIL, role: 'editor', password: EDITOR_PASSWORD });
  expectStatus(dup, 409, 'duplicate email');
  const login = await api('POST', '/api/auth/login', { email: EDITOR_EMAIL, password: EDITOR_PASSWORD }, { auth: null });
  expectStatus(login, 200, 'editor login');
  state.editorToken = login.data.token;
  const forbidden = await api('GET', `/api/admin/businesses/${state.slug}`, undefined, { auth: state.editorToken });
  expectStatus(forbidden, 403, 'editor on another business');
  const forbiddenWrite = await api('PATCH', `/api/admin/businesses/${state.slug}`, { tagline: 'nope' }, { auth: state.editorToken });
  expectStatus(forbiddenWrite, 403, 'editor write on another business');
  const usersPage = await api('GET', '/api/admin/users', undefined, { auth: state.editorToken });
  expectStatus(usersPage, 403, 'editor cannot list users');
  const family = await api('POST', '/api/admin/announcements', { title: 'nope' }, { auth: state.editorToken });
  expectStatus(family, 403, 'editor cannot post family-wide');
  if (state.otherSlug) {
    const allowed = await api('GET', `/api/admin/businesses/${state.otherSlug}`, undefined, { auth: state.editorToken });
    expectStatus(allowed, 200, 'editor on their own business');
    const list = await api('GET', '/api/admin/businesses', undefined, { auth: state.editorToken });
    expect(list.data.businesses.length === 1 && list.data.businesses[0].slug === state.otherSlug, 'editor sees only their business');
  }
  const change = await api('POST', '/api/auth/change-password', { current_password: EDITOR_PASSWORD, new_password: 'smoke-editor-pass-2' }, { auth: state.editorToken });
  expectStatus(change, 200, 'editor changes password');
  const me = await api('GET', '/api/auth/me', undefined, { auth: state.editorToken });
  expect(me.data.user.must_change_password === false, 'must_change_password cleared');
  const peek = await api('GET', `/api/admin/settings/signage:${state.slug}`, undefined, { auth: state.editorToken });
  expectStatus(peek, 403, 'editor cannot read settings of another business');
  if (state.otherSlug) {
    const own = await api('GET', `/api/admin/settings/signage:${state.otherSlug}`, undefined, { auth: state.editorToken });
    expectStatus(own, 200, 'editor reads their own TV settings');
  }
  // An owner resetting the password ends the editor's sessions; the new password works and must be changed.
  const reset = await api('PATCH', `/api/admin/users/${state.editorId}`, { password: 'smoke-editor-pass-3' });
  expectStatus(reset, 200, 'admin password reset');
  const stale = await api('GET', '/api/auth/me', undefined, { auth: state.editorToken });
  expectStatus(stale, 401, 'old editor token after an admin reset');
  const relogin = await api('POST', '/api/auth/login', { email: EDITOR_EMAIL, password: 'smoke-editor-pass-3' }, { auth: null });
  expectStatus(relogin, 200, 'editor logs in with the reset password');
  expect(relogin.data.user.must_change_password === true, 'reset password must be changed');
  state.editorToken = relogin.data.token;
  const selfDelete = await api('DELETE', `/api/admin/users/${(await api('GET', '/api/auth/me')).data.user.id}`);
  expectStatus(selfDelete, 400, 'cannot delete self');
  return editorBusinesses.length ? `editor limited to ${editorBusinesses[0]}` : 'editor with no businesses';
});

/* ---------- Artwork catalog ---------- */
const artworkIdsIn = (res) => (res.data?.artworks || []).map((a) => a.id);
/** The later artwork steps build on the first one's pieces; fail them with one clear reason when it did not get that far. */
const needCatalog = () => expect(state.artworkIds.portrait, 'needs the pieces from the first artwork step, which failed');

await step('Artworks: feature flag, counts, create tied to an event, filters', async () => {
  const list = await api('GET', '/api/admin/businesses');
  expectStatus(list, 200, 'businesses');
  const rows = list.data.businesses;
  expect(rows.every((b) => b.features && typeof b.features === 'object' && Number.isInteger(b.counts.artworks) && Number.isInteger(b.counts.artworks_available)), 'rows carry features + artwork counts');
  const gallery = rows.find((b) => b.features.artworks === true);
  expect(gallery, 'No business has features.artworks; run worker/migrations/2026-10-13-artworks.sql (it switches Blanc on).');
  state.artSlug = gallery.slug;
  state.plainSlug = rows.find((b) => !b.features.artworks)?.slug || null;
  const ev = await api('POST', `/api/admin/businesses/${state.artSlug}/events`, { title: 'Smoke exhibition', kind: 'exhibition', start_date: chicagoToday(-1), end_date: chicagoToday(20) });
  expectStatus(ev, 200, 'create exhibition');
  state.artEventId = ev.data.event.id;

  const base = `/api/admin/businesses/${state.artSlug}/artworks`;
  expectStatus(await api('POST', base, { artist: 'Nobody' }), 400, 'missing title rejected');
  expectStatus(await api('POST', base, { title: 'Bad price', price: -5 }), 400, 'negative price rejected');
  expectStatus(await api('POST', base, { title: 'Bad display', price_display: 'loud' }), 400, 'unknown price_display rejected');
  expectStatus(await api('POST', base, { title: 'Bad status', status: 'gone' }), 400, 'unknown status rejected');
  expectStatus(await api('POST', base, { title: 'Bad event', event_id: 999999999 }), 400, 'unknown event rejected');
  if (state.plainSlug) {
    const theirs = (await api('GET', `/api/admin/businesses/${state.plainSlug}/events`)).data.events[0];
    if (theirs) expectStatus(await api('POST', base, { title: 'Other event', event_id: theirs.id }), 400, 'event of another business rejected');
  }

  const make = async (body) => {
    const res = await api('POST', base, body);
    expectStatus(res, 200, `create ${body.title}`);
    return res.data.artwork;
  };
  const portrait = await make({ title: 'Smoke Portrait', artist: 'Smoke Artist', year: '2026', medium: 'Archival pigment print', dimensions: '24 × 30 in.', price: 1800, price_display: 'show', event_id: state.artEventId, featured: true });
  const study = await make({ title: 'Smoke Study 100%', price: 950.5, price_display: 'show', event_id: state.artEventId });
  const draft = await make({ title: 'Smoke Draft', published: false });
  state.artworkIds = { portrait: portrait.id, study: study.id, draft: draft.id };
  expect(portrait.event_id === state.artEventId && portrait.event_title === 'Smoke exhibition' && portrait.status === 'available'
    && portrait.featured === true && portrait.published === true && portrait.price === 1800 && Array.isArray(portrait.images) && portrait.images.length === 0, `artwork shape ${JSON.stringify(portrait)}`);
  expect(draft.price_display === 'on_request' && draft.status === 'available' && draft.event_id === null && draft.published === false, 'defaults');

  const ids = state.artworkIds;
  const byEvent = artworkIdsIn(await api('GET', `${base}?event_id=${state.artEventId}`));
  expect(byEvent.includes(ids.portrait) && byEvent.includes(ids.study) && !byEvent.includes(ids.draft), 'event_id filter');
  const loose = artworkIdsIn(await api('GET', `${base}?event_id=none`));
  expect(loose.includes(ids.draft) && !loose.includes(ids.portrait), 'event_id=none filter');
  const search = artworkIdsIn(await api('GET', `${base}?q=${encodeURIComponent('smoke ARTIST')}`));
  expect(search.includes(ids.portrait) && !search.includes(ids.study), 'q matches the artist, case-insensitively');
  const literal = artworkIdsIn(await api('GET', `${base}?q=${encodeURIComponent('y 100%')}`));
  expect(literal.includes(ids.study) && !literal.includes(ids.portrait), 'q matches % literally');
  const wildcard = artworkIdsIn(await api('GET', `${base}?q=${encodeURIComponent('Smoke_')}`));
  expect(!wildcard.some((id) => Object.values(ids).includes(id)), 'q does not treat _ as a wildcard');
  const sold = artworkIdsIn(await api('GET', `${base}?status=sold`));
  expect(!sold.includes(ids.portrait), 'status filter');
  expectStatus(await api('GET', `${base}?status=gone`), 400, 'unknown status filter');

  const after = (await api('GET', '/api/admin/businesses')).data.businesses.find((b) => b.slug === state.artSlug).counts;
  expect(after.artworks === gallery.counts.artworks + 3 && after.artworks_available === gallery.counts.artworks_available + 3, `counts ${JSON.stringify(after)}`);
  return state.artSlug;
});

await step('Artwork images: add 2 by URL, validate, reorder, alt text, at most 12', async () => {
  needCatalog();
  const { portrait, study } = state.artworkIds;
  const add = (id, body) => api('POST', `/api/admin/artworks/${id}/images`, body);
  const a = await add(portrait, { url: 'https://example.com/smoke-a-full.webp', thumb_url: 'https://example.com/smoke-a-thumb.webp', alt: 'Smoke portrait, front', width: 2000, height: 1500 });
  expectStatus(a, 200, 'add image 1');
  const b = await add(portrait, { url: '/api/media/uploads/smoke/b-full.webp', alt: 'Smoke portrait, detail' });
  expectStatus(b, 200, 'add image 2');
  state.imageIds = [a.data.image.id, b.data.image.id];
  expect(a.data.image.width === 2000 && a.data.image.artwork_id === portrait && a.data.image.sort_order < b.data.image.sort_order, 'image shape, appended last');
  // Links are judged the way a browser resolves them: encoded dot segments, "https:host" and "//host" are refused too.
  for (const url of ['http://insecure.example/x.jpg', 'javascript:alert(1)', '/admin/x.jpg', '/api/media/../admin/index.html',
    '/api/media/%2e%2e/%2e%2e/admin/', '/api/media/.%2E/x', 'https:evil.example', '//evil.example/api/media/x', `${BASE}/api/media/%2e%2e/admin/`]) {
    expectStatus(await add(portrait, { url }), 400, `url ${url} rejected`);
  }
  expectStatus(await add(portrait, { alt: 'no link' }), 400, 'missing url');

  const re = await api('POST', `/api/admin/artworks/${portrait}/images/reorder`, { ids: [b.data.image.id, a.data.image.id] });
  expectStatus(re, 200, 'reorder images');
  expectStatus(await api('POST', `/api/admin/artworks/${portrait}/images/reorder`, { ids: [999999999] }), 400, 'foreign image in reorder');
  const alt = await api('PATCH', `/api/admin/artwork-images/${a.data.image.id}`, { alt: 'Smoke portrait, front view' });
  expectStatus(alt, 200, 'edit alt text');
  const got = await api('GET', `/api/admin/artworks/${portrait}`);
  expectStatus(got, 200, 'get artwork');
  const imgs = got.data.artwork.images;
  expect(imgs.length === 2 && imgs[0].id === b.data.image.id && imgs[1].alt === 'Smoke portrait, front view', `images ${JSON.stringify(imgs)}`);

  const order = await api('POST', `/api/admin/businesses/${state.artSlug}/artworks/reorder`, { ids: [study, portrait] });
  expectStatus(order, 200, 'reorder artworks');
  const listed = artworkIdsIn(await api('GET', `/api/admin/businesses/${state.artSlug}/artworks`));
  expect(listed.indexOf(study) < listed.indexOf(portrait), 'admin list follows the new order');
  expectStatus(await api('POST', `/api/admin/businesses/${state.artSlug}/artworks/reorder`, { ids: [999999999] }), 400, 'foreign artwork in reorder');

  for (let i = 1; i <= 12; i++) expectStatus(await add(study, { url: `https://example.com/smoke-study-${i}.webp` }), 200, `study photo ${i}`);
  const thirteenth = await add(study, { url: 'https://example.com/smoke-study-13.webp' });
  expectStatus(thirteenth, 409, 'a 13th photo');
  expect(thirteenth.data.code === 'too_many_images', `code ${thirteenth.data.code}`);
});

await step('Public bundle: artworks, status_text, price_text, artwork_count', async () => {
  needCatalog();
  const { portrait, study, draft } = state.artworkIds;
  const pub = await api('GET', `/api/public/${state.artSlug}`);
  expectStatus(pub, 200, 'public bundle');
  const b = pub.data;
  expect(b.features?.artworks === true && Array.isArray(b.artworks), 'features + artworks');
  const p = b.artworks.find((x) => x.id === portrait);
  const s = b.artworks.find((x) => x.id === study);
  expect(p && s && !b.artworks.some((x) => x.id === draft), 'published pieces only');
  expect(b.artworks.indexOf(p) < b.artworks.indexOf(s), 'featured first');
  expect(p.price === 1800 && p.price_text === '$1,800' && p.status === 'available' && p.status_text === 'Available' && p.event_id === state.artEventId
    && p.artist === 'Smoke Artist' && p.dimensions === '24 × 30 in.' && p.featured === true, `portrait ${JSON.stringify(p)}`);
  expect(s.price_text === '$950.50', `study price_text ${s.price_text}`);
  expect(p.images.length === 2 && p.images[0].id === state.imageIds[1] && p.images[0].thumb_url === p.images[0].url
    && p.images[1].thumb_url === 'https://example.com/smoke-a-thumb.webp' && p.images[1].width === 2000 && p.images[1].height === 1500, `images ${JSON.stringify(p.images)}`);
  expect(!('published' in p) && !('price_display' in p) && !('sort_order' in p.images[0]), 'no admin-only columns');
  const ev = b.events.current.find((e) => e.id === state.artEventId);
  expect(ev && ev.artwork_count === 2, `artwork_count ${ev?.artwork_count}`);
  const sig = await api('GET', `/api/public/signage/${state.artSlug}`);
  expect(sig.data.features?.artworks === true && sig.data.artworks.some((x) => x.id === portrait), 'signage bundle carries features + artworks');
  if (state.plainSlug) {
    const plain = await api('GET', `/api/public/${state.plainSlug}`);
    expect(plain.data.features && !plain.data.features.artworks && !('artworks' in plain.data), 'no catalog where the feature is off');
    expect([...plain.data.events.current, ...plain.data.events.upcoming].every((e) => !('artwork_count' in e)), 'no artwork_count where the feature is off');
  }
});

await step('Price rules: sold hides the price, on request, hidden; audit summaries', async () => {
  needCatalog();
  const { portrait, study } = state.artworkIds;
  const sold = await api('PATCH', `/api/admin/artworks/${portrait}`, { status: 'sold' });
  expectStatus(sold, 200, 'mark sold');
  expect(sold.data.artwork.status === 'sold' && sold.data.artwork.price === 1800, 'the admin still sees the price');
  expectStatus(await api('PATCH', `/api/admin/artworks/${study}`, { price: 1200 }), 200, 'change price');
  expectStatus(await api('PATCH', `/api/admin/artworks/${study}`, { price_display: '' }), 400, 'empty price_display rejected');
  const find = async () => (await api('GET', `/api/public/${state.artSlug}`)).data.artworks;
  let pub = await find();
  const p = pub.find((x) => x.id === portrait);
  expect(p.status_text === 'Sold' && p.price === null && p.price_text === null, `sold piece ${JSON.stringify({ price: p.price, price_text: p.price_text })}`);
  expect(pub.find((x) => x.id === study).price_text === '$1,200', 'new price shows');
  expectStatus(await api('PATCH', `/api/admin/artworks/${study}`, { price_display: 'on_request' }), 200, 'on request');
  pub = await find();
  let s = pub.find((x) => x.id === study);
  expect(s.price_text === 'Price on request' && s.price === null, `on request ${JSON.stringify({ price: s.price, price_text: s.price_text })}`);
  expectStatus(await api('PATCH', `/api/admin/artworks/${study}`, { price_display: 'hidden', status: 'reserved' }), 200, 'hidden + reserved');
  pub = await find();
  s = pub.find((x) => x.id === study);
  expect(s.price_text === null && s.price === null && s.status_text === 'Reserved', 'hidden price, reserved');
  const hist = await api('GET', `/api/admin/businesses/${state.artSlug}/history?limit=20`);
  const summaries = hist.data.entries.map((e) => e.summary);
  expect(summaries.includes("Marked 'Smoke Portrait' sold"), 'sold summary');
  expect(summaries.includes("Changed the price of 'Smoke Study 100%' to $1,200"), 'price summary');
  expect(summaries.includes("Edited 'Smoke Study 100%'"), 'edit summary');
});

await step('Artwork inquiry form stores the canonical title', async () => {
  needCatalog();
  const { portrait, draft } = state.artworkIds;
  const res = await api('POST', `/api/forms/${state.artSlug}/artwork`, {
    name: 'Smoke Collector', email: 'collector@example.com', message: 'Is this piece still available?',
    artwork_id: String(portrait), artwork_title: 'A title the page made up', artwork_artist: 'Someone else',
  }, { auth: null, headers: FORM_IP });
  expectStatus(res, 200, 'artwork form');
  const inq = (await api('GET', `/api/admin/inquiries/${res.data.id}`)).data.inquiry;
  const f = inq.fields;
  expect(inq.form_type === 'artwork' && f.artwork_id === String(portrait) && f.artwork_title === 'Smoke Portrait'
    && f.artwork_artist === 'Smoke Artist' && f.artwork_status === 'Sold', `fields ${JSON.stringify(f)}`);
  // Any other id (here a draft piece) keeps only artwork_id: a visitor's title, artist and status are dropped.
  const spoof = { artwork_title: 'Typed by the visitor', artwork_artist: 'Fake', artwork_status: 'Sold' };
  const other = await api('POST', `/api/forms/${state.artSlug}/artwork`, { email: 'collector@example.com', artwork_id: String(draft), ...spoof }, { auth: null, headers: FORM_IP });
  expectStatus(other, 200, 'unpublished piece');
  const otherFields = (await api('GET', `/api/admin/inquiries/${other.data.id}`)).data.inquiry.fields;
  expect(otherFields.artwork_id === String(draft) && !Object.keys(spoof).some((k) => k in otherFields), `unpublished piece fields ${JSON.stringify(otherFields)}`);
  // The same goes for every other form type.
  const contact = await api('POST', `/api/forms/${state.artSlug}/contact`, { email: 'collector@example.com', message: 'Hello', ...spoof, artwork_id: String(portrait) }, { auth: null, headers: FORM_IP });
  expectStatus(contact, 200, 'contact form');
  const contactFields = (await api('GET', `/api/admin/inquiries/${contact.data.id}`)).data.inquiry.fields;
  expect(!Object.keys(spoof).some((k) => k in contactFields), `contact form fields ${JSON.stringify(contactFields)}`);
  for (const id of [res.data.id, other.data.id, contact.data.id]) await api('PATCH', `/api/admin/inquiries/${id}`, { status: 'handled' });
});

await step('Artworks: an editor of another business gets 403', async () => {
  if (state.role === 'editor') return 'skipped (logged in as an editor)';
  needCatalog();
  const email = `smoke-art-editor-${Date.now()}@example.com`;
  const created = await api('POST', '/api/admin/users', { email, name: 'Smoke Art Editor', role: 'editor', businesses: state.plainSlug ? [state.plainSlug] : [], password: EDITOR_PASSWORD });
  expectStatus(created, 200, 'create editor');
  state.artEditorId = created.data.user.id;
  const login = await api('POST', '/api/auth/login', { email, password: EDITOR_PASSWORD }, { auth: null });
  expectStatus(login, 200, 'editor login');
  const { portrait } = state.artworkIds;
  const [imageId] = state.imageIds;
  const tries = [
    ['GET', `/api/admin/businesses/${state.artSlug}/artworks`],
    ['POST', `/api/admin/businesses/${state.artSlug}/artworks`, { title: 'nope' }],
    ['POST', `/api/admin/businesses/${state.artSlug}/artworks/reorder`, { ids: [portrait] }],
    ['GET', `/api/admin/artworks/${portrait}`],
    ['PATCH', `/api/admin/artworks/${portrait}`, { status: 'available' }],
    ['DELETE', `/api/admin/artworks/${portrait}`],
    ['POST', `/api/admin/artworks/${portrait}/images`, { url: 'https://example.com/nope.webp' }],
    ['POST', `/api/admin/artworks/${portrait}/images/reorder`, { ids: state.imageIds }],
    ['PATCH', `/api/admin/artwork-images/${imageId}`, { alt: 'nope' }],
    ['DELETE', `/api/admin/artwork-images/${imageId}`],
  ];
  for (const [method, path, body] of tries) expectStatus(await api(method, path, body, { auth: login.data.token }), 403, `${method} ${path} as an editor of another business`);
  const still = (await api('GET', `/api/admin/artworks/${portrait}`)).data.artwork;
  expect(still.status === 'sold' && still.images.length === 2, 'nothing changed');
  return `${tries.length} routes refused`;
});

await step('Delete an artwork, then History → Restore brings its photos back', async () => {
  needCatalog();
  const { portrait, study } = state.artworkIds;
  expectStatus(await api('DELETE', `/api/admin/artworks/${portrait}`), 200, 'delete artwork');
  expectStatus(await api('GET', `/api/admin/artworks/${portrait}`), 404, 'gone');
  let pub = (await api('GET', `/api/public/${state.artSlug}`)).data;
  expect(!pub.artworks.some((x) => x.id === portrait) && pub.events.current.find((e) => e.id === state.artEventId).artwork_count === 1, 'gone from the public bundle');
  const history = async () => (await api('GET', `/api/admin/businesses/${state.artSlug}/history?limit=50`)).data.entries;
  let entries = await history();
  const del = entries.find((e) => e.entity === 'artwork' && e.action === 'delete' && e.entity_id === String(portrait));
  expect(del && del.summary === "Deleted artwork 'Smoke Portrait' (2 photos)" && del.can_restore, `delete entry ${JSON.stringify(del)}`);
  expectStatus(await api('POST', `/api/admin/history/${del.id}/restore`), 200, 'restore');
  const back = await api('GET', `/api/admin/artworks/${portrait}`);
  expectStatus(back, 200, 'back');
  const art = back.data.artwork;
  expect(art.status === 'sold' && art.event_id === state.artEventId && art.images.map((i) => i.id).join() === [state.imageIds[1], state.imageIds[0]].join(), `restored ${JSON.stringify(art)}`);
  pub = (await api('GET', `/api/public/${state.artSlug}`)).data;
  expect(pub.artworks.find((x) => x.id === portrait)?.images.length === 2 && pub.events.current.find((e) => e.id === state.artEventId).artwork_count === 2, 'public again, with photos');
  expectStatus(await api('POST', `/api/admin/history/${del.id}/restore`), 409, 'restoring twice');

  // A removed photo comes back on its own too, and the artwork order can be undone.
  expectStatus(await api('DELETE', `/api/admin/artwork-images/${state.imageIds[0]}`), 200, 'remove photo');
  entries = await history();
  const photo = entries.find((e) => e.entity === 'artwork_image' && e.action === 'delete' && e.entity_id === String(state.imageIds[0]));
  expect(photo?.summary === "Removed a photo from 'Smoke Portrait'", `photo entry ${photo?.summary}`);
  expectStatus(await api('POST', `/api/admin/history/${photo.id}/restore`), 200, 'restore photo');
  expect((await api('GET', `/api/admin/artworks/${portrait}`)).data.artwork.images.length === 2, 'photo back');
  const reorder = entries.find((e) => e.entity === 'artwork' && e.summary.startsWith('Reordered the artworks'));
  expect(reorder?.can_restore, 'reorder entry is restorable');
  expectStatus(await api('POST', `/api/admin/history/${reorder.id}/restore`), 200, 'undo reorder');
  const listed = artworkIdsIn(await api('GET', `/api/admin/businesses/${state.artSlug}/artworks`));
  expect(listed.indexOf(portrait) < listed.indexOf(study), 'original order back');
});

await step('A draft exhibition hides its pieces; deleting and restoring a show keeps them in it', async () => {
  needCatalog();
  const ev = await api('POST', `/api/admin/businesses/${state.artSlug}/events`, { title: 'Smoke unannounced show', kind: 'exhibition', start_date: chicagoToday(30), published: false });
  expectStatus(ev, 200, 'draft exhibition');
  const showId = ev.data.event.id;
  state.draftShowId = showId;
  const made = await api('POST', `/api/admin/businesses/${state.artSlug}/artworks`, { title: 'Smoke Secret Piece', price: 5000, price_display: 'show', event_id: showId });
  expectStatus(made, 200, 'piece in the draft show');
  const secret = made.data.artwork.id;
  state.artworkIds.secret = secret;
  expectStatus(await api('POST', `/api/admin/artworks/${secret}/images`, { url: 'https://example.com/smoke-secret.webp' }), 200, 'its photo');
  const bundle = async () => (await api('GET', `/api/public/${state.artSlug}`)).data;
  let pub = await bundle();
  expect(!pub.artworks.some((x) => x.id === secret) && !JSON.stringify(pub).includes('smoke-secret.webp'), 'a piece in a draft show is not public, nor its photo');
  const sig = (await api('GET', `/api/public/signage/${state.artSlug}`)).data;
  expect(!sig.artworks.some((x) => x.id === secret), 'nor on the TV');
  // An inquiry naming it is an ordinary one (the visitor cannot have seen it).
  const inq = await api('POST', `/api/forms/${state.artSlug}/artwork`, { email: 'collector@example.com', artwork_id: String(secret), artwork_title: 'Smoke Secret Piece' }, { auth: null, headers: FORM_IP });
  expectStatus(inq, 200, 'inquiry naming it');
  expect(!('artwork_title' in (await api('GET', `/api/admin/inquiries/${inq.data.id}`)).data.inquiry.fields), 'no catalog facts for a hidden piece');
  await api('PATCH', `/api/admin/inquiries/${inq.data.id}`, { status: 'handled' });
  // Publishing the show publishes its pieces.
  expectStatus(await api('PATCH', `/api/admin/events/${showId}`, { published: true }), 200, 'publish the show');
  pub = await bundle();
  expect(pub.artworks.find((x) => x.id === secret)?.price_text === '$5,000' && pub.events.upcoming.find((e) => e.id === showId)?.artwork_count === 1, 'public once the show is');
  // Deleting the show leaves the piece "not in a show"; History → Restore hangs it back.
  expectStatus(await api('DELETE', `/api/admin/events/${showId}`), 200, 'delete the show');
  expect((await api('GET', `/api/admin/artworks/${secret}`)).data.artwork.event_id === null, 'piece stays, out of any show');
  const del = (await api('GET', `/api/admin/businesses/${state.artSlug}/history?limit=20`)).data.entries.find((e) => e.entity === 'event' && e.action === 'delete' && e.entity_id === String(showId));
  expect(del?.can_restore, 'event delete entry');
  expect((await api('GET', `/api/admin/history/${del.id}`)).data.entry.before.artwork_ids?.join() === String(secret), 'the entry keeps the piece ids');
  expectStatus(await api('POST', `/api/admin/history/${del.id}/restore`), 200, 'restore the show');
  expect((await api('GET', `/api/admin/artworks/${secret}`)).data.artwork.event_id === showId, 'piece back in the show');
  pub = await bundle();
  expect(pub.events.upcoming.find((e) => e.id === showId)?.artwork_count === 1, 'and counted on the site again');
});

await step('Media upload: a generated PNG as variant=full', async () => {
  needCatalog();
  const png = tinyPng(3, 2);
  const upload = async (fields, name = 'Smoke Upload.png') => {
    const fd = new FormData();
    fd.append('business', state.artSlug);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([png], { type: 'image/png' }), name);
    const res = await fetch(`${BASE}/api/admin/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    return { status: res.status, data: await res.json() };
  };
  const res = await upload({ variant: 'full', width: '3', height: '2' });
  if (res.status === 501) return 'skipped (MEDIA is not bound)';
  expectStatus(res, 200, 'upload');
  const { url, key, width, height } = res.data;
  expect(new RegExp(`^uploads/${state.artSlug}/\\d+-smoke-upload-full\\.png$`).test(key) && width === 3 && height === 2 && url.endsWith(`/api/media/${key}`), `upload answer ${JSON.stringify(res.data)}`);
  const file = await fetch(`${BASE}/api/media/${key}`);
  expect(file.status === 200 && file.headers.get('content-type') === 'image/png', `serve: ${file.status} ${file.headers.get('content-type')}`);
  expect(Buffer.from(await file.arrayBuffer()).equals(png), 'same bytes back');
  const hist = (await api('GET', `/api/admin/businesses/${state.artSlug}/history?limit=20`)).data.entries;
  expect(!hist.some((e) => e.entity === 'media' && e.entity_id === key), 'a sized copy writes no History entry of its own');
  expectStatus(await upload({ variant: 'huge' }), 400, 'unknown variant');
  expectStatus(await upload({ variant: 'thumb', width: 'wide' }), 400, 'bad width');
  // The answer's link can go straight onto a piece.
  const img = await api('POST', `/api/admin/artworks/${state.artworkIds.draft}/images`, { url, thumb_url: url, alt: 'A peach-coloured square', width, height });
  expectStatus(img, 200, 'uploaded photo added to a piece');
  return key;
});

await step('Cleanup: remove test rows', async () => {
  const errors = [];
  const tryDelete = async (path, auth = token) => { const r = await api('DELETE', path, undefined, { auth }); if (r.status !== 200) errors.push(`${path} → ${r.status}`); };
  if (state.sectionId) await tryDelete(`/api/admin/menu/sections/${state.sectionId}`);
  for (const id of state.announcementIds) await tryDelete(`/api/admin/announcements/${id}`);
  if (state.editorId) await tryDelete(`/api/admin/users/${state.editorId}`);
  for (const id of Object.values(state.artworkIds)) await tryDelete(`/api/admin/artworks/${id}`);
  if (state.artEventId) await tryDelete(`/api/admin/events/${state.artEventId}`);
  if (state.draftShowId) await tryDelete(`/api/admin/events/${state.draftShowId}`);
  if (state.artEditorId) await tryDelete(`/api/admin/users/${state.artEditorId}`);
  if (state.originalHours && state.originalHours.length === 7) {
    const r = await api('PUT', `/api/admin/businesses/${state.slug}/hours`, { hours: state.originalHours });
    if (r.status !== 200) errors.push(`restore hours → ${r.status} ${JSON.stringify(r.data)}`);
  }
  expect(!errors.length, errors.join('; '));
});

await step('POST /api/auth/logout → 401 afterwards', async () => {
  const res = await api('POST', '/api/auth/logout');
  expectStatus(res, 200, 'logout');
  const me = await api('GET', '/api/auth/me');
  expectStatus(me, 401, 'me after logout');
  const list = await api('GET', '/api/admin/businesses');
  expectStatus(list, 401, 'admin after logout');
  token = null;
});

/* ---------- Change sets: drafts, previews, double-checks, publish, verify, undo (docs/assistant-api.md §1) ---------- */
// These steps sign in again (the logout above ended that session), work on the same business as the steps above, and
// remove what they create. Two need the local database itself: an expired draft, and a publish that fails half way (a
// temporary SQLite trigger makes one insert fail). They run when SMOKE_PERSIST_TO is the folder wrangler dev was started
// with (--persist-to); otherwise they are skipped.
const PERSIST = process.env.SMOKE_PERSIST_TO || '';
const cs = { token: null, slug: null, other: null, hours: null, day: null, dayLine: null, tagline: null, sectionId: null, item: null, draftId: null, editorId: null };
const csApi = (method, path, body) => api(method, path, body, { auth: cs.token });
const publicGet = (path) => api('GET', path, undefined, { auth: null });
const propose = (title, ops, extra = {}, auth = cs.token) => api('POST', '/api/admin/change-sets', { title, ops, ...extra }, { auth });
const weekWith = (hours, day) => hours.map((h) => (h.weekday === day.weekday ? day : h));
const dayIn = (bundle) => bundle.hours.find((h) => h.weekday === cs.day.weekday).text;
const needDraft = () => expect(cs.draftId, 'needs the draft from the "valid draft" step, which failed');
async function localSql(command) {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  execFileSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', 'romesjoy-admin', '--local', '--persist-to', PERSIST, '--command', command],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' });
}

await step('Change sets: sign in again, add a menu item to work on', async () => {
  const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: null });
  expectStatus(login, 200, 'login');
  cs.token = login.data.token;
  const list = (await csApi('GET', '/api/admin/businesses')).data.businesses;
  cs.slug = state.slug || list[0].slug;
  cs.other = list.find((b) => b.slug !== cs.slug)?.slug || null;
  const detail = (await csApi('GET', `/api/admin/businesses/${cs.slug}`)).data;
  cs.hours = detail.hours.map((h) => ({ weekday: h.weekday, closed: h.closed, open_min: h.open_min, close_min: h.close_min }));
  cs.tagline = detail.business.tagline;
  // One hour off the first open day (or open a closed Monday 9–5): the draft's hours change.
  const open = cs.hours.find((h) => !h.closed && h.close_min - h.open_min > 60);
  cs.day = open ? { ...open, close_min: open.close_min - 60 } : { weekday: cs.hours[0].weekday, closed: false, open_min: 540, close_min: 1020 };
  const sec = await csApi('POST', `/api/admin/businesses/${cs.slug}/menu/sections`, { title: 'Smoke CS Plates' });
  expectStatus(sec, 200, 'menu section');
  cs.sectionId = sec.data.section.id;
  const item = await csApi('POST', `/api/admin/menu/sections/${cs.sectionId}/items`, { name: 'Smoke CS Catfish', price: 10, tags: ['GF'], allergens: ['Fish'] });
  expectStatus(item, 200, 'menu item');
  cs.item = item.data.item;
  return cs.slug;
});

await step('Change sets: bad drafts are refused with details per op', async () => {
  const res = await propose('Smoke bad draft', [
    { op: 'hours.put', business_slug: cs.slug, args: { hours: cs.hours.slice(0, 6) } },
    { op: 'event.create', business_slug: cs.slug, args: { title: 'Smoke backwards', start_date: chicagoToday(9), end_date: chicagoToday(3) } },
    { op: 'event.patch', business_slug: cs.slug, args: { id: { $ref: 3 }, featured: true } },
    { op: 'menu.burn', business_slug: cs.slug, args: {} },
    { op: 'business.patch', business_slug: cs.slug, args: { inquiry_emails: 'not an email' } },
    { op: 'menu_item.patch', business_slug: cs.slug, args: { id: 999999999, price: 5 } },
  ]);
  expectStatus(res, 400, 'bad draft');
  expect(res.data.code === 'invalid_change_set' && res.data.details?.map((d) => d.op_index).join() === '0,1,2,3,4,5', `details ${JSON.stringify(res.data.details)}`);
  expect(res.data.details.every((d) => typeof d.message === 'string' && d.message.length > 10) && /change 2: The end date/.test(res.data.error), `messages ${res.data.error}`);
  const tooMany = await propose('Smoke too many', Array.from({ length: 41 }, () => ({ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'x' } })));
  expectStatus(tooMany, 400, '41 ops');
  expectStatus(await propose('', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'x' } }]), 400, 'missing title');
  expectStatus(await propose('x', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'x' } }], {}, null), 401, 'not signed in');
});

await step('Change sets: a valid draft has a before → after summary, checks and preview links', async () => {
  const ops = [
    { op: 'hours.put', business_slug: cs.slug, args: { hours: weekWith(cs.hours, cs.day) } },
    { op: 'business.patch', business_slug: cs.slug, args: { notice: 'Smoke preview notice', notice_until: chicagoToday(3) } },
    { op: 'event.create', business_slug: cs.slug, args: { title: 'Smoke preview event', start_date: chicagoToday(6), start_time: '10:00', end_time: '14:00' } },
    { op: 'event.patch', business_slug: cs.slug, args: { id: { $ref: 2 }, featured: true } },
    { op: 'hours_exception.create', business_slug: cs.slug, args: { date: chicagoToday(21), closed: true, label: 'Smoke preview holiday' } },
    { op: 'menu_item.patch', business_slug: cs.slug, args: { id: cs.item.id, price: 40, allergens: [] } },
  ];
  const firstTry = await propose('Smoke draft, first try', ops.slice(0, 2));
  expectStatus(firstTry, 200, 'first draft');
  const res = await propose('Smoke: close early + an event', ops, { replace_id: firstTry.data.change_set.id });
  expectStatus(res, 200, 'propose');
  const d = res.data.change_set;
  expect(d.id === firstTry.data.change_set.id && /^[A-Za-z0-9_-]{22}$/.test(d.id), 'replace_id overwrites the same draft');
  cs.draftId = d.id;
  expect(d.status === 'draft' && d.source === 'assistant' && d.businesses.join() === cs.slug && d.ops.length === ops.length, `draft ${JSON.stringify({ ...d, ops: undefined, summary: undefined })}`);
  cs.dayLine = d.summary.find((l) => l.op_index === 0);
  expect(cs.dayLine && / hours$/.test(cs.dayLine.line) && cs.dayLine.before && cs.dayLine.after && cs.dayLine.before !== cs.dayLine.after && cs.dayLine.business_name, `hours line ${JSON.stringify(cs.dayLine)}`);
  expect(d.summary.some((l) => l.line === 'Notice' && l.after === 'Smoke preview notice'), 'notice line');
  expect(d.summary.some((l) => l.line === "New event 'Smoke preview event'" && l.before === null && /10 am – 2 pm/.test(l.after)), 'event line');
  expect(d.summary.some((l) => l.line === "Menu item 'Smoke CS Catfish': price" && l.before === '$10' && l.after === '$40'), 'price line');
  expect(d.checks.some((k) => k.level === 'warn' && k.op_index === 5 && /\$10 to \$40/.test(k.message)), `price warning ${JSON.stringify(d.checks)}`);
  expect(d.checks.some((k) => k.level === 'warn' && /^Allergen info removed from 'Smoke CS Catfish': Fish/.test(k.message)), 'allergen warning');
  expect(!d.checks.some((k) => k.level === 'block'), 'no blocking checks');
  const hoursLeft = (Date.parse(d.expires_at) - Date.now()) / 3600000;
  expect(hoursLeft > 47 && hoursLeft <= 48.05, `expires in ${hoursLeft.toFixed(2)} h`);
  const site = d.preview_urls.find((u) => u.label !== 'TV screen');
  const tv = d.preview_urls.find((u) => u.label === 'TV screen');
  expect(site && site.url.endsWith(`?preview=${d.id}`) && tv && tv.url.endsWith(`/signage/live.html?business=${cs.slug}&preview=${d.id}`), `preview_urls ${JSON.stringify(d.preview_urls)}`);
  expectStatus(await csApi('GET', `/api/admin/change-sets/${d.id}`), 200, 'get');
  const drafts = await csApi('GET', '/api/admin/change-sets?status=draft');
  expect(drafts.data.change_sets.some((x) => x.id === d.id), 'listed as a draft');
  return `${d.summary.length} lines, ${d.checks.length} checks`;
});

await step('Change sets: the preview bundle shows the draft; the live bundle does not', async () => {
  needDraft();
  const preview = await publicGet(`/api/public/${cs.slug}?preview=${cs.draftId}`);
  expectStatus(preview, 200, 'preview');
  const p = preview.data;
  expect(p.preview?.id === cs.draftId && p.preview.title === 'Smoke: close early + an event' && p.preview.expires_at, `preview ${JSON.stringify(p.preview)}`);
  expect(preview.headers.get('cache-control') === 'no-store', `preview Cache-Control ${preview.headers.get('cache-control')}`);
  expect(dayIn(p) === cs.dayLine.after && p.business.notice?.text === 'Smoke preview notice', `preview hours ${dayIn(p)}, notice ${JSON.stringify(p.business.notice)}`);
  const ev = p.events.upcoming.find((e) => e.title === 'Smoke preview event');
  expect(ev && ev.featured === true && ev.time_text === '10 am – 2 pm', `preview event ${JSON.stringify(ev)}`);
  expect(p.exceptions.some((e) => e.label === 'Smoke preview holiday' && e.closed === true), 'preview special day');
  const item = p.menu.sections.flatMap((s) => s.items).find((i) => i.id === cs.item.id);
  expect(item?.price === 40 && item.allergens.length === 0, `preview item ${JSON.stringify(item)}`);
  const live = await publicGet(`/api/public/${cs.slug}`);
  expect(!('preview' in live.data) && /max-age=60/.test(live.headers.get('cache-control') || ''), 'the live bundle has no preview and stays cacheable');
  expect(dayIn(live.data) === cs.dayLine.before && !JSON.stringify(live.data).includes('Smoke preview'), 'nothing from the draft is live');
  expect(live.data.menu.sections.flatMap((s) => s.items).find((i) => i.id === cs.item.id)?.price === 10, 'live price unchanged');
  const tv = await publicGet(`/api/public/signage/${cs.slug}?preview=${cs.draftId}`);
  expect(tv.data.preview?.id === cs.draftId && tv.headers.get('cache-control') === 'no-store' && dayIn(tv.data) === cs.dayLine.after, 'TV preview');
  expect(tv.data.family.find((f) => f.slug === cs.slug)?.hours_summary === p.hours_summary, 'the family strip shows the draft hours too');
  if (cs.other) expect(!('preview' in (await publicGet(`/api/public/${cs.other}?preview=${cs.draftId}`)).data), 'another business ignores the id');
  const bogus = await publicGet(`/api/public/${cs.slug}?preview=AAAAAAAAAAAAAAAAAAAAAA`);
  expect(bogus.status === 200 && !('preview' in bogus.data), 'an unknown id is ignored');
});

await step('Change sets: blocking checks, "nothing unusual", discard', async () => {
  const plain = await propose('Smoke plain draft', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke plain tagline' } }]);
  expectStatus(plain, 200, 'plain draft');
  const checks = plain.data.change_set.checks;
  expect(checks.length === 1 && checks[0].level === 'ok' && checks[0].message === 'Checked: nothing unusual.', `checks ${JSON.stringify(checks)}`);
  const blocked = await propose('Smoke blocked draft', [
    { op: 'business.patch', business_slug: cs.slug, args: { notice: 'Smoke old notice', notice_until: chicagoToday(-2) } },
    { op: 'hours_exception.create', business_slug: cs.slug, args: { date: chicagoToday(-5), closed: true } },
    { op: 'menu_item.patch', business_slug: cs.slug, args: { id: cs.item.id, price: 0 } },
  ]);
  expectStatus(blocked, 200, 'a draft with blocking checks is saved for the person to see');
  const b = blocked.data.change_set;
  expect(b.checks.filter((k) => k.level === 'block').map((k) => k.op_index).join() === '0,1,2', `block checks ${JSON.stringify(b.checks)}`);
  const refused = await csApi('POST', `/api/admin/change-sets/${b.id}/publish`);
  expectStatus(refused, 409, 'publish with a blocking check');
  expect(refused.data.code === 'change_set_blocked', `code ${refused.data.code}`);
  for (const id of [plain.data.change_set.id, b.id]) {
    const dis = await csApi('POST', `/api/admin/change-sets/${id}/discard`);
    expectStatus(dis, 200, 'discard');
    expect(dis.data.change_set.status === 'discarded', 'discarded');
  }
  const gone = (await publicGet(`/api/public/${cs.slug}?preview=${plain.data.change_set.id}`)).data;
  expect(!('preview' in gone) && gone.business.tagline !== 'Smoke plain tagline', 'a discarded draft no longer previews');
  expectStatus(await csApi('POST', `/api/admin/change-sets/${plain.data.change_set.id}/publish`), 409, 'publish a discarded draft');
});

await step('Change sets: an editor of another business is blocked', async () => {
  if (state.role === 'editor') return 'skipped (logged in as an editor)';
  needDraft();
  const email = `smoke-cs-editor-${Date.now()}@example.com`;
  const made = await csApi('POST', '/api/admin/users', { email, name: 'Smoke Draft Editor', role: 'editor', businesses: cs.other ? [cs.other] : [], password: EDITOR_PASSWORD });
  expectStatus(made, 200, 'create editor');
  cs.editorId = made.data.user.id;
  const login = await api('POST', '/api/auth/login', { email, password: EDITOR_PASSWORD }, { auth: null });
  expectStatus(login, 200, 'editor login');
  const ed = login.data.token;
  const theirs = await propose('Smoke not mine', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'nope' } }], {}, ed);
  expectStatus(theirs, 400, 'drafting for a business they cannot edit');
  expect(theirs.data.code === 'invalid_change_set' && /assigned to you/.test(theirs.data.details?.[0]?.message || ''), `details ${JSON.stringify(theirs.data.details)}`);
  expectStatus(await propose('Smoke family', [{ op: 'announcement.create', business_slug: null, args: { title: 'nope' } }], {}, ed), 400, 'a family-wide announcement');
  for (const [method, path] of [['GET', ''], ['POST', '/publish'], ['POST', '/discard'], ['POST', '/undo'], ['GET', '/verify']]) {
    expectStatus(await api(method, `/api/admin/change-sets/${cs.draftId}${path}`, undefined, { auth: ed }), 404, `${method} …${path} on someone else's draft`);
  }
  const list = await api('GET', '/api/admin/change-sets?status=all', undefined, { auth: ed });
  expect(list.status === 200 && !list.data.change_sets.some((x) => x.id === cs.draftId), 'not in their list');
  if (cs.other) {
    const own = await propose('Smoke own business', [{ op: 'business.patch', business_slug: cs.other, args: { tagline: 'Smoke editor tagline' } }], {}, ed);
    expectStatus(own, 200, 'their own business');
    expectStatus(await api('POST', `/api/admin/change-sets/${own.data.change_set.id}/discard`, undefined, { auth: ed }), 200, 'discard their own');
  }
  expect((await csApi('GET', `/api/admin/change-sets/${cs.draftId}`)).data.change_set.status === 'draft', 'the draft is untouched');
});

await step('Change sets: an expired draft cannot be published or previewed', async () => {
  if (!PERSIST) return 'skipped (set SMOKE_PERSIST_TO to the folder wrangler dev uses for --persist-to)';
  const res = await propose('Smoke expiring draft', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke expired tagline' } }]);
  expectStatus(res, 200, 'draft');
  const id = res.data.change_set.id;
  expect(/^[A-Za-z0-9_-]{22}$/.test(id), 'id is safe to put in SQL');
  await localSql(`UPDATE change_sets SET expires_at = datetime('now', '-1 minute') WHERE id = '${id}'`);
  const preview = (await publicGet(`/api/public/${cs.slug}?preview=${id}`)).data;
  expect(!('preview' in preview) && preview.business.tagline !== 'Smoke expired tagline', 'no preview once expired');
  const got = (await csApi('GET', `/api/admin/change-sets/${id}`)).data.change_set;
  expect(got.status === 'expired', `status ${got.status}`);
  const refused = await csApi('POST', `/api/admin/change-sets/${id}/publish`);
  expectStatus(refused, 409, 'publish an expired draft');
  expect(refused.data.code === 'change_set_expired', `code ${refused.data.code}`);
  const fresh = await propose('Smoke after expiry', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke fresh tagline' } }], { replace_id: id });
  expectStatus(fresh, 200, 'replacing an expired draft');
  expect(fresh.data.change_set.id !== id && fresh.data.change_set.status === 'draft', 'makes a new draft');
  expectStatus(await csApi('POST', `/api/admin/change-sets/${fresh.data.change_set.id}/discard`), 200, 'discard it');
});

await step('Change sets: publish runs the real handlers; History and verify agree', async () => {
  needDraft();
  const res = await csApi('POST', `/api/admin/change-sets/${cs.draftId}/publish`);
  expectStatus(res, 200, 'publish');
  const { change_set: d, results: done } = res.data;
  expect(d.status === 'published' && d.published_at && done.length === d.ops.length && done.every((r) => r.ok && r.audit_ids.length === 1), `results ${JSON.stringify(done)}`);
  const eventId = done[2].created_id;
  expect(Number.isInteger(eventId) && eventId > 0, `created event id ${eventId}`);
  const live = (await publicGet(`/api/public/${cs.slug}`)).data;
  expect(dayIn(live) === cs.dayLine.after && live.business.notice?.text === 'Smoke preview notice', 'hours and notice are live');
  expect(live.events.upcoming.find((e) => e.id === eventId)?.featured === true, 'the event is live, and the $ref patch featured it');
  expect(live.menu.sections.flatMap((s) => s.items).find((i) => i.id === cs.item.id)?.price === 40, 'price is live');
  const hist = (await csApi('GET', `/api/admin/businesses/${cs.slug}/history?limit=10`)).data.entries;
  expect(hist[0].entity === 'change_set' && hist[0].summary === `Published "Smoke: close early + an event" (${d.ops.length} changes)`, `latest entry: ${hist[0]?.summary}`);
  expect(hist.slice(1, 1 + d.ops.length).every((e) => e.summary.startsWith('Assistant: ')), `entries ${hist.map((e) => e.summary).join(' | ')}`);
  const verify = await csApi('GET', `/api/admin/change-sets/${cs.draftId}/verify`);
  expectStatus(verify, 200, 'verify');
  expect(verify.data.ok === true && verify.data.lines.length === d.summary.length && verify.data.lines.every((l) => l.ok && l.detail && l.line), `verify ${JSON.stringify(verify.data)}`);
  expectStatus(await csApi('POST', `/api/admin/change-sets/${cs.draftId}/publish`), 409, 'publishing twice');
  // A manual edit afterwards: verify says that line is no longer what was published.
  expectStatus(await csApi('PATCH', `/api/admin/businesses/${cs.slug}`, { notice: 'Smoke manual notice' }), 200, 'manual edit');
  const again = (await csApi('GET', `/api/admin/change-sets/${cs.draftId}/verify`)).data;
  expect(again.ok === false && again.lines.find((l) => l.line === 'Notice')?.ok === false && again.lines.filter((l) => !l.ok).length === 1, `verify after an edit ${JSON.stringify(again)}`);
});

await step('Change sets: Undo all puts the live site back', async () => {
  needDraft();
  const res = await csApi('POST', `/api/admin/change-sets/${cs.draftId}/undo`);
  expectStatus(res, 200, 'undo');
  expect(res.data.change_set.status === 'undone', `status ${res.data.change_set.status}`);
  const live = (await publicGet(`/api/public/${cs.slug}`)).data;
  expect(dayIn(live) === cs.dayLine.before && !JSON.stringify(live).includes('Smoke preview'), 'hours, event and special day back');
  expect(!live.business.notice || !/^Smoke/.test(live.business.notice.text), `notice ${JSON.stringify(live.business.notice)}`);
  const item = live.menu.sections.flatMap((s) => s.items).find((i) => i.id === cs.item.id);
  expect(item?.price === 10 && item.allergens.join() === 'Fish', `item back ${JSON.stringify(item)}`);
  const hist = (await csApi('GET', `/api/admin/businesses/${cs.slug}/history?limit=3`)).data.entries;
  expect(hist[0].summary === 'Undid "Smoke: close early + an event" (6 changes)', `latest entry: ${hist[0]?.summary}`);
  expectStatus(await csApi('POST', `/api/admin/change-sets/${cs.draftId}/undo`), 409, 'undo twice');
  expectStatus(await csApi('GET', `/api/admin/change-sets/${cs.draftId}/verify`), 409, 'verify after undo');
});

await step('Change sets: a failing op rolls back the ones before it', async () => {
  if (!PERSIST) return 'skipped (set SMOKE_PERSIST_TO to the folder wrangler dev uses for --persist-to)';
  await localSql("CREATE TRIGGER IF NOT EXISTS smoke_changeset_fail BEFORE INSERT ON hours_exceptions WHEN NEW.label = 'Smoke rollback trigger' BEGIN SELECT RAISE(ABORT, 'Smoke test: forced failure'); END;");
  try {
    const res = await propose('Smoke rollback', [
      { op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke rollback tagline' } },
      { op: 'hours.put', business_slug: cs.slug, args: { hours: weekWith(cs.hours, cs.day) } },
      { op: 'event.create', business_slug: cs.slug, args: { title: 'Smoke rollback event', start_date: chicagoToday(4) } },
      { op: 'hours_exception.create', business_slug: cs.slug, args: { date: chicagoToday(25), closed: true, label: 'Smoke rollback trigger' } },
    ]);
    expectStatus(res, 200, 'draft (the trigger only bites on publish)');
    const id = res.data.change_set.id;
    const attempt = await csApi('POST', `/api/admin/change-sets/${id}/publish`);
    expectStatus(attempt, 409, 'publish that fails at the last op');
    expect(attempt.data.code === 'publish_failed' && /^Change 4 could not be made/.test(attempt.data.error) && /Nothing was changed/.test(attempt.data.error), `error: ${attempt.data.error}`);
    const after = (await csApi('GET', `/api/admin/change-sets/${id}`)).data.change_set;
    expect(after.status === 'failed' && /^Change 4/.test(after.error || ''), `change set ${after.status} ${after.error}`);
    const live = (await publicGet(`/api/public/${cs.slug}`)).data;
    expect(live.business.tagline === cs.tagline && dayIn(live) === cs.dayLine.before && !JSON.stringify(live).includes('Smoke rollback'), 'nothing partial is left');
    const hist = (await csApi('GET', `/api/admin/businesses/${cs.slug}/history?limit=3`)).data.entries;
    expect(hist.every((e) => e.action === 'restore'), `the three earlier changes were put back: ${hist.map((e) => e.summary).join(' | ')}`);
    expectStatus(await csApi('POST', `/api/admin/change-sets/${id}/publish`), 409, 'a failed draft cannot be published again');
  } finally {
    await localSql('DROP TRIGGER IF EXISTS smoke_changeset_fail;');
  }
});

await step('Change sets: artworks, a photo, family-wide news and TV settings in one draft', async () => {
  if (state.role === 'editor') return 'skipped (logged in as an editor)';
  const art = state.artSlug;
  expect(art, 'needs the gallery business from the artwork steps');
  const tvBefore = (await csApi('GET', `/api/admin/settings/signage:${art}`)).data.value;
  const res = await propose('Smoke gallery draft', [
    { op: 'event.create', business_slug: art, args: { title: 'Smoke CS show', kind: 'exhibition', start_date: chicagoToday(-1), end_date: chicagoToday(30) } },
    { op: 'artwork.create', business_slug: art, args: { title: 'Smoke CS Piece', artist: 'Smoke Artist', price: 1200, price_display: 'show', status: 'sold', event_id: { $ref: 0 } } },
    { op: 'artwork_image.add', business_slug: art, args: { id: { $ref: 1 }, url: 'https://example.com/smoke-cs.webp' } },
    { op: 'announcement.create', business_slug: null, args: { title: 'Smoke CS family news', ends_at: chicagoToday(5) } },
    { op: 'screen_settings.put', business_slug: art, args: { value: { ...tvBefore, seconds_per_scene: 15 } } },
  ]);
  expectStatus(res, 200, 'draft');
  const d = res.data.change_set;
  expect(d.checks.some((k) => /marked sold, so its price will be hidden/.test(k.message)) && d.checks.some((k) => /no description/.test(k.message)), `checks ${JSON.stringify(d.checks)}`);
  expect(d.summary.some((l) => l.line === 'TV screens: seconds per scene' && l.after === '15') && d.summary.some((l) => l.business_slug === null && /family-wide/.test(l.line)), `summary ${JSON.stringify(d.summary)}`);
  const p = (await publicGet(`/api/public/${art}?preview=${d.id}`)).data;
  const piece = p.artworks?.find((a) => a.title === 'Smoke CS Piece');
  expect(piece && piece.status === 'sold' && piece.price_text === null && piece.images.length === 1 && p.events.current.find((e) => e.id === piece.event_id)?.artwork_count === 1, `preview piece ${JSON.stringify(piece)}`);
  expect(p.announcements.some((a) => a.title === 'Smoke CS family news' && a.business_slug === null), 'family news in the preview');
  const elsewhere = (await publicGet(`/api/public/${cs.slug}?preview=${d.id}`)).data;
  expect(elsewhere.preview && elsewhere.announcements.some((a) => a.title === 'Smoke CS family news') && !('artworks' in elsewhere && elsewhere.artworks.some((a) => a.title === 'Smoke CS Piece')), 'family news previews on every site, the gallery change only on its own');
  expect((await publicGet(`/api/public/signage/${art}?preview=${d.id}`)).data.signage?.seconds_per_scene === 15, 'TV preview has the new setting');
  const done = await csApi('POST', `/api/admin/change-sets/${d.id}/publish`);
  expectStatus(done, 200, 'publish');
  const verify = (await csApi('GET', `/api/admin/change-sets/${d.id}/verify`)).data;
  expect(verify.ok === true, `verify ${JSON.stringify(verify)}`);
  const tvPublished = (await csApi('GET', `/api/admin/settings/signage:${art}`)).data.value;
  expect(tvPublished.refresh_version > (Number(tvBefore.refresh_version) || 0), `publishing asks the TV screens to reload: ${JSON.stringify(tvPublished)}`);
  expectStatus(await csApi('POST', `/api/admin/change-sets/${d.id}/undo`), 200, 'undo');
  const back = (await publicGet(`/api/public/${art}`)).data;
  expect(!JSON.stringify(back).includes('Smoke CS'), 'all gone after undo');
  // Everything back, apart from refresh_version: undo asks the screens to reload again, with a newer number.
  const { refresh_version: tvAfterVersion, ...tvAfter } = (await csApi('GET', `/api/admin/settings/signage:${art}`)).data.value;
  const { refresh_version: unusedVersion, ...tvWas } = tvBefore;
  expect(JSON.stringify(tvAfter) === JSON.stringify(tvWas) && tvAfterVersion > tvPublished.refresh_version, `TV settings back ${JSON.stringify({ tvAfter, tvAfterVersion })}`);
});

await step('Change sets: TV settings never saved before can be published and undone', async () => {
  if (state.role === 'editor') return 'skipped (logged in as an editor)';
  const slugs = (await csApi('GET', '/api/admin/businesses')).data.businesses.map((b) => b.slug);
  const slug = slugs.includes('catering') ? 'catering' : cs.other || cs.slug;
  if (PERSIST) await localSql(`DELETE FROM settings WHERE key = 'signage:${slug}'`); // no row at all, as on a fresh database
  const before = (await csApi('GET', `/api/admin/settings/signage:${slug}`)).data.value;
  const res = await propose('Smoke TV settings', [{ op: 'screen_settings.put', business_slug: slug, args: { value: { ...before, seconds_per_scene: 15, scenes: { menu: false } } } }]);
  expectStatus(res, 200, 'draft');
  const d = res.data.change_set;
  expectStatus(await csApi('POST', `/api/admin/change-sets/${d.id}/publish`, { version: d.version }), 200, 'publish');
  const live = (await csApi('GET', `/api/admin/settings/signage:${slug}`)).data.value;
  expect(live.seconds_per_scene === 15 && live.scenes?.menu === false && live.refresh_version > (Number(before.refresh_version) || 0), `published ${JSON.stringify(live)}`);
  const undo = await csApi('POST', `/api/admin/change-sets/${d.id}/undo`);
  expectStatus(undo, 200, `Undo all ${JSON.stringify(undo.data)}`);
  expect(undo.data.change_set.status === 'undone', `status ${undo.data.change_set.status}`);
  const { refresh_version: version, ...after } = (await csApi('GET', `/api/admin/settings/signage:${slug}`)).data.value;
  const { refresh_version: unusedVersion, ...was } = before;
  expect(JSON.stringify(after) === JSON.stringify(was) && version > live.refresh_version, `after undo ${JSON.stringify({ after, version })}`);
  return slug;
});

await step('Change sets: Publish checks the version the person saw; a replaced draft is refused', async () => {
  const first = await propose('Smoke version one', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke version one' } }]);
  expectStatus(first, 200, 'draft');
  const seen = first.data.change_set;
  expect(typeof seen.version === 'string' && seen.version.length > 4, `version ${seen.version}`);
  const second = await propose('Smoke version two', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke version two' } }], { replace_id: seen.id });
  expectStatus(second, 200, 'replaced');
  expect(second.data.change_set.id === seen.id && second.data.change_set.version !== seen.version, 'same draft, new version');
  const stale = await csApi('POST', `/api/admin/change-sets/${seen.id}/publish`, { version: seen.version });
  expectStatus(stale, 409, 'publish the version the person did not see');
  expect(stale.data.code === 'change_set_changed', `code ${stale.data.code}`);
  expect((await publicGet(`/api/public/${cs.slug}`)).data.business.tagline === cs.tagline, 'nothing went live');
  expectStatus(await csApi('POST', `/api/admin/change-sets/${seen.id}/discard`), 200, 'discard');
});

await step('Change sets: new items show every detail; links to new sites and new form inboxes are flagged', async () => {
  const res = await propose('Smoke details', [
    { op: 'event.create', business_slug: cs.slug, args: { title: 'Smoke ticketed brunch', start_date: chicagoToday(8), location: 'Back patio',
      description: 'Smoke description', link_url: 'https://peachs-tickets.example/pay', link_label: 'Buy tickets', image_url: 'https://images.example.org/x.jpg' } },
    { op: 'business.patch', business_slug: cs.slug, args: { inquiry_emails: 'smoke-new-inbox@example.net' } },
  ]);
  expectStatus(res, 200, 'draft');
  const d = res.data.change_set;
  const line = (what) => d.summary.find((l) => l.line === `New event 'Smoke ticketed brunch': ${what}`);
  expect(line('link')?.after === 'https://peachs-tickets.example/pay' && line('location')?.after === 'Back patio' && line('description') && line('photo') && line('link label'),
    `detail lines ${JSON.stringify(d.summary.map((l) => l.line))}`);
  expect(d.checks.some((k) => k.level === 'warn' && k.op_index === 0 && /peachs-tickets\.example/.test(k.message)), `link warning ${JSON.stringify(d.checks)}`);
  expect(d.checks.some((k) => k.level === 'warn' && k.op_index === 1 && /also go to smoke-new-inbox@example\.net/.test(k.message)), 'new inbox warning');
  expectStatus(await csApi('POST', `/api/admin/change-sets/${d.id}/discard`), 200, 'discard');
});

await step('Change sets: a publish that never recorded its changes is not "undone"', async () => {
  if (!PERSIST) return 'skipped (set SMOKE_PERSIST_TO to the folder wrangler dev uses for --persist-to)';
  const res = await propose('Smoke cut-off publish', [{ op: 'business.patch', business_slug: cs.slug, args: { tagline: 'Smoke cut-off tagline' } }]);
  expectStatus(res, 200, 'draft');
  const id = res.data.change_set.id;
  expectStatus(await csApi('POST', `/api/admin/change-sets/${id}/publish`), 200, 'publish');
  try {
    await localSql(`UPDATE change_sets SET result_json = NULL WHERE id = '${id}'`); // as if the Worker stopped before the end
    const undo = await csApi('POST', `/api/admin/change-sets/${id}/undo`);
    expectStatus(undo, 409, 'undo');
    expect(undo.data.code === 'undo_unavailable' && /History/.test(undo.data.error), `answer ${JSON.stringify(undo.data)}`);
    expect((await csApi('GET', `/api/admin/change-sets/${id}`)).data.change_set.status === 'published', 'still published');
  } finally {
    await csApi('PATCH', `/api/admin/businesses/${cs.slug}`, { tagline: cs.tagline });
  }
});

await step('Change sets: cleanup and sign out', async () => {
  const errors = [];
  if (cs.sectionId) { const r = await csApi('DELETE', `/api/admin/menu/sections/${cs.sectionId}`); if (r.status !== 200) errors.push(`menu section → ${r.status}`); }
  if (cs.editorId) { const r = await csApi('DELETE', `/api/admin/users/${cs.editorId}`); if (r.status !== 200) errors.push(`editor → ${r.status}`); }
  // Undo and rollback put everything else back; if a step failed half way, put the hours and tagline back too.
  if (cs.hours) {
    const now = (await csApi('GET', `/api/admin/businesses/${cs.slug}`)).data;
    if (JSON.stringify(now.hours.map((h) => [h.weekday, h.closed, h.open_min, h.close_min])) !== JSON.stringify(cs.hours.map((h) => [h.weekday, h.closed, h.open_min, h.close_min]))) {
      await csApi('PUT', `/api/admin/businesses/${cs.slug}/hours`, { hours: cs.hours });
    }
    if (now.business.tagline !== cs.tagline) await csApi('PATCH', `/api/admin/businesses/${cs.slug}`, { tagline: cs.tagline });
  }
  expectStatus(await csApi('POST', '/api/auth/logout'), 200, 'logout');
  expect(!errors.length, errors.join('; '));
});

/* ---------- Photo library and TV screens (docs/assistant-api.md §5 and §6) ---------- */
// These steps sign in again, work on the same business as the steps above (and a second one for moves and the editor),
// and remove what they create. With SMOKE_PERSIST_TO set, a heartbeat is also backdated to see a screen go offline.
const ps = { token: null, slug: null, other: null, albumId: null, otherAlbumId: null, photo: null, linkPhoto: null, files: [],
  eventId: null, announcementId: null, screen: null, screen2: null, tv: null, tvRaw: null, editorId: null };
const psApi = (method, path, body, auth = ps.token) => api(method, path, body, { auth });
const needPhotos = () => expect(ps.photo && ps.linkPhoto, 'needs the photos from the "add photos" step, which failed');
const needScreen = () => expect(ps.screen, 'needs the screen from the "add a screen" step, which failed');
/** What signage/live.js sends: a text/plain JSON body (no CORS preflight), no login. */
const beat = (id, body = { scene: 'welcome', version: '0' }) => api('POST', `/api/public/screens/${id}/heartbeat`, JSON.stringify(body),
  { auth: null, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
async function uploadPng(slug, variant) {
  const fd = new FormData();
  fd.append('business', slug);
  fd.append('variant', variant);
  fd.append('width', '3');
  fd.append('height', '2');
  fd.append('file', new Blob([tinyPng(3, 2)], { type: 'image/png' }), 'Smoke Library.png');
  const res = await fetch(`${BASE}/api/admin/media`, { method: 'POST', headers: { Authorization: `Bearer ${ps.token}` }, body: fd });
  return { status: res.status, data: await res.json() };
}

await step('Photo library: sign in; albums: list, add, rename, no duplicate names', async () => {
  const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: null });
  expectStatus(login, 200, 'login');
  ps.token = login.data.token;
  const list = (await psApi('GET', '/api/admin/businesses')).data.businesses;
  ps.slug = state.slug || list[0].slug;
  ps.other = list.find((b) => b.slug !== ps.slug)?.slug || null;
  const before = await psApi('GET', `/api/admin/businesses/${ps.slug}/albums`);
  expectStatus(before, 200, 'albums');
  expect(before.data.albums.every((a) => Number.isInteger(a.id) && a.name && Number.isInteger(a.count)), `albums shape ${JSON.stringify(before.data)}`);
  const made = await psApi('POST', `/api/admin/businesses/${ps.slug}/albums`, { name: 'Smoke Album' });
  expectStatus(made, 200, 'add album');
  ps.albumId = made.data.album.id;
  expect(made.data.album.count === 0 && made.data.album.sort_order > Math.max(0, ...before.data.albums.map((a) => a.sort_order)), 'a new album is empty and goes last');
  const dup = await psApi('POST', `/api/admin/businesses/${ps.slug}/albums`, { name: 'smoke album' });
  expect(dup.status === 409 && dup.data.code === 'album_exists', `same name in other letters: ${dup.status} ${JSON.stringify(dup.data)}`);
  expectStatus(await psApi('POST', `/api/admin/businesses/${ps.slug}/albums`, { name: '  ' }), 400, 'empty name');
  const renamed = await psApi('PATCH', `/api/admin/albums/${ps.albumId}`, { name: 'Smoke Brunch Album' });
  expectStatus(renamed, 200, 'rename');
  expect(renamed.data.album.name === 'Smoke Brunch Album', 'renamed');
  if (ps.other) {
    const theirs = await psApi('POST', `/api/admin/businesses/${ps.other}/albums`, { name: 'Smoke Other Album' });
    expectStatus(theirs, 200, 'album of the other business');
    ps.otherAlbumId = theirs.data.album.id;
  }
  const hist = (await psApi('GET', `/api/admin/businesses/${ps.slug}/history?limit=5`)).data.entries;
  expect(hist.some((e) => e.entity === 'album' && e.summary === "Renamed the photo album 'Smoke Album' to 'Smoke Brunch Album'" && e.can_restore === false), 'History: the rename, as a record');
  return `${before.data.albums.length} albums before`;
});

await step('Photo library: add photos, then list, filter by album, search and page', async () => {
  expect(ps.albumId, 'needs the album step, which failed');
  const full = await uploadPng(ps.slug, 'full');
  let fields;
  if (full.status === 501) {
    fields = { url: 'https://example.com/smoke/brunch-full.jpg', thumb_url: 'https://example.com/smoke/brunch-thumb.jpg' };
  } else {
    expectStatus(full, 200, 'upload full size');
    const thumb = await uploadPng(ps.slug, 'thumb');
    expectStatus(thumb, 200, 'upload thumbnail');
    fields = { url: full.data.url, thumb_url: thumb.data.url, r2_key: full.data.key, thumb_r2_key: thumb.data.key };
    ps.files = [full.data.key, thumb.data.key];
  }
  const add = await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { ...fields, note: 'Smoke brunch special', alt: 'A peach-coloured square',
    album_id: ps.albumId, width: 3, height: 2, bytes: 120, taken_at: '2026-10-13T09:15' });
  expectStatus(add, 200, 'add photo');
  const p = add.data.photo;
  ps.photo = p;
  expect(p.url === fields.url && p.thumb_url === fields.thumb_url && p.album_id === ps.albumId && p.album_name === 'Smoke Brunch Album'
    && p.note === 'Smoke brunch special' && p.taken_at === '2026-10-13T09:15' && p.width === 3 && p.uploaded_by_name
    && Array.isArray(p.in_use) && !p.in_use.length && /Z$/.test(p.created_at), `photo shape ${JSON.stringify(p)}`);
  const again = await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, fields);
  expect(again.status === 409 && again.data.code === 'already_in_library', `the same photo twice: ${again.status}`);
  expectStatus(await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { url: 'javascript:alert(1)' }), 400, 'a script link');
  expectStatus(await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { url: 'https://example.com/x.jpg', taken_at: 'yesterday' }), 400, 'a bad date taken');
  if (ps.files.length) {
    const elsewhere = ps.other || 'blanc';
    const theirs = await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { url: `/api/media/uploads/${elsewhere}/1-x.png`, r2_key: `uploads/${elsewhere}/1-x.png` });
    expectStatus(theirs, 400, 'a file of another business');
    expectStatus(await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { url: `/api/media/uploads/${ps.slug}/1-missing.png` }), 400, 'a file that was never uploaded');
  }
  if (ps.otherAlbumId) expectStatus(await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { url: 'https://example.com/y.jpg', album_id: ps.otherAlbumId }), 400, 'an album of another business');
  const link = await psApi('POST', `/api/admin/businesses/${ps.slug}/media`, { url: 'https://example.com/smoke/flyer.jpg', note: 'Smoke 50%_off flyer' });
  expectStatus(link, 200, 'a photo by link, with no album');
  ps.linkPhoto = link.data.photo;
  expect(ps.linkPhoto.thumb_url === ps.linkPhoto.url && ps.linkPhoto.album_id === null, 'no thumbnail: thumb_url is the photo itself');

  const listed = await psApi('GET', `/api/admin/businesses/${ps.slug}/media`);
  expectStatus(listed, 200, 'list');
  const ids = listed.data.photos.map((x) => x.id);
  expect(ids.includes(ps.linkPhoto.id) && ids.indexOf(p.id) > ids.indexOf(ps.linkPhoto.id), 'newest first');
  expect(listed.data.albums.find((a) => a.id === ps.albumId)?.count === 1 && listed.data.total >= 2 && listed.data.no_album >= 1, `counts ${JSON.stringify({ ...listed.data, photos: undefined })}`);
  const inAlbum = (await psApi('GET', `/api/admin/businesses/${ps.slug}/media?album_id=${ps.albumId}`)).data.photos.map((x) => x.id);
  expect(JSON.stringify(inAlbum) === JSON.stringify([p.id]), 'album filter');
  const none = (await psApi('GET', `/api/admin/businesses/${ps.slug}/media?album_id=none`)).data.photos.map((x) => x.id);
  expect(none.includes(ps.linkPhoto.id) && !none.includes(p.id), '"No album" filter');
  expectStatus(await psApi('GET', `/api/admin/businesses/${ps.slug}/media?album_id=abc`), 400, 'a bad album filter');
  const search = async (q, path = `/api/admin/businesses/${ps.slug}/media`) => (await psApi('GET', `${path}?q=${encodeURIComponent(q)}`)).data.photos;
  expect(JSON.stringify((await search('brunch special')).map((x) => x.id)) === JSON.stringify([p.id]), 'search the note');
  expect((await search('Smoke Brunch Album')).some((x) => x.id === p.id), 'search the album name');
  expect(JSON.stringify((await search('50%_off')).map((x) => x.id)) === JSON.stringify([ps.linkPhoto.id]), '% and _ are matched literally');
  const page1 = (await psApi('GET', `/api/admin/businesses/${ps.slug}/media?limit=1`)).data;
  expect(page1.photos.length === 1 && page1.next_before === page1.photos[0].id, `page 1: ${JSON.stringify(page1.next_before)}`);
  const page2 = (await psApi('GET', `/api/admin/businesses/${ps.slug}/media?limit=1&before=${page1.next_before}`)).data;
  expect(page2.photos.length === 1 && page2.photos[0].id < page1.photos[0].id, 'page 2');
  const everywhere = await search('Smoke brunch special', '/api/admin/media');
  expect(everywhere.length === 1 && everywhere[0].business_slug === ps.slug && everywhere[0].business_name, 'search across businesses');
  return ps.files.length ? 'with uploaded files' : 'links only (MEDIA is not bound)';
});

await step('Photo library: move to another business and back; in use → 409; delete removes the files', async () => {
  needPhotos();
  if (ps.other) {
    const moved = await psApi('PATCH', `/api/admin/media/${ps.photo.id}`, { business_slug: ps.other, note: 'Smoke brunch special (moved)' });
    expectStatus(moved, 200, 'move');
    expect(moved.data.photo.business_slug === ps.other && moved.data.photo.album_id === null && moved.data.photo.note === 'Smoke brunch special (moved)', `moved: ${JSON.stringify(moved.data.photo)}`);
    const hist = (await psApi('GET', `/api/admin/businesses/${ps.slug}/history?limit=5`)).data.entries;
    expect(hist.some((e) => e.entity === 'photo' && /^Moved photo 'Smoke brunch special' to the photo library of .+ and changed its note$/.test(e.summary)), 'History says where it went');
    expectStatus(await psApi('PATCH', `/api/admin/media/${ps.photo.id}`, { business_slug: ps.slug, album_id: ps.otherAlbumId }), 400, 'an album of the business it is leaving');
    expectStatus(await psApi('PATCH', `/api/admin/media/${ps.photo.id}`, { business_slug: 'no-such-business' }), 404, 'an unknown business');
    const back = await psApi('PATCH', `/api/admin/media/${ps.photo.id}`, { business_slug: ps.slug, album_id: ps.albumId, note: 'Smoke brunch special' });
    expectStatus(back, 200, 'move back into its album');
    expect(back.data.photo.business_slug === ps.slug && back.data.photo.album_id === ps.albumId, 'back home');
  }
  // An event uses the photo, its link written as a path (the library has it absolute); an announcement uses the other.
  const link = ps.files.length ? `/api/media/${ps.files[0]}` : ps.photo.url;
  const ev = await psApi('POST', `/api/admin/businesses/${ps.slug}/events`, { title: 'Smoke photo event', start_date: chicagoToday(30), image_url: link, published: false });
  expectStatus(ev, 200, 'event with the photo');
  ps.eventId = ev.data.event.id;
  const news = await psApi('POST', `/api/admin/businesses/${ps.slug}/announcements`, { title: 'Smoke photo news', image_url: ps.linkPhoto.url, published: false });
  expectStatus(news, 200, 'announcement with the link photo');
  ps.announcementId = news.data.announcement.id;
  const listed = (await psApi('GET', `/api/admin/businesses/${ps.slug}/media`)).data.photos;
  const used = listed.find((x) => x.id === ps.photo.id).in_use;
  expect(used.length === 1 && used[0].kind === 'event' && used[0].id === ps.eventId && used[0].title === 'Smoke photo event', `in_use: ${JSON.stringify(used)}`);
  expect(listed.find((x) => x.id === ps.linkPhoto.id).in_use[0]?.kind === 'announcement', 'the announcement counts too');
  const blocked = await psApi('DELETE', `/api/admin/media/${ps.photo.id}`);
  expect(blocked.status === 409 && blocked.data.code === 'in_use' && blocked.data.in_use[0]?.id === ps.eventId
    && blocked.data.error.includes("the event 'Smoke photo event'"), `delete while in use: ${blocked.status} ${JSON.stringify(blocked.data)}`);
  if (ps.files.length) expect((await fetch(`${BASE}/api/media/${ps.files[0]}`)).status === 200, 'the file is still there');
  expectStatus(await psApi('PATCH', `/api/admin/events/${ps.eventId}`, { image_url: null }), 200, 'take the photo off the event');
  expectStatus(await psApi('DELETE', `/api/admin/media/${ps.photo.id}`), 200, 'delete');
  for (const key of ps.files) expect((await fetch(`${BASE}/api/media/${key}`)).status === 404, `file ${key} is gone from storage`);
  expectStatus(await psApi('DELETE', `/api/admin/media/${ps.photo.id}`), 404, 'already gone');
  const hist = (await psApi('GET', `/api/admin/businesses/${ps.slug}/history?limit=5`)).data.entries;
  expect(hist.some((e) => e.entity === 'photo' && e.action === 'delete' && e.summary === "Deleted photo 'Smoke brunch special' from the photo library"), 'History: the delete');
  return ps.files.length ? 'both files deleted from R2' : 'links only';
});

await step('TV screens: add, list with the settings, rename', async () => {
  expect(ps.token, 'needs the sign-in step, which failed');
  const before = await psApi('GET', `/api/admin/businesses/${ps.slug}/screens`);
  expectStatus(before, 200, 'list');
  const s = before.data.settings;
  ps.tv = s;
  ps.tvRaw = (await psApi('GET', `/api/admin/settings/signage:${ps.slug}`)).data.value;
  expect(Number.isInteger(s.seconds_per_scene) && Number.isInteger(s.refresh_version)
    && ['welcome', 'notice', 'announcements', 'featured', 'menu', 'catering', 'events', 'artworks'].every((k) => typeof s.scenes[k] === 'boolean'), `settings shape ${JSON.stringify(s)}`);
  const add = await psApi('POST', `/api/admin/businesses/${ps.slug}/screens`, { name: 'Smoke counter TV', notes: 'Above the register' });
  expectStatus(add, 200, 'add');
  const tv = add.data.screen;
  ps.screen = tv;
  expect(/^[a-z0-9]{12}$/.test(tv.id) && tv.status === 'never' && tv.last_seen_at === null, `new screen ${JSON.stringify(tv)}`);
  expect(/^https?:\/\//.test(tv.player_url) && tv.player_url.endsWith(`/signage/live.html?business=${ps.slug}&screen=${tv.id}`) && !tv.preview_url.includes('screen='), 'player link, and a preview link that sends no heartbeats');
  expectStatus(await psApi('POST', `/api/admin/businesses/${ps.slug}/screens`, { name: '' }), 400, 'a name is needed');
  const renamed = await psApi('PATCH', `/api/admin/screens/${tv.id}`, { name: 'Smoke front TV' });
  expectStatus(renamed, 200, 'rename');
  expect(renamed.data.screen.name === 'Smoke front TV' && renamed.data.screen.notes === 'Above the register', 'renamed, notes kept');
  expect((await psApi('GET', `/api/admin/businesses/${ps.slug}/screens`)).data.screens.some((x) => x.id === tv.id && x.name === 'Smoke front TV'), 'listed');
  expectStatus(await psApi('PATCH', '/api/admin/screens/nosuchscreen1', { name: 'x' }), 404, 'unknown screen');
  const hist = (await psApi('GET', `/api/admin/businesses/${ps.slug}/history?limit=5`)).data.entries;
  expect(hist.some((e) => e.entity === 'screen' && e.summary === "Changed name of the TV screen 'Smoke counter TV'"), 'History: the rename');
  return tv.id;
});

await step('TV screens: heartbeat → online (one per 20 s), refresh bumps the version, scene switches reach the TV', async () => {
  needScreen();
  const id = ps.screen.id;
  const v0 = ps.tv.refresh_version;
  const first = await beat(id, { scene: 'menu-12', version: String(v0) });
  expectStatus(first, 200, 'heartbeat');
  expect(first.data.refresh_version === v0 && first.data.seconds_per_scene === ps.tv.seconds_per_scene, `heartbeat answer ${JSON.stringify(first.data)}`);
  expect(first.headers.get('access-control-allow-origin') === '*', 'any origin may send it');
  const second = await beat(id);
  expect(second.status === 429 && second.data.code === 'rate_limited' && second.headers.get('retry-after') === '20', `a second one within 20 s: ${second.status} ${JSON.stringify(second.data)}`);
  expectStatus(await beat('zzzzzzzzzzzz'), 404, 'unknown screen');
  expectStatus(await beat('NOT-AN-ID!'), 404, 'not a screen id');
  const online = (await psApi('GET', `/api/admin/businesses/${ps.slug}/screens`)).data.screens.find((x) => x.id === id);
  expect(online.status === 'online' && online.last_scene === 'menu-12' && online.last_version === String(v0)
    && Math.abs(Date.now() - Date.parse(online.last_seen_at)) < 120000, `online: ${JSON.stringify(online)}`);
  // Refresh: the version goes up by one and nothing else changes; the TV bundle and every next heartbeat carry it.
  const refreshed = await psApi('POST', `/api/admin/businesses/${ps.slug}/screens/refresh`);
  expectStatus(refreshed, 200, 'refresh');
  const v = v0 + 1;
  expect(refreshed.data.refresh_version === v && refreshed.data.settings.refresh_version === v && refreshed.data.settings.seconds_per_scene === ps.tv.seconds_per_scene, `refresh answer ${JSON.stringify(refreshed.data)}`);
  const raw = (await psApi('GET', `/api/admin/settings/signage:${ps.slug}`)).data.value;
  expect(raw.refresh_version === v && Object.keys(ps.tvRaw).every((k) => k === 'refresh_version' || JSON.stringify(raw[k]) === JSON.stringify(ps.tvRaw[k])), 'only refresh_version changed in the stored setting');
  expect((await publicGet(`/api/public/signage/${ps.slug}`)).data.signage.refresh_version === v, 'the TV bundle carries the new version');
  const other = await psApi('POST', `/api/admin/businesses/${ps.slug}/screens`, { name: 'Smoke back TV' });
  expectStatus(other, 200, 'second screen');
  ps.screen2 = other.data.screen;
  const told = await beat(ps.screen2.id, { scene: 'welcome', version: String(v0) });
  expect(told.status === 200 && told.data.refresh_version === v, 'the next heartbeat says "reload"');
  const hist = (await psApi('GET', `/api/admin/businesses/${ps.slug}/history?limit=5`)).data.entries;
  expect(hist.some((e) => e.entity === 'screen' && /^Asked every TV screen of .+ to reload$/.test(e.summary)), 'History: the refresh');
  // Scene switches saved through the settings route show in the screens list and in the TV bundle.
  const scenes = { ...refreshed.data.settings.scenes, menu: false, notice: false };
  expectStatus(await psApi('PUT', `/api/admin/settings/signage:${ps.slug}`, { value: { ...refreshed.data.settings, scenes } }), 200, 'save the switches');
  const after = (await psApi('GET', `/api/admin/businesses/${ps.slug}/screens`)).data.settings;
  expect(after.scenes.menu === false && after.scenes.notice === false && after.scenes.welcome === true && after.refresh_version === v, `switches: ${JSON.stringify(after)}`);
  expect((await publicGet(`/api/public/signage/${ps.slug}`)).data.signage.scenes.menu === false, 'the TV bundle has the switches');
  // A screen not heard from for more than 10 minutes is offline (needs the local database to backdate it).
  if (!PERSIST) return 'offline check skipped (SMOKE_PERSIST_TO not set)';
  await localSql(`UPDATE screens SET last_seen_at = datetime('now', '-11 minutes') WHERE id = '${id}'`);
  const stale = (await psApi('GET', `/api/admin/businesses/${ps.slug}/screens`)).data.screens.find((x) => x.id === id);
  expect(stale.status === 'offline', `offline after 11 minutes: ${stale.status}`);
  expectStatus(await beat(id), 200, 'a heartbeat after the gap counts again');
  return 'offline checked';
});

await step('Photo library and TV screens: an editor of another business is blocked', async () => {
  needPhotos();
  needScreen();
  if (!ps.other) return 'skipped (only one business)';
  const email = `smoke-media-editor-${Date.now()}@example.com`;
  const made = await psApi('POST', '/api/admin/users', { email, name: 'Smoke Media Editor', role: 'editor', businesses: [ps.other], password: 'smoke-media-pass-1' });
  expectStatus(made, 200, 'create editor');
  ps.editorId = made.data.user.id;
  const login = await api('POST', '/api/auth/login', { email, password: 'smoke-media-pass-1' }, { auth: null });
  expectStatus(login, 200, 'editor login');
  const as = (method, path, body) => psApi(method, path, body, login.data.token);
  const blocked = [
    ['GET', `/api/admin/businesses/${ps.slug}/media`], ['POST', `/api/admin/businesses/${ps.slug}/media`, { url: 'https://example.com/e.jpg' }],
    ['PATCH', `/api/admin/media/${ps.linkPhoto.id}`, { note: 'nope' }], ['DELETE', `/api/admin/media/${ps.linkPhoto.id}`],
    ['GET', `/api/admin/businesses/${ps.slug}/albums`], ['POST', `/api/admin/businesses/${ps.slug}/albums`, { name: 'Nope' }],
    ['PATCH', `/api/admin/albums/${ps.albumId}`, { name: 'Nope' }], ['DELETE', `/api/admin/albums/${ps.albumId}`],
    ['GET', `/api/admin/businesses/${ps.slug}/screens`], ['POST', `/api/admin/businesses/${ps.slug}/screens`, { name: 'Nope' }],
    ['PATCH', `/api/admin/screens/${ps.screen.id}`, { name: 'Nope' }], ['DELETE', `/api/admin/screens/${ps.screen.id}`],
    ['POST', `/api/admin/businesses/${ps.slug}/screens/refresh`],
  ];
  for (const [method, path, body] of blocked) expectStatus(await as(method, path, body), 403, `${method} ${path}`);
  // Their own business works, but a photo of theirs cannot move into a business they cannot edit.
  const own = await as('POST', `/api/admin/businesses/${ps.other}/media`, { url: 'https://example.com/smoke/editor.jpg', note: 'Smoke editor photo' });
  expectStatus(own, 200, 'editor adds a photo to their business');
  const move = await as('PATCH', `/api/admin/media/${own.data.photo.id}`, { business_slug: ps.slug });
  expect(move.status === 403 && /businesses you can edit/.test(move.data.error), `move out: ${move.status} ${JSON.stringify(move.data)}`);
  const mine = (await as('GET', `/api/admin/media?q=${encodeURIComponent('Smoke')}`)).data.photos;
  expect(mine.length >= 1 && mine.every((x) => x.business_slug === ps.other), 'their search covers only their business');
  expectStatus(await as('GET', `/api/admin/businesses/${ps.other}/screens`), 200, 'their own screens');
  expectStatus(await as('DELETE', `/api/admin/media/${own.data.photo.id}`), 200, 'delete their own photo');
  expectStatus(await as('POST', '/api/auth/logout'), 200, 'editor logout');
  return `editor limited to ${ps.other}`;
});

await step('Photo library and TV screens: deleting an album keeps its photos; cleanup and sign out', async () => {
  const errors = [];
  const del = async (path) => { const r = await psApi('DELETE', path); if (r.status !== 200) errors.push(`${path} → ${r.status}`); return r; };
  if (ps.albumId && ps.linkPhoto) {
    expectStatus(await psApi('PATCH', `/api/admin/media/${ps.linkPhoto.id}`, { album_id: ps.albumId }), 200, 'put the link photo in the album');
    const gone = await del(`/api/admin/albums/${ps.albumId}`);
    expect(gone.data?.photos_moved === 1, `photos_moved: ${JSON.stringify(gone.data)}`);
    const kept = (await psApi('GET', `/api/admin/businesses/${ps.slug}/media?album_id=none`)).data.photos.find((x) => x.id === ps.linkPhoto.id);
    expect(kept && kept.album_id === null && kept.album_name === null, 'the photo stays, with no album');
    ps.albumId = null;
  }
  if (ps.announcementId) await del(`/api/admin/announcements/${ps.announcementId}`);
  if (ps.linkPhoto) await del(`/api/admin/media/${ps.linkPhoto.id}`);
  if (ps.albumId) await del(`/api/admin/albums/${ps.albumId}`);
  if (ps.otherAlbumId) await del(`/api/admin/albums/${ps.otherAlbumId}`);
  if (ps.eventId) await del(`/api/admin/events/${ps.eventId}`);
  for (const tv of [ps.screen, ps.screen2]) if (tv) await del(`/api/admin/screens/${tv.id}`);
  if (ps.screen) expectStatus(await beat(ps.screen.id), 404, 'a removed screen cannot report in');
  if (ps.editorId) await del(`/api/admin/users/${ps.editorId}`);
  if (ps.tvRaw) {
    const r = await psApi('PUT', `/api/admin/settings/signage:${ps.slug}`, { value: ps.tvRaw });
    if (r.status !== 200) errors.push(`TV settings → ${r.status}`);
  }
  expectStatus(await psApi('POST', '/api/auth/logout'), 200, 'logout');
  expect(!errors.length, errors.join('; '));
});

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
