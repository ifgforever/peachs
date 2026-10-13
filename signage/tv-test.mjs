// Live screen check: serves the repo plus a fake /api from the public fixture, then drives
// signage/live.html with Playwright at 1920x1080, screenshots every scene, and proves the page
// keeps showing cached data when the API goes away.
//
//   node signage/tv-test.mjs [--out <dir>] [--keep]
//
// --keep leaves the server running after the checks so you can open the printed URL yourself.
// Google Fonts are cached on disk (via curl) and served to the test browser so the screenshots
// use the real brand fonts even on machines where Chromium has no direct internet access.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(argv[outArg + 1]) : path.join(tmpdir(), 'rj-tv-test');
const KEEP = argv.includes('--keep');
const FONT_CACHE = path.join(OUT, 'fonts-cache');
const AT = '2026-10-14T10:30'; // a Wednesday at 10:30 am: "Open now · until 2 pm"

/* -------------------------------------------------------------------------
   Fake API, from docs/fixtures/public-peachs.json
   ------------------------------------------------------------------------- */
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'docs/fixtures/public-peachs.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const FAMILY = [
  { slug: 'romesjoy', name: "Rome's Joy Companies", tagline: "Chef Cliff Rome's family of Bronzeville businesses", hours_summary: 'Mon – Fri · 9 am – 5 pm' },
  { slug: 'peachs', name: fixture.business.name, tagline: fixture.business.tagline, hours_summary: fixture.hours_summary },
  { slug: 'catering', name: "Rome's Joy Catering", tagline: 'Full-service catering and event planning from Bronzeville', hours_summary: 'Closed' },
  { slug: 'parkway-social', name: 'Parkway Social', tagline: 'Coworking lounge, social club and event space', hours_summary: 'Mon – Fri · 9 am – 5 pm' },
  { slug: 'mise-en-place', name: 'Mise En Place Chicago', tagline: 'Investing in our future before they step up to the plate', hours_summary: 'Closed' },
  { slug: 'blanc', name: 'Blanc Gallery', tagline: 'A Culture of Conversation', hours_summary: 'Sat & Sun · 11 am – 3 pm' },
  { slug: 'rjc-sausage', name: 'R.J.C. Sausage Company', tagline: 'Small-batch sausage from Bronzeville', hours_summary: 'Closed' },
];

function signageBundle() {
  const b = clone(fixture);
  // A third, long-titled family-wide announcement and a wider menu exercise the layouts.
  b.announcements = b.announcements.map((a, i) => ({ ...a, business_slug: i === 0 ? null : 'peachs', show_on_tv: true }));
  b.announcements.push({
    id: 3, business_slug: 'peachs', title: 'FIXTURE: Gift cards for the holidays are here, in any amount, at the counter', body: 'Breakfast makes a good present. Ask your server or stop by the register on your way out; e-gift cards are on the website too.', link_url: 'https://peachson47th.com/#gifts', link_label: 'Gift cards', image_url: null, starts_at: '2026-10-01', ends_at: '2026-12-31', show_on_tv: true,
  });
  b.announcements.push({ id: 4, business_slug: 'peachs', title: 'FIXTURE: Web-only note', body: 'Should not appear on the TV.', link_url: null, link_label: null, image_url: null, starts_at: '2026-10-01', ends_at: null, show_on_tv: false });
  const plates = b.menu.sections[0];
  plates.items.push(
    { id: 13, name: "Peach's Shrimp & Grits", portion: null, price: 24, prices: null, description: 'Sautéed shrimp over creamy cheese grits with a Cajun cream sauce', tags: [], allergens: ['Shellfish'], featured: true },
    { id: 14, name: 'Salmon Croquettes & Grits', portion: null, price: 23, prices: null, description: 'Two croquettes, a cup of grits and two eggs any style', tags: [], allergens: [], featured: true },
    { id: 15, name: 'Chicken & Waffles', portion: null, price: 19, prices: null, description: null, tags: [], allergens: [], featured: false },
    { id: 16, name: 'Steak & Eggs', portion: '8 oz', price: 28, prices: null, description: null, tags: ['GF'], allergens: [], featured: false },
    { id: 17, name: 'Veggie Omelette', portion: null, price: 15, prices: null, description: null, tags: ['V', 'GF'], allergens: [], featured: false },
    { id: 18, name: 'Avocado Toast', portion: null, price: 11, prices: null, description: 'Add an egg 3.50', tags: ['V'], allergens: [], featured: false },
    { id: 19, name: 'Hangover Chicken Wings', portion: 'with fries', price: 17, prices: null, description: null, tags: [], allergens: [], featured: false },
    { id: 20, name: 'Biscuits & Gravy', portion: null, price: 12.5, prices: null, description: null, tags: [], allergens: [], featured: false },
    { id: 21, name: 'Oatmeal with Brown Sugar & Fruit', portion: null, price: 9, prices: null, description: null, tags: ['V', 'DF'], allergens: [], featured: false },
    { id: 22, name: 'Catfish & Eggs', portion: null, price: 21, prices: null, description: null, tags: [], allergens: [], featured: false },
    { id: 23, name: 'Turkey Sausage Scramble', portion: null, price: 16, prices: null, description: null, tags: [], allergens: [], featured: false },
    { id: 24, name: 'Fruit Bowl', portion: null, price: 8, prices: null, description: null, tags: ['V', 'GF', 'DF'], allergens: [], featured: false },
  );
  b.menu.sections[1].items.push(
    { id: 25, name: 'Banana Rum French Toast', portion: '6 wedges', price: 14, prices: null, description: 'Six wedges of French toast under our banana rum topping', tags: ['V'], allergens: ['Dairy', 'Wheat', 'Egg'], featured: true },
    { id: 26, name: 'Peach Bourbon French Toast', portion: null, price: 15, prices: null, description: null, tags: ['V'], allergens: ['Dairy', 'Wheat', 'Egg'], featured: false },
  );
  b.signage = { seconds_per_scene: 10 };
  b.family = FAMILY;
  return b;
}

function cateringBundle() {
  const b = clone(fixture);
  Object.assign(b.business, {
    slug: 'catering', name: "Rome's Joy Catering", short_name: 'Catering', tagline: 'Full-service catering and event planning from Bronzeville',
    phone: '773.373.4320', phone_href: 'tel:+17733734320', public_email: 'ordering@romesjoy.com', website_url: 'https://romesjoy.com/catering/',
    instagram_url: 'https://www.instagram.com/rjc.events/', notice: null,
  });
  b.business.address = { line1: '4455 S. King Drive', line2: null, city: 'Chicago', state: 'IL', zip: '60653', formatted: '4455 S. King Drive, Chicago, IL 60653' };
  b.hours = b.hours.map((h) => ({ ...h, closed: true, open_min: null, close_min: null, open: null, close: null, text: 'Closed' }));
  b.hours_summary = 'Closed';
  b.open_now = { open: false, text: 'Closed today', checked_at: b.generated_at };
  b.announcements = [];
  b.events = { current: [], upcoming: [], past: [] };
  b.menu.sections = [
    { id: 206, title: 'Signature full pans', short_title: 'Full pans', description: 'Half pans feed 10–12', items: [
      { id: 2601, name: 'Pancakes', portion: 'half pan · 12 pcs', price: 36, prices: null, description: null, tags: ['V'], allergens: [], featured: true },
      { id: 2602, name: 'Salmon Croquettes', portion: 'half pan · 12 pcs', price: 76, prices: null, description: null, tags: [], allergens: [], featured: true },
      { id: 2603, name: 'Chicken Wings', portion: 'half pan · 24 pcs', price: 73, prices: null, description: null, tags: [], allergens: [], featured: false },
      { id: 2604, name: 'Cheese Grits', portion: 'half pan', price: 35, prices: null, description: null, tags: ['V', 'GF'], allergens: [], featured: false },
      { id: 2605, name: 'Peach Cobbler', portion: 'half pan', price: 60, prices: null, description: null, tags: ['V'], allergens: [], featured: true },
    ] },
    { id: 205, title: 'Brunch', short_title: 'Brunch', description: 'Per person · minimum 10 orders', items: [
      { id: 2501, name: 'Brunch box', portion: 'per person', price: null, prices: [{ label: 'Classic', value: 18 }, { label: 'Deluxe', value: 24 }], description: null, tags: [], allergens: [], featured: false },
      { id: 2502, name: 'Shrimp & Grits', portion: 'per person', price: 21, prices: null, description: null, tags: [], allergens: ['Shellfish'], featured: false },
    ] },
  ];
  return b;
}

function blancBundle() {
  const b = clone(fixture);
  Object.assign(b.business, {
    slug: 'blanc', name: 'Blanc Gallery', short_name: 'Blanc', tagline: 'A Culture of Conversation', phone: '773.373.4320', phone_href: 'tel:+17733734320',
    public_email: null, website_url: 'https://blancchicago.com/', instagram_url: 'https://www.instagram.com/blancgallerychicago/', notice: null,
  });
  b.business.address = { line1: '4445 S. King Drive', line2: null, city: 'Chicago', state: 'IL', zip: '60653', formatted: '4445 S. King Drive, Chicago, IL 60653' };
  b.hours_summary = 'Sat & Sun · 11 am – 3 pm';
  b.announcements = [];
  b.menu = { sections: [] };
  b.events = {
    current: [{ id: 1, kind: 'exhibition', title: 'What Shall I Do With My Dead?', subtitle: 'Edra Soto, Cecil McDonald Jr. and Dawn Mosley', description: 'A group exhibition on memory, loss and what we keep.', start_date: '2026-10-24', end_date: '2026-12-05', start_time: null, end_time: null, date_text: 'Oct 24 – Dec 5, 2026', time_text: null, location: 'Blanc Gallery', link_url: 'https://blancchicago.com/', link_label: 'Exhibition page', image_url: '/blanc/img/whatshall.webp', featured: true, status: 'current' }],
    upcoming: [{ id: 2, kind: 'event', title: 'Artist talk', subtitle: null, description: null, start_date: '2026-11-14', end_date: null, start_time: '13:00', end_time: '15:00', date_text: 'Nov 14, 2026', time_text: '1–3 pm', location: 'Blanc Gallery', link_url: null, link_label: null, image_url: null, featured: false, status: 'upcoming' }],
    past: [],
  };
  return b;
}

const API = {
  '/api/public/signage/peachs': signageBundle,
  '/api/public/catering': cateringBundle,
  '/api/public/blanc': blancBundle,
};

/* -------------------------------------------------------------------------
   Static server (repo files + fake API)
   ------------------------------------------------------------------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const make = API[url.pathname];
    res.writeHead(make ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
    res.end(JSON.stringify(make ? make() : { error: 'Not found', code: 'not_found' }));
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/\/$/, '/index.html');
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const PAGE = `${ORIGIN}/signage/live.html?api=${encodeURIComponent(ORIGIN)}&at=${AT}`;
await mkdir(OUT, { recursive: true });
await mkdir(FONT_CACHE, { recursive: true });
console.log('serving', ORIGIN, '→', OUT);

/* -------------------------------------------------------------------------
   Google Fonts: fetch once with curl, serve from disk
   ------------------------------------------------------------------------- */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let fontMisses = 0;
async function fontRoute(route) {
  const url = route.request().url();
  const key = createHash('sha1').update(url).digest('hex') + (url.includes('.woff2') ? '.woff2' : '.css');
  const file = path.join(FONT_CACHE, key);
  if (!existsSync(file)) {
    try {
      await writeFile(file, execFileSync('curl', ['-sSL', '--fail', '--max-time', '20', '-A', UA, url], { maxBuffer: 16 * 1024 * 1024 }));
    } catch (e) {
      fontMisses++;
      return route.continue();
    }
  }
  return route.fulfill({ status: 200, contentType: key.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2', body: await readFile(file), headers: { 'Access-Control-Allow-Origin': '*' } });
}

/* -------------------------------------------------------------------------
   Browser checks
   ------------------------------------------------------------------------- */
const browser = await chromium.launch();
const problems = [];
const shots = [];
let shotN = 0;
const shot = async (page, name) => {
  const file = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
};

/** A page that records console errors and uncaught exceptions. `apiDown` aborts every /api/ call. */
async function openPage(context, { apiDown = false } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, fontRoute);
  if (apiDown) await page.route('**/api/**', (route) => route.abort('connectionfailed'));
  page.errors = errors;
  return page;
}
const waitReady = (page) => page.waitForFunction(() => window.__tvReady === true, null, { timeout: 30000 });
const settle = (page) => page.waitForTimeout(1400); // the cross-fade is 900ms plus the content rise

try {
  /* ---- 1. Online: every scene, no errors ---- */
  const online = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await openPage(online);
  await page.goto(PAGE, { waitUntil: 'load' });
  await waitReady(page);
  await page.evaluate(() => document.fonts.ready);
  const scenes = await page.evaluate(() => window.__tv.scenes());
  console.log('scenes:', scenes.join(', '));
  const expected = ['welcome', 'notice', 'announcement-1', 'announcement-2', 'announcement-3', 'featured-1', 'featured-2', 'menu-1-1', 'menu-1-2', 'menu-2', 'catering', 'events', 'closing'];
  assert.deepEqual(scenes, expected, 'scene plan');
  assert.equal(await page.evaluate(() => window.__tv.state().source), 'network');
  assert.equal(await page.evaluate(() => document.getElementById('brand').classList.contains('is-on')), false, 'brand screen hidden once data is in');

  for (const id of scenes) {
    await page.evaluate((sid) => window.__tv.goto(sid), id);
    await settle(page);
    assert.equal(await page.evaluate(() => window.__tv.current()), id);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#scenes .scene.is-on').length), 1, 'exactly one scene on');
    if (id === 'welcome') {
      const txt = await page.evaluate(() => document.querySelector('#scenes .scene.is-on').textContent);
      assert.match(txt, /Open now · until 2 pm/, 'open status computed from the frozen clock');
      assert.match(txt, /Today · 8 am – 2 pm/, "today's hours");
      assert.match(txt, /@peachson47th/, 'instagram handle');
    }
    if (id === 'events') {
      const txt = await page.evaluate(() => document.querySelector('#scenes .scene.is-on').textContent);
      assert.match(txt, /At Blanc Gallery/, 'family event from the Blanc bundle');
      assert.match(txt, /Holiday brunch tasting/, 'own upcoming event');
    }
    await shot(page, id);
  }
  // Nothing from the API may reach innerHTML: a title with markup must render as text.
  await page.evaluate(() => { const s = document.querySelector('#scenes .scene.is-on'); return s && s.querySelector('script, iframe, img[src^="javascript"]'); }).then((bad) => assert.equal(bad, null));
  await page.keyboard.press('d');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.getElementById('debug').hidden), false, 'debug overlay opens with d');
  await shot(page, 'debug');
  await page.keyboard.press('d');

  // HUD shows the clock and freshness.
  const hud = await page.evaluate(() => ({ clock: document.querySelector('[data-hud-clock]').textContent, updated: document.querySelector('[data-hud-updated]').textContent }));
  assert.equal(hud.clock, '10:30 am');
  assert.match(hud.updated, /^updated /);

  /* ---- 2. API goes down mid-run: forced refresh keeps the cached data ---- */
  await page.route('**/api/**', (route) => route.abort('connectionfailed'));
  const ok = await page.evaluate(() => window.__tv.refresh());
  assert.equal(ok, false, 'refresh reports failure');
  const after = await page.evaluate(() => window.__tv.state());
  assert.ok(after.lastError, 'error recorded');
  assert.ok(after.hasData, 'data kept');
  await page.evaluate(() => window.__tv.goto('welcome'));
  await settle(page);
  assert.match(await page.evaluate(() => document.querySelector('#scenes .scene.is-on').textContent), /Peach's on 47th|@peachson47th/);
  await shot(page, 'offline-after-refresh');
  const cacheKeys = await page.evaluate(() => Object.keys(localStorage));
  assert.ok(cacheKeys.includes('romesjoy-tv:peachs'), 'bundle cached in localStorage');
  assert.deepEqual(page.errors, [], 'no console errors online');

  /* ---- 3. Reload with the API down: cached bundle comes back ---- */
  const page2 = await openPage(online, { apiDown: true });
  await page2.goto(PAGE, { waitUntil: 'load' });
  await waitReady(page2);
  const s2 = await page2.evaluate(() => window.__tv.state());
  assert.equal(s2.source, 'cache');
  assert.ok(s2.lastError, 'the failed fetch is recorded');
  assert.ok((await page2.evaluate(() => window.__tv.scenes())).length >= 5, 'scenes planned from cache');
  assert.equal(await page2.evaluate(() => document.getElementById('brand').classList.contains('is-on')), false);
  await settle(page2);
  assert.match(await page2.evaluate(() => document.body.textContent), /Peach's on 47th/);
  await shot(page2, 'offline-from-cache');
  assert.deepEqual(page2.errors, [], 'no console errors from cache');
  await online.close();

  /* ---- 4. Nothing cached and no API: the brand screen stays up ---- */
  const cold = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page3 = await openPage(cold, { apiDown: true });
  await page3.goto(PAGE, { waitUntil: 'load' });
  await waitReady(page3);
  await page3.evaluate(() => document.fonts.ready);
  const s3 = await page3.evaluate(() => window.__tv.state());
  assert.equal(s3.source, 'none');
  assert.equal(await page3.evaluate(() => document.getElementById('brand').classList.contains('is-on')), true, 'brand screen on');
  assert.match(await page3.evaluate(() => document.getElementById('brand').textContent), /Peach's on 47th/);
  assert.match(await page3.evaluate(() => document.getElementById('brand').textContent), /4652 S\. King Drive/);
  await page3.waitForTimeout(300);
  await shot(page3, 'brand-no-data');
  assert.deepEqual(page3.errors, [], 'no console errors on the brand screen');

  /* ---- 5. Other resolutions: the stage scales to fit ---- */
  await page3.setViewportSize({ width: 1280, height: 720 });
  await page3.waitForTimeout(200);
  const scale = await page3.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tv-scale')));
  assert.ok(Math.abs(scale - 1280 / 1920) < 0.001, 'scale at 720p: ' + scale);
  await cold.close();

  /* ---- 6. Another business with no data: the brand screen uses its name ---- */
  const other = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page4 = await openPage(other, { apiDown: true });
  await page4.goto(PAGE.replace('live.html?', 'live.html?business=parkway-social&'), { waitUntil: 'load' });
  await waitReady(page4);
  assert.match(await page4.evaluate(() => document.getElementById('brand').textContent), /Parkway Social/);
  await other.close();
} catch (e) {
  problems.push(e);
} finally {
  await browser.close();
}

if (fontMisses) console.log(`note: ${fontMisses} font file(s) could not be fetched; screenshots use fallback fonts`);
console.log('screenshots:', shots.length, 'in', OUT);
if (problems.length) {
  console.error('FAILED:', problems[0].stack || problems[0]);
  if (!KEEP) { server.close(); process.exit(1); }
} else {
  console.log('OK');
}
if (KEEP) console.log('server still running at', PAGE, '(Ctrl+C to stop)');
else server.close();
