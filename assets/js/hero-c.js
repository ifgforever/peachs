// Hero variant C: "Peach Bourbon Pop".
// Pancakes and fresh peach slices hang in the air over a vivid peach backdrop,
// drop one at a time into a bouncy stack, get a pat of butter, a glossy peach
// bourbon compote with diced peaches, and a crown of lemon cream-cheese frosting
// (a nod to Peach's 7-Up pancakes).
//
// Contract: mountHero(host, { getProgress, reducedMotion, frozen }) -> { renderAt, destroy }
// Scene state is a pure function of (p, t); every random choice is seeded.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* ------------------------------------------------------------------ utils */
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const easeInQuad = (t) => t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const span = (p, a, b) => clamp((p - a) / (b - a));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded 2D value noise, optionally periodic (integer periods) for tileable textures.
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = rnd();
  return (x, y, px = 4096, py = 4096) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = val[perm[perm[x0 & 255] + (y0 & 255)]], b = val[perm[perm[x1 & 255] + (y0 & 255)]];
    const c = val[perm[perm[x0 & 255] + (y1 & 255)]], d = val[perm[perm[x1 & 255] + (y1 & 255)]];
    const ab = a + (b - a) * u, cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  };
}
function fbm(n, x, y, oct = 4, px = 4096, py = 4096) {
  let s = 0, a = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { s += a * n(x * f, y * f, px * f, py * f); norm += a; a *= 0.5; f *= 2; }
  return s / norm;
}

function dataTexture(data, w, h, srgb, wrap = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

// Piecewise-linear colour ramp over [0,1]; stops = [[pos, r, g, b], ...]
function ramp(stops, x) {
  if (x <= stops[0][0]) return stops[0];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], t = (x - a[0]) / (b[0] - a[0]);
      return [0, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return stops[stops.length - 1];
}

// Stamp small discs into a float field (pores, specks).
function stamp(field, size, cx, cy, rad, fn, wrapX = false) {
  const R = Math.ceil(rad * 1.8) + 1;
  for (let yy = -R; yy <= R; yy++) {
    for (let xx = -R; xx <= R; xx++) {
      let X = Math.round(cx + xx);
      const Y = Math.round(cy + yy);
      if (Y < 0 || Y >= size[1]) continue;
      if (wrapX) X = ((X % size[0]) + size[0]) % size[0];
      else if (X < 0 || X >= size[0]) continue;
      let dx = X - cx;
      if (wrapX) { if (dx > size[0] / 2) dx -= size[0]; if (dx < -size[0] / 2) dx += size[0]; }
      const d = Math.sqrt(dx * dx + (Y - cy) * (Y - cy)) / rad;
      fn(Y * size[0] + X, d);
    }
  }
}

/* --------------------------------------------------------------- textures */
const PAN_UV_SCALE = 2.3; // planar UV covers a 2.3 x 2.3 square (pancake radius ~1)

// Golden-brown pancake face: mottled + lacy browning, pale outer ring, bubble pores.
function pancakeFaceTextures(seed, size = 512) {
  const rnd = mulberry32(seed);
  const n1 = makeNoise(seed + 11), n2 = makeNoise(seed + 23), n3 = makeNoise(seed + 37), n4 = makeNoise(seed + 41);
  const N = size * size;
  const B = new Float32Array(N); // browning 0..1
  const H = new Float32Array(N); // height 0..1
  const doneness = 0.5 + rnd() * 0.16;
  const lacy = 0.35 + rnd() * 0.55;
  const spotty = 0.6 + rnd() * 0.6;
  const ox = rnd() * 50, oy = rnd() * 50;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const dx = (u - 0.5) * PAN_UV_SCALE, dz = (v - 0.5) * PAN_UV_SCALE;
      const r = Math.sqrt(dx * dx + dz * dz);
      const m = fbm(n1, u * 4.5 + ox, v * 4.5 + oy, 4);
      const m2 = fbm(n2, u * 13 + ox, v * 13 + oy, 3);
      const ridge = 1 - Math.abs(2 * fbm(n3, u * 8 + ox, v * 8 + oy, 3) - 1);
      const lace = Math.pow(ridge, 6) * lacy;
      const speck = Math.pow(n4(u * 70 + ox, v * 70 + oy), 6) * spotty;
      let b = doneness + (m - 0.5) * 0.72 * spotty + (m2 - 0.5) * 0.2 + lace * 0.24 + speck * 0.1;
      b += (1 - sstep(0.0, 0.7, r)) * 0.06;   // centre sat longest on the griddle
      b -= sstep(0.66, 0.95, r) * 0.26;       // thin outer ring cooks paler
      const i = y * size + x;
      B[i] = clamp(b);
      H[i] = 0.55 + (m2 - 0.5) * 0.35 - lace * 0.12 + (m - 0.5) * 0.2;
    }
  }
  // Bubble pores (popped bubbles from the first side): small dark pits with a faint raised lip.
  const pores = 900 + Math.floor(rnd() * 700);
  const dims = [size, size];
  for (let k = 0; k < pores; k++) {
    const rr = 0.9 * Math.pow(rnd(), 0.62);
    const aa = rnd() * TAU;
    const cx = (0.5 + (Math.sin(aa) * rr) / PAN_UV_SCALE) * size;
    const cy = (0.5 + (Math.cos(aa) * rr) / PAN_UV_SCALE) * size;
    const rad = (0.45 + Math.pow(rnd(), 2.5) * 1.9) * (size / 512);
    const depth = 0.5 + rnd() * 0.5;
    stamp(H, dims, cx, cy, rad, (i, d) => {
      if (d < 1) { const w = (1 - d * d) * depth; B[i] = clamp(B[i] + 0.3 * w); H[i] -= 0.55 * w; }
      else if (d < 1.7) { const w = 1 - (d - 1) / 0.7; H[i] += 0.07 * w * depth; B[i] = clamp(B[i] - 0.05 * w); }
    });
  }
  const stops = [
    [0.0, 236, 184, 104],
    [0.25, 224, 152, 70],
    [0.5, 202, 120, 44],
    [0.7, 168, 88, 30],
    [0.88, 122, 58, 20],
    [1.0, 86, 38, 14],
  ];
  const col = new Uint8Array(N * 4), bump = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const c = ramp(stops, B[i]);
    col[i * 4] = c[1]; col[i * 4 + 1] = c[2]; col[i * 4 + 2] = c[3]; col[i * 4 + 3] = 255;
    const h = Math.round(clamp(H[i]) * 255);
    bump[i * 4] = bump[i * 4 + 1] = bump[i * 4 + 2] = h; bump[i * 4 + 3] = 255;
  }
  return { map: dataTexture(col, size, size, true), bump: dataTexture(bump, size, size, false) };
}

// Tileable cream crumb for the pancake sides (u wraps around the rim, v = height).
function crumbTexture(seed, w = 512, h = 128) {
  const rnd = mulberry32(seed);
  const n1 = makeNoise(seed + 5), n2 = makeNoise(seed + 9);
  const data = new Uint8Array(w * h * 4);
  const P = 32, Q = 8; // noise periods across u / v
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const a = fbm(n1, u * P, v * Q, 3, P, Q);
      const b = fbm(n2, u * P * 4, v * Q * 4, 2, P * 4, Q * 4);
      L[y * w + x] = (a - 0.5) * 0.5 + (b - 0.5) * 0.35;
    }
  }
  const dims = [w, h];
  for (let k = 0; k < 1400; k++) {
    const cx = rnd() * w, cy = rnd() * h, rad = 0.6 + Math.pow(rnd(), 3) * 2.6;
    stamp(L, dims, cx, cy, rad, (i, d) => { if (d < 1) L[i] -= 0.55 * (1 - d * d); }, true);
  }
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const edge = Math.max(sstep(0.3, 0.0, v), sstep(0.72, 1.0, v)); // toward the cooked faces
    for (let x = 0; x < w; x++) {
      const l = L[y * w + x];
      const c = ramp([[0, 186, 126, 60], [0.5, 233, 186, 112], [1, 247, 214, 146]], clamp(0.6 + l));
      const i = (y * w + x) * 4;
      data[i] = lerp(c[1], 206, edge * 0.7);
      data[i + 1] = lerp(c[2], 140, edge * 0.7);
      data[i + 2] = lerp(c[3], 62, edge * 0.7);
      data[i + 3] = 255;
    }
  }
  return dataTexture(data, w, h, true, true);
}

// Peach skin: blushing red over yellow-orange, fine pole-to-pole streaks, tiny lenticels.
function peachSkinTexture(seed, blush, size = 256) {
  const n1 = makeNoise(seed + 1), n2 = makeNoise(seed + 2), n3 = makeNoise(seed + 3);
  const rnd = mulberry32(seed);
  const o = rnd() * 40;
  const data = new Uint8Array(size * size * 4);
  const stops = [[0, 250, 190, 72], [0.32, 246, 150, 50], [0.56, 230, 96, 40], [0.8, 196, 48, 36], [1, 150, 26, 32]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const big = fbm(n1, u * 1.6 + o, v * 2.4 + o, 4);
    const streak = fbm(n2, u * 26 + o, v * 2.2, 3);
    let b = blush + (big - 0.5) * 1.3 + (streak - 0.5) * 0.28;
    b += sstep(0.3, 0.0, v) * 0.18 - sstep(0.75, 1.0, v) * 0.12;
    b = clamp(b);
    const c = ramp(stops, b);
    const sp = n3(u * 46 + o, v * 46);
    const len = sp > 0.9 && b > 0.35 ? (sp - 0.9) * 6 : 0;
    const i = (y * size + x) * 4;
    data[i] = lerp(c[1], 246, len); data[i + 1] = lerp(c[2], 168, len); data[i + 2] = lerp(c[3], 78, len); data[i + 3] = 255;
  }
  return dataTexture(data, size, size, true);
}

// Peach flesh: u runs pit (0) -> skin (1); red fibres near the pit, juicy golden-orange body.
function peachFleshTexture(seed, size = 256) {
  const n1 = makeNoise(seed + 1), n2 = makeNoise(seed + 2);
  const data = new Uint8Array(size * size * 4);
  const stops = [[0, 206, 80, 34], [0.08, 236, 124, 34], [0.26, 244, 152, 36], [0.72, 247, 168, 44], [0.92, 242, 140, 36], [1, 226, 100, 30]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / (size - 1), v = y / size;
    const fib = fbm(n1, u * 3, v * 90, 2);
    const reach = 0.1 + 0.24 * fbm(n2, 0.5, v * 9, 3);
    const red = u < reach ? Math.pow(1 - u / reach, 1.3) * 0.85 : 0;
    const c = ramp(stops, u);
    const k = 0.92 + 0.14 * fib;
    const i = (y * size + x) * 4;
    data[i] = clamp(lerp(c[1], 194, red) * k / 255) * 255;
    data[i + 1] = clamp(lerp(c[2], 44, red) * k / 255) * 255;
    data[i + 2] = clamp(lerp(c[3], 34, red) * k / 255) * 255;
    data[i + 3] = 255;
  }
  return dataTexture(data, size, size, true);
}

// Lemon cream-cheese frosting with flecks of zest.
function zestTexture(seed, size = 256) {
  const rnd = mulberry32(seed);
  const n1 = makeNoise(seed + 4);
  const F = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = fbm(n1, x / size * 8, y / size * 8, 3, 8, 8) - 0.5;
    const i = (y * size + x) * 3;
    F[i] = 249 + n * 6; F[i + 1] = 229 + n * 8; F[i + 2] = 146 + n * 14;
  }
  const dims = [size, size];
  for (let k = 0; k < 420; k++) {
    const cx = rnd() * size, cy = rnd() * size, rad = 0.7 + Math.pow(rnd(), 2) * 1.6;
    const green = rnd() < 0.15;
    const col = green ? [206, 192, 52] : [244, 196, 34];
    stamp(F, dims, cx, cy, rad, (i, d) => {
      if (d >= 1) return; const w = 1 - d * d;
      F[i * 3] = lerp(F[i * 3], col[0], w); F[i * 3 + 1] = lerp(F[i * 3 + 1], col[1], w); F[i * 3 + 2] = lerp(F[i * 3 + 2], col[2], w);
    }, true);
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = clamp(F[i * 3] / 255) * 255; data[i * 4 + 1] = clamp(F[i * 3 + 1] / 255) * 255;
    data[i * 4 + 2] = clamp(F[i * 3 + 2] / 255) * 255; data[i * 4 + 3] = 255;
  }
  return dataTexture(data, size, size, true, true);
}

function radialShadowTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
    const r = Math.sqrt(dx * dx + dy * dy);
    const a = Math.pow(clamp(1 - r), 1.8) * (0.55 + 0.45 * sstep(0.85, 0.3, r));
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(a * 255);
  }
  return dataTexture(data, size, size, false);
}

/* ---------------------------------------------------------------- pancake */
// Profile: flat bottom, superellipse rim (squarer underneath, puffier on top), domed top.
function pancakeParams(seed) {
  const rnd = mulberry32(seed);
  const P = {
    T: 0.27 + rnd() * 0.04,
    dome: 0.02 + rnd() * 0.014,
    a: 0.16 + rnd() * 0.035,
    exBot: 0.66,
    exTop: 0.94,
    harm: [],
    lumps: [],
    tvA: 0.03 + rnd() * 0.025, tvP: rnd() * TAU, tvA2: 0.012 + rnd() * 0.012, tvP2: rnd() * TAU,
  };
  P.rc = 1 - P.a;
  for (let k = 2; k <= 7; k++) P.harm.push([k, (0.016 / Math.pow(k, 0.7)) * (0.4 + rnd()), rnd() * TAU]);
  for (let k = 0; k < 3; k++) P.lumps.push([rnd() * TAU, (rnd() - 0.35) * 0.03, 0.18 + rnd() * 0.2]);
  P.rad = (th) => {
    let r = 1;
    for (const [k, a, ph] of P.harm) r += a * Math.sin(k * th + ph);
    for (const [c, a, w] of P.lumps) { const d = wrapAngle(th - c); r += a * Math.exp(-(d * d) / (w * w)); }
    return r;
  };
  P.tv = (th) => P.tvA * Math.sin(th + P.tvP) + P.tvA2 * Math.sin(2 * th + P.tvP2);
  return P;
}

// rim point at angle beta (-pi/2 bottom .. +pi/2 top), unscaled profile coordinates
function rimPoint(P, b) {
  const c = Math.max(0, Math.cos(b)), s = Math.sin(b);
  const ex = s < 0 ? P.exBot : P.exTop;
  return [P.rc + P.a * Math.pow(c, ex), P.T / 2 + (P.T / 2) * Math.sign(s) * Math.pow(Math.abs(s), ex), c];
}

function pancakeProfile(P) {
  const pts = []; // [r, y, sideWeight]
  const nb = 9;
  for (let k = 0; k < nb; k++) { const f = k / nb; pts.push([P.rc * Math.sqrt(f), 0, 0]); }
  const ne = 32;
  for (let k = 0; k <= ne; k++) {
    const [r, y, c] = rimPoint(P, -Math.PI / 2 + (Math.PI * k) / ne);
    pts.push([r, y, Math.pow(c, 0.85)]);
  }
  const nt = 16;
  for (let k = 1; k <= nt; k++) {
    const f = 1 - Math.pow(k / nt, 0.85);
    pts.push([P.rc * f, P.T + P.dome * (1 - f * f), 0]);
  }
  return pts;
}

function weldSeam(geo, cols, rows) {
  // average normals of the first and last column (duplicated seam) of a (cols+1) x rows grid laid out col-major
  const n = geo.attributes.normal;
  for (let j = 0; j < rows; j++) {
    const a = j, b = cols * rows + j;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
}

function buildPancakeGeometry(P, segments = 160) {
  const prof = pancakeProfile(P);
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  const np = prof.length;
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const aProf = new Float32Array(pos.count * 2);
  const aSide = new Float32Array(pos.count * 2);
  let maxY = 0;
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * TAU;
    const rad = P.rad(phi), tv = P.tv(phi);
    const sn = Math.sin(phi), cs = Math.cos(phi);
    for (let j = 0; j < np; j++) {
      const idx = i * np + j;
      const [r0, y0, sw] = prof[j];
      const r = r0 * rad;
      const y = y0 * (1 + tv * Math.min(1, r0 / P.rc));
      const x = r * sn, z = r * cs;
      pos.setXYZ(idx, x, y, z);
      uv.setXY(idx, x / PAN_UV_SCALE + 0.5, z / PAN_UV_SCALE + 0.5);
      aProf[idx * 2] = sw; aProf[idx * 2 + 1] = r0;
      aSide[idx * 2] = (i / segments) * 6; aSide[idx * 2 + 1] = y0 / P.T;
      if (y > maxY) maxY = y;
    }
  }
  g.setAttribute('aProf', new THREE.BufferAttribute(aProf, 2));
  g.setAttribute('aSideUv', new THREE.BufferAttribute(aSide, 2));
  g.computeVertexNormals();
  weldSeam(g, segments, np);
  const nrm = g.attributes.normal;
  for (let i = 0; i <= segments; i++) { nrm.setXYZ(i * np, 0, -1, 0); nrm.setXYZ(i * np + np - 1, 0, 1, 0); }
  g.computeBoundingSphere();
  P.maxY = maxY;
  return g;
}

// Point + normal on the TOP of a pancake (local, unscaled), wrapping over the rounded rim
// for points beyond the flat face. Used to lay the compote pool onto the real surface.
function surfTop(P, x, z) {
  const th = Math.atan2(x, z);
  const rad = P.rad(th), tv = P.tv(th);
  const rho = Math.hypot(x, z) / rad;
  const sn = Math.sin(th), cs = Math.cos(th);
  if (rho <= P.rc) {
    const k = rho / P.rc;
    const y = (P.T + P.dome * (1 - k * k)) * (1 + tv * k);
    const dydr = ((-2 * P.dome * k / P.rc) * (1 + tv * k) + (P.T + P.dome * (1 - k * k)) * tv / P.rc) / rad;
    const l = Math.hypot(dydr, 1);
    return [x, y, z, (-dydr * sn) / l, 1 / l, (-dydr * cs) / l];
  }
  const e = Math.min(rho - P.rc, P.a * 0.995);
  const c = Math.pow(e / P.a, 1 / P.exTop);
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  const ex = P.exTop;
  const yl = (P.T / 2 + (P.T / 2) * Math.pow(s, ex)) * (1 + tv);
  const rl = (P.rc + P.a * Math.pow(c, ex)) * rad;
  const nr = Math.pow(c, 2 - ex) / P.a, ny = Math.pow(s, 2 - ex) / ((P.T / 2) * (1 + tv));
  const l = Math.hypot(nr, ny) || 1;
  return [rl * sn, yl, rl * cs, (nr / l) * sn, ny / l, (nr / l) * cs];
}

function makePancakeMaterial(face, crumb, tint) {
  const m = new THREE.MeshPhysicalMaterial({
    map: face.map,
    bumpMap: face.bump,
    bumpScale: 1.6,
    roughness: 0.58,
    metalness: 0,
    sheen: 0.22,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0xffc98a),
    specularIntensity: 0.55,
  });
  const uniforms = { uCrumb: { value: crumb }, uTint: { value: tint } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCrumb = uniforms.uCrumb;
    sh.uniforms.uTint = uniforms.uTint;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aProf;\nattribute vec2 aSideUv;\nvarying vec2 vProf;\nvarying vec2 vSideUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvProf = aProf;\n\tvSideUv = aSideUv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uCrumb;\nuniform vec3 uTint;\nvarying vec2 vProf;\nvarying vec2 vSideUv;')
      .replace('#include <map_fragment>', /* glsl */`
        vec4 faceS = texture2D( map, vMapUv );
        vec3 crumbC = texture2D( uCrumb, vSideUv ).rgb;
        float sw = vProf.x;
        float rn = vProf.y;
        vec3 faceC = faceS.rgb * uTint;
        // batter that spread thin at the outer ring cooks paler
        faceC = mix( faceC, faceC * vec3( 1.22, 1.16, 1.04 ) + vec3( 0.03, 0.02, 0.0 ),
          smoothstep( 0.62, 0.86, rn ) * ( 1.0 - smoothstep( 0.05, 0.35, sw ) ) * 0.55 );
        // darker cooked band where the face rolls over into the side
        float rimBand = smoothstep( 0.04, 0.3, sw ) * ( 1.0 - smoothstep( 0.5, 0.82, sw ) );
        vec3 rimC = faceS.rgb * uTint * vec3( 0.8, 0.64, 0.48 );
        vec3 col = mix( faceC, crumbC, smoothstep( 0.45, 0.88, sw ) );
        col = mix( col, rimC, rimBand * 0.85 );
        diffuseColor.rgb *= col;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = mix( roughness, 0.86, smoothstep( 0.45, 0.88, vProf.x ) );
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        vec3 nGeo = normal;
        #include <normal_fragment_maps>
        normal = normalize( mix( normal, nGeo, smoothstep( 0.3, 0.75, vProf.x ) ) );
      `);
  };
  m.customProgramCacheKey = () => 'peach-c-pancake';
  return m;
}

/* ------------------------------------------------------------------ plate */
const PLATE_TOP = 0.06;
const PLATE_R = 2.0;
function buildPlate() {
  // bottom centre -> underside -> lip -> top -> top centre (outward normals with LatheGeometry)
  const W = [251, 247, 240], PE = [238, 132, 86];
  const pts = [
    [0.0, 0.004, W], [0.7, 0.004, W], [1.25, 0.0, W], [1.36, 0.0, W], [1.42, 0.018, W],
    [1.62, 0.04, W], [1.78, 0.066, W], [1.92, 0.094, W], [1.985, 0.108, W],
    [2.015, 0.122, W], [2.02, 0.132, W], [2.005, 0.141, W], [1.98, 0.144, PE],
    [1.945, 0.141, PE], [1.935, 0.14, W], [1.88, 0.132, W],
    [1.81, 0.114, W], [1.74, 0.094, W], [1.69, 0.078, W], [1.645, 0.066, W], [1.61, PLATE_TOP + 0.001, W], [1.56, PLATE_TOP, W],
    [1.0, PLATE_TOP, W], [0.5, PLATE_TOP, W], [0.0, PLATE_TOP, W],
  ];
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 144);
  const np = pts.length;
  const col = new Float32Array(g.attributes.position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < g.attributes.position.count; i++) {
    const rgb = pts[i % np][2];
    c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/* ------------------------------------------------------------ peach slice */
// A wedge cut pole-to-pole from a peach with the pit removed. Local frame: the peach's
// axis is Y, the wedge is centred on +X (skin side), flat flesh faces at phi = +-w/2.
function sliceParams(seed) {
  const r = mulberry32(seed);
  return {
    R: 0.445 + r() * 0.025, pit: 0.31 + r() * 0.04, w: 0.6 + r() * 0.1, ys: 1.05 + r() * 0.04,
    wa: 0.02 + r() * 0.02, wp: r() * TAU, wp2: r() * TAU, blush: 0.42 + r() * 0.26,
  };
}

function buildSliceGeometry(S) {
  const pos = [], nor = [], uv = [], idx = [];
  const groups = [];
  const nT = 40, nP = 12, nR = 9;
  const skinR = (th) => S.R * (1 + S.wa * Math.sin(3 * th + S.wp) + 0.012 * Math.sin(7 * th + S.wp2));
  const pitR = (th) => S.R * S.pit * (1 + 0.1 * Math.sin(5 * th + S.wp2));
  const P = (rho, th, ph) => [rho * Math.sin(th) * Math.cos(ph), rho * Math.cos(th) * S.ys, rho * Math.sin(th) * Math.sin(ph)];
  // grid helper: f(i, j) -> [pos, normal, uv]; rows i (0..ni), cols j (0..nj)
  function grid(ni, nj, f, mat) {
    const base = pos.length / 3;
    const start = idx.length;
    for (let i = 0; i <= ni; i++) for (let j = 0; j <= nj; j++) {
      const [p, n, t] = f(i, j);
      pos.push(...p); nor.push(...n); uv.push(...t);
    }
    const V = (i, j) => base + i * (nj + 1) + j;
    const tri = (a, b, c) => {
      // orient each triangle to agree with the supplied vertex normals
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
      const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const nx = nor[a * 3] + nor[b * 3] + nor[c * 3], ny = nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1], nz = nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2];
      if (cx * nx + cy * ny + cz * nz < 0) idx.push(a, c, b); else idx.push(a, b, c);
    };
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      tri(V(i, j), V(i + 1, j), V(i, j + 1));
      tri(V(i, j + 1), V(i + 1, j), V(i + 1, j + 1));
    }
    groups.push([start, idx.length - start, mat]);
  }
  const ellN = (th, ph, s) => {
    const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th) / S.ys, z = Math.sin(th) * Math.sin(ph);
    const l = Math.hypot(x, y, z) || 1; return [(s * x) / l, (s * y) / l, (s * z) / l];
  };
  const thAt = (i) => (i / nT) * Math.PI;
  // skin
  grid(nT, nP, (i, j) => {
    const th = thAt(i), ph = -S.w / 2 + (S.w * j) / nP;
    return [P(skinR(th), th, ph), ellN(th, ph, 1), [j / nP, i / nT]];
  }, 0);
  // two flat flesh faces
  for (const side of [1, -1]) {
    const ph = (side * S.w) / 2;
    const n = [-Math.sin(S.w / 2), 0, side * Math.cos(S.w / 2)];
    grid(nT, nR, (i, j) => {
      const th = thAt(i), f = j / nR;
      return [P(lerp(pitR(th), skinR(th), f), th, ph), n, [f, i / nT]];
    }, 1);
  }
  // pit cavity (faces the axis)
  grid(nT, nP, (i, j) => {
    const th = thAt(i), ph = -S.w / 2 + (S.w * j) / nP;
    return [P(pitR(th), th, ph), ellN(th, ph, -1), [0.015, i / nT]];
  }, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  for (const [s, c, m] of groups) g.addGroup(s, c, m);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/* -------------------------------------------------------------- frosting */
// Piped swirl of lemon cream-cheese frosting: star-tip ridges spiralling to a soft curl.
const FROST_R = 0.41, FROST_H = 0.5;
function buildFrostingGeometry() {
  const na = 128;
  const rows = [];
  for (let k = 0; k <= 5; k++) rows.push({ base: true, f: k / 5 });
  const nh = 60;
  for (let k = 1; k <= nh; k++) rows.push({ base: false, h: k / nh });
  const nr = rows.length;
  const pos = new Float32Array((na + 1) * nr * 3);
  const uv = new Float32Array((na + 1) * nr * 2);
  for (let i = 0; i <= na; i++) {
    const th = (i / na) * TAU;
    const sn = Math.sin(th), cs = Math.cos(th);
    for (let j = 0; j < nr; j++) {
      const row = rows[j];
      let r, y, cx = 0, cz = 0, v;
      if (row.base) {
        r = FROST_R * 0.985 * row.f; y = -0.006 * (1 - row.f * row.f) - 0.004; v = 0;
      } else {
        const h = row.h;
        const tiers = 1 + 0.11 * Math.sin(h * Math.PI * 3.2 + 0.2) * (1 - h * 0.5);
        const prof = Math.pow(1 - Math.pow(h, 1.7), 0.66) * tiers;
        const amp = 0.2 * Math.pow(1 - h, 0.5) * sstep(0, 0.06, h);
        const ridge = Math.pow(0.5 + 0.5 * Math.cos(8 * th + h * TAU * 1.6), 1.8) * 2 - 0.7;
        r = FROST_R * prof * (1 + amp * ridge);
        y = FROST_H * h;
        cx = 0.05 * Math.pow(h, 3.2); cz = 0.02 * Math.pow(h, 2.5);
        v = h;
      }
      const o = (i * nr + j) * 3;
      pos[o] = r * sn + cx; pos[o + 1] = y; pos[o + 2] = r * cs + cz;
      uv[(i * nr + j) * 2] = (i / na) * 3; uv[(i * nr + j) * 2 + 1] = v;
    }
  }
  const idx = [];
  for (let i = 0; i < na; i++) for (let j = 0; j < nr - 1; j++) {
    const a = i * nr + j, b = (i + 1) * nr + j, c = i * nr + j + 1, d = (i + 1) * nr + j + 1;
    idx.push(a, b, c, c, b, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  weldSeam(g, na, nr);
  const n = g.attributes.normal;
  for (let i = 0; i <= na; i++) { n.setXYZ(i * nr, 0, -1, 0); n.setXYZ(i * nr + nr - 1, 0.12, 0.99, 0.05); }
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------ choreography */
const N_PAN = 6;
const PITCH = 0.8;
const DROP_START = 0.08, DROP_END = 0.72;
const DROP_DUR = 0.115;
const DROP_STEP = (DROP_END - DROP_START - DROP_DUR) / (N_PAN - 1); // last drop ends at 0.72
const CONTACT = 0.62; // fraction of a drop window spent falling

const BUTTER = { start: 0.72, dur: 0.06, soft0: 0.785, soft1: 0.99 };
const POUR = { head0: 0.845, head1: 0.866, tail0: 0.905, tail1: 0.935 };
const BLOOM = { start: 0.862, end: 0.965 };
const FROST = { start: 0.925, dur: 0.075 };
const DRIPS = [ // world angle (0 = toward camera), max length below the rim, width, start p
  { a: -1.3, L: 0.6, w: 0.07, s: 0.905 },
  { a: -0.74, L: -1, w: 0.095, s: 0.9 }, // L < 0: runs all the way to the plate
  { a: -0.18, L: 0.42, w: 0.06, s: 0.915 },
  { a: 0.28, L: 0.95, w: 0.085, s: 0.903 },
  { a: 0.86, L: 0.3, w: 0.072, s: 0.92 },
  { a: 1.45, L: 0.78, w: 0.065, s: 0.91 },
];
const IMPACT = { ang: 0.42, dist: 0.5 };
const SLICES = [ // hover (angle, radius, y at p=0, y at p=0.72), final (angle on plate), settle start
  { seed: 71, ha: -1.12, hr: 1.95, y0: 1.5, y1: 1.15, fa: -0.98, settle: 0.84, rot: [0.5, 0.25, 0.95] },
  { seed: 83, ha: 1.08, hr: 2.0, y0: 3.05, y1: 1.85, fa: 0.66, settle: 0.865, rot: [-0.35, -0.3, -0.8] },
  { seed: 97, ha: -0.55, hr: 2.15, y0: 4.55, y1: 2.7, fa: 1.95, settle: 0.9, rot: [0.3, 0.35, 1.05] },
];
const SLICE_DUR = 0.09;
const N_CHUNK = 12;

/* ------------------------------------------------------------------ mount */
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    return true;
  } catch (e) { return false; }
}

export async function mountHero(host, { getProgress = () => 0, reducedMotion = false, frozen = null } = {}) {
  if (!webglAvailable()) throw new Error('webgl-unavailable');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('webgl-unavailable');
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const canvas = renderer.domElement;
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  host.appendChild(canvas);

  const disposables = new Set();
  const track = (o) => { disposables.add(o); return o; };

  /* scene, environment, lights */
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.5;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);

  const key = new THREE.DirectionalLight(0xffdcb8, 2.35);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 4;
  const sc = key.shadow.camera;
  sc.left = -3.8; sc.right = 3.8; sc.top = 4.0; sc.bottom = -4.0; sc.near = 1; sc.far = 26;
  scene.add(key, key.target);
  const KEY_DIR = new THREE.Vector3(-0.55, 0.78, 0.5).normalize();
  key.target.position.set(0, 2.3, 0);
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, 12);

  const rim = new THREE.DirectionalLight(0xfff3e6, 3.2);
  rim.position.set(3.2, 4.2, -5.5);
  const rim2 = new THREE.DirectionalLight(0xffd2b0, 1.1);
  rim2.position.set(-5.5, 2.5, -3.5);
  const hemi = new THREE.HemisphereLight(0xffeedd, 0xf0844e, 0.45);
  scene.add(rim, rim2, hemi);

  /* plate + contact shadow */
  const plateMat = track(new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.2, clearcoat: 0.9, clearcoatRoughness: 0.08, specularIntensity: 0.8,
  }));
  const plate = new THREE.Mesh(track(buildPlate()), plateMat);
  plate.receiveShadow = true;
  scene.add(plate);

  const shadowTex = track(radialShadowTexture());
  const groundMat = track(new THREE.MeshBasicMaterial({
    map: shadowTex, color: 0x6e2208, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false,
  }));
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0.22, -0.003, -0.16);
  ground.scale.set(5.4, 5.1, 1);
  ground.renderOrder = -1;
  scene.add(ground);

  /* pancakes */
  const crumb = track(crumbTexture(909));
  const rngStack = mulberry32(4747);
  const pans = [];
  let landY = PLATE_TOP + 0.001;
  for (let i = 0; i < N_PAN; i++) {
    const seed = 1301 + i * 977;
    const P = pancakeParams(seed);
    const geo = track(buildPancakeGeometry(P));
    const face = pancakeFaceTextures(seed + 3);
    track(face.map); track(face.bump);
    const tintR = mulberry32(seed + 7);
    const warm = 0.93 + tintR() * 0.12;
    const tint = new THREE.Color(warm, warm * (0.97 + tintR() * 0.04), warm * (0.94 + tintR() * 0.06));
    const mat = track(makePancakeMaterial(face, crumb, tint));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const r = mulberry32(seed + 99);
    const hoverAng = r() * TAU;
    const pan = {
      P, mesh,
      start: DROP_START + i * DROP_STEP,
      hx: Math.sin(hoverAng) * (0.08 + r() * 0.2),
      hz: Math.cos(hoverAng) * (0.08 + r() * 0.14),
      hy0: PLATE_TOP + 0.85 + i * PITCH + (r() - 0.5) * 0.1,
      tilt0: (0.2 + r() * 0.24) * (i % 2 ? 1 : -1),
      tiltAxis: r() * TAU,
      yaw0: r() * TAU,
      ph: Array.from({ length: 8 }, () => r() * TAU),
      lx: (rngStack() - 0.5) * 0.09,
      lz: (rngStack() - 0.5) * 0.09,
      landY,
    };
    pan.yawLand = pan.yaw0 + (r() - 0.5) * 1.2;
    landY += P.maxY + 0.0015;
    pans.push(pan);
  }
  const top = pans[N_PAN - 1];
  const STACK_TOP = top.landY + top.P.T + top.P.dome; // centre of the top pancake's dome

  // top-pancake local <-> world (landed pose: translation + yaw only)
  const cY = Math.cos(top.yawLand), sY = Math.sin(top.yawLand);
  const toLocal = (X, Z) => { const dx = X - top.lx, dz = Z - top.lz; return [dx * cY - dz * sY, dx * sY + dz * cY]; };
  const toWorldXZ = (x, z) => [x * cY + z * sY + top.lx, -x * sY + z * cY + top.lz];
  // surface point + normal on the finished stack top, in world space
  function stackSurf(X, Z) {
    const [x, z] = toLocal(X, Z);
    const s = surfTop(top.P, x, z);
    const [wx, wz] = toWorldXZ(s[0], s[2]);
    const [nx, nz] = [s[3] * cY + s[5] * sY, -s[3] * sY + s[5] * cY];
    return [wx, s[1] + top.landY, wz, nx, s[4], nz];
  }

  /* peach slices */
  const fleshTex = track(peachFleshTexture(55));
  const fleshMat = track(new THREE.MeshPhysicalMaterial({
    map: fleshTex, roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.16, specularIntensity: 0.6,
    envMapIntensity: 0.55, emissive: 0xff6a10, emissiveMap: fleshTex, emissiveIntensity: 0.22,
  }));
  const slices = SLICES.map((cfg, k) => {
    const S = sliceParams(cfg.seed);
    const geo = track(buildSliceGeometry(S));
    const skinTex = track(peachSkinTexture(cfg.seed + 5, S.blush));
    const skinMat = track(new THREE.MeshPhysicalMaterial({
      map: skinTex, roughness: 0.5, sheen: 0.6, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xff9a74),
      clearcoat: 0.12, clearcoatRoughness: 0.35, specularIntensity: 0.6,
    }));
    const mesh = new THREE.Mesh(geo, [skinMat, fleshMat]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const C = new THREE.Vector3(); geo.boundingBox.getCenter(C);
    mesh.position.copy(C).negate(); // pivot about the slice's centre
    const group = new THREE.Group();
    group.add(mesh);
    scene.add(group);
    const r = mulberry32(cfg.seed + 17);
    const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(cfg.rot[0], cfg.rot[1], cfg.rot[2], 'YXZ'));
    const tumbleAxis = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    // final: lying on one flat face on the plate, skin toward the stack, the other juicy
    // flesh face tilted up and outward (toward the viewer for the front slices)
    const qFinal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), cfg.fa + Math.PI / 2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -S.w / 2));
    const axisPos = new THREE.Vector3(Math.sin(cfg.fa) * (1.1 + S.R * 1.04), PLATE_TOP + 0.002, Math.cos(cfg.fa) * (1.1 + S.R * 1.04));
    const finalPos = C.clone().applyQuaternion(qFinal).add(axisPos);
    return { cfg, S, group, qBase, qFinal, finalPos, tumbleAxis, ph: Array.from({ length: 6 }, () => r() * TAU), idx: k };
  });

  /* butter */
  const butterGeo = track(new RoundedBoxGeometry(0.34, 0.1, 0.27, 4, 0.04));
  const butterMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xfbe39a, roughness: 0.28, clearcoat: 0.7, clearcoatRoughness: 0.15, sheen: 0.4, sheenColor: new THREE.Color(0xfff2c0),
    emissive: 0x5a3a00, emissiveIntensity: 0.08,
  }));
  const butter = new THREE.Mesh(butterGeo, butterMat);
  butter.castShadow = true;
  scene.add(butter);
  const BUTTER_XZ = toWorldXZ(-0.04, 0.02);
  const BUTTER_YAW = 0.5;

  /* compote: pool + drips + pour stream share one glossy material */
  const compoteMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xc4660c, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02,
    ior: 1.5, specularIntensity: 1, emissive: 0x7a3600, emissiveIntensity: 0.28, envMapIntensity: 1.7,
  }));

  // pool: polar grid around the pour impact point, laid on the real top surface
  const impactW = [top.lx + Math.sin(IMPACT.ang) * IMPACT.dist, top.lz + Math.cos(IMPACT.ang) * IMPACT.dist];
  const POOL_NA = 160, POOL_NR = 28, POOL_TH = 0.05;
  const poolNoise = makeNoise(321);
  const poolD = new Float32Array(POOL_NA + 1);
  {
    const lobe = (aw) => {
      let s = 0;
      for (const d of DRIPS) { const da = wrapAngle(aw - d.a); s = Math.max(s, Math.exp(-(da * da) / (0.2 * 0.2)) * (0.75 + d.w * 3)); }
      return clamp(s);
    };
    for (let k = 0; k <= POOL_NA; k++) {
      const psi = (k / POOL_NA) * TAU;
      const dx = Math.sin(psi), dz = Math.cos(psi);
      let lo = 0, hi = 3;
      for (let it = 0; it < 30; it++) {
        const t = (lo + hi) / 2;
        const X = impactW[0] + dx * t, Z = impactW[1] + dz * t;
        const [x, z] = toLocal(X, Z);
        const th = Math.atan2(x, z);
        const rho = Math.hypot(x, z) / top.P.rad(th);
        const aw = Math.atan2(X - top.lx, Z - top.lz);
        const target = top.P.rc * (0.93 + 0.1 * (fbm(poolNoise, aw * 1.3 + 10, 3.3, 3) - 0.5)) + lobe(aw) * (top.P.rc * 0.07 + top.P.a * 0.97);
        if (rho > target) hi = t; else lo = t;
      }
      poolD[k] = (lo + hi) / 2;
    }
  }
  const poolGeo = track(new THREE.BufferGeometry());
  const poolPos = new Float32Array((POOL_NA + 1) * (POOL_NR + 1) * 3);
  poolGeo.setAttribute('position', new THREE.BufferAttribute(poolPos, 3));
  poolGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(poolPos.length), 3));
  {
    const idx = [];
    const V = (j, k) => j * (POOL_NA + 1) + k;
    for (let j = 0; j < POOL_NR; j++) for (let k = 0; k < POOL_NA; k++) {
      const A = V(j, k), B = V(j + 1, k), C = V(j, k + 1), D = V(j + 1, k + 1);
      idx.push(A, B, C, C, B, D);
    }
    poolGeo.setIndex(idx);
  }
  const pool = new THREE.Mesh(poolGeo, compoteMat);
  pool.castShadow = true;
  pool.frustumCulled = false;
  scene.add(pool);
  const poolThick = (f) => POOL_TH * Math.sqrt(Math.max(0, 1 - Math.pow(f, 4))) + 0.0045;

  function updatePool(b) {
    for (let j = 0; j <= POOL_NR; j++) {
      const f = Math.pow(j / POOL_NR, 0.72);
      const th = poolThick(f) * (0.35 + 0.65 * sstep(0, 0.25, b));
      for (let k = 0; k <= POOL_NA; k++) {
        const psi = (k / POOL_NA) * TAU;
        const t = poolD[k] * b * f;
        const s = stackSurf(impactW[0] + Math.sin(psi) * t, impactW[1] + Math.cos(psi) * t);
        const o = (j * (POOL_NA + 1) + k) * 3;
        poolPos[o] = s[0] + s[3] * th; poolPos[o + 1] = s[1] + s[4] * th; poolPos[o + 2] = s[2] + s[5] * th;
      }
    }
    poolGeo.attributes.position.needsUpdate = true;
    poolGeo.computeVertexNormals();
    // weld the seam column and the centre fan
    const n = poolGeo.attributes.normal;
    for (let j = 0; j <= POOL_NR; j++) {
      const a = j * (POOL_NA + 1), c = a + POOL_NA;
      const x = n.getX(a) + n.getX(c), y = n.getY(a) + n.getY(c), z = n.getZ(a) + n.getZ(c), l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(c, x / l, y / l, z / l);
    }
    const s0 = stackSurf(impactW[0], impactW[1]);
    for (let k = 0; k <= POOL_NA; k++) n.setXYZ(k, s0[3], s0[4], s0[5]);
    n.needsUpdate = true;
    poolGeo.computeBoundingSphere();
  }
  // height of the pool surface at a world point for a given bloom (chunks ride on it)
  function poolTopAt(X, Z, b) {
    const s = stackSurf(X, Z);
    const dx = X - impactW[0], dz = Z - impactW[1];
    let psi = Math.atan2(dx, dz); if (psi < 0) psi += TAU;
    const k = Math.min(POOL_NA, Math.round((psi / TAU) * POOL_NA));
    const f = Math.hypot(dx, dz) / Math.max(1e-4, poolD[k] * b);
    const th = f <= 1 ? poolThick(f) : 0;
    return s[1] + s[4] * th;
  }

  // drips: precomputed 2D paths (radius, height) hugging the finished stack at each angle
  function sideProfileAt(alpha) {
    const curves = pans.map((pan) => {
      const thL = alpha - pan.yawLand, P = pan.P;
      const rad = P.rad(thL), tv = P.tv(thL);
      const off = pan.lx * Math.sin(alpha) + pan.lz * Math.cos(alpha);
      const pts = [];
      for (let k = 0; k <= 64; k++) {
        const [r, y] = rimPoint(P, -Math.PI / 2 + (Math.PI * k) / 64);
        pts.push([pan.landY + y * (1 + tv), r * rad + off]);
      }
      return pts;
    });
    return (y) => {
      let best = 0;
      for (const c of curves) {
        if (y < c[0][0] || y > c[c.length - 1][0]) continue;
        for (let i = 1; i < c.length; i++) {
          if (y <= c[i][0]) { const t = (y - c[i - 1][0]) / Math.max(1e-6, c[i][0] - c[i - 1][0]); best = Math.max(best, lerp(c[i - 1][1], c[i][1], t)); break; }
        }
      }
      return best;
    };
  }
  const drips = DRIPS.map((d) => {
    const P = top.P, thL = d.a - top.yawLand;
    const rad = P.rad(thL), tv = P.tv(thL);
    const off = top.lx * Math.sin(d.a) + top.lz * Math.cos(d.a);
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const rho = lerp(0.72 * P.rc, P.rc, k / 8), kk = rho / P.rc;
      pts.push([rho * rad + off, top.landY + (P.T + P.dome * (1 - kk * kk)) * (1 + tv * kk)]);
    }
    for (let k = 1; k <= 16; k++) {
      const [r, y] = rimPoint(P, (Math.PI / 2) * (1 - k / 16));
      pts.push([r * rad + off, top.landY + y * (1 + tv)]);
    }
    const iBelly = pts.length - 1;
    // envelope of the stack side below the belly: bridges the grooves between pancakes
    const raw = sideProfileAt(d.a);
    const yB = pts[iBelly][1], step = 0.005;
    const ys = [], rs = [];
    for (let y = yB; y >= PLATE_TOP + 0.02; y -= step) { ys.push(y); rs.push(raw(y)); }
    const env = rs.map((_, i) => { let m = 0; for (let j = Math.max(0, i - 7); j <= Math.min(rs.length - 1, i + 7); j++) m = Math.max(m, rs[j]); return m; });
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < env.length - 1; i++) env[i] = (env[i - 1] + env[i] * 2 + env[i + 1]) / 4;
    const blend = (i) => Math.min(1, i / 6); // ease from the exact rim onto the envelope
    for (let i = 2; i < ys.length; i += 2) pts.push([lerp(pts[iBelly][0], Math.max(env[i] - 0.004, 0.5), blend(i / 2)), ys[i]]);
    // arc length + outward normals in the (r, y) plane
    const arc = [0];
    for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const nrm = pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const tr = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tr, ty) || 1;
      return [-ty / l, tr / l];
    });
    const sMax = arc[arc.length - 1];
    return { ...d, L: d.L < 0 ? sMax - arc[iBelly] : d.L, toPlate: d.L < 0, pts, arc, nrm, sBelly: arc[iBelly], sMax };
  });
  function pathAt(d, sq) {
    const { arc: s, pts, nrm } = d;
    sq = clamp(sq, 0, d.sMax);
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= sq) lo = m; else hi = m; }
    const t = (sq - s[lo]) / Math.max(1e-6, s[hi] - s[lo]);
    const nr = lerp(nrm[lo][0], nrm[hi][0], t), ny = lerp(nrm[lo][1], nrm[hi][1], t), l = Math.hypot(nr, ny) || 1;
    return [lerp(pts[lo][0], pts[hi][0], t), lerp(pts[lo][1], pts[hi][1], t), nr / l, ny / l];
  }
  const DRIP_TRAIL = 46, DRIP_CAP = 8, DRIP_M = 14;
  const DRIP_RINGS = DRIP_TRAIL + 1 + DRIP_CAP;
  const dripGeo = track(new THREE.BufferGeometry());
  const dripPos = new Float32Array(drips.length * DRIP_RINGS * DRIP_M * 3);
  dripGeo.setAttribute('position', new THREE.BufferAttribute(dripPos, 3));
  dripGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(dripPos.length), 3));
  {
    const idx = [];
    for (let di = 0; di < drips.length; di++) {
      const base = di * DRIP_RINGS * DRIP_M;
      for (let k = 0; k < DRIP_RINGS - 1; k++) for (let a = 0; a < DRIP_M; a++) {
        const A = base + k * DRIP_M + a, B = base + k * DRIP_M + ((a + 1) % DRIP_M);
        const C = A + DRIP_M, D = B + DRIP_M;
        idx.push(A, B, C, C, B, D);
      }
    }
    dripGeo.setIndex(idx);
  }
  const dripMesh = new THREE.Mesh(dripGeo, compoteMat);
  dripMesh.castShadow = true;
  dripMesh.frustumCulled = false;
  scene.add(dripMesh);

  // small puddle where the long drip reaches the plate
  const puddleDrip = drips.find((d) => d.toPlate);
  const puddle = new THREE.Mesh(track(new THREE.SphereGeometry(1, 40, 14)), compoteMat);
  puddle.frustumCulled = false;
  scene.add(puddle);
  function updatePuddle(p) {
    if (!puddleDrip) { puddle.visible = false; return; }
    const reach = span(p, puddleDrip.s, 0.995);
    const g = sstep(0.82, 1.0, easeOutCubic(reach));
    puddle.visible = g > 0;
    if (!puddle.visible) return;
    const [r] = pathAt(puddleDrip, puddleDrip.sMax);
    const a = puddleDrip.a;
    puddle.position.set(Math.sin(a) * (r + 0.07), PLATE_TOP - 0.012, Math.cos(a) * (r + 0.07));
    puddle.rotation.set(0, a, 0);
    puddle.scale.set(0.2 * g + 1e-3, 0.04 * Math.sqrt(g) + 1e-3, 0.15 * g + 1e-3);
  }

  function updateDrips(p) {
    let o = 0;
    for (const d of drips) {
      const grow = sstep(d.s, d.s + 0.012, p);
      const L = d.L * easeOutCubic(span(p, d.s, 0.995));
      const ca = Math.cos(d.a), sa = Math.sin(d.a);
      const w0 = d.w * (0.4 + 0.6 * grow);
      const bR = w0 * (0.9 + 0.3 * sstep(0.05, 0.4, L));
      const sEnd = d.sBelly + L;
      const sC = Math.max(d.sBelly * 0.55, sEnd - bR);
      const ringAt = (sq, hw, th) => {
        const [r, y, nr, ny] = pathAt(d, sq);
        const off = th * 0.3;
        const cx = sa * (r + nr * off), cy = y + ny * off, cz = ca * (r + nr * off);
        // N3 = dir*nr + up*ny ; T = (cos a, 0, -sin a)
        for (let m = 0; m < DRIP_M; m++) {
          const ang = (m / DRIP_M) * TAU, c = Math.cos(ang) * hw, s = Math.sin(ang) * th;
          dripPos[o++] = cx + ca * c + sa * nr * s;
          dripPos[o++] = cy + ny * s;
          dripPos[o++] = cz - sa * c + ca * nr * s;
        }
      };
      if (grow <= 0) {
        const [r, y] = pathAt(d, 0);
        for (let m = 0; m < DRIP_RINGS * DRIP_M; m++) { dripPos[o++] = sa * r; dripPos[o++] = y - 0.01; dripPos[o++] = ca * r; }
        continue;
      }
      for (let k = 0; k <= DRIP_TRAIL; k++) {
        const u = k / DRIP_TRAIL;
        const sq = sC * (1 - Math.pow(1 - u, 1.35));
        let hw, th;
        if (sq < d.sBelly) {
          const e = sstep(0, d.sBelly, sq);
          hw = w0 * lerp(0.62, 1.0, e);
          th = lerp(0.01, w0 * 0.62, e * e);
        } else {
          const e = clamp((sq - d.sBelly) / 0.9);
          hw = w0 * (1 - 0.42 * Math.sqrt(e));
          th = hw * 0.66;
        }
        const dc = sq - sC; // bulge into the bulb
        if (dc > -bR) { const bb = Math.sqrt(Math.max(0, bR * bR - dc * dc)); hw = Math.max(hw, bb); th = Math.max(th, bb * 0.85); }
        ringAt(sq, hw, th);
      }
      for (let m = 1; m <= DRIP_CAP; m++) {
        const g = (m / DRIP_CAP) * (Math.PI / 2);
        const hw = bR * Math.cos(g) + 1e-4;
        ringAt(sC + bR * Math.sin(g), hw, hw * 0.85);
      }
    }
    dripGeo.attributes.position.needsUpdate = true;
    dripGeo.computeVertexNormals();
  }

  // pour stream: a wobbling glossy rope from above the frame to the impact point
  const STREAM_RINGS = 40, STREAM_M = 16;
  const streamGeo = track(new THREE.BufferGeometry());
  const streamPos = new Float32Array(STREAM_RINGS * STREAM_M * 3);
  const streamNrm = new Float32Array(streamPos.length);
  streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
  streamGeo.setAttribute('normal', new THREE.BufferAttribute(streamNrm, 3));
  {
    const idx = [];
    for (let k = 0; k < STREAM_RINGS - 1; k++) for (let a = 0; a < STREAM_M; a++) {
      const A = k * STREAM_M + a, B = k * STREAM_M + ((a + 1) % STREAM_M), C = A + STREAM_M, D = B + STREAM_M;
      idx.push(A, B, C, C, B, D);
    }
    streamGeo.setIndex(idx);
  }
  const stream = new THREE.Mesh(streamGeo, compoteMat);
  stream.castShadow = true;
  stream.frustumCulled = false;
  scene.add(stream);
  const impactSurf = stackSurf(impactW[0], impactW[1]);
  const IMPACT_Y = impactSurf[1] + POOL_TH * 0.6;
  const STREAM_TOP = STACK_TOP + 5.5;
  function updateStream(p, t) {
    const hp = span(p, POUR.head0, POUR.head1), tp = span(p, POUR.tail0, POUR.tail1);
    const vis = hp > 0 && tp < 1;
    stream.visible = vis;
    if (!vis) return;
    const yHead = lerp(STREAM_TOP, IMPACT_Y, easeInQuad(hp));
    const yTail = lerp(STREAM_TOP, IMPACT_Y, easeInQuad(tp));
    const len = Math.max(1e-3, yTail - yHead);
    const r0 = 0.072 * (1 - 0.5 * tp);
    let o = 0;
    for (let k = 0; k < STREAM_RINGS; k++) {
      const u = k / (STREAM_RINGS - 1); // 0 tail (top) .. 1 head (bottom)
      const y = lerp(yTail, yHead, u);
      const capT = tp > 0 ? Math.sqrt(clamp((y - yTail) / -Math.min(len, r0 * 2.5))) : 1;
      const capH = hp < 1 ? Math.sqrt(clamp((y - yHead) / Math.min(len, r0 * 2))) : 1;
      const above = y - IMPACT_Y;
      const r = r0 * (0.72 + 0.28 * clamp(above / 3)) * Math.min(capT, capH) + 1e-4;
      const wx = 0.012 * Math.sin(y * 6.5 - t * 5.2) * clamp(above / 0.5);
      const wz = 0.01 * Math.cos(y * 5.1 - t * 4.1) * clamp(above / 0.5);
      for (let m = 0; m < STREAM_M; m++) {
        const ang = (m / STREAM_M) * TAU, c = Math.cos(ang), s = Math.sin(ang);
        streamPos[o] = impactW[0] + wx + c * r; streamPos[o + 1] = y; streamPos[o + 2] = impactW[1] + wz + s * r;
        streamNrm[o] = c; streamNrm[o + 1] = 0; streamNrm[o + 2] = s;
        o += 3;
      }
    }
    streamGeo.attributes.position.needsUpdate = true;
    streamGeo.attributes.normal.needsUpdate = true;
  }

  // diced peaches carried by the compote
  const chunkGeo = track(new RoundedBoxGeometry(0.16, 0.13, 0.145, 3, 0.042));
  const chunkMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.04, specularIntensity: 1,
    emissive: 0xa83a00, emissiveIntensity: 0.22,
  }));
  const chunks = new THREE.InstancedMesh(chunkGeo, chunkMat, N_CHUNK);
  chunks.castShadow = true;
  chunks.frustumCulled = false;
  scene.add(chunks);
  const chunkData = [];
  {
    const r = mulberry32(2024);
    const col = new THREE.Color();
    const palette = [0xe8761c, 0xe06414, 0xee8a26, 0xd9561a, 0xea7e22];
    let tries = 0;
    while (chunkData.length < N_CHUNK && tries++ < 4000) {
      const front = chunkData.length < 9;
      const aw = front ? (r() - 0.5) * 2.9 : r() * TAU;
      const rr = 0.46 + r() * 0.34;
      const X = top.lx + Math.sin(aw) * rr, Z = top.lz + Math.cos(aw) * rr;
      const dx = X - impactW[0], dz = Z - impactW[1];
      let psi = Math.atan2(dx, dz); if (psi < 0) psi += TAU;
      const f = Math.hypot(dx, dz) / poolD[Math.round((psi / TAU) * POOL_NA)];
      if (f > 0.84) continue;
      if (chunkData.some((c) => Math.hypot(c.X - X, c.Z - Z) < 0.2)) continue;
      col.setHex(palette[chunkData.length % palette.length]);
      chunks.setColorAt(chunkData.length, col);
      chunkData.push({
        X, Z, f,
        rot: new THREE.Euler((r() - 0.5) * 0.9, r() * TAU, (r() - 0.5) * 0.9),
        s: 0.8 + r() * 0.4,
        sv: [0.85 + r() * 0.35, 0.8 + r() * 0.3, 0.85 + r() * 0.35],
      });
    }
    chunks.count = chunkData.length;
    chunks.instanceColor.needsUpdate = true;
  }
  const mtx = new THREE.Matrix4(), qC = new THREE.Quaternion(), vC = new THREE.Vector3(), sC3 = new THREE.Vector3();
  function updateChunks(p, b) {
    chunkData.forEach((c, i) => {
      const go = easeOutCubic(span(p, BLOOM.start + 0.003 + i * 0.0015, BLOOM.end - 0.005));
      const sc = sstep(BLOOM.start - 0.002, BLOOM.start + 0.012, p) * c.s;
      const X = lerp(impactW[0], c.X, go * 0.98), Z = lerp(impactW[1], c.Z, go * 0.98);
      const y = poolTopAt(X, Z, Math.max(b, 0.05)) + 0.006 * sc;
      qC.setFromEuler(c.rot);
      vC.set(X, y, Z);
      const k = Math.max(1e-4, sc);
      sC3.set(k * c.sv[0], k * c.sv[1], k * c.sv[2]);
      mtx.compose(vC, qC, sC3);
      chunks.setMatrixAt(i, mtx);
    });
    chunks.instanceMatrix.needsUpdate = true;
    chunks.visible = p > BLOOM.start - 0.002;
  }

  /* frosting crown */
  const zest = track(zestTexture(77));
  const frostMat = track(new THREE.MeshPhysicalMaterial({
    map: zest, roughness: 0.5, sheen: 0.15, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffe9a8),
    specularIntensity: 0.45,
  }));
  const frosting = new THREE.Mesh(track(buildFrostingGeometry()), frostMat);
  frosting.castShadow = true;
  scene.add(frosting);

  /* pose helpers (pure functions of p, t) */
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), vAxis = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  function landedCount(p) {
    let c = 0;
    for (const pan of pans) c += sstep(pan.start, pan.start + CONTACT * DROP_DUR, p);
    return c;
  }
  function pancakeBaseY(pan, p, Lc) {
    const hover = pan.hy0 - 0.5 * PITCH * Lc;
    const u = span(p, pan.start, pan.start + DROP_DUR);
    const f = u < CONTACT ? easeInQuad(u / CONTACT) : 1;
    return { hover, u, f, y: lerp(hover, pan.landY, f) };
  }
  // bouncy squash-and-settle after contact; v in [0,1]; returns [scaleY, scaleXZ, hop]
  function squash(v, amp, hop) {
    const sq = amp * Math.exp(-4.2 * v) * Math.cos(2.5 * Math.PI * v);
    const h = v > 0.1 && v < 0.55 ? hop * Math.sin((Math.PI * (v - 0.1)) / 0.45) : 0;
    return [1 - sq, 1 + 0.5 * sq, h];
  }

  function posePancakes(p, t) {
    const Lc = landedCount(p);
    for (const pan of pans) {
      const { mesh, ph } = pan;
      const { hover, u, f } = pancakeBaseY(pan, p, Lc);
      const air = 1 - sstep(0, 0.4, u);
      const settle = sstep(0, CONTACT, u);
      const bob = (0.06 * Math.sin(0.9 * t + ph[0]) + 0.018 * Math.sin(2.1 * t + ph[1])) * air;
      const hx = pan.hx + 0.035 * Math.sin(0.53 * t + ph[2]) * air;
      const hz = pan.hz + 0.03 * Math.sin(0.61 * t + ph[3]) * air;
      let y = lerp(hover + bob, pan.landY, f);
      if (u > 0 && u < 0.2) y += 0.06 * Math.sin(Math.PI * (u / 0.2)); // anticipation lift
      const x = lerp(hx, pan.lx, settle), z = lerp(hz, pan.lz, settle);
      const tilt = (pan.tilt0 + 0.07 * Math.sin(0.7 * t + ph[4]) * air) * (1 - settle);
      const ta = pan.tiltAxis + 0.35 * Math.sin(0.23 * t + ph[5]) * air;
      const yaw = lerp(pan.yaw0 + 0.45 * Math.sin(0.19 * t + ph[6]) * air, pan.yawLand, settle);
      let sy = 1, sxz = 1;
      if (u >= CONTACT) {
        const [a, b, h] = squash((u - CONTACT) / (1 - CONTACT), 0.17, 0.075);
        sy = a; sxz = b; y += h;
      } else if (u > 0.2) {
        const s = 0.035 * sstep(0.2, CONTACT, u);
        sy = 1 + s; sxz = 1 - 0.5 * s;
      }
      vAxis.set(Math.cos(ta), 0, Math.sin(ta));
      qA.setFromAxisAngle(vAxis, tilt);
      qB.setFromAxisAngle(UP, yaw);
      mesh.quaternion.copy(qA).multiply(qB);
      mesh.position.set(x, y, z);
      mesh.scale.set(sxz, sy, sxz);
    }
  }

  const qH = new THREE.Quaternion(), qT = new THREE.Quaternion(), vT = new THREE.Vector3();
  function sliceHover(sl, p, t, air) {
    const { cfg, ph } = sl;
    const a = cfg.ha + 0.07 * Math.sin(0.21 * t + ph[0]) * air;
    const y = lerp(cfg.y0, cfg.y1, sstep(DROP_START, DROP_END, p)) + (0.07 * Math.sin(0.83 * t + ph[1]) + 0.02 * Math.sin(1.9 * t + ph[2])) * air;
    vT.set(Math.sin(a) * cfg.hr, y, Math.cos(a) * cfg.hr);
    qT.setFromAxisAngle(sl.tumbleAxis, 0.45 * Math.sin(0.37 * t + ph[3]) * air);
    qH.setFromAxisAngle(UP, 0.5 * Math.sin(0.17 * t + ph[4]) * air).multiply(sl.qBase).multiply(qT);
    return [vT.clone(), qH.clone()];
  }
  function poseSlices(p, t) {
    for (const sl of slices) {
      const u = span(p, sl.cfg.settle, sl.cfg.settle + SLICE_DUR);
      const air = 1 - sstep(0, 0.3, u);
      const [hp, hq] = sliceHover(sl, p, t, air);
      const fall = clamp(u / 0.78);
      const yF = easeInQuad(fall);
      const radial = sstep(0.55, 1.0, fall);
      const g = sl.group;
      const hr = Math.hypot(hp.x, hp.z), ha = Math.atan2(hp.x, hp.z);
      const fr = Math.hypot(sl.finalPos.x, sl.finalPos.z), fa = Math.atan2(sl.finalPos.x, sl.finalPos.z);
      const r = lerp(hr, fr, radial);
      const a = ha + wrapAngle(fa - ha) * sstep(0.0, 0.8, fall);
      let y = lerp(hp.y, sl.finalPos.y, yF);
      if (u > 0.78) { const v = (u - 0.78) / 0.22; y += 0.05 * Math.sin(Math.PI * clamp(v / 0.6)) * (1 - v); }
      g.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
      g.quaternion.copy(hq).slerp(sl.qFinal, easeInOutCubic(sstep(0.0, 0.85, fall)));
    }
  }

  function butterBaseY(p) { return STACK_TOP - 0.004; }
  function poseButter(p) {
    const u = span(p, BUTTER.start, BUTTER.start + BUTTER.dur);
    butter.visible = p > BUTTER.start;
    if (!butter.visible) return { top: STACK_TOP };
    const H0 = 0.1;
    const f = u < 0.6 ? easeInQuad(u / 0.6) : 1;
    let sy = 1, sxz = 1, hop = 0;
    if (u >= 0.6) [sy, sxz, hop] = squash((u - 0.6) / 0.4, 0.22, 0.05);
    const soft = sstep(BUTTER.soft0, BUTTER.soft1, p);
    sy *= 1 - 0.45 * soft; sxz *= 1 + 0.17 * soft;
    const base = butterBaseY(p);
    const y = lerp(base + 3.2, base, f) + hop;
    butter.position.set(BUTTER_XZ[0], y + (H0 / 2) * sy, BUTTER_XZ[1]);
    butter.rotation.set((1 - sstep(0, 0.6, u)) * 0.7, BUTTER_YAW + (1 - sstep(0, 0.6, u)) * 0.8, 0);
    butter.scale.set(sxz, sy, sxz);
    return { top: base + H0 * (1 - 0.45 * soft) };
  }

  function poseFrosting(p, butterTop) {
    const u = span(p, FROST.start, FROST.start + FROST.dur);
    frosting.visible = p > FROST.start;
    if (!frosting.visible) return;
    const contact = 0.5;
    const f = u < contact ? easeInQuad(u / contact) : 1;
    let sy = 1, sxz = 1, hop = 0;
    if (u >= contact) [sy, sxz, hop] = squash((u - contact) / (1 - contact), 0.26, 0.06);
    else if (u > 0.15) { const s = 0.06 * sstep(0.15, contact, u); sy = 1 + s; sxz = 1 - 0.5 * s; }
    const soft = sstep(FROST.start + 0.04, 1.0, p);
    sy *= 1 - 0.07 * soft; sxz *= 1 + 0.03 * soft;
    const base = butterTop - 0.006;
    frosting.position.set(BUTTER_XZ[0], lerp(base + 3.4, base, f) + hop, BUTTER_XZ[1]);
    frosting.rotation.set(0, 0.6 + (1 - f) * 1.4, 0);
    frosting.scale.set(sxz, sy, sxz);
  }

  let lastCompP = -1, lastStreamKey = '';
  function poseCompote(p, t) {
    const b = easeOutCubic(span(p, BLOOM.start, BLOOM.end));
    pool.visible = b > 0;
    if (Math.abs(p - lastCompP) > 1e-6) {
      if (b > 0) updatePool(b);
      updateDrips(p);
      updatePuddle(p);
      updateChunks(p, b);
      lastCompP = p;
    }
    dripMesh.visible = p > DRIPS.reduce((m, d) => Math.min(m, d.s), 1);
    const key = `${p}|${t}`;
    if (key !== lastStreamKey) { updateStream(p, t); lastStreamKey = key; }
  }

  /* framing: subject extents from p alone (no idle), then fit + lens-shift */
  function subjectExtents(p) {
    const Lc = landedCount(p);
    let top = STACK_TOP;
    for (const pan of pans) {
      const { y, u } = pancakeBaseY(pan, p, Lc);
      const tiltPad = Math.abs(pan.tilt0) * 0.95 * (1 - sstep(0, CONTACT, u));
      top = Math.max(top, y + pan.P.T + tiltPad);
    }
    if (p > FROST.start) top = Math.max(top, STACK_TOP + 0.06 + FROST_H * sstep(FROST.start, FROST.start + FROST.dur * 0.5, p));
    let halfW = PLATE_R + 0.06;
    for (const sl of slices) {
      const u = span(p, sl.cfg.settle, sl.cfg.settle + SLICE_DUR);
      const hx = Math.abs(Math.sin(sl.cfg.ha) * sl.cfg.hr) + 0.42;
      halfW = Math.max(halfW, lerp(hx, 0, sstep(0, 0.8, u)));
    }
    return { top, bottom: -0.02, halfW };
  }

  let vw = 1, vh = 1;
  function placeCamera(p) {
    const aspect = vw / vh;
    const mobile = aspect < 1.1;
    const ext = subjectExtents(p);
    const camT = sstep(0.0, 0.9, p);
    const el = lerp(0.19, 0.45, camT);
    const hh = (ext.top - ext.bottom) / 2;
    const projH = hh * Math.cos(el) + (PLATE_R + 0.05) * Math.sin(el) * 0.9;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    let fracH, fracW, cx, cy;
    if (mobile) { fracH = 0.55; fracW = lerp(0.86, 0.93, camT); cx = 0.5; cy = lerp(0.69, 0.68, camT); }
    else { fracH = lerp(0.82, 0.64, camT); fracW = 0.42; cx = 0.685; cy = lerp(0.5, 0.53, camT); }
    const d = Math.max(projH / (fracH * tanV), ext.halfW / (fracW * tanV * aspect)) * 1.05;
    const ty = (ext.top + ext.bottom) / 2;
    camera.position.set(0, ty + Math.sin(el) * d, Math.cos(el) * d);
    camera.lookAt(0, ty, 0);
    camera.aspect = aspect;
    camera.setViewOffset(vw, vh, -(cx - 0.5) * vw, -(cy - 0.5) * vh, vw, vh);
    camera.near = Math.max(0.1, d - 9); camera.far = d + 14;
    camera.updateProjectionMatrix();
  }

  /* render state */
  function renderAt(p, t) {
    p = clamp(p);
    posePancakes(p, t);
    poseSlices(p, t);
    const bt = poseButter(p);
    poseFrosting(p, bt.top);
    poseCompote(p, t);
    placeCamera(p);
    renderer.render(scene, camera);
  }

  /* sizing */
  function resize() {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    vw = w; vh = h;
    const pr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1.5 : 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
  }
  resize();

  let destroyed = false;
  let raf = 0;
  let visible = true;
  let curP = null;
  let lastT = 0;
  const t0 = performance.now();
  let markReady = () => { window.__heroReady = true; markReady = () => {}; };

  const staticMode = !!frozen || reducedMotion;
  const staticP = frozen ? clamp(+frozen.p || 0) : 1;
  const staticT = frozen && Number.isFinite(+frozen.t) ? +frozen.t : 2;
  const drawStatic = () => renderAt(staticP, staticT);

  function loop(now) {
    raf = 0;
    if (destroyed || !visible || document.hidden) return;
    const t = (now - t0) / 1000;
    const dt = Math.min(0.1, Math.max(0, t - lastT));
    lastT = t;
    const target = clamp(getProgress());
    curP = curP == null ? target : curP + (target - curP) * (1 - Math.exp(-dt * 11));
    if (Math.abs(target - curP) < 1e-4) curP = target;
    renderAt(curP, t);
    markReady();
    raf = requestAnimationFrame(loop);
  }
  function start() { if (!raf && !destroyed && !staticMode && visible && !document.hidden) raf = requestAnimationFrame(loop); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  const ro = new ResizeObserver(() => {
    if (destroyed) return;
    resize();
    if (staticMode) drawStatic();
  });
  ro.observe(host);
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) start(); else stop();
  });
  io.observe(host);
  const onVis = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVis);

  if (staticMode) {
    drawStatic();
    requestAnimationFrame(() => markReady());
  } else {
    start();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    ro.disconnect();
    io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    scene.traverse((o) => {
      if (o.geometry) disposables.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => disposables.add(m));
    });
    for (const d of disposables) if (d && d.dispose) d.dispose();
    chunks.dispose();
    envRT.dispose();
    if (key.shadow.map) key.shadow.map.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  return {
    renderAt(p, t = 2) { if (!destroyed) renderAt(p, t); },
    destroy,
  };
}
