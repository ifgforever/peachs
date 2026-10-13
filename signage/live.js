/* Peach's live in-store screen (signage/live.html).
   Fetches GET {api}/api/public/signage/{business} every 5 minutes, keeps the last good copy in
   localStorage, and rotates through scenes built from it with DOM nodes (textContent only, never
   innerHTML). It never goes blank: with no data at all it leaves the brand screen up.

   This is a classic script, not a module, on purpose: BrightSign players open the page from the
   SD card as file:// and Chromium refuses module scripts there. Syntax is kept to Chromium 87+
   (BrightSign OS 8.5 and later): no top-level await, Array.at, structuredClone or :has(). */
(function () {
  'use strict';

  /* -------------------------------------------------------------------------
     Settings
     ------------------------------------------------------------------------- */
  const REFRESH_MS = 5 * 60 * 1000;      // how often to ask the API
  const RETRY_MS = 60 * 1000;            // with nothing to show yet, try again sooner
  const TIMEOUT_MS = 6000;               // a slow API counts as down; the cached copy stays up
  const FADE_MS = 900;                   // matches --fade in live.css
  const DEFAULT_SECONDS = 10;            // per scene, unless settings signage:<slug> says otherwise
  const MIN_SECONDS = 4;
  const MAX_SECONDS = 60;
  const BOARD_PER_SCENE = 14;            // menu board items per scene (two columns of seven)
  const FEATURED_PER_SCENE = 4;
  const CATERING_PICKS = 5;              // rows that fit the catering card
  const RELOAD_AFTER_MS = 24 * 60 * 60 * 1000; // a daily reload keeps long-running players tidy
  const OFFLINE_AFTER_MS = 2 * REFRESH_MS;     // show the "offline" chip after two missed refreshes

  const params = new URLSearchParams(location.search);
  const BUSINESS = /^[a-z0-9-]{1,40}$/.test(params.get('business') || '') ? params.get('business') : 'peachs';
  const API = apiBase(params.get('api'));
  const FROZEN = parseFrozenClock(params.get('at'));   // ?at=2026-10-14T10:30 freezes "now" for previews
  const CACHE_KEY = 'romesjoy-tv:' + BUSINESS;

  const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  /** The API origin: ?api=https://host (any trailing slash dropped), else the page's own origin. */
  function apiBase(raw) {
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin + u.pathname.replace(/\/+$/, '');
      } catch (e) { /* fall through to same origin */ }
    }
    return location.protocol === 'file:' ? '' : location.origin;
  }

  function parseFrozenClock(raw) {
    const m = raw && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw);
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { date: m[1] + '-' + m[2] + '-' + m[3], weekday: dt.getUTCDay(), minutes: (+m[4]) * 60 + (+m[5]) };
  }

  /* -------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------- */
  const state = {
    data: null,          // { bundle, catering, blanc, savedAt }
    source: 'none',      // none | cache | network
    scenes: [],          // [{ id, seconds, build }]
    index: -1,
    timer: null,
    refreshTimer: null,
    fetching: false,
    shownAt: 0,
    shownSeconds: DEFAULT_SECONDS,
    lastFetchAt: null,
    lastOkAt: null,
    lastError: null,
    errors: [],          // newest first, max 12
    started: Date.now(),
  };

  const scenesRoot = document.getElementById('scenes');
  const brandEl = document.getElementById('brand');
  const debugEl = document.getElementById('debug');

  /* -------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const text = (v) => (v == null ? '' : String(v));
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pad2 = (n) => String(n).padStart(2, '0');

  /**
   * Builds an element: el('p', { class: 'x', text: 'hi', d: 120 }, child, 'string', null).
   * `text` always goes through textContent, so API strings can never become markup.
   */
  function el(tag, props) {
    const node = document.createElement(tag);
    const p = props || {};
    if (p.class) node.className = p.class;
    if (p.text != null) node.textContent = text(p.text);
    if (p.d != null) { node.classList.add('rise'); node.style.setProperty('--d', p.d + 'ms'); }
    if (p.attrs) Object.keys(p.attrs).forEach((k) => node.setAttribute(k, p.attrs[k]));
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** Only http(s) URLs are allowed into src attributes; relative paths resolve against the API. */
  function safeUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      const u = new URL(raw, API || location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch (e) { return null; }
  }

  function hostOf(raw) {
    try {
      const u = new URL(raw);
      const path = u.pathname.replace(/\/+$/, '');
      return u.host.replace(/^www\./, '') + (path && path !== '/' ? path : '');
    } catch (e) { return null; }
  }

  /** "https://www.instagram.com/peachson47th/" → "@peachson47th". */
  function instagramHandle(raw) {
    try {
      const seg = new URL(raw).pathname.split('/').filter(Boolean)[0];
      return seg && /^[A-Za-z0-9._]{1,30}$/.test(seg) ? '@' + seg : null;
    } catch (e) { return null; }
  }

  const formatPrice = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : null);

  function note(err, where) {
    const msg = (where ? where + ': ' : '') + (err && err.message ? err.message : String(err));
    state.errors.unshift({ at: Date.now(), message: msg });
    state.errors.length = Math.min(state.errors.length, 12);
    if (debugEl && !debugEl.hidden) renderDebug();
  }

  /* -------------------------------------------------------------------------
     Chicago time, hours and open/closed (mirrors worker/lib/time.js)
     ------------------------------------------------------------------------- */
  const chicagoFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });

  /** { date: 'YYYY-MM-DD', weekday: 0–6, minutes, time: '2:14 pm' } for right now in Chicago. */
  function chicagoNow() {
    if (FROZEN) return Object.assign({ time: minutesToText(FROZEN.minutes) }, FROZEN);
    const parts = {};
    chicagoFmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
    const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    return {
      date: parts.year + '-' + parts.month + '-' + parts.day,
      weekday: DAY_SHORT.indexOf(parts.weekday),
      minutes,
      time: clockText(minutes),
    };
  }

  /** 480 → "8 am", 870 → "2:30 pm". */
  function minutesToText(min) {
    if (min == null || Number.isNaN(Number(min))) return null;
    const m = ((Number(min) % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60);
    const mm = m % 60;
    const period = h24 < 12 ? 'am' : 'pm';
    const h = h24 % 12 || 12;
    return mm ? h + ':' + pad2(mm) + ' ' + period : h + ' ' + period;
  }
  /** Always with minutes, for the corner clock: "2:05 pm". */
  function clockText(min) {
    const h24 = Math.floor(min / 60);
    return (h24 % 12 || 12) + ':' + pad2(min % 60) + ' ' + (h24 < 12 ? 'am' : 'pm');
  }

  function parseDate(s) {
    const m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const dt = new Date(t);
    if (dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) return null;
    return { y: +m[1], m: +m[2], d: +m[3], weekday: dt.getUTCDay(), time: t };
  }
  function addDays(dateStr, days) {
    const p = parseDate(dateStr);
    if (!p) return null;
    const dt = new Date(p.time + days * 86400000);
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }
  /** "2026-11-26" → "Thursday, November 26". */
  function longDate(dateStr) {
    const p = parseDate(dateStr);
    return p ? DAY_LABELS[p.weekday] + ', ' + MONTH_LONG[p.m - 1] + ' ' + p.d : null;
  }

  const hoursRow = (bundle, weekday) => (bundle.hours || []).find((h) => Number(h.weekday) === weekday) || null;
  const exceptionOn = (bundle, date) => (bundle.exceptions || []).find((x) => x.date === date) || null;

  /** Hours that apply on a date: today's exception wins over the weekly row. Null = closed. */
  function effectiveHours(bundle, date, weekday) {
    const src = exceptionOn(bundle, date) || hoursRow(bundle, weekday);
    if (!src || src.closed || src.open_min == null || src.close_min == null) return null;
    return { open_min: Number(src.open_min), close_min: Number(src.close_min) };
  }

  /** Same wording as the API's open_now, but computed from the clock so it stays right between fetches. */
  function openStatus(bundle, now) {
    if (!bundle.hours || !bundle.hours.length) return bundle.open_now || { open: false, text: '' };
    const today = effectiveHours(bundle, now.date, now.weekday);
    if (today) {
      if (now.minutes >= today.open_min && now.minutes < today.close_min) return { open: true, text: 'Open now · until ' + minutesToText(today.close_min) };
      if (now.minutes < today.open_min) return { open: false, text: 'Closed · opens today ' + minutesToText(today.open_min) };
    }
    for (let i = 1; i <= 7; i++) {
      const weekday = (now.weekday + i) % 7;
      const next = effectiveHours(bundle, addDays(now.date, i), weekday);
      if (next) return { open: false, text: 'Closed · opens ' + DAY_SHORT[weekday] + ' ' + minutesToText(next.open_min) };
    }
    return { open: false, text: 'Closed today' };
  }

  function todayText(bundle, now) {
    const ex = exceptionOn(bundle, now.date);
    const h = effectiveHours(bundle, now.date, now.weekday);
    const hours = h ? minutesToText(h.open_min) + ' – ' + minutesToText(h.close_min) : 'Closed';
    return ex && ex.label ? hours + ' · ' + ex.label : hours;
  }

  const greeting = (minutes) => (minutes < 12 * 60 ? 'Good morning' : minutes < 17 * 60 ? 'Good afternoon' : 'Good evening');

  /* -------------------------------------------------------------------------
     Fetching and the cache
     ------------------------------------------------------------------------- */
  function fetchJson(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    return fetch(API + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
        return res.json();
      })
      .catch((err) => { throw err && err.name === 'AbortError' ? new Error('Timed out after ' + TIMEOUT_MS / 1000 + 's: ' + path) : err; })
      .finally(() => clearTimeout(timer));
  }

  function checkBundle(data) {
    if (!isObj(data) || !isObj(data.business) || !data.business.name) throw new Error('Unexpected response from the API');
    return data;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const saved = raw && JSON.parse(raw);
      if (saved && saved.v === 1 && isObj(saved.bundle) && isObj(saved.bundle.business)) return saved;
    } catch (e) { note(e, 'cache'); }
    return null;
  }
  function saveCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.assign({ v: 1 }, data))); } catch (e) { note(e, 'cache'); }
  }

  const settingOn = (settings, key) => settings[key] !== false && settings[key] !== 0 && settings[key] !== 'false';

  /** One round trip: the signage bundle, then catering and Blanc when the settings allow. */
  function refresh() {
    if (state.fetching) return Promise.resolve(false);
    state.fetching = true;
    state.lastFetchAt = Date.now();
    let fetched = false;
    return fetchJson('/api/public/signage/' + BUSINESS)
      .then(checkBundle)
      .then((bundle) => {
        const settings = isObj(bundle.signage) ? bundle.signage : {};
        const wantCatering = BUSINESS !== 'catering' && settingOn(settings, 'show_catering');
        const wantBlanc = BUSINESS !== 'blanc' && settingOn(settings, 'show_events') && settingOn(settings, 'show_blanc');
        // null = turned off; undefined = failed this time, so keep what we had.
        const side = (want, path) => (want ? fetchJson(path).then(checkBundle).catch((e) => { note(e); return undefined; }) : Promise.resolve(null));
        return Promise.all([side(wantCatering, '/api/public/catering'), side(wantBlanc, '/api/public/blanc')]).then((extra) => {
          const prev = state.data || {};
          state.data = {
            bundle,
            catering: extra[0] === undefined ? prev.catering || null : extra[0],
            blanc: extra[1] === undefined ? prev.blanc || null : extra[1],
            savedAt: Date.now(),
          };
          state.source = 'network';
          state.lastOkAt = state.data.savedAt;
          state.lastError = null;
          saveCache(state.data);
          plan();
          if (!state.timer) advance();
          fetched = true;
          return true;
        });
      })
      .catch((err) => {
        state.lastError = (err && err.message) || String(err);
        note(err, 'fetch');
        return false;
      })
      .finally(() => {
        state.fetching = false;
        renderHud();
        if (!debugEl.hidden) renderDebug();
        scheduleRefresh(state.data ? REFRESH_MS : RETRY_MS);
        if (fetched && Date.now() - state.started > RELOAD_AFTER_MS) location.reload();
      });
  }
  function scheduleRefresh(ms) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, ms);
  }

  /* -------------------------------------------------------------------------
     Scene planning: which scenes exist, from the current data
     ------------------------------------------------------------------------- */
  function plan() {
    const d = state.data;
    const bundle = d.bundle;
    const settings = isObj(bundle.signage) ? bundle.signage : {};
    const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(settings.seconds_per_scene) || DEFAULT_SECONDS));
    const scenes = [];
    const add = (id, build, factor) => scenes.push({ id, seconds: Math.round(seconds * (factor || 1)), build });

    add('welcome', () => sceneWelcome(bundle));
    if (bundle.business.notice && bundle.business.notice.text) add('notice', () => sceneNotice(bundle));

    if (settingOn(settings, 'show_announcements')) {
      (bundle.announcements || []).filter((a) => isObj(a) && a.title && a.show_on_tv !== false)
        .forEach((a) => add('announcement-' + a.id, () => sceneAnnouncement(bundle, a)));
    }

    const sections = (bundle.menu && Array.isArray(bundle.menu.sections) ? bundle.menu.sections : []).filter((s) => isObj(s) && Array.isArray(s.items));
    if (settingOn(settings, 'show_featured')) {
      const featured = [];
      sections.forEach((s) => s.items.forEach((it) => { if (isObj(it) && it.featured && it.name) featured.push({ item: it, section: s }); }));
      chunk(featured, FEATURED_PER_SCENE).forEach((group, i, all) => add('featured-' + (i + 1), () => sceneFeatured(group, i, all.length)));
    }
    if (settingOn(settings, 'show_menu_board')) {
      sections.forEach((s) => {
        const items = s.items.filter((it) => isObj(it) && it.name);
        if (!items.length) return;
        chunk(items, BOARD_PER_SCENE).forEach((group, i, all) => add('menu-' + s.id + (all.length > 1 ? '-' + (i + 1) : ''), () => sceneBoard(s, group, i, all.length), group.length > 8 ? 1.4 : 1));
      });
    }

    if (d.catering && settingOn(settings, 'show_catering')) {
      const picks = cateringPicks(d.catering);
      if (picks.length) add('catering', () => sceneCatering(bundle, d.catering, picks));
    }
    if (settingOn(settings, 'show_events')) {
      const cards = eventCards(bundle, d.blanc);
      if (cards.length) add('events', () => sceneEvents(bundle, cards));
    }
    add('closing', () => sceneClosing(bundle));

    state.scenes = scenes;
    if (state.index >= scenes.length) state.index = -1;
    if (!debugEl.hidden) renderDebug();
  }

  /** Splits a list into groups of at most `max`, keeping the groups as even as possible. */
  function chunk(list, max) {
    if (!list.length) return [];
    const n = Math.ceil(list.length / max);
    const base = Math.floor(list.length / n);
    const extra = list.length % n;
    const out = [];
    let at = 0;
    for (let i = 0; i < n; i++) {
      const size = base + (i < extra ? 1 : 0);
      out.push(list.slice(at, at + size));
      at += size;
    }
    return out;
  }

  /* -------------------------------------------------------------------------
     Shared pieces
     ------------------------------------------------------------------------- */
  function statusPill(bundle, d) {
    const s = openStatus(bundle, chicagoNow());
    return el('p', { class: 'status' + (s.open ? ' is-open' : ''), d }, el('span', { class: 'status__dot' }), el('span', { text: s.text }));
  }

  /** The wordmark for Peach's; the name in display type for any other business. */
  function brandMark(bundle, cls, d) {
    if (bundle.business.slug === 'peachs') return el('span', { class: 'wordmark', d, attrs: { role: 'img', 'aria-label': bundle.business.name } });
    return el('h1', { class: 'display name ' + (cls || ''), text: bundle.business.name, d });
  }

  function priceNodes(item, cls) {
    const prices = Array.isArray(item.prices) ? item.prices.filter((p) => isObj(p) && formatPrice(p.value) != null) : [];
    if (prices.length) {
      const dl = el('dl', { class: cls + '__sizes' });
      prices.forEach((p) => dl.appendChild(el('div', null, el('dt', { text: p.label || '' }), el('dd', { text: formatPrice(p.value) }))));
      return dl;
    }
    const single = formatPrice(item.price);
    return single != null ? el('p', { class: cls + '__price', text: single }) : null;
  }

  function tagNodes(item) {
    const tags = Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t) : [];
    if (!tags.length) return null;
    const wrap = el('p', { class: 'card__tags' });
    tags.forEach((t) => wrap.appendChild(el('span', { class: 'tag', text: t, attrs: { 'data-tag': t } })));
    return wrap;
  }

  /* -------------------------------------------------------------------------
     1. Welcome
     ------------------------------------------------------------------------- */
  function sceneWelcome(bundle) {
    const b = bundle.business;
    const now = chicagoNow();
    const scene = el('section', { class: 'scene s-welcome' });
    const copy = el('div', { class: 'copy' },
      el('p', { class: 'eyebrow', text: greeting(now.minutes) + ' · Welcome in', d: 0 }),
      brandMark(bundle, '', 150),
      b.tagline ? el('p', { class: 'accent tagline', text: b.tagline, d: 300 }) : null,
      statusPill(bundle, 450),
      el('p', { class: 'today', d: 600 }, 'Today · ', el('b', { text: todayText(bundle, now) })));
    scene.appendChild(copy);

    const facts = el('p', { class: 'facts', d: 800 });
    const addr = b.address && (b.address.formatted || b.address.line1);
    [addr, b.phone, instagramHandle(b.instagram_url)].forEach((f) => { if (f) facts.appendChild(el('span', { text: f })); });
    scene.appendChild(facts);

    if (bundle.hours && bundle.hours.length) {
      const week = el('aside', { class: 'week', d: 500 }, el('p', { class: 'week__title', text: 'This week' }));
      const dl = el('dl');
      WEEK_ORDER.forEach((wd) => {
        const row = hoursRow(bundle, wd) || { closed: true, text: 'Closed', label: DAY_LABELS[wd] };
        const date = addDays(now.date, (wd - now.weekday + 7) % 7);
        const ex = exceptionOn(bundle, date);
        const closed = ex ? Boolean(ex.closed) : Boolean(row.closed);
        const txt = ex ? (ex.closed ? 'Closed' + (ex.label ? ' · ' + ex.label : '') : (ex.text || minutesToText(ex.open_min) + ' – ' + minutesToText(ex.close_min))) : row.text || 'Closed';
        dl.appendChild(el('div', { class: 'week__row' + (wd === now.weekday ? ' is-today' : '') + (closed ? ' is-closed' : '') },
          el('dt', { text: row.label || DAY_LABELS[wd] }), el('dd', { text: txt })));
      });
      week.appendChild(dl);
      if (b.hours_note) week.appendChild(el('p', { class: 'week__note', text: b.hours_note }));
      scene.appendChild(week);
    }
    return scene;
  }

  /* -------------------------------------------------------------------------
     2. Notice
     ------------------------------------------------------------------------- */
  function sceneNotice(bundle) {
    const n = bundle.business.notice;
    const until = n.until ? longDate(n.until) : null;
    return el('section', { class: 'scene s-notice' },
      el('p', { class: 'eyebrow', text: 'Please note', d: 0 }),
      el('p', { class: 'text' + (text(n.text).length > 120 ? ' is-long' : ''), text: n.text, d: 150 }),
      until ? el('p', { class: 'until', text: 'Through ' + until, d: 350 }) : null);
  }

  /* -------------------------------------------------------------------------
     3. Announcements (one scene each)
     ------------------------------------------------------------------------- */
  function sceneAnnouncement(bundle, a) {
    const image = safeUrl(a.image_url);
    const scene = el('section', { class: 'scene s-announce' + (image ? ' has-image' : '') });
    const family = a.business_slug == null && bundle.business.slug !== 'romesjoy';
    const title = text(a.title);
    const copy = el('div', { class: 'copy' },
      el('p', { class: 'eyebrow', text: family ? "From Rome's Joy" : 'News from ' + (bundle.business.short_name || bundle.business.name), d: 0 }),
      el('h2', { class: 'display title' + (title.length > 60 ? ' is-long' : ''), text: title, d: 150 }),
      a.body ? el('p', { class: 'body', text: a.body, d: 300 }) : null);
    const host = hostOf(a.link_url);
    if (a.link_label || host) {
      copy.appendChild(el('p', { class: 'link', d: 450 }, el('span', { text: a.link_label || 'More' }), host ? el('small', { text: host }) : null));
    }
    scene.appendChild(copy);
    if (image) {
      const img = el('img', { attrs: { alt: '' } });
      img.src = image;
      img.addEventListener('error', () => { scene.classList.remove('has-image'); img.parentNode.remove(); });
      scene.appendChild(el('div', { class: 'photo', d: 100 }, img));
    }
    return scene;
  }

  /* -------------------------------------------------------------------------
     4. Featured dishes
     ------------------------------------------------------------------------- */
  function sceneFeatured(group, i, total) {
    const scene = el('section', { class: 'scene s-featured' });
    const head = el('div', { class: 'head' },
      el('div', null,
        el('p', { class: 'eyebrow', text: "Chef's picks", d: 0 }),
        el('h2', { class: 'display title', d: 120 }, 'From our ', el('span', { class: 'accent', text: 'menu' }))),
      total > 1 ? el('p', { class: 'count', text: (i + 1) + ' of ' + total, d: 200 }) : null);
    scene.appendChild(head);
    const cols = Math.max(2, Math.min(4, group.length));
    const cards = el('div', { class: 'cards', attrs: { 'data-cols': String(cols) } });
    group.forEach((g, k) => {
      const it = g.item;
      const name = it.portion ? it.name + ' · ' + it.portion : it.name;
      cards.appendChild(el('article', { class: 'card', d: 250 + k * 120 },
        el('p', { class: 'card__section', text: g.section.short_title || g.section.title || '' }),
        el('h3', { class: 'display card__name', text: name }),
        priceNodes(it, 'card'),
        it.description ? el('p', { class: 'card__desc', text: it.description }) : null,
        tagNodes(it)));
    });
    scene.appendChild(cards);
    return scene;
  }

  /* -------------------------------------------------------------------------
     5. Menu board (one scene per section, big type, two columns)
     ------------------------------------------------------------------------- */
  function sceneBoard(section, items, i, total) {
    const scene = el('section', { class: 'scene s-board' });
    const titleText = text(section.title);
    scene.appendChild(el('div', { class: 'head' },
      el('div', null,
        el('p', { class: 'eyebrow', text: 'Menu' + (total > 1 ? ' · ' + (i + 1) + ' of ' + total : ''), d: 0 }),
        el('h2', { class: 'display title', text: titleText, d: 120 })),
      section.description ? el('p', { class: 'note', text: section.description, d: 200 }) : null));

    const board = el('ul', { class: 'board' + (items.length > 10 ? ' board--dense' : items.length <= 8 ? ' board--roomy' : ''), d: 250 });
    board.style.gridTemplateRows = 'repeat(' + Math.ceil(items.length / 2) + ', auto)';
    items.forEach((it) => {
      const prices = Array.isArray(it.prices) ? it.prices.filter((p) => isObj(p) && formatPrice(p.value) != null) : [];
      const sub = prices.length ? prices.map((p) => p.label).filter(Boolean).join(' / ') : it.portion;
      const price = prices.length ? prices.map((p) => formatPrice(p.value)).join(' / ') : formatPrice(it.price);
      board.appendChild(el('li', { class: 'board__item' },
        el('span', { class: 'board__name' }, text(it.name), sub ? el('small', { class: 'board__portion', text: sub }) : null),
        el('span', { class: 'board__leader', attrs: { 'aria-hidden': 'true' } }),
        price != null ? el('span', { class: 'board__price', text: price }) : null));
    });
    scene.appendChild(board);
    if (total > 1 && i < total - 1) scene.appendChild(el('p', { class: 'more', text: 'More ' + titleText.toLowerCase() + ' on the next screen', d: 400 }));
    return scene;
  }

  /* -------------------------------------------------------------------------
     6. Catering
     ------------------------------------------------------------------------- */
  /** Up to five catering items with prices: featured first, then menu order. */
  function cateringPicks(catering) {
    const sections = catering.menu && Array.isArray(catering.menu.sections) ? catering.menu.sections : [];
    const all = [];
    sections.forEach((s) => (Array.isArray(s.items) ? s.items : []).forEach((it) => {
      if (isObj(it) && it.name && (formatPrice(it.price) != null || (Array.isArray(it.prices) && it.prices.length))) all.push({ item: it, section: s });
    }));
    return all.filter((x) => x.item.featured).concat(all.filter((x) => !x.item.featured)).slice(0, CATERING_PICKS);
  }

  function sceneCatering(bundle, catering, picks) {
    const c = catering.business || {};
    const phone = c.phone || bundle.business.phone;
    const email = c.public_email || bundle.business.public_email;
    const scene = el('section', { class: 'scene s-catering' });
    const contact = el('p', { class: 'contact', d: 450 }, el('span', { text: 'Ask about catering' }));
    if (phone) contact.appendChild(el('b', { text: phone }));
    if (email) contact.appendChild(el('span', { text: email }));
    scene.appendChild(el('div', { class: 'copy' },
      el('p', { class: 'eyebrow', text: c.name || 'Catering', d: 0 }),
      el('h2', { class: 'display title', d: 150 }, 'Let us cater your ', el('span', { class: 'accent', text: 'next event.' })),
      c.tagline ? el('p', { class: 'sub', text: c.tagline, d: 300 }) : null,
      contact));

    const menu = el('aside', { class: 'menu', d: 250 }, el('p', { class: 'pill', text: 'A taste of the menu' }));
    const dl = el('dl');
    picks.forEach((p) => {
      const it = p.item;
      const prices = Array.isArray(it.prices) ? it.prices.filter((x) => isObj(x) && formatPrice(x.value) != null) : [];
      const price = prices.length ? prices.map((x) => '$' + formatPrice(x.value)).join(' / ') : '$' + formatPrice(it.price);
      const sub = it.portion || (prices.length ? prices.map((x) => x.label).filter(Boolean).join(' / ') : p.section.short_title || p.section.title);
      dl.appendChild(el('div', null, el('dt', null, text(it.name), sub ? el('small', { text: sub }) : null), el('dd', { text: price })));
    });
    menu.appendChild(dl);
    menu.appendChild(el('p', { class: 'fine', text: 'A selection. Ask for the full catering menu.' }));
    scene.appendChild(menu);
    return scene;
  }

  /* -------------------------------------------------------------------------
     7. Events: this business first, then what's on at Blanc Gallery
     ------------------------------------------------------------------------- */
  function eventCards(bundle, blanc) {
    const own = bundle.events || {};
    const list = (own.current || []).concat(own.upcoming || []).filter((e) => isObj(e) && e.title).slice(0, 3)
      .map((e) => ({ event: e, where: e.location || bundle.business.short_name || bundle.business.name, family: false }));
    if (blanc && blanc.events && blanc.business) {
      const ev = blanc.events || {};
      const current = (ev.current || []).filter((e) => isObj(e) && e.title);
      const pick = current.find((e) => e.kind === 'exhibition') || current[0] || (ev.upcoming || []).find((e) => isObj(e) && e.title);
      if (pick) list.push({ event: pick, where: 'At ' + blanc.business.name, family: true, address: blanc.business.address && blanc.business.address.line1 });
    }
    return list.slice(0, 4);
  }

  function sceneEvents(bundle, cards) {
    const scene = el('section', { class: 'scene s-events' });
    scene.appendChild(el('div', null,
      el('p', { class: 'eyebrow', text: "What's on", d: 0 }),
      el('h2', { class: 'display title', d: 120 }, 'Coming ', el('span', { class: 'accent', text: 'up' }))));
    const grid = el('div', { class: 'events', attrs: { 'data-cols': String(cards.length) } });
    cards.forEach((c, k) => {
      const e = c.event;
      const kind = e.kind === 'exhibition' ? (e.status === 'current' ? 'On view now' : 'Exhibition') : e.status === 'current' ? 'Happening now' : e.kind === 'program' ? 'Program' : null;
      const foot = [c.family ? c.address : (e.location && e.location !== c.where ? e.location : null), c.family && e.status === 'current' ? 'On view now' : null].filter(Boolean).join(' · ');
      grid.appendChild(el('article', { class: 'event' + (c.family ? ' event--family' : ''), d: 250 + k * 120 },
        el('p', { class: 'event__where', text: c.where }),
        el('p', { class: 'event__date', text: e.date_text || e.start_date || '' }),
        e.time_text ? el('p', { class: 'event__time', text: e.time_text }) : null,
        el('h3', { class: 'event__title', text: e.title }),
        e.subtitle ? el('p', { class: 'event__sub', text: e.subtitle }) : (e.description ? el('p', { class: 'event__sub', text: e.description }) : null),
        el('p', { class: 'event__foot' }, foot ? el('span', { text: foot }) : null, kind && !c.family ? el('span', { class: 'event__kind', text: kind }) : null)));
    });
    scene.appendChild(grid);
    return scene;
  }

  /* -------------------------------------------------------------------------
     8. Closing
     ------------------------------------------------------------------------- */
  function sceneClosing(bundle) {
    const b = bundle.business;
    const links = el('p', { class: 'links', d: 600 });
    [hostOf(b.website_url), instagramHandle(b.instagram_url), b.phone].forEach((t) => { if (t) links.appendChild(el('span', { text: t })); });
    return el('section', { class: 'scene s-closing' },
      brandMark(bundle, '', 0),
      b.tagline ? el('p', { class: 'accent tagline', text: b.tagline, d: 200 }) : null,
      bundle.hours_summary ? el('p', { class: 'hours', text: bundle.hours_summary, d: 400 }) : null,
      b.address && b.address.formatted ? el('p', { class: 'address', text: b.address.formatted, d: 500 }) : null,
      links.childNodes.length ? links : null);
  }

  /* -------------------------------------------------------------------------
     Rotation: build the next scene, cross-fade, drop the old one
     ------------------------------------------------------------------------- */
  function show(node) {
    const prev = scenesRoot.lastElementChild;
    scenesRoot.appendChild(node);
    node.getBoundingClientRect();           // commit styles so the opacity transition runs
    node.classList.add('is-on');
    brandEl.classList.remove('is-on');
    if (prev) {
      prev.classList.remove('is-on');
      setTimeout(() => { if (prev.parentNode) prev.parentNode.removeChild(prev); }, FADE_MS + 100);
    }
  }

  function advance() {
    clearTimeout(state.timer);
    state.timer = null;
    const n = state.scenes.length;
    for (let tries = 0; tries < n; tries++) {
      state.index = (state.index + 1) % n;
      const scene = state.scenes[state.index];
      try {
        show(scene.build());
        schedule(scene.seconds);
        return;
      } catch (e) {
        note(e, 'scene ' + scene.id);
      }
    }
    // Nothing could be built: fall back to the brand screen and try again later.
    brandEl.classList.add('is-on');
    if (n) schedule(DEFAULT_SECONDS);
  }

  function schedule(seconds) {
    state.shownAt = Date.now();
    state.shownSeconds = seconds;
    state.timer = setTimeout(advance, seconds * 1000);
  }

  /** If a timer ever stalls (players throttle timers now and then), kick the rotation. */
  function watchdog() {
    if (state.scenes.length && Date.now() - state.shownAt > (state.shownSeconds + 15) * 1000) {
      note(new Error('rotation stalled; restarted'), 'watchdog');
      advance();
    }
  }

  /* -------------------------------------------------------------------------
     Stage scaling, HUD, debug overlay, keys
     ------------------------------------------------------------------------- */
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
    document.documentElement.style.setProperty('--tv-scale', s.toFixed(4));
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }

  function renderHud() {
    $('[data-hud-clock]').textContent = chicagoNow().time;
    $('[data-hud-updated]').textContent = state.lastOkAt ? 'updated ' + ago(state.lastOkAt) : '';
    const chip = $('[data-hud-status]');
    chip.hidden = !(state.lastError && (!state.lastOkAt || Date.now() - state.lastOkAt > OFFLINE_AFTER_MS));
  }

  const stamp = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : '–');

  function renderDebug() {
    const list = $('[data-debug-list]');
    list.textContent = '';
    const rows = [
      ['API', API + '/api/public/signage/' + BUSINESS],
      ['Business', BUSINESS],
      ['Page', location.href],
      ['Data from', state.source + (state.data ? ' (saved ' + stamp(state.data.savedAt) + ')' : '')],
      ['Last fetch', stamp(state.lastFetchAt) + (state.fetching ? ' (in progress)' : '')],
      ['Last success', stamp(state.lastOkAt)],
      ['Last error', state.lastError || 'none'],
      ['Scenes', state.scenes.map((s) => s.id + ' ' + s.seconds + 's').join(', ') || 'none'],
      ['Showing', state.scenes[state.index] ? state.scenes[state.index].id : 'brand screen'],
      ['Clock', chicagoNow().date + ' ' + chicagoNow().time + (FROZEN ? ' (frozen by ?at=)' : ' America/Chicago')],
      ['Uptime', Math.round((Date.now() - state.started) / 60000) + ' min'],
      ['Screen', window.innerWidth + '×' + window.innerHeight + ' · scale ' + getComputedStyle(document.documentElement).getPropertyValue('--tv-scale').trim()],
    ];
    rows.forEach((r) => { list.appendChild(el('dt', { text: r[0] })); list.appendChild(el('dd', { text: r[1] })); });
    const errors = $('[data-debug-errors]');
    errors.textContent = '';
    state.errors.forEach((e) => errors.appendChild(el('li', { text: stamp(e.at) + ' · ' + e.message })));
  }

  function toggleDebug(force) {
    debugEl.hidden = force == null ? !debugEl.hidden : !force;
    if (!debugEl.hidden) renderDebug();
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'd' || e.key === 'D') toggleDebug();
    else if (e.key === 'n' || e.key === 'N') advance();
    else if (e.key === 'r' || e.key === 'R') refresh();
  });

  /* -------------------------------------------------------------------------
     Start
     ------------------------------------------------------------------------- */
  function init() {
    fit();
    window.addEventListener('resize', fit, { passive: true });
    if (BUSINESS !== 'peachs') {
      // Another business with nothing loaded yet: show its slug as a name rather than Peach's.
      brandEl.setAttribute('data-brand-nowordmark', '');
      $('[data-brand-name]').textContent = BUSINESS.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      $('[data-brand-address]').textContent = '';
    }
    const cached = loadCache();
    if (cached) {
      state.data = { bundle: cached.bundle, catering: cached.catering || null, blanc: cached.blanc || null, savedAt: cached.savedAt };
      state.source = 'cache';
      state.lastOkAt = cached.savedAt || null;
      plan();
      advance();
    }
    renderHud();
    setInterval(renderHud, 15 * 1000);
    setInterval(watchdog, 30 * 1000);
    refresh().then(() => {
      if (state.data) {
        // The brand screen may still be up (cache shown, name updated); fill it in from real data too.
        $('[data-brand-name]').textContent = state.data.bundle.business.name;
        const addr = state.data.bundle.business.address;
        $('[data-brand-address]').textContent = addr && addr.formatted ? addr.formatted : '';
      }
      window.__tvReady = true;
    });
  }

  // Test and preview hooks (used by signage/tv-test.mjs).
  window.__tvNext = advance;
  window.__tv = {
    next: advance,
    refresh,
    scenes: () => state.scenes.map((s) => s.id),
    current: () => (state.scenes[state.index] ? state.scenes[state.index].id : null),
    goto: (id) => { const i = state.scenes.findIndex((s) => s.id === id); if (i > -1) { state.index = i - 1; advance(); } },
    state: () => ({ source: state.source, lastOkAt: state.lastOkAt, lastFetchAt: state.lastFetchAt, lastError: state.lastError, errors: state.errors.slice(), hasData: Boolean(state.data), api: API, business: BUSINESS }),
  };

  init();
})();
