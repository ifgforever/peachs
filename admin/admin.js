// Rome's Joy back office: one-page app for staff (no build step, ES module).
// Talks to the Worker described in docs/admin-api.md. Every piece of data from
// the API goes through h() / textContent, never innerHTML.

/* -------------------------------------------------------------------------
   Tiny DOM helpers
   ------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVG_NS = 'http://www.w3.org/2000/svg';
let uid = 0;

/** Build an element: h('p', { class: 'x', onclick }, 'text', child, [more]). Strings become text nodes. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return el;
}

/** Replace an element's children; arrays and null/false are handled like in h(). */
function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** An inline SVG icon from the sprite in index.html. */
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const star = (label = 'Featured') => h('span', { class: 'star', title: label }, icon('star'), h('span', { class: 'visually-hidden' }, ` (${label})`));

/* -------------------------------------------------------------------------
   Settings and storage
   ------------------------------------------------------------------------- */
const TOKEN_KEY = 'rj_admin_token';
const BUSINESS_KEY = 'rj_admin_business';
// Only the page itself may say where the API is (<meta name="api-base">): a link with a query parameter
// must never be able to send someone's token elsewhere.
const API_BASE = ($('meta[name="api-base"]')?.content || '/api').replace(/\/$/, '');

// localStorage can throw (private mode, blocked storage); the app must still work.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

// Where each business's website lives, relative to the site root (the admin is at /admin/).
const SITE_PATHS = {
  romesjoy: '/romesjoy/',
  peachs: '/peachs.html',
  catering: '/catering/',
  'parkway-social': '/parkway-social/',
  'mise-en-place': '/mise-en-place/',
  blanc: '/blanc/',
  'rjc-sausage': '/rjc-sausage/',
};
const siteUrl = (slug) => (SITE_PATHS[slug] ? new URL(`..${SITE_PATHS[slug]}`, location.href).href : null);

const SAVED_MESSAGE = 'Saved. Websites update within a minute.';
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const DIETARY = { GF: 'Gluten free', V: 'Vegetarian', DF: 'Dairy free' };
const KIND_LABELS = { event: 'Event', exhibition: 'Exhibition', program: 'Program or class' };
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', editor: 'Editor' };

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  status: null,       // GET /api/auth/status
  user: null,         // signed-in user
  businesses: [],     // businesses this user may edit (with counts)
  slug: null,         // selected business
  screen: 'overview',
  sub: null,          // e.g. an event id or "new"
  hash: '',
  dirty: false,       // unsaved form changes
};
let ignoreNextHash = false;

const currentBusiness = () => state.businesses.find((b) => b.slug === state.slug) || null;
const isManager = () => state.user && (state.user.role === 'owner' || state.user.role === 'admin');

/* -------------------------------------------------------------------------
   API
   ------------------------------------------------------------------------- */
class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Fetch JSON from the Worker. body: a plain object (sent as JSON) or FormData (sent as is). timeoutMs: give up
 * after that long (photo uploads), so a request stalled on weak wifi fails and can be retried instead of spinning.
 */
async function api(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
  const headers = { Accept: 'application/json' };
  const token = store.get(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers, cache: 'no-store' }; // the admin always wants the latest, even for public bundles
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (controller) init.signal = controller.signal;
  const timedOut = () => new ApiError('The server took too long to answer. Check your connection and try again.', 0, 'timeout');
  let res;
  let data = null;
  try {
    try {
      res = await fetch(`${API_BASE}${path}`, init);
    } catch {
      throw controller?.signal.aborted ? timedOut() : new ApiError('Could not reach the server. Check your connection and try again.', 0, 'network');
    }
    try { data = await res.json(); } catch { data = null; }
    if (controller?.signal.aborted) throw timedOut();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/login')) {
      signOut({ expired: true });
    }
    throw new ApiError(friendlyMessage(res.status, data), res.status, data?.code);
  }
  return data;
}

/** Turn an HTTP failure into a sentence that says what to do next. */
function friendlyMessage(status, data) {
  const serverSays = data && typeof data.error === 'string' ? data.error : '';
  switch (status) {
    case 400: return serverSays ? `Please check the form: ${serverSays}` : 'Please check the form and try again.';
    case 401: return 'Your session has ended. Please sign in again.';
    case 403: return serverSays || 'You do not have permission to do that. Ask an owner or admin.';
    case 404: return 'That item no longer exists. Reload the page to see the latest.';
    case 409: return serverSays ? `Not saved: ${serverSays}` : 'Not saved: it conflicts with something that already exists.';
    case 429: return 'Too many tries. Please wait 15 minutes and try again.';
    case 501: return serverSays || 'That feature is not set up on the server yet.';
    default:
      if (status >= 500) return 'The server had a problem. Please try again in a minute.';
      return serverSays || 'Something went wrong. Please try again.';
  }
}

/* -------------------------------------------------------------------------
   Dates, times, money
   ------------------------------------------------------------------------- */
const pad2 = (n) => String(n).padStart(2, '0');

/** 480 -> "08:00" (for <input type="time">); a closing time of 1440 (midnight) shows as "00:00". */
const minToTime = (min) => (min == null || Number.isNaN(min) ? '' : min === 1440 ? '00:00' : `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`);
/** "08:00" -> 480; "" -> null */
function timeToMin(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** A closing time: "00:00" means midnight at the end of the day (1440), which the API accepts. */
const closeToMin = (value) => { const min = timeToMin(value); return min === 0 ? 1440 : min; };
const CLOSE_AFTER_OPEN = 'The closing time must be after the opening time. For a day that runs until midnight, enter 00:00 as the closing time.';
/** 480 -> "8 am", 870 -> "2:30 pm", 1440 -> "midnight" */
function fmtMin(min) {
  if (min == null) return '';
  if (min === 1440 || min === 0) return 'midnight';
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? `:${pad2(mm)}` : ''} ${hh < 12 ? 'am' : 'pm'}`;
}
const fmtClock = (hhmm) => fmtMin(timeToMin(hhmm));

/** Today's date in Chicago as YYYY-MM-DD. */
function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
/** "2026-10-24" -> "Oct 24, 2026" */
function fmtDate(ymd, { year = true } = {}) {
  const p = dateParts(ymd);
  if (!p) return ymd || '';
  return `${MONTHS[p.m - 1]} ${p.d}${year ? `, ${p.y}` : ''}`;
}
/** Weekday name for a YYYY-MM-DD. */
function weekdayOf(ymd) {
  const p = dateParts(ymd);
  return p ? DAY_LABELS[new Date(p.y, p.m - 1, p.d).getDay()] : '';
}
/** Date range text like the public bundle: "Oct 24 – Dec 5, 2026". */
function dateText(start, end) {
  if (!end || end === start) return fmtDate(start);
  const a = dateParts(start);
  const b = dateParts(end);
  if (a && b && a.y === b.y) return `${fmtDate(start, { year: false })} – ${fmtDate(end)}`;
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}
function timeText(start, end) {
  if (!start) return '';
  return end ? `${fmtClock(start)} – ${fmtClock(end)}` : fmtClock(start);
}
/** SQLite "2026-10-13 15:04:05" (UTC) or an ISO string -> "Oct 13, 2026, 10:04 am" in Chicago. */
function fmtDateTime(value) {
  if (!value) return '';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date).replace(' AM', ' am').replace(' PM', ' pm');
}
function fmtPrice(value) {
  const n = Number(value);
  if (value == null || Number.isNaN(n)) return '';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
/** 1800 -> "$1,800", 950.5 -> "$950.50" (like price_text in the public bundle). */
function fmtUsd(value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return '';
  const cents = Number.isInteger(n) ? 0 : 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents, maximumFractionDigits: cents }).format(n);
}
/** plural(1, 'artwork') -> "1 artwork", plural(3, 'artwork') -> "3 artworks" */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* -------------------------------------------------------------------------
   Toasts, dialogs, busy buttons
   ------------------------------------------------------------------------- */
/** action: { label, onClick } adds a button (e.g. Undo); such a toast stays at least 8 seconds. */
function toast(message, { kind = 'ok', ms = 3600, action = null } = {}) {
  const box = $('#toasts');
  if (!box) return;
  const el = h('div', { class: `toast${kind === 'error' ? ' toast--error' : ''}${action ? ' toast--action' : ''}` }, kind === 'error' ? null : icon('check'), h('span', {}, message));
  if (action) el.append(h('button', { type: 'button', class: 'toast__action', onclick: () => { el.remove(); action.onClick(); } }, action.label));
  while (box.children.length >= 2) box.firstChild.remove(); // never stack more than two
  box.append(el);
  setTimeout(() => el.remove(), action ? Math.max(ms, 8000) : ms);
}

let confirmEl = null;
/** Accessible yes/no dialog. Resolves true when the person confirms. */
function confirmDialog({ title, text, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true }) {
  if (!confirmEl) {
    confirmEl = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
    document.body.append(confirmEl);
  }
  return new Promise((resolve) => {
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => confirmEl.close('cancel') }, cancelLabel);
    const ok = h('button', { type: 'button', class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, onclick: () => confirmEl.close('ok') }, confirmLabel);
    fill(confirmEl,
      h('div', { class: 'dialog__body' }, h('h2', { class: 'dialog__title', id: 'dlg-title' }, title), text ? h('p', { class: 'dialog__text' }, text) : null),
      h('div', { class: 'dialog__actions' }, cancel, ok),
    );
    confirmEl.addEventListener('close', () => resolve(confirmEl.returnValue === 'ok'), { once: true });
    confirmEl.showModal();
    cancel.focus();
  });
}

/** Show a spinner on a button while fn runs; the button cannot be clicked twice. */
async function withBusy(button, fn) {
  if (!button) return fn();
  if (button.classList.contains('is-loading')) return undefined;
  button.classList.add('is-loading');
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

/** Flash a green "Saved" tick on a button for a moment. */
function flashSaved(button, label = 'Saved') {
  if (!button) return;
  const original = [...button.childNodes];
  button.classList.add('is-saved');
  fill(button, icon('check'), ` ${label}`);
  setTimeout(() => {
    button.classList.remove('is-saved');
    fill(button, ...original);
  }, 1800);
}

/* -------------------------------------------------------------------------
   Form helpers: fields, validation, reading values, dirty tracking
   ------------------------------------------------------------------------- */
function field({ label, name, type = 'text', value = '', hint, required = false, placeholder, options, rows, min, max, step, inputmode, autocomplete, maxlength, id }) {
  id = id || `f-${name}-${++uid}`;
  let control;
  if (type === 'select') {
    control = h('select', { class: 'select', id, name }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
  } else if (type === 'textarea') {
    control = h('textarea', { class: 'textarea', id, name, rows: rows || 4, placeholder, maxlength }, value ?? '');
  } else {
    control = h('input', { class: 'input', id, name, type, value: value ?? '', placeholder, min, max, step, inputmode, autocomplete, maxlength });
  }
  if (required) control.setAttribute('aria-required', 'true');
  control.addEventListener('input', () => {
    if (control.getAttribute('aria-invalid') !== 'true') return;
    setError(control, '');
    const summary = control.form && $('.form-error', control.form);
    if (summary && !$('[aria-invalid="true"]', control.form)) summary.textContent = '';
  });
  const hintEl = hint ? h('p', { class: 'field__hint', id: `${id}-hint` }, hint) : null;
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  const wrap = h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label, required ? h('span', { class: 'req' }, '(required)') : null),
    control, hintEl, errorEl);
  wrap.control = control;
  return wrap;
}

function checkbox({ label, name, checked = false, hint, value }) {
  const input = h('input', { type: 'checkbox', name, checked, value });
  return h('label', { class: 'check' }, input, h('span', {}, label, hint ? h('span', { class: 'check__hint' }, hint) : null));
}

function toggle({ label, name, checked = false, extraClass = '' }) {
  const input = h('input', { type: 'checkbox', name, checked });
  return h('label', { class: `switch ${extraClass}`.trim() }, input, h('span', { class: 'switch__track' }), h('span', {}, label));
}

function setError(control, message) {
  const wrap = control.closest('.field');
  const errorEl = wrap ? $('.field__error', wrap) : null;
  if (errorEl) errorEl.textContent = message || '';
  if (message) {
    control.setAttribute('aria-invalid', 'true');
    if (errorEl) {
      const ids = (control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      if (!ids.includes(errorEl.id)) control.setAttribute('aria-describedby', [...ids, errorEl.id].join(' '));
    }
  } else {
    control.removeAttribute('aria-invalid');
  }
}

function clearErrors(form) {
  $$('[aria-invalid]', form).forEach((el) => setError(el, ''));
  $$('.field__error', form).forEach((el) => { el.textContent = ''; });
  const formError = $('.form-error', form);
  if (formError) formError.textContent = '';
}

/** Point out the first invalid field: focus it and show a summary line. */
function showErrors(form, errors) {
  const entries = Object.entries(errors).filter(([, msg]) => msg);
  if (!entries.length) return false;
  for (const [name, msg] of entries) {
    const control = form.elements[name];
    if (control && control.closest) setError(control, msg);
  }
  const summary = $('.form-error', form);
  if (summary) summary.textContent = entries.length === 1 ? 'Please fix the highlighted field.' : `Please fix the ${entries.length} highlighted fields.`;
  const first = form.elements[entries[0][0]];
  if (first && first.focus) first.focus();
  return true;
}

/** Read every named control: text -> trimmed string or null, checkbox -> 1/0, number -> number or null. */
function readForm(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') data[el.name] = el.checked ? 1 : 0;
    else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
    else if (el.type === 'number') data[el.name] = el.value === '' ? null : Number(el.value);
    else if (el.type === 'file') continue;
    else data[el.name] = el.value.trim() === '' ? null : el.value.trim();
  }
  return data;
}

/** Any change in this form means "unsaved changes" until a successful save. */
function trackDirty(form) {
  form.addEventListener('input', () => { state.dirty = true; });
  form.addEventListener('change', () => { state.dirty = true; });
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
/** A web link, or a path on this site (what an uploaded photo gets). */
const isUrl = (s) => !s || /^(https?:\/\/\S+|\/(?!\/)\S*)$/i.test(s);
const LINK_RULE = 'Links must start with https://';
const PHOTO_RULE = 'Photo links must start with https:// (or be an uploaded photo).';

/* -------------------------------------------------------------------------
   Page pieces: headings, empty states, error banners, tabs
   ------------------------------------------------------------------------- */
function pageHead({ title, lead, actions = [] }) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head__row' }, h('h1', {}, title), actions.length ? h('div', { class: 'page-head__actions' }, actions) : null),
    lead ? h('p', { class: 'page-head__lead' }, lead) : null);
}

function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, title), text ? h('p', {}, text) : null, action || null);
}

function errorBanner(err, retry) {
  return h('div', { class: 'banner banner--error', role: 'alert' },
    h('p', {}, err?.message || 'Something went wrong.'),
    retry ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: retry }, 'Try again') : null);
}

function infoBanner(text, { kind = '' } = {}) {
  return h('div', { class: `banner ${kind ? `banner--${kind}` : ''}`.trim() }, h('p', {}, text));
}

/** Accessible tab strip. onSelect(id) is called after the selection moves. */
function tabStrip(tabs, selected, onSelect) {
  const list = h('div', { class: 'tabs', role: 'tablist' });
  tabs.forEach((t) => {
    const btn = h('button', {
      type: 'button', role: 'tab', class: 'tab', id: `tab-${t.id}`, 'aria-selected': String(t.id === selected), tabindex: t.id === selected ? '0' : '-1',
      onclick: () => select(t.id),
    }, t.label, t.count != null ? h('span', { class: 'tab__count' }, String(t.count)) : null);
    list.append(btn);
  });
  function select(id) {
    $$('[role="tab"]', list).forEach((b) => {
      const on = b.id === `tab-${id}`;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    onSelect(id);
  }
  list.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const buttons = $$('[role="tab"]', list);
    const i = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = buttons[(i + keys[e.key] + buttons.length) % buttons.length];
    select(next.id.replace('tab-', ''));
    next.focus();
  });
  return list;
}

/* -------------------------------------------------------------------------
   Photos: shrink in the browser, then upload (docs/admin-api.md, "Photo upload").
   Phones take 12-megapixel photos; the websites need at most 2000 px. Shrinking
   first makes uploads quick on the gallery's wifi and keeps every file small.
   ------------------------------------------------------------------------- */
const PHOTO_FULL_PX = 2000;
const PHOTO_THUMB_PX = 640;
const PHOTO_FORMAT_MESSAGE = "This photo format isn't supported by this browser. On iPhone, set Camera → Formats → Most Compatible, or upload a JPEG.";
const STEP_TEXT = { waiting: 'Waiting…', shrinking: 'Shrinking…', uploading: 'Uploading…', done: 'Done' };
const UPLOAD_TIMEOUT_MS = 60000; // per request; a stalled upload then fails with a message and can be tried again

class PhotoError extends Error {}

/** Decode a picked file the right way up. Throws PhotoError when this browser cannot read the format (HEIC, mostly). */
async function decodePhoto(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch { /* try an <img> below */ }
  }
  try {
    // A data: URL rather than a blob: URL, because the admin's Content-Security-Policy allows data: images only.
    const src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = new Image();
    img.src = src;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
  } catch {
    throw new PhotoError(PHOTO_FORMAT_MESSAGE);
  }
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** Safari cannot encode WebP (it hands back a PNG), so ask once rather than making and dropping two PNGs per photo. */
let webpEncodes = null;
function canEncodeWebp() {
  if (webpEncodes == null) {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    try { webpEncodes = probe.toDataURL('image/webp').startsWith('data:image/webp'); } catch { webpEncodes = false; }
  }
  return webpEncodes;
}

/** Draw the picture at most maxPx on its longest side and encode it: WebP 0.85, or JPEG 0.88 where WebP cannot be made. */
async function encodePhoto(source, width, height, maxPx) {
  const scale = Math.min(1, maxPx / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  let blob = canEncodeWebp() ? await canvasBlob(canvas, 'image/webp', 0.85) : null;
  if (!blob || blob.type !== 'image/webp') {
    // Safari answers a WebP request with a PNG. JPEG has no transparency, so lay the picture on white first.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, 'image/jpeg', 0.88);
  }
  if (!blob) throw new PhotoError('This photo could not be prepared for upload. Please try another photo.');
  return { blob, canvas, width: canvas.width, height: canvas.height };
}

/** "IMG_2041.HEIC" -> "img_2041"; the Worker adds the time, the variant and the extension. */
const photoName = (file) => String(file.name || 'photo').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';

function postPhoto(slug, variant, { blob, width, height }, name) {
  const body = new FormData();
  body.append('file', blob, `${name}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`);
  body.append('business', slug);
  body.append('variant', variant);
  body.append('width', String(width));
  body.append('height', String(height));
  return api('/admin/media', { method: 'POST', body, timeoutMs: UPLOAD_TIMEOUT_MS });
}

/**
 * Shrink a picked photo and upload it: a full copy (≤ 2000 px) and, unless thumb is false, a thumbnail
 * (≤ 640 px). onStep('shrinking' | 'uploading') reports progress. Resolves { url, thumb_url, width, height }.
 */
async function uploadPhoto(file, { slug, thumb = true, onStep = () => {} }) {
  onStep('shrinking');
  const decoded = await decodePhoto(file);
  let full;
  let small = null;
  try {
    full = await encodePhoto(decoded.source, decoded.width, decoded.height, PHOTO_FULL_PX);
    // The thumbnail is drawn from the shrunk copy: quicker, and smoother than one big jump.
    if (thumb) small = await encodePhoto(full.canvas, full.width, full.height, PHOTO_THUMB_PX);
  } finally {
    decoded.release();
  }
  [full, small].forEach((c) => { if (c) c.canvas.width = 0; }); // phones run out of canvas memory after a dozen photos otherwise
  onStep('uploading');
  const name = photoName(file);
  const fullRes = await postPhoto(slug, 'full', full, name);
  const thumbRes = small ? await postPhoto(slug, 'thumb', small, name) : null;
  return { url: fullRes.url, thumb_url: thumbRes ? thumbRes.url : null, width: full.width, height: full.height };
}

/** Photos the admin can preview: https links and this site's own files (its Content-Security-Policy allows no others). */
const previewable = (url) => /^(https:\/\/\S+|\/(?!\/)\S*)$/i.test(url || '') || String(url || '').startsWith(`${location.origin}/`);

/**
 * Photo link field. When photo storage is configured on the server it also offers "Choose a photo": the
 * photo is shrunk in the browser, uploaded, and its link lands in the field (saved with the form).
 */
function imageField({ value, name = 'image_url' }) {
  const media = Boolean(state.status?.media_configured);
  const urlField = field({
    label: 'Photo link', name, type: 'url', value, placeholder: 'https://…',
    hint: media ? 'Upload a photo below, or paste a link to one.' : 'Paste a link to a photo (https://…). Photo uploads are not set up on the server yet.',
  });
  const preview = h('img', { class: 'photo-preview', alt: 'Preview of the photo', hidden: true });
  const showPreview = () => {
    const url = urlField.control.value.trim();
    preview.hidden = !previewable(url);
    if (!preview.hidden && preview.getAttribute('src') !== url) preview.src = url;
  };
  preview.addEventListener('error', () => { preview.hidden = true; });
  urlField.control.addEventListener('change', showPreview);
  showPreview();
  const wrap = h('div', { class: 'form__row' }, urlField, preview);
  if (media) {
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'file-pick__input', id: `file-${++uid}` });
    const status = h('p', { class: 'field__hint', 'aria-live': 'polite' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      status.classList.remove('is-error');
      fileInput.disabled = true;
      try {
        const photo = await uploadPhoto(file, { slug: state.slug, thumb: false, onStep: (step) => { status.textContent = STEP_TEXT[step]; } });
        urlField.control.value = photo.url;
        setError(urlField.control, '');
        showPreview();
        state.dirty = true;
        status.textContent = 'Uploaded. Save the form to keep it.';
      } catch (err) {
        status.classList.add('is-error');
        status.textContent = err.message;
      } finally {
        fileInput.disabled = false;
      }
    });
    wrap.append(h('div', { class: 'field' },
      h('span', { class: 'field__label' }, 'Upload a photo'),
      h('div', { class: 'file-pick' }, fileInput, h('label', { class: 'btn btn--secondary file-pick__btn', for: fileInput.id }, icon('camera'), 'Choose a photo')),
      status));
  }
  return wrap;
}

/* -------------------------------------------------------------------------
   Screens registry and routing (hash based so the back button works)
   ------------------------------------------------------------------------- */
const SCREENS = [
  { id: 'overview', label: 'Overview', icon: 'home', group: 'business', render: screenOverview },
  { id: 'hours', label: 'Hours', icon: 'clock', group: 'business', render: screenHours },
  { id: 'contact', label: 'Contact & links', icon: 'card', group: 'business', render: screenContact },
  { id: 'notice', label: 'Notice', icon: 'bell', group: 'business', render: screenNotice },
  { id: 'events', label: 'Events', icon: 'calendar', group: 'business', render: screenEvents },
  { id: 'artworks', label: 'Artworks', icon: 'frame', group: 'business', render: screenArtworks, feature: 'artworks' },
  { id: 'menu', label: 'Menu', icon: 'menu', group: 'business', render: screenMenu },
  { id: 'announcements', label: 'Announcements', icon: 'megaphone', group: 'business', render: screenAnnouncements },
  { id: 'inquiries', label: 'Inquiries', icon: 'inbox', group: 'business', render: screenInquiries },
  { id: 'history', label: 'History', icon: 'history', group: 'everything', render: screenHistory },
  { id: 'users', label: 'Users', icon: 'users', group: 'everything', render: screenUsers, managerOnly: true },
  { id: 'account', label: 'Account', icon: 'user', group: 'everything', render: screenAccount },
];
const PHONE_NAV = ['overview', 'hours', 'events', 'inquiries'];

const screenById = (id) => SCREENS.find((s) => s.id === id);
/** Switched on per business by the setting features:<slug> (e.g. { artworks: true }); missing = off. */
const hasFeature = (name) => Boolean(currentBusiness()?.features?.[name]);
const screenAllowed = (def) => (!def.managerOnly || isManager()) && (!def.feature || hasFeature(def.feature));
// A gallery edits its artworks far more often than its hours, so Artworks takes the Hours spot on the phone bar.
const phoneNav = () => (hasFeature('artworks') ? ['overview', 'artworks', 'events', 'inquiries'] : PHONE_NAV);
const hashFor = (screen, sub) => `#/${screen}${sub != null && sub !== '' ? `/${encodeURIComponent(sub)}` : ''}`;

function parseHash() {
  const m = /^#\/([a-z-]+)(?:\/([^/]+))?/.exec(location.hash);
  return { screen: m ? m[1] : 'overview', sub: m && m[2] ? decodeURIComponent(m[2]) : null };
}

/** Go to a screen. Returns false when the person chose to stay because of unsaved changes. */
function go(screen, sub = null) {
  const next = hashFor(screen, sub);
  if (next === location.hash) { route(); return true; }
  location.hash = next;
  return true;
}

function leaveGuard() {
  if (!state.dirty) return true;
  // The native dialog is synchronous, which the back button needs.
  const ok = window.confirm('You have unsaved changes. Leave this page without saving?');
  if (ok) state.dirty = false;
  return ok;
}

window.addEventListener('hashchange', () => {
  if (ignoreNextHash) { ignoreNextHash = false; return; }
  if (!leaveGuard()) {
    ignoreNextHash = true;
    location.hash = state.hash;
    return;
  }
  route({ focusHeading: true });
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/** Render the screen named in the hash into <main>. focusHeading moves focus to the new h1 (after a navigation). */
async function route({ focusHeading = false } = {}) {
  if (!state.user) return;
  let { screen, sub } = parseHash();
  let def = screenById(screen);
  if (!def || !screenAllowed(def)) {
    def = screenById('overview'); screen = 'overview'; sub = null;
    if (location.hash && location.hash !== hashFor('overview')) history.replaceState(null, '', hashFor('overview')); // no hashchange
  }
  if (state.user.must_change_password && screen !== 'account') {
    if (location.hash !== hashFor('account')) { ignoreNextHash = true; location.hash = hashFor('account'); }
    screen = 'account'; sub = null; def = screenById('account');
  }
  state.screen = screen;
  state.sub = sub;
  state.hash = hashFor(screen, sub);
  state.dirty = false;
  syncNav();
  const main = $('#main');
  fill(main, h('p', { class: 'loading' }, 'Loading…'));
  main.scrollTop = 0;
  window.scrollTo({ top: 0 });
  if (def.group === 'business' && !state.slug) {
    fill(main, pageHead({ title: def.label }), emptyState('No business to edit yet', 'Your account is not attached to any business. Ask an owner or admin to add you to one.'));
    return;
  }
  try {
    await def.render(main, { slug: state.slug, sub });
  } catch (err) {
    fill(main, pageHead({ title: def.label }), errorBanner(err, () => route()));
  }
  const heading = $('h1', main);
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    if (focusHeading) heading.focus({ preventScroll: true });
  }
}

/* -------------------------------------------------------------------------
   App shell: header with business switcher, side nav, bottom nav, "More" sheet
   ------------------------------------------------------------------------- */
function navLink(def, { bottom = false } = {}) {
  const biz = currentBusiness();
  const count = def.id === 'inquiries' && biz?.counts?.new_inquiries ? biz.counts.new_inquiries : 0;
  return h('a', {
    class: bottom ? 'bottomnav__item' : 'sidenav__link', href: hashFor(def.id), dataset: { nav: def.id },
    'aria-current': state.screen === def.id ? 'page' : null,
  }, icon(def.icon), h('span', {}, def.label), count ? h('span', { class: 'count', 'aria-label': `${count} new` }, String(count)) : null);
}

function navList() {
  const visible = SCREENS.filter(screenAllowed);
  const list = h('ul', { class: 'sidenav__list', role: 'list' });
  let group = null;
  visible.forEach((def) => {
    if (def.group !== group) {
      group = def.group;
      list.append(h('li', { class: 'sidenav__group', 'aria-hidden': 'true' }, group === 'business' ? 'This business' : 'Everything'));
    }
    list.append(h('li', {}, navLink(def)));
  });
  return list;
}

function renderShell() {
  const app = $('#app');
  app.className = 'app has-nav';

  const select = h('select', { id: 'business-select', 'aria-label': 'Business you are editing' },
    state.businesses.map((b) => h('option', { value: b.slug, selected: b.slug === state.slug }, b.name)));
  select.addEventListener('change', () => {
    if (!leaveGuard()) { select.value = state.slug; return; }
    setBusiness(select.value);
  });

  const more = h('dialog', { class: 'sheet', 'aria-labelledby': 'sheet-title' },
    h('div', { class: 'sheet__head' }, h('h2', { class: 'sheet__title', id: 'sheet-title' }, 'All pages'),
      h('button', { type: 'button', class: 'btn btn--icon btn--secondary btn--sm', 'aria-label': 'Close', onclick: () => more.close() }, icon('close'))),
    h('nav', { 'aria-label': 'All pages' }, navList()));
  more.addEventListener('click', (e) => { if (e.target.closest('a')) more.close(); });

  const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Main' },
    phoneNav().map((id) => navLink(screenById(id), { bottom: true })),
    h('button', { type: 'button', class: 'bottomnav__item', 'aria-haspopup': 'dialog', onclick: () => { fill($('nav', more), navList()); more.showModal(); } }, icon('more'), h('span', {}, 'More')));

  fill(app,
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: hashFor('overview') }, h('span', { class: 'brand__name' }, 'Rome’s Joy'), h('span', { class: 'brand__sub' }, 'Back office')),
      state.businesses.length ? h('div', { class: 'switcher' }, h('label', { class: 'switcher__label', for: 'business-select' }, 'Editing'), select) : null,
      h('a', { class: 'topbar__user', href: hashFor('account') }, icon('user'), h('span', {}, state.user.name || state.user.email)),
    ),
    h('div', { class: 'frame' },
      h('nav', { class: 'sidenav', 'aria-label': 'Main' }, navList()),
      h('main', { id: 'main', class: 'main', tabindex: '-1' }),
    ),
    bottom, more,
  );
  navShape = currentNavShape();
}

function syncNav() {
  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === state.screen;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

/** Rebuild the side nav and the phone bar when the screens on offer change (another business, other features). */
let navShape = '';
const currentNavShape = () => `${SCREENS.filter(screenAllowed).map((s) => s.id)}|${phoneNav()}`;
function renderNav() {
  const shape = currentNavShape();
  if (shape === navShape) { refreshNavCounts(); return; }
  navShape = shape;
  const side = $('.sidenav');
  if (side) fill(side, navList());
  const bottom = $('.bottomnav');
  const more = bottom && $('[aria-haspopup="dialog"]', bottom);
  if (bottom) fill(bottom, phoneNav().map((id) => navLink(screenById(id), { bottom: true })), more);
  syncNav();
}

/** Refresh the unread badge next to "Inquiries" after counts change. */
function refreshNavCounts() {
  $$('[data-nav="inquiries"]').forEach((a) => {
    const fresh = navLink(screenById('inquiries'), { bottom: a.classList.contains('bottomnav__item') });
    a.replaceWith(fresh);
    if (state.screen === 'inquiries') fresh.classList.add('is-active');
  });
}

function setBusiness(slug) {
  state.slug = slug;
  store.set(BUSINESS_KEY, slug);
  $$('#business-select').forEach((s) => { s.value = slug; });
  renderNav();
  route();
}

async function loadBusinesses() {
  const res = await api('/admin/businesses');
  state.businesses = res.businesses || [];
  const fromQuery = new URLSearchParams(location.search).get('business');
  const remembered = store.get(BUSINESS_KEY);
  const pick = state.businesses.find((b) => b.slug === fromQuery) || state.businesses.find((b) => b.slug === remembered) || state.businesses[0];
  state.slug = pick ? pick.slug : null;
  if (state.slug) store.set(BUSINESS_KEY, state.slug);
}

/* -------------------------------------------------------------------------
   Sign in, first account, sign out
   ------------------------------------------------------------------------- */
function authFrame(title, lead, ...content) {
  const app = $('#app');
  app.className = 'app';
  const main = h('main', { id: 'main', class: 'main', tabindex: '-1' },
    h('div', { class: 'auth' },
      h('div', { class: 'auth__brand' }, h('p', { class: 'brand__sub', style: 'color:var(--orange-ink);font-weight:700' }, 'Rome’s Joy back office'), h('h1', {}, title), lead ? h('p', {}, lead) : null),
      h('div', { class: 'card' }, ...content)));
  fill(app, main);
  return main;
}

function renderLogin({ message } = {}) {
  const email = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', required: true });
  const password = field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Sign in');
  const form = h('form', { class: 'form', novalidate: true }, email, password, h('p', { class: 'form-error', role: 'alert' }), submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    if (showErrors(form, { email: isEmail(data.email) ? '' : 'Enter the email address you sign in with.', password: data.password ? '' : 'Enter your password.' })) return;
    withBusy(submit, async () => {
      try {
        const res = await api('/auth/login', { method: 'POST', body: { email: data.email.toLowerCase(), password: data.password } });
        await afterLogin(res.token, res.user);
      } catch (err) {
        $('.form-error', form).textContent = err.code === 'invalid_credentials' ? 'That email and password do not match. Try again, or ask an owner to reset your password.' : err.message;
      }
    });
  });
  authFrame('Sign in', 'Edit hours, menus, events and more for every Rome’s Joy business.', message ? infoBanner(message) : null, form);
  email.control.focus();
}

function renderBootstrap() {
  const token = field({ label: 'Setup token', name: 'token', type: 'password', required: true, hint: 'The ADMIN_BOOTSTRAP_TOKEN from the server setup. Ask whoever deployed the site.' });
  const name = field({ label: 'Your name', name: 'name', autocomplete: 'name', required: true });
  const email = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', required: true });
  const password = field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 8 characters.' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Create account');
  const form = h('form', { class: 'form', novalidate: true }, token, name, email, password, h('p', { class: 'form-error', role: 'alert' }), submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    if (showErrors(form, {
      token: data.token ? '' : 'Enter the setup token.',
      name: data.name ? '' : 'Enter your name.',
      email: isEmail(data.email) ? '' : 'Enter a valid email address.',
      password: (data.password || '').length >= 8 ? '' : 'Use at least 8 characters.',
    })) return;
    withBusy(submit, async () => {
      try {
        const res = await api('/auth/bootstrap', { method: 'POST', body: { token: data.token, email: data.email.toLowerCase(), password: data.password, name: data.name } });
        state.status = { ...state.status, has_users: true };
        await afterLogin(res.token, res.user);
      } catch (err) {
        $('.form-error', form).textContent = err.status === 403 ? 'That setup token is not right, or an account already exists. Reload the page and try again.' : err.message;
      }
    });
  });
  authFrame('Create the first account', 'This account becomes the owner. You can add the rest of the team afterwards.', form);
  token.control.focus();
}

async function afterLogin(token, user) {
  if (token) store.set(TOKEN_KEY, token);
  state.user = user;
  await loadBusinesses();
  renderShell();
  if (!location.hash) {
    ignoreNextHash = true;
    location.hash = hashFor('overview');
  }
  await route();
  $('#main')?.focus({ preventScroll: true });
}

function signOut({ expired = false } = {}) {
  const hadUser = Boolean(state.user);
  store.remove(TOKEN_KEY);
  state.user = null;
  state.businesses = [];
  state.dirty = false;
  if (hadUser || expired) {
    history.replaceState(null, '', location.pathname + location.search); // replaceState fires no hashchange
    renderLogin({ message: expired ? 'Your session has ended. Please sign in again.' : 'You are signed out.' });
  }
}

/* -------------------------------------------------------------------------
   Overview
   ------------------------------------------------------------------------- */
async function screenOverview(main, { slug }) {
  const [bundle, bizList] = await Promise.all([
    api(`/public/${encodeURIComponent(slug)}`),
    api('/admin/businesses').catch(() => null),
  ]);
  if (bizList?.businesses) {
    state.businesses = bizList.businesses;
    renderNav(); // counts, and features switched on or off since sign-in
  }
  const biz = currentBusiness() || {};
  const counts = biz.counts || {};
  const today = bundle.today?.date || chicagoToday();
  const todayRow = (bundle.hours || []).find((r) => r.weekday === bundle.today?.weekday);
  const todayException = (bundle.exceptions || []).find((x) => x.date === today);
  const upcoming = bundle.events?.upcoming || [];
  const current = bundle.events?.current || [];
  const next = upcoming[0];
  const happening = counts.current_events ?? current.length;
  // The card counts what the Events page calls "Upcoming"; events on now are mentioned in the note.
  const eventsNote = [
    happening ? `${happening} happening now` : null,
    next ? `Next: ${next.title} · ${next.date_text || dateText(next.start_date, next.end_date)}` : null,
  ].filter(Boolean).join(' · ') || 'Nothing scheduled.';
  const notice = bundle.business?.notice;
  const website = siteUrl(slug);

  const stat = ({ label, value, note, link, extraClass = '', big = false }) => h('div', { class: `stat ${extraClass}`.trim() },
    h('p', { class: 'stat__label' }, label),
    h('p', { class: `stat__value${big ? ' stat__value--big' : ''}` }, value),
    note ? h('p', { class: 'stat__note' }, note) : null,
    link ? h('a', { class: 'stat__link', href: link.href, target: link.external ? '_blank' : null, rel: link.external ? 'noopener' : null }, link.label, link.external ? icon('external') : null) : null);

  const todayText = todayException
    ? `${todayException.closed ? 'Closed' : `${todayException.open} – ${todayException.close}`}${todayException.label ? ` · ${todayException.label}` : ''}`
    : (todayRow?.text || 'No hours set');

  fill(main,
    pageHead({ title: bundle.business?.name || biz.name || slug, lead: `What visitors see right now. Checked ${fmtDateTime(bundle.open_now?.checked_at || bundle.generated_at)}.` }),
    h('div', { class: 'stats' },
      stat({ label: 'Right now', value: bundle.open_now?.text || 'Unknown', extraClass: bundle.open_now?.open ? 'stat--open' : 'stat--closed', note: todayException ? 'A special day is in effect today.' : null, link: { href: hashFor('hours'), label: 'Change hours' } }),
      stat({ label: `Today, ${weekdayOf(today)}`, value: todayText, note: bundle.hours_summary ? `Usual week: ${bundle.hours_summary}` : null, link: { href: hashFor('hours'), label: 'Edit hours' } }),
      stat({ label: 'New inquiries', value: String(counts.new_inquiries ?? 0), big: true, note: counts.new_inquiries ? 'Waiting for a reply.' : 'Nothing new.', link: { href: hashFor('inquiries'), label: 'Open the inbox' } }),
      stat({ label: 'Upcoming events', value: String(counts.upcoming_events ?? upcoming.length), big: true, note: eventsNote, link: { href: hashFor('events'), label: 'Manage events' } }),
      biz.features?.artworks ? stat({
        label: 'Artworks', value: `${plural(counts.artworks ?? 0, 'artwork')} · ${counts.artworks_available ?? 0} available`,
        note: 'Pieces on the website, with photos, prices and sold dots.', link: { href: hashFor('artworks'), label: 'Manage artworks' },
      }) : null,
      stat({ label: 'Site notice', value: notice ? notice.text : 'No notice showing', note: notice?.until ? `Shows until ${fmtDate(notice.until)}` : null, link: { href: hashFor('notice'), label: notice ? 'Change notice' : 'Add a notice' }, extraClass: 'stat--wide' }),
      website ? stat({ label: 'Website', value: biz.name || bundle.business?.name || slug, note: bundle.business?.tagline || null, link: { href: website, label: 'View website', external: true }, extraClass: 'stat--wide' }) : null,
    ),
  );
}

/* -------------------------------------------------------------------------
   Hours: weekly hours plus special days
   ------------------------------------------------------------------------- */
async function screenHours(main, { slug }) {
  const data = await api(`/admin/businesses/${encodeURIComponent(slug)}`);
  const byDay = new Map((data.hours || []).map((r) => [r.weekday, r]));
  const todayWeekday = new Date(`${chicagoToday()}T12:00:00`).getDay();

  // --- Weekly hours form ---
  const rows = WEEK_ORDER.map((weekday) => {
    const r = byDay.get(weekday) || { weekday, closed: 1, open_min: null, close_min: null };
    const closedToggle = toggle({ label: 'Closed', name: `closed-${weekday}`, checked: Boolean(r.closed), extraClass: 'hours__switch' });
    const openField = h('input', { class: 'input', type: 'time', name: `open-${weekday}`, value: minToTime(r.open_min), 'aria-label': `${DAY_LABELS[weekday]} opens at`, step: 300 });
    const closeField = h('input', { class: 'input', type: 'time', name: `close-${weekday}`, value: minToTime(r.close_min), 'aria-label': `${DAY_LABELS[weekday]} closes at`, step: 300 });
    const times = h('div', { class: `hours__times${r.closed ? ' is-closed' : ''}` }, openField, h('span', { class: 'hours__dash', 'aria-hidden': 'true' }, '–'), closeField);
    const closedText = h('p', { class: 'hours__closed-text', hidden: !r.closed }, 'Closed all day');
    const error = h('p', { class: 'field__error', id: `hours-err-${weekday}` });
    const row = h('div', { class: `hours__row${weekday === todayWeekday ? ' is-today' : ''}`, dataset: { weekday: String(weekday) } },
      h('div', { class: 'hours__day' }, DAY_LABELS[weekday], weekday === todayWeekday ? h('small', {}, 'Today') : null),
      closedToggle, times, closedText, error);
    const input = $('input', closedToggle);
    input.addEventListener('change', () => {
      times.classList.toggle('is-closed', input.checked);
      closedText.hidden = !input.checked;
    });
    return { weekday, row, closedInput: input, openField, closeField, error };
  });

  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save hours');
  const copyFromId = `copy-from-${++uid}`;
  const copyFrom = h('select', { class: 'select input--inline', id: copyFromId }, WEEK_ORDER.map((d) => h('option', { value: String(d) }, DAY_LABELS[d])));
  const copyBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Copy to all open days');
  copyBtn.addEventListener('click', () => {
    const src = rows.find((r) => r.weekday === Number(copyFrom.value));
    if (!src || src.closedInput.checked || !src.openField.value || !src.closeField.value) {
      toast(`${DAY_LABELS[Number(copyFrom.value)]} has no open hours to copy.`, { kind: 'error' });
      return;
    }
    rows.forEach((r) => {
      if (r === src || r.closedInput.checked) return;
      r.openField.value = src.openField.value;
      r.closeField.value = src.closeField.value;
    });
    state.dirty = true;
    toast(`Copied ${DAY_LABELS[src.weekday]}'s hours to every open day. Save to keep it.`);
  });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'hours' }, rows.map((r) => r.row)),
    h('div', { class: 'actions' }, h('label', { class: 'small muted', for: copyFromId }, 'Copy hours from'), copyFrom, copyBtn),
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions actions--sticky' }, saveBtn));
  trackDirty(form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    let firstBad = null;
    const hours = rows.map((r) => {
      r.error.textContent = '';
      [r.openField, r.closeField].forEach((f) => { f.removeAttribute('aria-invalid'); f.removeAttribute('aria-describedby'); });
      if (r.closedInput.checked) return { weekday: r.weekday, closed: 1, open_min: null, close_min: null };
      const open_min = timeToMin(r.openField.value);
      const close_min = closeToMin(r.closeField.value);
      let problem = '';
      if (open_min == null || close_min == null) problem = 'Enter both an opening and a closing time, or mark the day closed.';
      else if (open_min >= close_min) problem = CLOSE_AFTER_OPEN;
      if (problem) {
        r.error.textContent = problem;
        const flagged = open_min == null ? r.openField : r.closeField;
        flagged.setAttribute('aria-invalid', 'true');
        flagged.setAttribute('aria-describedby', r.error.id); // so a screen reader hears why, not just "invalid"
        firstBad = firstBad || flagged;
      }
      return { weekday: r.weekday, closed: 0, open_min, close_min };
    });
    if (firstBad) {
      $('.form-error', form).textContent = 'Please fix the highlighted days.';
      firstBad.focus();
      return;
    }
    withBusy(saveBtn, async () => {
      try {
        await api(`/admin/businesses/${encodeURIComponent(slug)}/hours`, { method: 'PUT', body: { hours } });
        state.dirty = false;
        flashSaved(saveBtn);
        toast(SAVED_MESSAGE);
      } catch (err) {
        $('.form-error', form).textContent = err.message;
      }
    });
  });

  // --- Special days (holidays, one-off changes) ---
  const list = h('div', { class: 'list' });
  const exceptions = [...(data.exceptions || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  const today = chicagoToday();

  function exceptionRow(x) {
    const when = x.closed ? 'Closed' : `${fmtMin(x.open_min)} – ${fmtMin(x.close_min)}`;
    const del = h('button', { type: 'button', class: 'btn btn--danger btn--sm' }, 'Delete');
    const row = h('div', { class: 'list__row', dataset: { date: x.date } },
      h('div', { class: 'list__main' },
        h('p', { class: 'list__title' }, `${weekdayOf(x.date)}, ${fmtDate(x.date)}`, x.label ? ` · ${x.label}` : ''),
        h('p', { class: 'list__meta' }, when)),
      h('div', { class: 'list__actions' }, del));
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Delete ${fmtDate(x.date)}?`, text: 'The usual weekly hours will apply on that day again.' });
      if (!ok) return;
      withBusy(del, async () => {
        try {
          await api(`/admin/hours/exceptions/${x.id}`, { method: 'DELETE' });
          row.remove();
          if (!list.children.length) list.append(emptyExceptions());
          toast(SAVED_MESSAGE);
        } catch (err) { toast(err.message, { kind: 'error' }); }
      });
    });
    return row;
  }
  const emptyExceptions = () => emptyState('No special days coming up', 'Add one below for a holiday closure or a one-off change of hours.');
  append(list, [exceptions.length ? exceptions.map(exceptionRow) : emptyExceptions()]);

  const exDate = field({ label: 'Date', name: 'date', type: 'date', min: today, required: true });
  const exLabel = field({ label: 'Reason (shown on the website and TV)', name: 'label', placeholder: 'e.g. Thanksgiving', maxlength: 80 });
  const exClosed = toggle({ label: 'Closed all day', name: 'closed', checked: true });
  const exOpen = h('input', { class: 'input', type: 'time', name: 'open', 'aria-label': 'Opens at', step: 300 });
  const exClose = h('input', { class: 'input', type: 'time', name: 'close', 'aria-label': 'Closes at', step: 300 });
  const exTimes = h('div', { class: 'hours__times is-closed' }, exOpen, h('span', { class: 'hours__dash', 'aria-hidden': 'true' }, '–'), exClose);
  const exTimesField = h('div', { class: 'field', hidden: true }, h('span', { class: 'field__label' }, 'Hours that day'), exTimes, h('p', { class: 'field__error', id: `ex-time-err-${++uid}` }));
  $('input', exClosed).addEventListener('change', (e) => { exTimes.classList.toggle('is-closed', e.target.checked); exTimesField.hidden = e.target.checked; });
  const addBtn = h('button', { type: 'submit', class: 'btn btn--secondary' }, 'Add special day');
  const exForm = h('form', { class: 'form card', novalidate: true },
    h('h3', { class: 'card__title' }, 'Add a special day'),
    h('div', { class: 'form__row form__row--2' }, exDate, exLabel),
    exClosed, exTimesField,
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions' }, addBtn));
  trackDirty(exForm);
  exForm.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(exForm);
    const closed = $('input', exClosed).checked;
    const date = exDate.control.value;
    const open_min = closed ? null : timeToMin(exOpen.value);
    const close_min = closed ? null : closeToMin(exClose.value);
    const errors = {};
    if (!date) errors.date = 'Pick a date.';
    else if (date < today) errors.date = 'Pick today or a later date.';
    if (!closed && (open_min == null || close_min == null)) errors.open = 'Enter both times, or mark the day closed.';
    else if (!closed && open_min >= close_min) errors.close = CLOSE_AFTER_OPEN;
    const timeErr = $('.field__error[id^="ex-time-err"]', exForm);
    timeErr.textContent = errors.open || errors.close || '';
    if (showErrors(exForm, { date: errors.date })) return;
    if (timeErr.textContent) { (errors.open ? exOpen : exClose).focus(); return; }
    withBusy(addBtn, async () => {
      try {
        const res = await api(`/admin/businesses/${encodeURIComponent(slug)}/hours/exceptions`, {
          method: 'POST', body: { date, closed: closed ? 1 : 0, open_min, close_min, label: exLabel.control.value.trim() || null },
        });
        if ($('.empty', list)) fill(list);
        const rowEl = exceptionRow(res.exception || { id: res.id, date, closed: closed ? 1 : 0, open_min, close_min, label: exLabel.control.value.trim() || null });
        const after = [...list.children].find((el) => el.dataset.date > date);
        list.insertBefore(rowEl, after || null);
        exForm.reset();
        exTimes.classList.add('is-closed');
        state.dirty = false;
        toast(SAVED_MESSAGE);
      } catch (err) {
        $('.form-error', exForm).textContent = err.message;
      }
    });
  });

  fill(main,
    pageHead({ title: 'Hours', lead: 'Weekly opening hours. The websites and the TV screens show them, and the "Open now" badge follows them.' }),
    form,
    h('h2', { class: 'section-title' }, 'Special days'),
    h('p', { class: 'muted', style: 'margin-bottom:12px' }, 'Holidays and one-off changes. A special day replaces the weekly hours for that date only.'),
    list,
    h('div', { style: 'margin-top:14px' }, exForm),
  );
}

/* -------------------------------------------------------------------------
   Contact & links
   ------------------------------------------------------------------------- */
async function screenContact(main, { slug }) {
  const { business: b } = await api(`/admin/businesses/${encodeURIComponent(slug)}`);
  const f = (opts) => field({ ...opts, value: b[opts.name] ?? '' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save changes');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'card' },
      h('h2', { class: 'card__title' }, 'Name and address'),
      h('div', { class: 'form' },
        h('div', { class: 'form__row form__row--2' }, f({ label: 'Business name', name: 'name', required: true }), f({ label: 'Short name', name: 'short_name', hint: 'Used where space is tight, e.g. on the TV screens.' })),
        f({ label: 'Tagline', name: 'tagline', hint: 'One line under the name.' }),
        f({ label: 'Description', name: 'description', type: 'textarea', rows: 3 }),
        h('div', { class: 'form__row form__row--2' }, f({ label: 'Street address', name: 'address1' }), f({ label: 'Suite, floor, etc.', name: 'address2' })),
        h('div', { class: 'form__row form__row--3' }, f({ label: 'City', name: 'city', required: true }), f({ label: 'State', name: 'state', required: true }), f({ label: 'ZIP', name: 'zip', inputmode: 'numeric' })),
      )),
    h('div', { class: 'card' },
      h('h2', { class: 'card__title' }, 'How to reach you'),
      h('div', { class: 'form' },
        h('div', { class: 'form__row form__row--2' },
          f({ label: 'Phone', name: 'phone', type: 'tel', inputmode: 'tel', hint: 'Shown exactly as you type it, e.g. 773.966.5801.' }),
          f({ label: 'Public email', name: 'public_email', type: 'email', inputmode: 'email', hint: 'Shown on the website.' })),
        f({ label: 'Inquiry emails', name: 'inquiry_emails', hint: 'Website forms are sent to these addresses. Separate several with commas.', placeholder: 'you@example.com, manager@example.com' }),
        f({ label: 'Hours note', name: 'hours_note', hint: 'Shown next to the hours, e.g. "and by appointment".' }),
      )),
    h('div', { class: 'card' },
      h('h2', { class: 'card__title' }, 'Links'),
      h('div', { class: 'form' },
        h('div', { class: 'form__row form__row--2' }, f({ label: 'Website', name: 'website_url', type: 'url', inputmode: 'url' }), f({ label: 'Instagram', name: 'instagram_url', type: 'url', inputmode: 'url' })),
        h('div', { class: 'form__row form__row--2' }, f({ label: 'Facebook', name: 'facebook_url', type: 'url', inputmode: 'url' }), f({ label: 'Map link', name: 'map_url', type: 'url', inputmode: 'url', hint: 'A Google Maps link to the door.' })),
        h('div', { class: 'form__row form__row--2' }, f({ label: 'Online ordering link', name: 'order_url', type: 'url', inputmode: 'url' }), f({ label: 'Booking or RSVP link', name: 'book_url', type: 'url', inputmode: 'url' })),
      )),
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions actions--sticky' }, saveBtn));
  trackDirty(form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    const errors = {};
    if (!data.name) errors.name = 'Enter the business name.';
    if (!data.city) errors.city = 'Enter the city.';
    if (!data.state) errors.state = 'Enter the state.';
    if (data.public_email && !isEmail(data.public_email)) errors.public_email = 'That does not look like an email address.';
    if (data.inquiry_emails) {
      const parts = data.inquiry_emails.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.every(isEmail)) errors.inquiry_emails = 'Check the addresses: each one needs an @, separated by commas.';
      else data.inquiry_emails = parts.join(', ');
    }
    ['website_url', 'instagram_url', 'facebook_url', 'map_url', 'order_url', 'book_url'].forEach((k) => {
      if (!isUrl(data[k])) errors[k] = LINK_RULE;
    });
    if (showErrors(form, errors)) return;
    withBusy(saveBtn, async () => {
      try {
        const res = await api(`/admin/businesses/${encodeURIComponent(slug)}`, { method: 'PATCH', body: data });
        state.dirty = false;
        const biz = currentBusiness();
        if (biz && res.business) {
          biz.name = res.business.name;
          $$('#business-select option').forEach((o) => { if (o.value === slug) o.textContent = res.business.name; });
        }
        flashSaved(saveBtn);
        toast(SAVED_MESSAGE);
      } catch (err) {
        $('.form-error', form).textContent = err.message;
      }
    });
  });

  fill(main, pageHead({ title: 'Contact & links', lead: 'Name, address, phone and the links on the website.' }), form);
}

/* -------------------------------------------------------------------------
   Notice: a short banner at the top of the site
   ------------------------------------------------------------------------- */
async function screenNotice(main, { slug }) {
  const { business: b } = await api(`/admin/businesses/${encodeURIComponent(slug)}`);
  const text = field({ label: 'Notice', name: 'notice', type: 'textarea', rows: 2, value: b.notice || '', maxlength: 200, hint: 'Keep it short: one sentence, up to 200 characters.', placeholder: 'e.g. Closed Thursday, November 26 for Thanksgiving.' });
  const until = field({ label: 'Show until (optional)', name: 'notice_until', type: 'date', value: b.notice_until || '', min: chicagoToday(), hint: 'The notice hides itself after this day. Leave empty to show it until you clear it.' });
  const preview = h('div', { class: 'notice-preview', 'aria-live': 'polite' });
  const renderPreview = () => {
    const value = text.control.value.trim();
    preview.classList.toggle('is-empty', !value);
    fill(preview, value ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null, h('span', {}, value || 'No notice is showing.'));
  };
  text.control.addEventListener('input', renderPreview);
  renderPreview();

  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save notice');
  const clearBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Clear notice');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'card' }, h('h2', { class: 'card__title' }, 'Preview'), preview, h('p', { class: 'small muted', style: 'margin-top:8px' }, 'This is how it looks in the bar at the top of the website and on the TV screens.')),
    text, until,
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions actions--sticky' }, saveBtn, clearBtn));
  trackDirty(form);

  const save = (body, button) => withBusy(button, async () => {
    try {
      await api(`/admin/businesses/${encodeURIComponent(slug)}`, { method: 'PATCH', body });
      state.dirty = false;
      flashSaved(button, body.notice ? 'Saved' : 'Cleared');
      toast(SAVED_MESSAGE);
    } catch (err) {
      $('.form-error', form).textContent = err.message;
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    if (!data.notice) { showErrors(form, { notice: 'Type the notice, or use "Clear notice" to remove it.' }); return; }
    if (data.notice_until && data.notice_until < chicagoToday()) { showErrors(form, { notice_until: 'Pick today or a later date.' }); return; }
    save({ notice: data.notice, notice_until: data.notice_until }, saveBtn);
  });
  clearBtn.addEventListener('click', async () => {
    text.control.value = '';
    until.control.value = '';
    renderPreview();
    await save({ notice: null, notice_until: null }, clearBtn);
  });

  fill(main, pageHead({ title: 'Notice', lead: 'A short message at the top of the website, for closures, weather or special news.' }), form);
}

/* -------------------------------------------------------------------------
   Events: list with tabs, add / edit form
   ------------------------------------------------------------------------- */
const eventStatus = (ev) => {
  if (!ev.published) return 'draft';
  if (ev.status) return ev.status;
  const today = chicagoToday();
  const last = ev.end_date || ev.start_date;
  if (last < today) return 'past';
  if (ev.start_date > today) return 'upcoming';
  return 'current';
};
const STATUS_LABELS = { current: 'Happening now', upcoming: 'Upcoming', past: 'Past', draft: 'Draft' };

async function screenEvents(main, { slug, sub }) {
  if (sub) return renderEventForm(main, slug, sub);
  const { events = [] } = await api(`/admin/businesses/${encodeURIComponent(slug)}/events?status=all`);
  const groups = { current: [], upcoming: [], past: [], draft: [] };
  events.forEach((ev) => groups[eventStatus(ev)].push(ev));
  groups.past.sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  ['current', 'upcoming', 'draft'].forEach((k) => groups[k].sort((a, b) => (a.start_date < b.start_date ? -1 : 1)));

  const panel = h('div', { role: 'tabpanel' });
  const card = (ev) => {
    const status = eventStatus(ev);
    const when = ev.time_text || timeText(ev.start_time, ev.end_time);
    return h('article', { class: 'card event-card' },
      h('div', { class: 'event-card__top' },
        h('span', { class: `chip chip--${status}` }, STATUS_LABELS[status]),
        h('span', { class: 'chip' }, KIND_LABELS[ev.kind] || ev.kind),
        ev.featured ? star() : null),
      h('h3', { class: 'event-card__title' }, ev.title),
      ev.subtitle ? h('p', { class: 'muted' }, ev.subtitle) : null,
      h('p', { class: 'event-card__meta' }, ev.date_text || dateText(ev.start_date, ev.end_date), when ? ` · ${when}` : '', ev.location ? ` · ${ev.location}` : ''),
      h('div', { class: 'actions', style: 'margin-top:8px' }, h('a', { class: 'btn btn--secondary btn--sm', href: hashFor('events', ev.id) }, 'Edit')));
  };
  const show = (key) => {
    const items = groups[key];
    panel.setAttribute('aria-labelledby', `tab-${key}`);
    fill(panel, items.length ? items.map(card) : emptyState(
      key === 'draft' ? 'No drafts' : `No ${STATUS_LABELS[key].toLowerCase()} events`,
      key === 'past' ? 'Events move here on their own the day after they end.' : 'Add an event and it shows on the website as soon as you save it.',
      key !== 'past' ? h('a', { class: 'btn btn--primary', href: hashFor('events', 'new') }, 'Add an event') : null));
  };
  const first = groups.current.length ? 'current' : 'upcoming';
  const tabs = tabStrip([
    { id: 'current', label: 'Now', count: groups.current.length },
    { id: 'upcoming', label: 'Upcoming', count: groups.upcoming.length },
    { id: 'past', label: 'Past', count: groups.past.length },
    { id: 'draft', label: 'Drafts', count: groups.draft.length },
  ], first, show);
  show(first);
  fill(main,
    pageHead({ title: 'Events', lead: 'Exhibitions, classes and happenings. Past events move to "Past" automatically; you never need to remove them.', actions: [h('a', { class: 'btn btn--primary', href: hashFor('events', 'new') }, 'Add event')] }),
    tabs, panel);
}

async function renderEventForm(main, slug, sub) {
  const isNew = sub === 'new';
  let ev = { kind: 'event', published: 1, featured: 0 };
  if (!isNew) {
    const { events = [] } = await api(`/admin/businesses/${encodeURIComponent(slug)}/events?status=all`);
    ev = events.find((x) => String(x.id) === String(sub));
    if (!ev) {
      fill(main, pageHead({ title: 'Event not found' }), errorBanner({ message: 'That event no longer exists. It may have been deleted by someone else.' }), h('a', { class: 'btn btn--secondary', href: hashFor('events') }, 'Back to events'));
      return;
    }
  }
  const f = (opts) => field({ ...opts, value: ev[opts.name] ?? '' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? 'Add event' : 'Save changes');
  const deleteBtn = isNew ? null : h('button', { type: 'button', class: 'btn btn--danger' }, 'Delete');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'card' }, h('div', { class: 'form' },
      f({ label: 'Type', name: 'kind', type: 'select', options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) }),
      f({ label: 'Title', name: 'title', required: true, maxlength: 140 }),
      f({ label: 'Subtitle', name: 'subtitle', hint: 'e.g. the artists or the host.', maxlength: 140 }),
      f({ label: 'Description', name: 'description', type: 'textarea', rows: 4 }),
    )),
    h('div', { class: 'card' }, h('h2', { class: 'card__title' }, 'When and where'), h('div', { class: 'form' },
      h('div', { class: 'form__row form__row--2' }, f({ label: 'Start date', name: 'start_date', type: 'date', required: true }), f({ label: 'End date', name: 'end_date', type: 'date', hint: 'Leave empty for a single day.' })),
      h('div', { class: 'form__row form__row--2' }, f({ label: 'Start time', name: 'start_time', type: 'time', step: 300 }), f({ label: 'End time', name: 'end_time', type: 'time', step: 300 })),
      f({ label: 'Location', name: 'location', placeholder: 'e.g. Blanc Gallery' }),
    )),
    h('div', { class: 'card' }, h('h2', { class: 'card__title' }, 'Link and photo'), h('div', { class: 'form' },
      h('div', { class: 'form__row form__row--2' }, f({ label: 'Link', name: 'link_url', type: 'url', inputmode: 'url', placeholder: 'https://…' }), f({ label: 'Link text', name: 'link_label', placeholder: 'e.g. RSVP on Eventbrite' })),
      imageField({ value: ev.image_url || '' }),
    )),
    h('div', { class: 'card' },
      checkbox({ label: 'Featured', name: 'featured', checked: Boolean(ev.featured), hint: 'Shown first and marked with a star.' }),
      checkbox({ label: 'Published', name: 'published', checked: Boolean(ev.published), hint: 'Off = a draft only staff can see.' })),
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions actions--sticky' }, saveBtn, h('a', { class: 'btn btn--secondary', href: hashFor('events') }, 'Cancel'), deleteBtn ? h('span', { class: 'actions__spacer' }) : null, deleteBtn));
  trackDirty(form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    const errors = {};
    if (!data.title) errors.title = 'Give the event a title.';
    if (!data.start_date) errors.start_date = 'Pick the start date.';
    if (data.end_date && data.start_date && data.end_date < data.start_date) errors.end_date = 'The end date cannot be before the start date.';
    if (!isUrl(data.link_url)) errors.link_url = LINK_RULE;
    if (!isUrl(data.image_url)) errors.image_url = PHOTO_RULE;
    if (showErrors(form, errors)) return;
    withBusy(saveBtn, async () => {
      try {
        if (isNew) await api(`/admin/businesses/${encodeURIComponent(slug)}/events`, { method: 'POST', body: data });
        else await api(`/admin/events/${ev.id}`, { method: 'PATCH', body: data });
        state.dirty = false;
        toast(SAVED_MESSAGE);
        go('events');
      } catch (err) {
        $('.form-error', form).textContent = err.message;
      }
    });
  });
  deleteBtn?.addEventListener('click', async () => {
    // Its artworks stay in the catalog, out of any show, until History → Restore brings the event back with them.
    let pieces = 0;
    if (hasFeature('artworks')) {
      try {
        pieces = ((await api(`/admin/businesses/${encodeURIComponent(slug)}/artworks?event_id=${ev.id}`)).artworks || []).length;
      } catch { /* the question still works without the count */ }
    }
    const stay = pieces === 1 ? ' Its artwork stays, listed as "Not in a show".' : pieces > 1 ? ` Its ${pieces} artworks stay, listed as "Not in a show".` : '';
    const ok = await confirmDialog({
      title: `Delete "${ev.title}"?`,
      text: `It disappears from the website right away.${stay} You can bring it back from History${pieces ? `, ${pieces === 1 ? 'artwork' : 'artworks'} included` : ''}.`,
    });
    if (!ok) return;
    withBusy(deleteBtn, async () => {
      try {
        await api(`/admin/events/${ev.id}`, { method: 'DELETE' });
        state.dirty = false;
        toast('Event deleted.');
        go('events');
      } catch (err) { $('.form-error', form).textContent = err.message; }
    });
  });

  fill(main,
    h('p', { style: 'margin-bottom:10px' }, h('a', { class: 'btn btn--quiet btn--sm', href: hashFor('events') }, icon('back'), 'All events')),
    pageHead({ title: isNew ? 'Add an event' : ev.title }),
    form);
}

/* -------------------------------------------------------------------------
   Artworks (Blanc's catalog): card grid with quick actions, add / edit form with photos.
   Built for gallery staff on a phone: big targets, photos straight from the camera roll.
   ------------------------------------------------------------------------- */
const ART_STATUS = { available: 'Available', reserved: 'Reserved', sold: 'Sold', not_for_sale: 'Not for sale' };
const PRICE_DISPLAY = { show: 'Show price', on_request: 'Price on request', hidden: "Don't show" };
const ARTWORK_SAVED = 'Saved. The website updates within a minute.';
const MAX_PHOTOS = 12;
// The list's filters, kept while staff open a piece and come back (reset when the business changes).
const artFilters = { slug: null, event: 'all', status: 'all', q: '' };

/** What the website shows for the price (the public bundle's price_text rules, in words for staff). */
function artPriceText(a) {
  if (a.status === 'sold' || a.status === 'not_for_sale') return 'No price shown';
  if (a.price_display === 'on_request') return 'Price on request';
  if (a.price_display === 'show' && a.price != null) return fmtUsd(a.price);
  return 'No price shown';
}
const artStatusChip = (status) => h('span', { class: `chip art-status art-status--${status}` }, h('span', { class: 'art-status__dot', 'aria-hidden': 'true' }), ART_STATUS[status] || status);
const byArtOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id;
/** The business's events for the exhibition pickers, newest first; on the same day the exhibition before its reception. */
const showsNewestFirst = (events) => [...events].sort((a, b) => {
  if (a.start_date !== b.start_date) return a.start_date < b.start_date ? 1 : -1;
  return (b.kind === 'exhibition') - (a.kind === 'exhibition') || b.id - a.id;
});
/** The website leaves out a published piece while its exhibition is still a draft (docs/admin-api.md, "Public"). */
const hiddenByDraftShow = (a, showsById) => Boolean(a.published) && a.event_id != null && showsById.get(String(a.event_id))?.published === false;
const draftShowChip = () => h('span', { class: 'chip chip--draft chip--long' }, 'Hidden: its exhibition is a draft');
/** A photo link the Worker accepts: https, or one of this site's own uploads. */
const isPhotoLink = (s) => /^(https:\/\/\S+|\/api\/media\/\S+)$/i.test(s || '');
/** Extra words for screen readers, e.g. which artwork a "Mark sold" button is about. */
const srOnly = (text) => h('span', { class: 'visually-hidden' }, text);
/** Keep what we know (photos, exhibition title) when a write answers with fewer fields. */
const mergeArtwork = (a, fresh) => Object.assign(a, fresh || {}, { images: fresh?.images || a.images, event_title: fresh?.event_title ?? a.event_title });

/** Focus data-focus="<key>" inside root; for a disabled Up (now first) use Down, and the other way round. */
function focusKey(root, key, fallback) {
  let el = key ? $(`[data-focus="${key}"]`, root) : null;
  if (el?.disabled) el = $(`[data-focus="${key.startsWith('up:') ? key.replace('up:', 'down:') : key.replace('down:', 'up:')}"]`, root);
  (el && !el.disabled ? el : fallback)?.focus();
}

async function screenArtworks(main, { slug, sub }) {
  if (sub) return renderArtworkForm(main, slug, sub);
  const base = `/admin/businesses/${encodeURIComponent(slug)}`;
  const [{ artworks = [] }, { events = [] }] = await Promise.all([api(`${base}/artworks`), api(`${base}/events?status=all`)]);
  let list = artworks.map((a) => ({ ...a, images: [...(a.images || [])].sort(byArtOrder) })).sort(byArtOrder);
  const shows = showsNewestFirst(events);
  const showTitles = new Map(shows.map((ev) => [String(ev.id), ev.title]));
  const showsById = new Map(shows.map((ev) => [String(ev.id), { published: Boolean(ev.published) }]));
  if (artFilters.slug !== slug) Object.assign(artFilters, { slug, event: 'all', status: 'all', q: '' });
  if (!['all', 'none'].includes(artFilters.event) && !showTitles.has(artFilters.event)) artFilters.event = 'all';

  // --- Filters: exhibition, status, search (all on this page, so Up/Down can save the whole order) ---
  const inShow = (id) => list.filter((a) => (id === 'none' ? a.event_id == null : String(a.event_id) === String(id))).length;
  const search = field({ label: 'Search', name: 'q', type: 'search', value: artFilters.q, placeholder: 'Title or artist', autocomplete: 'off' });
  search.classList.add('art-filters__search');
  const showSelect = field({
    label: 'Exhibition', name: 'event', type: 'select', value: artFilters.event,
    options: [{ value: 'all', label: 'All exhibitions' }, ...shows.map((ev) => ({ value: String(ev.id), label: `${ev.title} (${inShow(ev.id)})` })), { value: 'none', label: `Not in a show (${inShow('none')})` }],
  });
  const statusSelect = field({ label: 'Status', name: 'status', type: 'select', value: artFilters.status, options: [{ value: 'all', label: 'Any status' }, ...Object.entries(ART_STATUS).map(([value, label]) => ({ value, label }))] });
  const filters = h('div', { class: 'art-filters', role: 'search', 'aria-label': 'Find artworks' }, search, showSelect, statusSelect);
  search.control.addEventListener('input', () => { artFilters.q = search.control.value; render(); });
  showSelect.control.addEventListener('change', () => { artFilters.event = showSelect.control.value; render(); });
  statusSelect.control.addEventListener('change', () => { artFilters.status = statusSelect.control.value; render(); });
  const clearFilters = () => {
    Object.assign(artFilters, { event: 'all', status: 'all', q: '' });
    search.control.value = '';
    showSelect.control.value = 'all';
    statusSelect.control.value = 'all';
    render();
    search.control.focus();
  };

  const summary = h('p', { 'aria-live': 'polite' });
  const clearBtn = h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: clearFilters }, 'Clear filters');
  const summaryRow = h('div', { class: 'art-summary', tabindex: '-1' }, summary, clearBtn);
  const grid = h('ul', { class: 'art-grid', role: 'list' });

  const filtering = () => artFilters.event !== 'all' || artFilters.status !== 'all' || artFilters.q.trim() !== '';
  function matches(a) {
    const f = artFilters;
    if (f.event === 'none' ? a.event_id != null : f.event !== 'all' && String(a.event_id) !== f.event) return false;
    if (f.status !== 'all' && a.status !== f.status) return false;
    const q = f.q.trim().toLowerCase();
    return !q || a.title.toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q);
  }

  function render({ focus } = {}) {
    const shown = list.filter(matches);
    const available = list.filter((a) => a.status === 'available').length;
    filters.hidden = !list.length;
    summaryRow.hidden = !list.length;
    summary.textContent = `${plural(list.length, 'artwork')} · ${available} available${filtering() ? ` · showing ${shown.length}` : ''}`;
    clearBtn.hidden = !filtering();
    if (!list.length) {
      fill(grid, h('li', {}, emptyState('No artworks yet', 'Add a piece with its photos, price and status. It shows on the website as soon as you save it.',
        h('a', { class: 'btn btn--primary', href: hashFor('artworks', 'new') }, 'Add an artwork'))));
    } else if (!shown.length) {
      fill(grid, h('li', {}, emptyState('No artworks match', 'Try another exhibition or status, or clear the search.',
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: clearFilters }, 'Clear filters'))));
    } else {
      fill(grid, shown.map((a, i) => h('li', {}, artCard(a, i, shown))));
    }
    if (focus) focusKey(grid, focus, summaryRow); // a piece a filter now hides: land on the summary
  }

  function artCard(a, index, shown) {
    const href = hashFor('artworks', a.id);
    const photo = a.images[0];
    const titleId = `art-${a.id}-title`;
    const offSale = a.status === 'sold' || a.status === 'not_for_sale';
    const toggleBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--compact', dataset: { focus: `toggle:${a.id}` } }, offSale ? 'Mark available' : 'Mark sold', srOnly(`: ${a.title}`));
    const up = h('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-label': `Move ${a.title} up`, disabled: index === 0, dataset: { focus: `up:${a.id}` } }, icon('up'));
    const down = h('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-label': `Move ${a.title} down`, disabled: index === shown.length - 1, dataset: { focus: `down:${a.id}` } }, icon('down'));
    toggleBtn.addEventListener('click', () => setStatus(a, offSale ? 'available' : 'sold', toggleBtn));
    up.addEventListener('click', () => move(a, shown, -1, up));
    down.addEventListener('click', () => move(a, shown, 1, down));
    const where = a.event_id == null ? 'Not in a show' : (a.event_title || showTitles.get(String(a.event_id)) || 'In an exhibition');
    return h('article', { class: `art-card${a.published ? '' : ' is-draft'}`, 'aria-labelledby': titleId, dataset: { artwork: String(a.id) } },
      // The picture repeats the title link for fingers; screen readers and keyboards use the title.
      h('a', { class: 'art-card__thumb', href, tabindex: '-1', 'aria-hidden': 'true' },
        photo ? h('img', { src: photo.thumb_url || photo.url, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'art-card__nophoto' }, icon('frame'), 'No photo yet')),
      h('div', { class: 'art-card__body' },
        h('h3', { class: 'art-card__title', id: titleId }, h('a', { href }, a.title), a.featured ? star() : null),
        a.artist ? h('p', { class: 'art-card__artist' }, a.artist) : null,
        h('div', { class: 'chips' }, artStatusChip(a.status), a.published ? null : h('span', { class: 'chip chip--draft' }, 'Draft'), hiddenByDraftShow(a, showsById) ? draftShowChip() : null),
        h('p', { class: 'art-card__price' }, artPriceText(a)),
        h('p', { class: 'art-card__meta' }, where)),
      h('div', { class: 'art-card__tools' },
        toggleBtn,
        h('a', { class: 'btn btn--secondary btn--compact', href }, 'Edit', srOnly(`: ${a.title}`)),
        h('div', { class: 'art-card__move' }, up, down)));
  }

  /** Mark sold / available straight from the card, with Undo in the toast (the button itself also flips back). */
  function setStatus(a, next, button, { offerUndo = true } = {}) {
    const previous = a.status;
    return withBusy(button, async () => {
      try {
        const res = await api(`/admin/artworks/${a.id}`, { method: 'PATCH', body: { status: next } });
        mergeArtwork(a, res.artwork || { status: next });
        render({ focus: `toggle:${a.id}` });
        const undo = offerUndo ? { label: 'Undo', onClick: () => setStatus(a, previous, null, { offerUndo: false }) } : null;
        toast(`"${a.title}" is now ${(ART_STATUS[a.status] || a.status).toLowerCase()}.`, { action: undo });
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  /** Swap with the neighbour on screen (a filter may hide pieces in between), then save the whole order. */
  function move(a, shown, delta, button) {
    const neighbour = shown[shown.indexOf(a) + delta];
    if (!neighbour) return undefined;
    return withBusy(button, async () => {
      const before = list.slice();
      const i = list.indexOf(a);
      const j = list.indexOf(neighbour);
      [list[i], list[j]] = [list[j], list[i]];
      try {
        await api(`${base}/artworks/reorder`, { method: 'POST', body: { ids: list.map((x) => x.id) } });
        list.forEach((x, k) => { x.sort_order = k; });
        render({ focus: `${delta < 0 ? 'up' : 'down'}:${a.id}` });
      } catch (err) {
        list = before;
        toast(err.message, { kind: 'error' });
        button.focus();
      }
    });
  }

  fill(main,
    pageHead({
      title: 'Artworks',
      lead: 'Every piece on the website, with photos, price and status. Mark a piece sold the moment it sells; the website never shows what a sold piece cost.',
      actions: [h('a', { class: 'btn btn--primary', href: hashFor('artworks', 'new') }, 'Add artwork')],
    }),
    filters, summaryRow, grid);
  render();
}

async function renderArtworkForm(main, slug, sub) {
  const base = `/admin/businesses/${encodeURIComponent(slug)}`;
  const backHref = hashFor('artworks');
  let isNew = sub === 'new';
  const [found, { events = [] }] = await Promise.all([
    isNew ? null : api(`/admin/artworks/${encodeURIComponent(sub)}`).then((r) => r.artwork || null, (err) => { if (err.status === 404) return null; throw err; }),
    api(`${base}/events?status=all`),
  ]);
  if (!isNew && (!found || (found.business_slug && found.business_slug !== slug))) {
    fill(main, pageHead({ title: 'Artwork not found' }), errorBanner({ message: 'That artwork no longer exists. It may have been deleted by someone else.' }), h('a', { class: 'btn btn--secondary', href: backHref }, 'Back to artworks'));
    return;
  }
  // A new piece starts in the exhibition the list was showing, if any.
  const listShow = artFilters.slug === slug && !['all', 'none'].includes(artFilters.event) ? artFilters.event : null;
  let art = isNew ? { title: '', status: 'available', price_display: 'on_request', featured: 0, published: 1, event_id: listShow } : found;
  const photos = [...(art.images || [])].sort(byArtOrder);
  const shows = showsNewestFirst(events);
  const showsById = new Map(shows.map((ev) => [String(ev.id), { published: Boolean(ev.published) }]));
  const media = Boolean(state.status?.media_configured);

  // --- The artwork's own fields ---
  const f = (opts) => field({ ...opts, value: art[opts.name] ?? '' });
  const price = f({ label: 'Price (US dollars)', name: 'price', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'e.g. 1800' });
  const priceShow = h('fieldset', { class: 'field fieldset' },
    h('legend', { class: 'field__label' }, 'Price on the website'),
    h('div', { class: 'price-mode' }, Object.entries(PRICE_DISPLAY).map(([value, label]) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'price_display', value, checked: (art.price_display || 'on_request') === value }), h('span', {}, label)))),
    h('p', { class: 'field__hint' }, 'Sold and not-for-sale pieces never show a price, whatever is chosen here.'));
  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? 'Add artwork' : 'Save changes');
  const deleteBtn = h('button', { type: 'button', class: 'btn btn--danger btn--compact', hidden: isNew }, 'Delete');

  // --- Photos: added, moved and removed straight away; descriptions save with the form ---
  const photoList = h('ol', { class: 'photos', 'aria-label': 'Photos, main photo first' });
  const progress = h('ul', { class: 'upload-progress', role: 'list', 'aria-live': 'polite', 'aria-label': 'Upload progress', tabindex: '-1' });
  const photoMsg = h('p', { class: 'field__error', role: 'alert' });
  const photoCount = h('p', { class: 'photos-count' });
  const photoIntro = h('p', { class: 'field__hint' });
  let busyPhotos = false;
  // These controls change photos, not the form, so they must not trip the unsaved-changes guard.
  const quiet = (el) => { ['input', 'change'].forEach((type) => el.addEventListener(type, (e) => e.stopPropagation())); return el; };

  const fileInput = quiet(h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'file-pick__input', id: `photos-${++uid}` }));
  // A new artwork is saved when photos are picked, so check the form before the picker opens: otherwise the
  // photos someone has just chosen would be thrown away by a missing title. (Keyboard and label clicks both land here.)
  fileInput.addEventListener('click', (e) => {
    if (art.id) return;
    clearErrors(form);
    const { errors } = collect();
    if (errors.title) errors.title = 'Give the artwork a title first, then add photos.';
    if (showErrors(form, errors)) e.preventDefault();
  });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) addPhotos(files);
  });
  const picker = h('div', { class: 'file-pick' }, fileInput, h('label', { class: 'btn btn--primary file-pick__btn', for: fileInput.id }, icon('camera'), 'Add photos'));

  const linkField = field({ label: 'Photo link', name: 'photo_link', type: 'url', inputmode: 'url', placeholder: 'https://…', hint: 'Photo uploads are not set up on the server yet, so add photos by their link: an address that starts with https://.' });
  quiet(linkField.control);
  const linkBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Add photo');
  linkField.control.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); linkBtn.click(); } });
  linkBtn.addEventListener('click', addLink);
  const addControl = media ? fileInput : linkField.control;

  function syncPhotoControls() {
    const full = photos.length >= MAX_PHOTOS;
    photoCount.textContent = photos.length ? `${photos.length} of ${MAX_PHOTOS}` : '';
    fileInput.disabled = full || busyPhotos;
    linkField.control.disabled = full;
    linkBtn.disabled = full;
    photoIntro.textContent = full
      ? `This artwork has the most photos it can have (${MAX_PHOTOS}). Remove one to add another.`
      : !art.id
        ? 'Adding photos saves the artwork first, so the photos have a place to go. The first photo is the main one.'
        : 'The first photo is the main one: the website shows it first. Describe each photo for people who use screen readers; descriptions save with the Save button.';
  }

  function renderPhotos(focus) {
    fill(photoList, photos.map(photoRow));
    photoList.hidden = !photos.length;
    syncPhotoControls();
    if (focus) focusKey(photoList, focus, addControl);
  }

  /** A photo that has just arrived gets its own row; the rows above stay put, so a description being typed keeps its focus. */
  function appendPhoto(p) {
    photos.push(p);
    const i = photos.length - 1;
    const aboveDown = i > 0 ? $(`[data-focus="down:${photos[i - 1].id}"]`, photoList) : null;
    if (aboveDown) aboveDown.disabled = false;
    photoList.append(photoRow(p, i));
    photoList.hidden = false;
    syncPhotoControls();
  }

  function photoRow(p, i) {
    const n = i + 1;
    const altId = `photo-alt-${p.id}`;
    const alt = h('input', { class: 'input', id: altId, type: 'text', value: p.altDraft ?? p.alt ?? '', maxlength: 300, placeholder: 'e.g. Oil painting of two sisters on a porch' });
    alt.addEventListener('input', () => { p.altDraft = alt.value; });
    const swapped = (j) => { const next = photos.slice(); [next[i], next[j]] = [next[j], next[i]]; return next; };
    const makeMain = i === 0
      ? h('span', { class: 'photo-row__main' }, h('span', { class: 'chip chip--current' }, 'Main photo'))
      : h('button', { type: 'button', class: 'btn btn--secondary btn--compact', dataset: { focus: `main:${p.id}` } }, 'Make main', srOnly(` (photo ${n})`));
    const up = h('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-label': `Move photo ${n} up`, disabled: i === 0, dataset: { focus: `up:${p.id}` } }, icon('up'));
    const down = h('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-label': `Move photo ${n} down`, disabled: i === photos.length - 1, dataset: { focus: `down:${p.id}` } }, icon('down'));
    const remove = h('button', { type: 'button', class: 'btn btn--danger btn--compact' }, 'Remove', srOnly(` photo ${n}`));
    if (i > 0) makeMain.addEventListener('click', () => reorderPhotos([p, ...photos.filter((x) => x !== p)], makeMain, `down:${p.id}`, 'Main photo changed.'));
    up.addEventListener('click', () => reorderPhotos(swapped(i - 1), up, `up:${p.id}`));
    down.addEventListener('click', () => reorderPhotos(swapped(i + 1), down, `down:${p.id}`));
    remove.addEventListener('click', () => removePhoto(p, n, remove));
    return h('li', { class: 'photo-row', dataset: { imageId: String(p.id) } },
      h('img', { class: 'photo-row__img', src: p.thumb_url || p.url, alt: '', width: 120, height: 120 }),
      h('div', { class: 'field photo-row__alt' }, h('label', { class: 'field__label', for: altId }, `Photo ${n}: what it shows`), alt),
      h('div', { class: 'photo-row__tools' }, makeMain, up, down, remove));
  }

  function reorderPhotos(next, button, focus, message) {
    return withBusy(button, async () => {
      try {
        await api(`/admin/artworks/${art.id}/images/reorder`, { method: 'POST', body: { ids: next.map((p) => p.id) } });
        // A photo that finished uploading meanwhile stays (last, as on the server); one removed meanwhile stays gone.
        const order = [...next.filter((p) => photos.includes(p)), ...photos.filter((p) => !next.includes(p))];
        photos.splice(0, photos.length, ...order);
        renderPhotos(focus);
        if (message) toast(message);
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  async function removePhoto(p, n, button) {
    const ok = await confirmDialog({ title: `Remove photo ${n}?`, text: 'It disappears from the website right away. You can bring it back from History.', confirmLabel: 'Remove' });
    if (!ok) return;
    await withBusy(button, async () => {
      try {
        await api(`/admin/artwork-images/${p.id}`, { method: 'DELETE' });
        photos.splice(photos.indexOf(p), 1);
        renderPhotos();
        addControl.focus();
        toast('Photo removed.');
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  /** Photos belong to a saved artwork, so a new one is saved first with what the form says so far. */
  async function ensureSaved() {
    if (art.id) return true;
    if (!(await save({ auto: true }))) return false;
    toast('Artwork saved. Now adding the photos.');
    return true;
  }

  async function addPhotos(files) {
    if (busyPhotos) return;
    photoMsg.textContent = '';
    if (!(await ensureSaved())) {
      photoMsg.textContent = `${files.length === 1 ? 'The photo was' : `The ${files.length} photos were`} not added. Fix the form, then choose ${files.length === 1 ? 'it' : 'them'} again.`;
      return;
    }
    const room = Math.max(0, MAX_PHOTOS - photos.length);
    const take = files.slice(0, room);
    const left = files.length - take.length;
    if (left) photoMsg.textContent = `An artwork can have up to ${MAX_PHOTOS} photos, so ${plural(left, 'photo')} ${left === 1 ? 'was' : 'were'} left out.`;
    if (!take.length) return;
    busyPhotos = true;
    syncPhotoControls();
    const rows = take.map((file, k) => {
      const step = h('span', { class: 'upload-progress__step' }, STEP_TEXT.waiting);
      // "Photo 2 of 4": an iPhone names every picked photo image.jpg, so the name alone cannot say which one failed.
      const label = `Photo ${k + 1} of ${take.length}${file.name ? ` · ${file.name}` : ''}`;
      return { file, step, row: h('li', { class: 'upload-progress__row' }, h('span', { class: 'upload-progress__name' }, label), step) };
    });
    fill(progress, rows.map((r) => r.row));
    let added = 0;
    const failed = [];
    for (const { file, step, row } of rows) { // one at a time: a phone has little memory to spare
      try {
        const up = await uploadPhoto(file, { slug, onStep: (s) => { step.textContent = STEP_TEXT[s]; } });
        const res = await api(`/admin/artworks/${art.id}/images`, {
          method: 'POST', body: { url: up.url, thumb_url: up.thumb_url, width: up.width, height: up.height, alt: null }, timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        appendPhoto(res.image || { id: res.id, ...up, alt: null });
        row.classList.add('is-done');
        step.textContent = STEP_TEXT.done;
        added++;
      } catch (err) {
        row.classList.add('is-error');
        step.textContent = err.message;
        if (!(err instanceof PhotoError)) failed.push(file); // a format this browser cannot read fails again on a retry
      }
    }
    busyPhotos = false;
    syncPhotoControls();
    if (failed.length) {
      // The picked files are kept, so nobody has to find them in the camera roll again.
      const again = h('button', { type: 'button', class: 'btn btn--secondary' }, failed.length === 1 ? 'Try that photo again' : `Try the ${failed.length} photos again`);
      again.addEventListener('click', () => { progress.focus(); addPhotos(failed); });
      progress.append(h('li', { class: 'upload-progress__retry' }, again));
    }
    if (added) toast(`${plural(added, 'photo')} added.`);
  }

  async function addLink() {
    const url = linkField.control.value.trim();
    setError(linkField.control, '');
    if (!isPhotoLink(url)) {
      setError(linkField.control, 'Paste a link to a photo that starts with https://');
      linkField.control.focus();
      return;
    }
    if (!(await ensureSaved())) return;
    await withBusy(linkBtn, async () => {
      try {
        const res = await api(`/admin/artworks/${art.id}/images`, { method: 'POST', body: { url, thumb_url: null, alt: null } });
        appendPhoto(res.image || { id: res.id, url, thumb_url: null, alt: null });
        linkField.control.value = '';
        toast('Photo added.');
      } catch (err) { setError(linkField.control, err.message); }
    });
  }

  // --- Exhibition picker; a draft show keeps its pieces off the website until it is published ---
  const showField = field({
    label: 'Exhibition', name: 'event_id', type: 'select', value: art.event_id ?? '',
    options: [{ value: '', label: 'Not in a show' }, ...shows.map((ev) => ({ value: String(ev.id), label: `${ev.title} (${ev.date_text || dateText(ev.start_date, ev.end_date)})${ev.published ? '' : ' · draft'}` }))],
    hint: 'The show it hangs in. Pieces not in a show are listed as part of the collection.',
  });
  const showNote = h('p', { class: 'art-show-note', 'aria-live': 'polite' });
  const syncShowNote = () => {
    const published = $('input[name="published"]', form)?.checked ?? Boolean(art.published);
    const hidden = hiddenByDraftShow({ published, event_id: showField.control.value || null }, showsById);
    fill(showNote, hidden ? [draftShowChip(), ' The website shows this piece once its exhibition is published (Events).'] : []);
    showNote.hidden = !hidden;
  };
  showField.control.addEventListener('change', syncShowNote);

  // --- The form ---
  const head = pageHead({ title: isNew ? 'Add an artwork' : art.title });
  const photosTitleId = `photos-title-${++uid}`;
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'card' }, h('div', { class: 'form' },
      f({ label: 'Title', name: 'title', required: true, maxlength: 200 }),
      f({ label: 'Artist', name: 'artist', maxlength: 200, autocomplete: 'off' }),
      h('div', { class: 'form__row form__row--3' },
        f({ label: 'Year', name: 'year', maxlength: 40, placeholder: 'e.g. 2024 or c. 1968' }),
        f({ label: 'Medium', name: 'medium', maxlength: 200, placeholder: 'e.g. Oil on canvas' }),
        f({ label: 'Dimensions', name: 'dimensions', maxlength: 120, placeholder: 'e.g. 36 × 48 in.' })),
      f({ label: 'Description', name: 'description', type: 'textarea', rows: 4 }),
    )),
    h('section', { class: 'card', 'aria-labelledby': photosTitleId },
      h('div', { class: 'photos-head' }, h('h2', { class: 'card__title', id: photosTitleId }, 'Photos'), photoCount),
      h('div', { class: 'photos-body' },
        photoIntro, photoList,
        media ? h('div', {}, picker) : h('div', { class: 'form' }, linkField, h('div', {}, linkBtn)),
        progress, photoMsg)),
    h('div', { class: 'card' }, h('h2', { class: 'card__title' }, 'Show, price and status'), h('div', { class: 'form' },
      h('div', { class: 'form__row form__row--2' },
        showField,
        f({ label: 'Status', name: 'status', type: 'select', options: Object.entries(ART_STATUS).map(([value, label]) => ({ value, label })) })),
      showNote,
      price, priceShow,
    )),
    h('div', { class: 'card' },
      checkbox({ label: 'Featured', name: 'featured', checked: Boolean(art.featured), hint: 'Shown first on the website and marked with a star here.' }),
      checkbox({ label: 'Published', name: 'published', checked: Boolean(art.published), hint: 'Off = a draft only staff can see.' })),
    h('p', { class: 'form-error', role: 'alert' }),
    // Compact Cancel and Delete keep the bar on one line on a phone.
    h('div', { class: 'actions actions--sticky' }, saveBtn, h('a', { class: 'btn btn--secondary btn--compact', href: backHref }, 'Cancel'), h('span', { class: 'actions__spacer' }), deleteBtn));
  trackDirty(form);
  $('input[name="published"]', form).addEventListener('change', syncShowNote);
  syncShowNote();

  function collect() {
    const data = readForm(form);
    const body = {
      title: data.title, artist: data.artist, year: data.year, medium: data.medium, dimensions: data.dimensions, description: data.description,
      event_id: data.event_id == null ? null : Number(data.event_id),
      price: data.price, price_display: data.price_display || 'on_request',
      status: data.status, featured: data.featured, published: data.published,
    };
    const errors = {};
    if (!body.title) errors.title = 'Give the artwork a title.';
    if (price.control.validity.badInput) errors.price = 'Type the price as a number, e.g. 1800 or 950.50.';
    else if (body.price != null && body.price < 0) errors.price = 'The price cannot be below zero.';
    else if (body.price_display === 'show' && body.price == null) errors.price = 'Enter the price, or choose "Price on request".';
    return { body, errors };
  }

  /** Save the form (and any changed photo descriptions). auto: called by "Add photos" on a new artwork. */
  async function save({ auto = false } = {}) {
    clearErrors(form);
    const { body, errors } = collect();
    if (auto && errors.title) errors.title = 'Give the artwork a title first, then add photos.';
    if (showErrors(form, errors)) return false;
    const ok = await withBusy(saveBtn, async () => {
      try {
        if (art.id) {
          const res = await api(`/admin/artworks/${art.id}`, { method: 'PATCH', body });
          art = { ...art, ...(res.artwork || body) };
        } else {
          const res = await api(`${base}/artworks`, { method: 'POST', body });
          art = { ...art, ...(res.artwork || { ...body, id: res.id }) };
          becameSaved();
        }
        for (const p of photos) {
          const next = p.altDraft == null ? null : p.altDraft.trim();
          if (next == null || next === (p.alt || '')) continue;
          const res = await api(`/admin/artwork-images/${p.id}`, { method: 'PATCH', body: { alt: next || null } });
          p.alt = res.image ? res.image.alt : next || null;
          p.altDraft = null;
        }
        state.dirty = false;
        return true;
      } catch (err) {
        $('.form-error', form).textContent = err.message;
        return false;
      }
    });
    return ok === true;
  }

  /** A new artwork got its id: point the address at it (without re-rendering) and offer Delete. */
  function becameSaved() {
    isNew = false;
    const hash = hashFor('artworks', art.id);
    history.replaceState(null, '', hash); // fires no hashchange
    state.sub = String(art.id);
    state.hash = hash;
    saveBtn.textContent = 'Save changes';
    $('h1', head).textContent = art.title;
    deleteBtn.hidden = false;
    syncPhotoControls();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busyPhotos) { $('.form-error', form).textContent = 'Please wait until the photos finish uploading, then save.'; return; }
    if (await save()) {
      toast(ARTWORK_SAVED);
      go('artworks');
    }
  });
  deleteBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Delete "${art.title}"?`, text: 'It disappears from the website right away, with its photos. You can bring it back from History.' });
    if (!ok) return;
    withBusy(deleteBtn, async () => {
      try {
        await api(`/admin/artworks/${art.id}`, { method: 'DELETE' });
        state.dirty = false;
        toast('Artwork deleted.');
        go('artworks');
      } catch (err) { $('.form-error', form).textContent = err.message; }
    });
  });

  fill(main,
    h('p', { style: 'margin-bottom:10px' }, h('a', { class: 'btn btn--quiet btn--sm', href: backHref }, icon('back'), 'All artworks')),
    head, form);
  renderPhotos();
}

/* -------------------------------------------------------------------------
   Menu: sections and items, edited in place
   ------------------------------------------------------------------------- */
async function screenMenu(main, { slug }) {
  const base = `/admin/businesses/${encodeURIComponent(slug)}/menu`;
  let sections = [];
  const openSections = new Set(); // which panels are expanded, kept across re-renders
  const wrap = h('div');

  async function load() {
    const res = await api(base);
    sections = (res.sections || []).map((s) => ({ ...s, items: s.items || [] }));
  }

  /** Save the current order of sections, or of the items in one section. */
  async function saveOrder(sectionId) {
    const body = sectionId == null
      ? { sections: sections.map((s) => s.id) }
      : { items: { [sectionId]: sections.find((s) => s.id === sectionId).items.map((i) => i.id) } };
    await api(`${base}/reorder`, { method: 'POST', body });
  }

  function move(list, index, delta) {
    const to = index + delta;
    if (to < 0 || to >= list.length) return false;
    [list[index], list[to]] = [list[to], list[index]];
    return true;
  }

  const priceText = (item) => {
    if (Array.isArray(item.prices) && item.prices.length) return item.prices.map((p) => `${p.label} ${fmtPrice(p.value)}`).join(' · ');
    return fmtPrice(item.price);
  };

  /* --- Item: read-only view --- */
  function itemView(section, item, index, focusAfter) {
    const el = h('div', { class: `menu-item${item.available ? '' : ' is-unavailable'}`, dataset: { item: String(item.id) } });
    const up = h('button', { type: 'button', class: 'btn btn--secondary btn--sm btn--icon', 'aria-label': `Move ${item.name} up`, disabled: index === 0 }, icon('up'));
    const down = h('button', { type: 'button', class: 'btn btn--secondary btn--sm btn--icon', 'aria-label': `Move ${item.name} down`, disabled: index === section.items.length - 1 }, icon('down'));
    const edit = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Edit');
    const del = h('button', { type: 'button', class: 'btn btn--danger btn--sm' }, 'Delete');
    append(el, [
      h('div', { class: 'menu-item__head' },
        h('span', { class: 'menu-item__name' }, item.name, item.featured ? star() : null),
        item.portion ? h('span', { class: 'muted small' }, item.portion) : null,
        h('span', { class: 'menu-item__price' }, priceText(item))),
      item.description ? h('p', { class: 'menu-item__desc' }, item.description) : null,
      (item.tags?.length || item.allergens?.length || !item.available) ? h('div', { class: 'chips' },
        (item.tags || []).map((t) => h('span', { class: 'chip chip--tag', title: DIETARY[t] || t }, t)),
        (item.allergens || []).map((a) => h('span', { class: 'chip chip--tag chip--off' }, `Contains ${a}`)),
        !item.available ? h('span', { class: 'chip chip--off' }, 'Hidden from menu') : null) : null,
      h('div', { class: 'menu-item__tools' }, edit, up, down, del)]);
    const reorder = async (delta, btn) => {
      const i = section.items.indexOf(item);
      if (!move(section.items, i, delta)) return;
      try {
        await saveOrder(section.id);
        renderSectionItems(section, { focus: `${delta < 0 ? 'up' : 'down'}:${item.id}` });
      } catch (err) { move(section.items, i + delta, -delta); toast(err.message, { kind: 'error' }); btn.focus(); }
    };
    up.addEventListener('click', () => reorder(-1, up));
    down.addEventListener('click', () => reorder(1, down));
    edit.addEventListener('click', () => el.replaceWith(itemForm(section, item)));
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Delete "${item.name}"?`, text: 'Tip: turning off "Available" hides an item without deleting it.' });
      if (!ok) return;
      withBusy(del, async () => {
        try {
          await api(`/admin/menu/items/${item.id}`, { method: 'DELETE' });
          section.items = section.items.filter((x) => x !== item);
          renderSectionItems(section);
          toast('Item deleted.');
        } catch (err) { toast(err.message, { kind: 'error' }); }
      });
    });
    if (focusAfter === `up:${item.id}`) queueMicrotask(() => (up.disabled ? down : up).focus());
    if (focusAfter === `down:${item.id}`) queueMicrotask(() => (down.disabled ? up : down).focus());
    return el;
  }

  /* --- Item: inline edit form (also used for "Add item") --- */
  function itemForm(section, item) {
    const isNew = !item;
    item = item || { name: '', portion: '', price: null, prices: null, description: '', tags: [], allergens: [], featured: 0, available: 1 };
    const hasSizes = Array.isArray(item.prices) && item.prices.length > 0;
    const name = field({ label: 'Name', name: 'name', value: item.name, required: true, maxlength: 120 });
    const portion = field({ label: 'Portion', name: 'portion', value: item.portion || '', placeholder: 'e.g. half pan, serves 10' });
    const price = field({ label: 'Price', name: 'price', type: 'number', value: item.price ?? '', step: '0.01', min: '0', inputmode: 'decimal' });
    const modeName = `pricemode-${++uid}`;
    const modeSingle = h('input', { type: 'radio', name: modeName, value: 'single', checked: !hasSizes });
    const modeSizes = h('input', { type: 'radio', name: modeName, value: 'sizes', checked: hasSizes });
    const sizes = h('div', { class: 'sizes' });
    const sizeRow = (p = { label: '', value: '' }) => {
      const row = h('div', { class: 'sizes__row' },
        h('input', { class: 'input', type: 'text', value: p.label, placeholder: 'Size, e.g. Small', 'aria-label': 'Size name', dataset: { sizeLabel: '' } }),
        h('input', { class: 'input', type: 'number', value: p.value, step: '0.01', min: '0', inputmode: 'decimal', placeholder: '$', 'aria-label': 'Price for this size', dataset: { sizeValue: '' } }),
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm btn--icon', 'aria-label': 'Remove this size', onclick: () => { row.remove(); state.dirty = true; } }, icon('close')));
      return row;
    };
    (hasSizes ? item.prices : [{ label: '', value: '' }, { label: '', value: '' }]).forEach((p) => sizes.append(sizeRow(p)));
    const addSize = h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => { sizes.append(sizeRow()); $('input', sizes.lastChild).focus(); } }, 'Add a size');
    const sizesWrap = h('div', { class: 'field', hidden: !hasSizes }, h('span', { class: 'field__label' }, 'Sizes and prices'), sizes, h('div', {}, addSize), h('p', { class: 'field__error' }));
    const syncMode = () => { price.hidden = modeSizes.checked; sizesWrap.hidden = !modeSizes.checked; };
    modeSingle.addEventListener('change', syncMode);
    modeSizes.addEventListener('change', syncMode);
    syncMode();
    const description = field({ label: 'Description', name: 'description', type: 'textarea', rows: 2, value: item.description || '' });
    const tags = h('div', { class: 'check-grid' }, Object.entries(DIETARY).map(([code, label]) => checkbox({ label: `${label} (${code})`, name: `tag-${code}`, checked: (item.tags || []).includes(code) })));
    const allergens = field({ label: 'Allergens', name: 'allergens', value: (item.allergens || []).join(', '), placeholder: 'e.g. Dairy, Shellfish', hint: 'Separate with commas.' });
    const allergenChips = h('div', { class: 'chips', 'aria-live': 'polite' });
    const parseAllergens = () => allergens.control.value.split(',').map((s) => s.trim()).filter(Boolean);
    const renderChips = () => fill(allergenChips, parseAllergens().map((a) => h('span', { class: 'chip chip--tag chip--off' }, a)));
    allergens.control.addEventListener('input', renderChips);
    renderChips();
    const featured = checkbox({ label: 'Featured (star)', name: 'featured', checked: Boolean(item.featured) });
    const available = toggle({ label: 'Available', name: 'available', checked: Boolean(item.available) });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, isNew ? 'Add item' : 'Save');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Cancel');
    const form = h('form', { class: 'form menu-item__form', novalidate: true, 'aria-label': isNew ? 'New item' : `Edit ${item.name}` },
      h('div', { class: 'form__row form__row--2' }, name, portion),
      h('fieldset', { class: 'field', style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'field__label' }, 'Pricing'),
        h('div', { class: 'price-mode' }, h('label', { class: 'check' }, modeSingle, h('span', {}, 'One price')), h('label', { class: 'check' }, modeSizes, h('span', {}, 'Several sizes')))),
      price, sizesWrap, description,
      h('fieldset', { class: 'field', style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'field__label' }, 'Dietary tags'), tags),
      allergens, allergenChips,
      h('div', { class: 'form__row form__row--2' }, featured, available),
      h('p', { class: 'form-error', role: 'alert' }),
      h('div', { class: 'actions', style: 'margin-top:4px' }, saveBtn, cancelBtn));
    trackDirty(form);
    cancelBtn.addEventListener('click', () => { state.dirty = false; renderSectionItems(section); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearErrors(form);
      const errors = {};
      const body = {
        name: name.control.value.trim(),
        portion: portion.control.value.trim() || null,
        description: description.control.value.trim() || null,
        tags: Object.keys(DIETARY).filter((code) => form.elements[`tag-${code}`].checked),
        allergens: parseAllergens(),
        featured: $('input', featured).checked ? 1 : 0,
        available: $('input', available).checked ? 1 : 0,
      };
      if (!body.name) errors.name = 'Give the item a name.';
      if (modeSizes.checked) {
        const rows = $$('.sizes__row', sizes).map((row) => ({ label: $('[data-size-label]', row).value.trim(), value: $('[data-size-value]', row).value }))
          .filter((p) => p.label || p.value !== '');
        const bad = rows.find((p) => !p.label || p.value === '' || Number(p.value) < 0);
        $('.field__error', sizesWrap).textContent = !rows.length ? 'Add at least one size with a price.' : bad ? 'Every size needs a name and a price.' : '';
        if (!rows.length || bad) { if (!errors.name) $('input', sizes)?.focus(); errors._sizes = 'x'; }
        body.price = null;
        body.prices = rows.map((p) => ({ label: p.label, value: Number(p.value) }));
      } else {
        const value = price.control.value;
        if (value === '' || Number(value) < 0) errors.price = 'Enter a price (0 is allowed).';
        body.price = value === '' ? null : Number(value);
        body.prices = null;
      }
      const { _sizes, ...fieldErrors } = errors;
      if (showErrors(form, fieldErrors) || _sizes) { if (_sizes) $('.form-error', form).textContent = 'Please fix the highlighted fields.'; return; }
      withBusy(saveBtn, async () => {
        try {
          if (isNew) {
            const res = await api(`/admin/menu/sections/${section.id}/items`, { method: 'POST', body });
            section.items.push(res.item || { ...body, id: res.id });
          } else {
            const res = await api(`/admin/menu/items/${item.id}`, { method: 'PATCH', body });
            Object.assign(item, res.item || body);
          }
          state.dirty = false;
          flashSaved(saveBtn);
          toast(SAVED_MESSAGE);
          setTimeout(() => renderSectionItems(section), 600);
        } catch (err) { $('.form-error', form).textContent = err.message; }
      });
    });
    queueMicrotask(() => name.control.focus());
    return form;
  }

  function renderSectionItems(section, { focus } = {}) {
    const body = $(`[data-section-items="${section.id}"]`, wrap);
    if (!body) return;
    const addBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Add item');
    addBtn.addEventListener('click', () => addBtn.replaceWith(itemForm(section, null)));
    fill(body,
      section.items.length ? section.items.map((item, i) => itemView(section, item, i, focus)) : h('p', { class: 'muted small', style: 'padding:12px 0' }, 'No items in this section yet.'),
      h('div', { class: 'actions', style: 'margin-top:10px' }, addBtn));
  }

  /* --- Section: panel with header tools and an inline edit form --- */
  function sectionForm(section, onDone) {
    const isNew = !section;
    section = section || { title: '', short_title: '', description: '', published: 1 };
    const title = field({ label: 'Section title', name: 'title', value: section.title, required: true, maxlength: 80 });
    const short = field({ label: 'Short title', name: 'short_title', value: section.short_title || '', hint: 'For the menu tabs on the website, e.g. "Plates".', maxlength: 30 });
    const desc = field({ label: 'Note', name: 'description', type: 'textarea', rows: 2, value: section.description || '', hint: 'Optional line under the section title.' });
    const published = checkbox({ label: 'Published', name: 'published', checked: Boolean(section.published), hint: 'Off = the whole section is hidden from the website.' });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, isNew ? 'Add section' : 'Save section');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => { state.dirty = false; onDone(null); } }, 'Cancel');
    const form = h('form', { class: 'form menu-section__edit', novalidate: true, 'aria-label': isNew ? 'New section' : `Edit ${section.title}` },
      h('div', { class: 'form__row form__row--2' }, title, short), desc, published,
      h('p', { class: 'form-error', role: 'alert' }), h('div', { class: 'actions', style: 'margin-top:4px' }, saveBtn, cancelBtn));
    trackDirty(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearErrors(form);
      const body = readForm(form);
      if (showErrors(form, { title: body.title ? '' : 'Give the section a title.' })) return;
      withBusy(saveBtn, async () => {
        try {
          let saved;
          if (isNew) {
            const res = await api(`${base}/sections`, { method: 'POST', body });
            saved = { ...(res.section || { ...body, id: res.id }), items: [] };
            sections.push(saved);
          } else {
            const res = await api(`/admin/menu/sections/${section.id}`, { method: 'PATCH', body });
            Object.assign(section, res.section || body);
            saved = section;
          }
          state.dirty = false;
          toast(SAVED_MESSAGE);
          onDone(saved);
        } catch (err) { $('.form-error', form).textContent = err.message; }
      });
    });
    queueMicrotask(() => title.control.focus());
    return form;
  }

  function sectionPanel(section, index, focusAfter) {
    const up = h('button', { type: 'button', class: 'btn btn--secondary btn--sm btn--icon', 'aria-label': `Move ${section.title} up`, disabled: index === 0 }, icon('up'));
    const down = h('button', { type: 'button', class: 'btn btn--secondary btn--sm btn--icon', 'aria-label': `Move ${section.title} down`, disabled: index === sections.length - 1 }, icon('down'));
    const edit = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Edit');
    const del = h('button', { type: 'button', class: 'btn btn--danger btn--sm btn--icon', 'aria-label': `Delete ${section.title}` }, icon('close'));
    const editSlot = h('div');
    const bodyId = `menu-body-${section.id}`;
    const isOpen = openSections.has(section.id) || (openSections.size === 0 && (index === 0 || sections.length <= 3));
    const body = h('div', { class: 'menu-section__body', id: bodyId, hidden: !isOpen }, editSlot, h('div', { dataset: { sectionItems: String(section.id) } }));
    const toggleBtn = h('button', { type: 'button', class: 'menu-section__toggle', 'aria-expanded': String(isOpen), 'aria-controls': bodyId },
      h('span', { class: 'menu-section__title' }, section.title), !section.published ? h('span', { class: 'chip chip--draft' }, 'Hidden') : null,
      h('span', { class: 'menu-section__count' }, `${section.items.length} item${section.items.length === 1 ? '' : 's'}`));
    toggleBtn.addEventListener('click', () => {
      const open = toggleBtn.getAttribute('aria-expanded') !== 'true';
      toggleBtn.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (open) openSections.add(section.id); else openSections.delete(section.id);
    });
    const panel = h('section', { class: 'menu-section', 'aria-label': section.title },
      h('div', { class: 'menu-section__head' }, toggleBtn, h('div', { class: 'menu-section__tools' }, edit, up, down, del)),
      body);
    if (isOpen) openSections.add(section.id);
    const reorder = async (delta, btn) => {
      const i = sections.indexOf(section);
      if (!move(sections, i, delta)) return;
      try { await saveOrder(null); renderAll({ focus: `${delta < 0 ? 'up' : 'down'}:${section.id}` }); }
      catch (err) { move(sections, i + delta, -delta); toast(err.message, { kind: 'error' }); btn.focus(); }
    };
    up.addEventListener('click', () => reorder(-1, up));
    down.addEventListener('click', () => reorder(1, down));
    edit.addEventListener('click', () => {
      if (body.hidden) toggleBtn.click();
      fill(editSlot, sectionForm(section, (saved) => { if (saved) renderAll(); else fill(editSlot); }));
    });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Delete "${section.title}" and its ${section.items.length} item${section.items.length === 1 ? '' : 's'}?`, text: 'You can bring it back from History.' });
      if (!ok) return;
      withBusy(del, async () => {
        try {
          await api(`/admin/menu/sections/${section.id}`, { method: 'DELETE' });
          sections = sections.filter((s) => s !== section);
          renderAll();
          toast('Section deleted.');
        } catch (err) { toast(err.message, { kind: 'error' }); }
      });
    });
    if (focusAfter === `up:${section.id}`) queueMicrotask(() => (up.disabled ? down : up).focus());
    if (focusAfter === `down:${section.id}`) queueMicrotask(() => (down.disabled ? up : down).focus());
    return panel;
  }

  function renderAll({ focus } = {}) {
    const addSlot = h('div', { style: 'margin-top:14px' });
    const addBtn = h('button', { type: 'button', class: 'btn btn--primary' }, 'Add section');
    addBtn.addEventListener('click', () => fill(addSlot, h('div', { class: 'card' }, sectionForm(null, (saved) => { if (saved) renderAll(); else fill(addSlot, addBtn); }))));
    addSlot.append(addBtn);
    fill(wrap,
      sections.length ? sections.map((s, i) => sectionPanel(s, i, focus)) : emptyState('No menu yet', 'Add a section (like "Breakfast" or "Plates"), then add items to it.'),
      addSlot);
    sections.forEach((s) => renderSectionItems(s));
  }

  await load();
  fill(main,
    pageHead({ title: 'Menu', lead: 'Each change saves on its own. "Available" off hides an item without deleting it.' }),
    wrap);
  renderAll();
}

/* -------------------------------------------------------------------------
   Announcements (this business, and family-wide for owners/admins)
   ------------------------------------------------------------------------- */
async function screenAnnouncements(main, { slug, sub }) {
  if (sub && sub !== 'family') return renderAnnouncementForm(main, slug, sub);
  const scope = sub === 'family' ? 'family' : 'business';
  const listPath = scope === 'family' ? '/admin/announcements?scope=family' : `/admin/businesses/${encodeURIComponent(slug)}/announcements`;
  const { announcements = [] } = await api(listPath);
  const today = chicagoToday();
  const rows = [...announcements].sort((a, b) => (a.starts_at < b.starts_at ? 1 : -1));

  const row = (a) => {
    const ended = a.ends_at && a.ends_at < today;
    const notYet = a.starts_at && a.starts_at > today;
    return h('div', { class: 'list__row' },
      h('div', { class: 'list__main' },
        h('p', { class: 'list__title' }, a.title),
        h('p', { class: 'list__meta' }, `From ${fmtDate(a.starts_at)}`, a.ends_at ? ` until ${fmtDate(a.ends_at)}` : ' until removed'),
        h('div', { class: 'chips', style: 'margin-top:6px' },
          !a.published ? h('span', { class: 'chip chip--draft' }, 'Draft') : ended ? h('span', { class: 'chip chip--past' }, 'Ended') : notYet ? h('span', { class: 'chip chip--upcoming' }, 'Scheduled') : h('span', { class: 'chip chip--current' }, 'Live'),
          a.show_on_tv ? h('span', { class: 'chip chip--tv' }, 'On TV') : null,
          a.business_slug == null ? h('span', { class: 'chip chip--family' }, 'Whole family') : null)),
      h('div', { class: 'list__actions' }, h('a', { class: 'btn btn--secondary btn--sm', href: hashFor('announcements', scope === 'family' ? `family-${a.id}` : a.id) }, 'Edit')));
  };

  const newHref = hashFor('announcements', scope === 'family' ? 'family-new' : 'new');
  const tabs = isManager() ? tabStrip([
    { id: 'business', label: currentBusiness()?.name || 'This business' },
    { id: 'family', label: 'Whole family' },
  ], scope, (id) => go('announcements', id === 'family' ? 'family' : null)) : null;

  fill(main,
    pageHead({
      title: 'Announcements',
      lead: scope === 'family' ? 'News for every business at once: the hub site and all TV screens show these.' : 'News and promos for the website and the TV screens. They show between the start and end dates.',
      actions: [h('a', { class: 'btn btn--primary', href: newHref }, 'Add announcement')],
    }),
    tabs,
    h('div', { class: 'list' }, rows.length ? rows.map(row) : emptyState('No announcements yet', 'Add one for news, a promo or a new menu.', h('a', { class: 'btn btn--primary', href: newHref }, 'Add announcement'))));
}

async function renderAnnouncementForm(main, slug, sub) {
  const family = sub.startsWith('family-');
  const id = family ? sub.slice('family-'.length) : sub;
  const isNew = id === 'new';
  const backHref = hashFor('announcements', family ? 'family' : null);
  let a = { starts_at: chicagoToday(), show_on_tv: 1, published: 1 };
  if (!isNew) {
    const listPath = family ? '/admin/announcements?scope=family' : `/admin/businesses/${encodeURIComponent(slug)}/announcements`;
    const { announcements = [] } = await api(listPath);
    a = announcements.find((x) => String(x.id) === String(id));
    if (!a) {
      fill(main, pageHead({ title: 'Announcement not found' }), errorBanner({ message: 'That announcement no longer exists.' }), h('a', { class: 'btn btn--secondary', href: backHref }, 'Back'));
      return;
    }
  }
  const f = (opts) => field({ ...opts, value: a[opts.name] ?? '' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? 'Add announcement' : 'Save changes');
  const deleteBtn = isNew ? null : h('button', { type: 'button', class: 'btn btn--danger' }, 'Delete');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'card' }, h('div', { class: 'form' },
      f({ label: 'Title', name: 'title', required: true, maxlength: 140 }),
      f({ label: 'Text', name: 'body', type: 'textarea', rows: 3 }),
      h('div', { class: 'form__row form__row--2' }, f({ label: 'Link', name: 'link_url', type: 'url', inputmode: 'url', placeholder: 'https://…' }), f({ label: 'Link text', name: 'link_label', placeholder: 'e.g. Read the news' })),
      imageField({ value: a.image_url || '' }),
    )),
    h('div', { class: 'card' }, h('h2', { class: 'card__title' }, 'When it shows'), h('div', { class: 'form' },
      h('div', { class: 'form__row form__row--2' }, f({ label: 'Start date', name: 'starts_at', type: 'date', required: true }), f({ label: 'End date', name: 'ends_at', type: 'date', hint: 'Leave empty to keep it up until you unpublish it.' })),
      checkbox({ label: 'Show on the TV screens', name: 'show_on_tv', checked: Boolean(a.show_on_tv) }),
      checkbox({ label: 'Published', name: 'published', checked: Boolean(a.published), hint: 'Off = a draft only staff can see.' }),
    )),
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions actions--sticky' }, saveBtn, h('a', { class: 'btn btn--secondary', href: backHref }, 'Cancel'), deleteBtn ? h('span', { class: 'actions__spacer' }) : null, deleteBtn));
  trackDirty(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    const errors = {};
    if (!data.title) errors.title = 'Give it a title.';
    if (!data.starts_at) errors.starts_at = 'Pick a start date.';
    if (data.ends_at && data.starts_at && data.ends_at < data.starts_at) errors.ends_at = 'The end date cannot be before the start date.';
    if (!isUrl(data.link_url)) errors.link_url = LINK_RULE;
    if (!isUrl(data.image_url)) errors.image_url = PHOTO_RULE;
    if (showErrors(form, errors)) return;
    withBusy(saveBtn, async () => {
      try {
        if (isNew) await api(family ? '/admin/announcements' : `/admin/businesses/${encodeURIComponent(slug)}/announcements`, { method: 'POST', body: data });
        else await api(`/admin/announcements/${a.id}`, { method: 'PATCH', body: data });
        state.dirty = false;
        toast(SAVED_MESSAGE);
        go('announcements', family ? 'family' : null);
      } catch (err) { $('.form-error', form).textContent = err.message; }
    });
  });
  deleteBtn?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Delete "${a.title}"?`, text: 'It disappears from the website and the screens right away. You can bring it back from History.' });
    if (!ok) return;
    withBusy(deleteBtn, async () => {
      try {
        await api(`/admin/announcements/${a.id}`, { method: 'DELETE' });
        state.dirty = false;
        toast('Announcement deleted.');
        go('announcements', family ? 'family' : null);
      } catch (err) { $('.form-error', form).textContent = err.message; }
    });
  });
  fill(main,
    h('p', { style: 'margin-bottom:10px' }, h('a', { class: 'btn btn--quiet btn--sm', href: backHref }, icon('back'), 'All announcements')),
    pageHead({ title: isNew ? (family ? 'Add a family-wide announcement' : 'Add an announcement') : a.title }),
    form);
}

/* -------------------------------------------------------------------------
   Inquiries: website form submissions
   ------------------------------------------------------------------------- */
const FORM_TYPE_LABELS = { contact: 'Contact', quote: 'Quote request', event: 'Event inquiry', wholesale: 'Wholesale', apply: 'Job application', catering: 'Catering', artwork: 'Artwork inquiry' };
const formTypeLabel = (t) => FORM_TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Form');

/** Plain words for the email_error codes the Worker stores (see worker/lib/email.js). */
function emailErrorText(code) {
  if (code === 'not_configured') return 'Not emailed: email sending is not set up on the server yet. The inquiry is saved here.';
  if (code === 'no_recipients') return 'Not emailed: this business has no inquiry email address yet. Add one under Contact & links.';
  return `Email failed (${code}). Try "Resend email" or check the Resend settings.`;
}

async function screenInquiries(main, { slug, sub }) {
  if (sub && !['new', 'handled', 'spam', 'all'].includes(sub)) return renderInquiry(main, slug, sub);
  const filter = sub || 'new';
  const base = `/admin/businesses/${encodeURIComponent(slug)}/inquiries`;
  const list = h('div', { class: 'list' });
  const moreWrap = h('div', { class: 'actions' });
  let lastId = null;

  const row = (q) => {
    const who = q.name || q.email || q.phone || 'Someone';
    const open = h('button', { type: 'button', class: 'list__open', onclick: () => go('inquiries', q.id) },
      h('p', { class: 'list__title' }, who, q.status === 'new' ? h('span', { class: 'chip chip--new', style: 'margin-left:8px' }, 'New') : null, q.status === 'spam' ? h('span', { class: 'chip chip--off', style: 'margin-left:8px' }, 'Spam') : null),
      h('p', { class: 'list__meta' }, `${formTypeLabel(q.form_type)} · ${fmtDateTime(q.created_at)}`),
      // An artwork inquiry names the piece. Only the Worker writes artwork_status, and only together with the piece's
      // real title and artist (anything a visitor sends under those names is dropped), so it marks catalog facts.
      q.form_type === 'artwork' && q.fields?.artwork_status && q.fields.artwork_title
        ? h('p', { class: 'list__meta' }, `About “${q.fields.artwork_title}”${q.fields.artwork_artist ? ` by ${q.fields.artwork_artist}` : ''}`) : null,
      q.message ? h('p', { class: 'list__meta' }, q.message.length > 120 ? `${q.message.slice(0, 120)}…` : q.message) : null);
    return h('div', { class: `list__row${q.status === 'new' ? ' is-unread' : ''}` }, open);
  };

  async function loadPage() {
    const qs = new URLSearchParams({ status: filter, limit: '50' });
    if (lastId) qs.set('before', String(lastId));
    const { inquiries = [] } = await api(`${base}?${qs}`);
    if (!inquiries.length && !lastId) {
      fill(list, emptyState(filter === 'new' ? 'No new inquiries' : 'Nothing here', filter === 'new' ? 'New website form submissions show up here. You will also get them by email once email is set up.' : null));
    } else {
      inquiries.forEach((q) => list.append(row(q)));
    }
    lastId = inquiries.length ? inquiries[inquiries.length - 1].id : lastId;
    fill(moreWrap);
    if (inquiries.length === 50) {
      const moreBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Show older');
      moreBtn.addEventListener('click', () => withBusy(moreBtn, loadPage));
      moreWrap.append(moreBtn);
    }
  }

  fill(main,
    pageHead({ title: 'Inquiries', lead: 'Everything sent through the website forms.' }),
    state.status && state.status.email_configured === false ? infoBanner('Form emails are not set up yet; inquiries still arrive here.') : null,
    tabStrip([{ id: 'new', label: 'New' }, { id: 'all', label: 'All' }, { id: 'handled', label: 'Handled' }, { id: 'spam', label: 'Spam' }], filter, (id) => go('inquiries', id === 'new' ? null : id)),
    list, moreWrap);
  await loadPage();
}

async function renderInquiry(main, slug, id) {
  let q = null;
  try {
    q = (await api(`/admin/inquiries/${encodeURIComponent(id)}`)).inquiry || null;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  // A Worker without the single-inquiry route answers 404; then look through the list (newest 50 first).
  const base = `/admin/businesses/${encodeURIComponent(slug)}/inquiries`;
  let before = null;
  for (let page = 0; page < 10 && !q; page++) {
    const qs = new URLSearchParams({ status: 'all', limit: '50' });
    if (before) qs.set('before', String(before));
    const { inquiries = [] } = await api(`${base}?${qs}`);
    q = inquiries.find((x) => String(x.id) === String(id)) || null;
    if (inquiries.length < 50) break;
    before = inquiries[inquiries.length - 1].id;
  }
  const backHref = hashFor('inquiries');
  if (!q) {
    fill(main, pageHead({ title: 'Inquiry not found' }), errorBanner({ message: 'That inquiry could not be found. It may be older than the list shows.' }), h('a', { class: 'btn btn--secondary', href: backHref }, 'Back to the inbox'));
    return;
  }
  let extra = q.fields && typeof q.fields === 'object' ? q.fields : {};
  if (!Object.keys(extra).length && typeof q.fields_json === 'string') { try { extra = JSON.parse(q.fields_json) || {}; } catch { extra = {}; } }

  const statusLine = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const emailLine = h('p', { class: 'muted small' });
  const renderStatus = () => {
    fill(statusLine, q.status === 'new' ? h('span', { class: 'chip chip--new' }, 'New') : q.status === 'spam' ? h('span', { class: 'chip chip--off' }, 'Marked as spam') : h('span', { class: 'chip chip--current' }, 'Handled'));
    emailLine.textContent = q.emailed_at ? `Emailed to the team ${fmtDateTime(q.emailed_at)}.` : q.email_error ? emailErrorText(q.email_error) : 'Not emailed yet.';
  };
  renderStatus();

  const dt = (label, value, { wide = false, href = null } = {}) => (value == null || value === '' ? null
    : h('div', { class: wide ? 'is-wide' : '' }, h('dt', {}, label), h('dd', {}, href ? h('a', { href }, String(value)) : String(value))));
  const fields = h('dl', { class: 'inquiry__fields' },
    dt('Name', q.name), dt('Email', q.email, { href: q.email ? `mailto:${q.email}` : null }), dt('Phone', q.phone, { href: q.phone ? `tel:${q.phone}` : null }),
    dt('Form', formTypeLabel(q.form_type)), dt('Message', q.message, { wide: true }),
    Object.entries(extra).map(([k, v]) => dt(k.replace(/[_-]+/g, ' '), typeof v === 'object' ? JSON.stringify(v) : v, {
      wide: String(v).length > 60,
      // The piece an artwork inquiry is about opens in Artworks (where it can be marked sold).
      href: k === 'artwork_id' && q.form_type === 'artwork' && /^\d+$/.test(String(v)) && hasFeature('artworks') ? hashFor('artworks', v) : null,
    })),
    dt('Sent', fmtDateTime(q.created_at)), dt('From page', q.source_url, { href: isUrl(q.source_url) ? q.source_url : null }));

  const setStatus = (status, btn) => withBusy(btn, async () => {
    try {
      const wasNew = q.status === 'new';
      const res = await api(`/admin/inquiries/${q.id}`, { method: 'PATCH', body: { status } });
      Object.assign(q, res.inquiry || { status });
      const biz = currentBusiness();
      if (biz?.counts) {
        biz.counts.new_inquiries = Math.max(0, (biz.counts.new_inquiries || 0) + (q.status === 'new' ? 1 : 0) - (wasNew ? 1 : 0));
        refreshNavCounts();
      }
      renderStatus();
      renderButtons();
      toast(status === 'handled' ? 'Marked as handled.' : status === 'spam' ? 'Marked as spam.' : 'Marked as new.');
    } catch (err) { toast(err.message, { kind: 'error' }); }
  });
  const actions = h('div', { class: 'actions' });
  function renderButtons() {
    const handled = h('button', { type: 'button', class: 'btn btn--primary' }, 'Mark handled');
    const unhandle = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Mark as new');
    const spam = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Spam');
    const resend = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Resend email');
    handled.addEventListener('click', () => setStatus('handled', handled));
    unhandle.addEventListener('click', () => setStatus('new', unhandle));
    spam.addEventListener('click', () => setStatus('spam', spam));
    resend.addEventListener('click', () => withBusy(resend, async () => {
      try {
        const res = await api(`/admin/inquiries/${q.id}/resend`, { method: 'POST' });
        if (res.emailed) { q.emailed_at = new Date().toISOString(); q.email_error = null; toast('Email sent.'); }
        else { q.email_error = res.error || 'not sent'; toast(emailErrorText(q.email_error), { kind: 'error' }); }
        renderStatus();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    }));
    fill(actions, q.status === 'handled' ? unhandle : handled, q.status === 'spam' ? unhandle : spam, resend);
  }
  renderButtons();

  fill(main,
    h('p', { style: 'margin-bottom:10px' }, h('a', { class: 'btn btn--quiet btn--sm', href: backHref }, icon('back'), 'Inbox')),
    pageHead({ title: q.name || q.email || 'Inquiry' }),
    h('div', { class: 'card inquiry' }, statusLine, fields, emailLine, actions));
}

/* -------------------------------------------------------------------------
   History: who changed what, with Restore
   ------------------------------------------------------------------------- */
const ACTION_LABELS = { create: 'Added', update: 'Changed', delete: 'Deleted', restore: 'Restored' };
const ENTITY_LABELS = { business: 'business details', hours: 'hours', hours_exception: 'a special day', event: 'an event', menu_section: 'a menu section', menu_item: 'a menu item', announcement: 'an announcement', inquiry: 'an inquiry', user: 'a user', settings: 'settings', artwork: 'an artwork', artwork_image: 'an artwork photo', media: 'a photo' };

async function screenHistory(main, { slug, sub }) {
  const all = sub === 'all' && isManager();
  const list = h('div', { class: 'list' });
  const moreWrap = h('div', { class: 'actions' });
  let lastId = null;

  const row = (entry) => {
    const restore = entry.can_restore ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Restore') : null;
    const el = h('div', { class: 'list__row history__row' },
      h('div', { class: 'list__main' },
        h('p', { class: 'list__title' }, entry.summary ? entry.summary : [h('span', { class: 'history__action' }, ACTION_LABELS[entry.action] || entry.action), ' ', ENTITY_LABELS[entry.entity] || entry.entity]),
        h('p', { class: 'history__who' }, `${entry.user_email || 'Someone'} · ${fmtDateTime(entry.created_at)}`, all && entry.business_slug ? ` · ${state.businesses.find((b) => b.slug === entry.business_slug)?.name || entry.business_slug}` : '')),
      restore ? h('div', { class: 'list__actions' }, restore) : null);
    restore?.addEventListener('click', async () => {
      const what = { create: 'This removes what was added.', update: 'This puts the earlier version back.', delete: 'This brings the deleted item back.' }[entry.action] || 'This undoes the change.';
      const ok = await confirmDialog({ title: 'Restore this version?', text: `${what} The websites update within a minute.`, confirmLabel: 'Restore', danger: false });
      if (!ok) return;
      withBusy(restore, async () => {
        try {
          await api(`/admin/history/${entry.id}/restore`, { method: 'POST' });
          toast('Restored. Websites update within a minute.');
          lastId = null;
          fill(list);
          await loadPage();
        } catch (err) { toast(err.message, { kind: 'error' }); }
      });
    });
    return el;
  };

  async function loadPage() {
    const qs = new URLSearchParams({ limit: '50' });
    if (lastId) qs.set('before', String(lastId));
    const path = all ? `/admin/history?${qs}` : `/admin/businesses/${encodeURIComponent(slug)}/history?${qs}`;
    const { entries = [] } = await api(path);
    if (!entries.length && !lastId) fill(list, emptyState('No changes yet', 'Every save shows up here with who made it and when.'));
    else entries.forEach((e) => list.append(row(e)));
    lastId = entries.length ? entries[entries.length - 1].id : lastId;
    fill(moreWrap);
    if (entries.length === 50) {
      const moreBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Show older');
      moreBtn.addEventListener('click', () => withBusy(moreBtn, loadPage));
      moreWrap.append(moreBtn);
    }
  }

  fill(main,
    pageHead({ title: 'History', lead: 'Every change, newest first. Restore puts an earlier version back; that is recorded here too.' }),
    isManager() ? tabStrip([{ id: 'one', label: currentBusiness()?.name || 'This business' }, { id: 'all', label: 'All businesses' }], all ? 'all' : 'one', (id) => go('history', id === 'all' ? 'all' : null)) : null,
    list, moreWrap);
  await loadPage();
}

/* -------------------------------------------------------------------------
   Users (owner/admin)
   ------------------------------------------------------------------------- */
async function screenUsers(main, { sub }) {
  const { users = [] } = await api('/admin/users');
  const me = state.user;
  const canEdit = (u) => me.role === 'owner' || u.role !== 'owner';
  const bizName = (s) => state.businesses.find((b) => b.slug === s)?.name || s;
  const formSlot = h('div');

  function userForm(u) {
    const isNew = !u;
    u = u || { email: '', name: '', role: 'editor', businesses: [], active: 1 };
    const roleOptions = (me.role === 'owner' ? ['owner', 'admin', 'editor'] : ['admin', 'editor']).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
    const email = field({ label: 'Email', name: 'email', type: 'email', inputmode: 'email', value: u.email, required: true });
    if (!isNew) email.control.disabled = true;
    const name = field({ label: 'Name', name: 'name', value: u.name || '', required: true });
    const role = field({ label: 'Role', name: 'role', type: 'select', value: u.role, options: roleOptions });
    const businessBoxes = h('div', { class: 'check-grid' }, state.businesses.map((b) => checkbox({ label: b.name, name: `biz-${b.slug}`, checked: (u.businesses || []).includes(b.slug) })));
    const bizField = h('fieldset', { class: 'field', style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'field__label' }, 'Businesses this editor may change'), businessBoxes);
    const syncRole = () => { bizField.hidden = role.control.value !== 'editor'; };
    role.control.addEventListener('change', syncRole);
    syncRole();
    const password = field({ label: isNew ? 'Temporary password' : 'New temporary password (optional)', name: 'password', type: 'password', autocomplete: 'new-password', required: isNew, hint: 'At least 8 characters. They will be asked to choose their own password when they sign in.' });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? 'Add user' : 'Save changes');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => { state.dirty = false; go('users'); } }, 'Cancel');
    const form = h('form', { class: 'form card', novalidate: true },
      h('h2', { class: 'card__title' }, isNew ? 'Add a user' : `Edit ${u.name || u.email}`),
      h('div', { class: 'form__row form__row--2' }, email, name), role, bizField, password,
      h('p', { class: 'form-error', role: 'alert' }), h('div', { class: 'actions' }, saveBtn, cancelBtn));
    trackDirty(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearErrors(form);
      const data = readForm(form);
      const errors = {};
      if (isNew && !isEmail(data.email)) errors.email = 'Enter a valid email address.';
      if (!data.name) errors.name = 'Enter their name.';
      if ((isNew && !data.password) || (data.password && data.password.length < 8)) errors.password = 'Use at least 8 characters.';
      if (showErrors(form, errors)) return;
      const body = { name: data.name, role: data.role, businesses: data.role === 'editor' ? state.businesses.map((b) => b.slug).filter((s) => data[`biz-${s}`]) : [] };
      if (data.password) body.password = data.password;
      if (isNew) body.email = data.email.toLowerCase();
      withBusy(saveBtn, async () => {
        try {
          if (isNew) await api('/admin/users', { method: 'POST', body });
          else await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
          state.dirty = false;
          toast(isNew ? 'User added. Give them their temporary password.' : 'Saved.');
          go('users');
          if (location.hash === hashFor('users')) route();
        } catch (err) { $('.form-error', form).textContent = err.message; }
      });
    });
    queueMicrotask(() => (isNew ? email : name).control.focus());
    return form;
  }

  const row = (u) => {
    const toggleBtn = canEdit(u) && u.id !== me.id ? h('button', { type: 'button', class: `btn btn--sm ${u.active ? 'btn--danger' : 'btn--secondary'}` }, u.active ? 'Deactivate' : 'Reactivate') : null;
    const el = h('div', { class: 'list__row' },
      h('div', { class: 'list__main' },
        h('p', { class: 'list__title' }, u.name || u.email, ' ', h('span', { class: 'chip' }, ROLE_LABELS[u.role] || u.role), !u.active ? h('span', { class: 'chip chip--off', style: 'margin-left:6px' }, 'Inactive') : null, u.id === me.id ? h('span', { class: 'chip chip--family', style: 'margin-left:6px' }, 'You') : null),
        h('p', { class: 'list__meta' }, u.email, u.role === 'editor' ? ` · ${(u.businesses || []).length ? u.businesses.map(bizName).join(', ') : 'no businesses yet'}` : ' · every business'),
        h('p', { class: 'list__meta' }, u.last_login_at ? `Last signed in ${fmtDateTime(u.last_login_at)}` : 'Has not signed in yet')),
      h('div', { class: 'list__actions' }, canEdit(u) ? h('a', { class: 'btn btn--secondary btn--sm', href: hashFor('users', u.id) }, 'Edit') : null, toggleBtn));
    toggleBtn?.addEventListener('click', async () => {
      if (u.active) {
        const ok = await confirmDialog({ title: `Deactivate ${u.name || u.email}?`, text: 'They can no longer sign in. You can reactivate them later.', confirmLabel: 'Deactivate' });
        if (!ok) return;
      }
      withBusy(toggleBtn, async () => {
        try {
          await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { active: u.active ? 0 : 1 } });
          toast(u.active ? 'User deactivated.' : 'User reactivated.');
          route();
        } catch (err) { toast(err.message, { kind: 'error' }); }
      });
    });
    return el;
  };

  if (sub === 'new') formSlot.append(userForm(null));
  else if (sub) {
    const u = users.find((x) => String(x.id) === String(sub));
    formSlot.append(u && canEdit(u) ? userForm(u) : errorBanner({ message: 'That user could not be found, or you cannot edit them.' }));
  }

  fill(main,
    pageHead({ title: 'Users', lead: 'Who can sign in, and what they may change.', actions: [h('a', { class: 'btn btn--primary', href: hashFor('users', 'new') }, 'Add user')] }),
    h('ul', { class: 'role-list' },
      h('li', {}, h('strong', {}, 'Owner'), ': can change everything, including other owners.'),
      h('li', {}, h('strong', {}, 'Admin'), ': can edit every business and manage editors and admins.'),
      h('li', {}, h('strong', {}, 'Editor'), ': can edit only the businesses ticked for them.')),
    formSlot,
    h('div', { class: 'list', style: 'margin-top:14px' }, users.map(row)));
}

/* -------------------------------------------------------------------------
   Account: change password, sign out
   ------------------------------------------------------------------------- */
async function screenAccount(main) {
  const me = state.user;
  const current = field({ label: 'Current password', name: 'current_password', type: 'password', autocomplete: 'current-password', required: true });
  const next = field({ label: 'New password', name: 'new_password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 8 characters. A short sentence works well.' });
  const again = field({ label: 'New password again', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Change password');
  const form = h('form', { class: 'form card', novalidate: true },
    h('h2', { class: 'card__title' }, 'Change password'), current, next, again,
    h('p', { class: 'form-error', role: 'alert' }), h('div', { class: 'actions' }, saveBtn));
  trackDirty(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = readForm(form);
    const errors = {};
    if (!data.current_password) errors.current_password = 'Enter your current password.';
    if (!data.new_password || data.new_password.length < 8) errors.new_password = 'Use at least 8 characters.';
    else if (data.new_password === data.current_password) errors.new_password = 'Choose a different password from the current one.';
    if (data.confirm !== data.new_password) errors.confirm = 'The two new passwords do not match.';
    if (showErrors(form, errors)) return;
    withBusy(saveBtn, async () => {
      try {
        await api('/auth/change-password', { method: 'POST', body: { current_password: data.current_password, new_password: data.new_password } });
        state.dirty = false;
        form.reset();
        const wasForced = me.must_change_password;
        me.must_change_password = 0;
        toast('Password changed.');
        if (wasForced) go('overview');
      } catch (err) {
        $('.form-error', form).textContent = err.code === 'wrong_password' ? 'The current password is not right. Try again.' : err.message;
      }
    });
  });

  const signOutBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Sign out');
  signOutBtn.addEventListener('click', () => withBusy(signOutBtn, async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* the token is dropped either way */ }
    signOut();
  }));

  fill(main,
    pageHead({ title: 'Account' }),
    me.must_change_password ? infoBanner('Please choose a new password before you continue. Your temporary password was set by whoever added you.') : null,
    h('div', { class: 'card' },
      h('p', { class: 'list__title' }, me.name || me.email, ' ', h('span', { class: 'chip' }, ROLE_LABELS[me.role] || me.role)),
      h('p', { class: 'list__meta' }, me.email),
      h('p', { class: 'list__meta' }, me.role === 'editor' ? `Can edit: ${(me.businesses || []).map((s) => state.businesses.find((b) => b.slug === s)?.name || s).join(', ') || 'no businesses yet'}` : 'Can edit every business.'),
      h('div', { class: 'actions' }, signOutBtn)),
    form);
  if (me.must_change_password) current.control.focus();
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
async function init() {
  try {
    state.status = await api('/auth/status');
  } catch (err) {
    const retry = h('button', { type: 'button', class: 'btn btn--primary', onclick: init }, 'Try again');
    authFrame('Cannot reach the server', err.message, h('p', { class: 'muted' }, 'If this keeps happening, tell whoever looks after the website.'), h('div', { class: 'actions' }, retry));
    return;
  }
  if (!state.status.has_users) { renderBootstrap(); return; }
  if (store.get(TOKEN_KEY)) {
    try {
      const { user } = await api('/auth/me');
      await afterLogin(null, user);
      return;
    } catch (err) {
      if (err.status !== 401) {
        authFrame('Cannot reach the server', err.message, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn--primary', onclick: init }, 'Try again')));
        return;
      }
      // signOut() already showed the login screen for an expired token.
      if (!state.user && $('.auth')) return;
    }
  }
  renderLogin();
}

// Any screen-level link (sidebar, cards) is a plain hash link, so nothing else to wire up.
init();
