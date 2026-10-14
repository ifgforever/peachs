/* Peach's live in-store screen (signage/live.html).
   Fetches GET {api}/api/public/signage/{business} every 5 minutes, keeps the last good copy in
   localStorage, and rotates through scenes built from it with DOM nodes (textContent only, never
   innerHTML). It never goes blank: with no data at all it leaves the brand screen up.
   With ?screen=<id> (the player link from the admin's TV screens page) it also reports in every
   minute, and fetches its data again as soon as staff tap "Refresh all screens now".

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
  const ARTWORKS_PER_CYCLE = 20;         // gallery slideshow: artwork scenes per pass; more rotate in on the next pass
  const PRELOAD_AHEAD = 2;               // artwork photos loaded ahead of the scene that shows them
  const IMAGE_TIMEOUT_MS = 12000;        // a photo slower than this counts as failed and its scene is skipped
  const IMAGE_RETRY_MS = 10 * 60 * 1000; // a failed photo is tried again after this long
  const KNOWN_IMAGES = 80;               // photos remembered as loaded (with their size), for offline starts
  const RELOAD_AFTER_MS = 24 * 60 * 60 * 1000; // a daily reload keeps long-running players tidy
  const OFFLINE_AFTER_MS = 2 * REFRESH_MS;     // show the "offline" chip after two missed refreshes
  const HEARTBEAT_MS = 60 * 1000;        // with ?screen=, how often to tell the admin this screen is on

  const params = new URLSearchParams(location.search);
  const BUSINESS = /^[a-z0-9-]{1,40}$/.test(params.get('business') || '') ? params.get('business') : 'peachs';
  const API = apiBase(params.get('api'));
  const FROZEN = parseFrozenClock(params.get('at'));   // ?at=2026-10-14T10:30 freezes "now" for previews
  // ?preview=<draft id> from the admin's Assistant: the bundles as they will be once it is published (never cached).
  const PREVIEW = /^[A-Za-z0-9_-]{10,64}$/.test(params.get('preview') || '') ? params.get('preview') : null;
  // ?screen=<id>: this TV's row in the admin. Previews never report in, so they cannot make a screen look online.
  const SCREEN = !PREVIEW && /^[a-z0-9]{6,32}$/.test(params.get('screen') || '') ? params.get('screen') : null;
  const CACHE_KEY = 'romesjoy-tv:' + BUSINESS;
  const IMAGES_KEY = CACHE_KEY + ':images';

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
    plannedDate: null,   // the Chicago date plan() last ran for
    images: {},          // artwork photo url → { ok: true | false | null (loading), w, h, at, promise } this session
    known: {},           // artwork photo url → [width, height, lastLoadedAt], kept in localStorage across restarts
    artPool: 0,          // artworks the gallery slideshow can show; more than ARTWORKS_PER_CYCLE rotate
    artOffset: 0,        // where this pass's window of artworks starts in that pool
    waiting: null,       // token of a pending "wait for the next photo"; a newer advance() replaces it
    history: [],         // ids of the scenes shown, oldest first (last 40), for the debug overlay and tests
    version: 0,          // refresh_version of the data on screen; a heartbeat answer with another one means "fetch again"
    lastBeatAt: null,    // last heartbeat the Worker accepted
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
  /** `fresh` skips the browser's copy (the API allows a minute of caching): used when staff asked for a refresh. */
  function fetchJson(path, fresh) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const url = API + path + (PREVIEW ? (path.indexOf('?') > -1 ? '&' : '?') + 'preview=' + encodeURIComponent(PREVIEW) : '');
    return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' }, cache: PREVIEW ? 'no-store' : fresh ? 'reload' : 'default' })
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
    if (PREVIEW) return null; // a preview never paints from, or writes to, the player's cache
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const saved = raw && JSON.parse(raw);
      if (saved && saved.v === 1 && isObj(saved.bundle) && isObj(saved.bundle.business)) return saved;
    } catch (e) { note(e, 'cache'); }
    return null;
  }
  function saveCache(data) {
    if (PREVIEW) return;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.assign({ v: 1 }, data))); } catch (e) { note(e, 'cache'); }
  }

  const settingOn = (settings, key) => settings[key] !== false && settings[key] !== 0 && settings[key] !== 'false';

  // Scene switches: settings.scenes = { welcome, notice, announcements, featured, menu, catering, events, artworks }
  // (the admin's TV screens page). A scene it does not name follows the older flat key, if any; everything is on by default.
  const LEGACY_SCENE_KEYS = {
    announcements: 'show_announcements', featured: 'show_featured', menu: 'show_menu_board',
    catering: 'show_catering', events: 'show_events', artworks: 'show_artworks',
  };
  function sceneOn(settings, name) {
    const scenes = isObj(settings.scenes) ? settings.scenes : {};
    if (Object.prototype.hasOwnProperty.call(scenes, name)) return settingOn(scenes, name);
    return LEGACY_SCENE_KEYS[name] ? settingOn(settings, LEGACY_SCENE_KEYS[name]) : true;
  }
  /** The refresh_version a bundle was built with; read the same way as worker/lib/screens.js does. */
  const versionOf = (bundle) => Number(isObj(bundle.signage) ? bundle.signage.refresh_version : 0) || 0;

  /* -------------------------------------------------------------------------
     Artwork photos: loaded ahead of their scene, remembered once they have loaded
     ------------------------------------------------------------------------- */
  function loadKnownImages() {
    try {
      const saved = JSON.parse(localStorage.getItem(IMAGES_KEY) || 'null');
      if (saved && saved.v === 1 && isObj(saved.images)) return saved.images;
    } catch (e) { note(e, 'cache'); }
    return {};
  }

  /** Keeps the most recent KNOWN_IMAGES photos that loaded; the browser's own cache holds the files. */
  function rememberImage(url, w, h) {
    state.known[url] = [w, h, Date.now()];
    const urls = Object.keys(state.known);
    if (urls.length > KNOWN_IMAGES) {
      urls.sort((a, b) => state.known[a][2] - state.known[b][2]).slice(0, urls.length - KNOWN_IMAGES).forEach((u) => { delete state.known[u]; });
    }
    try { localStorage.setItem(IMAGES_KEY, JSON.stringify({ v: 1, images: state.known })); } catch (e) { note(e, 'cache'); }
  }

  /** 'ok', 'failed', 'loading' or 'unknown' (never tried, or failed long enough ago to try again). */
  function photoState(url) {
    const p = state.images[url];
    if (!p) return 'unknown';
    if (p.ok === null) return 'loading';
    if (p.ok) return 'ok';
    return Date.now() - p.at > IMAGE_RETRY_MS ? 'unknown' : 'failed';
  }

  function photoFailed(url, why) {
    const p = state.images[url] || (state.images[url] = {});
    Object.assign(p, { ok: false, at: Date.now() });
    note(new Error(why + ': ' + url), 'artwork photo');
  }

  /** Loads a photo once (again after IMAGE_RETRY_MS if it failed). Resolves true when it can be shown. */
  function preload(url) {
    const st = photoState(url);
    if (st !== 'unknown') return state.images[url].promise || Promise.resolve(st === 'ok');
    const entry = { ok: null, w: 0, h: 0, at: Date.now() };
    state.images[url] = entry;
    entry.promise = new Promise((resolve) => {
      const img = new Image();
      let timer = null;
      const finish = (ok, why) => {
        if (entry.ok !== null) return;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        if (ok) {
          Object.assign(entry, { ok: true, w: img.naturalWidth, h: img.naturalHeight, at: Date.now() });
          rememberImage(url, entry.w, entry.h);
        } else {
          photoFailed(url, why);
        }
        resolve(ok);
      };
      timer = setTimeout(() => finish(false, 'Timed out after ' + IMAGE_TIMEOUT_MS / 1000 + 's'), IMAGE_TIMEOUT_MS);
      img.onload = () => (img.naturalWidth ? finish(true) : finish(false, 'Empty image'));
      img.onerror = () => finish(false, 'Could not load');
      img.src = url;
    });
    return entry.promise;
  }

  /** Starts loading the photos of the next few artwork scenes while the current scene is up. */
  function preloadAhead() {
    const n = state.scenes.length;
    let found = 0;
    for (let k = 1; k < n && found < PRELOAD_AHEAD; k++) {
      const s = state.scenes[(state.index + k) % n];
      if (!s.photo) continue;
      found++;
      if (photoState(s.photo) === 'unknown') preload(s.photo);
    }
  }

  /** One round trip: the signage bundle, then catering and Blanc when the settings allow. `fresh`: see fetchJson. */
  function refresh(fresh) {
    if (state.fetching) return Promise.resolve(false);
    state.fetching = true;
    state.lastFetchAt = Date.now();
    let fetched = false;
    return fetchJson('/api/public/signage/' + BUSINESS, fresh)
      .then(checkBundle)
      .then((bundle) => {
        const settings = isObj(bundle.signage) ? bundle.signage : {};
        const wantCatering = BUSINESS !== 'catering' && sceneOn(settings, 'catering');
        const wantBlanc = BUSINESS !== 'blanc' && sceneOn(settings, 'events') && settingOn(settings, 'show_blanc');
        // null = turned off; undefined = failed this time, so keep what we had.
        const side = (want, path) => (want ? fetchJson(path, fresh).then(checkBundle).catch((e) => { note(e); return undefined; }) : Promise.resolve(null));
        return Promise.all([side(wantCatering, '/api/public/catering'), side(wantBlanc, '/api/public/blanc')]).then((extra) => {
          const prev = state.data || {};
          state.data = {
            bundle,
            catering: extra[0] === undefined ? prev.catering || null : extra[0],
            blanc: extra[1] === undefined ? prev.blanc || null : extra[1],
            savedAt: Date.now(),
          };
          state.source = 'network';
          state.version = versionOf(bundle);
          state.lastOkAt = state.data.savedAt;
          state.lastError = null;
          saveCache(state.data);
          if (PREVIEW) previewBadge(bundle);
          plan();
          if (!state.timer) advance();
          fetched = true;
          return true;
        });
      })
      .catch((err) => {
        state.lastError = (err && err.message) || String(err);
        note(err, 'fetch');
        // Offline, the gallery slideshow narrows to photos this player has loaded before (see plan()).
        if (state.data && hasArtworks(state.data.bundle)) plan();
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
     Heartbeat (?screen=<id>): "this screen is on and showing X" for the admin's TV screens page. The answer
     carries refresh_version; a new one means staff tapped "Refresh all screens now", so the data is fetched again.
     ------------------------------------------------------------------------- */
  function showingNow() {
    return brandEl.classList.contains('is-on') || !state.history.length ? 'brand' : state.history[state.history.length - 1];
  }

  function heartbeat() {
    if (!SCREEN) return Promise.resolve(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    // text/plain keeps this a simple cross-origin request (no preflight); the Worker reads the body as JSON anyway.
    return fetch(API + '/api/public/screens/' + encodeURIComponent(SCREEN) + '/heartbeat', {
      method: 'POST',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ scene: showingNow(), version: String(state.version) }),
    })
      .then((res) => {
        if (res.status === 429) return null; // a restart moments after the last beat; the next one counts
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for the heartbeat');
        return res.json();
      })
      .then((data) => {
        if (!isObj(data)) return null;
        state.lastBeatAt = Date.now();
        // Different, not just higher: restoring an older TV setting from History must refresh the screens too.
        if ((Number(data.refresh_version) || 0) !== state.version && !state.fetching) refresh(true);
        return data;
      })
      .catch((err) => {
        note(err && err.name === 'AbortError' ? new Error('Timed out after ' + TIMEOUT_MS / 1000 + 's: heartbeat') : err, 'heartbeat');
        return null;
      })
      .finally(() => clearTimeout(timer));
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
    const add = (id, build, factor, extra) => scenes.push(Object.assign({ id, seconds: Math.round(seconds * (factor || 1)), build }, extra));
    // The Worker filters by date when it builds the bundle, but a cached copy can outlive a holiday, so
    // dates are checked again against today's date here (and plan() runs again when the date changes).
    const today = chicagoNow().date;
    state.plannedDate = today;
    const onToday = (from, to) => (!from || from <= today) && (!to || to >= today);

    if (sceneOn(settings, 'welcome')) add('welcome', () => sceneWelcome(bundle));
    const notice = bundle.business.notice;
    if (sceneOn(settings, 'notice') && notice && notice.text && onToday(null, notice.until)) add('notice', () => sceneNotice(bundle));

    // Gallery slideshow (businesses with the artwork catalog): a title card, then one scene per piece.
    state.artPool = 0;
    const gallery = hasArtworks(bundle) && sceneOn(settings, 'artworks') ? slideshow(bundle, today) : null;
    if (gallery) {
      const pool = gallery.pieces;
      state.artPool = pool.length;
      const start = pool.length > ARTWORKS_PER_CYCLE ? state.artOffset % pool.length : 0;
      const picks = [];
      for (let k = 0; k < Math.min(ARTWORKS_PER_CYCLE, pool.length); k++) picks.push(pool[(start + k) % pool.length]);
      // The title card is skipped once photos of this pass have failed and none has loaded (offline, say).
      const titleSkip = () => {
        const states = picks.map((p) => photoState(p.photo.url));
        return states.indexOf('ok') === -1 && states.indexOf('failed') > -1;
      };
      add('exhibition', () => sceneExhibition(bundle, gallery), 1, { skip: titleSkip });
      picks.forEach((p, k) => add('artwork-' + p.art.id, () => sceneArtwork(gallery, p, k, seconds), 1, { photo: p.photo.url }));
    }

    if (sceneOn(settings, 'announcements')) {
      (bundle.announcements || []).filter((a) => isObj(a) && a.title && a.show_on_tv !== false && onToday(a.starts_at, a.ends_at))
        .forEach((a) => add('announcement-' + a.id, () => sceneAnnouncement(bundle, a)));
    }

    const sections = (bundle.menu && Array.isArray(bundle.menu.sections) ? bundle.menu.sections : []).filter((s) => isObj(s) && Array.isArray(s.items));
    if (sceneOn(settings, 'featured')) {
      const featured = [];
      sections.forEach((s) => s.items.forEach((it) => { if (isObj(it) && it.featured && it.name) featured.push({ item: it, section: s }); }));
      chunk(featured, FEATURED_PER_SCENE).forEach((group, i, all) => add('featured-' + (i + 1), () => sceneFeatured(group, i, all.length)));
    }
    if (sceneOn(settings, 'menu')) {
      sections.forEach((s) => {
        const items = s.items.filter((it) => isObj(it) && it.name);
        if (!items.length) return;
        chunk(items, BOARD_PER_SCENE).forEach((group, i, all) => add('menu-' + s.id + (all.length > 1 ? '-' + (i + 1) : ''), () => sceneBoard(s, group, i, all.length), group.length > 8 ? 1.4 : 1));
      });
    }

    if (d.catering && sceneOn(settings, 'catering')) {
      const picks = cateringPicks(d.catering);
      if (picks.length) add('catering', () => sceneCatering(bundle, d.catering, picks));
    }
    if (sceneOn(settings, 'events')) {
      const cards = eventCards(bundle, d.blanc, today);
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
     2b. Gallery slideshow: exhibition title card, then one artwork per scene
     ------------------------------------------------------------------------- */
  const hasArtworks = (bundle) => Boolean(isObj(bundle.features) && bundle.features.artworks && Array.isArray(bundle.artworks));

  /** The first photo of a piece that can go into a src attribute, or null. */
  function artPhoto(art) {
    const images = Array.isArray(art.images) ? art.images : [];
    for (let i = 0; i < images.length; i++) {
      const url = isObj(images[i]) ? safeUrl(images[i].url) : null;
      if (url) return { url, alt: images[i].alt };
    }
    return null;
  }

  /**
   * What the slideshow shows: the pieces of the current exhibition, else of the next one, else the featured
   * pieces. Only pieces with a photo count; offline, only photos this player has loaded before (the rest would
   * fail anyway). Returns { event (null for featured), pieces: [{ art, photo }] } or null.
   */
  function slideshow(bundle, today) {
    const offline = Boolean(state.lastError);
    const pieces = bundle.artworks
      .filter((a) => isObj(a) && a.title)
      .map((a) => ({ art: a, photo: artPhoto(a) }))
      .filter((p) => p.photo && (!offline || state.known[p.photo.url] || photoState(p.photo.url) === 'ok'));
    if (!pieces.length) return null;
    const events = liveEvents(bundle.events, today);
    const inShow = (status) => {
      const shows = events.filter((e) => e.status === status)
        .map((e) => ({ event: e, pieces: pieces.filter((p) => p.art.event_id != null && Number(p.art.event_id) === Number(e.id)) }))
        .filter((s) => s.pieces.length);
      return shows.find((s) => s.event.kind === 'exhibition') || shows[0] || null;
    };
    const found = inShow('current') || inShow('upcoming');
    if (found) return found;
    const featured = pieces.filter((p) => p.art.featured);
    return featured.length ? { event: null, pieces: featured } : null;
  }

  /** "Now showing · <title> · <dates>" before the pieces. */
  function sceneExhibition(bundle, gallery) {
    const e = gallery.event;
    const eyebrow = !e ? 'From the collection' : e.status === 'upcoming' ? 'Coming soon' : 'Now showing';
    const title = e ? text(e.title) : 'Featured works';
    return el('section', { class: 'scene s-gallery s-exhibition' },
      el('p', { class: 'g-eyebrow', text: eyebrow, d: 0 }),
      el('h2', { class: 'g-title' + (title.length > 34 ? ' is-long' : ''), text: title, d: 150 }),
      e && e.subtitle ? el('p', { class: 'g-sub', text: e.subtitle, d: 300 }) : null,
      e && (e.date_text || e.start_date) ? el('p', { class: 'g-dates', text: e.date_text || e.start_date, d: 450 }) : null,
      el('p', { class: 'g-house', text: bundle.business.name, d: 650 }));
  }

  // Ken Burns drift: each piece grows from a slightly different point.
  const ZOOM_ORIGINS = ['50% 45%', '35% 40%', '65% 55%', '45% 65%', '60% 35%'];
  // Wall boxes the photo fits into; they match .s-art--side / .s-art--wide .art__wall in live.css.
  const ART_BOX = { side: [1148, 904], wide: [1728, 676] };

  /** Largest size of a w×h photo inside a box. */
  function fitInto(w, h, box) {
    const s = Math.min(box[0] / w, box[1] / h);
    return [Math.round(w * s), Math.round(h * s)];
  }

  /** One piece: the photo letterboxed on the wall, a label beside it (or under a wide one). Never a price. */
  function sceneArtwork(gallery, pick, k, seconds) {
    const art = pick.art;
    const url = pick.photo.url;
    const p = state.images[url] || {};
    // A wide photo gets the label underneath when that leaves it bigger than the label-beside layout.
    let layout = 'side';
    let size = null;
    if (p.w && p.h) {
      const side = fitInto(p.w, p.h, ART_BOX.side);
      const wide = fitInto(p.w, p.h, ART_BOX.wide);
      if (wide[0] * wide[1] > side[0] * side[1] * 1.05) layout = 'wide';
      size = layout === 'wide' ? wide : side;
    }
    const scene = el('section', { class: 'scene s-gallery s-art s-art--' + layout });
    const img = el('img', { class: 'art__img', attrs: { alt: text(pick.photo.alt) || text(art.title) + (art.artist ? ', by ' + art.artist : '') } });
    if (size) { img.style.width = size[0] + 'px'; img.style.height = size[1] + 'px'; }
    img.style.animationDuration = (seconds + FADE_MS / 1000 + 1) + 's';
    img.style.transformOrigin = ZOOM_ORIGINS[k % ZOOM_ORIGINS.length];
    // Loaded a moment ago, so this comes from the browser's cache; if it still fails, skip the scene.
    img.addEventListener('error', () => {
      photoFailed(url, 'Could not show');
      if (scenesRoot.lastElementChild === scene) advance();
    });
    img.src = url;
    scene.appendChild(el('div', { class: 'art__wall' }, img));

    const e = gallery.event;
    const meta = [art.year, art.medium].filter((v) => v != null && String(v).trim()).join(' · ');
    const title = text(art.title);
    scene.appendChild(el('div', { class: 'art__label', d: 350 },
      el('div', { class: 'art__show' },
        el('p', { class: 'g-eyebrow', text: !e ? 'From the collection' : e.status === 'upcoming' ? 'Coming soon' : 'Now showing' }),
        e ? el('p', { class: 'art__showname', text: e.title }) : null),
      el('div', { class: 'art__text' },
        el('div', { class: 'art__main' },
          el('h2', { class: 'art__title' + (title.length > 40 ? ' is-long' : ''), text: title }),
          art.artist ? el('p', { class: 'art__artist', text: art.artist }) : null),
        el('div', { class: 'art__facts' },
          meta ? el('p', { class: 'art__meta', text: meta }) : null,
          art.dimensions ? el('p', { class: 'art__meta', text: art.dimensions }) : null,
          art.status === 'sold' ? el('p', { class: 'art__sold' }, el('span', { class: 'art__dot', attrs: { 'aria-hidden': 'true' } }), 'Sold') : null))));
    return scene;
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
  /** current + upcoming events of a bundle with their status worked out for `today` (past ones dropped). */
  function liveEvents(events, today) {
    const list = ((events && events.current) || []).concat((events && events.upcoming) || []).filter((e) => isObj(e) && e.title && e.start_date);
    return list
      .map((e) => Object.assign({}, e, { status: (e.end_date || e.start_date) < today ? 'past' : e.start_date > today ? 'upcoming' : 'current' }))
      .filter((e) => e.status !== 'past')
      .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
  }

  function eventCards(bundle, blanc, today) {
    const list = liveEvents(bundle.events, today).slice(0, 3)
      .map((e) => ({ event: e, where: e.location || bundle.business.short_name || bundle.business.name, family: false }));
    if (blanc && blanc.events && blanc.business) {
      const theirs = liveEvents(blanc.events, today);
      const current = theirs.filter((e) => e.status === 'current');
      const pick = current.find((e) => e.kind === 'exhibition') || current[0] || theirs.find((e) => e.status === 'upcoming');
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
    state.waiting = null;
    // End of a pass: with more artworks than fit one pass, the slideshow moves on to the next ones.
    if (state.index >= state.scenes.length - 1 && state.artPool > ARTWORKS_PER_CYCLE) {
      state.artOffset = (state.artOffset + ARTWORKS_PER_CYCLE) % state.artPool;
      plan();
      state.index = -1;
    }
    const n = state.scenes.length;
    for (let tries = 0; tries < n; tries++) {
      state.index = (state.index + 1) % n;
      const scene = state.scenes[state.index];
      if (scene.photo) {
        const st = photoState(scene.photo);
        if (st === 'failed') continue;                       // a photo that will not load: skip its scene
        if (st !== 'ok') { waitForPhoto(scene); return; }    // not loaded yet: keep the current scene up a moment
      }
      if (scene.skip && scene.skip()) continue;
      try {
        show(scene.build());
        schedule(scene.seconds);
        state.history.push(scene.id);
        if (state.history.length > 40) state.history.shift();
        preloadAhead();
        return;
      } catch (e) {
        note(e, 'scene ' + scene.id);
      }
    }
    // Nothing could be built: fall back to the brand screen and try again later.
    brandEl.classList.add('is-on');
    if (n) schedule(DEFAULT_SECONDS);
  }

  /** Leaves the current scene up until the photo of `scene` has loaded (or failed), then moves on. */
  function waitForPhoto(scene) {
    const index = state.index;
    const token = {};
    state.index = index - 1;                 // the next advance() comes back to this scene
    state.waiting = token;
    // Nothing else moved the rotation on meanwhile (a key, the watchdog): carry on from here, even if a
    // refresh re-planned the scenes in the meantime.
    preload(scene.photo).then(() => { if (state.waiting === token) advance(); });
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
    const now = chicagoNow();
    // A new day: plan the scenes again so a long-lived cache rolls over without a fetch.
    if (state.data && state.plannedDate && now.date !== state.plannedDate) plan();
    $('[data-hud-clock]').textContent = now.time;
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
      ['Player id', SCREEN ? SCREEN + ' · last heartbeat ' + stamp(state.lastBeatAt) + ' · refresh version ' + state.version : 'none (no ?screen= in the address)'],
      ['Page', location.href],
      ['Data from', state.source + (state.data ? ' (saved ' + stamp(state.data.savedAt) + ')' : '')],
      ['Last fetch', stamp(state.lastFetchAt) + (state.fetching ? ' (in progress)' : '')],
      ['Last success', stamp(state.lastOkAt)],
      ['Last error', state.lastError || 'none'],
      ['Scenes', state.scenes.map((s) => s.id + ' ' + s.seconds + 's').join(', ') || 'none'],
      ['Showing', brandEl.classList.contains('is-on') || !state.history.length ? 'brand screen' : state.history[state.history.length - 1]],
      ['Artworks', state.artPool ? state.artPool + ' in the slideshow' + (state.artPool > ARTWORKS_PER_CYCLE ? ', this pass from #' + (state.artOffset + 1) : '') + ' · photos loaded ' + Object.keys(state.images).filter((u) => state.images[u].ok).length + ', failed ' + Object.keys(state.images).filter((u) => state.images[u].ok === false).length : 'none'],
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

  /** The PREVIEW corner badge; once the draft is published, discarded or expired the API sends the live data instead. */
  function previewBadge(bundle) {
    let badge = document.getElementById('tv-preview');
    if (!badge) {
      badge = el('div', { text: 'PREVIEW', attrs: { id: 'tv-preview', role: 'status' } });
      badge.style.cssText = 'position:fixed;top:calc(24px * var(--tv-scale, 1));right:calc(24px * var(--tv-scale, 1));z-index:25;'
        + 'padding:calc(8px * var(--tv-scale, 1)) calc(18px * var(--tv-scale, 1));border-radius:calc(8px * var(--tv-scale, 1));'
        + 'background:#c8102e;color:#ffffff;border:calc(2px * var(--tv-scale, 1)) solid #ffffff;'
        + 'font:700 calc(26px * var(--tv-scale, 1))/1.2 system-ui, sans-serif;letter-spacing:0.12em;'
        + 'box-shadow:0 4px 16px rgba(0, 0, 0, 0.35);pointer-events:none';
      document.body.appendChild(badge);
    }
    if (bundle) badge.textContent = bundle.preview ? 'PREVIEW' : 'PREVIEW ENDED · LIVE';
  }

  /* -------------------------------------------------------------------------
     Start
     ------------------------------------------------------------------------- */
  function init() {
    fit();
    if (PREVIEW) previewBadge(null);
    window.addEventListener('resize', fit, { passive: true });
    if (BUSINESS !== 'peachs') {
      // Another business with nothing loaded yet: show its slug as a name rather than Peach's.
      brandEl.setAttribute('data-brand-nowordmark', '');
      $('[data-brand-name]').textContent = BUSINESS.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      $('[data-brand-address]').textContent = '';
    }
    state.known = loadKnownImages();
    const cached = loadCache();
    if (cached) {
      state.data = { bundle: cached.bundle, catering: cached.catering || null, blanc: cached.blanc || null, savedAt: cached.savedAt };
      state.source = 'cache';
      state.version = versionOf(cached.bundle);
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
      if (SCREEN) {
        heartbeat();
        setInterval(heartbeat, HEARTBEAT_MS);
      }
    });
  }

  // Test and preview hooks (used by signage/tv-test.mjs).
  window.__tvNext = advance;
  window.__tv = {
    next: advance,
    refresh,
    heartbeat,
    scenes: () => state.scenes.map((s) => s.id),
    current: () => (state.history.length ? state.history[state.history.length - 1] : null),
    shown: () => state.history.slice(),
    goto: (id) => { const i = state.scenes.findIndex((s) => s.id === id); if (i > -1) { state.index = i - 1; advance(); } },
    state: () => ({ source: state.source, lastOkAt: state.lastOkAt, lastFetchAt: state.lastFetchAt, lastError: state.lastError, errors: state.errors.slice(), hasData: Boolean(state.data), api: API, business: BUSINESS, screen: SCREEN, version: state.version, lastBeatAt: state.lastBeatAt }),
  };

  init();
})();
