(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- Floating pancake stack ---------- */

  var stage = document.querySelector("[data-stack]");
  if (stage) initStack(stage);

  function initStack(stage) {
    var cakes = Array.prototype.slice.call(stage.querySelectorAll(".pancake"));
    var whip = stage.querySelector(".whip");
    var berries = Array.prototype.slice.call(stage.querySelectorAll(".berry"));
    var compote = stage.querySelector("[data-compote]");
    var shadow = stage.querySelector("[data-shadow]");
    var N = cakes.length;

    // Hand-tuned so the stack looks tossed by a person, not a machine.
    var cakeLook = [
      { rs: -5, xs: -10, rf: -1.2, xf: -3, period: 5.6, phase: 0.0 },
      { rs: 4, xs: 14, rf: 0.8, xf: 4, period: 6.4, phase: 1.3 },
      { rs: -3, xs: -16, rf: -0.6, xf: -2, period: 5.1, phase: 2.6 },
      { rs: 6, xs: 10, rf: 1.1, xf: 3, period: 6.9, phase: 0.7 },
      { rs: -4, xs: -6, rf: -0.4, xf: -4, period: 5.8, phase: 3.4 },
      { rs: 3, xs: 8, rf: 0.6, xf: 1, period: 6.2, phase: 4.1 }
    ];
    var whipLook = { rs: -10, xs: 18, rf: -2, xf: 6, period: 4.8, phase: 2.0 };
    var berryLook = [
      { rs: 0, xs: -150, rf: 0, xf: -64, ys: 210, yf: -4, period: 4.4, phase: 0.4 },
      { rs: 0, xs: 150, rf: 0, xf: 62, ys: 150, yf: 2, period: 5.2, phase: 1.9 },
      { rs: 0, xs: 118, rf: 0, xf: 22, ys: 330, yf: -12, period: 4.9, phase: 3.0 }
    ];

    // Timeline (ms after load)
    var INTRO = 1100;      // drift into view, suspended
    var HOVER = 900;       // hang in the air for a beat
    var STAGGER = 230;     // gap between each pancake dropping
    var DROP = 680;        // fall time for one pancake
    var dropStart = INTRO + HOVER;
    var whipStart = dropStart + N * STAGGER + 120;
    var berryStart = whipStart + 260;
    var compoteStart = berryStart + 3 * 140 + 380;
    var COMPOTE = 1900;

    var geo = {};
    function measure() {
      var H = stage.clientHeight;
      var pw = cakes[0].offsetWidth;
      var u = pw / 320;
      var plateH = (pw * 1.32) / 4;
      var base = H * 0.06 + plateH * 0.5 - 6 * u;
      var ph = pw * 92 / 320;
      var room = H * 0.97 - base - 34 * u - ph - 70 * u;
      geo = {
        H: H, u: u, pw: pw, base: base,
        gap: Math.max(26 * u, Math.min(66 * u, room / (N - 1))),
        whipH: whip.offsetWidth * 70 / 120,
        berryW: berries[0].offsetWidth
      };
    }

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
    function easeOut(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }

    // A drop: gravity in, a soft landing squash, a tiny settle.
    function drop(p) {
      p = clamp(p, 0, 1);
      var CONTACT = 0.74;
      if (p < CONTACT) {
        var f = p / CONTACT;
        return { fall: f * f, squash: 0, bounce: 0 };
      }
      var q = (p - CONTACT) / (1 - CONTACT);
      var s = Math.sin(q * Math.PI);
      return { fall: 1, squash: s * 0.11 * (1 - q * 0.6), bounce: Math.sin(q * Math.PI) * (1 - q) };
    }

    var lift = 0, liftTarget = 0;
    function readScroll() {
      var rect = stage.getBoundingClientRect();
      var vh = window.innerHeight || 800;
      // 0 while the stack sits in its spot; rises toward 1 as it scrolls up and away.
      var travelled = (vh * 0.62) - (rect.top + rect.height * 0.5);
      liftTarget = smooth(travelled / (vh * 0.55));
    }

    function place(el, x, y, rot, sx, sy, opacity) {
      el.style.transform =
        "translate3d(calc(-50% + " + x.toFixed(2) + "px)," + (-y).toFixed(2) + "px,0) rotate(" +
        rot.toFixed(2) + "deg) scale(" + sx.toFixed(3) + "," + sy.toFixed(3) + ")";
      el.style.opacity = opacity.toFixed(3);
    }

    function setCompote(reveal, drips) {
      var hidden = (1 - easeOut(reveal)) * 100;
      var v = "inset(0 0 " + hidden.toFixed(2) + "% 0)";
      compote.style.clipPath = v;
      compote.style.webkitClipPath = v;
      compote.style.opacity = drips.toFixed(3);
    }

    function frame(now, still) {
      var g = geo, u = g.u;
      var t = still ? 1e9 : now - startTime;
      var secs = now / 1000;
      var introP = still ? 1 : easeOut(t / INTRO);
      var landedSum = 0;
      var topY = 0, topX = 0, topRot = 0;

      for (var i = 0; i < N; i++) {
        var L = cakeLook[i];
        var ySusp = g.base + 34 * u + i * g.gap;
        var yStack = g.base + i * 15 * u;
        var d = drop((t - dropStart - i * STAGGER) / DROP);
        var settled = smooth(d.fall);
        // Scroll pulls the stack back up into the air.
        var w = settled * (1 - lift);
        var bobAmt = still ? 0 : (1 - w);
        var bob = Math.sin(secs * 2 * Math.PI / L.period + L.phase) * 7 * u * bobAmt;
        var sway = Math.sin(secs * 2 * Math.PI / (L.period * 1.3) + L.phase) * 1.4 * bobAmt;
        var fromAbove = (1 - introP) * 40 * u;
        var y = lerp(ySusp, yStack, d.fall * (1 - lift)) + bob + fromAbove + d.bounce * 5 * u * (1 - lift);
        var x = lerp(L.xs * u, L.xf * u, w);
        var rot = lerp(L.rs, L.rf, w) + sway;
        var sq = d.squash * (1 - lift);
        place(cakes[i], x, y, rot, 1 + sq * 0.45, 1 - sq, introP);
        landedSum += w;
        if (i === N - 1) { topY = y; topX = x; topRot = rot; }
      }

      // Cream lands on the top pancake once it's down.
      var surface = topY + 50 * u;
      var dw = drop((t - whipStart) / (DROP * 0.85));
      var ww = smooth(dw.fall) * (1 - lift);
      var wb = still ? 0 : (1 - ww);
      var wBob = Math.sin(secs * 2 * Math.PI / whipLook.period + whipLook.phase) * 8 * u * wb;
      var whipSusp = g.base + 34 * u + (N - 1) * g.gap + 96 * u;
      var whipRest = surface - g.whipH * (6 / 70) + 2 * u;
      var wy = lerp(whipSusp, whipRest, dw.fall * (1 - lift)) + wBob + (1 - introP) * 50 * u;
      place(whip, lerp(whipLook.xs * u, topX + whipLook.xf * u, ww), wy,
        lerp(whipLook.rs, topRot + whipLook.rf, ww), 1 + dw.squash * 0.4 * (1 - lift), 1 - dw.squash * (1 - lift), introP);

      for (var b = 0; b < berries.length; b++) {
        var B = berryLook[b];
        var db = drop((t - berryStart - b * 140) / (DROP * 0.7));
        var bw = smooth(db.fall) * (1 - lift);
        var bbAmt = still ? 0 : (1 - bw);
        var bBob = Math.sin(secs * 2 * Math.PI / B.period + B.phase) * 10 * u * bbAmt;
        var bySusp = g.base + B.ys * u;
        var byRest = surface + B.yf * u - g.berryW * 0.04;
        var by = lerp(bySusp, byRest, db.fall * (1 - lift)) + bBob + (1 - introP) * 60 * u;
        var spin = still ? 0 : secs * 18 * bbAmt * (b % 2 ? -1 : 1);
        place(berries[b], lerp(B.xs * u, topX + B.xf * u, bw), by, spin, 1, 1, introP);
      }

      var cReveal = still ? 1 : clamp((t - compoteStart) / COMPOTE, 0, 1);
      setCompote(cReveal, clamp(1 - lift * 3, 0, 1));

      shadow.style.opacity = (0.15 + 0.6 * (landedSum / N)).toFixed(3);
      var sScale = 0.7 + 0.3 * (landedSum / N);
      shadow.style.transform = "translateX(-50%) scale(" + sScale.toFixed(3) + ")";
    }

    var startTime = performance.now();
    var running = false, visible = true, rafId = 0;

    function loop(now) {
      readScroll();
      lift += (liftTarget - lift) * 0.09;
      if (Math.abs(liftTarget - lift) < 0.0005) lift = liftTarget;
      frame(now, false);
      rafId = visible ? requestAnimationFrame(loop) : 0;
      running = !!rafId;
    }

    function startLoop() {
      if (!running && visible) { running = true; rafId = requestAnimationFrame(loop); }
    }

    function renderStill() {
      lift = 0;
      frame(performance.now(), true);
    }

    measure();

    // The show starts the first time the stack is actually on screen.
    var started = false;
    function begin() {
      if (!started) { started = true; startTime = performance.now(); }
      startLoop();
    }

    if (reduceMotion.matches) {
      renderStill();
    } else {
      frame(startTime, false);
    }

    if ("IntersectionObserver" in window) {
      visible = false;
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && !reduceMotion.matches) begin();
      }, { threshold: 0.25 }).observe(stage);
    } else if (!reduceMotion.matches) {
      begin();
    }

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        measure();
        if (reduceMotion.matches) renderStill();
      }, 120);
    });

    var onMotionChange = function () {
      if (reduceMotion.matches) { cancelAnimationFrame(rafId); running = false; renderStill(); }
      else { started = true; startTime = performance.now() - compoteStart - COMPOTE; startLoop(); }
    };
    if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", onMotionChange);
    else if (reduceMotion.addListener) reduceMotion.addListener(onMotionChange);
  }

  /* ---------- Open now / closed ---------- */

  var dot = document.querySelector("[data-open-dot]");
  var label = document.querySelector("[data-open-label]");
  if (dot && label) {
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23"
      }).formatToParts(new Date());
      var get = function (type) { for (var k = 0; k < parts.length; k++) if (parts[k].type === type) return parts[k].value; };
      var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      var names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      var day = days.indexOf(get("weekday"));
      var mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
      var openDay = function (d) { return d === 0 || d >= 3; }; // Wed–Sun
      if (openDay(day) && mins >= 480 && mins < 840) {
        dot.classList.add("open");
        label.textContent = "Open now · until 2pm";
      } else if (openDay(day) && mins < 480) {
        label.textContent = "Opens today at 8am";
      } else {
        var next = (day + 1) % 7, ahead = 1;
        while (!openDay(next)) { next = (next + 1) % 7; ahead++; }
        label.textContent = "Opens " + (ahead === 1 ? "tomorrow" : names[next]) + " at 8am";
      }
    } catch (e) { /* keep the static hours */ }
  }

  /* ---------- Header, order bar, reveals ---------- */

  var header = document.querySelector(".site-header");
  var bar = document.querySelector(".order-bar");
  var footer = document.querySelector(".site-footer");
  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (header) header.classList.toggle("scrolled", y > 8);
    if (bar && footer) {
      var nearFooter = footer.getBoundingClientRect().top < window.innerHeight - 40;
      bar.classList.toggle("show", y > 420 && !nearFooter);
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  var year = document.querySelector("[data-year]");
  if (year) year.textContent = new Date().getFullYear();
})();
