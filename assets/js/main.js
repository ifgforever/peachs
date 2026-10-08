// Peach's on 47th: site behaviour (no build step, ES module).
import { MENU_SECTIONS, DIETARY, FINE_PRINT, formatPrice } from './menu-data.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');

/* -------------------------------------------------------------------------
   Hero scroll progress + 3D mount
   p = clamp((scrollY - hero top) / (hero height - viewport height), 0, 1)
   ------------------------------------------------------------------------- */
const hero = $('#hero');
const header = $('[data-header]');
let heroTop = 0;
let heroHeight = 0;
let heroRange = 0;
let progress = 0;
let lastP = -1;

/** Current hero scroll progress, 0..1. Read by hero.js every frame. */
export const getProgress = () => progress;

function measure() {
  if (!hero) return;
  heroTop = hero.getBoundingClientRect().top + window.scrollY; // == hero.offsetTop (no positioned ancestors)
  heroHeight = hero.offsetHeight;
  heroRange = heroHeight - window.innerHeight;
  onScroll();
}

function onScroll() {
  const y = window.scrollY;
  if (hero) {
    // When the hero is not pinned (reduced motion / fallback: 100svh, range ~ 0) it
    // shows the finished stack, so progress is 1.
    progress = heroRange > 1 ? clamp((y - heroTop) / heroRange, 0, 1) : 1;
    if (Math.abs(progress - lastP) > 0.0005) {
      hero.style.setProperty('--hero-p', progress.toFixed(4));
      lastP = progress;
    }
  }
  if (header) {
    const headerH = header.offsetHeight;
    const pastHero = hero ? y > heroTop + heroHeight - headerH - 1 : y > 10;
    header.classList.toggle('is-solid', pastHero);
  }
}

let ticking = false;
window.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; onScroll(); });
}, { passive: true });
window.addEventListener('resize', measure, { passive: true });
if ('ResizeObserver' in window) {
  // Catches late layout shifts (web fonts, images, menu re-renders, fallback class).
  new ResizeObserver(() => measure()).observe(document.body);
}
measure();

async function initHero() {
  if (!hero) { window.__heroReady = true; return; }
  const stageEl = $('.hero__stage', hero);
  try {
    const { mountHero } = await import('./hero.js');
    window.__hero = await mountHero(stageEl, { getProgress, reducedMotion: reduced }); // handle kept for demo recording
    if (reduced) addPlayButton(mountHero, stageEl);
  } catch (e) {
    hero.classList.add('hero--fallback');
    console.info('Hero fallback:', e && e.message);
  } finally {
    measure();
    window.__heroReady = true;
  }
}
initHero();

// Visitors with "Reduce Motion" on see the finished stack; this lets them opt in to the animation.
function addPlayButton(mountHero, stageEl) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hero__play';
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z"/></svg>Play the animation';
  btn.addEventListener('click', async () => {
    btn.remove();
    window.__hero?.destroy();
    hero.classList.add('hero--motion');
    measure();
    window.scrollTo({ top: heroTop, behavior: 'auto' });
    window.__hero = await mountHero(stageEl, { getProgress, reducedMotion: false });
    measure();
  });
  $('.hero__sticky', hero).appendChild(btn);
}

/* -------------------------------------------------------------------------
   Open / closed status (America/Chicago), hours table "today"
   ------------------------------------------------------------------------- */
const HOURS = { open: 8 * 60, close: 14 * 60, days: [3, 4, 5, 6, 0] }; // Wed–Sun 8:00–14:00
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const chicagoFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function chicagoNow(date = new Date()) {
  const parts = chicagoFmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: DAY_SHORT.indexOf(get('weekday')), minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

export function openStatus({ day, minutes }) {
  const openToday = HOURS.days.includes(day);
  if (openToday && minutes >= HOURS.open && minutes < HOURS.close) {
    return { open: true, text: 'Open now · until 2pm' };
  }
  if (openToday && minutes < HOURS.open) return { open: false, text: 'Closed · opens today 8am' };
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    if (HOURS.days.includes(d)) return { open: false, text: `Closed · opens ${DAY_SHORT[d]} 8am` };
  }
  return { open: false, text: 'Closed' };
}

function renderStatus() {
  const now = chicagoNow();
  const status = openStatus(now);
  const el = $('[data-open-status]');
  if (el) {
    el.classList.toggle('is-open', status.open);
    $('[data-open-text]', el).textContent = status.text;
  }
  $$('[data-hours] tr').forEach((row) => {
    const d = Number(row.dataset.day);
    const isToday = d === now.day;
    row.classList.toggle('is-today', isToday);
    row.classList.toggle('is-closed', !HOURS.days.includes(d));
    if (isToday) row.setAttribute('aria-current', 'date'); else row.removeAttribute('aria-current');
  });
}
renderStatus();
setInterval(renderStatus, 60 * 1000);

/* -------------------------------------------------------------------------
   Mobile navigation
   ------------------------------------------------------------------------- */
const navToggle = $('[data-nav-toggle]');
const navMenu = $('[data-nav-menu]');
const mobileNav = matchMedia('(max-width: 899px)');

function setNav(open, { focusToggle = false } = {}) {
  if (!navToggle || !header) return;
  navToggle.setAttribute('aria-expanded', String(open));
  header.classList.toggle('is-open', open);
  if (open) {
    $('a', navMenu)?.focus();
  } else if (focusToggle) {
    navToggle.focus();
  }
}
navToggle?.addEventListener('click', () => setNav(navToggle.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && header?.classList.contains('is-open')) setNav(false, { focusToggle: true });
});
navMenu?.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
document.addEventListener('click', (e) => {
  if (header?.classList.contains('is-open') && !header.contains(e.target)) setNav(false);
});
// Keep focus inside the open mobile menu: tabbing past the last link closes it.
navMenu?.addEventListener('focusout', (e) => {
  if (header?.classList.contains('is-open') && mobileNav.matches && !header.contains(e.relatedTarget)) setNav(false);
});
mobileNav.addEventListener('change', () => setNav(false));

/* -------------------------------------------------------------------------
   In-page anchors: smooth scroll (JS only, so programmatic scrolls stay instant)
   ------------------------------------------------------------------------- */
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="#"]');
  if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const id = link.getAttribute('href').slice(1);
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  e.preventDefault();
  if (id === 'top') {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  } else {
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    // Move focus for keyboard and screen reader users without a second jump.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
  history.replaceState(null, '', `#${id}`);
});

/* -------------------------------------------------------------------------
   Active nav link
   ------------------------------------------------------------------------- */
const navLinks = $$('[data-nav-link]');
if ('IntersectionObserver' in window && navLinks.length) {
  const byId = new Map(navLinks.map((a) => [a.getAttribute('href').slice(1), a]));
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const link = byId.get(entry.target.id);
      if (!link) return;
      if (entry.isIntersecting) {
        navLinks.forEach((a) => a.classList.toggle('is-active', a === link));
      } else if (link.classList.contains('is-active')) {
        link.classList.remove('is-active');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  byId.forEach((_, id) => { const el = document.getElementById(id); if (el) spy.observe(el); });
}

/* -------------------------------------------------------------------------
   Marquee pause control
   ------------------------------------------------------------------------- */
const marquee = $('.marquee');
const marqueeToggle = $('[data-marquee-toggle]');
marqueeToggle?.addEventListener('click', () => {
  const paused = marqueeToggle.getAttribute('aria-pressed') !== 'true';
  marqueeToggle.setAttribute('aria-pressed', String(paused));
  $('.visually-hidden', marqueeToggle).textContent = paused ? 'Play the dish ticker' : 'Pause the dish ticker';
  marquee.classList.toggle('is-paused', paused);
});

/* -------------------------------------------------------------------------
   Reveal on scroll
   ------------------------------------------------------------------------- */
if (!reduced && 'IntersectionObserver' in window) {
  const items = $$('[data-reveal]');
  // Stagger siblings that share a parent.
  const groups = new Map();
  items.forEach((el) => {
    const list = groups.get(el.parentElement) || [];
    list.push(el);
    groups.set(el.parentElement, list);
  });
  groups.forEach((list) => list.forEach((el, i) => el.style.setProperty('--reveal-delay', `${Math.min(i, 5) * 80}ms`)));

  document.documentElement.classList.add('reveal-on');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
  items.forEach((el) => io.observe(el));
}

/* -------------------------------------------------------------------------
   Full menu: tabs + dietary filters
   ------------------------------------------------------------------------- */
const tablist = $('[data-menu-tabs]');
const panel = $('[data-menu-panel]');
const statusEl = $('[data-menu-status]');
const chips = $$('[data-filter]');
const STAR = '<svg class="icon" aria-hidden="true"><use href="#i-star"/></svg>';
const state = { index: 0, filter: 'all' };

const matches = (item) => state.filter === 'all' || (item.tags || []).includes(state.filter);
const filterLabel = () => (state.filter === 'all' ? '' : DIETARY[state.filter].toLowerCase());

function renderPrice(item) {
  if (item.prices) {
    const sizes = item.prices.map((p) => `<div><dt>${esc(p.label)}</dt><dd>${formatPrice(p.value)}</dd></div>`).join('');
    return `<dl class="mi__sizes" aria-label="Prices by size">${sizes}</dl>`;
  }
  return `<p class="mi__price">${formatPrice(item.price)}</p>`;
}

function renderItem(item) {
  const portion = item.portion ? ` <span class="mi__portion">${esc(item.portion)}</span>` : '';
  const star = item.star ? `${STAR}<span class="visually-hidden"> (starred on our menu)</span>` : '';
  const desc = item.desc ? `<p class="mi__desc">${esc(item.desc)}</p>` : '';
  const tags = item.tags?.length
    ? `<p class="mi__tags">${item.tags.map((t) => `<abbr class="tag" title="${esc(DIETARY[t])}">${esc(t)}</abbr>`).join('')}</p>`
    : '';
  return `<li class="mi">
    <div class="mi__head">
      <h4 class="mi__name">${esc(item.name)}${portion}${star}</h4>
      <span class="mi__leader" aria-hidden="true"></span>
      ${renderPrice(item)}
    </div>${desc}${tags}
  </li>`;
}

function renderTabs() {
  tablist.innerHTML = MENU_SECTIONS.map((s, i) => `
    <button type="button" role="tab" class="tab" id="tab-${s.id}" aria-controls="menu-panel"
      aria-selected="${i === state.index}" tabindex="${i === state.index ? 0 : -1}" data-index="${i}">
      <span class="tab__label">${esc(s.short)}</span>${s.star ? STAR : ''}<span class="tab__count" hidden></span>
    </button>`).join('');
}

function updateTabs() {
  $$('[role="tab"]', tablist).forEach((tab, i) => {
    const selected = i === state.index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const count = MENU_SECTIONS[i].items.filter(matches).length;
    const badge = $('.tab__count', tab);
    if (state.filter === 'all') {
      badge.hidden = true;
      tab.classList.remove('is-empty');
    } else {
      badge.hidden = false;
      badge.textContent = count;
      badge.setAttribute('aria-label', `${count} ${filterLabel()} item${count === 1 ? '' : 's'}`);
      tab.classList.toggle('is-empty', count === 0);
    }
  });
  panel.setAttribute('aria-labelledby', `tab-${MENU_SECTIONS[state.index].id}`);
}

function renderPanel() {
  const section = MENU_SECTIONS[state.index];
  const visible = section.items.filter(matches);
  const note = section.note ? `<p class="panel-head__note">${esc(section.note)}</p>` : '';
  const count = state.filter === 'all'
    ? `${section.items.length} items`
    : `${visible.length} of ${section.items.length} ${filterLabel()}`;
  const head = `<header class="panel-head">
      <h3 class="panel-head__title">${esc(section.title)}${section.star ? STAR : ''}</h3>
      ${note}
      <p class="panel-head__count">${count}</p>
    </header>`;
  let body;
  if (visible.length) {
    body = `<ul class="menu-items" role="list">${visible.map(renderItem).join('')}</ul>`;
  } else {
    const others = MENU_SECTIONS
      .map((s, i) => ({ s, i, n: s.items.filter(matches).length }))
      .filter((x) => x.n > 0 && x.i !== state.index);
    const suggestion = others.length
      ? `Try <button type="button" class="linklike" data-goto="${others[0].i}">${esc(others[0].s.short)}</button>, which has ${others[0].n}.`
      : '';
    body = `<div class="menu-empty">
        <p class="menu-empty__title">Nothing marked ${esc(state.filter)} here</p>
        <p>None of the ${esc(section.short)} items are marked ${esc(filterLabel())} on our printed menu. ${suggestion} Please tell your server about any dietary restrictions.</p>
        <button type="button" class="btn btn--dark btn--sm" data-reset-filter>Show all ${esc(section.short)}</button>
      </div>`;
  }
  panel.innerHTML = head + body;
  if (statusEl) {
    statusEl.textContent = state.filter === 'all'
      ? `${section.title}: ${section.items.length} items`
      : `${section.title}: ${visible.length} ${filterLabel()} item${visible.length === 1 ? '' : 's'}`;
  }
}

function scrollTabIntoView(tab) {
  const scroller = tablist.parentElement;
  if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
  const left = tab.offsetLeft - (scroller.clientWidth - tab.offsetWidth) / 2;
  scroller.scrollTo({ left: Math.max(0, left), behavior: reduced ? 'auto' : 'smooth' });
}

function selectTab(index, { focus = false } = {}) {
  state.index = (index + MENU_SECTIONS.length) % MENU_SECTIONS.length;
  updateTabs();
  renderPanel();
  const tab = $$('[role="tab"]', tablist)[state.index];
  if (focus) tab.focus({ preventScroll: true });
  scrollTabIntoView(tab);
}

function setFilter(filter) {
  state.filter = filter;
  chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === filter)));
  updateTabs();
  renderPanel();
}

if (tablist && panel) {
  renderTabs();
  updateTabs();
  renderPanel();

  const desktopTabs = matchMedia('(min-width: 1000px)');
  const syncOrientation = () => tablist.setAttribute('aria-orientation', desktopTabs.matches ? 'vertical' : 'horizontal');
  syncOrientation();
  desktopTabs.addEventListener('change', syncOrientation);

  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(Number(tab.dataset.index));
  });
  tablist.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key in keys) {
      e.preventDefault();
      selectTab(state.index + keys[e.key], { focus: true });
    } else if (e.key === 'Home') {
      e.preventDefault();
      selectTab(0, { focus: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      selectTab(MENU_SECTIONS.length - 1, { focus: true });
    }
  });
  chips.forEach((chip) => chip.addEventListener('click', () => setFilter(chip.dataset.filter)));
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-reset-filter]')) {
      setFilter('all');
      panel.focus({ preventScroll: true });
    }
    const go = e.target.closest('[data-goto]');
    if (go) selectTab(Number(go.dataset.goto), { focus: true });
  });
}

$$('[data-fineprint]').forEach((el) => { el.textContent = FINE_PRINT[el.dataset.fineprint] || ''; });
