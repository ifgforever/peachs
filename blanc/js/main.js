/* Blanc Gallery concept: nav, open-now badge, exhibition status, gentle reveals, and (with the live API)
   the artwork catalog, its viewer and the "Ask about this piece" form. */
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

  /* ---------- Artworks (only with the live API) ----------
     The catalog comes from the admin: GET /api/public/blanc carries features.artworks and artworks[]
     (docs/admin-api.md, "Artwork catalog"). Without them the #artworks section and its nav link stay
     hidden, so the static copy of the site shows nothing new. live.js is a module that may already have
     applied a cached bundle before this script ran, so the same module instance is loaded with import()
     to catch up (liveBundle), then "live:hydrated" keeps the catalog in step with each refresh.
     API data only goes in through textContent and setAttribute, never as markup. */
  var liveTag = document.querySelector('script[type="module"][data-business][src*="live.js"]');
  var artSection = document.querySelector('[data-artworks]');
  if (liveTag && artSection && window.Promise) {
    import(liveTag.src).then(function (live) {
      initArtworks(live, liveTag.getAttribute('data-business'));
    }).catch(function () { /* opened from disk, or a copy without assets/js/live.js: no catalog */ });
  }

  function initArtworks(live, slug) {
    var groupsEl = artSection.querySelector('[data-artworks-groups]');
    var navItem = document.querySelector('[data-artworks-nav]');
    var STATUS_TEXT = { available: 'Available', reserved: 'Reserved', sold: 'Sold', not_for_sale: 'Not for sale' };
    var WHEN_TEXT = { current: 'On view now', upcoming: 'Coming up', past: 'Previously on view' };
    var pieces = {};      // id → artwork, from the latest bundle
    var eventsById = {};  // id → event, for the viewer's caption
    var business = {};
    var hashChecked = false;

    /* Small helpers */
    function h(tag, attrs, kids) {
      var el = document.createElement(tag);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
      add(el, kids);
      return el;
    }
    function add(el, kids) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
        if (k == null || k === false || k === '') return;
        el.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
      });
    }
    function blank(v) { return v == null || String(v).trim() === ''; }
    // Image URLs: http(s) only. A same-site path like /api/media/… belongs to the API, which may be another origin.
    function imageSrc(v) {
      if (blank(v)) return null;
      try {
        var base = live.apiBase() ? live.apiBase() + '/' : location.href;
        var url = new URL(String(v), base);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
      } catch (e) { return null; }
    }
    function linkHref(v) {
      if (blank(v)) return null;
      try { return /^(https?|tel):$/.test(new URL(String(v), location.href).protocol) ? String(v) : null; } catch (e) { return null; }
    }
    function byLine(p) { return blank(p.artist) ? p.title : p.title + ' by ' + p.artist; }
    function altFor(p, img) { return img && !blank(img.alt) ? img.alt : byLine(p); }
    function detailLine(p) { return [p.year, p.medium, p.dimensions].filter(function (v) { return !blank(v); }).join(' · '); }
    function imagesOf(p) {
      return (Array.isArray(p.images) ? p.images : []).filter(function (img) { return img && imageSrc(img.url || img.thumb_url); });
    }
    // Sold and not-for-sale pieces never show a price, whatever the data says.
    function priceOf(p) { return p.status === 'sold' || p.status === 'not_for_sale' || blank(p.price_text) ? null : p.price_text; }

    /** "Sold" with the red dot, "Reserved", "Not for sale", and the price when there is one. */
    function saleBits(p) {
      var bits = [];
      if (p.status === 'sold' || p.status === 'reserved' || p.status === 'not_for_sale') {
        bits.push(h('span', { class: 'sale sale--' + p.status.replace(/_/g, '-') }, p.status_text || STATUS_TEXT[p.status]));
      }
      var price = priceOf(p);
      if (price) {
        if (bits.length) bits.push(' · ');
        bits.push(h('span', { class: 'sale__price' }, price));
      }
      return bits;
    }

    /* ---- Render the catalog ---- */
    function card(p) {
      var img = imagesOf(p)[0];
      var frame = h('div', { class: 'art__frame' }, img
        ? h('img', {
          src: imageSrc(img.thumb_url) || imageSrc(img.url), alt: altFor(p, img),
          width: img.width || 640, height: img.height || 800, loading: 'lazy', decoding: 'async',
        })
        : h('span', { class: 'art__noimg' }, 'Photo coming soon'));
      var sale = saleBits(p);
      return h('li', { class: 'art', 'data-artwork-id': p.id }, [
        frame,
        h('h4', { class: 'art__title' }, h('button', { class: 'art__open', type: 'button', 'aria-haspopup': 'dialog', 'data-artwork-open': p.id }, p.title)),
        blank(p.artist) ? null : h('p', { class: 'art__artist' }, p.artist),
        detailLine(p) ? h('p', { class: 'art__details' }, detailLine(p)) : null,
        sale.length ? h('p', { class: 'art__sale' }, sale) : null,
      ]);
    }

    function group(id, ev, list) {
      var titleId = id + '-title';
      var when = ev ? [h('span', { class: ev.status === 'current' ? 'status' : null }, WHEN_TEXT[ev.status] || 'Exhibition'),
        blank(ev.date_text) ? null : ' · ' + ev.date_text] : null;
      return h('section', { class: 'art-group', id: id, 'aria-labelledby': titleId }, [
        h('div', { class: 'art-group__head' }, [
          when ? h('p', { class: 'art-group__when' }, when) : null,
          h('h3', { class: 'art-group__title', id: titleId }, ev ? ev.title : 'From the collection'),
          ev && !blank(ev.subtitle) ? h('p', { class: 'art-group__meta' }, ev.subtitle) : null,
          h('p', { class: 'art-group__count' }, list.length === 1 ? '1 work' : list.length + ' works'),
        ]),
        h('ul', { class: 'art-grid', role: 'list' }, list.map(card)),
      ]);
    }

    function setShown(on) {
      artSection.hidden = !on;
      if (navItem) navItem.hidden = !on;
    }

    /** "See the artworks (N)" in the hero and in each exhibition block live.js rendered (data-event-id). */
    function addJumps(events, grouped) {
      var roots = document.querySelectorAll('[data-live-clone][data-event-id]');
      events.forEach(function (ev) {
        var n = Number(ev.artwork_count) || 0;
        if (n <= 0 || !grouped[ev.id]) return;
        var href = '#artworks-event-' + ev.id;
        var label = 'See the artworks (' + n + ')';
        Array.prototype.forEach.call(roots, function (root) {
          if (root.getAttribute('data-event-id') !== String(ev.id)) return;
          var actions = root.matches('.hero__text') && root.querySelector('.actions');
          if (actions) {
            actions.appendChild(h('a', { class: 'btn btn--ghost', href: href, 'data-art-jump': true }, label));
          } else if (root.matches('.feature__text, .upcoming__item, .card')) {
            root.appendChild(h('p', { class: 'art-jump', 'data-art-jump': true },
              h('a', { class: 'text-link', href: href }, [label + ' ', h('span', { 'aria-hidden': 'true' }, '→')])));
          }
        });
      });
    }

    function render(bundle) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-art-jump]'), function (el) { el.remove(); });
      var on = Boolean(bundle && bundle.features && bundle.features.artworks);
      var list = on && Array.isArray(bundle.artworks)
        ? bundle.artworks.filter(function (p) { return p && p.id != null && !blank(p.title); }) : [];
      if (!list.length) { setShown(false); groupsEl.textContent = ''; pieces = {}; return; }
      business = bundle.business || {};

      // Current exhibition first, then upcoming, then past shows that have pieces, then the collection.
      // Pieces whose show is not in the bundle (unpublished, or older than the 20 past ones) join the collection.
      var buckets = live.bucketEvents(bundle.events || {}, live.chicagoNow().date);
      var events = buckets.current.concat(buckets.upcoming, buckets.past);
      eventsById = {};
      events.forEach(function (ev) { eventsById[ev.id] = ev; });
      var grouped = {};
      var loose = [];
      pieces = {};
      list.forEach(function (p) {
        pieces[p.id] = p;
        if (p.event_id != null && eventsById[p.event_id]) (grouped[p.event_id] = grouped[p.event_id] || []).push(p);
        else loose.push(p);
      });
      var frag = document.createDocumentFragment();
      events.forEach(function (ev) { if (grouped[ev.id]) frag.appendChild(group('artworks-event-' + ev.id, ev, grouped[ev.id])); });
      if (loose.length) frag.appendChild(group('artworks-collection', null, loose));
      groupsEl.textContent = '';
      groupsEl.appendChild(frag);
      setShown(true);
      addJumps(events, grouped);

      // A shared link to #artworks… arrives before the section exists: go there once it does.
      if (!hashChecked) {
        hashChecked = true;
        var target = /^#artworks/.test(location.hash) && document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    }

    /* ---- Dialogs: shared open/close, focus trap, scroll lock ---- */
    var viewer = document.getElementById('art-viewer');
    var ask = document.getElementById('art-ask');
    function isOpen(dlg) { return dlg.hasAttribute('open'); }
    function focusables(root) {
      return Array.prototype.filter.call(root.querySelectorAll('button, [href], input, textarea, select, [tabindex]'), function (el) {
        return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden], [aria-hidden="true"]');
      });
    }
    function openDialog(dlg, focusEl) {
      if (!isOpen(dlg)) {
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
      }
      document.documentElement.classList.add('has-dialog');
      (focusEl || focusables(dlg)[0] || dlg).focus();
    }
    function closeDialog(dlg) {
      if (!isOpen(dlg)) return;
      if (typeof dlg.close === 'function') dlg.close(); // fires "close"
      else { dlg.removeAttribute('open'); dlg.dispatchEvent(new Event('close')); }
    }
    function afterClose() {
      if (!isOpen(viewer) && !isOpen(ask)) document.documentElement.classList.remove('has-dialog');
    }
    [viewer, ask].forEach(function (dlg) {
      dlg.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(dlg); return; }
        if (e.key !== 'Tab') return;
        var items = focusables(dlg);
        if (!items.length) return;
        var first = items[0];
        var last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dlg)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    });

    /* ---- Viewer ---- */
    var v = {
      img: viewer.querySelector('[data-viewer-img]'),
      noimg: viewer.querySelector('[data-viewer-noimg]'),
      stage: viewer.querySelector('[data-viewer-stage]'),
      count: viewer.querySelector('[data-viewer-count]'),
      prev: viewer.querySelector('[data-viewer-prev]'),
      next: viewer.querySelector('[data-viewer-next]'),
      thumbs: viewer.querySelector('[data-viewer-thumbs]'),
      show: viewer.querySelector('[data-viewer-show]'),
      artist: viewer.querySelector('[data-viewer-artist]'),
      title: viewer.querySelector('[data-viewer-title]'),
      details: viewer.querySelector('[data-viewer-details]'),
      sale: viewer.querySelector('[data-viewer-sale]'),
      desc: viewer.querySelector('[data-viewer-desc]'),
      ask: viewer.querySelector('[data-viewer-ask]'),
    };
    var state = { piece: null, images: [], index: 0, opener: null };

    v.img.addEventListener('load', function () { v.img.classList.remove('is-loading'); });
    v.img.addEventListener('error', function () { v.img.classList.remove('is-loading'); });

    function showImage(i) {
      var n = state.images.length;
      v.prev.hidden = v.next.hidden = n < 2;
      v.count.textContent = '';
      if (!n) {
        v.img.hidden = true;
        v.img.removeAttribute('src');
        v.noimg.hidden = false;
        return;
      }
      state.index = ((i % n) + n) % n;
      var img = state.images[state.index];
      v.noimg.hidden = true;
      v.img.hidden = false;
      v.img.classList.add('is-loading');
      if (img.width && img.height) { v.img.setAttribute('width', img.width); v.img.setAttribute('height', img.height); }
      else { v.img.removeAttribute('width'); v.img.removeAttribute('height'); }
      v.img.setAttribute('alt', altFor(state.piece, img));
      v.img.setAttribute('src', imageSrc(img.url) || imageSrc(img.thumb_url));
      if (v.img.complete && v.img.naturalWidth) v.img.classList.remove('is-loading');
      if (n > 1) {
        add(v.count, [h('span', { 'aria-hidden': 'true' }, (state.index + 1) + ' / ' + n),
          h('span', { class: 'sr-only' }, 'Photo ' + (state.index + 1) + ' of ' + n)]);
        Array.prototype.forEach.call(v.thumbs.querySelectorAll('button'), function (b, j) {
          b.setAttribute('aria-current', String(j === state.index));
        });
        var after = state.images[(state.index + 1) % n];
        var pre = new Image();
        pre.src = imageSrc(after.url) || '';
      }
    }

    function fillViewer(p) {
      var ev = p.event_id != null ? eventsById[p.event_id] : null;
      v.show.textContent = ev ? ev.title : 'From the collection';
      v.artist.textContent = p.artist || '';
      v.artist.hidden = blank(p.artist);
      v.title.textContent = p.title;
      v.details.textContent = '';
      add(v.details, [p.year, p.medium, p.dimensions].filter(function (x) { return !blank(x); }).map(function (x) { return h('span', null, x); }));
      v.details.hidden = !v.details.childNodes.length;
      v.sale.textContent = '';
      add(v.sale, saleBits(p));
      v.desc.textContent = '';
      if (!blank(p.description)) {
        add(v.desc, String(p.description).trim().split(/\n\s*\n/).map(function (para) { return h('p', null, para.trim()); }));
      }
      v.ask.textContent = p.status === 'sold' ? 'Ask about similar work' : 'Ask about this piece';
      v.thumbs.textContent = '';
      v.thumbs.hidden = state.images.length < 2;
      if (state.images.length > 1) {
        state.images.forEach(function (img, j) {
          var src = imageSrc(img.thumb_url) || imageSrc(img.url);
          v.thumbs.appendChild(h('li', null, h('button', {
            class: 'viewer__thumb', type: 'button', 'data-index': j, 'aria-label': 'Show photo ' + (j + 1) + ' of ' + state.images.length,
          }, h('img', { src: src, alt: '', width: 56, height: 56, loading: 'lazy' }))));
        });
      }
    }

    function openViewer(p, opener) {
      state.piece = p;
      state.images = imagesOf(p);
      state.opener = opener || null;
      fillViewer(p);
      showImage(0);
      viewer.scrollTop = 0;
      openDialog(viewer, viewer.querySelector('[data-viewer-close]'));
    }

    groupsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-artwork-open]');
      var p = btn && pieces[btn.getAttribute('data-artwork-open')];
      if (p) openViewer(p, btn);
    });
    viewer.querySelector('[data-viewer-close]').addEventListener('click', function () { closeDialog(viewer); });
    v.prev.addEventListener('click', function () { showImage(state.index - 1); });
    v.next.addEventListener('click', function () { showImage(state.index + 1); });
    v.thumbs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-index]');
      if (b) showImage(Number(b.getAttribute('data-index')));
    });
    viewer.addEventListener('keydown', function (e) {
      if (state.images.length < 2 || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); showImage(state.index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); showImage(state.index + 1); }
    });
    // Swipe left/right on the photo (touch only; vertical moves still scroll the caption).
    var touch = null;
    v.stage.addEventListener('touchstart', function (e) {
      touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    v.stage.addEventListener('touchend', function (e) {
      if (!touch || state.images.length < 2) { touch = null; return; }
      var t = e.changedTouches[0];
      var dx = t.clientX - touch.x;
      var dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) showImage(state.index + (dx < 0 ? 1 : -1));
    }, { passive: true });
    viewer.addEventListener('close', function () {
      afterClose();
      // A refresh may have re-rendered the cards while the viewer was open: find the same piece's button.
      var back = state.opener && document.contains(state.opener) ? state.opener
        : state.piece && groupsEl.querySelector('[data-artwork-open="' + state.piece.id + '"]');
      if (back) back.focus();
    });

    /* ---- Inquiry ("Ask about this piece") ---- */
    var a = {
      title: ask.querySelector('[data-ask-title]'),
      piece: ask.querySelector('[data-ask-piece]'),
      form: ask.querySelector('[data-ask-form]'),
      error: ask.querySelector('[data-ask-error]'),
      done: ask.querySelector('[data-ask-done]'),
      doneText: ask.querySelector('[data-ask-done-text]'),
      submit: ask.querySelector('button[type="submit"]'),
    };
    var asking = null; // the piece the open form is about

    function openAsk() {
      var p = state.piece;
      if (!p) return;
      asking = p;
      a.title.textContent = p.status === 'sold' ? 'Ask about similar work' : 'Ask about this piece';
      a.piece.textContent = '';
      var img = state.images[0];
      add(a.piece, [
        img ? h('img', { src: imageSrc(img.thumb_url) || imageSrc(img.url), alt: '', width: 56, height: 56 }) : null,
        h('span', null, [h('em', null, p.title), blank(p.artist) ? null : [h('br'), p.artist]].flat()),
      ]);
      a.form.elements.message.value = 'I’m interested in “' + p.title + '”' + (blank(p.artist) ? '' : ' by ' + p.artist) + '.';
      a.form.elements.website.value = '';
      a.error.hidden = true;
      a.done.hidden = true;
      a.form.hidden = false;
      openDialog(ask, a.form.elements.name);
    }

    function failMessage() {
      var phone = blank(business.phone) ? '773.373.4320' : business.phone;
      var tel = linkHref(business.phone_href) || 'tel:+17733734320';
      var insta = linkHref(business.instagram_url) || 'https://www.instagram.com/blancgallerychicago/';
      a.error.textContent = '';
      add(a.error, [
        'Your message didn’t go through. Please call the gallery at ', h('a', { href: tel }, phone),
        ' or message us on ', h('a', { href: insta, target: '_blank', rel: 'noopener' }, 'Instagram'), ' (@blancgallerychicago).',
      ]);
      a.error.hidden = false;
    }

    a.form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!asking || a.form.getAttribute('aria-busy') === 'true') return;
      if (typeof a.form.reportValidity === 'function' && !a.form.reportValidity()) return;
      var f = a.form.elements;
      var fields = {
        name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(),
        message: f.message.value.trim(), website: f.website.value,
        artwork_id: asking.id, artwork_title: asking.title,
      };
      var piece = asking;
      a.error.hidden = true;
      live.setBusy(a.form, true);
      a.submit.textContent = 'Sending…';
      live.sendInquiry(slug, 'artwork', fields).then(function () {
        var first = fields.name.split(/\s+/)[0];
        a.doneText.textContent = 'Thank you' + (first ? ', ' + first : '') + ', for starting the conversation. Your note about “' +
          piece.title + '” is with the gallery, and someone from Blanc will be in touch soon.';
        a.form.hidden = true;
        a.done.hidden = false;
        a.done.focus();
      }).catch(failMessage).then(function () {
        live.setBusy(a.form, false);
        a.submit.textContent = 'Send';
      });
    });
    v.ask.addEventListener('click', openAsk);
    Array.prototype.forEach.call(ask.querySelectorAll('[data-ask-close]'), function (b) {
      b.addEventListener('click', function () { closeDialog(ask); });
    });
    ask.addEventListener('close', function () {
      afterClose();
      if (isOpen(viewer)) v.ask.focus();
    });

    /* ---- Start: the bundle live.js already applied (cache or API), then every refresh ---- */
    document.addEventListener('live:hydrated', function (e) {
      if (e.detail && e.detail.slug === slug) render(e.detail.bundle);
    });
    var current = live.liveBundle(slug);
    if (current) render(current);
  }
})();
