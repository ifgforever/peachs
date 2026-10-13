/* Rome's Joy Catering concept: nav, menu tabs (static markup or the admin's menu), quote form. */
import { initLive, sendInquiry, formFields, setBusy } from '../assets/js/live.js';

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

  /* ---------- Menu tabs (WAI-ARIA tabs pattern) ----------
     initTabs() runs once for the static markup and again whenever the menu is re-rendered from the API. */
  var tabs = [];
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
  function initTabs() {
    tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
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
  }
  initTabs();

  // "Box lunches →" etc. jump to the menu with that tab open. Static tabs have ids like tab-boxes; tabs
  // rendered from the API are matched by their title instead ("boxes" → "Box lunches").
  function findTab(key) {
    var exact = document.getElementById('tab-' + key);
    if (exact) return exact;
    var k = key.toLowerCase();
    for (var i = 0; i < tabs.length; i++) {
      var label = (tabs[i].getAttribute('data-key') || tabs[i].textContent).toLowerCase();
      if (label.indexOf(k) !== -1 || k.indexOf(label) !== -1) return tabs[i];
    }
    return null;
  }
  document.querySelectorAll('[data-tab]').forEach(function (link) {
    link.addEventListener('click', function () {
      var tab = findTab(link.getAttribute('data-tab'));
      if (tab) selectTab(tab, false);
    });
  });

  /* ---------- Menu from the admin API ----------
     Rebuilds the tabs and panels inside [data-live-menu] with the same markup as the static menu.
     Everything is built with createElement/textContent: API text never reaches innerHTML. */
  var menuBox = document.querySelector('[data-live-menu]');
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function money(value) { return '$' + Number(value).toFixed(2); }
  function priceText(item) {
    if (Array.isArray(item.prices) && item.prices.length) {
      return item.prices.map(function (p) { return (p.label ? p.label + ' ' : '') + money(p.value); }).join(' · ');
    }
    return item.price == null ? '' : money(item.price);
  }
  function renderDish(item, dietary) {
    var li = el('li', 'dish');
    var head = el('div', 'dish__head');
    var name = el('h4', 'dish__name', item.name);
    if (item.portion) name.append(' ', el('span', 'dish__portion', item.portion));
    (item.tags || []).forEach(function (tag) {
      var abbr = el('abbr', 'tag', tag);
      abbr.title = dietary[tag] || tag;
      name.append(' ', abbr);
    });
    var dots = el('span', 'dish__dots');
    dots.setAttribute('aria-hidden', 'true');
    head.append(name, dots, el('span', 'dish__price', priceText(item)));
    li.append(head);
    if (item.description) li.append(el('p', 'dish__desc', item.description));
    if (Array.isArray(item.allergens) && item.allergens.length) {
      li.append(el('p', 'dish__allergens', 'Allergens: ' + item.allergens.join(', ')));
    }
    return li;
  }
  function renderLiveMenu(menu, bundle) {
    var sections = (menu.sections || []).filter(function (s) { return Array.isArray(s.items) && s.items.length; });
    if (!sections.length || !menuBox) return; // an empty admin menu keeps the static one
    var dietary = (bundle && bundle.dietary) || {};
    var tablist = el('div', 'tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Menu sections');
    var panels = sections.map(function (s, i) {
      var id = 'live-' + s.id;
      var label = s.short_title || s.title;
      var tab = el('button', 'tab', label);
      tab.type = 'button';
      tab.id = 'tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'panel-' + id);
      tab.setAttribute('aria-selected', String(i === 0));
      tab.setAttribute('data-key', label.toLowerCase());
      if (i) tab.tabIndex = -1;
      tablist.append(tab);

      var panel = el('section', 'menu-panel');
      panel.id = 'panel-' + id;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'tab-' + id);
      panel.tabIndex = 0;
      panel.hidden = i !== 0;
      panel.append(el('h3', 'menu-panel__title', s.title));
      if (s.description) panel.append(el('p', 'menu-panel__note', s.description));
      var list = el('ul', 'menu-list');
      list.setAttribute('role', 'list');
      s.items.forEach(function (item) { list.append(renderDish(item, dietary)); });
      panel.append(list);
      return panel;
    });
    menuBox.replaceChildren.apply(menuBox, [tablist].concat(panels));
    initTabs();
  }
  initLive('catering', { renderMenu: renderLiveMenu });

  /* ---------- Quote form ----------
     Posts to the admin API (saved to the inbox and emailed). If that fails, or there is no API behind
     this copy of the site, it builds the same email in the visitor's mail app so nothing is lost. */
  var form = document.querySelector('[data-quote-form]');
  if (form) {
    var errorEl = form.querySelector('[data-form-error]');
    var statusEl = form.querySelector('[data-form-status]');
    var dateInput = form.querySelector('#q-date');
    if (dateInput) {
      var d = new Date();
      dateInput.min = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function setStatus(message) {
      statusEl.textContent = message;
      statusEl.hidden = !message;
    }
    // The form's field names are the labels the email shows; the API wants name/email/phone/message.
    var RENAME = { 'First name': null, 'Last name': null, Email: 'email', Phone: 'phone', 'Additional information': 'message' };
    function payloadFrom(fields) {
      var out = { name: ((fields['First name'] || '') + ' ' + (fields['Last name'] || '')).trim() };
      Object.keys(fields).forEach(function (key) {
        if (key in RENAME) { if (RENAME[key]) out[RENAME[key]] = fields[key]; }
        else out[key] = fields[key];
      });
      return out;
    }
    function openMailApp(data) {
      var lines = [];
      var seen = {};
      data.forEach(function (_, key) {
        if (seen[key] || key === 'website') return;
        seen[key] = true;
        var vals = data.getAll(key).map(function (v) { return String(v).trim(); }).filter(Boolean);
        if (vals.length) lines.push(key + ': ' + vals.join(', '));
      });
      var name = (data.get('First name') + ' ' + data.get('Last name')).trim();
      var subject = 'Catering request: ' + (data.get('Type of event') || 'event') +
        (data.get('Date of event') ? ' on ' + data.get('Date of event') : '') + ' (' + name + ')';
      var body = 'Hello Rome’s Joy Catering,\n\nI’d like a quote for an event.\n\n' + lines.join('\n') + '\n\nThank you!';
      window.location.href = 'mailto:ordering@romesjoy.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      setStatus('We couldn’t send that from here, so your email app should open with your request filled in. If nothing happens, email ordering@romesjoy.com or call 773.373.4320.');
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
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
      setBusy(form, true);
      setStatus('Sending your request…');
      sendInquiry('catering', 'quote', payloadFrom(formFields(form))).then(function () {
        form.reset();
        setStatus('Thanks! Your request is in. We’ll reply within one business day with next steps.');
        statusEl.setAttribute('tabindex', '-1');
        statusEl.focus();
      }, function () {
        openMailApp(data);
      }).finally(function () { setBusy(form, false); });
    });
  }

  /* ---------- Footer year ---------- */
  var y = document.querySelector('[data-year]');
  if (y) y.textContent = String(new Date().getFullYear());
})();
