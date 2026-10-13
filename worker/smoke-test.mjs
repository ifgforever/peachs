#!/usr/bin/env node
// Rome's Joy admin: end-to-end smoke test against a running local server.
//   npx wrangler dev --local --port 8787        (in another terminal, after applying worker/schema.sql)
//   node worker/smoke-test.mjs [http://localhost:8787]
// Env: ADMIN_BOOTSTRAP_TOKEN (default local-dev-token), SMOKE_EMAIL / SMOKE_PASSWORD (the owner account it
// creates on an empty database, or logs in with when users already exist), SMOKE_SLUG (a business to use;
// defaults to the first one the owner may edit). Prints PASS/FAIL per step and exits 1 on any failure.
// Form posts carry a random CF-Connecting-IP so repeated runs do not trip the per-IP limit on a local server
// (Cloudflare replaces that header in production, so it has no effect there).

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

const chicagoToday = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/* ---------- state shared between steps ---------- */
const state = { slug: null, otherSlug: null, originalHours: null, businessEntryId: null, originalTagline: null,
  events: {}, sectionId: null, itemIds: [], announcementIds: [], inquiryId: null, editorId: null, editorToken: null, exceptionId: null };

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

await step('Cleanup: remove test rows', async () => {
  const errors = [];
  const tryDelete = async (path, auth = token) => { const r = await api('DELETE', path, undefined, { auth }); if (r.status !== 200) errors.push(`${path} → ${r.status}`); };
  if (state.sectionId) await tryDelete(`/api/admin/menu/sections/${state.sectionId}`);
  for (const id of state.announcementIds) await tryDelete(`/api/admin/announcements/${id}`);
  if (state.editorId) await tryDelete(`/api/admin/users/${state.editorId}`);
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

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
