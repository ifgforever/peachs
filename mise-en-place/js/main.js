// Mise En Place Chicago concept: mobile nav, header state, apply form, gentle reveals.
import { sendInquiry, formFields, setBusy } from '../../assets/js/live.js';

(function () {
  'use strict';

  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    window.matchMedia('(min-width: 980px)').addEventListener('change', function (mq) {
      if (mq.matches) setOpen(false);
    });
  }

  function onScroll() {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 8);
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Apply form: posted to the admin API (saved to the inbox and emailed). If that fails, or this copy of
  // the site has no API behind it, the same details open in the visitor's email app instead.
  // CONFIRM: the fallback inbox is the Rome's Joy Companies ordering address from romesjoy.com/contact-us/.
  var INBOX = 'ordering@romesjoy.com';
  var form = document.getElementById('apply-form');
  if (form) {
    var err = form.querySelector('[data-form-error]');
    var status = form.querySelector('[data-form-status]');
    var setStatus = function (message) { status.textContent = message; status.hidden = !message; };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      var firstBad = null;
      form.querySelectorAll('[required]').forEach(function (el) {
        var ok = el.checkValidity() && el.value.trim() !== '';
        el.setAttribute('aria-invalid', String(!ok));
        if (!ok && !firstBad) firstBad = el;
      });
      if (firstBad) {
        err.textContent = 'Please add your name, a valid email and a few words about yourself.';
        err.hidden = false;
        firstBad.focus();
        return;
      }
      err.hidden = true;
      var fields = formFields(form);
      var payload = {
        name: fields.name, email: fields.email, phone: fields.phone, message: fields.message,
        Age: fields.age, 'Most interested in': fields.interest, website: fields.website
      };
      var openMailApp = function () {
        var body = [
          'Name: ' + fields.name,
          'Email: ' + fields.email,
          fields.phone ? 'Phone: ' + fields.phone : '',
          fields.age ? 'Age: ' + fields.age : '',
          'Most interested in: ' + fields.interest,
          '',
          fields.message
        ].filter(function (line, i, all) { return line !== '' || (i > 0 && all[i - 1] !== ''); }).join('\n');
        window.location.href = 'mailto:' + INBOX + '?subject=' + encodeURIComponent('Mise En Place application: ' + fields.name) +
          '&body=' + encodeURIComponent(body);
        setStatus('We couldn’t send that from here, so your email app should open with your details filled in. If it didn’t, call 773.373.4320.');
      };
      setBusy(form, true);
      setStatus('Sending…');
      sendInquiry('mise-en-place', 'apply', payload).then(function () {
        form.reset();
        setStatus('Thanks, we got your application. We’ll follow up within a few days with the next session dates.');
        status.setAttribute('tabindex', '-1');
        status.focus();
      }, openMailApp).finally(function () { setBusy(form, false); });
    });
  }

  // Reveal sections as they enter the viewport (skipped for reduced motion).
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window) {
    var targets = document.querySelectorAll('.tier, .person, .give-card, .press-card, .steps li, .facts li');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach(function (el) {
      el.classList.add('reveal');
      io.observe(el);
    });
  }
})();
