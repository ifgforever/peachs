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
  /** data: the error body as the server sent it (e.g. the places a photo is used in, for a 409 in_use). */
  constructor(message, status, code, data = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
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
    throw new ApiError(friendlyMessage(res.status, data), res.status, data?.code, data);
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
/** An ISO time -> "just now", "4 min ago", "2 hours ago", "3 days ago", else the date and time. */
function timeAgo(value) {
  const t = Date.parse(value || '');
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor(Math.max(0, Date.now() - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${plural(days, 'day')} ago` : fmtDateTime(value);
}

/* -------------------------------------------------------------------------
   Links to the Worker's own pages (previews, TV players, the Claude app connector)
   ------------------------------------------------------------------------- */
/** The Worker's origin: where /api lives, so also the sites, the TV page and /mcp. */
const workerOrigin = () => new URL(API_BASE, location.href).origin;
/** A link the API sent (absolute, or a same-site path like /peachs.html?preview=…) made absolute. */
const workerUrl = (link) => new URL(link, `${workerOrigin()}/`).href;

/** Copy text to the clipboard. Resolves false when the browser would not (then the caller shows the text to copy). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure pages: a selected textarea and the old copy command.
    const area = h('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' }, text);
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

/** A read-only link with a Copy button (TV player links, the connector address). */
function copyField({ label, value, hint, buttonLabel = 'Copy' }) {
  const id = `copy-${++uid}`;
  const input = h('input', { class: 'input copy-field__input', id, type: 'text', readonly: true, value, spellcheck: 'false' });
  input.addEventListener('focus', () => input.select());
  const btn = h('button', { type: 'button', class: 'btn btn--secondary btn--compact' }, icon('copy'), buttonLabel, srOnly(` the ${label.toLowerCase()}`));
  btn.addEventListener('click', async () => {
    if (await copyText(input.value)) { flashSaved(btn, 'Copied'); toast('Copied.'); } else { input.focus(); toast('Select the text and copy it.', { kind: 'error' }); }
  });
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('div', { class: 'copy-field' }, input, btn),
    hint ? h('p', { class: 'field__hint' }, hint) : null);
}

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

/**
 * Ask for one line of text (an album's name). Resolves the trimmed text, or null when cancelled. check(text) may
 * return a problem to show under the field; the dialog then stays open.
 */
function promptDialog({ title, label, value = '', confirmLabel = 'Save', maxlength = 80, check = () => '' }) {
  const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': `prompt-title-${++uid}` });
  const input = field({ label, name: 'value', value, maxlength, required: true, autocomplete: 'off' });
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => dlg.close('cancel') }, 'Cancel');
  const ok = h('button', { type: 'submit', class: 'btn btn--primary', value: 'ok' }, confirmLabel);
  const form = h('form', { method: 'dialog', novalidate: true },
    h('div', { class: 'dialog__body' }, h('h2', { class: 'dialog__title', id: dlg.getAttribute('aria-labelledby') }, title), input),
    h('div', { class: 'dialog__actions' }, cancel, ok));
  dlg.append(form);
  document.body.append(dlg);
  return new Promise((resolve) => {
    form.addEventListener('submit', (e) => {
      const text = input.control.value.trim();
      const problem = text ? check(text) : 'Type a name.';
      if (problem) { e.preventDefault(); setError(input.control, problem); input.control.focus(); }
    });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? input.control.value.trim() : null); dlg.remove(); }, { once: true });
    dlg.showModal();
    input.control.select();
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
 * (≤ 640 px). onStep('shrinking' | 'uploading') reports progress. Resolves { url, thumb_url, width, height, key,
 * thumb_key, bytes } (the keys and size are what the photo library records).
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
  return {
    url: fullRes.url, thumb_url: thumbRes ? thumbRes.url : null, width: full.width, height: full.height,
    key: fullRes.key || null, thumb_key: thumbRes?.key || null, bytes: full.blob.size,
  };
}

/**
 * When a JPEG says it was taken (EXIF DateTimeOriginal), as "2026-10-13T09:14:22"; null when the file does not say
 * (other formats, or a phone that dropped it). Lets the Assistant find "the photo I took this morning".
 */
async function photoTakenAt(file) {
  try {
    const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return null;
    for (let at = 2; at + 10 < view.byteLength;) {
      const marker = view.getUint16(at);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // not a marker, or the picture data starts
      if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966) {  // APP1 "Exif"
        const tiff = at + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const u16 = (o) => view.getUint16(tiff + o, little);
        const u32 = (o) => view.getUint32(tiff + o, little);
        const entry = (ifd, tag) => { for (let i = 0, n = u16(ifd); i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12; return null; };
        const exif = entry(u32(4), 0x8769);                   // pointer to the Exif sub-directory
        const original = exif == null ? null : entry(u32(exif + 8), 0x9003); // DateTimeOriginal
        if (original == null) return null;
        const start = tiff + u32(original + 8);
        const text = String.fromCharCode(...new Uint8Array(view.buffer, start, 19));
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
        return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
      }
      at += 2 + view.getUint16(at + 2);
    }
  } catch { /* unreadable or cut short: no date */ }
  return null;
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
  const status = h('p', { class: 'field__hint', 'aria-live': 'polite' });
  // A photo staff took earlier (Photos page): its link lands in the field, saved with the form like an upload.
  const libraryBtn = h('button', { type: 'button', class: 'btn btn--secondary file-pick__btn' }, icon('photos'), 'Choose from library');
  libraryBtn.addEventListener('click', async () => {
    const photo = await chooseFromLibrary();
    libraryBtn.focus();
    if (!photo) return;
    urlField.control.value = photo.url;
    setError(urlField.control, '');
    showPreview();
    state.dirty = true;
    status.classList.remove('is-error');
    status.textContent = 'Photo chosen from the library. Save the form to keep it.';
  });
  if (!media) {
    wrap.append(h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Or use a photo from the library'), h('div', { class: 'photo-pick' }, libraryBtn), status));
  } else {
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'file-pick__input', id: `file-${++uid}` });
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
      h('div', { class: 'photo-pick' },
        h('div', { class: 'file-pick' }, fileInput, h('label', { class: 'btn btn--secondary file-pick__btn', for: fileInput.id }, icon('camera'), 'Choose a photo')),
        libraryBtn),
      status));
  }
  return wrap;
}

/* -------------------------------------------------------------------------
   Photo library picker: "Choose from library" next to every photo field
   ------------------------------------------------------------------------- */
/** What a library photo is called on screen: its note, its description, or the day it was added. */
const photoTitle = (p) => p.note || p.alt || `Photo from ${fmtDate(String(p.taken_at || p.created_at || '').slice(0, 10))}`;

/**
 * A sheet with one business's albums and photos (docs/assistant-api.md §5). Resolves the photo picked
 * ({ id, url, thumb_url, alt, width, height, note, … }), or null when it is closed without choosing.
 */
function chooseFromLibrary({ slug = state.slug } = {}) {
  const titleId = `picker-title-${++uid}`;
  const dlg = h('dialog', { class: 'sheet picker', 'aria-labelledby': titleId });
  const base = `/admin/businesses/${encodeURIComponent(slug)}/media`;
  const view = { album: 'all', q: '', photos: [], next: null };
  let chosen = null;
  let loading = 0;
  const chips = h('div', { class: 'album-chips', role: 'group', 'aria-label': 'Albums' });
  const search = field({ label: 'Search the library', name: 'library-q', type: 'search', placeholder: 'A note or an album, e.g. brunch', autocomplete: 'off' });
  const grid = h('ul', { class: 'picker__grid', role: 'list' });
  const status = h('p', { class: 'picker__status', role: 'status' });
  const more = h('button', { type: 'button', class: 'btn btn--secondary', hidden: true }, 'Show more photos');

  function renderChips(albums, total, noAlbum) {
    const chip = (id, label, count) => h('button', {
      type: 'button', class: 'album-chip', 'aria-pressed': String(view.album === id),
      onclick: () => { view.album = id; load(); },
    }, label, h('span', { class: 'album-chip__count' }, String(count)));
    fill(chips, chip('all', 'All photos', total), albums.map((a) => chip(String(a.id), a.name, a.count)), noAlbum ? chip('none', 'No album', noAlbum) : null);
  }

  function renderGrid() {
    fill(grid, view.photos.map((p) => h('li', {}, h('button', {
      type: 'button', class: 'picker__photo', onclick: () => { chosen = p; dlg.close(); },
    }, h('img', { src: p.thumb_url || p.url, alt: '', loading: 'lazy', decoding: 'async' }), h('span', { class: 'picker__note' }, photoTitle(p))))));
    more.hidden = !view.next;
  }

  async function load({ append: more_ = false } = {}) {
    const ticket = ++loading;
    const qs = new URLSearchParams({ limit: '60' });
    if (view.album !== 'all') qs.set('album_id', view.album);
    if (view.q.trim()) qs.set('q', view.q.trim());
    if (more_ && view.next) qs.set('before', String(view.next));
    status.textContent = 'Loading photos…';
    try {
      const res = await api(`${base}?${qs}`);
      if (ticket !== loading) return; // a newer search or album answered first
      view.photos = more_ ? [...view.photos, ...(res.photos || [])] : res.photos || [];
      view.next = res.next_before ?? null;
      renderChips(res.albums || [], res.total ?? view.photos.length, res.no_album ?? 0);
      renderGrid();
      status.textContent = view.photos.length ? '' : (res.total ? 'No photos match. Try another album or word.' : 'No photos in the library yet. Take some on the Photos page and they show up here.');
    } catch (err) {
      if (ticket === loading) status.textContent = err.message;
    }
  }

  let timer = null;
  search.control.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { view.q = search.control.value; load(); }, 300); });
  more.addEventListener('click', () => withBusy(more, () => load({ append: true })));
  dlg.append(
    h('div', { class: 'sheet__head' }, h('h2', { class: 'sheet__title', id: titleId }, 'Choose a photo'),
      h('button', { type: 'button', class: 'btn btn--icon btn--secondary', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close'))),
    h('div', { class: 'picker__body' }, chips, search, status, grid, h('div', { class: 'actions' }, more)));
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { clearTimeout(timer); dlg.remove(); resolve(chosen); }, { once: true });
    dlg.showModal();
    load();
  });
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
  { id: 'photos', label: 'Photos', icon: 'photos', group: 'business', render: screenPhotos },
  { id: 'screens', label: 'TV screens', icon: 'tv', group: 'business', render: screenScreens },
  { id: 'inquiries', label: 'Inquiries', icon: 'inbox', group: 'business', render: screenInquiries },
  { id: 'history', label: 'History', icon: 'history', group: 'everything', render: screenHistory },
  { id: 'users', label: 'Users', icon: 'users', group: 'everything', render: screenUsers, managerOnly: true },
  { id: 'account', label: 'Account', icon: 'user', group: 'everything', render: screenAccount },
  // Not in the nav: the page a draft link opens (from the Claude app, or a photo used by a draft).
  { id: 'draft', label: 'Review a draft', icon: 'sparkle', group: 'everything', render: screenDraft, hidden: true },
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
  // Each visit renders into its own view. When someone moves on before a slow page has loaded (switching business,
  // then tapping History), the slow page finishes into a view that is no longer on screen instead of replacing the new one.
  const view = h('div', { class: 'view' }, h('p', { class: 'loading' }, 'Loading…'));
  fill(main, view);
  main.scrollTop = 0;
  window.scrollTo({ top: 0 });
  if (def.group === 'business' && !state.slug) {
    fill(view, pageHead({ title: def.label }), emptyState('No business to edit yet', 'Your account is not attached to any business. Ask an owner or admin to add you to one.'));
    return;
  }
  try {
    await def.render(view, { slug: state.slug, sub });
  } catch (err) {
    fill(view, pageHead({ title: def.label }), errorBanner(err, () => route()));
  }
  const heading = view.isConnected ? $('h1', view) : null;
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
  const visible = SCREENS.filter((def) => !def.hidden && screenAllowed(def));
  const list = h('ul', { class: 'sidenav__list', role: 'list' });
  // The Assistant is a panel beside every page, not a page of its own, so its nav item is a button.
  list.append(h('li', {}, h('button', {
    type: 'button', class: 'sidenav__link sidenav__assist', dataset: { assistOpen: '' }, 'aria-controls': 'assist', onclick: () => openAssistant(),
  }, icon('sparkle'), h('span', {}, 'Assistant'))));
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
  more.addEventListener('click', (e) => { if (e.target.closest('a, [data-assist-open]')) more.close(); });

  const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Main' },
    phoneNav().map((id) => navLink(screenById(id), { bottom: true })),
    h('button', { type: 'button', class: 'bottomnav__item', 'aria-haspopup': 'dialog', onclick: () => { fill($('nav', more), navList()); more.showModal(); } }, icon('more'), h('span', {}, 'More')));

  fill(app,
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: hashFor('overview') }, h('span', { class: 'brand__name' }, 'Rome’s Joy'), h('span', { class: 'brand__sub' }, 'Back office')),
      state.businesses.length ? h('div', { class: 'switcher' }, h('label', { class: 'switcher__label', for: 'business-select' }, 'Editing'), select) : null,
      h('button', { type: 'button', class: 'topbar__assist', id: 'assist-toggle', 'aria-controls': 'assist', 'aria-expanded': 'false', onclick: () => toggleAssistant() },
        icon('sparkle'), h('span', { class: 'topbar__assist-label' }, 'Assistant')),
      h('a', { class: 'topbar__user', href: hashFor('account') }, icon('user'), h('span', {}, state.user.name || state.user.email)),
    ),
    h('div', { class: 'frame' },
      h('nav', { class: 'sidenav', 'aria-label': 'Main' }, navList()),
      h('main', { id: 'main', class: 'main', tabindex: '-1' }),
    ),
    bottom, more, assistantPanel(),
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
  store.remove(CHAT_KEY);
  stopDictation();
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
  const [bundle, bizList, usage] = await Promise.all([
    api(`/public/${encodeURIComponent(slug)}`),
    api('/admin/businesses').catch(() => null),
    // Owners and admins see what the Assistant costs (a 501 means it is not switched on; other failures hide the card).
    isManager() ? api('/admin/assistant/usage?days=30').catch((err) => (err.status === 501 ? { off: true } : null)) : null,
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
      usage ? usageStat(usage, stat) : null,
    ),
  );
}

/** The "AI usage" card: this month's estimated cost of the Assistant, for owners and admins (Lance bills Cliff from it). */
function usageStat(usage, stat) {
  if (usage.off) {
    return stat({ label: 'AI usage this month', value: 'Assistant not switched on', note: 'It needs an Anthropic API key on the server. The setup steps are in admin/README.md.', extraClass: 'stat--wide' });
  }
  const month = usage.this_month || {};
  const cost = Number(month.cost_usd) || 0;
  const money = (n) => (n > 0 && n < 0.01 ? 'under $0.01' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n));
  const value = cost > 0 && cost < 0.01 ? 'Under $0.01' : money(cost);
  // A removed account's chats go with it, so only its cost is left to show; all removed accounts share one entry.
  const active = (usage.by_user || []).filter((u) => u.turns || u.calls);
  const removed = active.filter((u) => !u.name && !u.email).reduce((sum, u) => sum + (Number(u.cost_usd) || 0), 0);
  const people = [
    ...active.filter((u) => u.name || u.email).slice(0, 3).map((u) => `${u.name || u.email} ${plural(u.turns || 0, 'message')}`),
    active.some((u) => !u.name && !u.email) ? `removed accounts ${money(removed)}` : null,
  ].filter(Boolean).join(' · ');
  return stat({
    label: 'AI usage this month', value,
    note: [`${plural(month.turns || 0, 'Assistant message')} since ${fmtDate(month.since || chicagoToday().slice(0, 8) + '01', { year: false })}. An estimate; the Anthropic Console has the exact bill.`,
      people ? `Last ${usage.days || 30} days: ${people}.` : null].filter(Boolean).join(' '),
    extraClass: 'stat--wide',
  });
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
  // A photo already in the library (Photos page) is added by its link; nothing is uploaded again.
  const libraryBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, icon('photos'), 'Choose from library');
  libraryBtn.addEventListener('click', () => addFromLibrary());

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
    libraryBtn.disabled = full || busyPhotos;
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

  async function addFromLibrary() {
    photoMsg.textContent = '';
    if (!art.id) { // the same question as "Add photos": a new piece needs its title before it can be saved
      clearErrors(form);
      const { errors } = collect();
      if (errors.title) errors.title = 'Give the artwork a title first, then add photos.';
      if (showErrors(form, errors)) return;
    }
    const photo = await chooseFromLibrary({ slug });
    libraryBtn.focus();
    if (!photo || !(await ensureSaved())) return;
    await withBusy(libraryBtn, async () => {
      try {
        const body = { url: photo.url, thumb_url: photo.thumb_url && photo.thumb_url !== photo.url ? photo.thumb_url : null, width: photo.width ?? null, height: photo.height ?? null, alt: photo.alt || null };
        const res = await api(`/admin/artworks/${art.id}/images`, { method: 'POST', body });
        appendPhoto(res.image || { id: res.id, ...body });
        toast('Photo added from the library.');
      } catch (err) { photoMsg.textContent = err.message; }
    });
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
        media ? h('div', { class: 'photo-pick' }, picker, libraryBtn) : h('div', { class: 'form' }, linkField, h('div', { class: 'photo-pick' }, linkBtn, libraryBtn)),
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
   Photos: the photo library (docs/assistant-api.md §5). Staff snap a photo on a phone now and use it later on
   the website (events, announcements, artworks: "Choose from library"), or ask the Assistant to. Albums keep it
   tidy; a photo that is in use cannot be deleted until it is taken off there.
   ------------------------------------------------------------------------- */
// The album and search, kept while staff open other pages and come back (reset when the business changes).
const photoFilters = { slug: null, album: 'all', q: '' };
const PLACE_KINDS = { event: 'Event', announcement: 'Announcement', artwork: 'Artwork', notice: 'Notice', draft: 'Draft' };

/** Where a photo is used, as a link when it is in the business being edited (else plain words). */
function placeItem(place, slug) {
  const other = place.kind === 'draft' ? 'A draft someone else is working on' : `${PLACE_KINDS[place.kind] || place.kind} of another business`;
  const label = place.title ? `${PLACE_KINDS[place.kind] || place.kind}: ${place.title}` : other;
  let href = null;
  if (place.id != null && place.kind === 'draft') {
    href = hashFor('draft', place.id); // an open Assistant draft: review it there (publish or discard)
  } else if (place.id != null && place.business_slug === slug) {
    href = { event: hashFor('events', place.id), announcement: hashFor('announcements', place.id), artwork: hashFor('artworks', place.id), notice: hashFor('notice') }[place.kind] || null;
  } else if (place.id != null && place.kind === 'announcement' && place.business_slug == null && isManager()) {
    href = hashFor('announcements', `family-${place.id}`);
  }
  return h('li', {}, href ? h('a', { href }, label) : label);
}

async function screenPhotos(main, { slug }) {
  const base = `/admin/businesses/${encodeURIComponent(slug)}`;
  const media = Boolean(state.status?.media_configured);
  if (photoFilters.slug !== slug) Object.assign(photoFilters, { slug, album: 'all', q: '' });
  const view = { photos: [], albums: [], total: 0, noAlbum: 0, next: null };
  const selected = new Set(); // ids ticked for "Move"
  let loadTicket = 0;
  let busyUploads = false;

  async function load({ more = false } = {}) {
    const ticket = ++loadTicket;
    const qs = new URLSearchParams({ limit: '60' });
    if (photoFilters.album !== 'all') qs.set('album_id', photoFilters.album);
    if (photoFilters.q.trim()) qs.set('q', photoFilters.q.trim());
    if (more && view.next) qs.set('before', String(view.next));
    const res = await api(`${base}/media?${qs}`);
    if (ticket !== loadTicket) return false; // a newer album or search answered first
    view.albums = res.albums || [];
    view.total = res.total ?? 0;
    view.noAlbum = res.no_album ?? 0;
    view.next = res.next_before ?? null;
    view.photos = more ? [...view.photos, ...(res.photos || [])] : res.photos || [];
    // An album deleted elsewhere: back to every photo.
    if (!['all', 'none'].includes(photoFilters.album) && !view.albums.some((a) => String(a.id) === photoFilters.album)) {
      photoFilters.album = 'all';
      return load();
    }
    return true;
  }

  async function refresh({ focus } = {}) {
    try {
      if (await load()) render();
    } catch (err) {
      fill(grid, h('li', { class: 'photo-grid__wide' }, errorBanner(err, () => refresh())));
    }
    if (focus) focus.focus();
  }

  const albumName = (id) => (id == null ? 'No album' : view.albums.find((a) => a.id === Number(id))?.name || 'an album');

  // --- Adding photos: pick (or take) several, choose the album, they shrink and upload one at a time ---
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'file-pick__input', id: `library-${++uid}` });
  const uploadAlbum = field({ label: 'Album', name: 'upload_album', type: 'select', options: [{ value: '', label: 'No album' }] });
  const uploadNote = field({ label: 'Note (optional)', name: 'upload_note', maxlength: 500, autocomplete: 'off', placeholder: 'e.g. brunch special, Saturday', hint: 'Saved with every photo you add now. The Assistant finds photos by their note.' });
  let albumTouched = false;
  uploadAlbum.control.addEventListener('change', () => { albumTouched = true; });
  const progress = h('ul', { class: 'upload-progress', role: 'list', 'aria-live': 'polite', 'aria-label': 'Upload progress', tabindex: '-1' });
  const uploadMsg = h('p', { class: 'field__error', role: 'alert' });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) addPhotos(files);
  });
  const uploadTitleId = `upload-title-${++uid}`;
  const uploadCard = media ? h('section', { class: 'card upload-card', 'aria-labelledby': uploadTitleId },
    h('h2', { class: 'card__title', id: uploadTitleId }, 'Add photos'),
    h('div', { class: 'form' },
      h('div', { class: 'form__row form__row--2' }, uploadAlbum, uploadNote),
      h('div', { class: 'file-pick' }, fileInput, h('label', { class: 'btn btn--primary file-pick__btn upload-card__btn', for: fileInput.id }, icon('camera'), 'Take or choose photos')),
      h('p', { class: 'field__hint' }, 'Big phone photos are shrunk before they upload, so it is quick on the shop wifi. On an iPhone, if a photo is refused, set Settings → Camera → Formats → Most Compatible.'),
      progress, uploadMsg))
    : infoBanner('Photo uploads are not set up on the server yet, so new photos cannot be added here. Photos already in the library still work.');

  function syncUploadAlbums() {
    const keep = uploadAlbum.control.value;
    fill(uploadAlbum.control, h('option', { value: '' }, 'No album'), view.albums.map((a) => h('option', { value: String(a.id) }, a.name)));
    // New photos go in the album being looked at, unless someone picked another one.
    const wanted = albumTouched ? keep : (/^\d+$/.test(photoFilters.album) ? photoFilters.album : keep);
    uploadAlbum.control.value = view.albums.some((a) => String(a.id) === wanted) ? wanted : '';
  }

  async function addPhotos(files) {
    if (busyUploads) return;
    busyUploads = true;
    fileInput.disabled = true;
    uploadMsg.textContent = '';
    const albumId = uploadAlbum.control.value ? Number(uploadAlbum.control.value) : null;
    const note = uploadNote.control.value.trim() || null;
    const rows = files.map((file, k) => {
      const step = h('span', { class: 'upload-progress__step' }, STEP_TEXT.waiting);
      const label = `Photo ${k + 1} of ${files.length}${file.name ? ` · ${file.name}` : ''}`;
      return { file, step, row: h('li', { class: 'upload-progress__row' }, h('span', { class: 'upload-progress__name' }, label), step) };
    });
    fill(progress, rows.map((r) => r.row));
    let added = 0;
    const failed = [];
    for (const { file, step, row } of rows) { // one at a time: a phone has little memory to spare
      try {
        const up = await uploadPhoto(file, { slug, onStep: (s) => { step.textContent = STEP_TEXT[s]; } });
        await api(`${base}/media`, {
          method: 'POST', timeoutMs: UPLOAD_TIMEOUT_MS,
          body: { url: up.url, thumb_url: up.thumb_url, r2_key: up.key, thumb_r2_key: up.thumb_key, album_id: albumId, note, alt: null, width: up.width, height: up.height, bytes: up.bytes, taken_at: await photoTakenAt(file) },
        });
        row.classList.add('is-done');
        step.textContent = STEP_TEXT.done;
        added++;
      } catch (err) {
        row.classList.add('is-error');
        step.textContent = err.message;
        if (!(err instanceof PhotoError) && err.code !== 'already_in_library') failed.push(file);
      }
    }
    busyUploads = false;
    fileInput.disabled = false;
    if (failed.length) {
      const again = h('button', { type: 'button', class: 'btn btn--secondary' }, failed.length === 1 ? 'Try that photo again' : `Try the ${failed.length} photos again`);
      again.addEventListener('click', () => { progress.focus(); addPhotos(failed); });
      progress.append(h('li', { class: 'upload-progress__retry' }, again));
    }
    if (added) {
      if (!failed.length) uploadNote.control.value = '';
      toast(`${plural(added, 'photo')} added to ${albumId == null ? 'the library' : `“${albumName(albumId)}”`}.`);
      await refresh();
    }
  }

  // --- Albums: chips to filter by, plus new / rename / delete ---
  const chips = h('div', { class: 'album-chips', role: 'group', 'aria-label': 'Albums' });
  const albumTools = h('div', { class: 'album-tools' });
  function renderChips() {
    const chip = (id, label, count) => h('button', {
      type: 'button', class: 'album-chip', 'aria-pressed': String(photoFilters.album === id),
      onclick: () => { if (photoFilters.album === id) return; photoFilters.album = id; selected.clear(); refresh(); },
    }, label, h('span', { class: 'album-chip__count' }, String(count)));
    const add = h('button', { type: 'button', class: 'album-chip album-chip--add' }, icon('plus'), 'New album');
    add.addEventListener('click', () => newAlbum(add));
    fill(chips, chip('all', 'All photos', view.total), view.albums.map((a) => chip(String(a.id), a.name, a.count)),
      view.noAlbum || !view.albums.length || photoFilters.album === 'none' ? chip('none', 'No album', view.noAlbum) : null, add);
    const album = view.albums.find((a) => String(a.id) === photoFilters.album);
    fill(albumTools, album ? [
      h('button', { type: 'button', class: 'btn btn--quiet btn--compact', onclick: (e) => renameAlbum(album, e.currentTarget) }, 'Rename album', srOnly(` “${album.name}”`)),
      h('button', { type: 'button', class: 'btn btn--quiet btn--compact album-tools__delete', onclick: (e) => deleteAlbum(album, e.currentTarget) }, 'Delete album', srOnly(` “${album.name}”`)),
    ] : []);
    albumTools.hidden = !album;
  }
  const nameTaken = (name, except) => (view.albums.some((a) => a.id !== except && a.name.toLowerCase() === name.toLowerCase()) ? `There is already an album called “${name}”.` : '');

  async function newAlbum(button) {
    const name = await promptDialog({ title: 'New album', label: 'Album name', confirmLabel: 'Add album', maxlength: 60, check: (t) => nameTaken(t) });
    button.focus();
    if (!name) return;
    await withBusy(button, async () => {
      try {
        const res = await api(`${base}/albums`, { method: 'POST', body: { name } });
        photoFilters.album = String(res.album.id);
        albumTouched = false;
        toast(`Album “${name}” added.`);
        await refresh();
        $(`.album-chip[aria-pressed="true"]`, chips)?.focus();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  async function renameAlbum(album, button) {
    const name = await promptDialog({ title: 'Rename album', label: 'Album name', value: album.name, confirmLabel: 'Rename', maxlength: 60, check: (t) => nameTaken(t, album.id) });
    button.focus();
    if (!name || name === album.name) return;
    await withBusy(button, async () => {
      try {
        await api(`/admin/albums/${album.id}`, { method: 'PATCH', body: { name } });
        toast(`Album renamed to “${name}”.`);
        await refresh();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  async function deleteAlbum(album, button) {
    const ok = await confirmDialog({
      title: `Delete the album “${album.name}”?`,
      text: album.count ? `Its ${plural(album.count, 'photo')} stay in the library, under “No album”. Nothing on the website changes.` : 'It has no photos. Nothing on the website changes.',
      confirmLabel: 'Delete album',
    });
    if (!ok) { button.focus(); return; }
    await withBusy(button, async () => {
      try {
        await api(`/admin/albums/${album.id}`, { method: 'DELETE' });
        photoFilters.album = 'all';
        toast(`Album “${album.name}” deleted.`);
        await refresh();
        $('.album-chip', chips)?.focus();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  // --- Search ---
  const search = field({ label: 'Search photos', name: 'q', type: 'search', value: photoFilters.q, placeholder: 'A note, a description or an album', autocomplete: 'off' });
  let searchTimer = null;
  search.control.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { photoFilters.q = search.control.value; selected.clear(); refresh(); }, 300);
  });

  // --- Selecting several photos to move them (to another album, or another business) ---
  const selectCount = h('p', { class: 'select-bar__count', 'aria-live': 'polite' });
  const moveId = `move-${++uid}`;
  const moveSelect = h('select', { class: 'select', id: moveId });
  const moveBtn = h('button', { type: 'button', class: 'btn btn--primary btn--compact' }, 'Move');
  const clearSel = h('button', { type: 'button', class: 'btn btn--secondary btn--compact', onclick: () => { selected.clear(); render(); summary.focus(); } }, 'Clear');
  const selectBar = h('div', { class: 'select-bar', role: 'region', 'aria-label': 'Selected photos', hidden: true },
    selectCount, h('div', { class: 'select-bar__move' }, h('label', { class: 'select-bar__label', for: moveId }, 'Move to'), moveSelect), h('div', { class: 'select-bar__buttons' }, moveBtn, clearSel));
  moveBtn.addEventListener('click', () => moveSelected());

  function syncSelection() {
    const n = selected.size;
    selectBar.hidden = n === 0;
    selectCount.textContent = n ? `${plural(n, 'photo')} selected` : '';
    const keep = moveSelect.value;
    const others = state.businesses.filter((b) => b.slug !== slug);
    fill(moveSelect,
      h('optgroup', { label: 'An album' }, h('option', { value: 'album:none' }, 'No album'), view.albums.map((a) => h('option', { value: `album:${a.id}` }, a.name))),
      others.length ? h('optgroup', { label: 'Another business' }, others.map((b) => h('option', { value: `biz:${b.slug}` }, b.name))) : null);
    if ([...moveSelect.options].some((o) => o.value === keep)) moveSelect.value = keep;
  }

  async function moveSelected() {
    const target = moveSelect.value;
    const ids = view.photos.filter((p) => selected.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    const toBusiness = target.startsWith('biz:') ? state.businesses.find((b) => b.slug === target.slice(4)) : null;
    const body = toBusiness ? { business_slug: toBusiness.slug } : { album_id: target === 'album:none' ? null : Number(target.slice(6)) };
    const where = toBusiness ? toBusiness.name : target === 'album:none' ? '“No album”' : `“${albumName(body.album_id)}”`;
    if (toBusiness) {
      const ok = await confirmDialog({
        title: `Move ${plural(ids.length, 'photo')} to ${toBusiness.name}?`,
        text: `They leave ${currentBusiness()?.name || 'this business'}’s library and go to ${toBusiness.name}’s, with no album. Anything already using them keeps working.`,
        confirmLabel: 'Move', danger: false,
      });
      if (!ok) { moveBtn.focus(); return; }
    }
    await withBusy(moveBtn, async () => {
      let moved = 0;
      for (const id of ids) { // one request per photo; stop at the first problem and say how far it got
        try {
          await api(`/admin/media/${id}`, { method: 'PATCH', body });
          selected.delete(id);
          moved++;
        } catch (err) {
          toast(`${moved ? `Moved ${plural(moved, 'photo')}, then stopped: ` : ''}${err.message}`, { kind: 'error' });
          break;
        }
      }
      if (moved === ids.length) toast(`Moved ${plural(moved, 'photo')} to ${where}.`);
      await refresh();
      summary.focus();
    });
  }

  // --- The grid ---
  const summary = h('p', { class: 'photo-summary', 'aria-live': 'polite', tabindex: '-1' });
  const grid = h('ul', { class: 'photo-grid', role: 'list' });
  const more = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Show more photos');
  more.addEventListener('click', () => withBusy(more, async () => {
    try { if (await load({ more: true })) render(); } catch (err) { toast(err.message, { kind: 'error' }); }
  }));

  function tile(p) {
    const title = photoTitle(p);
    const checkId = `pick-${p.id}-${++uid}`;
    const check = h('input', { type: 'checkbox', id: checkId, checked: selected.has(p.id) });
    const el = h('li', { class: `photo-tile${selected.has(p.id) ? ' is-selected' : ''}`, dataset: { photo: String(p.id) } },
      // The picture opens the photo for fingers; keyboards and screen readers get the Edit button.
      h('button', { type: 'button', class: 'photo-tile__img', tabindex: '-1', 'aria-hidden': 'true', onclick: () => editPhoto(p) },
        h('img', { src: p.thumb_url || p.url, alt: '', loading: 'lazy', decoding: 'async' })),
      h('label', { class: 'photo-tile__select', for: checkId }, check, srOnly(`Select ${title}`)),
      h('div', { class: 'photo-tile__body' },
        h('p', { class: `photo-tile__note${p.note ? '' : ' is-empty'}` }, p.note || 'No note'),
        h('p', { class: 'photo-tile__meta' }, [photoFilters.album === 'all' ? p.album_name || 'No album' : null, fmtDate(String(p.taken_at || p.created_at || '').slice(0, 10), { year: false })].filter(Boolean).join(' · ')),
        h('div', { class: 'photo-tile__foot' },
          p.in_use?.length ? h('span', { class: 'chip chip--current' }, 'In use') : null,
          h('button', { type: 'button', class: 'btn btn--secondary btn--compact photo-tile__edit', onclick: () => editPhoto(p) }, 'Edit', srOnly(` ${title}`)))));
    check.addEventListener('change', () => {
      if (check.checked) selected.add(p.id); else selected.delete(p.id);
      el.classList.toggle('is-selected', check.checked);
      syncSelection();
    });
    return el;
  }

  function render() {
    renderChips();
    syncUploadAlbums();
    const filtering = photoFilters.album !== 'all' || photoFilters.q.trim();
    const shown = view.photos.length;
    summary.textContent = view.total ? `${plural(view.total, 'photo')} in the library${filtering ? ` · ${shown}${view.next ? '+' : ''} shown here` : ''}` : '';
    if (!view.total) {
      fill(grid, h('li', { class: 'photo-grid__wide' }, emptyState('No photos yet', media ? 'Take a photo of today’s special, the dining room or a new piece. It waits here until you use it on the website.' : 'Photos added by link elsewhere show up here.')));
    } else if (!shown) {
      fill(grid, h('li', { class: 'photo-grid__wide' }, emptyState('No photos here', photoFilters.q.trim() ? 'No photo matches that search. Try another word.' : 'This album is empty. Add photos above, or move some here.')));
    } else {
      fill(grid, view.photos.map(tile));
    }
    more.hidden = !view.next;
    // Ticked photos that are no longer on screen are let go, so "Move" only ever moves what you can see.
    for (const id of [...selected]) if (!view.photos.some((p) => p.id === id)) selected.delete(id);
    syncSelection();
  }

  // --- One photo: note, description, album, where it is used, delete ---
  function editPhoto(p) {
    const titleId = `photo-title-${++uid}`;
    const dlg = h('dialog', { class: 'dialog dialog--photo', 'aria-labelledby': titleId });
    const note = field({ label: 'Note', name: 'note', type: 'textarea', rows: 2, value: p.note || '', maxlength: 500, hint: 'What it is, in your words, e.g. “brunch special” or “new piece, Hamilton”.' });
    const alt = field({ label: 'Description', name: 'alt', type: 'textarea', rows: 2, value: p.alt || '', maxlength: 500, hint: 'What the photo shows, for people who use screen readers, e.g. “Chicken and waffles with peach butter”.' });
    const album = field({ label: 'Album', name: 'album_id', type: 'select', value: p.album_id ?? '', options: [{ value: '', label: 'No album' }, ...view.albums.map((a) => ({ value: String(a.id), label: a.name }))] });
    const used = p.in_use || [];
    const usedBox = h('div', { class: 'photo-used' },
      h('p', { class: 'field__label' }, 'Where it is used'),
      used.length ? h('ul', { class: 'photo-used__list' }, used.map((place) => placeItem(place, slug))) : h('p', { class: 'muted small' }, 'Not used on the website yet.'));
    const error = h('div', { class: 'form-error', role: 'alert' });
    const save = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save');
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => dlg.close() }, 'Cancel');
    const del = h('button', { type: 'button', class: 'btn btn--danger' }, 'Delete');
    const form = h('form', { novalidate: true },
      h('div', { class: 'dialog__body' },
        h('h2', { class: 'dialog__title', id: titleId }, photoTitle(p)),
        h('img', { class: 'dialog__photo', src: p.url, alt: p.alt || '', width: p.width || null, height: p.height || null }),
        h('p', { class: 'muted small dialog__meta' }, [p.taken_at ? `Taken ${fmtDate(p.taken_at.slice(0, 10))}` : null, `Added ${fmtDateTime(p.created_at)}${p.uploaded_by_name ? ` by ${p.uploaded_by_name}` : ''}`].filter(Boolean).join(' · ')),
        h('div', { class: 'form' }, note, alt, album, usedBox, error)),
      h('div', { class: 'dialog__actions' }, del, h('span', { class: 'actions__spacer' }), cancel, save));
    dlg.append(form);
    document.body.append(dlg);
    const opener = document.activeElement;
    dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus(); else summary.focus(); }, { once: true });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = {};
      const nextNote = note.control.value.trim() || null;
      const nextAlt = alt.control.value.trim() || null;
      const nextAlbum = album.control.value ? Number(album.control.value) : null;
      if (nextNote !== (p.note || null)) body.note = nextNote;
      if (nextAlt !== (p.alt || null)) body.alt = nextAlt;
      if (nextAlbum !== (p.album_id ?? null)) body.album_id = nextAlbum;
      if (!Object.keys(body).length) { dlg.close(); return; }
      withBusy(save, async () => {
        try {
          const res = await api(`/admin/media/${p.id}`, { method: 'PATCH', body });
          Object.assign(p, res.photo || body);
          dlg.close();
          toast('Photo saved.');
          await refresh();
        } catch (err) { error.textContent = err.message; }
      });
    });

    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete this photo?', text: 'It is removed from the library for good. Photos that are on the website cannot be deleted until they are taken off there.' });
      if (!ok) { del.focus(); return; }
      await withBusy(del, async () => {
        try {
          await api(`/admin/media/${p.id}`, { method: 'DELETE' });
          selected.delete(p.id);
          dlg.close();
          toast('Photo deleted.');
          await refresh();
        } catch (err) {
          // The message sits below the fields: scroll it into view, or on a phone it is hidden under the buttons.
          if (err.code !== 'in_use') { error.textContent = err.message; error.scrollIntoView({ block: 'center' }); return; }
          // Say where, with links to each place, so it can be taken off there first.
          const places = err.data?.in_use || [];
          fill(error, h('p', {}, err.data?.error || 'This photo is in use, so it cannot be deleted yet.'),
            places.length ? h('ul', { class: 'photo-used__list' }, places.map((place) => placeItem(place, slug))) : null);
          p.in_use = places;
          fill(usedBox, h('p', { class: 'field__label' }, 'Where it is used'), places.length ? h('ul', { class: 'photo-used__list' }, places.map((place) => placeItem(place, slug))) : h('p', { class: 'muted small' }, 'Not used on the website yet.'));
          del.focus();
          error.scrollIntoView({ block: 'center' });
        }
      });
    });
    dlg.addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) dlg.close(); });
    dlg.showModal();
    note.control.focus();
  }

  await load();
  fill(main,
    pageHead({ title: 'Photos', lead: 'Take photos now and use them later: for events, announcements and artworks (“Choose from library”), or ask the Assistant to put one on the website.' }),
    uploadCard,
    h('div', { class: 'photo-filters' }, chips, albumTools, search),
    summary, grid, h('div', { class: 'actions' }, more), selectBar);
  render();
}

/* -------------------------------------------------------------------------
   TV screens (docs/assistant-api.md §6): each TV that plays this business's screen, whether it is on, a small live
   preview, what the screens show, and "Refresh all screens now". A TV is online when it checked in within 10 minutes.
   ------------------------------------------------------------------------- */
const SCENES = ['welcome', 'notice', 'announcements', 'featured', 'menu', 'catering', 'events', 'artworks'];
const SCENE_LABELS = {
  welcome: 'Welcome: name, hours, open now', notice: 'Notice', announcements: 'Announcements', featured: 'Featured dishes',
  menu: 'Menu board', catering: 'Catering', events: 'Events and exhibitions', artworks: 'Artworks',
};
const SCREEN_STATUS = { online: 'Online', offline: 'Offline', never: 'Not connected yet' };
const SCREEN_POLL_MS = 30000; // statuses refresh while the page is open

/** "Online · last seen 2 min ago" with a coloured dot (the words carry the meaning; the dot is extra). */
function screenStatusLine(s) {
  return h('p', { class: `screen-status screen-status--${s.status}` },
    h('span', { class: 'screen-status__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'screen-status__text' }, SCREEN_STATUS[s.status] || s.status),
    s.last_seen_at ? h('span', { class: 'screen-status__seen' }, ` · last seen ${timeAgo(s.last_seen_at)}`) : null);
}

async function screenScreens(main, { slug }) {
  const base = `/admin/businesses/${encodeURIComponent(slug)}`;
  let { screens = [], settings = {} } = await api(`${base}/screens`);
  const list = h('ul', { class: 'screen-list', role: 'list' });
  const summary = h('p', { class: 'screen-summary', 'aria-live': 'polite', tabindex: '-1' });
  const formSlot = h('div');
  const bizName = currentBusiness()?.short_name || currentBusiness()?.name || 'This business';

  // Mini previews load only while on screen (each one is a whole TV page) and stop again when scrolled away.
  // They use the page without ?screen=, so an open admin never makes a TV look online.
  const previews = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting && target.getAttribute('src') !== target.dataset.src) target.src = target.dataset.src;
      else if (!isIntersecting && target.getAttribute('src') && target.getAttribute('src') !== 'about:blank') target.src = 'about:blank';
    }
  }, { rootMargin: '120px' }) : null;

  function renderSummary() {
    const online = screens.filter((s) => s.status === 'online').length;
    summary.textContent = screens.length ? `${plural(screens.length, 'screen')} · ${online} online` : '';
  }

  function screenCard(s) {
    const frame = h('iframe', {
      class: 'screen-card__frame', title: `Live preview of ${s.name}`, loading: 'lazy', tabindex: '-1',
      sandbox: 'allow-scripts allow-same-origin', referrerpolicy: 'no-referrer', dataset: { src: s.preview_url },
    });
    if (previews) previews.observe(frame); else frame.src = s.preview_url;
    const body = h('div', { class: 'screen-card__body' });
    const card = h('li', { class: 'screen-card', dataset: { screen: s.id } }, h('div', { class: 'screen-card__preview' }, frame), body);
    const showView = () => {
      const rename = h('button', { type: 'button', class: 'btn btn--secondary btn--compact' }, 'Rename', srOnly(` ${s.name}`));
      const remove = h('button', { type: 'button', class: 'btn btn--danger btn--compact' }, 'Remove', srOnly(` ${s.name}`));
      rename.addEventListener('click', () => showEdit());
      remove.addEventListener('click', () => removeScreen(s, remove));
      fill(body,
        h('h3', { class: 'screen-card__name' }, s.name),
        screenStatusLine(s),
        s.notes ? h('p', { class: 'screen-card__notes' }, s.notes) : null,
        copyField({ label: 'Player link', value: s.player_url, hint: 'Open this link on the TV, full screen. It tells this page when the TV is on.' }),
        h('div', { class: 'screen-card__tools' },
          h('a', { class: 'btn btn--quiet btn--compact', href: s.preview_url, target: '_blank', rel: 'noopener' }, 'Open preview', icon('external'), srOnly(` of ${s.name} (new tab)`)),
          h('div', { class: 'screen-card__edit' }, rename, remove)));
    };
    const showEdit = () => {
      const form = screenForm({ screen: s, onDone: async (saved) => {
        if (saved) Object.assign(s, saved);
        showView();
        $('.btn', body)?.focus();
      } });
      fill(body, form);
    };
    showView();
    return card;
  }

  function renderList() {
    if (previews) previews.disconnect();
    renderSummary();
    fill(list, screens.length ? screens.map(screenCard) : h('li', {}, emptyState('No TV screens yet',
      'Add one for each TV (“Counter”, “Dining room”), then open its player link on that TV. This page then shows whether each TV is on.')));
  }

  /** The add / rename form. onDone(screen or null). */
  function screenForm({ screen = null, onDone }) {
    const isNew = !screen;
    const name = field({ label: 'Name', name: 'name', value: screen?.name || '', required: true, maxlength: 80, placeholder: `e.g. ${bizName}: counter`, hint: 'Where the TV is, so you can tell them apart.' });
    const notes = field({ label: 'Notes (optional)', name: 'notes', value: screen?.notes || '', maxlength: 500, placeholder: 'e.g. Fire TV stick behind the menu board' });
    const save = h('button', { type: 'submit', class: 'btn btn--primary' }, isNew ? 'Add screen' : 'Save');
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => { state.dirty = false; onDone(null); } }, 'Cancel');
    const form = h('form', { class: `form${isNew ? ' card' : ''}`, novalidate: true, 'aria-label': isNew ? 'Add a TV screen' : `Rename ${screen.name}` },
      isNew ? h('h2', { class: 'card__title' }, 'Add a TV screen') : null,
      name, notes, h('p', { class: 'form-error', role: 'alert' }), h('div', { class: 'actions' }, save, cancel));
    trackDirty(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearErrors(form);
      const body = { name: name.control.value.trim(), notes: notes.control.value.trim() || null };
      if (showErrors(form, { name: body.name ? '' : 'Give the screen a name, like “Counter”.' })) return;
      withBusy(save, async () => {
        try {
          const res = isNew
            ? await api(`${base}/screens`, { method: 'POST', body })
            : await api(`/admin/screens/${screen.id}`, { method: 'PATCH', body });
          state.dirty = false;
          toast(isNew ? 'Screen added. Open its player link on the TV.' : 'Saved.');
          onDone(res.screen || { ...screen, ...body });
        } catch (err) { $('.form-error', form).textContent = err.message; }
      });
    });
    queueMicrotask(() => name.control.focus());
    return form;
  }

  async function removeScreen(s, button) {
    const ok = await confirmDialog({
      title: `Remove “${s.name}”?`,
      text: 'The TV keeps playing, but this page no longer shows whether it is on. To list it again, add it again and open the new link on the TV.',
      confirmLabel: 'Remove',
    });
    if (!ok) { button.focus(); return; }
    await withBusy(button, async () => {
      try {
        await api(`/admin/screens/${s.id}`, { method: 'DELETE' });
        screens = screens.filter((x) => x !== s);
        renderList();
        toast('Screen removed.');
        summary.focus();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
  }

  const addBtn = h('button', { type: 'button', class: 'btn btn--primary' }, icon('plus'), 'Add screen');
  addBtn.addEventListener('click', () => {
    fill(formSlot, screenForm({ onDone: (saved) => {
      fill(formSlot);
      if (saved) {
        screens = [...screens, saved].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
        renderList();
        $(`[data-screen="${saved.id}"] .screen-card__name`, list)?.scrollIntoView({ block: 'center' });
        $(`[data-screen="${saved.id}"] .copy-field .btn`, list)?.focus();
      } else addBtn.focus();
    } }));
  });

  const refreshBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, icon('refresh'), 'Refresh all screens now');
  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, async () => {
    try {
      const res = await api(`${base}/screens/refresh`, { method: 'POST' });
      if (res.settings) settings = { ...settings, refresh_version: res.settings.refresh_version };
      toast('Asked every screen to reload. They pick it up within a minute.');
    } catch (err) { toast(err.message, { kind: 'error' }); }
  }));

  // --- What the screens show: scene switches and seconds per scene, saved with the button ---
  const scenes = SCENES.filter((name) => name !== 'artworks' || hasFeature('artworks'));
  const sceneToggles = scenes.map((name) => toggle({ label: SCENE_LABELS[name], name: `scene-${name}`, checked: settings.scenes?.[name] !== false }));
  const seconds = field({ label: 'Seconds per scene', name: 'seconds_per_scene', type: 'number', min: 4, max: 60, step: 1, inputmode: 'numeric', value: settings.seconds_per_scene ?? 10, hint: 'From 4 to 60. A long menu reads better with more time.' });
  seconds.classList.add('scene-seconds');
  const saveScenes = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save screen settings');
  const sceneForm = h('form', { class: 'form card', novalidate: true, 'aria-labelledby': 'scenes-title' },
    h('h2', { class: 'card__title', id: 'scenes-title' }, 'What the screens show'),
    h('p', { class: 'muted small' }, `For every ${bizName} TV. A scene with nothing to show (no notice, no events) is skipped by itself.`),
    h('fieldset', { class: 'fieldset' }, h('legend', { class: 'field__label' }, 'Scenes'), h('div', { class: 'scene-grid' }, sceneToggles)),
    seconds,
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'actions' }, saveScenes));
  trackDirty(sceneForm);
  sceneForm.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(sceneForm);
    const n = seconds.control.value === '' ? NaN : Number(seconds.control.value);
    if (showErrors(sceneForm, { seconds_per_scene: Number.isInteger(n) && n >= 4 && n <= 60 ? '' : 'Use a whole number from 4 to 60.' })) return;
    const value = { ...settings, seconds_per_scene: n, scenes: { ...(settings.scenes || {}) } };
    scenes.forEach((name) => { value.scenes[name] = sceneForm.elements[`scene-${name}`].checked; });
    withBusy(saveScenes, async () => {
      try {
        await api(`/admin/settings/signage:${encodeURIComponent(slug)}`, { method: 'PUT', body: { value } });
        settings = value;
        state.dirty = false;
        flashSaved(saveScenes);
        toast('Saved. The screens show it within a few minutes, or tap “Refresh all screens now”.');
      } catch (err) { $('.form-error', sceneForm).textContent = err.message; }
    });
  });

  // --- Keep the statuses fresh while this page is open ---
  const checkBtn = h('button', { type: 'button', class: 'btn btn--quiet btn--compact' }, 'Check again');
  async function updateStatuses() {
    const res = await api(`${base}/screens`);
    const fresh = res.screens || [];
    if (fresh.map((s) => s.id).join() !== screens.map((s) => s.id).join()) { screens = fresh; renderList(); return; }
    fresh.forEach((f, i) => {
      Object.assign(screens[i], f);
      const line = $(`[data-screen="${f.id}"] .screen-status`, list);
      if (line) line.replaceWith(screenStatusLine(screens[i]));
    });
    renderSummary();
  }
  checkBtn.addEventListener('click', () => withBusy(checkBtn, async () => {
    try { await updateStatuses(); toast('Checked just now.'); } catch (err) { toast(err.message, { kind: 'error' }); }
  }));
  const poll = setInterval(() => {
    if (!list.isConnected) { clearInterval(poll); previews?.disconnect(); return; }
    if (document.visibilityState === 'visible') updateStatuses().catch(() => { /* the next round tries again */ });
  }, SCREEN_POLL_MS);

  fill(main,
    pageHead({
      title: 'TV screens',
      lead: 'Every TV that plays this business’s screen. Each TV gets its own link; once it is open on the TV, this page shows whether the TV is on.',
      actions: [addBtn, refreshBtn],
    }),
    formSlot,
    h('div', { class: 'screen-summary-row' }, summary, checkBtn),
    list,
    h('div', { style: 'margin-top:18px' }, sceneForm));
  renderList();
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
const ENTITY_LABELS = { business: 'business details', hours: 'hours', hours_exception: 'a special day', event: 'an event', menu_section: 'a menu section', menu_item: 'a menu item', announcement: 'an announcement', inquiry: 'an inquiry', user: 'a user', settings: 'settings', artwork: 'an artwork', artwork_image: 'an artwork photo', media: 'a photo',
  photo: 'a library photo', album: 'a photo album', screen: 'a TV screen', change_set: 'Assistant changes', connected_app: 'a connected app' };

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
    form,
    me.must_change_password ? null : connectedAppsCard());
  if (me.must_change_password) current.control.focus();
}

/**
 * The Claude app connector (docs/assistant-api.md §4): how to connect it, and the apps connected with this account,
 * each with Disconnect (its access ends at once).
 */
function connectedAppsCard() {
  const list = h('div', { class: 'list', 'aria-live': 'polite' }, h('p', { class: 'muted small' }, 'Loading…'));
  const titleId = `apps-title-${++uid}`;
  const card = h('section', { class: 'card', 'aria-labelledby': titleId, style: 'margin-top:14px' },
    h('h2', { class: 'card__title', id: titleId, tabindex: '-1' }, 'Claude app'),
    h('p', { class: 'muted' }, 'Manage the websites from the Claude app, the same way as with the Assistant here: Claude drafts, you check the preview, and nothing goes live until you confirm.'),
    h('ol', { class: 'steps' },
      h('li', {}, 'In the Claude app, open Settings → Connectors → Add custom connector.'),
      h('li', {}, 'Paste the address below, then sign in with your back office email and password.'),
      h('li', {}, 'Allow access. Claude can then change what your account can change, nothing more.')),
    copyField({ label: 'Connector address', value: `${workerOrigin()}/mcp` }),
    h('h3', { class: 'apps__title' }, 'Connected with your account'),
    list);
  const row = (app) => {
    const off = h('button', { type: 'button', class: 'btn btn--danger btn--compact' }, 'Disconnect', srOnly(` ${app.name}`));
    off.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Disconnect ${app.name}?`, text: 'It can no longer read or change anything. You can connect it again from the Claude app at any time.', confirmLabel: 'Disconnect' });
      if (!ok) { off.focus(); return; }
      withBusy(off, async () => {
        try {
          await api(`/admin/connected-apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
          toast(`${app.name} disconnected.`);
          await load();
          $('h2', card)?.focus?.();
        } catch (err) { toast(err.message, { kind: 'error' }); }
      });
    });
    return h('div', { class: 'list__row' },
      h('div', { class: 'list__main' },
        h('p', { class: 'list__title' }, app.name, app.needs_sign_in ? h('span', { class: 'chip chip--off', style: 'margin-left:8px' }, 'Needs sign-in again') : null),
        h('p', { class: 'list__meta' }, [`Connected ${fmtDateTime(app.connected_at)}`, app.host].filter(Boolean).join(' · ')),
        app.needs_sign_in ? h('p', { class: 'list__meta' }, 'Your password changed since, so it stopped working. Connect it again from the Claude app.') : null),
      h('div', { class: 'list__actions' }, off));
  };
  async function load() {
    try {
      const { connected_apps: apps = [] } = await api('/admin/connected-apps');
      fill(list, apps.length ? apps.map(row) : h('p', { class: 'muted small' }, 'Nothing connected yet.'));
    } catch (err) {
      fill(list, h('p', { class: 'muted small' }, err.status === 404 || err.status === 501 ? 'The Claude app connector is not set up on this server yet.' : err.message));
    }
  }
  load();
  return card;
}

/* -------------------------------------------------------------------------
   Assistant (docs/assistant-api.md §3 and §7): a chat beside every page. Staff ask in plain English; the Assistant
   reads the data, asks for anything missing and drafts a change set. The draft card shows before → after, the
   double-checks and preview links, and nothing is live until a person taps Publish. Replies stream as Server-Sent
   Events over fetch, because EventSource cannot send the Authorization header.
   ------------------------------------------------------------------------- */
const CHAT_KEY = 'rj_admin_chat';            // the chat to reopen (per browser; the server checks it is yours)
const CHAT_PHOTO_PX = 1600;                  // photos sent to the Assistant: JPEG, longest side at most this
const CHAT_PHOTO_BYTES = 1.5 * 1024 * 1024;  // and at most this big (the server's limit)
const CHAT_MAX_PHOTOS = 4;
const CHAT_MAX_TEXT = 8000;
const THINKING_SLOW_MS = 25000;              // no word or step from Claude for this long: say that is normal
const TURN_POLL_MS = 4000;                   // after a reply was cut off: how often to ask whether the turn has finished
const TURN_WAIT_MS = 200000;                 // and for how long (the server lets a stuck turn go after 3 minutes)
const LIVE_SOON = 'The websites update within a minute, the TV screens within a minute or two.';
const SUGGESTIONS = [
  'Close early this Friday at noon',
  'Put up a notice at the top of the website',
  'Add a dish to the menu',
  'Add an event',
  'Use the photo I took today on the website',
];
const CHECK_LEVELS = { ok: { word: 'OK', icon: 'check' }, warn: { word: 'Check', icon: 'alert' }, block: { word: 'Must fix', icon: 'close' } };
const DRAFT_STATUS = { draft: 'Draft · not live yet', published: 'Published', undone: 'Undone', discarded: 'Discarded', expired: 'Expired', failed: 'Not published' };
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const phoneLayout = window.matchMedia('(max-width: 899px)');

const assist = {};
function resetAssistant() {
  Object.assign(assist, {
    el: null, parts: null, ready: false, off: false, view: 'chat', conversation: null, conversations: [],
    busy: false, photos: [], drafts: new Map(), verify: new Map(), pending: [], recognition: null, opener: null,
  });
}
resetAssistant();

/** The panel: built with the app shell, hidden until the Assistant button opens it. */
function assistantPanel() {
  resetAssistant();
  const p = {};
  p.subtitle = h('p', { class: 'assist__subtitle' }, 'New chat');
  p.chatsBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--compact', 'aria-pressed': 'false', onclick: () => (assist.view === 'list' ? showChat() : showChats()) }, icon('chat'), h('span', { class: 'assist__btn-label' }, 'Chats'));
  p.newBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--compact', onclick: () => newChat() }, icon('plus'), h('span', { class: 'assist__btn-label' }, 'New chat'));
  p.closeBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-label': 'Close the Assistant', onclick: () => closeAssistant() }, icon('close'));
  p.log = h('div', { class: 'assist__log', role: 'log', 'aria-label': 'Conversation', tabindex: '-1' });
  p.chats = h('div', { class: 'assist__chats', hidden: true });
  p.body = h('div', { class: 'assist__body' }, p.log, p.chats);

  // Composer: text, photo, microphone, send.
  p.input = h('textarea', { class: 'textarea assist__input', id: 'assist-input', rows: 2, maxlength: CHAT_MAX_TEXT, placeholder: 'e.g. Close Peach’s early this Friday at noon', 'aria-describedby': 'assist-hint' });
  p.input.addEventListener('input', autoGrow);
  p.input.addEventListener('keydown', (e) => {
    // Enter sends on a computer (Shift+Enter for a new line); on a phone the Enter key makes a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !window.matchMedia('(pointer: coarse)').matches) { e.preventDefault(); sendMessage(); }
  });
  p.file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'file-pick__input', id: 'assist-photo' });
  p.file.addEventListener('change', () => { const files = [...(p.file.files || [])]; p.file.value = ''; if (files.length) attachPhotos(files); });
  p.photoBtn = h('label', { class: 'btn btn--secondary btn--icon file-pick__btn', for: 'assist-photo', title: 'Add a photo' }, icon('camera'), srOnly('Add a photo (a menu board, a flyer, a label)'));
  p.mic = Recognition ? h('button', { type: 'button', class: 'btn btn--secondary btn--icon assist__mic', 'aria-pressed': 'false', 'aria-label': 'Speak instead of typing', title: 'Speak instead of typing', onclick: () => toggleDictation() }, icon('mic')) : null;
  p.send = h('button', { type: 'submit', class: 'btn btn--primary assist__send' }, icon('send'), h('span', {}, 'Send'));
  p.attachments = h('ul', { class: 'assist__attachments', role: 'list', 'aria-label': 'Photos to send', hidden: true });
  p.status = h('p', { class: 'assist__status', id: 'assist-hint', role: 'status' });
  p.composer = h('form', { class: 'assist__composer', novalidate: true },
    h('label', { class: 'visually-hidden', for: 'assist-input' }, 'Message to the Assistant'),
    p.attachments, p.input,
    // Photos sent in the chat are kept in photo storage, so without it the button is left out.
    h('div', { class: 'assist__tools' }, state.status?.media_configured ? h('div', { class: 'file-pick' }, p.file, p.photoBtn) : null, p.mic, p.status, p.send));
  p.composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

  const panel = h('aside', { class: 'assist', id: 'assist', 'aria-labelledby': 'assist-title', hidden: true },
    h('header', { class: 'assist__head' },
      h('div', { class: 'assist__bar' }, h('h2', { class: 'assist__title', id: 'assist-title', tabindex: '-1' }, icon('sparkle'), 'Assistant'), p.closeBtn),
      h('div', { class: 'assist__bar' }, p.subtitle, h('div', { class: 'assist__head-tools' }, p.chatsBtn, p.newBtn))),
    p.body, p.composer);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) { e.preventDefault(); closeAssistant(); } });
  assist.el = panel;
  assist.parts = p;
  return panel;
}

function autoGrow() {
  const input = assist.parts.input;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, 168)}px`;
}

/* --- Open, close, and the phone's full-screen sheet --- */
function setInert(on) {
  for (const el of $$('#app > .topbar, #app > .frame, #app > .bottomnav')) {
    if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
  }
}
phoneLayout.addEventListener('change', () => { if (assist.el && !assist.el.hidden) setInert(phoneLayout.matches); });

function openAssistant() {
  if (!assist.el) return;
  if (assist.el.hidden) {
    assist.opener = document.activeElement;
    assist.el.hidden = false;
    $('#app')?.classList.add('assist-open');
    $('#assist-toggle')?.setAttribute('aria-expanded', 'true');
    setInert(phoneLayout.matches);
  }
  if (!assist.ready) initAssistant(); else focusComposer({ opening: true });
}

function closeAssistant() {
  if (!assist.el || assist.el.hidden) return;
  stopDictation();
  assist.el.hidden = true;
  $('#app')?.classList.remove('assist-open');
  $('#assist-toggle')?.setAttribute('aria-expanded', 'false');
  setInert(false);
  const back = assist.opener?.isConnected && !assist.opener.closest('.assist, dialog') ? assist.opener : $('#assist-toggle');
  back?.focus();
}

const toggleAssistant = () => (assist.el && !assist.el.hidden ? closeAssistant() : openAssistant());

/** Focus the message box; when the panel opens on a phone, its heading instead (so the keyboard does not pop up). */
function focusComposer({ opening = false } = {}) {
  if (opening && phoneLayout.matches) { $('#assist-title')?.focus(); return; }
  if (assist.off || assist.view !== 'chat') return;
  assist.parts.input.focus({ preventScroll: true });
}

/** First open: is the Assistant switched on (501 if not), and which chat to continue. */
async function initAssistant() {
  const p = assist.parts;
  fill(p.log, h('p', { class: 'assist__loading' }, 'Loading…'));
  try {
    const res = await api('/admin/assistant/conversations');
    assist.conversations = res.conversations || [];
    assist.ready = true;
  } catch (err) {
    if (err.status === 501) { assist.ready = true; showOff(); return; }
    fill(p.log, errorBanner(err, () => initAssistant()));
    return;
  }
  const remembered = store.get(CHAT_KEY);
  if (remembered && assist.conversations.some((c) => c.id === remembered)) await openConversation(remembered);
  else showWelcome();
  focusComposer({ opening: true });
}

/** Not switched on yet (no ANTHROPIC_API_KEY on the server): say so, and that everything else works. */
function showOff() {
  assist.off = true;
  const p = assist.parts;
  p.composer.hidden = true;
  p.chatsBtn.hidden = true;
  p.newBtn.hidden = true;
  p.subtitle.textContent = 'Not switched on yet';
  fill(p.log, h('div', { class: 'assist__intro' },
    h('h3', {}, 'The Assistant is not switched on yet'),
    h('p', {}, 'It needs an Anthropic API key on the server. ',
      isManager() ? 'The setup steps are in the back office guide (admin/README.md, “The Assistant”).' : 'Ask an owner or admin to switch it on.'),
    h('p', {}, 'Everything else in the back office works as usual: every change can be made by hand.')));
  p.closeBtn.focus();
}

function showWelcome() {
  const p = assist.parts;
  p.subtitle.textContent = 'New chat';
  fill(p.log, h('div', { class: 'assist__intro' },
    h('h3', {}, 'What should we change?'),
    h('p', {}, 'Tell me in your own words, the way you would tell a manager. I will ask about anything I need, draft the change and show you a preview. ',
      h('strong', {}, 'Nothing goes live until you tap Publish.')),
    h('p', { class: 'assist__try' }, 'For example:'),
    h('ul', { class: 'assist__suggestions', role: 'list' }, SUGGESTIONS.map((text) => h('li', {}, h('button', {
      type: 'button', class: 'assist__suggestion', onclick: () => { p.input.value = text; autoGrow(); p.input.focus(); },
    }, text))))));
}

/* --- Chats: the list, opening one, starting a new one --- */
async function showChats() {
  const p = assist.parts;
  assist.view = 'list';
  p.chatsBtn.setAttribute('aria-pressed', 'true');
  p.log.hidden = true;
  p.composer.hidden = true;
  p.chats.hidden = false;
  fill(p.chats, h('p', { class: 'assist__loading' }, 'Loading your chats…'));
  try {
    assist.conversations = (await api('/admin/assistant/conversations')).conversations || [];
  } catch (err) {
    fill(p.chats, errorBanner(err, () => showChats()));
    return;
  }
  const item = (c) => h('li', {}, h('button', {
    type: 'button', class: 'assist__chat', 'aria-current': assist.conversation?.id === c.id ? 'true' : null,
    onclick: () => { showChat(); openConversation(c.id); },
  }, h('span', { class: 'assist__chat-title' }, c.title || 'New chat'), h('span', { class: 'assist__chat-when' }, timeAgo(c.updated_at || c.created_at))));
  fill(p.chats,
    h('div', { class: 'assist__chats-head' }, h('h3', {}, 'Your chats'), h('button', { type: 'button', class: 'btn btn--primary btn--compact', onclick: () => newChat() }, icon('plus'), 'New chat')),
    assist.conversations.length ? h('ul', { class: 'assist__chat-list', role: 'list' }, assist.conversations.map(item))
      : h('p', { class: 'muted' }, 'No chats yet. Your last 30 chats are kept here.'));
  $('button', p.chats)?.focus();
}

function showChat() {
  const p = assist.parts;
  assist.view = 'chat';
  p.chatsBtn.setAttribute('aria-pressed', 'false');
  p.chats.hidden = true;
  p.log.hidden = false;
  p.composer.hidden = assist.off;
}

function newChat() {
  if (assist.off) return;
  stopDictation();
  showChat();
  assist.conversation = null;
  store.remove(CHAT_KEY);
  showWelcome();
  focusComposer();
}

async function openConversation(id) {
  const p = assist.parts;
  fill(p.log, h('p', { class: 'assist__loading' }, 'Loading the chat…'));
  let res;
  try {
    res = await api(`/admin/assistant/conversations/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.status === 404) { store.remove(CHAT_KEY); newChat(); return; }
    fill(p.log, errorBanner(err, () => openConversation(id)));
    return;
  }
  assist.conversation = res.conversation;
  store.set(CHAT_KEY, id);
  p.subtitle.textContent = res.conversation.title || 'New chat';
  const messages = res.messages || [];
  // A draft revised later in the chat is shown once, at its latest place.
  const lastMention = new Map();
  messages.forEach((m, i) => (m.drafts || []).forEach((d) => lastMention.set(d, i)));
  fill(p.log);
  const pending = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') { p.log.append(userBubble(m.text, m.attachments_count)); return; }
    const bubble = assistantBubble();
    (m.tools || []).forEach((label) => bubble.tool(label, true));
    bubble.setText(m.text || '');
    (m.drafts || []).filter((d) => lastMention.get(d) === i).forEach((d) => {
      const slot = h('div', { class: 'draft draft--loading', dataset: { draft: d } }, h('p', { class: 'muted small' }, 'Loading the draft…'));
      bubble.drafts.append(slot);
      pending.push([d, slot]);
    });
    p.log.append(bubble.el);
  });
  if (!messages.length) showWelcome();
  scrollLog();
  // A reply still being written (on another device, or before this page was reloaded): wait for it before Send.
  if (res.conversation.busy && !assist.busy) followRunningTurn(id);
  await Promise.all(pending.map(async ([draftId, slot]) => {
    try {
      const cs = (await api(`/admin/change-sets/${encodeURIComponent(draftId)}`)).change_set;
      slot.replaceWith(draftCard(cs));
    } catch {
      fill(slot, h('p', { class: 'muted small' }, 'This draft is no longer available.'));
    }
  }));
}

/* --- Messages --- */
/** Plain text with web links made clickable, built as nodes (never as HTML). */
function linkedText(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)'”’]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(text.slice(last, m.index), h('a', { href: m[0], target: '_blank', rel: 'noopener' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function userBubble(text, photos = 0) {
  return h('div', { class: 'msg msg--user' },
    h('p', { class: 'visually-hidden' }, 'You:'),
    text ? h('div', { class: 'msg__text' }, text) : null,
    photos ? h('p', { class: 'msg__meta' }, icon('camera'), photos === 1 ? '1 photo' : `${photos} photos`) : null);
}

/** An Assistant reply: progress lines for the steps it takes, the text as it streams in, then any draft cards. */
function assistantBubble() {
  const tools = h('ul', { class: 'msg__tools', role: 'list' });
  const text = h('div', { class: 'msg__text', hidden: true });
  const drafts = h('div', { class: 'msg__drafts' });
  const el = h('div', { class: 'msg msg--assistant' }, h('p', { class: 'visually-hidden' }, 'Assistant:'), tools, text, drafts);
  let words = '';
  let frame = 0;
  let waiting = null; // the "Thinking…" line, until the first word or step arrives
  const paint = () => { frame = 0; text.hidden = !words; fill(text, linkedText(words)); };
  const settle = () => {
    waiting?.remove();
    waiting = null;
    $$('.msg__tool:not(.is-done)', tools).forEach((li) => { li.classList.add('is-done'); fill(li, icon('check'), $('.msg__tool-label', li)); });
  };
  return {
    el, drafts,
    /** A line with a spinner while there is nothing else to show yet; the next word or step replaces it. */
    thinking(label) {
      if (waiting) { $('.msg__tool-label', waiting).textContent = label; return; }
      waiting = h('li', { class: 'msg__tool msg__tool--thinking' }, h('span', { class: 'msg__spinner', 'aria-hidden': 'true' }), h('span', { class: 'msg__tool-label' }, label));
      tools.append(waiting);
    },
    get isThinking() { return Boolean(waiting); },
    tool(label, done = false) {
      settle();
      tools.append(h('li', { class: `msg__tool${done ? ' is-done' : ''}` }, done ? icon('check') : h('span', { class: 'msg__spinner', 'aria-hidden': 'true' }), h('span', { class: 'msg__tool-label' }, label)));
    },
    addText(delta) {
      settle();
      words += delta;
      if (!frame) frame = requestAnimationFrame(paint);
    },
    setText(value) { words = value; paint(); },
    draft(cs) {
      // The same draft revised: the old card goes, the new one shows here.
      $$(`.draft[data-draft="${CSS.escape(cs.id)}"]`, assist.parts.log).forEach((old) => old.remove());
      drafts.append(draftCard(cs));
    },
    finish() { settle(); if (frame) { cancelAnimationFrame(frame); paint(); } },
    fail(message, action) {
      this.finish();
      el.append(h('div', { class: 'msg__error', role: 'alert' }, icon('alert'), h('p', {}, message), action || null));
    },
  };
}

function scrollLog() {
  const log = assist.parts.log;
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

/** A chat error with what to do next: start a new chat when this one is too long or the limit is hit. */
function chatErrorAction(code) {
  if (code === 'conversation_too_long' || code === 'too_many_images') {
    return h('button', { type: 'button', class: 'btn btn--secondary btn--compact', onclick: () => newChat() }, icon('plus'), 'Start a new chat');
  }
  return null;
}

/* --- Sending, and reading the reply as it streams --- */
function syncComposer() {
  const p = assist.parts;
  p.send.disabled = assist.busy;
  p.send.classList.toggle('is-loading', assist.busy);
  p.send.setAttribute('aria-label', assist.busy ? 'Waiting for the reply' : 'Send');
  p.log.setAttribute('aria-busy', String(assist.busy));
  p.newBtn.disabled = assist.busy;
  p.chatsBtn.disabled = assist.busy;
  if (!assist.recognition) p.status.textContent = assist.busy ? 'The Assistant is replying…' : '';
}

/**
 * POST to an Assistant route and read the text/event-stream answer: event: text { delta } | tool { label } |
 * draft { change_set } | done | error { error, code }. Throws ApiError when the request itself is refused (it then
 * started nothing). Resolves true when the stream ended with done or error, false when it was cut off.
 */
async function streamTurn(path, body, on) {
  const headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
  const token = store.get(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'network');
  }
  if (!res.ok || !/text\/event-stream/.test(res.headers.get('Content-Type') || '')) {
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 && token) signOut({ expired: true });
    // The Assistant's own refusals (daily limit, long chat, photo problems) are already plain English.
    const message = typeof data?.error === 'string' && res.status !== 401 && res.status < 500 ? data.error : friendlyMessage(res.status, data);
    throw new ApiError(message, res.status, data?.code, data);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const dispatch = (chunk) => {
    let event = 'message';
    const data = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue; // keep-alive comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let payload;
    try { payload = JSON.parse(data.join('\n')); } catch { return; }
    if (event === 'done' || event === 'error') ended = true;
    on[event]?.(payload);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      for (let cut = buffer.indexOf('\n\n'); cut > -1; cut = buffer.indexOf('\n\n')) {
        dispatch(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } catch { /* the connection dropped: reported as a cut-off reply below */ }
  return ended;
}

/** Send works again; a Publish tapped while a reply was streaming gets its follow-up now. */
function endBusy() {
  assist.busy = false;
  syncComposer();
  scrollLog();
  const next = assist.pending.shift();
  if (next) reportPublished(next);
}

/** Asks every few seconds whether the chat's turn has finished on the server. → true when it has, false on giving up. */
async function waitForTurn(id) {
  const until = Date.now() + TURN_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => { setTimeout(resolve, TURN_POLL_MS); });
    if (assist.conversation?.id !== id) return false;
    try {
      const res = await api(`/admin/assistant/conversations/${encodeURIComponent(id)}`);
      if (!res.conversation?.busy) return true;
    } catch (err) {
      if (err.status === 401 || err.status === 404) return false;
    }
  }
  return false;
}

/**
 * The reply stopped part-way (the phone locked, the network dropped), but the server finishes the turn anyway. Send
 * stays off until it has, because a new message now would start a second reply on the same chat; then the chat is
 * shown again from the server, with the words and draft cards that came after the cut.
 */
async function afterCutOff(bubble, id, label = 'The connection dropped, but the Assistant is still working on this. The chat updates when it is done.') {
  bubble.thinking(label);
  scrollLog();
  const finished = await waitForTurn(id);
  if (assist.conversation?.id !== id) return;
  if (finished) { await openConversation(id); return; }
  bubble.fail('The Assistant is taking longer than usual. Open this chat again from Chats in a minute to see the reply.');
}

/** A turn of this chat is already running (started on another device, or before a reload): wait for it, then show it. */
async function followRunningTurn(id) {
  assist.busy = true;
  syncComposer();
  const bubble = assistantBubble();
  assist.parts.log.append(bubble.el);
  try {
    await afterCutOff(bubble, id, 'The Assistant is still working on the last message. The chat updates when it is done.');
  } finally {
    endBusy();
  }
}

/** Runs one Assistant turn into a new reply bubble. onRefused(err) runs when the server refused before starting. */
async function runTurn(path, body, { onRefused, thinking = 'Thinking about your request…' } = {}) {
  const p = assist.parts;
  const bubble = assistantBubble();
  bubble.thinking(thinking); // Claude can think for a while before its first word
  p.log.append(bubble.el);
  scrollLog();
  assist.busy = true;
  syncComposer();
  const id = assist.conversation?.id;
  const slow = setTimeout(() => { if (bubble.isThinking) bubble.thinking('Still working. Bigger changes can take up to a minute.'); }, THINKING_SLOW_MS);
  const heard = (fn) => (d) => { clearTimeout(slow); fn(d); };
  try {
    const ended = await streamTurn(path, body, {
      text: heard((d) => { bubble.addText(String(d.delta || '')); scrollLog(); }),
      tool: heard((d) => { bubble.tool(d.label || 'Working…'); scrollLog(); }),
      draft: heard((d) => { if (d.change_set) { bubble.draft(d.change_set); scrollLog(); } }),
      done: heard(() => bubble.finish()),
      error: heard((d) => bubble.fail(d.error || 'Something went wrong. Please try again.', chatErrorAction(d.code))),
    });
    clearTimeout(slow);
    if (!ended) await afterCutOff(bubble, id);
  } catch (err) {
    bubble.el.remove();
    if (err.status === 501) { showOff(); return; }
    onRefused?.(err);
    const note = assistantBubble();
    note.fail(err.message, chatErrorAction(err.code));
    p.log.append(note.el);
  } finally {
    clearTimeout(slow);
    endBusy();
  }
}

async function sendMessage() {
  const p = assist.parts;
  if (assist.busy || assist.off) return;
  const text = p.input.value.trim();
  const photos = assist.photos.slice();
  if (!text && !photos.length) { p.status.textContent = 'Type a message, or add a photo.'; p.input.focus(); return; }
  stopDictation();
  if (assist.view !== 'chat') showChat();
  if (!assist.conversation) {
    assist.busy = true;
    syncComposer();
    try {
      const res = await api('/admin/assistant/conversations', { method: 'POST', body: { business_slug: state.slug || null } });
      assist.conversation = res.conversation;
      store.set(CHAT_KEY, res.conversation.id);
      fill(p.log); // the welcome text goes
    } catch (err) {
      assist.busy = false;
      syncComposer();
      if (err.status === 501) { showOff(); return; }
      p.status.textContent = err.message;
      return;
    }
    assist.busy = false;
  }
  if (!p.subtitle.textContent || p.subtitle.textContent === 'New chat') p.subtitle.textContent = (text || 'Photo').slice(0, 80);
  const mine = userBubble(text, photos.length);
  p.log.append(mine);
  p.input.value = '';
  autoGrow();
  assist.photos = [];
  renderAttachments();
  await runTurn(`/admin/assistant/conversations/${encodeURIComponent(assist.conversation.id)}/messages`, {
    text, images: photos.map(({ media_type, data_base64 }) => ({ media_type, data_base64 })),
  }, {
    // Refused before anything was saved (daily limit, long chat): put the words and photos back, so nothing is lost.
    onRefused: () => {
      mine.remove();
      if (!p.input.value) { p.input.value = text; autoGrow(); }
      assist.photos = [...photos, ...assist.photos].slice(0, CHAT_MAX_PHOTOS);
      renderAttachments();
    },
  });
  if (!assist.busy) focusComposer();
}

/* --- Photos for the Assistant to read (menu boards, flyers, labels): JPEG, at most 1600 px --- */
async function chatPhoto(file) {
  const decoded = await decodePhoto(file);
  try {
    for (let maxPx = CHAT_PHOTO_PX, quality = 0.85; maxPx >= 500; maxPx = Math.round(maxPx * 0.75), quality = Math.max(0.6, quality - 0.1)) {
      const scale = Math.min(1, maxPx / Math.max(decoded.width, decoded.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // JPEG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality);
      canvas.width = 0;
      const data = url.slice(url.indexOf(',') + 1);
      if (data.length * 0.75 <= CHAT_PHOTO_BYTES) return { media_type: 'image/jpeg', data_base64: data, preview: url };
    }
  } finally {
    decoded.release();
  }
  throw new PhotoError('This photo is too big to send. Please try another one.');
}

async function attachPhotos(files) {
  const p = assist.parts;
  const room = CHAT_MAX_PHOTOS - assist.photos.length;
  if (room <= 0) { p.status.textContent = `You can send up to ${CHAT_MAX_PHOTOS} photos at a time.`; return; }
  p.status.textContent = 'Getting the photo ready…';
  for (const file of files.slice(0, room)) {
    try {
      assist.photos.push(await chatPhoto(file));
    } catch (err) {
      p.status.textContent = err.message;
      renderAttachments();
      return;
    }
  }
  p.status.textContent = files.length > room ? `Only ${CHAT_MAX_PHOTOS} photos fit in one message; the rest were left out.` : '';
  renderAttachments();
  p.input.focus();
}

function renderAttachments() {
  const p = assist.parts;
  fill(p.attachments, assist.photos.map((photo, i) => h('li', { class: 'assist__attachment' },
    h('img', { src: photo.preview, alt: `Photo ${i + 1} to send` }),
    h('button', { type: 'button', class: 'assist__attachment-remove', 'aria-label': `Remove photo ${i + 1}`, onclick: () => { assist.photos.splice(i, 1); renderAttachments(); p.input.focus(); } }, icon('close')))));
  p.attachments.hidden = !assist.photos.length;
}

/* --- Speaking instead of typing (where the browser can turn speech into text) --- */
function toggleDictation() {
  const p = assist.parts;
  if (assist.recognition) { assist.recognition.stop(); return; }
  const rec = new Recognition();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  const before = p.input.value ? `${p.input.value.replace(/\s+$/, '')} ` : '';
  rec.onresult = (e) => {
    let said = '';
    for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
    p.input.value = (before + said).slice(0, CHAT_MAX_TEXT);
    autoGrow();
  };
  rec.onerror = (e) => {
    p.status.textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'The microphone is blocked. Allow it in the browser’s settings, or type instead.'
      : e.error === 'no-speech' ? 'I didn’t hear anything. Tap the microphone and try again.' : 'Speaking stopped. You can type instead.';
  };
  rec.onend = () => {
    assist.recognition = null;
    p.mic.setAttribute('aria-pressed', 'false');
    p.mic.classList.remove('is-listening');
    if (p.status.textContent === 'Listening… speak now, then tap the microphone again.') p.status.textContent = '';
    p.input.focus();
  };
  try { rec.start(); } catch { p.status.textContent = 'The microphone could not start. You can type instead.'; return; }
  assist.recognition = rec;
  p.mic.setAttribute('aria-pressed', 'true');
  p.mic.classList.add('is-listening');
  p.status.textContent = 'Listening… speak now, then tap the microphone again.';
}

function stopDictation() {
  if (assist.recognition) { try { assist.recognition.abort(); } catch { /* already stopped */ } }
}

/* --- The draft card: before → after, checks, previews, Publish / Discard, then the live check and Undo all --- */
/** The card for one draft; `level` is its title's heading level (3 in the chat, 2 on the draft page). */
function draftCard(cs, { level = 3 } = {}) {
  const card = h('article', { class: 'draft', dataset: { draft: cs.id, level: String(level) } });
  renderDraft(card, cs);
  return card;
}

function changeLine(l) {
  const has = (v) => v != null && v !== '';
  return h('li', { class: 'draft__line' },
    h('p', { class: 'draft__what' }, l.line),
    has(l.before) || has(l.after) ? h('p', { class: 'draft__change' },
      has(l.before) ? h('span', { class: 'draft__before' }, srOnly('Before: '), h('s', {}, String(l.before))) : h('span', { class: 'draft__before is-none' }, 'New'),
      h('span', { class: 'draft__arrow', 'aria-hidden': 'true' }, ' → '),
      has(l.after) ? h('span', { class: 'draft__after' }, srOnly(has(l.before) ? ' After: ' : ': '), String(l.after)) : h('span', { class: 'draft__after is-none' }, srOnly(' After: '), 'Removed')) : null);
}

function renderDraft(card, cs, { error = '', focus = false } = {}) {
  assist.drafts.set(cs.id, cs);
  const titleId = `draft-title-${cs.id}`;
  card.setAttribute('aria-labelledby', titleId);
  card.className = `draft draft--${cs.status}`;
  const n = (cs.ops || []).length;
  const checks = cs.checks || [];
  const blocking = checks.filter((c) => c.level === 'block');
  const previews = cs.preview_urls || [];
  const multi = new Set(previews.map((u) => u.business_slug)).size > 1;
  const nameOf = (slug) => state.businesses.find((b) => b.slug === slug)?.short_name || state.businesses.find((b) => b.slug === slug)?.name || slug;
  const level = Number(card.dataset.level) || 3;

  // Before → after, grouped by business.
  const groups = new Map();
  for (const line of cs.summary || []) {
    const key = line.business_slug ?? '*';
    if (!groups.has(key)) groups.set(key, { name: line.business_name || (key === '*' ? 'Every business' : nameOf(key)), lines: [] });
    groups.get(key).lines.push(line);
  }
  const summary = h('div', { class: 'draft__summary' }, [...groups.values()].map((g) => h('section', { class: 'draft__group' },
    h(`h${level + 1}`, { class: 'draft__biz' }, g.name),
    h('ul', { class: 'draft__lines', role: 'list' }, g.lines.map(changeLine)))));

  const checkList = checks.length ? h('ul', { class: 'draft__checks', role: 'list', 'aria-label': 'Checks' }, checks.map((c) => {
    const level = CHECK_LEVELS[c.level] || CHECK_LEVELS.warn;
    return h('li', { class: `draft-check draft-check--${c.level}` }, icon(level.icon), h('p', {}, h('strong', {}, `${level.word}: `), c.message));
  })) : null;

  const parts = [
    h('div', { class: 'draft__head' },
      h('p', { class: `draft__status draft__status--${cs.status}` }, DRAFT_STATUS[cs.status] || cs.status),
      h(`h${level}`, { class: 'draft__title', id: titleId, tabindex: '-1' }, cs.title),
      h('p', { class: 'draft__count' }, plural(n, 'change'))),
    summary,
  ];

  if (cs.status === 'draft') {
    const websites = previews.filter((u) => u.label !== 'TV screen');
    const firstLink = workerUrl((websites[0] || previews[0])?.url || '/');
    const copyBtn = h('button', { type: 'button', class: 'btn btn--quiet btn--compact' }, icon('copy'), 'Copy preview link');
    copyBtn.addEventListener('click', async () => {
      const text = websites.length > 1 ? websites.map((u) => `${u.label}: ${workerUrl(u.url)}`).join('\n') : firstLink;
      if (await copyText(text)) { flashSaved(copyBtn, 'Copied'); toast('Preview link copied. It works for 48 hours, until the draft is published or discarded.'); } else toast(firstLink, { kind: 'error', ms: 12000 });
    });
    const shareBtn = navigator.share ? h('button', { type: 'button', class: 'btn btn--quiet btn--compact' }, icon('share'), 'Share') : null;
    shareBtn?.addEventListener('click', async () => {
      try { await navigator.share({ title: `Preview: ${cs.title}`, text: `How the website will look after “${cs.title}” (not live yet).`, url: firstLink }); } catch { /* closed the share sheet */ }
    });
    const publishNoteId = `publish-note-${cs.id}`;
    const publish = h('button', { type: 'button', class: 'btn btn--primary', disabled: blocking.length > 0, 'aria-describedby': blocking.length ? publishNoteId : null }, n === 1 ? 'Publish' : `Publish ${n} changes`);
    const discard = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Discard');
    publish.addEventListener('click', () => publishDraft(card, cs, publish));
    discard.addEventListener('click', () => discardDraft(card, cs, discard));
    parts.push(checkList,
      previews.length ? h('div', { class: 'draft__previews' },
        h('p', { class: 'draft__label' }, 'See it before it goes live'),
        h('div', { class: 'draft__preview-links' }, previews.map((u) => h('a', { class: 'btn btn--secondary btn--compact', href: workerUrl(u.url), target: '_blank', rel: 'noopener' },
          icon(u.label === 'TV screen' ? 'tv' : 'external'),
          u.label === 'TV screen' ? `TV screen${multi ? ` (${nameOf(u.business_slug)})` : ''}` : `Preview the ${u.label}`,
          srOnly(' (opens in a new tab)')))),
        h('div', { class: 'draft__share' }, copyBtn, shareBtn)) : null,
      blocking.length ? h('p', { class: 'draft__blocked', id: publishNoteId }, 'Publish is off until the “Must fix” item is fixed. Tell the Assistant what to change.') : null,
      h('p', { class: 'draft__note' }, `Nothing is live yet. It goes live only when you tap Publish. This draft expires ${fmtDateTime(cs.expires_at)}.`),
      h('div', { class: 'draft__actions' }, publish, discard));
  } else if (cs.status === 'published') {
    const result = assist.verify.get(cs.id);
    const undo = h('button', { type: 'button', class: 'btn btn--secondary' }, n === 1 ? 'Undo' : 'Undo all');
    undo.addEventListener('click', () => undoDraft(card, cs, undo));
    parts.push(
      h('p', { class: 'draft__note' }, `Published ${fmtDateTime(cs.published_at)}. ${LIVE_SOON}`),
      // A Claude app draft has no chat here to report back in; Claude checks the live website when told.
      cs.source === 'mcp' ? h('p', { class: 'draft__note' }, 'Made in the Claude app: tell Claude you published it, and it checks the live website for you.') : null,
      result === 'checking' ? h('p', { class: 'draft__note', role: 'status' }, 'Checking the live website…')
        : result?.lines ? h('div', { class: 'draft__verify', role: 'status' },
          h('p', { class: 'draft__label' }, result.ok ? 'Checked: it is all live.' : 'Checked: something is not showing yet.'),
          h('ul', { class: 'draft__checks', role: 'list' }, result.lines.map((l) => h('li', { class: `draft-check draft-check--${l.ok ? 'ok' : 'block'}` },
            icon(l.ok ? 'check' : 'alert'), h('p', {}, h('strong', {}, `${l.ok ? 'Live' : 'Not yet'}: `), l.line, l.detail ? h('span', { class: 'draft-check__detail' }, ` ${l.detail}`) : null)))))
          : null,
      h('div', { class: 'draft__actions' }, undo));
  } else {
    const words = {
      undone: 'These changes were undone: everything went back to how it was.',
      discarded: 'Discarded. Nothing was changed.',
      expired: 'This draft expired (drafts last 48 hours). Ask the Assistant to draft it again.',
      failed: cs.error ? `${cs.error}` : 'This draft could not be published. Nothing was changed.',
    };
    parts.push(h('p', { class: 'draft__note' }, words[cs.status] || ''));
  }
  parts.push(error ? h('p', { class: 'draft__error', role: 'alert' }, error) : null);
  fill(card, parts);
  if (focus) $('.draft__title', card).focus();
}

/** After a failed action the draft may have changed (expired, already published): show it fresh, with the reason. */
async function reloadDraft(card, cs, message) {
  try {
    const fresh = (await api(`/admin/change-sets/${encodeURIComponent(cs.id)}`)).change_set;
    renderDraft(card, fresh, { error: message, focus: true });
  } catch {
    renderDraft(card, cs, { error: message, focus: true });
  }
}

async function publishDraft(card, cs, button) {
  const n = (cs.ops || []).length;
  const ok = await confirmDialog({
    title: n === 1 ? 'Publish this change?' : `Publish these ${n} changes?`,
    text: `“${cs.title}” goes live. ${LIVE_SOON} You can undo it afterwards.`,
    confirmLabel: 'Publish', danger: false,
  });
  if (!ok) { button.focus(); return; }
  await withBusy(button, async () => {
    try {
      // The version on this card: a draft the Assistant changed since it was shown is refused (409), and shown again.
      const res = await api(`/admin/change-sets/${encodeURIComponent(cs.id)}/publish`, { method: 'POST', body: { version: cs.version } });
      assist.verify.set(cs.id, 'checking');
      renderDraft(card, res.change_set, { focus: true });
      toast(`Published. ${LIVE_SOON}`);
      checkLive(card, res.change_set);
      reportPublished(res.change_set);
    } catch (err) {
      await reloadDraft(card, cs, err.message);
    }
  });
}

/** The live check, straight from the server (the Assistant also reports it in words). */
async function checkLive(card, cs) {
  try {
    assist.verify.set(cs.id, await api(`/admin/change-sets/${encodeURIComponent(cs.id)}/verify`));
  } catch {
    assist.verify.delete(cs.id);
  }
  if (card.isConnected && assist.drafts.get(cs.id)?.status === 'published') renderDraft(card, assist.drafts.get(cs.id));
}

/** Tell the chat it was published, so the Assistant checks the live website and says what is now live. */
function reportPublished(cs) {
  if (!cs.conversation_id || assist.conversation?.id !== cs.conversation_id || assist.off) return;
  if (assist.busy) { assist.pending.push(cs); return; }
  if (assist.view !== 'chat') showChat();
  runTurn(`/admin/assistant/conversations/${encodeURIComponent(cs.conversation_id)}/published`, { change_set_id: cs.id }, { thinking: 'Getting ready to check the live website…' });
}

async function discardDraft(card, cs, button) {
  const ok = await confirmDialog({ title: 'Discard this draft?', text: 'Nothing on the website changes. You can ask the Assistant for it again.', confirmLabel: 'Discard' });
  if (!ok) { button.focus(); return; }
  await withBusy(button, async () => {
    try {
      const res = await api(`/admin/change-sets/${encodeURIComponent(cs.id)}/discard`, { method: 'POST' });
      renderDraft(card, res.change_set, { focus: true });
      toast('Draft discarded.');
    } catch (err) { await reloadDraft(card, cs, err.message); }
  });
}

async function undoDraft(card, cs, button) {
  const n = (cs.ops || []).length;
  const ok = await confirmDialog({
    title: n === 1 ? 'Undo this change?' : `Undo all ${n} changes?`,
    text: `Everything goes back to how it was before you published. ${LIVE_SOON}`,
    confirmLabel: n === 1 ? 'Undo' : 'Undo all',
  });
  if (!ok) { button.focus(); return; }
  await withBusy(button, async () => {
    try {
      const res = await api(`/admin/change-sets/${encodeURIComponent(cs.id)}/undo`, { method: 'POST' });
      assist.verify.delete(cs.id);
      renderDraft(card, res.change_set, { focus: true });
      toast('Undone. The websites go back within a minute, the TV screens within a minute or two.');
    } catch (err) { await reloadDraft(card, cs, err.message); }
  });
}

/**
 * #/draft/<id>: one draft on a page of its own, with the same card as in the chat. The Claude app sends people here to
 * publish (it cannot publish itself), and a photo used by a draft links here.
 */
async function screenDraft(main, { sub }) {
  const title = 'Review a draft';
  if (!sub) { fill(main, pageHead({ title }), emptyState('No draft chosen', 'Open the link the Assistant or the Claude app gave you.')); return; }
  let cs;
  try {
    cs = (await api(`/admin/change-sets/${encodeURIComponent(sub)}`)).change_set;
  } catch (err) {
    if (err.status !== 404) throw err;
    fill(main, pageHead({ title }), emptyState('This draft was not found',
      'The link may be wrong, or the draft belongs to someone else. The person who made it, or an owner or admin, can open it.'));
    return;
  }
  const from = cs.source === 'mcp' ? 'the Claude app' : 'the Assistant';
  fill(main,
    pageHead({ title, lead: `A draft made in ${from}. Check the changes and the preview. Nothing is live until you tap Publish.` }),
    h('div', { class: 'draft-page' }, draftCard(cs, { level: 2 })));
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
