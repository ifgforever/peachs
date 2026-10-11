/* Rome's Joy Catering concept: nav, menu tabs, quote form (mailto, no backend). */
(function () {
  'use strict';

  /* ---------- Mobile nav ---------- */
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  function setNav(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  }
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setNav(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setNav(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setNav(false);
        toggle.focus();
      }
    });
    window.matchMedia('(min-width: 860px)').addEventListener('change', function (mq) {
      if (mq.matches) setNav(false);
    });
  }

  /* ---------- Menu tabs (WAI-ARIA tabs pattern) ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab, false); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });
  // "Box lunches →" etc. jump to the menu with that tab open.
  document.querySelectorAll('[data-tab]').forEach(function (link) {
    link.addEventListener('click', function () {
      var tab = document.getElementById('tab-' + link.getAttribute('data-tab'));
      if (tab) selectTab(tab, false);
    });
  });

  /* ---------- Quote form ----------
     Concept only: builds an email to ordering@romesjoy.com in the visitor's mail app.
     Swap for the real form handler before launch. */
  var form = document.querySelector('[data-quote-form]');
  if (form) {
    var errorEl = form.querySelector('[data-form-error]');
    var statusEl = form.querySelector('[data-form-status]');
    var dateInput = form.querySelector('#q-date');
    if (dateInput) {
      var d = new Date();
      dateInput.min = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var required = Array.prototype.slice.call(form.querySelectorAll('[required]'));
      var firstBad = null;
      required.forEach(function (el) {
        var ok = el.checkValidity() && el.value.trim() !== '';
        el.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (!ok && !firstBad) firstBad = el;
      });
      if (firstBad) {
        errorEl.textContent = 'Please add your first name, last name and a valid email so we can reply.';
        errorEl.hidden = false;
        firstBad.focus();
        return;
      }
      errorEl.hidden = true;

      var data = new FormData(form);
      var lines = [];
      var seen = {};
      data.forEach(function (_, key) {
        if (seen[key]) return;
        seen[key] = true;
        var vals = data.getAll(key).map(function (v) { return String(v).trim(); }).filter(Boolean);
        if (vals.length) lines.push(key + ': ' + vals.join(', '));
      });
      var name = (data.get('First name') + ' ' + data.get('Last name')).trim();
      var subject = 'Catering request: ' + (data.get('Type of event') || 'event') +
        (data.get('Date of event') ? ' on ' + data.get('Date of event') : '') + ' (' + name + ')';
      var body = 'Hello Rome’s Joy Catering,\n\nI’d like a quote for an event.\n\n' + lines.join('\n') + '\n\nThank you!';
      window.location.href = 'mailto:ordering@romesjoy.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);

      statusEl.textContent = 'Your email app should open with your request filled in. If nothing happens, email ordering@romesjoy.com or call 773.373.4320.';
      statusEl.hidden = false;
    });
  }

  /* ---------- Footer year ---------- */
  var y = document.querySelector('[data-year]');
  if (y) y.textContent = String(new Date().getFullYear());
})();
