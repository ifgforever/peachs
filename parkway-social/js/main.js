/* Parkway Social concept: nav, open-now badge, gallery lightbox, event inquiry, reveals. No dependencies. */
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  /* ---------- Mobile nav ---------- */
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav__toggle');
  var list = document.getElementById('nav-list');
  function setNav(open) {
    header.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  if (toggle && list) {
    toggle.addEventListener('click', function () { setNav(toggle.getAttribute('aria-expanded') !== 'true'); });
    list.addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.classList.contains('is-open')) { setNav(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 900px)').addEventListener('change', function (m) { if (m.matches) setNav(false); });
  }

  /* ---------- Active nav link ---------- */
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav__list a[href^="#"]'));
  if ('IntersectionObserver' in window && links.length) {
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && map[en.target.id]) {
          links.forEach(function (a) { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
          map[en.target.id].classList.add('is-active');
          map[en.target.id].setAttribute('aria-current', 'true');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
  }

  /* ---------- Open-now badge (Chicago time, Mon-Fri 8:30-17:00) ---------- */
  var status = document.querySelector('[data-open-status]');
  if (status) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
      var get = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? p.value : ''; };
      var day = get('weekday');
      var mins = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
      var weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(day) !== -1;
      var open = weekday && mins >= 510 && mins < 1020;
      var text = status.querySelector('[data-open-text]');
      if (open) {
        status.classList.add('is-open');
        text.textContent = 'Open now · until 5 pm today';
      } else {
        text.textContent = 'Closed now · opens weekdays 8:30 am';
      }
    } catch (err) { /* keep the static hours text */ }
  }

  /* ---------- Gallery lightbox ---------- */
  var dialog = document.querySelector('[data-lightbox]');
  if (dialog && typeof dialog.showModal === 'function') {
    var big = dialog.querySelector('[data-lightbox-img]');
    var cap = dialog.querySelector('[data-lightbox-cap]');
    document.querySelectorAll('[data-gallery] .shot').forEach(function (btn) {
      var img = btn.querySelector('img');
      btn.setAttribute('aria-label', 'View larger: ' + img.alt);
      btn.addEventListener('click', function () {
        big.src = btn.getAttribute('data-full');
        big.alt = img.alt;
        cap.textContent = img.alt;
        dialog.showModal();
      });
    });
    dialog.querySelector('[data-close]').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
  } else {
    /* No <dialog> support: open the image itself. */
    document.querySelectorAll('[data-gallery] .shot').forEach(function (btn) {
      btn.addEventListener('click', function () { window.open(btn.getAttribute('data-full'), '_blank', 'noopener'); });
    });
  }

  /* ---------- Event inquiry: validate, then compose an email ---------- */
  var form = document.getElementById('inquiry');
  if (form) {
    var err = form.querySelector('[data-form-error]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var bad = [];
      ['name', 'email', 'message'].forEach(function (n) {
        var f = form.elements[n];
        var ok = f.value.trim() !== '' && (n !== 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value.trim()));
        f.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (!ok) bad.push(f);
      });
      if (bad.length) {
        err.hidden = false;
        err.textContent = 'Please add your name, a valid email, and a few details about your event.';
        bad[0].focus();
        return;
      }
      err.hidden = true;
      var v = function (n) { return form.elements[n].value.trim(); };
      var body = [
        'Name: ' + v('name'),
        'Email: ' + v('email'),
        'Phone: ' + (v('phone') || '-'),
        'Event type: ' + v('type'),
        'Preferred date: ' + (v('date') || '-'),
        'Guest count: ' + (v('guests') || '-'),
        '',
        v('message')
      ].join('\n');
      var subject = 'Event inquiry: ' + v('type') + (v('date') ? ' on ' + v('date') : '');
      window.location.href = 'mailto:parkwaysocial@romesjoy.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    });
  }

  /* ---------- Year ---------- */
  var y = document.querySelector('[data-year]');
  if (y) y.textContent = new Date().getFullYear();

  /* ---------- Reveal on scroll ---------- */
  var motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  if (motionOK && 'IntersectionObserver' in window) {
    var targets = document.querySelectorAll('.section-head, .room, .flow, .plan, .story__quote, .inquiry, .visit__map');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach(function (t) { t.classList.add('reveal'); io.observe(t); });
  }
})();
