// Hero variant A: "Golden Hour Studio"
// Photoreal, bright-studio food commercial: six pancakes hang in the air, drop one at a
// time onto a white plate, then butter, maple syrup and blueberries finish the stack.
//
// Contract: mountHero(host, { getProgress, reducedMotion, frozen }) -> { renderAt(p, t), destroy() }
// The scene is a pure function of (p, t): no accumulated state, so scrubbing works both ways.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------------------------------
 * Small math helpers
 * ---------------------------------------------------------------------------------------- */
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, k) => a + (b - a) * k;
const sstep = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const easeInQuad = (k) => k * k;
const smax = (a, b, k) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul((s | 0) + 0x3c6ef372, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise; when per > 0 the lattice wraps so the result tiles with that period.
function vnoise(x, y, s, per = 0) {
  let xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  let x1 = xi + 1, y1 = yi + 1;
  if (per > 0) {
    xi = ((xi % per) + per) % per; yi = ((yi % per) + per) % per;
    x1 = ((x1 % per) + per) % per; y1 = ((y1 % per) + per) % per;
  }
  const a = hash2(xi, yi, s), b = hash2(x1, yi, s), c = hash2(xi, y1, s), d = hash2(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, s, oct = 4, per = 0) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, s + i * 31, per ? per * f : 0);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------------------------------
 * Choreography constants (p is scroll progress 0..1)
 * ---------------------------------------------------------------------------------------- */
const N = 6;                       // pancakes
const DROP_START = 0.08;
const DROP_END = 0.72;
const SLOT = (DROP_END - DROP_START) / N;
const FALL = 0.056;                // p-span of one fall
const SQUASH = 0.04;               // p-span of the squash-and-settle
const CLEAR = 0.8;                 // gap under the lowest floating pancake when it lets go
const GAP = 1.06;                  // vertical pitch of the floating column
const PLATE_TOP = 0;               // y of the plate's flat well
const LAST_LAND = DROP_START + (N - 1) * SLOT + FALL;

const BUTTER_IN = 0.72, BUTTER_LAND = 0.79, BUTTER_SQ = 0.025;
const SYRUP_IN = 0.84;

const RT = 1.14;                   // half-size (world) covered by the planar top texture
const DESCENT_RATE = (GAP - 0.318) / SLOT;

const dropStart = (i) => DROP_START + i * SLOT;

// Soft-started linear descent of the floating column.
function descent(p) {
  const w = 0.045, x = p - DROP_START;
  const r = x <= -w ? 0 : x >= w ? x : (x + w) * (x + w) / (4 * w);
  return r * DESCENT_RATE;
}

// squash curve: 0 at impact, quick rise to 1, then a damped settle back to 0
function squashCurve(q) {
  if (q <= 0 || q >= 1) return 0;
  if (q < 0.14) return Math.sin((q / 0.14) * Math.PI / 2);
  const x = (q - 0.14) / 0.86;
  return Math.exp(-4.2 * x) * Math.cos(x * Math.PI * 2.2) * (1 - x);
}

/* ------------------------------------------------------------------------------------------
 * Pancake shape (shared by geometry, syrup and drips so everything sits exactly on it)
 * Local frame: centre at origin, y up, angle phi measured with x = r sin(phi), z = r cos(phi).
 * ---------------------------------------------------------------------------------------- */
function makePancakeParams(i) {
  const rnd = mulberry32(9001 + i * 7919);
  const R = 1.0 + (rnd() - 0.5) * 0.09;
  const T = 0.29 + rnd() * 0.04;
  const dome = 0.022 + rnd() * 0.02;
  const harm = [];
  for (let k = 2; k <= 9; k++) harm.push({ k, a: (0.02 / Math.pow(k - 1, 0.8)) * (0.45 + rnd()), ph: rnd() * TAU });
  // floating pose: tops mostly turned toward the camera, alternating side tilt
  const side = i % 2 === 0 ? 1 : -1;
  const P = {
    i, seed: 1000 + i * 97, R, T, dome,
    ct: 0.1 + rnd() * 0.025, cb: 0.055,
    harm,
    trx: (8 + rnd() * 14) * DEG,
    trz: side * (5 + rnd() * 10) * DEG,
    fx: 0.2 * Math.sin(i * 1.25 + 0.6) + (rnd() - 0.5) * 0.1,
    fz: (rnd() - 0.5) * 0.46,
    rotY: rnd() * TAU,
    spinIn: (rnd() - 0.5) * 1.6,
    lx: (rnd() - 0.5) * 0.12,
    lz: (rnd() - 0.5) * 0.1,
    lrx: (rnd() - 0.5) * 0.006,
    lrz: (rnd() - 0.5) * 0.006,
    ph1: rnd() * TAU, ph2: rnd() * TAU, ph3: rnd() * TAU,
    texSeed: 77 + i * 13,
    so: [rnd() * 7, rnd() * 7],
  };
  P.h = T + 0.4 * dome; // stacking increment
  return P;
}

function outline(P, phi) {
  let f = 1;
  for (const h of P.harm) f += h.a * Math.sin(h.k * phi + h.ph);
  return f;
}

function topNoise(P, x, z) {
  const n1 = vnoise(x * 1.9 + 11.3, z * 1.9 + 3.7, P.seed) - 0.5;
  const n2 = fbm(x * 5.5 + 5.1, z * 5.5 + 7.9, P.seed + 3, 2) - 0.5;
  return n1 * P.T * 0.14 + n2 * 0.012;
}

const CB_Y = 0.3, CT_Y = 0.44; // vertical radii of the bottom / top rounded edges (fraction of T)
function pancakeProfile(P) {
  const { R, T, dome, ct, cb } = P;
  const hb = T / 2, cbY = CB_Y * T, ctY = CT_Y * T, rc = R - ct;
  const pts = [[0, -hb]];
  for (let k = 1; k <= 7; k++) pts.push([(R - cb) * (k / 7), -hb]);
  for (let k = 1; k <= 7; k++) { const a = -Math.PI / 2 + (k / 7) * (Math.PI / 2); pts.push([R - cb + cb * Math.cos(a), -hb + cbY + cbY * Math.sin(a)]); }
  const ys = -hb + cbY, ye = hb - ctY;
  for (let k = 1; k <= 2; k++) pts.push([R + 0.006 * Math.sin(Math.PI * k / 3), ys + (ye - ys) * (k / 3)]);
  for (let k = 0; k <= 12; k++) { const a = (k / 12) * (Math.PI / 2); pts.push([rc + ct * Math.cos(a), ye + ctY * Math.sin(a)]); }
  for (let k = 1; k <= 16; k++) { const r = rc * (1 - k / 16); pts.push([r, hb + dome * Math.pow(1 - (r / rc) ** 2, 2)]); }
  return pts;
}

// height of the top surface at local polar (rw, phi), matching the generated mesh
function topSurfaceLocal(P, rw, phi) {
  const { R, T, dome, ct } = P;
  const hb = T / 2, ctY = CT_Y * T, rc = R - ct;
  const r = rw / outline(P, phi);
  let y;
  if (r <= rc) y = hb + dome * Math.pow(1 - (r / rc) ** 2, 2);
  else if (r < R) { const a = Math.acos(clamp((r - rc) / ct, -1, 1)); y = hb - ctY + ctY * Math.sin(a); }
  else y = hb - ctY;
  const up = clamp(y / hb);
  return y + up * up * topNoise(P, rw * Math.sin(phi), rw * Math.cos(phi));
}

function buildPancakeGeometry(P) {
  const prof = pancakeProfile(P);
  const SEG = 128, J = prof.length;
  const ringCount = J - 2;
  const vCount = ringCount * SEG + 2;
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const hb = P.T / 2;
  const put = (vi, x, y, z) => {
    pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
    uv[vi * 2] = x / (2 * RT) + 0.5; uv[vi * 2 + 1] = z / (2 * RT) + 0.5;
  };
  const bottomPole = ringCount * SEG, topPole = bottomPole + 1;
  put(bottomPole, 0, -hb, 0);
  put(topPole, 0, prof[J - 1][1] + topNoise(P, 0, 0), 0);
  for (let j = 1; j < J - 1; j++) {
    const [r, y] = prof[j];
    for (let s = 0; s < SEG; s++) {
      const phi = (s / SEG) * TAU;
      const rr = r * outline(P, phi);
      const x = rr * Math.sin(phi), z = rr * Math.cos(phi);
      const up = clamp(y / hb);
      put((j - 1) * SEG + s, x, y + up * up * topNoise(P, x, z), z);
    }
  }
  const idx = [];
  const vid = (j, s) => (j === 0 ? bottomPole : j === J - 1 ? topPole : (j - 1) * SEG + (s % SEG));
  for (let s = 0; s < SEG; s++) {
    for (let j = 0; j < J - 1; j++) {
      const a = vid(j, s), b = vid(j, s + 1), c = vid(j + 1, s + 1), d = vid(j + 1, s);
      if (j !== 0) idx.push(a, b, d);
      if (j !== J - 2) idx.push(b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------------------------------
 * Procedural textures
 * ---------------------------------------------------------------------------------------- */
const TOP_STOPS = [
  [0.00, [236, 198, 128]],
  [0.24, [224, 160, 80]],
  [0.48, [198, 120, 50]],
  [0.70, [164, 90, 34]],
  [1.00, [112, 56, 20]],
];
function ramp(stops, x, out) {
  x = clamp(x);
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const k = (x - a) / (b - a);
      out[0] = ca[0] + (cb[0] - ca[0]) * k; out[1] = ca[1] + (cb[1] - ca[1]) * k; out[2] = ca[2] + (cb[2] - ca[2]) * k;
      return out;
    }
  }
  const c = stops[stops.length - 1][1]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  return out;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Browned griddle side: mottled golden-brown, lacy darker browning, pale rim, bubble pores.
function makeTopTextures(P, S = 512) {
  const cMap = makeCanvas(S, S), cBump = makeCanvas(S, S);
  const gMap = cMap.getContext('2d'), gBump = cBump.getContext('2d');
  const imMap = gMap.createImageData(S, S), imBump = gBump.createImageData(S, S);
  const dm = imMap.data, db = imBump.data;
  const sd = P.texSeed, col = [0, 0, 0];
  const cell = 0.036;
  const pore = (X, Z) => {
    // jittered-grid bubble pores: returns [darkness, halo]
    const cx = Math.floor(X / cell), cz = Math.floor(Z / cell);
    let dark = 0, halo = 0, speck = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gz = cz + oy;
      const h0 = hash2(gx, gz, sd + 5);
      const px = (gx + hash2(gx, gz, sd + 6)) * cell, pz = (gz + hash2(gx, gz, sd + 7)) * cell;
      const d = Math.hypot(X - px, Z - pz);
      if (h0 < 0.42) {
        const rad = 0.0045 + 0.0075 * hash2(gx, gz, sd + 8);
        if (d < rad) dark = Math.max(dark, 1 - (d / rad) * 0.5);
        else if (d < rad * 2.1) halo = Math.max(halo, 1 - (d - rad) / (rad * 1.1));
      } else if (h0 > 0.86) {
        const rad = 0.008 + 0.012 * hash2(gx, gz, sd + 9);
        if (d < rad) speck = Math.max(speck, 1 - d / rad);
      }
    }
    return [dark, halo, speck];
  };
  for (let py = 0; py < S; py++) {
    const v = 1 - (py + 0.5) / S;
    const Z = (v - 0.5) * 2 * RT;
    for (let px = 0; px < S; px++) {
      const u = (px + 0.5) / S;
      const X = (u - 0.5) * 2 * RT;
      const rw = Math.hypot(X, Z);
      const phi = Math.atan2(X, Z);
      const rn = rw / (P.R * outline(P, phi));
      const m1 = fbm(X * 1.7 + 3.1, Z * 1.7 + 8.2, sd, 4);
      const m2 = fbm(X * 6.2 + 1.7, Z * 6.2 + 4.4, sd + 1, 3);
      const wx = X * 8.5 + (m1 - 0.5) * 3.2, wz = Z * 8.5 + (m2 - 0.5) * 3.2;
      const ridge = 1 - Math.abs(2 * vnoise(wx, wz, sd + 2) - 1);
      const lace = Math.pow(ridge, 5);
      const ridge2 = 1 - Math.abs(2 * vnoise(wx * 2.3 + 9, wz * 2.3 + 2, sd + 4) - 1);
      const lace2 = Math.pow(ridge2, 7);
      // even golden-brown centre, lacy darker network, leopard-spotted paler ring toward the rim
      let b = 0.6 + (m1 - 0.5) * 0.42 + (m2 - 0.5) * 0.3 + 0.16 * lace + 0.1 * lace2;
      b += 0.06 * (1 - rn);
      const ring = sstep(0.7, 0.9, rn) * (1 - sstep(0.95, 1.0, rn));
      const spots = sstep(0.5, 0.75, vnoise(X * 26 + 3, Z * 26 + 9, sd + 12));
      b -= ring * (0.14 + 0.14 * spots);
      b += 0.2 * sstep(0.955, 1.01, rn);
      const [dark, halo, speck] = pore(X, Z);
      b -= 0.1 * halo * (1 - sstep(0.8, 0.9, rn));
      b -= 0.3 * speck * (1 - sstep(0.78, 0.88, rn));
      ramp(TOP_STOPS, b, col);
      const pd = dark * (1 - sstep(0.8, 0.9, rn));
      const k = 1 - 0.5 * pd;
      const o = (py * S + px) * 4;
      dm[o] = col[0] * k; dm[o + 1] = col[1] * k * 0.97; dm[o + 2] = col[2] * k * 0.92; dm[o + 3] = 255;
      let h = 0.55 + 0.22 * (m2 - 0.5) + 0.12 * lace - 0.55 * pd + 0.08 * halo + 0.06 * speck;
      h = clamp(h) * 255;
      db[o] = h; db[o + 1] = h; db[o + 2] = h; db[o + 3] = 255;
    }
  }
  gMap.putImageData(imMap, 0, 0);
  gBump.putImageData(imBump, 0, 0);
  return { map: cMap, bump: cBump };
}

// Tileable crumb for the pale sides: R = crumb mottling, G = air pockets, B = crust variation
function makeCrumbTexture(S = 256) {
  const c = makeCanvas(S, S), g = c.getContext('2d');
  const im = g.createImageData(S, S), d = im.data;
  const PER = 8, cellN = 22;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const r = fbm(u * PER, v * PER, 501, 4, PER);
    const bnoise = fbm(u * 4, v * 4, 777, 3, 4);
    // pores: elongated jittered-grid holes, wrapped
    const gx = Math.floor(u * cellN), gy = Math.floor(v * cellN * 0.6);
    let hole = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = (gx + ox + cellN) % cellN, cy = (gy + oy + Math.round(cellN * 0.6)) % Math.round(cellN * 0.6);
      if (hash2(cx, cy, 91) > 0.3) continue;
      let px = (gx + ox + hash2(cx, cy, 92)) / cellN, py = (gy + oy + hash2(cx, cy, 93)) / (cellN * 0.6);
      const dx = (u - px) * 1.0, dy = (v - py) * 1.9;
      const rad = (0.006 + 0.012 * hash2(cx, cy, 94));
      const dd = Math.hypot(dx, dy);
      if (dd < rad) hole = Math.max(hole, 1 - dd / rad);
    }
    const o = (y * S + x) * 4;
    d[o] = r * 255; d[o + 1] = Math.min(1, hole * 1.6) * 255; d[o + 2] = bnoise * 255; d[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

// grey-scale radial falloff on opaque black (alphaMap reads the green channel)
function makeRadialTexture(stops, S = 256) {
  const c = makeCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2 - 1);
  for (const [o, a] of stops) { const v = Math.round(255 * a); gr.addColorStop(o, `rgb(${v},${v},${v})`); }
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return c;
}

/* ------------------------------------------------------------------------------------------
 * Plate profile (lathe). Top surface is exactly flat (y = 0) out to r = 1.34.
 * ---------------------------------------------------------------------------------------- */
const PLATE_R = 1.8;
function plateProfilePoints() {
  const ctrl = [
    [0.0, -0.03], [0.86, -0.03], [0.93, -0.062], [1.03, -0.062], [1.09, -0.028],
    [1.45, 0.03], [1.66, 0.07], [1.76, 0.088], [1.8, 0.104], [1.792, 0.12], [1.765, 0.128],
    [1.64, 0.122], [1.52, 0.1], [1.43, 0.058], [1.375, 0.02], [1.34, 0.0], [0.7, 0.0], [0.0, 0.0],
  ];
  const curve = new THREE.CatmullRomCurve3(ctrl.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, 'centripetal', 0.5);
  const pts = curve.getSpacedPoints(150).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y));
  pts[0].set(0, -0.03); pts[pts.length - 1].set(0, 0);
  return pts;
}
const PLATE_TOP_CURVE = [[0, 0], [1.34, 0], [1.375, 0.02], [1.43, 0.058], [1.52, 0.1], [1.64, 0.122], [1.765, 0.128]];
function plateTopY(r) {
  const c = PLATE_TOP_CURVE;
  if (r <= c[1][0]) return 0;
  for (let i = 2; i < c.length; i++) if (r <= c[i][0]) { const k = (r - c[i - 1][0]) / (c[i][0] - c[i - 1][0]); return lerp(c[i - 1][1], c[i][1], k); }
  return c[c.length - 1][1];
}

/* ------------------------------------------------------------------------------------------
 * Syrup: shared helpers for blobs (pool on top, puddle on plate) and drips
 * ---------------------------------------------------------------------------------------- */
function makeBlobGeometry(K, S) {
  const n = 1 + K * S;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aThick', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  const idx = [];
  const ring = (k, s) => 1 + (k - 1) * S + ((s + S) % S);
  for (let s = 0; s < S; s++) idx.push(0, ring(1, s), ring(1, s + 1));
  for (let k = 1; k < K; k++) for (let s = 0; s < S; s++) {
    const a = ring(k, s), b = ring(k, s + 1), c = ring(k + 1, s + 1), d = ring(k + 1, s);
    idx.push(a, d, c, a, c, b);
  }
  g.setIndex(idx);
  g.userData = { K, S };
  return g;
}

// thickness profile of a syrup pool: domed body, rounded bead at the edge that dips below the surface
function blobThick(rho, thC) {
  const body = thC * (1 - 0.3 * rho * rho);
  const e0 = 0.74;
  if (rho <= e0) return body;
  const q = (rho - e0) / (1 - e0);
  return body * Math.sqrt(Math.max(0, 1 - q * q)) - 0.008 * q * q * q;
}

// fill a blob: centre (cx, cz) in the geometry's own frame, radius(phi), surface(x, z)
function fillBlob(g, cx, cz, radiusFn, thC, surfaceFn, thickNorm, attrFn = null) {
  const { K, S } = g.userData;
  const pos = g.attributes.position.array, th = g.attributes.aThick.array;
  const t0 = blobThick(0, thC);
  pos[0] = cx; pos[1] = surfaceFn(cx, cz) + t0 + 0.0015; pos[2] = cz; th[0] = clamp(t0 / thickNorm);
  if (attrFn) th[0] = attrFn(cx, cz, th[0]);
  for (let s = 0; s < S; s++) {
    const phi = (s / S) * TAU;
    const rr = radiusFn(phi);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let k = 1; k <= K; k++) {
      const rho = 1 - Math.pow(1 - k / K, 1.7);
      const x = cx + sp * rr * rho, z = cz + cp * rr * rho;
      const t = blobThick(rho, thC);
      const vi = 1 + (k - 1) * S + s;
      pos[vi * 3] = x; pos[vi * 3 + 1] = surfaceFn(x, z) + t + 0.0015; pos[vi * 3 + 2] = z;
      th[vi] = attrFn ? attrFn(x, z, clamp(t / thickNorm)) : clamp(t / thickNorm);
    }
  }
  g.attributes.position.needsUpdate = true;
  g.attributes.aThick.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
}

/* ------------------------------------------------------------------------------------------
 * Warm studio environment for reflections: peach sweep, cream ceiling, big softboxes.
 * Unlit materials with HDR colour values, baked once through PMREM.
 * ---------------------------------------------------------------------------------------- */
function buildStudioEnvironment(keyDir, rimDir) {
  const env = new THREE.Scene();
  const disposables = [];
  const sphere = new THREE.SphereGeometry(30, 48, 24);
  const col = new Float32Array(sphere.attributes.position.count * 3);
  const top = new THREE.Color('#FFF2E4').multiplyScalar(1.15);
  const mid = new THREE.Color('#F6C8A2').multiplyScalar(0.95);
  const low = new THREE.Color('#D99A6E').multiplyScalar(0.42);
  const c = new THREE.Color();
  for (let i = 0; i < sphere.attributes.position.count; i++) {
    const y = sphere.attributes.position.getY(i) / 30;
    if (y > 0) c.copy(mid).lerp(top, sstep(0.0, 0.8, y)); else c.copy(mid).lerp(low, sstep(0.0, 0.5, -y));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  sphere.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const roomMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  env.add(new THREE.Mesh(sphere, roomMat));
  disposables.push(sphere, roomMat);
  const panel = new THREE.PlaneGeometry(1, 1);
  disposables.push(panel);
  const addBox = (dir, dist, w, h, color, intensity) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(panel, m);
    mesh.position.copy(dir).normalize().multiplyScalar(dist);
    mesh.lookAt(0, 0, 0);
    mesh.scale.set(w, h, 1);
    env.add(mesh);
    disposables.push(m);
  };
  addBox(keyDir, 16, 9, 7, '#FFF0DC', 7);                                   // key softbox
  addBox(rimDir, 16, 4, 10, '#FFD7A8', 6);                                   // rim strip
  addBox(new THREE.Vector3(0, 1, 0.15), 15, 10, 10, '#FFF6EC', 2.2);         // overhead
  addBox(new THREE.Vector3(0.7, 0.25, 1), 16, 8, 4, '#FFFFFF', 1.6);         // front-right bounce card
  addBox(new THREE.Vector3(-1, 0.15, -0.4), 16, 6, 5, '#FFE6CC', 1.2);       // left fill
  return { scene: env, dispose: () => disposables.forEach((d) => d.dispose()) };
}

/* ------------------------------------------------------------------------------------------
 * mountHero
 * ---------------------------------------------------------------------------------------- */
function hasWebGL2() {
  try {
    if (!window.WebGL2RenderingContext) return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    return true;
  } catch (e) {
    return false;
  }
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

export async function mountHero(host, { getProgress = () => 0, reducedMotion = false, frozen = null } = {}) {
  if (!hasWebGL2()) throw new Error('webgl-unavailable');

  const canvas = document.createElement('canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('webgl-unavailable');
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  /* ---------- scene, environment, lights ---------- */
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(22, 1, 0.5, 200);

  const key = new THREE.DirectionalLight(new THREE.Color('#FFE2BF'), 2.9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.04;
  key.shadow.radius = 6;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 60;
  scene.add(key, key.target);
  const KEY_DIR = new THREE.Vector3(-4.6, 7.4, 4.4).normalize();

  const rim = new THREE.DirectionalLight(new THREE.Color('#FFC88E'), 3.0);
  scene.add(rim, rim.target);
  const RIM_DIR = new THREE.Vector3(5.2, 3.6, -5.6).normalize();

  const fill = new THREE.DirectionalLight(new THREE.Color('#FFF1E0'), 0.4);
  scene.add(fill, fill.target);
  const FILL_DIR = new THREE.Vector3(5, 1.6, 7).normalize();

  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = buildStudioEnvironment(KEY_DIR, RIM_DIR);
  const envRT = pmrem.fromScene(studio.scene, 0.035);
  studio.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.5;

  const hemi = new THREE.HemisphereLight(new THREE.Color('#FFF5EA'), new THREE.Color('#E9B48C'), 0.24);
  scene.add(hemi);

  /* ---------- pancakes ---------- */
  const pk = [];
  for (let i = 0; i < N; i++) pk.push(makePancakeParams(i));
  // landed stack
  let base = PLATE_TOP + 0.002;
  for (const P of pk) {
    P.land = { bottom: base, x: P.lx, z: P.lz, rotY: P.rotY, rx: P.lrx, rz: P.lrz };
    P.land.y = base + P.T / 2;
    base += P.h;
  }
  const STACK_TOP = base;           // top of the final stack (approx. rim level of top pancake)
  for (const P of pk) P.y0 = P.land.y + CLEAR + descent(dropStart(P.i));

  const crumbTex = track(new THREE.CanvasTexture(makeCrumbTexture()));
  crumbTex.wrapS = crumbTex.wrapT = THREE.RepeatWrapping;
  crumbTex.colorSpace = THREE.NoColorSpace;
  crumbTex.anisotropy = maxAniso;

  const pancakeMeshes = [];
  for (const P of pk) {
    const geo = track(buildPancakeGeometry(P));
    const tx = makeTopTextures(P);
    await nextTick();
    const map = track(new THREE.CanvasTexture(tx.map));
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = maxAniso;
    const bump = track(new THREE.CanvasTexture(tx.bump));
    bump.colorSpace = THREE.NoColorSpace; bump.anisotropy = maxAniso;
    const mat = track(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map, bumpMap: bump, bumpScale: 1.6,
      roughness: 0.56, metalness: 0,
      sheen: 0.2, sheenRoughness: 0.6, sheenColor: new THREE.Color('#FFD7A3'),
      specularIntensity: 0.5,
    }));
    const uni = {
      uCrumb: { value: crumbTex },
      uHalfT: { value: P.T / 2 },
      uCrumbCol: { value: new THREE.Color('#E8C890') },
      uCrustCol: { value: new THREE.Color('#C3823C') },
      uSeedOff: { value: new THREE.Vector2(P.so[0], P.so[1]) },
      uAOTop: { value: 0 },
      uAOBottom: { value: 0 },
    };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vObjPos;
varying vec3 vObjN;
uniform sampler2D uCrumb;
uniform float uHalfT;
uniform vec3 uCrumbCol;
uniform vec3 uCrustCol;
uniform vec2 uSeedOff;
uniform float uAOTop;
uniform float uAOBottom;`)
        .replace('#include <map_fragment>', `
vec3 nO = normalize(vObjN);
float topness = smoothstep(0.58, 0.93, abs(nO.y));
vec3 topCol = texture2D(map, vMapUv).rgb;
topCol *= nO.y < 0.0 ? vec3(0.9, 0.86, 0.8) : vec3(1.0);
float e = clamp((vObjPos.y + uHalfT) / (2.0 * uHalfT), 0.0, 1.0);
vec2 sA = vObjPos.xy * 2.3 + uSeedOff;
vec2 sB = vObjPos.zy * 2.3 + uSeedOff.yx;
float wA = abs(nO.z) + 0.001;
float wB = abs(nO.x) + 0.001;
vec4 cr = (texture2D(uCrumb, sA) * wA + texture2D(uCrumb, sB) * wB) / (wA + wB);
float crust = max(smoothstep(0.6, 0.97, e), smoothstep(0.3, 0.03, e));
vec3 sideCol = mix(uCrumbCol, uCrustCol, clamp(crust * (0.7 + 0.6 * cr.b), 0.0, 1.0));
sideCol *= 0.9 + 0.2 * cr.r;
sideCol = mix(sideCol, sideCol * vec3(0.84, 0.78, 0.7), cr.g * (1.0 - 0.8 * crust));
diffuseColor.rgb *= mix(sideCol, topCol, topness);
float ao = uAOTop * smoothstep(0.62, 1.0, e) + uAOBottom * smoothstep(0.34, 0.0, e) * (1.0 - topness);
diffuseColor.rgb *= 1.0 - 0.42 * clamp(ao, 0.0, 1.0);
`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.82, roughness, topness);')
        .replace('dHdxy_fwd(), faceDirection', 'dHdxy_fwd() * topness, faceDirection');
    };
    mat.customProgramCacheKey = () => 'peach-pancake-a';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.rotation.order = 'XZY';
    mesh.userData.uni = uni;
    scene.add(mesh);
    pancakeMeshes.push(mesh);
    P.profile = pancakeProfile(P);
  }
  const topP = pk[N - 1];
  // butter sits slightly off-centre; keep its offset in world and in the top pancake's local frame
  const BUT_OX = 0.05, BUT_OZ = -0.03;
  const butterLocal = (() => {
    const a = topP.land.rotY, ca = Math.cos(a), sa = Math.sin(a);
    return { x: BUT_OX * ca - BUT_OZ * sa, z: BUT_OX * sa + BUT_OZ * ca };
  })();

  /* ---------- plate, floor shadows ---------- */
  const plateGeo = track(new THREE.LatheGeometry(plateProfilePoints(), 128));
  const plateMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#FBF8F3'), roughness: 0.2, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.06, specularIntensity: 0.8,
  }));
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.castShadow = true; plate.receiveShadow = true;
  scene.add(plate);

  // soft contact shadows (blurred radial textures): under the plate, and on the plate under the stack
  const floorY = -0.063;
  const blobTex = track(new THREE.CanvasTexture(makeRadialTexture([[0, 1], [0.7, 0.95], [0.8, 0.62], [0.9, 0.2], [1, 0]])));
  const softTex = track(new THREE.CanvasTexture(makeRadialTexture([[0, 1], [0.3, 0.8], [0.6, 0.35], [0.85, 0.08], [1, 0]])));
  const aoTex = track(new THREE.CanvasTexture(makeRadialTexture([[0, 1], [0.74, 0.92], [0.8, 0.62], [0.9, 0.2], [1, 0]])));
  const planeGeo = track(new THREE.PlaneGeometry(1, 1));
  const blobMesh = (tex, color, opacity, y, order, offset = false) => {
    const m = new THREE.Mesh(planeGeo, track(new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), alphaMap: tex, transparent: true, opacity, depthWrite: false,
      polygonOffset: offset, polygonOffsetFactor: offset ? -2 : 0, polygonOffsetUnits: offset ? -2 : 0,
    })));
    m.rotation.x = -Math.PI / 2; m.position.y = y; m.renderOrder = order;
    scene.add(m);
    return m;
  };
  const floorBlob = blobMesh(blobTex, '#6E3A1A', 0.55, floorY, 1);
  floorBlob.scale.set(4.35, 4.25, 1);
  floorBlob.position.set(0.08, floorY, -0.05);
  const floorSoft = blobMesh(softTex, '#94522A', 0.3, floorY + 0.0005, 1);
  floorSoft.scale.set(6.2, 5.2, 1);
  floorSoft.position.set(0.55, floorY + 0.0005, -0.35);
  const plateAO = blobMesh(aoTex, '#8A5A34', 0.5, PLATE_TOP + 0.0012, 2, true);
  const plateSoft = blobMesh(softTex, '#8A5A36', 0.15, PLATE_TOP + 0.001, 2, true);
  plateSoft.scale.set(2.7, 2.7, 1);

  /* ---------- syrup material ---------- */
  const syrupMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.08, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.025, ior: 1.47, specularIntensity: 1,
    transmission: 0.55, thickness: 0.06, attenuationColor: new THREE.Color('#C8661A'), attenuationDistance: 0.14,
    emissive: new THREE.Color('#1E0800'),
  }));
  const syrupUni = {
    uThin: { value: new THREE.Color('#E6A242') },
    uThick: { value: new THREE.Color('#9A4410') },
  };
  syrupMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, syrupUni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aThick;\nvarying float vThick;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvThick = aThick;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vThick;\nuniform vec3 uThin;\nuniform vec3 uThick;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(uThin, uThick, smoothstep(0.0, 1.0, vThick));')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uThin * 0.12 * (1.0 - smoothstep(0.0, 0.8, vThick));');
  };
  syrupMat.customProgramCacheKey = () => 'peach-syrup-a';

  // pool of syrup on top of the stack: child of the top pancake so it sits in its local frame
  const capGeo = track(makeBlobGeometry(24, 112));
  const cap = new THREE.Mesh(capGeo, syrupMat);
  cap.receiveShadow = true;
  cap.frustumCulled = false;
  pancakeMeshes[N - 1].add(cap);

  // drips (world space)
  const DRIPS = [
    // yEnd is a fraction of the stack height; null = runs all the way down and pools on the plate
    { phi: 0.08, w: 0.095, yEnd: null, start: 0.872 },
    { phi: 0.7, w: 0.072, yEnd: 0.62, start: 0.884 },
    { phi: -0.55, w: 0.082, yEnd: 0.36, start: 0.878 },
    { phi: 1.24, w: 0.064, yEnd: 0.8, start: 0.895 },
    { phi: -1.28, w: 0.085, yEnd: 0.52, start: 0.889 },
    { phi: 1.86, w: 0.06, yEnd: 0.84, start: 0.905 },
  ];
  const DR_R = 64, DR_S = 16;
  const dripGeo = track(new THREE.BufferGeometry());
  {
    const nv = DRIPS.length * DR_R * DR_S;
    dripGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    dripGeo.setAttribute('aThick', new THREE.BufferAttribute(new Float32Array(nv), 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let d = 0; d < DRIPS.length; d++) {
      const o = d * DR_R * DR_S;
      for (let r = 0; r < DR_R - 1; r++) for (let s = 0; s < DR_S; s++) {
        const a = o + r * DR_S + s, b = o + r * DR_S + ((s + 1) % DR_S);
        const c = o + (r + 1) * DR_S + ((s + 1) % DR_S), dd = o + (r + 1) * DR_S + s;
        idx.push(a, dd, b, b, dd, c);
      }
    }
    dripGeo.setIndex(idx);
  }
  const drips = new THREE.Mesh(dripGeo, syrupMat);
  drips.receiveShadow = true;
  drips.frustumCulled = false;
  scene.add(drips);

  // precompute each drip's path down the final stack (r, y in the drip's vertical plane)
  for (const D of DRIPS) {
    const raw = [];
    const dx = Math.sin(D.phi), dz = Math.cos(D.phi);
    for (let j = N - 1; j >= 0; j--) {
      const P = pk[j], L = P.land;
      const pl = D.phi - L.rotY;
      const f = outline(P, pl);
      const c = L.x * dx + L.z * dz;
      const hb = P.T / 2;
      const rStart = j === N - 1 ? P.R - P.ct - 0.3 : P.R - P.ct * 0.7;
      const prof = P.profile;
      let started = false;
      for (let q = prof.length - 1; q >= 0; q--) {
        const [r, y] = prof[q];
        if (!started) { if (r >= rStart) started = true; else continue; }
        if (y < -hb + CB_Y * P.T * 0.35 && r < P.R - 0.01) break;
        const rr = r * f;
        const up = clamp(y / hb);
        const yy = y + up * up * topNoise(P, rr * Math.sin(pl), rr * Math.cos(pl));
        raw.push([rr + c, L.y + yy]);
      }
    }
    // onto the plate
    const last = raw[raw.length - 1];
    for (let k = 0; k <= 16; k++) { const r = last[0] + 0.012 + k * 0.03; raw.push([r, plateTopY(r) + 0.0]); }
    // resample by arc length
    const pts = [raw[0]];
    const ds = 0.008;
    let acc = 0;
    for (let i = 1; i < raw.length; i++) {
      const [r0, y0] = raw[i - 1], [r1, y1] = raw[i];
      const seg = Math.hypot(r1 - r0, y1 - y0);
      let pos = ds - acc;
      while (pos <= seg) { const k = pos / seg; pts.push([lerp(r0, r1, k), lerp(y0, y1, k)]); pos += ds; }
      acc = seg - (pos - ds);
    }
    // bridge the grooves between pancakes and smooth (only on the vertical side part)
    const yTopMid = topP.land.y;
    const n = pts.length;
    const r0 = pts.map((p) => p[0]);
    const r1 = r0.slice();
    for (let i = 0; i < n; i++) {
      const y = pts[i][1];
      if (y > yTopMid || y < 0.012) continue;
      let m = r0[i];
      for (let k = -8; k <= 8; k++) { const q = i + k; if (q >= 0 && q < n && pts[q][1] <= yTopMid + 0.02 && pts[q][1] > 0.005) m = Math.max(m, r0[q]); }
      r1[i] = m;
    }
    const r2 = r1.slice();
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let k = -6; k <= 6; k++) { const q = i + k; if (q >= 0 && q < n) { sum += r1[q]; cnt++; } }
      r2[i] = sum / cnt;
    }
    const path = { s: new Float32Array(n), r: new Float32Array(n), y: new Float32Array(n), nr: new Float32Array(n), ny: new Float32Array(n), gr: new Float32Array(n) };
    let sAcc = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) sAcc += Math.hypot(r2[i] - r2[i - 1], pts[i][1] - pts[i - 1][1]);
      path.s[i] = sAcc; path.r[i] = r2[i]; path.y[i] = pts[i][1]; path.gr[i] = Math.max(0, r2[i] - r0[i]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
      let tr = path.r[b] - path.r[a], ty = path.y[b] - path.y[a];
      const l = Math.hypot(tr, ty) || 1; tr /= l; ty /= l;
      path.nr[i] = -ty; path.ny[i] = tr;
    }
    D.path = path; D.dx = dx; D.dz = dz;
    // where the visible run starts (the corner of the top pancake) and where it ends
    let sCorner = 0;
    for (let i = 0; i < n; i++) if (path.r[i] >= topP.R * 0.9 + topP.land.x * dx + topP.land.z * dz) { sCorner = path.s[i]; break; }
    D.sCorner = sCorner;
    let sBottom = path.s[n - 1];
    for (let i = 0; i < n; i++) if (path.y[i] < 0.02 && path.s[i] > sCorner) { sBottom = path.s[i]; break; }
    D.sBottom = sBottom;
    if (D.yEnd == null) D.sEnd = sBottom + 0.22;
    else { D.sEnd = sBottom; for (let i = 0; i < n; i++) if (path.y[i] < D.yEnd * STACK_TOP && path.s[i] > sCorner) { D.sEnd = path.s[i]; break; } }
    D.pool = D.yEnd == null;
    D.localPhi = D.phi - topP.land.rotY;
  }

  // puddle on the plate at the foot of the long drip
  const poolGeo = track(makeBlobGeometry(12, 64));
  const pool = new THREE.Mesh(poolGeo, syrupMat);
  pool.receiveShadow = true; pool.frustumCulled = false;
  scene.add(pool);
  const poolDrip = DRIPS.find((d) => d.pool);
  {
    const i = poolDrip.path.s.findIndex((s) => s >= poolDrip.sBottom);
    poolDrip.poolR = poolDrip.path.r[Math.max(0, i)] + 0.1;
  }

  // pouring stream
  const ST_R = 48, ST_S = 14;
  const streamGeo = track(new THREE.BufferGeometry());
  {
    streamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ST_R * ST_S * 3), 3).setUsage(THREE.DynamicDrawUsage));
    streamGeo.setAttribute('aThick', new THREE.BufferAttribute(new Float32Array(ST_R * ST_S).fill(0.6), 1));
    const idx = [];
    for (let r = 0; r < ST_R - 1; r++) for (let s = 0; s < ST_S; s++) {
      const a = r * ST_S + s, b = r * ST_S + ((s + 1) % ST_S), c = (r + 1) * ST_S + ((s + 1) % ST_S), d = (r + 1) * ST_S + s;
      idx.push(a, d, b, b, d, c);
    }
    streamGeo.setIndex(idx);
  }
  const stream = new THREE.Mesh(streamGeo, syrupMat);
  stream.frustumCulled = false;
  scene.add(stream);

  /* ---------- butter ---------- */
  let butterGeo = new RoundedBoxGeometry(0.44, 0.2, 0.35, 4, 0.06);
  butterGeo.deleteAttribute('normal'); butterGeo.deleteAttribute('uv');
  const bg2 = mergeVertices(butterGeo); butterGeo.dispose(); butterGeo = track(bg2);
  const butterBase = butterGeo.attributes.position.array.slice();
  butterGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
  butterGeo.computeVertexNormals();
  const butterMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#F6D47A'), roughness: 0.3, metalness: 0,
    sheen: 0.3, sheenColor: new THREE.Color('#FFF0B8'), sheenRoughness: 0.4,
    clearcoat: 0.4, clearcoatRoughness: 0.2, emissive: new THREE.Color('#221600'),
  }));
  const butter = new THREE.Mesh(butterGeo, butterMat);
  butter.castShadow = true; butter.receiveShadow = true;
  butter.rotation.order = 'XZY';
  scene.add(butter);
  const BUTTER_H = 0.2;

  /* ---------- blueberries ---------- */
  let berryGeo = new THREE.IcosahedronGeometry(1, 5);
  berryGeo.deleteAttribute('normal'); berryGeo.deleteAttribute('uv');
  { const m = mergeVertices(berryGeo); berryGeo.dispose(); berryGeo = track(m); }
  {
    const p = berryGeo.attributes.position, n = p.count;
    const colors = new Float32Array(n * 3);
    const cBody = new THREE.Color('#2B3160'), cBloom = new THREE.Color('#5E6A98'), cCrown = new THREE.Color('#2A1C28'), cRing = new THREE.Color('#6F6C8C');
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      const c = sstep(0.8, 0.97, y);
      const star = 0.5 + 0.5 * Math.cos(5 * Math.atan2(x, z));
      const rad = 1 - c * (0.13 + 0.07 * star) + (fbm(x * 3 + 4, z * 3 + y * 2, 55, 2) - 0.5) * 0.04;
      p.setXYZ(i, x * rad, y * rad * 0.86, z * rad);
      const bl = fbm(x * 2.2 + 1, y * 2.2 + z * 1.3, 56, 3);
      tmp.copy(cBody).lerp(cBloom, sstep(0.45, 0.75, bl) * 0.7);
      tmp.lerp(cRing, sstep(0.66, 0.8, y) * (1 - sstep(0.86, 0.93, y)) * 0.6);
      tmp.lerp(cCrown, sstep(0.86, 0.93, y));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    berryGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    berryGeo.computeVertexNormals();
  }
  const berryMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.48, metalness: 0,
    sheen: 1, sheenColor: new THREE.Color('#B9C3E2'), sheenRoughness: 0.42, specularIntensity: 0.55,
  }));
  // rest spots: 5 on the top pool around the butter (top pancake local polar), 4 on the plate (world polar)
  // a = world angle (0 = toward camera, +PI/2 = right)
  const BERRIES = [
    { top: true, r: 0.56, a: 0.42 },
    { top: true, r: 0.66, a: 0.9 },
    { top: true, r: 0.5, a: -0.55 },
    { top: true, r: 0.6, a: 2.55 },
    { top: true, r: 0.55, a: -2.3 },
    { top: false, r: 1.25, a: 0.6 },
    { top: false, r: 1.29, a: 0.93 },
    { top: false, r: 1.24, a: -0.66 },
    { top: false, r: 1.31, a: 1.5 },
  ];
  {
    const rnd = mulberry32(4242);
    BERRIES.forEach((b, i) => {
      b.size = 0.074 + rnd() * 0.014;
      b.start = 0.868 + i * 0.0072 + rnd() * 0.004;
      b.q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * TAU, rnd() * TAU, rnd() * TAU));
      b.q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.3) * 0.9, rnd() * TAU, (rnd() - 0.5) * 0.9, 'YXZ'));
      b.tint = 0.86 + rnd() * 0.22;
    });
  }
  const BERRY_FALL = 0.036;
  const berries = new THREE.InstancedMesh(berryGeo, berryMat, BERRIES.length);
  berries.castShadow = true; berries.receiveShadow = true;
  berries.frustumCulled = false;
  BERRIES.forEach((b, i) => berries.setColorAt(i, new THREE.Color(b.tint, b.tint, b.tint)));
  scene.add(berries);

  /* ------------------------------------------------------------------------------------------
   * Per-frame state (pure functions of p, t)
   * ---------------------------------------------------------------------------------------- */
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(), tmpS = new THREE.Vector3();

  function posePancake(i, p, t, idle, mesh) {
    const P = pk[i], L = P.land;
    const s = dropStart(i), land = s + FALL;
    const k = clamp((p - s) / FALL);
    const ia = idle ? 1 - k : 0;
    const bob = Math.sin(t * 0.85 + P.ph1) * 0.045 * ia;
    const wobX = Math.sin(t * 0.63 + P.ph2) * 2.4 * DEG * ia;
    const wobZ = Math.sin(t * 0.71 + P.ph3) * 2.4 * DEG * ia;
    const spin = Math.sin(t * 0.13 + P.ph1) * 0.35 * ia;
    const driftX = Math.sin(t * 0.37 + P.ph3) * 0.03 * ia;
    const yFloat = P.y0 - descent(p);
    const tiltK = 1 - sstep(0, 0.86, k);
    const hk = sstep(0, 1, k);
    let sy = 1, sxz = 1, yc;
    if (p < land) {
      yc = lerp(yFloat, L.y, easeInQuad(k)) + bob;
    } else {
      const sq = squashCurve(clamp((p - land) / SQUASH));
      sy = 1 - 0.1 * sq; sxz = 1 + 0.045 * sq;
      yc = L.bottom + P.T * 0.5 * sy;
    }
    mesh.position.set(lerp(P.fx, L.x, hk) + driftX, yc, lerp(P.fz, L.z, hk));
    mesh.rotation.set(lerp(L.rx, P.trx, tiltK) + wobX, L.rotY + P.spinIn * (1 - hk) + spin, lerp(L.rz, P.trz, tiltK) + wobZ);
    mesh.scale.set(sxz, sy, sxz);
  }

  // syrup pool on top: radius per local angle
  function capRadius(phi, p) {
    const P = topP;
    const bloom = easeOutCubic(clamp((p - (SYRUP_IN + 0.012)) / 0.1));
    const edge = P.R * outline(P, phi);
    let rr = lerp(0.1, (P.R - P.ct) * 0.98, bloom) * (1 + 0.05 * Math.sin(3 * phi + 1.3) + 0.035 * Math.sin(5 * phi + 0.4));
    for (const D of DRIPS) {
      let da = Math.abs(((phi - D.localPhi) % TAU + TAU) % TAU); if (da > Math.PI) da = TAU - da;
      const lobe = Math.exp(-((da / (0.07 + D.w * 1.1)) ** 2));
      const go = sstep(D.start - 0.012, D.start + 0.02, p);
      rr = lerp(rr, Math.max(rr, edge - 0.035), lobe * go);
    }
    return Math.min(rr, edge - 0.02);
  }
  const capThickC = (p) => 0.048 * sstep(SYRUP_IN + 0.004, SYRUP_IN + 0.05, p);

  // syrup thickness above the top surface at local polar (rw, phi) -- used to seat berries/butter
  function capHeightAt(rw, phi, p) {
    const thC = capThickC(p);
    if (thC <= 0) return 0;
    const rc = capRadius(phi, p);
    if (rw >= rc) return 0;
    return Math.max(0, blobThick(rw / rc, thC));
  }

  function fillDrip(d, D, p) {
    const pos = dripGeo.attributes.position.array, th = dripGeo.attributes.aThick.array;
    const o = d * DR_R * DR_S;
    const g = easeOutCubic(clamp((p - D.start) / (1.0 - D.start)));
    const path = D.path, n = path.s.length;
    const s0 = Math.max(0, D.sCorner - 0.26);
    const sEnd = lerp(D.sCorner - 0.06, D.sEnd, g);
    if (p < D.start || sEnd <= s0 + 0.02) {
      for (let i = o; i < o + DR_R * DR_S; i++) { pos[i * 3] = 0; pos[i * 3 + 1] = -5; pos[i * 3 + 2] = 0; th[i] = 0; }
      return;
    }
    const len = sEnd - s0;
    const fullLen = D.sEnd - s0;
    const bx = Math.cos(D.phi), bz = -Math.sin(D.phi);
    const Rb = D.w * (0.7 + 0.3 * g);
    let pi = 0;
    for (let r = 0; r < DR_R; r++) {
      const u = r / (DR_R - 1);
      const s = s0 + len * (1 - Math.pow(1 - u, 1.7));
      while (pi < n - 2 && path.s[pi + 1] < s) pi++;
      const k = clamp((s - path.s[pi]) / Math.max(1e-6, path.s[pi + 1] - path.s[pi]));
      const rr = lerp(path.r[pi], path.r[pi + 1], k), yy = lerp(path.y[pi], path.y[pi + 1], k);
      let nr = lerp(path.nr[pi], path.nr[pi + 1], k), ny = lerp(path.ny[pi], path.ny[pi + 1], k);
      const nl = Math.hypot(nr, ny) || 1; nr /= nl; ny /= nl;
      const along = (s - s0) / fullLen;
      const groove = lerp(path.gr[pi], path.gr[pi + 1], k);
      let a = D.w * (1.15 - 0.5 * along) * (1 + 1.1 * Math.exp(-Math.max(0, s - D.sCorner + 0.03) / 0.09));
      a *= 1 + clamp(groove / 0.05) * 0.3;
      const x = sEnd - s;
      const neck = 1 - 0.28 * Math.exp(-(((x - 2.3 * Rb) / (0.9 * Rb)) ** 2));
      a *= neck;
      let bulb = 0;
      if (x < 2 * Rb) { const q = (x - Rb) / Rb; bulb = Rb * Math.sqrt(Math.max(0, 1 - q * q)); }
      if (x < Rb) a = bulb; else a = Math.max(a, bulb);
      a *= sstep(0, 0.06, s - s0);
      const bRatio = 0.34 + 0.3 * (bulb > 0 ? clamp(bulb / Rb) : 0) + 0.12 * clamp(groove / 0.05);
      const b = a * bRatio;
      // flat on the plate: wider, thinner
      const flat = sstep(0.03, 0.0, yy);
      const aa = a * (1 + 0.6 * flat), bb = b * (1 - 0.45 * flat);
      const cr = rr + nr * bb * 0.25, cy = yy + ny * bb * 0.25;
      const cx = cr * D.dx, cz = cr * D.dz;
      const Nx = nr * D.dx, Ny = ny, Nz = nr * D.dz;
      for (let sg = 0; sg < DR_S; sg++) {
        const ps = (sg / DR_S) * TAU;
        const c = Math.cos(ps), sn = Math.sin(ps);
        const vi = o + r * DR_S + sg;
        pos[vi * 3] = cx + Nx * bb * c + bx * aa * sn;
        pos[vi * 3 + 1] = cy + Ny * bb * c;
        pos[vi * 3 + 2] = cz + Nz * bb * c + bz * aa * sn;
        th[vi] = clamp(bb / 0.05);
      }
    }
  }

  function updateSyrup(p) {
    const on = p >= SYRUP_IN;
    cap.visible = on && capThickC(p) > 0.0005;
    drips.visible = on && p >= Math.min(...DRIPS.map((d) => d.start));
    stream.visible = false;
    pool.visible = false;
    if (!on) return;
    if (cap.visible) {
      const melt = sstep(BUTTER_LAND + 0.04, 1.0, p);
      const bl = butterLocal;
      fillBlob(capGeo, 0, 0, (phi) => capRadius(phi, p), capThickC(p), (x, z) => topSurfaceLocal(topP, Math.hypot(x, z), Math.atan2(x, z)), 0.05,
        (x, z, v) => v * (1 - 0.75 * melt * (1 - sstep(0.16, 0.5, Math.hypot(x - bl.x, z - bl.z)))));
    }
    if (drips.visible) {
      DRIPS.forEach((D, d) => fillDrip(d, D, p));
      dripGeo.attributes.position.needsUpdate = true;
      dripGeo.attributes.aThick.needsUpdate = true;
      dripGeo.computeVertexNormals();
    }
    // puddle at the foot of the long drip
    const D = poolDrip;
    const g = easeOutCubic(clamp((p - D.start) / (1.0 - D.start)));
    const sEnd = lerp(D.sCorner - 0.06, D.sEnd, g);
    const pr = clamp((sEnd - D.sBottom) / (D.sEnd - D.sBottom));
    if (pr > 0.02) {
      pool.visible = true;
      const R0 = 0.07 + 0.2 * Math.sqrt(pr);
      const cxw = D.dx * D.poolR, czw = D.dz * D.poolR;
      fillBlob(poolGeo, cxw, czw, (phi) => R0 * (1 + 0.12 * Math.sin(3 * phi + 0.7) + 0.07 * Math.sin(5 * phi + 2.1)),
        0.024 * Math.sqrt(pr) + 0.006, (x, z) => plateTopY(Math.hypot(x, z)), 0.05);
    }
    // pouring stream
    const head = sstep(SYRUP_IN, SYRUP_IN + 0.024, p);
    const tail = sstep(0.925, 0.968, p);
    if (head > 0 && tail < 1) {
      stream.visible = true;
      const L = topP.land;
      const sx = L.x + 0.06, sz = L.z + 0.05;
      const yImp = L.y + topSurfaceLocal(topP, 0.08, 0.8) + capThickC(p) * 0.9;
      const yHigh = yImp + 7;
      const yHead = lerp(yHigh, yImp, easeInQuad(head));
      const yTail = lerp(yHigh, yImp, easeInQuad(tail));
      const pos = streamGeo.attributes.position.array;
      for (let r = 0; r < ST_R; r++) {
        const u = r / (ST_R - 1);
        const y = lerp(yTail, yHead, u);
        const hAbove = y - yImp;
        let rad = 0.028 + 0.022 * clamp(hAbove / 5);
        rad *= 1 + 0.9 * Math.exp(-Math.max(0, hAbove) / 0.05) * head;
        const toHead = (y - yHead), toTail = (yTail - y);
        rad *= Math.sqrt(clamp(toHead / 0.04)) * Math.sqrt(clamp(toTail / 0.25));
        for (let sg = 0; sg < ST_S; sg++) {
          const a = (sg / ST_S) * TAU;
          const vi = r * ST_S + sg;
          pos[vi * 3] = sx + Math.sin(a) * rad; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = sz + Math.cos(a) * rad;
        }
      }
      streamGeo.attributes.position.needsUpdate = true;
      streamGeo.computeVertexNormals();
    }
  }

  function updateButter(p) {
    butter.visible = p >= BUTTER_IN;
    if (!butter.visible) return;
    const L = topP.land;
    const ox = BUT_OX, oz = BUT_OZ;
    const ySurf = L.y + topSurfaceLocal(topP, Math.hypot(butterLocal.x, butterLocal.z), Math.atan2(butterLocal.x, butterLocal.z));
    const k = clamp((p - BUTTER_IN) / (BUTTER_LAND - BUTTER_IN));
    const sq = squashCurve(clamp((p - BUTTER_LAND) / BUTTER_SQ));
    const melt = sstep(BUTTER_LAND + 0.01, 1.0, p);
    const sy = 1 - 0.16 * sq, sxz = 1 + 0.07 * sq;
    const pos = butterGeo.attributes.position.array;
    const hy = BUTTER_H / 2;
    for (let i = 0; i < pos.length; i += 3) {
      const x = butterBase[i], y = butterBase[i + 1], z = butterBase[i + 2];
      const yn = (y + hy) / BUTTER_H;
      const spread = 1 + melt * (0.2 * (1 - yn) * (1 - yn) + 0.05);
      const rxz = Math.hypot(x / 0.22, z / 0.175);
      let ny = -hy + (y + hy) * (1 - 0.3 * melt);
      ny -= melt * 0.035 * Math.pow(clamp(rxz), 4) * yn;
      pos[i] = x * spread; pos[i + 1] = ny; pos[i + 2] = z * spread;
    }
    butterGeo.attributes.position.needsUpdate = true;
    butterGeo.computeVertexNormals();
    const restY = ySurf + hy * sy - 0.006 - 0.01 * melt;
    const y = lerp(restY + 2.6, restY, easeInQuad(k));
    butter.position.set(L.x + ox, y, L.z + oz);
    const tumble = 1 - sstep(0, 0.9, k);
    butter.rotation.set(0.5 * tumble, L.rotY + 0.6 + 0.8 * tumble, -0.35 * tumble);
    butter.scale.set(sxz, sy, sxz);
  }

  function updateBerries(p) {
    const L = topP.land;
    let any = false;
    BERRIES.forEach((b, i) => {
      const k = clamp((p - b.start) / BERRY_FALL);
      const vis = p >= b.start;
      let x, z, yRest;
      if (b.top) {
        const al = b.a - L.rotY;
        x = L.x + b.r * Math.sin(b.a); z = L.z + b.r * Math.cos(b.a);
        yRest = L.y + topSurfaceLocal(topP, b.r, al) + capHeightAt(b.r, al, p) + b.size * 0.78;
      } else {
        x = b.r * Math.sin(b.a); z = b.r * Math.cos(b.a);
        yRest = plateTopY(b.r) + b.size * 0.8;
      }
      let y = lerp(yRest + 2.4, yRest, easeInQuad(k));
      if (p > b.start + BERRY_FALL) {
        const q = clamp((p - b.start - BERRY_FALL) / 0.022);
        y = yRest + 0.05 * Math.abs(Math.sin(q * Math.PI * 2)) * (1 - q) * (1 - q);
      }
      tmpQ.copy(b.q0).slerp(b.q1, sstep(0.2, 1, k));
      tmpS.setScalar(vis ? b.size : 0.00001);
      tmpV.set(x, vis ? y : -10, z);
      tmpM.compose(tmpV, tmpQ, tmpS);
      berries.setMatrixAt(i, tmpM);
      any = any || vis;
    });
    berries.instanceMatrix.needsUpdate = true;
    berries.visible = any;
  }

  /* ---------- framing ---------- */
  const REGIONS = {
    d0: { x0: 0.47, x1: 0.9, y0: 0.08, y1: 0.92 },
    d1: { x0: 0.48, x1: 0.9, y0: 0.15, y1: 0.9 },
    m0: { x0: 0.07, x1: 0.93, y0: 0.4, y1: 0.95 },
    m1: { x0: 0.05, x1: 0.95, y0: 0.42, y1: 0.94 },
  };
  const fitPts = Array.from({ length: 40 }, () => new THREE.Vector3());
  const camTarget = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const lastTopP = pk[N - 1];
  const FINAL_TOP = STACK_TOP + 0.22;
  function frameTop(p) {
    const col = lastTopP.y0 - descent(p) + lastTopP.T / 2 + 0.34;
    return smax(col, FINAL_TOP, 0.35);
  }
  let frameKey = '';
  function frameCamera(p, W, H) {
    const key2 = `${p.toFixed(5)}|${W}|${H}`;
    if (key2 === frameKey) return;
    frameKey = key2;
    const aspect = W / H, mobile = aspect < 1.1;
    const kk = sstep(0, 0.78, p);
    const A = mobile ? REGIONS.m0 : REGIONS.d0, B = mobile ? REGIONS.m1 : REGIONS.d1;
    const x0 = lerp(A.x0, B.x0, kk), x1 = lerp(A.x1, B.x1, kk), y0 = lerp(A.y0, B.y0, kk), y1 = lerp(A.y1, B.y1, kk);
    const top = frameTop(p);
    let n = 0;
    for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; fitPts[n++].set(Math.sin(a) * PLATE_R, 0.11, Math.cos(a) * PLATE_R); }
    for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + 0.4; fitPts[n++].set(Math.sin(a) * 1.0, floorY, Math.cos(a) * 1.0); }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; fitPts[n++].set(Math.sin(a) * 1.18, top, Math.cos(a) * 1.18); }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; fitPts[n++].set(Math.sin(a) * 1.3, 0.1 + (top - 0.1) * 0.55, Math.cos(a) * 1.3); }
    const elev = lerp(8, 27, sstep(0.04, 0.9, p)) * DEG;
    camera.fov = mobile ? 26 : 22;
    camera.aspect = aspect;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camTarget.set(0, top * 0.5, 0);
    camDir.set(0, Math.sin(elev), Math.cos(elev));
    const rw = 2 * (x1 - x0), rh = 2 * (y1 - y0);
    const bb = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const measure = (d) => {
      camera.position.copy(camTarget).addScaledVector(camDir, d);
      camera.lookAt(camTarget);
      camera.updateMatrixWorld(true);
      bb.x0 = bb.y0 = Infinity; bb.x1 = bb.y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        tmpV.copy(fitPts[i]).project(camera);
        if (tmpV.x < bb.x0) bb.x0 = tmpV.x; if (tmpV.x > bb.x1) bb.x1 = tmpV.x;
        if (tmpV.y < bb.y0) bb.y0 = tmpV.y; if (tmpV.y > bb.y1) bb.y1 = tmpV.y;
      }
      return (bb.x1 - bb.x0) <= rw && (bb.y1 - bb.y0) <= rh;
    };
    let lo = 2, hi = 160;
    for (let it = 0; it < 28; it++) { const mid = 0.5 * (lo + hi); if (measure(mid)) hi = mid; else lo = mid; }
    measure(hi);
    const cx = 0.5 * (bb.x0 + bb.x1), cy = 0.5 * (bb.y0 + bb.y1);
    const dx = (x0 + x1) - 1, dy = 1 - (y0 + y1);
    camera.setViewOffset(W, H, -(dx - cx) * W / 2, (dy - cy) * H / 2, W, H);
    // lights follow the subject
    const ext = 0.5 * Math.hypot(top + 0.4, 2 * PLATE_R) + 0.6;
    key.target.position.copy(camTarget);
    key.position.copy(camTarget).addScaledVector(KEY_DIR, 20);
    const sc = key.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
    sc.updateProjectionMatrix();
    rim.target.position.copy(camTarget); rim.position.copy(camTarget).addScaledVector(RIM_DIR, 20);
    fill.target.position.copy(camTarget); fill.position.copy(camTarget).addScaledVector(FILL_DIR, 20);
  }

  function updateScene(p, t, W, H) {
    for (let i = 0; i < N; i++) posePancake(i, p, t, true, pancakeMeshes[i]);
    // contact occlusion in the seams once pancakes rest on each other
    for (let i = 0; i < N; i++) {
      const u = pancakeMeshes[i].userData.uni;
      const landedSelf = sstep(dropStart(i) + FALL * 0.8, dropStart(i) + FALL, p);
      const landedAbove = i < N - 1 ? sstep(dropStart(i + 1) + FALL * 0.8, dropStart(i + 1) + FALL, p) : 0;
      u.uAOBottom.value = landedSelf;
      u.uAOTop.value = landedAbove;
    }
    // plate AO: soft and faint while the column floats, tight once the stack sits on it
    const landed0 = sstep(dropStart(0) + FALL - 0.006, dropStart(0) + FALL + 0.012, p);
    // the lowest airborne pancake darkens the plate as it approaches
    const near0 = sstep(dropStart(0), dropStart(0) + FALL, p);
    plateSoft.material.opacity = lerp(0.1, 0.2, near0) * (1 - 0.5 * landed0);
    plateAO.material.opacity = 0.42 * landed0;
    plateAO.visible = landed0 > 0;
    plateAO.scale.set(2.62, 2.62, 1);
    plateAO.position.set(pk[0].land.x, PLATE_TOP + 0.0012, pk[0].land.z);
    updateButter(p);
    updateSyrup(p);
    updateBerries(p);
    frameCamera(p, W, H);
  }

  /* ------------------------------------------------------------------------------------------
   * Sizing, rendering, loop
   * ---------------------------------------------------------------------------------------- */
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  host.appendChild(canvas);

  let W = 0, H = 0;
  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === W && h === H) return false;
    W = w; H = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, w < 700 ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    frameKey = '';
    return true;
  }

  let lastRendered = null;
  function renderAt(p, t = 0) {
    p = clamp(Number.isFinite(p) ? p : 0);
    if (!W || !H) resize();
    updateScene(p, t, W, H);
    renderer.render(scene, camera);
    lastRendered = { p, t };
    if (!window.__heroReady) window.__heroReady = true;
  }

  const mode = frozen ? 'frozen' : reducedMotion ? 'reduced' : 'live';
  const staticFrame = () => (frozen ? [clamp(frozen.p), frozen.t ?? 2] : [1, 0]);

  let raf = 0, running = false, visible = true, destroyed = false;
  let clock = 0, lastNow = 0, lastP = -1, dirty = true;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    clock += dt;
    let p = 0;
    try { p = clamp(Number(getProgress()) || 0); } catch (e) { p = 0; }
    // once everything has landed the scene depends on p only, so skip identical frames
    if (!dirty && p === lastP && p >= LAST_LAND) return;
    dirty = false; lastP = p;
    renderAt(p, clock);
  }
  function start() {
    if (running || destroyed || mode !== 'live') return;
    running = true; lastNow = 0; dirty = true;
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  function syncLoop() {
    if (visible && !document.hidden) start(); else stop();
  }

  const ro = new ResizeObserver(() => {
    if (destroyed) return;
    if (resize()) {
      dirty = true;
      if (mode !== 'live') { const [p, t] = staticFrame(); renderAt(p, t); }
    }
  });
  ro.observe(host);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible = e.isIntersecting;
    syncLoop();
  }, { threshold: 0 });
  io.observe(host);
  const onVis = () => syncLoop();
  document.addEventListener('visibilitychange', onVis);

  resize();
  if (mode === 'live') {
    renderAt(clamp(Number(getProgress()) || 0), 0);
    syncLoop();
  } else {
    const [p, t] = staticFrame();
    renderAt(p, t);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    ro.disconnect();
    io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    for (const d of disposables) d.dispose && d.dispose();
    berries.dispose();
    if (key.shadow.map) key.shadow.map.dispose();
    envRT.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  return { renderAt, destroy };
}
