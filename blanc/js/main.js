/* Blanc Gallery concept: nav, open-now badge, exhibition status, gentle reveals. */
(function () {
  'use strict';

  /* ---------- Mobile nav ---------- */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  function setNav(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
    document.body.classList.toggle('nav-open', open);
  }
  if (toggle && nav) {
    toggle.addEventListener('click', function () { setNav(toggle.getAttribute('aria-expanded') !== 'true'); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setNav(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 960px)').addEventListener('change', function (m) { if (m.matches) setNav(false); });
  }

  /* ---------- Header border on scroll ---------- */
  var header = document.querySelector('.site-header');
  function onScroll() { header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Chicago time helpers ---------- */
  function chicagoNow() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(new Date());
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    var days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      day: days[o.weekday],
      minutes: parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10),
      date: o.year + '-' + o.month + '-' + o.day
    };
  }

  /* ---------- Open now (Sat & Sun, 11 am to 3 pm) ---------- */
  var now = chicagoNow();
  var weekend = now.day === 0 || now.day === 6;
  var isOpen = weekend && now.minutes >= 660 && now.minutes < 900;
  var label = document.querySelector('[data-open-text]'); // live.js rewrites the same element from the admin's hours
  var dot = document.querySelector('[data-open-dot]');
  if (label) {
    if (isOpen) label.textContent = 'Open now';
    else if (weekend && now.minutes < 660) label.textContent = 'Opens today at 11 am';
    else label.textContent = 'Open Saturday & Sunday';
  }
  if (dot) dot.classList.toggle('is-open', isOpen);
  var todayRow = document.querySelector('.hours tr[data-day="' + now.day + '"]');
  if (todayRow) todayRow.classList.add('is-today');

  /* ---------- Exhibition status (date-aware hero label) ---------- */
  var status = document.querySelector('[data-exhibit-status]');
  if (status) {
    var start = status.getAttribute('data-start');
    var weeks = parseInt(status.getAttribute('data-weeks') || '6', 10);
    var end = new Date(start + 'T12:00:00Z');
    end.setUTCDate(end.getUTCDate() + weeks * 7);
    var endStr = end.toISOString().slice(0, 10);
    if (now.date < start) status.textContent = 'Opening October 24';
    else if (now.date === start) status.textContent = 'Opening reception today, 5–8 pm';
    else if (now.date <= endStr) status.textContent = 'On view now';
    else status.textContent = 'Recently on view';
  }

  /* ---------- Reveal on scroll ---------- */
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window) {
    var els = document.querySelectorAll('.section-head, .feature, .card, .program, .about__grid > *, .space__rail > figure');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    els.forEach(function (el) { el.classList.add('reveal'); io.observe(el); });
  }
})();
