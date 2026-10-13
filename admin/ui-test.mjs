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

/* -------------------------------------------------------------------------
   Fake API: in-memory data seeded from the public fixture
   ------------------------------------------------------------------------- */
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'docs/fixtures/public-peachs.json'), 'utf8'));
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
  };
  nextId = 2000;
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

const adminBusiness = (b) => ({ ...b, hours_summary: fixture.hours_summary, counts: { new_inquiries: db.inquiries.filter((q) => q.business_slug === b.slug && q.status === 'new').length, upcoming_events: db.events.filter((e) => e.business_slug === b.slug && eventStatus(e) === 'upcoming').length } });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const userId = m ? db.sessions.get(m[1]) : null;
  return userId ? db.users.find((u) => u.id === userId) : null;
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/auth\/status$/, (c) => json(c.res, 200, { has_users: db.users.length > 0, email_configured: false, media_configured: false }));
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
  if (!user) return fail(c.res, 401, 'Wrong email or password', 'bad_login');
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  db.sessions.set(token, user.id);
  user.last_login_at = now();
  json(c.res, 200, { token, user: publicUser(user) });
});
route('POST', /^\/api\/auth\/logout$/, (c) => json(c.res, 200, { ok: true }));
route('GET', /^\/api\/auth\/me$/, (c) => (c.user ? json(c.res, 200, { user: publicUser(c.user) }) : fail(c.res, 401, 'Not signed in', 'unauthorized')));
route('POST', /^\/api\/auth\/change-password$/, (c) => {
  if (!c.user) return fail(c.res, 401, 'Not signed in', 'unauthorized');
  if (c.user.password !== c.body.current_password) return fail(c.res, 400, 'Current password is wrong', 'bad_password');
  if (String(c.body.new_password || '').length < 8) return fail(c.res, 400, 'Password too short', 'bad_input');
  c.user.password = c.body.new_password;
  c.user.must_change_password = 0;
  json(c.res, 200, { ok: true });
});
route('GET', /^\/api\/public\/([a-z-]+)$/, (c) => (db.businesses.some((b) => b.slug === c.m[1]) ? json(c.res, 200, publicBundle(c.m[1])) : fail(c.res, 404, 'No such business', 'not_found')));

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
admin('POST', /^\/api\/admin\/media$/, (c) => fail(c.res, 501, 'Photo uploads are not configured', 'not_configured'));

/* -------------------------------------------------------------------------
   Static files + API dispatch
   ------------------------------------------------------------------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const apiCalls = [];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    apiCalls.push({ method: req.method, path: url.pathname, body });
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (m && r.method === req.method) return r.handler({ req, res, url, m, body, user: authUser(req) });
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
        problems.push(`[${name}] console: ${msg.text()} (${where})`);
      });
      page.on('pageerror', (err) => problems.push(`[${name}] page error: ${err.message}`));
      const shot = async (label) => {
        shots++;
        // Scroll to the top and drop stale toasts (the run is far faster than a person) so the picture shows the layout.
        await page.evaluate((keepToast) => { window.scrollTo(0, 0); if (!keepToast) document.querySelectorAll('.toast').forEach((t) => t.remove()); }, /saved/.test(label));
        await page.screenshot({ path: path.join(OUT, `${name}-${String(shots).padStart(2, '0')}-${label}.png`), fullPage: true });
      };
      // Phones show four items in the bottom bar; everything else is behind "More".
      const nav = async (id) => {
        const direct = page.locator(`[data-nav="${id}"]:visible`).first();
        if (await direct.count()) return direct.click();
        await page.click('button:has-text("More")');
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
      await shot('event-form');
      await page.click('button:has-text("Add event")');
      await toastSaved();
      await heading('Events').waitFor();
      await page.getByRole('tab', { name: /Upcoming/ }).click();
      await page.getByText(eventTitle).waitFor();
      await page.getByText('Dec 20, 2026 · 10 am – 2 pm · Peach’s patio').first().waitFor();
      assert.ok(db.events.some((e) => e.title === eventTitle && e.featured === 1 && e.published === 1));
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
        await page.click('button:has-text("More")');
        await page.getByRole('dialog').getByText('All pages').waitFor();
        await shot('more-sheet');
        await page.keyboard.press('Escape');
      }
      // Switch business and check the overview follows.
      await page.selectOption('#business-select', 'blanc');
      await heading('Users').waitFor(); // Users is not per business, so the page stays
      await nav('overview');
      await heading('Blanc Gallery').waitFor();
      await page.getByText('Usual week', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('rj_admin_business')), 'blanc');
      await page.selectOption('#business-select', 'peachs');
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
        assert.equal(await page.locator('#business-select option').count(), 1);
      }

      await context.close();
    }
  } catch (err) {
    // Keep a picture of where it went wrong.
    if (lastPage) await lastPage.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
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
