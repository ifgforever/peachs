// Rome's Joy sites: live content from the admin API (no build step, ES module, no dependencies).
//
// Every site loads this once:
//   <meta name="live-api" content="">                                 (empty = same origin)
//   <script type="module" src="…/assets/js/live.js" data-business="peachs"></script>
// It fetches GET {api}/api/public/{slug} (docs/admin-api.md) with a 4-second timeout and, on success,
// hydrates the page and caches the bundle in localStorage ("rj_live_" + slug) so the next visit paints
// from cache before refetching. On any failure it does nothing: the static HTML is the fallback, so a
// copy of the site with no API behind it (GitHub Pages) keeps working unchanged.
//
// Pages that need more (Peach's and Catering render their menus) import { initLive } and call
// initLive(slug, { renderMenu, onBundle }); the auto-init from the script tag and that call share one
// fetch. Form scripts import { sendInquiry, formFields, setBusy } (see "Forms" below).
//
// HYDRATION VOCABULARY (attributes on the page's own elements; the static text inside stays as fallback)
//
//   [data-live="<key> <key> …"]   one or more keys, from business or the bundle:
//     text keys  →  textContent:  phone · email · address · address-line1 · address-line2 · address-city
//                                 hours-summary · hours-note · tagline · name · short-name
//                   A null value leaves the static text alone, except hours-note and address-line2, which
//                   hide the element (a stale note is worse than none). data-live-prefix="…" is prepended.
//                   "email" also rewrites the href of the element's own or enclosing <a href="mailto:…">
//                   (keeping any ?subject=), so a span inside an icon button works.
//                   Every element that received a value gets data-live-set, a hook for CSS tweaks.
//     href keys  →  setAttribute('href'):  phone-href · order-url · book-url · instagram-url ·
//                                 facebook-url · map-url · website-url
//                   A null value hides the element. Only http(s), tel and mailto URLs are accepted.
//
//   [data-live-hours]             a <table> (rows go in its <tbody>) or a <dl>. Rows are rebuilt
//                                 Monday → Sunday as <tr data-day><th scope="row">label</th><td>text</td>
//                                 (or <div><dt><dd>), with .is-today + aria-current="date" on today's row
//                                 and .is-closed on closed days. A special day (bundle.exceptions) within
//                                 the coming week replaces that weekday's text ("Closed · Thanksgiving",
//                                 "9 am – 1 pm · Christmas Eve") and adds .is-exception.
//                                 data-live-hours="grouped" merges consecutive days with the same hours
//                                 ("Monday – Friday", "Sat & Sun"); a special day is never grouped.
//                                 data-closed-text="By appointment only" replaces "Closed" on usual
//                                 closed days (not on a special day).
//
//   [data-open-dot] [data-open-label] [data-open-text] [data-open-status]
//                                 open/closed right now: the dot and the status container get
//                                 .is-open / .is-closed, the label reads "Open now" or "Closed", the text
//                                 reads e.g. "Open now · until 2 pm" / "Closed · opens Wed 8 am".
//                                 Recomputed every minute from hours + exceptions in Chicago time.
//
//   [data-live-notice]            hidden until business.notice exists; [data-field="text"] inside gets
//                                 the notice. Hidden again once notice.until has passed.
//
//   [data-live-announcements]     container with a <template>; one clone per announcement, fields:
//                                 title · body · link (href + label) · image. Hidden when empty; a sibling
//                                 [data-live-announcements-empty] is shown instead.
//
//   [data-live-events="current|upcoming|past"]   (a comma list is allowed: "current,upcoming")
//                                 container with a <template>; one clone per event, fields:
//                                 title · subtitle · description · date_text · time_text · location ·
//                                 link · image · kind · status. data-live-limit / data-live-offset
//                                 slice the list. Hidden when empty; a sibling [data-live-events-empty]
//                                 is shown instead. Clone roots get .is-current/.is-upcoming/.is-past,
//                                 .is-featured and data-event-id (so a page script can add to one event).
//
//   Clone fields: [data-field="…"] inside the template. A null value hides the element, or its
//   [data-field-group] ancestor when it has one (so a <dt>/<dd> pair hides together). "link" on an <a>
//   sets href (and the text when the <a> has no child elements); without a URL the <a> is hidden, or,
//   when it carries data-link-keep (an <a> wrapping a whole card), it just loses its href. "image" on
//   an <img> sets src and alt; without one the <img> (or its <figure>) is hidden. "status" shows the
//   element's data-text-current / data-text-upcoming / data-text-past attribute.
//
//   [data-live-menu]              marks a page with a menu; bundle.menu is handed to options.renderMenu.
//
//   document receives a "live:hydrated" CustomEvent ({ slug, bundle, fromCache }) after each hydration.
//   A classic page script that loads after the first (cached) hydration can catch up with
//   import(liveScript.src).then((live) => live.liveBundle(slug)), then listen for the event.
//
// Every value goes in through textContent or setAttribute: API data never reaches innerHTML.

const CACHE_PREFIX = 'rj_live_';
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 4000;
const FORM_TIMEOUT = 10000;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'tel:', 'mailto:']);

const registry = new Map(); // slug → { slug, options, bundle, fromCache, promise, timer }

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const isBlank = (v) => v == null || v === '';
const text = (v) => (isBlank(v) ? '' : String(v));

// `hidden` alone loses to any `display:` rule on the element, so set both.
function hide(el) { el.hidden = true; el.style.display = 'none'; }
function show(el) { el.hidden = false; el.style.removeProperty('display'); }

function safeUrl(value) {
  if (isBlank(value)) return null;
  try {
    const url = new URL(String(value), location.href);
    return SAFE_PROTOCOLS.has(url.protocol) ? String(value) : null;
  } catch { return null; }
}

function cityLine(address) {
  if (!address) return null;
  const region = [address.state, address.zip].filter(Boolean).join(' ');
  return [address.city, region].filter(Boolean).join(', ') || null;
}

/** The API origin from <meta name="live-api">, or '' for same origin. */
export function apiBase() {
  const meta = document.querySelector('meta[name="live-api"]');
  const content = (meta?.getAttribute('content') || '').trim();
  return content.replace(/\/+$/, '');
}

/* -------------------------------------------------------------------------
   Chicago time + open/closed (mirrors worker/lib/time.js so the text matches the API)
   ------------------------------------------------------------------------- */
const chicagoFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

/** "Now" in America/Chicago: { date: 'YYYY-MM-DD', weekday: 0–6, minutes }. */
export function chicagoNow(date = new Date()) {
  const parts = {};
  for (const p of chicagoFmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: DAY_SHORT.indexOf(parts.weekday),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 480 → "8 am", 510 → "8:30 am", 720 → "12 pm". */
function minutesToText(min) {
  const m = ((Number(min) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const period = h24 < 12 ? 'am' : 'pm';
  const h = h24 % 12 || 12;
  return mm ? `${h}:${pad2(mm)} ${period}` : `${h} ${period}`;
}

function addDays(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Open/closed right now from the bundle's weekly hours and exceptions. Today's exception wins, then the
 * next 7 days give the "opens Wed 8 am" text. Returns null when the bundle carries no hours.
 */
export function openNowFrom(bundle, now = chicagoNow()) {
  const hours = Array.isArray(bundle?.hours) ? bundle.hours : [];
  if (!hours.length) return bundle?.open_now || null;
  const byDate = new Map((bundle.exceptions || []).map((e) => [e.date, e]));
  const byDay = new Map(hours.map((h) => [Number(h.weekday), h]));
  const effective = (date, weekday) => {
    const src = byDate.get(date) || byDay.get(weekday);
    if (!src || src.closed || src.open_min == null || src.close_min == null) return null;
    return { open_min: Number(src.open_min), close_min: Number(src.close_min) };
  };
  const today = effective(now.date, now.weekday);
  if (today) {
    if (now.minutes >= today.open_min && now.minutes < today.close_min) {
      return { open: true, text: `Open now · until ${minutesToText(today.close_min)}` };
    }
    if (now.minutes < today.open_min) return { open: false, text: `Closed · opens today ${minutesToText(today.open_min)}` };
  }
  for (let i = 1; i <= 7; i++) {
    const weekday = (now.weekday + i) % 7;
    const next = effective(addDays(now.date, i), weekday);
    if (next) return { open: false, text: `Closed · opens ${DAY_SHORT[weekday]} ${minutesToText(next.open_min)}` };
  }
  return { open: false, text: 'Closed today' };
}

/* -------------------------------------------------------------------------
   Fetch + cache
   ------------------------------------------------------------------------- */
function looksLikeBundle(data) {
  return Boolean(data && typeof data === 'object' && data.business && typeof data.business === 'object');
}

async function fetchBundle(slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${apiBase()}/api/public/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' }, credentials: 'omit', signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return looksLikeBundle(data) && data.business.slug === slug ? data : null;
  } catch {
    return null; // no API here (static hosting), offline, timeout, or a non-JSON answer
  } finally {
    clearTimeout(timer);
  }
}

function readCache(slug) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + slug);
    if (!raw) return null;
    const { saved_at, bundle } = JSON.parse(raw);
    if (!saved_at || Date.now() - saved_at > CACHE_MAX_AGE || !looksLikeBundle(bundle)) return null;
    return bundle;
  } catch { return null; }
}

function writeCache(slug, bundle) {
  try { localStorage.setItem(CACHE_PREFIX + slug, JSON.stringify({ saved_at: Date.now(), bundle })); } catch { /* private mode, full, blocked */ }
}

/* -------------------------------------------------------------------------
   Hydration: single fields
   ------------------------------------------------------------------------- */
const TEXT_KEYS = {
  phone: (b) => b.phone,
  email: (b) => b.public_email,
  address: (b) => b.address?.formatted,
  'address-line1': (b) => b.address?.line1,
  'address-line2': (b) => b.address?.line2,
  'address-city': (b) => cityLine(b.address),
  'hours-summary': (b, bundle) => bundle.hours_summary,
  'hours-note': (b) => b.hours_note,
  tagline: (b) => b.tagline,
  name: (b) => b.name,
  'short-name': (b) => b.short_name,
};
const HIDE_WHEN_EMPTY = new Set(['hours-note', 'address-line2']);
const HREF_KEYS = {
  'phone-href': (b) => b.phone_href,
  'order-url': (b) => b.order_url,
  'book-url': (b) => b.book_url,
  'instagram-url': (b) => b.instagram_url,
  'facebook-url': (b) => b.facebook_url,
  'map-url': (b) => b.map_url,
  'website-url': (b) => b.website_url,
};

function applyFields(root, bundle) {
  const business = bundle.business;
  for (const el of $$('[data-live]', root)) {
    const keys = el.getAttribute('data-live').split(/[\s,]+/).filter(Boolean);
    for (const key of keys) {
      if (TEXT_KEYS[key]) {
        const value = TEXT_KEYS[key](business, bundle);
        if (isBlank(value)) {
          if (HIDE_WHEN_EMPTY.has(key)) hide(el);
          continue;
        }
        el.textContent = (el.dataset.livePrefix || '') + value;
        el.setAttribute('data-live-set', '');
        if (HIDE_WHEN_EMPTY.has(key)) show(el);
        if (key === 'email') {
          const anchor = el.closest('a[href^="mailto:" i]');
          if (anchor) {
            const query = anchor.getAttribute('href').split('?')[1];
            anchor.setAttribute('href', `mailto:${value}${query ? `?${query}` : ''}`);
          }
        }
      } else if (HREF_KEYS[key]) {
        const value = safeUrl(HREF_KEYS[key](business));
        if (value) { el.setAttribute('href', value); el.setAttribute('data-live-set', ''); show(el); } else hide(el);
      }
    }
  }
}

/* -------------------------------------------------------------------------
   Hydration: hours table / list and open status
   ------------------------------------------------------------------------- */
function groupHours(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && !last.exception && !row.exception && last.text === row.text && last.closed === row.closed) last.rows.push(row);
    else groups.push({ text: row.text, closed: row.closed, exception: row.exception, rows: [row] });
  }
  return groups.map((g) => {
    const names = g.rows.map((r) => r.label);
    let label = names[0];
    if (names.length === 2) label = `${g.rows[0].short} & ${g.rows[1].short}`;
    else if (names.length > 2) label = `${names[0]} – ${names[names.length - 1]}`;
    return { label, text: g.text, closed: g.closed, exception: g.exception, days: g.rows.map((r) => r.weekday) };
  });
}

/** The text for a special day: "Closed · Thanksgiving" or "9 am – 1 pm · Christmas Eve". */
function exceptionText(ex) {
  const hours = ex.closed ? 'Closed' : ex.text || `${minutesToText(ex.open_min)} – ${minutesToText(ex.close_min)}`;
  return isBlank(ex.label) ? hours : `${hours} · ${ex.label}`;
}

function applyHours(root, bundle, now) {
  const rows = Array.isArray(bundle.hours) ? bundle.hours : [];
  if (!rows.length) return;
  const byDay = new Map(rows.map((r) => [Number(r.weekday), r]));
  const byDate = new Map((bundle.exceptions || []).filter((e) => e && e.date).map((e) => [e.date, e]));
  // Each weekday stands for its next occurrence (today included), so a special day in the coming week shows
  // in its row instead of the usual hours.
  const ordered = WEEK_ORDER.map((d) => byDay.get(d)).filter(Boolean).map((r) => {
    const weekday = Number(r.weekday);
    const ex = byDate.get(addDays(now.date, (weekday - now.weekday + 7) % 7));
    const closed = ex ? Boolean(ex.closed) : Boolean(r.closed);
    return {
      weekday, label: r.label || DAY_LABELS[weekday], short: r.short || DAY_SHORT[weekday],
      closed, exception: Boolean(ex), text: ex ? exceptionText(ex) : r.text || 'Closed',
    };
  });
  for (const el of $$('[data-live-hours]', root)) {
    const isTable = el.tagName === 'TABLE';
    const closedText = el.dataset.closedText || null;
    const entries = el.getAttribute('data-live-hours') === 'grouped'
      ? groupHours(ordered)
      : ordered.map((r) => ({ label: r.label, text: r.text, closed: r.closed, exception: r.exception, days: [r.weekday] }));
    const body = isTable ? (el.tBodies[0] || el.appendChild(document.createElement('tbody'))) : el;
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const row = document.createElement(isTable ? 'tr' : 'div');
      const head = document.createElement(isTable ? 'th' : 'dt');
      const cell = document.createElement(isTable ? 'td' : 'dd');
      if (isTable) head.setAttribute('scope', 'row');
      head.textContent = entry.label;
      cell.textContent = entry.closed && closedText && !entry.exception ? closedText : entry.text;
      row.dataset.day = entry.days.join(',');
      row.classList.toggle('is-closed', entry.closed);
      row.classList.toggle('is-exception', Boolean(entry.exception));
      const today = entry.days.includes(now.weekday);
      row.classList.toggle('is-today', today);
      if (today) row.setAttribute('aria-current', 'date');
      row.append(head, cell);
      frag.append(row);
    }
    body.replaceChildren(frag);
  }
}

function applyOpenStatus(root, bundle, now) {
  const status = openNowFrom(bundle, now);
  if (!status) return;
  for (const el of $$('[data-open-status], [data-open-dot]', root)) {
    el.classList.toggle('is-open', Boolean(status.open));
    el.classList.toggle('is-closed', !status.open);
  }
  for (const el of $$('[data-open-label]', root)) el.textContent = status.open ? 'Open now' : 'Closed';
  for (const el of $$('[data-open-text]', root)) el.textContent = text(status.text);
}

/* -------------------------------------------------------------------------
   Hydration: notice, announcements, events (template clones)
   ------------------------------------------------------------------------- */
function applyNotice(root, bundle, now) {
  const notice = bundle.business.notice;
  const live = Boolean(notice && !isBlank(notice.text) && (!notice.until || notice.until >= now.date));
  for (const el of $$('[data-live-notice]', root)) {
    if (!live) { hide(el); continue; }
    for (const t of $$('[data-field="text"]', el)) t.textContent = text(notice.text);
    show(el);
  }
}

function setText(el, value) {
  const target = el.closest('[data-field-group]') || el;
  if (isBlank(value)) { hide(target); return; }
  el.textContent = (el.dataset.livePrefix || '') + value;
  show(target);
}

function setLink(el, url, label) {
  const href = safeUrl(url);
  const target = el.closest('[data-field-group]') || el;
  if (!href) {
    if (el.hasAttribute('data-link-keep')) { el.removeAttribute('href'); show(target); } else hide(target);
    return;
  }
  el.setAttribute('href', href);
  if (!isBlank(label) && !el.children.length) el.textContent = label;
  show(target);
}

function setImage(el, url, alt) {
  const src = safeUrl(url);
  const wrap = el.closest('figure, picture, [data-field-group]') || el;
  if (!src) { hide(wrap); return; }
  el.setAttribute('src', src);
  if (!el.getAttribute('alt')) el.setAttribute('alt', text(alt));
  show(wrap);
}

const capitalize = (s) => (isBlank(s) ? '' : String(s).charAt(0).toUpperCase() + String(s).slice(1));

function fillAnnouncement(frag, item) {
  for (const el of $$('[data-field]', frag)) {
    const key = el.dataset.field;
    if (key === 'link') setLink(el, item.link_url, item.link_label);
    else if (key === 'image') setImage(el, item.image_url, item.title);
    else setText(el, item[key]);
  }
}

function fillEvent(frag, ev) {
  for (const el of $$('[data-field]', frag)) {
    const key = el.dataset.field;
    if (key === 'link') setLink(el, ev.link_url, ev.link_label);
    else if (key === 'image') setImage(el, ev.image_url, ev.title);
    else if (key === 'kind') setText(el, capitalize(ev.kind));
    else if (key === 'status') setText(el, el.dataset[`text${capitalize(ev.status)}`] || capitalize(ev.status));
    else setText(el, ev[key]);
  }
  for (const node of frag.children) {
    node.classList.add(`is-${ev.status}`);
    if (ev.featured) node.classList.add('is-featured');
    if (ev.id != null) node.setAttribute('data-event-id', String(ev.id));
  }
}

/**
 * Renders `items` into `container` from its <template>: the static fallback children are removed and one
 * clone appended per item. An empty list hides the container and shows the `[emptyAttr]` sibling.
 */
function renderList(container, items, fill, emptyAttr) {
  const template = container.querySelector('template');
  if (!template) return;
  const offset = Math.max(0, Number(container.dataset.liveOffset) || 0);
  const limit = Number(container.dataset.liveLimit) || Infinity;
  const list = items.slice(offset, offset + limit);
  for (const child of [...container.children]) {
    if (child !== template && !child.hasAttribute('data-live-keep')) child.remove();
  }
  const empty = container.parentElement?.querySelector(`:scope > [${emptyAttr}]`);
  if (!list.length) {
    hide(container);
    if (empty) show(empty);
    return;
  }
  for (const item of list) {
    const frag = template.content.cloneNode(true);
    for (const node of frag.children) node.setAttribute('data-live-clone', '');
    fill(frag, item);
    container.append(frag);
  }
  show(container);
  if (empty) hide(empty);
}

function applyAnnouncements(root, bundle) {
  const items = Array.isArray(bundle.announcements) ? bundle.announcements : [];
  for (const el of $$('[data-live-announcements]', root)) renderList(el, items, fillAnnouncement, 'data-live-announcements-empty');
}

/** Re-buckets by today's date so a cached bundle does not keep yesterday's "upcoming". */
export function bucketEvents(events, today) {
  const all = [];
  for (const key of ['current', 'upcoming', 'past']) for (const ev of events?.[key] || []) all.push(ev);
  const out = { current: [], upcoming: [], past: [] };
  for (const ev of all) {
    if (!ev || isBlank(ev.start_date)) continue;
    const last = ev.end_date || ev.start_date;
    const status = last < today ? 'past' : ev.start_date > today ? 'upcoming' : 'current';
    out[status].push({ ...ev, status });
  }
  const byStart = (a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0);
  out.current.sort(byStart);
  out.upcoming.sort(byStart);
  out.past.sort((a, b) => byStart(b, a));
  return out;
}

function applyEvents(root, bundle, now) {
  const buckets = bucketEvents(bundle.events, now.date);
  for (const el of $$('[data-live-events]', root)) {
    const keys = el.getAttribute('data-live-events').split(/[\s,]+/).filter(Boolean);
    const items = keys.flatMap((k) => buckets[k] || []);
    renderList(el, items, fillEvent, 'data-live-events-empty');
  }
}

/* -------------------------------------------------------------------------
   Hydrate everything + keep the clock right
   ------------------------------------------------------------------------- */
function hydrate(entry, bundle, fromCache) {
  const now = chicagoNow();
  const root = document;
  entry.bundle = bundle;
  entry.fromCache = fromCache;
  applyFields(root, bundle);
  applyHours(root, bundle, now);
  applyOpenStatus(root, bundle, now);
  applyNotice(root, bundle, now);
  applyAnnouncements(root, bundle);
  applyEvents(root, bundle, now);
  renderMenuFor(entry);
  try { entry.options.onBundle?.(bundle, { fromCache }); } catch (e) { console.warn('live: onBundle failed', e); }
  document.dispatchEvent(new CustomEvent('live:hydrated', { detail: { slug: entry.slug, bundle, fromCache } }));
  if (!entry.timer) {
    entry.timer = setInterval(() => {
      if (!entry.bundle) return;
      const tick = chicagoNow();
      applyOpenStatus(root, entry.bundle, tick);
      applyHours(root, entry.bundle, tick);
      applyNotice(root, entry.bundle, tick);
    }, 60 * 1000);
  }
}

function renderMenuFor(entry) {
  const { renderMenu } = entry.options;
  if (!renderMenu || !entry.bundle?.menu || !document.querySelector('[data-live-menu]')) return;
  try { renderMenu(entry.bundle.menu, entry.bundle); } catch (e) { console.warn('live: renderMenu failed', e); }
}

const domReady = () => (document.readyState === 'loading'
  ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
  : Promise.resolve());

async function run(entry) {
  await domReady();
  const cached = readCache(entry.slug);
  if (cached) hydrate(entry, cached, true);
  const bundle = await fetchBundle(entry.slug);
  if (bundle) {
    hydrate(entry, bundle, false);
    writeCache(entry.slug, bundle);
  }
  return entry.bundle;
}

/**
 * Starts (or joins) the live hydration for a business. Resolves to the bundle in use, or null when
 * neither the API nor the cache had one. Options: renderMenu(menu, bundle), onBundle(bundle, { fromCache }).
 */
export function initLive(slug, options = {}) {
  if (!slug) return Promise.resolve(null);
  let entry = registry.get(slug);
  if (entry) {
    Object.assign(entry.options, options);
    if (entry.bundle) {
      if (options.renderMenu) renderMenuFor(entry);
      if (options.onBundle) {
        try { options.onBundle(entry.bundle, { fromCache: entry.fromCache }); } catch (e) { console.warn('live: onBundle failed', e); }
      }
    }
    return entry.promise;
  }
  entry = { slug, options: { ...options }, bundle: null, fromCache: false, promise: null, timer: null };
  registry.set(slug, entry);
  entry.promise = run(entry);
  return entry.promise;
}

/** The bundle currently applied for a slug (cache or API), or null. */
export const liveBundle = (slug) => registry.get(slug)?.bundle || null;

/* -------------------------------------------------------------------------
   Forms: POST {api}/api/forms/{slug}/{type} as JSON. Callers keep their own validation and fall back to
   the old mailto flow when this throws (no API, offline, rejected), so nothing is lost.
   ------------------------------------------------------------------------- */

/** Every field of a form as { name: value }, multi-value fields joined with ", ", file inputs skipped. */
export function formFields(form) {
  const data = new FormData(form);
  const out = {};
  for (const key of new Set(data.keys())) {
    const values = data.getAll(key).filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
    out[key] = values.join(', ');
  }
  return out;
}

/** Loading state: disables the submit button and marks the form busy. */
export function setBusy(form, busy) {
  form.setAttribute('aria-busy', String(busy));
  form.classList.toggle('is-sending', busy);
  for (const button of $$('button[type="submit"], input[type="submit"]', form)) button.disabled = busy;
}

export async function sendInquiry(slug, type, fields) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORM_TIMEOUT);
  try {
    const res = await fetch(`${apiBase()}/api/forms/${encodeURIComponent(slug)}/${encodeURIComponent(type)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
      body: JSON.stringify({ ...fields, source_url: location.href }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) throw new Error(data?.error || `The form service answered ${res.status}.`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------
   Auto-init from <script type="module" src="…/live.js" data-business="…"> or <body data-business="…">
   ------------------------------------------------------------------------- */
(function autoInit() {
  const tag = $$('script[data-business]').find((s) => {
    try { return new URL(s.getAttribute('src') || '', location.href).href === import.meta.url; } catch { return false; }
  }) || document.currentScript;
  const slug = tag?.dataset?.business || document.body?.dataset?.business;
  if (slug) initLive(slug);
}());
