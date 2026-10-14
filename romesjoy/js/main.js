/* Rome's Joy Companies concept: nav, hero word rotator, contact form, reveals. */
import { sendInquiry, formFields, setBusy } from '../../assets/js/live.js';

(function () {
  'use strict';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Sticky header shadow ---- */
  var header = document.querySelector('[data-header]');
  function onScroll() { if (header) header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- Mobile nav ---- */
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  function setNav(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  }
  if (toggle && nav) {
    toggle.addEventListener('click', function () { setNav(toggle.getAttribute('aria-expanded') !== 'true'); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setNav(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 960px)').addEventListener('change', function () { setNav(false); });
  }

  /* ---- Hero rotator: runs through the list once, then rests (WCAG 2.2.2) ---- */
  var rot = document.querySelector('[data-rotator]');
  if (rot && !reduceMotion) {
    var words = ['restaurants.', 'catering.', 'event spaces.', 'training.', 'art.', 'community.'];
    var i = 0;
    var timer = setInterval(function () {
      i++;
      if (i >= words.length) { clearInterval(timer); return; }
      rot.classList.add('is-out');
      setTimeout(function () { rot.textContent = words[i]; rot.classList.remove('is-out'); }, 350);
    }, 1900);
  } else if (rot) {
    rot.textContent = 'community.';
  }

  /* ---- Links that preselect a contact topic ---- */
  var topicSelect = document.getElementById('f-topic');
  document.querySelectorAll('[data-topic]').forEach(function (a) {
    a.addEventListener('click', function () {
      var want = a.getAttribute('data-topic');
      if (!topicSelect) return;
      for (var k = 0; k < topicSelect.options.length; k++) {
        if (topicSelect.options[k].text === want) { topicSelect.selectedIndex = k; break; }
      }
    });
  });

  /* ---- Contact form: POST to the admin API (saved + emailed); falls back to a mailto if that fails ---- */
  var form = document.querySelector('[data-mailto-form]');
  if (form) {
    var err = form.querySelector('[data-form-error]');
    var status = form.querySelector('[data-form-status]');
    var setStatus = function (message) { status.textContent = message; status.hidden = !message; };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      var name = form.elements.name, email = form.elements.email, msg = form.elements.message;
      var bad = [];
      [name, email, msg].forEach(function (f) {
        var ok = f.value.trim() !== '' && (f.type !== 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value.trim()));
        f.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (!ok) bad.push(f);
      });
      if (bad.length) {
        err.textContent = 'Please fill in your name, a valid email and a message.';
        err.hidden = false;
        bad[0].focus();
        return;
      }
      err.hidden = true;
      var topic = form.elements.topic.value;
      var fields = formFields(form);
      var payload = {
        name: fields.name, email: fields.email, phone: fields.phone, message: fields.message,
        Topic: topic, website: fields.website
      };
      var openMailApp = function () {
        var body = 'Name: ' + name.value.trim() + '\nEmail: ' + email.value.trim() +
          (form.elements.phone.value.trim() ? '\nPhone: ' + form.elements.phone.value.trim() : '') +
          '\nTopic: ' + topic + '\n\n' + msg.value.trim();
        window.location.href = 'mailto:ordering@romesjoy.com?subject=' +
          encodeURIComponent('Website inquiry: ' + topic) + '&body=' + encodeURIComponent(body);
        setStatus('We couldn’t send that from here, so your email app should open with the message filled in. If it didn’t, email ordering@romesjoy.com.');
      };
      setBusy(form, true);
      setStatus('Sending…');
      sendInquiry('romesjoy', 'contact', payload).then(function () {
        form.reset();
        setStatus('Thanks, we got your message. We’ll reply within one business day.');
        status.setAttribute('tabindex', '-1');
        status.focus();
      }, openMailApp).finally(function () { setBusy(form, false); });
    });
  }

  /* ---- Gentle reveal on scroll ---- */
  if (!reduceMotion && 'IntersectionObserver' in window) {
    var els = document.querySelectorAll('.co-card, .press-card, .person, .news-feature, .stats__list > div');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (el) { el.classList.add('reveal'); io.observe(el); });
  }

  var y = document.querySelector('[data-year]');
  if (y) y.textContent = new Date().getFullYear();
})();
