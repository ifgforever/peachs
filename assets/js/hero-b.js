// Hero variant B: "Midnight Slow-Mo"
// A dark, cinematic food-commercial shot: six pancakes hang in slow motion against deep espresso,
// backlit so their edges glow, then drop one at a time onto a slate plate. Butter lands and softens,
// amber syrup pours and runs down the sides, blueberries settle, sugar dust drifts through the light.
//
// Contract: mountHero(host, { getProgress, reducedMotion, frozen }) -> { renderAt(p, t), destroy() }
// Scene state is a pure function of (p, t): nothing accumulates between frames, so scrubbing works
// in both directions and frozen renders are reproducible.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/* ============================================================================================
 * Math helpers
 * ========================================================================================== */
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, k) => a + (b - a) * k;
const sstep = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const sstep5 = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * k * (k * (k * 6 - 15) + 10); };
const easeOut3 = (k) => 1 - Math.pow(1 - clamp(k), 3);
const easeInOut = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const smax = (a, b, k) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Periodic value noise on a 256 lattice (CPU side, used for textures and shape wobble).
function makeNoise2(seed) {
  const rnd = mulberry32(seed);
  const v = new Float32Array(256 * 256);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  const n = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let u = x - xi, w = y - yi;
    u = u * u * (3 - 2 * u); w = w * w * (3 - 2 * w);
    const x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
    const a = v[(y0 << 8) | x0], b = v[(y0 << 8) | x1], c = v[(y1 << 8) | x0], d = v[(y1 << 8) | x1];
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
  n.fbm = (x, y, oct = 4) => {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += amp * n(x * f + i * 17.3, y * f - i * 9.1); norm += amp; amp *= 0.5; f *= 2.03; }
    return s / norm;
  };
  return n;
}
const NOISE = makeNoise2(0x5EED);

/* ============================================================================================
 * Choreography constants (p = scroll progress 0..1)
 * ========================================================================================== */
const N = 6;                         // pancakes
const DROP_START = 0.08;
const DROP_END = 0.72;
const SLOT = (DROP_END - DROP_START) / N;
const FALL = 0.054;                  // p-span of one fall
const SQUASH = 0.04;                 // p-span of the squash-and-settle
const G = 0.92;                      // hover height above the landing spot right before a drop
const PITCH = 0.86;                  // vertical pitch of the floating column
const COMPRESS = 0.012;              // how much a landed pancake sinks into the dome below
const PLATE_TOP = 0;
const BUTTER_IN = 0.72, BUTTER_LAND = 0.778, BUTTER_SQ = 0.03;
const SYRUP_IN = 0.84;
const E_EDGE = 0.11;                 // radial depth of the rounded edge (pancake radius ~1)
const UVR = 1.14;                    // half-size covered by a pancake's planar texture tile

// squash curve: 0 at impact, quick compress to 1, damped rebound, back to 0
function squashCurve(q) {
  if (q <= 0 || q >= 1) return 0;
  if (q < 0.15) return Math.sin((q / 0.15) * Math.PI / 2);
  const x = (q - 0.15) / 0.85;
  return Math.exp(-4 * x) * Math.cos(x * Math.PI * 2.3) * (1 - x);
}

/* ============================================================================================
 * Pancake parameters (seeded, so every pancake is unique but identical on every load)
 * ========================================================================================== */
function pancakeParams(i) {
  const rnd = mulberry32(0xB0B5 + i * 7919);
  const R = 1.0 + (rnd() - 0.5) * 0.08;
  const T = 0.255 + rnd() * 0.05;
  const dome = 0.022 + rnd() * 0.02;
  const harm = [];
  for (let k = 2; k <= 9; k++) harm.push({ k, a: (0.024 / Math.pow(k - 1, 0.75)) * (0.4 + rnd()), ph: rnd() * TAU });
  const tw = [];
  for (let k = 1; k <= 3; k++) tw.push({ k, a: 0.035 * (0.5 + rnd()), ph: rnd() * TAU });
  // Floating pose: tops turned toward the camera, the tilt direction fans around the column.
  const dir = [-1.2, 0.9, -0.35, 1.45, -1.5, 0.4][i] + (rnd() - 0.5) * 0.4;
  const mag = (13 + rnd() * 8) * DEG;
  return {
    i, R, T, dome, harm, tw, bdome: 0.007,
    tiltX: Math.cos(dir) * mag * 0.7 + 7 * DEG,
    tiltZ: Math.sin(dir) * mag,
    fx: [0.0, 0.26, -0.2, 0.16, -0.24, 0.12][i] + (rnd() - 0.5) * 0.06,
    fz: (rnd() - 0.5) * 0.3,
    yawLand: rnd() * TAU,
    yawAir: (rnd() - 0.5) * 2.0,
    yawAmp: 0.6 + rnd() * 0.5, yawW: 0.07 + rnd() * 0.05,
    bobA: 0.045 + rnd() * 0.02, bobW: 0.55 + rnd() * 0.25,
    wobA: (1.6 + rnd() * 1.2) * DEG, wobW: 0.33 + rnd() * 0.2,
    ph1: rnd() * TAU, ph2: rnd() * TAU, ph3: rnd() * TAU, ph4: rnd() * TAU,
    lx: (rnd() - 0.5) * 0.11, lz: (rnd() - 0.5) * 0.09,
    ltx: (rnd() - 0.5) * 0.014, ltz: (rnd() - 0.5) * 0.014,
    brown: 0.5 + rnd() * 0.16,
    seedX: rnd() * 200, seedY: rnd() * 200,
  };
}

function outlineF(P, a) {
  let f = 1;
  for (const h of P.harm) f += h.a * Math.sin(h.k * a + h.ph);
  return f;
}
function thickF(P, a) {
  let f = 1;
  for (const h of P.tw) f += h.a * Math.sin(h.k * a + h.ph);
  return f;
}

// Make adjacent floating pancakes clear each other even at the extremes of their idle motion.
function resolveFloatingClearance(PS) {
  for (let j = 1; j < PS.length; j++) {
    const A = PS[j - 1], B = PS[j];
    for (let iter = 0; iter < 30; iter++) {
      let worst = Infinity;
      for (let s = 0; s < 48; s++) {
        const a = (s / 48) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        // vertical displacement of the rim point at angle a (small-angle tilt model, z toward camera)
        const hA = A.R * 1.06 * (Math.sin(A.tiltX) * sa - Math.sin(A.tiltZ) * ca);
        const hB = B.R * 1.06 * (Math.sin(B.tiltX) * sa - Math.sin(B.tiltZ) * ca);
        const dxz = Math.hypot(B.fx - A.fx, B.fz - A.fz);
        const gap = PITCH - A.bobA - B.bobA - (A.T / 2 + A.dome) - (B.T / 2 + B.bdome)
          - (hA - hB) - (A.wobA + B.wobA) * 1.1 - dxz * 0.15;
        worst = Math.min(worst, gap);
      }
      if (worst >= 0.07) break;
      B.tiltX = lerp(B.tiltX, A.tiltX, 0.15);
      B.tiltZ = lerp(B.tiltZ, A.tiltZ, 0.15);
    }
  }
}

// Static stack data: landing heights (no squash) and the initial floating heights.
function prepareStack(PS) {
  resolveFloatingClearance(PS);
  let cursor = PLATE_TOP;
  for (const P of PS) {
    P.landY = cursor + P.bdome + P.T / 2;
    cursor = P.landY + P.T / 2 + P.dome - COMPRESS;
  }
  PS.stackTop = cursor + COMPRESS;
  for (const P of PS) P.floatY0 = PS[0].landY + G + P.i * PITCH;
  return PS;
}

// Pancake poses as a pure function of (p, t). Writes {x,y,z,tx,yaw,tz,sy,sxz,air} into out[i].
function stackPoses(PS, p, t, out) {
  const c = clamp((p - DROP_START) / SLOT, 0, N);
  const sq = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    const ld = DROP_START + j * SLOT + FALL;
    const s = squashCurve((p - ld) / SQUASH);
    if (s === 0) continue;
    sq[j] += s;
    for (let k = j - 1, w = 0.42; k >= 0; k--, w *= 0.55) sq[k] += s * w;
  }
  let cursor = PLATE_TOP;
  for (let i = 0; i < N; i++) {
    const P = PS[i], o = out[i];
    const st = DROP_START + i * SLOT, ld = st + FALL;
    const idleYaw = P.yawAir + P.yawAmp * Math.sin(P.yawW * t + P.ph1);
    const precess = 0.35 * Math.sin(0.21 * t + P.ph2);
    const cp = Math.cos(precess), sp = Math.sin(precess);
    const ftx = (P.tiltX * cp - P.tiltZ * sp) + P.wobA * Math.sin(P.wobW * t + P.ph3);
    const ftz = (P.tiltX * sp + P.tiltZ * cp) + P.wobA * Math.sin(P.wobW * 0.83 * t + P.ph4);
    const bob = P.bobA * Math.sin(P.bobW * t + P.ph3 * 1.3);
    o.sy = 1; o.sxz = 1;
    if (p >= ld) {                                   // landed: squash-and-settle, then still
      o.sy = 1 - 0.11 * sq[i]; o.sxz = 1 + 0.045 * sq[i];
      o.y = cursor + P.bdome * o.sy + (P.T / 2) * o.sy;
      cursor = o.y + (P.T / 2 + P.dome) * o.sy - COMPRESS;
      o.x = P.lx; o.z = P.lz; o.tx = P.ltx; o.tz = P.ltz; o.yaw = P.yawLand;
      o.air = 0;
    } else if (p >= st) {                            // falling: gravity ease-in, tilt resolves
      const f = (p - st) / FALL;
      const k = Math.pow(1 - f, 1.6);
      o.air = 1 - f;
      o.y = cursor + P.bdome + P.T / 2 + G * (1 - f * f) + bob * o.air;
      const e = easeInOut(f);
      o.x = lerp(P.fx, P.lx, e); o.z = lerp(P.fz, P.lz, e);
      o.tx = lerp(P.ltx, ftx, k); o.tz = lerp(P.ltz, ftz, k);
      o.yaw = P.yawLand + idleYaw * k;
    } else {                                         // floating: column eases down as the stack grows
      o.air = 1;
      const hov = i === 0 ? P.floatY0 : lerp(P.floatY0, P.landY + G, c / i);
      o.y = hov + bob;
      o.x = P.fx; o.z = P.fz; o.tx = ftx; o.tz = ftz; o.yaw = P.yawLand + idleYaw;
    }
  }
  return out;
}

/* ============================================================================================
 * Pancake textures (CPU, procedural): colour atlas + (height, roughness) atlas, 3 x 2 tiles
 * ========================================================================================== */
const TILE = 512;
const RAMP = [ // browning ramp, sRGB
  [0.00, 246, 222, 172], [0.2, 236, 194, 124], [0.4, 212, 150, 80], [0.58, 182, 114, 52],
  [0.76, 140, 78, 34], [1.00, 86, 44, 20],
];
function ramp(b, out) {
  b = clamp(b);
  for (let k = 1; k < RAMP.length; k++) {
    if (b <= RAMP[k][0] || k === RAMP.length - 1) {
      const A = RAMP[k - 1], B = RAMP[k], f = clamp((b - A[0]) / (B[0] - A[0]));
      out[0] = A[1] + (B[1] - A[1]) * f; out[1] = A[2] + (B[2] - A[2]) * f; out[2] = A[3] + (B[3] - A[3]) * f;
      return out;
    }
  }
  return out;
}

function paintPancakeTile(P, col, hr, W, ox, oy) {
  const S = TILE;
  const bf = new Float32Array(S * S);   // browning
  const hf = new Float32Array(S * S);   // height
  const rf = new Float32Array(S * S);   // roughness
  const nz = NOISE, sx = P.seedX, sy = P.seedY;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = ((px + 0.5) / S * 2 - 1) * UVR, z = ((py + 0.5) / S * 2 - 1) * UVR;
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z) / (P.R * outlineF(P, a));   // 1 = pancake edge
      const m1 = nz.fbm(x * 1.5 + sx, z * 1.5 + sy, 4);
      const m2 = nz.fbm(x * 4.2 + sy, z * 4.2 + sx, 4);
      const wx = x + 0.35 * (m1 - 0.5), wz = z + 0.35 * (m2 - 0.5);
      const m3 = nz.fbm(wx * 8.5 + sx * 0.7, wz * 8.5 + sy * 0.3, 3);
      const blot = sstep(0.5, 0.7, m3);                          // darker browned blotches
      const lf = nz.fbm(wx * 17 + sy * 0.5, wz * 17 + sx * 0.5, 2);
      const ring = sstep(0.74, 0.88, r) * (1 - sstep(0.94, 0.995, r));
      const lace = sstep(0.42, 0.62, lf);                        // lacy light/dark cells near the rim
      const speck = nz(x * 46 + sx, z * 46 + sy);
      let b = P.brown + 0.2 * (m1 - 0.5) + 0.1 * (m2 - 0.5)
        + 0.1 * blot * (1 - ring * 0.6)
        + 0.08 * (1 - sstep(0, 0.6, r))         // centre cooks a touch darker
        + ring * (0.14 * (lace - 0.5) - 0.1)    // paler, lacy ring where the batter thinned out
        + 0.3 * sstep(0.92, 1.0, r)             // darker cooked rim over the rounded edge
        + 0.06 * (speck - 0.5);
      let h = 0.5 + 0.2 * (m2 - 0.5) + 0.06 * blot + 0.08 * ring * (lace - 0.5) + 0.05 * (speck - 0.5);
      h = lerp(h, 0.5, sstep(0.86, 0.95, r));
      const k = py * S + px;
      bf[k] = b; hf[k] = h; rf[k] = 0.8 - 0.07 * blot - 0.06 * (m1 - 0.5);
    }
  }
  // Bubble pores: small dark pits with a faint pale halo.
  const rnd = mulberry32(0xF00D + P.i * 131);
  const pores = 460 + Math.floor(rnd() * 140);
  for (let n = 0; n < pores; n++) {
    const rr = Math.sqrt(rnd()) * 0.86, aa = rnd() * TAU;
    const cx = Math.cos(aa) * rr * P.R, cz = Math.sin(aa) * rr * P.R;
    const ppx = (cx / UVR + 1) / 2 * S, ppy = (cz / UVR + 1) / 2 * S;
    const rad = 0.8 + Math.pow(rnd(), 2.6) * 2.2;
    const depth = 0.14 + rnd() * 0.2;
    const ext = Math.ceil(rad * 2.2);
    for (let yy = -ext; yy <= ext; yy++) {
      for (let xx = -ext; xx <= ext; xx++) {
        const qx = Math.floor(ppx) + xx, qy = Math.floor(ppy) + yy;
        if (qx < 0 || qy < 0 || qx >= S || qy >= S) continue;
        const d = Math.hypot(qx + 0.5 - ppx, qy + 0.5 - ppy) / rad;
        const k = qy * S + qx;
        if (d < 1) {
          const w = 1 - sstep(0.45, 1, d);
          bf[k] += depth * w; hf[k] -= 0.38 * w; rf[k] -= 0.12 * w;
        } else if (d < 2.1) {
          const w = (1 - sstep(1, 2.1, d)) * 0.5;
          bf[k] -= 0.05 * w; hf[k] += 0.05 * w;
        }
      }
    }
  }
  const c = [0, 0, 0];
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const k = py * S + px;
      ramp(bf[k], c);
      const o = ((oy + py) * W + (ox + px)) * 4;
      col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2]; col[o + 3] = 255;
      const o2 = ((oy + py) * W + (ox + px)) * 2;
      hr[o2] = clamp(hf[k]) * 255; hr[o2 + 1] = clamp(rf[k], 0.2, 1) * 255;
    }
  }
}

async function makePancakeAtlas(PS) {
  const W = TILE * 3, H = TILE * 2;
  const col = new Uint8Array(W * H * 4);
  const hr = new Uint8Array(W * H * 2);
  for (let i = 0; i < PS.length; i++) {
    paintPancakeTile(PS[i], col, hr, W, (i % 3) * TILE, Math.floor(i / 3) * TILE);
    await new Promise((r) => setTimeout(r, 0));   // keep each main-thread task short
  }
  const colTex = new THREE.DataTexture(col, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  colTex.colorSpace = THREE.SRGBColorSpace;
  const hrTex = new THREE.DataTexture(hr, W, H, THREE.RGFormat, THREE.UnsignedByteType);
  for (const t of [colTex, hrTex]) {
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  }
  return { colTex, hrTex };
}

/* ============================================================================================
 * Pancake geometry: polar grid (top cap -> rounded superellipse edge -> bottom cap), no seams.
 * ========================================================================================== */
function pancakeProfile(P) {
  const Rc = 1 - E_EDGE, Hh = P.T / 2;
  const prof = [];   // {r (fraction of outline radius), y, zone (-1 bottom face .. 0 side .. 1 top face)}
  const KT = 10, KE = 18, KB = 6;
  for (let k = 1; k <= KT; k++) {
    const rr = Rc * Math.pow(k / KT, 0.85);
    prof.push({ r: rr, y: Hh + P.dome * (1 - (rr / Rc) ** 2), zone: 1, top: true });
  }
  for (let k = 1; k < KE; k++) {
    const ph = Math.PI / 2 - Math.PI * k / KE;
    const c = Math.cos(ph), s = Math.sin(ph);
    const n = s > 0 ? 2.5 : 3.2;
    const rr = Rc + E_EDGE * Math.pow(Math.abs(c), 2 / n);
    const y = Hh * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    prof.push({ r: rr, y, zone: y / Hh });
  }
  for (let k = KB; k >= 1; k--) {
    const rr = Rc * Math.pow(k / KB, 0.85);
    prof.push({ r: rr, y: -Hh - P.bdome * (1 - (rr / Rc) ** 2), zone: -1 });
  }
  return prof;
}

function buildPancakeGeometry(P, tile) {
  const SEG = 120;
  const prof = pancakeProfile(P);
  const M = prof.length;
  const nV = 2 + M * SEG;
  const pos = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), zone = new Float32Array(nV);
  const tu0 = (tile % 3) / 3, tv0 = Math.floor(tile / 3) / 2;
  const setUV = (idx, x, z) => {
    uv[idx * 2] = tu0 + ((x / UVR + 1) / 2) / 3;
    uv[idx * 2 + 1] = tv0 + ((z / UVR + 1) / 2) / 2;
  };
  const topY = P.T / 2 + P.dome;
  pos.set([0, topY, 0], 0); setUV(0, 0, 0); zone[0] = 1;
  for (let m = 0; m < M; m++) {
    const pr = prof[m];
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * TAU;
      const f = P.R * outlineF(P, a);
      const x = Math.cos(a) * pr.r * f, z = Math.sin(a) * pr.r * f;
      let y = pr.y * thickF(P, a);
      if (pr.top) y += 0.012 * (NOISE.fbm(x * 1.3 + P.seedX, z * 1.3 + P.seedY, 2) - 0.5) * sstep(0, 0.4, pr.r);
      const idx = 1 + m * SEG + j;
      pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
      setUV(idx, x, z); zone[idx] = pr.zone;
    }
  }
  const last = nV - 1;
  pos.set([0, -P.T / 2 - P.bdome, 0], last * 3); setUV(last, 0, 0); zone[last] = -1;
  const ind = [];
  const ring = (m, j) => 1 + m * SEG + (j % SEG);
  for (let j = 0; j < SEG; j++) ind.push(0, ring(0, j + 1), ring(0, j));
  for (let m = 0; m < M - 1; m++) {
    for (let j = 0; j < SEG; j++) {
      const a = ring(m, j), b = ring(m, j + 1), c = ring(m + 1, j), d = ring(m + 1, j + 1);
      ind.push(a, d, c, a, b, d);
    }
  }
  for (let j = 0; j < SEG; j++) ind.push(ring(M - 1, j), ring(M - 1, j + 1), last);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aZone', new THREE.BufferAttribute(zone, 1));
  g.setIndex(ind);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Height of the top surface of pancake P at local polar (a, s) where s is the fraction of radius.
function pancakeTopY(P, s) {
  const Rc = 1 - E_EDGE;
  return P.T / 2 + P.dome * (1 - Math.min(1, (s / Rc) ** 2));
}

/* ============================================================================================
 * Shared GLSL
 * ========================================================================================== */
const GLSL_NOISE = /* glsl */`
float hb_hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float hb_noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hb_hash13(i), hb_hash13(i + vec3(1,0,0)), f.x), mix(hb_hash13(i + vec3(0,1,0)), hb_hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hb_hash13(i + vec3(0,0,1)), hb_hash13(i + vec3(1,0,1)), f.x), mix(hb_hash13(i + vec3(0,1,1)), hb_hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

/* ============================================================================================
 * mountHero
 * ========================================================================================== */
export async function mountHero(host, { getProgress = () => 0, reducedMotion = false, frozen = null } = {}) {
  // --- WebGL first, before touching the DOM -------------------------------------------------
  const canvas = document.createElement('canvas');
  let renderer;
  try {
    const probe = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!probe) throw new Error('no webgl2');
    renderer = new THREE.WebGLRenderer({ canvas, context: probe, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('webgl-unavailable');
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x160C07, 1);

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = makeStudioEnv();
  const envRT = pmrem.fromScene(envScene, 0.02);
  envScene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.9;

  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 200);

  /* ---------------- Background: espresso gradient + peach glow behind the subject ---------- */
  const bgMat = track(new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      uAspect: { value: 1 }, uCenter: { value: new THREE.Vector2(0.36, 0) }, uSize: { value: new THREE.Vector2(0.9, 1.0) },
      uGlow: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec2 vNdc;
      void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uAspect; uniform vec2 uCenter; uniform vec2 uSize; uniform float uGlow;
      varying vec2 vNdc;
      float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main() {
        vec2 q = (vNdc - uCenter) * vec2(uAspect, 1.0);
        float d = length(q);
        // base espresso falloff (sRGB authored, matches the CSS recommendation)
        vec3 c0 = vec3(42.0, 21.0, 11.0) / 255.0;   // #2A150B
        vec3 c1 = vec3(33.0, 17.0, 10.0) / 255.0;   // #21110A
        vec3 c2 = vec3(22.0, 12.0, 7.0) / 255.0;    // #160C07
        float k = clamp(d / 2.2, 0.0, 1.0);
        vec3 col = mix(mix(c0, c1, smoothstep(0.0, 0.45, k)), c2, smoothstep(0.45, 1.0, k));
        // soft peach glow (#F9AE7F) behind the subject
        vec2 g = (vNdc - uCenter) * vec2(uAspect, 1.0) / uSize;
        float gr = length(g);
        float glow = 0.24 * exp(-gr * gr * 2.6) + 0.07 * exp(-gr * gr * 0.7);
        col = mix(col, vec3(249.0, 174.0, 127.0) / 255.0, glow * uGlow);
        // vignette toward the frame edges
        vec2 v = vNdc * vec2(0.85, 1.0);
        col *= 1.0 - 0.28 * smoothstep(0.6, 1.5, length(v));
        // dither to kill banding in the dark gradient
        col += (h12(gl_FragCoord.xy) - 0.5) / 255.0 * 1.5;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  const bgGeo = track(new THREE.PlaneGeometry(2, 2));
  const bg = new THREE.Mesh(bgGeo, bgMat);
  bg.frustumCulled = false; bg.renderOrder = -1000;
  scene.add(bg);

  /* ---------------- Lights ------------------------------------------------------------------ */
  // Low-key rig: a warm side key from camera-left, two strong back/rim lights that make edges and
  // syrup glow against the dark, and a very small warm fill so the food never goes muddy.
  const key = new THREE.DirectionalLight(0xFFD9B0, 1.75);
  key.position.set(-4.8, 6.6, 4.2);
  key.target.position.set(0, 2.2, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2.7, right: 2.7, top: 3.9, bottom: -3.9, near: 1, far: 24 });
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.025; key.shadow.radius = 3;
  scene.add(key, key.target);
  const rimA = new THREE.DirectionalLight(0xFFAA66, 7.0);   // back-right, high
  rimA.position.set(2.8, 4.4, -5.5);
  const rimB = new THREE.DirectionalLight(0xFF9A58, 3.6);   // back-left, low
  rimB.position.set(-4.6, 1.6, -4.4);
  const front = new THREE.DirectionalLight(0xFFE2C4, 0.55); // faint frontal fill (keeps the crumb creamy)
  front.position.set(1.5, 1.2, 6);
  const hemi = new THREE.HemisphereLight(0x7A4C30, 0x120804, 0.35);
  scene.add(rimA, rimB, front, hemi);

  /* ---------------- Stage (everything that sways gently together) --------------------------- */
  const stage = new THREE.Group();
  scene.add(stage);

  /* ---------------- Plate: dark slate stoneware -------------------------------------------- */
  const plateProfile = [
    [0.0, -0.05], [0.95, -0.058], [1.0, -0.075], [1.1, -0.075], [1.14, -0.06], [1.32, -0.035], [1.5, -0.005],
    [1.62, 0.04], [1.66, 0.075], [1.655, 0.1], [1.63, 0.115], [1.58, 0.112], [1.5, 0.092], [1.42, 0.062],
    [1.34, 0.03], [1.26, 0.008], [1.18, 0.0], [0.0, 0.0],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const plateGeo = track(new THREE.LatheGeometry(plateProfile, 128));
  const plateMat = track(new THREE.MeshPhysicalMaterial({
    color: 0x1A1B1E, roughness: 0.6, metalness: 0,
    specularIntensity: 0.26, envMap: envRT.texture, envMapIntensity: 0.38,
  }));
  plateMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPL;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPL = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPL;\n' + GLSL_NOISE)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float pn = hb_noise3(vPL * 9.0) * 0.5 + hb_noise3(vPL * 27.0) * 0.3 + hb_noise3(vPL * 80.0) * 0.2;
        float speck = smoothstep(0.78, 0.86, hb_noise3(vPL * 140.0));
        diffuseColor.rgb *= 0.82 + 0.3 * pn;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.19, 0.18), speck * 0.35);`);
  };
  plateMat.customProgramCacheKey = () => 'hb-plate';
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.receiveShadow = true;
  stage.add(plate);

  // Soft contact shadow under the plate (grounds it in the dark void)
  const shadowTex = track(radialTexture(256, [[0, 0.75], [0.45, 0.45], [0.75, 0.12], [1, 0]]));
  const groundShadow = new THREE.Mesh(track(new THREE.PlaneGeometry(4.6, 4.6)), track(new THREE.MeshBasicMaterial({
    map: shadowTex, color: 0x000000, transparent: true, depthWrite: false, opacity: 0.85, toneMapped: false,
  })));
  groundShadow.rotation.x = -Math.PI / 2; groundShadow.position.y = -0.078;
  groundShadow.renderOrder = -10;
  stage.add(groundShadow);

  /* ---------------- Pancakes ---------------------------------------------------------------- */
  const PS = Array.from({ length: N }, (_, i) => pancakeParams(i));
  prepareStack(PS);
  const { colTex, hrTex } = await makePancakeAtlas(PS);
  track(colTex); track(hrTex);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  colTex.anisotropy = hrTex.anisotropy = Math.min(8, maxAniso);

  const crumbCols = ['#F8D597', '#F5CD8B', '#F9DA9F', '#F3CA86', '#F7D393', '#F6D08F'];
  const pancakes = PS.map((P, i) => {
    const geo = track(buildPancakeGeometry(P, i));
    const mat = track(new THREE.MeshPhysicalMaterial({
      map: colTex, bumpMap: hrTex, bumpScale: 1.6, roughnessMap: hrTex, roughness: 1.0,
      sheen: 0.6, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xFFC890),
    }));
    const uni = { uCrumb: { value: new THREE.Color(crumbCols[i]) }, uRim: { value: new THREE.Color('#B9793A') } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aZone;\nvarying float vZone;\nvarying vec3 vLoc;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZone = aZone; vLoc = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vZone;\nvarying vec3 vLoc;\nuniform vec3 uCrumb;\nuniform vec3 uRim;\n' + GLSL_NOISE)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float hbAz = abs(vZone);
          float hbSide = 1.0 - smoothstep(0.4, 0.9, hbAz);
          float hbRim = smoothstep(0.22, 0.72, hbAz) * (1.0 - smoothstep(0.88, 1.0, hbAz));
          float hbN = hb_noise3(vLoc * vec3(40.0, 70.0, 40.0)) * 0.55 + hb_noise3(vLoc * 120.0) * 0.45;
          vec3 hbCrumb = uCrumb * (0.84 + 0.3 * hbN);
          hbCrumb *= 1.0 - 0.35 * smoothstep(0.74, 0.92, hb_noise3(vLoc * vec3(150.0, 260.0, 150.0)));
          vec3 hbSideCol = mix(hbCrumb, uRim * (0.85 + 0.3 * hbN), hbRim * 0.9);
          diffuseColor.rgb = mix(diffuseColor.rgb, hbSideCol, hbSide);
          diffuseColor.rgb *= mix(1.0, 0.86, step(vZone, -0.95));`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.92, hbSide);`);
    };
    mat.customProgramCacheKey = () => 'hb-pancake';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    stage.add(mesh);
    return mesh;
  });

  /* ---------------- Pose computation (pure function of p, t) -------------------------------- */
  const _e = new THREE.Euler(0, 0, 0, 'XZY');
  const poses = PS.map(() => ({}));
  function poseScene(p, t) {
    stackPoses(PS, p, t, poses);
    for (let i = 0; i < N; i++) {
      const o = poses[i], m = pancakes[i];
      m.position.set(o.x, o.y, o.z);
      _e.set(o.tx, o.yaw, o.tz);
      m.rotation.copy(_e);
      m.scale.set(o.sxz, o.sy, o.sxz);
    }
    stage.rotation.y = 0.16 * Math.sin(0.05 * t + 0.4);
  }

  /* ---------------- Landed poses (static once everything is down) -------------------------- */
  poseScene(1, 0);
  const landed = pancakes.map((m, i) => {
    m.updateMatrix();
    return { P: PS[i], M: m.matrix.clone(), x: m.position.x, y: m.position.y, z: m.position.z, yaw: m.rotation.y };
  });
  const TOP = landed[N - 1];
  const topP = TOP.P;
  const topRot = new THREE.Matrix4().extractRotation(TOP.M);

  // Arc-length parametrisation of the top pancake's upper surface: sigma -> (r, y, normal).
  const sigmaTab = (() => {
    const prof = pancakeProfile(topP);
    const pts = [{ r: 0, y: topP.T / 2 + topP.dome }];
    for (const q of prof) { if (q.zone < -0.75) break; pts.push(q); }
    const out = [];
    let acc = 0;
    for (let k = 0; k < pts.length; k++) {
      if (k > 0) acc += Math.hypot(pts[k].r - pts[k - 1].r, pts[k].y - pts[k - 1].y);
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      let tr = b.r - a.r, ty = b.y - a.y;
      const l = Math.hypot(tr, ty) || 1;
      out.push({ s: acc, r: pts[k].r, y: pts[k].y, nr: -ty / l, ny: tr / l, top: !!pts[k].top || k === 0 });
    }
    return out;
  })();
  const SIG_EDGE = sigmaTab.filter((q) => q.top).pop().s;
  const SIG_EQ = (() => { for (const q of sigmaTab) if (q.y <= 0.02) return q.s; return sigmaTab[sigmaTab.length - 1].s; })();
  const _sig = { r: 0, y: 0, nr: 0, ny: 1 };
  function sigmaAt(s) {
    const tab = sigmaTab;
    if (s <= 0) { _sig.r = 0; _sig.y = tab[0].y; _sig.nr = 0; _sig.ny = 1; return _sig; }
    let k = 1;
    while (k < tab.length - 1 && tab[k].s < s) k++;
    const A = tab[k - 1], B = tab[k], f = clamp((s - A.s) / Math.max(1e-6, B.s - A.s));
    _sig.r = lerp(A.r, B.r, f); _sig.y = lerp(A.y, B.y, f);
    const nr = lerp(A.nr, B.nr, f), ny = lerp(A.ny, B.ny, f), l = Math.hypot(nr, ny) || 1;
    _sig.nr = nr / l; _sig.ny = ny / l;
    return _sig;
  }
  const lumpY = (P, x, z, r) => 0.012 * (NOISE.fbm(x * 1.3 + P.seedX, z * 1.3 + P.seedY, 2) - 0.5) * sstep(0, 0.4, r);

  /* ---------------- Dynamic liquid meshes (rebuilt only when p changes) ------------------- */
  function makeDyn(maxV, maxI, mat) {
    const pos = new Float32Array(maxV * 3), nrm = new Float32Array(maxV * 3), thin = new Float32Array(maxV);
    const idx = new Uint32Array(maxI);
    const g = track(new THREE.BufferGeometry());
    const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const na = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
    const ta = new THREE.BufferAttribute(thin, 1).setUsage(THREE.DynamicDrawUsage);
    const ia = new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa); g.setAttribute('normal', na); g.setAttribute('aThin', ta); g.setIndex(ia);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 14);
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    const D = {
      mesh, nv: 0, ni: 0,
      reset() { this.nv = 0; this.ni = 0; },
      v(x, y, z, th) { const k = this.nv++; pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; thin[k] = th; return k; },
      tri(a, b, c) { idx[this.ni++] = a; idx[this.ni++] = b; idx[this.ni++] = c; },
      finish() {
        nrm.fill(0, 0, this.nv * 3);
        for (let f = 0; f < this.ni; f += 3) {
          const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
          const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
          const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
        }
        for (let k = 0; k < this.nv; k++) {
          const o = k * 3, l = Math.hypot(nrm[o], nrm[o + 1], nrm[o + 2]) || 1;
          nrm[o] /= l; nrm[o + 1] /= l; nrm[o + 2] /= l;
        }
        g.setDrawRange(0, this.ni);
        pa.needsUpdate = na.needsUpdate = ta.needsUpdate = ia.needsUpdate = true;
        mesh.visible = this.ni > 0;
      },
    };
    return D;
  }

  // Fake translucency: backlit syrup glows amber at grazing angles and where it is thin.
  function addGlow(mat, glowHex, base, rim, thinK, key) {
    const uni = { uGlow: { value: new THREE.Color(glowHex) } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aThin;\nvarying float vThin;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvThin = aThin;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vThin;\nuniform vec3 uGlow;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float hbF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance += uGlow * (${base.toFixed(3)} + ${rim.toFixed(3)} * pow(hbF, 2.2) + ${thinK.toFixed(3)} * vThin);`);
    };
    mat.customProgramCacheKey = () => key;
  }

  const syrupMat = track(new THREE.MeshPhysicalMaterial({
    color: 0x2A0C02, roughness: 0.07, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02,
    envMap: envRT.texture, envMapIntensity: 1.7, specularIntensity: 1, ior: 1.48,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  addGlow(syrupMat, 0xD8680F, 0.035, 0.95, 0.24, 'hb-syrup');
  const butterMeltMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xF0C45A, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05,
    envMap: envRT.texture, envMapIntensity: 1.1,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  }));
  addGlow(butterMeltMat, 0x8A5A10, 0.05, 0.35, 0.25, 'hb-melt');
  const syrupD = makeDyn(14000, 80000, syrupMat);
  const meltD = makeDyn(2400, 13000, butterMeltMat);
  syrupD.mesh.castShadow = false; syrupD.mesh.receiveShadow = true;
  stage.add(syrupD.mesh, meltD.mesh);

  const _lp = new THREE.Vector3(), _ln = new THREE.Vector3();
  // A liquid film on the top pancake. Polar grid around (cx, cz) in pancake-local space; rhoFn(theta)
  // gives the reach (for cx = cz = 0 it is arc length, so it can wrap over the rounded edge).
  function addPool(D, cx, cz, rhoFn, h0, A, SR, thinFrom) {
    const P = topP, centred = cx === 0 && cz === 0;
    const put = (theta, u, rho) => {
      let a, s;
      if (centred) { a = theta; s = u * rho; }
      else { const px = cx + Math.cos(theta) * u * rho, pz = cz + Math.sin(theta) * u * rho; a = Math.atan2(pz, px); s = Math.hypot(px, pz); }
      const q = sigmaAt(s);
      const f = P.R * outlineF(P, a), tk = thickF(P, a);
      const x = Math.cos(a) * q.r * f, z = Math.sin(a) * q.r * f;
      let y = q.y * tk;
      if (q.ny > 0.9) y += lumpY(P, x, z, q.r);
      _ln.set(Math.cos(a) * q.nr, q.ny, Math.sin(a) * q.nr).normalize();
      const h = h0 * Math.sqrt(Math.max(0, 1 - Math.pow(u, 2.6))) + 0.0045;
      _lp.set(x, y, z).addScaledVector(_ln, h).applyMatrix4(TOP.M);
      return D.v(_lp.x, _lp.y, _lp.z, sstep(thinFrom, 1, u));
    };
    const c0 = put(0, 0, 0);
    const rings = [];
    for (let m = 1; m <= SR; m++) {
      const u = 1 - Math.pow(1 - m / SR, 1.7);
      const ring = [];
      for (let j = 0; j < A; j++) { const th = (j / A) * TAU; ring.push(put(th, u, rhoFn(th))); }
      rings.push(ring);
    }
    for (let j = 0; j < A; j++) D.tri(c0, rings[0][(j + 1) % A], rings[0][j]);
    for (let m = 0; m < SR - 1; m++) {
      const R0 = rings[m], R1 = rings[m + 1];
      for (let j = 0; j < A; j++) {
        const a = R0[j], b = R0[(j + 1) % A], c = R1[j], d = R1[(j + 1) % A];
        D.tri(a, d, c); D.tri(a, b, d);
      }
    }
  }

  // A tube of horizontal elliptical rings, capped at both ends. pts: {x,y,z,w,h,dx,dz,thin}
  function addTube(D, pts, SEGS = 12) {
    if (pts.length < 2) return;
    const rings = [];
    for (const q of pts) {
      const ring = [];
      const tx = -q.dz, tz = q.dx;
      for (let j = 0; j < SEGS; j++) {
        const ph = (j / SEGS) * TAU, c = Math.cos(ph), s = Math.sin(ph);
        ring.push(D.v(q.x + q.dx * q.h * c + tx * q.w * s, q.y, q.z + q.dz * q.h * c + tz * q.w * s, q.thin));
      }
      rings.push(ring);
    }
    const a0 = pts[0], a1 = pts[pts.length - 1];
    const top = D.v(a0.x, a0.y + 0.002, a0.z, a0.thin), tip = D.v(a1.x, a1.y - 0.002, a1.z, a1.thin);
    for (let j = 0; j < SEGS; j++) D.tri(top, rings[0][(j + 1) % SEGS], rings[0][j]);
    for (let m = 0; m < rings.length - 1; m++) {
      const R0 = rings[m], R1 = rings[m + 1];
      for (let j = 0; j < SEGS; j++) {
        const a = R0[j], b = R0[(j + 1) % SEGS], c = R1[j], d = R1[(j + 1) % SEGS];
        D.tri(a, b, c); D.tri(b, d, c);
      }
    }
    const L = rings[rings.length - 1];
    for (let j = 0; j < SEGS; j++) D.tri(L[j], L[(j + 1) % SEGS], tip);
  }

  // Stack silhouette radius along stage direction alpha at height y (max over landed pancakes).
  function edgeR(Lp, y, alpha) {
    const P = Lp.P, a = alpha + Lp.yaw, tk = thickF(P, a), Hh = (P.T / 2) * tk, yl = y - Lp.y;
    if (yl > Hh || yl < -Hh) return -1;
    const n = yl > 0 ? 2.5 : 3.2;
    const s = Math.pow(Math.abs(yl) / Hh, n / 2), c = Math.sqrt(Math.max(0, 1 - s * s));
    const rr = (1 - E_EDGE) + E_EDGE * Math.pow(c, 2 / n);
    return rr * P.R * outlineF(P, a) + Lp.x * Math.cos(alpha) + Lp.z * Math.sin(alpha);
  }

  /* ---------------- Syrup choreography data (seeded) ---------------------------------------- */
  const SYR = (() => {
    const rnd = mulberry32(0x5A1C);
    // stage angles (alpha = 90deg faces the camera); lengths as a fraction of the stack height
    const defs = [
      { a: 22, L: 0.34, st: 0.906 }, { a: 58, L: 0.86, st: 0.898 }, { a: 86, L: 0.5, st: 0.914 },
      { a: 110, L: 0.98, st: 0.902 }, { a: 138, L: 0.26, st: 0.922 }, { a: 166, L: 0.64, st: 0.91 },
      { a: -18, L: 0.42, st: 0.916 },
    ];
    const yTop = TOP.y + topP.T * 0.24;
    const yMin = PLATE_TOP + 0.05;
    const stackH = yTop - yMin;
    const dy = 0.005;
    const drips = defs.map((d) => {
      const alpha = (d.a + (rnd() - 0.5) * 8) * DEG;
      const nS = Math.ceil((yTop - yMin) / dy) + 1;
      const raw = new Float32Array(nS);
      for (let k = 0; k < nS; k++) {
        const y = yTop - k * dy;
        let r = -1;
        for (const Lp of landed) r = Math.max(r, edgeR(Lp, y, alpha));
        raw[k] = r;
      }
      // bridge the grooves between pancakes (surface tension), keep the bulges
      const filt = new Float32Array(nS), win = 16;
      for (let k = 0; k < nS; k++) {
        let m = -1;
        for (let q = Math.max(0, k - win); q <= Math.min(nS - 1, k + win); q++) m = Math.max(m, raw[q]);
        filt[k] = raw[k] < 0 ? m : lerp(raw[k], m, 0.86);
      }
      return {
        alpha, dx: Math.cos(alpha), dz: Math.sin(alpha), tab: filt, nS,
        len: Math.min(d.L * stackH, stackH - 0.06), st: d.st, dur: 0.045 + rnd() * 0.03,
        w0: 0.066 + rnd() * 0.026, h0: 0.024 + rnd() * 0.008, aLocal: alpha + TOP.yaw,
      };
    });
    const lobes = new Float32Array(48).map(() => rnd());
    return { drips, yTop, dy, lobes, rnd };
  })();
  const POOL_IN = 0.858, POOL_FULL = 0.93;
  const invTop = TOP.M.clone().invert();
  const toLocal = (x, z) => { const v = new THREE.Vector3(x, TOP.y, z).applyMatrix4(invTop); return { x: v.x, z: v.z }; };
  const sl = toLocal(0.2, -0.16);
  const STREAM_LOCAL = new THREE.Vector3(sl.x, 0, sl.z);
  const bl = toLocal(-0.1, 0.17);
  const BUTTER_LOCAL = { x: bl.x, z: bl.z, yaw: 0.35 };

  function poolRho(theta, p) {
    const g = easeOut3((p - POOL_IN) / (POOL_FULL - POOL_IN));
    const L = SYR.lobes;
    let n = 0;
    for (let k = 0; k < 4; k++) n += (L[k * 2] - 0.5) * 0.09 * Math.sin((k + 2) * theta + L[k * 2 + 1] * TAU);
    const base = SIG_EDGE * (0.84 + n) * g;
    let rho = base;
    for (const d of SYR.drips) {
      const lg = easeOut3((p - (d.st - 0.014)) / 0.022);
      if (lg <= 0) continue;
      let dth = Math.atan2(Math.sin(theta - d.aLocal), Math.cos(theta - d.aLocal));
      const bump = Math.exp(-((dth / 0.16) ** 2)) * (1 - 0.25 * lg * Math.exp(-((dth / 0.06) ** 2)) * 0);
      rho = Math.max(rho, lerp(base, SIG_EQ + 0.02, lg * bump));
    }
    return rho;
  }

  const _dp = [];
  function buildSyrup(p, t) {
    syrupD.reset();
    if (p > POOL_IN) addPool(syrupD, 0, 0, (th) => poolRho(th, p), 0.034, 96, 16, 0.55);
    // drips down the sides
    for (const d of SYR.drips) {
      const k = easeOut3((p - d.st) / d.dur);
      const len = d.len * k;
      if (len < 0.015) continue;
      _dp.length = 0;
      const K = 46;
      const tipW = d.w0 * 0.55, tipH = d.h0 * 0.9;
      const bw = Math.min(tipW * 1.5, d.w0 * 1.0), bh = Math.min(tipH * 1.9, 0.06);
      const bR = Math.max(bw, bh) * 0.95;
      for (let q = 0; q <= K; q++) {
        const s = len * (1 - Math.pow(1 - q / K, 1.6));
        const y = SYR.yTop - s;
        const fi = clamp((SYR.yTop - y) / SYR.dy, 0, d.nS - 1);
        const i0 = Math.floor(fi), i1 = Math.min(d.nS - 1, i0 + 1);
        const rS = lerp(d.tab[i0], d.tab[i1], fi - i0);
        const along = s / Math.max(len, 1e-3);
        let w = lerp(d.w0, tipW, Math.pow(along, 0.7)), h = lerp(d.h0, tipH, along);
        // teardrop bulb at the tip
        const sb = s - (len - bR);
        if (sb > -bR) {
          const e = Math.sqrt(Math.max(0, 1 - (sb / bR) ** 2));
          if (sb > 0) { w = bw * e; h = bh * e; } else { w = Math.max(w, bw * e); h = Math.max(h, bh * e); }
        }
        if (q === 0) { w *= 0.92; }
        const rc = rS + h * 0.35;
        _dp.push({ x: d.dx * rc, y, z: d.dz * rc, w: Math.max(w, 0.002), h: Math.max(h, 0.002), dx: d.dx, dz: d.dz, thin: 0.35 + 0.4 * along });
      }
      addTube(syrupD, _dp, 12);
    }
    // the pour: a thin glossy stream from above the frame
    const head = sstep5(SYRUP_IN, POOL_IN + 0.004, p);           // head reaches the pool
    const tail = sstep5(0.93, 0.968, p);                          // tail leaves the frame -> pool
    if (head > 0 && tail < 1) {
      _lp.copy(STREAM_LOCAL);
      const sTop = sigmaAt(Math.hypot(STREAM_LOCAL.x, STREAM_LOCAL.z));
      _lp.y = sTop.y + 0.03;
      _lp.applyMatrix4(TOP.M);
      const y0 = _lp.y, sx = _lp.x, sz = _lp.z;
      const H = 9;
      const yLo = lerp(y0 + H, y0, head);                          // falling head
      const top = Math.max(yLo + 0.02, lerp(y0 + H, y0, tail));    // falling tail
      _dp.length = 0;
      const K = 56;
      for (let q = 0; q <= K; q++) {
        const u = q / K;
        const y = lerp(top, yLo, Math.pow(u, 0.75));
        const fromPool = y - y0;
        let r = 0.03 * (1 + 0.1 * Math.sin(y * 13 - t * 7.5)) * (1 - 0.35 * sstep(1.5, 6, fromPool));
        r *= 1 + 1.4 * Math.exp(-fromPool * 22) * (1 - head * 0) * sstep(0, 1, head);
        if (tail > 0) r *= 1 - 0.55 * tail * (1 - u);
        const wob = 0.012 * Math.sin(y * 2.3 - t * 1.6) * sstep(0.2, 2, fromPool);
        _dp.push({ x: sx + wob, y, z: sz + wob * 0.6, w: r, h: r, dx: 1, dz: 0, thin: 0.8 });
      }
      if (head < 1) {   // rounded head while falling
        const last = _dp[_dp.length - 1];
        last.w = last.h = 0.001;
      }
      addTube(syrupD, _dp, 10);
    }
    syrupD.finish();
  }

  /* ---------------- Butter pat + melt puddle -------------------------------------------- */
  const butterGeo = track(new RoundedBoxGeometry(0.5, 0.17, 0.4, 4, 0.05));
  const butterMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xF7DC8E, roughness: 0.4, clearcoat: 0.35, clearcoatRoughness: 0.25,
    sheen: 0.5, sheenColor: new THREE.Color(0xFFF1C0), sheenRoughness: 0.5,
  }));
  const butterUni = { uMelt: { value: 0 } };
  butterMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, butterUni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uMelt;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float hbH = clamp((position.y + 0.085) / 0.17, 0.0, 1.0);
        float hbR = length(position.xz / vec2(0.25, 0.2));
        transformed.y = (position.y + 0.085) * (1.0 - 0.4 * uMelt) - 0.085;
        transformed.y -= uMelt * 0.045 * hbH * smoothstep(0.55, 1.0, hbR);
        transformed.xz *= 1.0 + uMelt * (0.2 * (1.0 - hbH) + 0.04);`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float hbBF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
      totalEmissiveRadiance += vec3(0.42, 0.28, 0.06) * (0.04 + 0.35 * pow(hbBF, 2.0));`);
  };
  butterMat.customProgramCacheKey = () => 'hb-butter';
  const butter = new THREE.Mesh(butterGeo, butterMat);
  butter.castShadow = true; butter.receiveShadow = true;
  stage.add(butter);
  const butterRest = (() => {
    const r = Math.hypot(BUTTER_LOCAL.x, BUTTER_LOCAL.z);
    const v = new THREE.Vector3(BUTTER_LOCAL.x, pancakeTopY(topP, r) * thickF(topP, Math.atan2(BUTTER_LOCAL.z, BUTTER_LOCAL.x)) + 0.085 - 0.012, BUTTER_LOCAL.z);
    return v.applyMatrix4(TOP.M);
  })();

  function buildMelt(p) {
    meltD.reset();
    const g = sstep(0.79, 0.93, p);
    if (g > 0) {
      const L = SYR.lobes;
      addPool(meltD, BUTTER_LOCAL.x, BUTTER_LOCAL.z, (th) => (0.3 + 0.2 * g) * (1 + 0.12 * Math.sin(3 * th + L[9] * 6) + 0.08 * Math.sin(5 * th + L[10] * 6)) * g,
        0.011, 64, 8, 0.4);
    }
    meltD.finish();
  }

  function poseButter(p) {
    if (p < BUTTER_IN) { butter.visible = false; return; }
    butter.visible = true;
    const f = clamp((p - BUTTER_IN) / (BUTTER_LAND - BUTTER_IN));
    const q = (p - BUTTER_LAND) / BUTTER_SQ;
    const s = squashCurve(q);
    const fallH = 2.5 * (1 - Math.pow(f, 1.7));
    const tum = Math.pow(1 - f, 2);
    butter.position.set(butterRest.x, butterRest.y + fallH - 0.085 * 0.16 * s, butterRest.z);
    butter.rotation.set(0.9 * tum, TOP.yaw + BUTTER_LOCAL.yaw + 0.8 * tum, -0.5 * tum);
    butter.scale.set(1 + 0.08 * s, 1 - 0.16 * s, 1 + 0.08 * s);
    butterUni.uMelt.value = 0.62 * sstep(0.785, 1.0, p);
  }

  /* ---------------- Blueberries --------------------------------------------------------- */
  const berryGeo = (() => {
    let g = new THREE.SphereGeometry(1, 36, 26);
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const pa = g.attributes.position, v = new THREE.Vector3();
    for (let k = 0; k < pa.count; k++) {
      v.fromBufferAttribute(pa, k);
      const ny = v.y, ang = Math.atan2(v.z, v.x);
      let r = 1 - 0.2 * sstep(0.84, 0.985, ny);                                   // crown dimple
      r += 0.07 * Math.max(0, Math.cos(5 * ang)) * sstep(0.8, 0.88, ny) * (1 - sstep(0.9, 0.97, ny)); // star lip
      r *= 1 + 0.02 * Math.sin(3 * ang + ny * 4);
      v.multiplyScalar(r); v.y *= 0.86;
      pa.setXYZ(k, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return track(g);
  })();
  const berryMat = track(new THREE.MeshPhysicalMaterial({
    color: 0x2B3058, roughness: 0.48, clearcoat: 0.3, clearcoatRoughness: 0.45,
    sheen: 1, sheenColor: new THREE.Color(0x8E9BD0), sheenRoughness: 0.7,
  }));
  const BR = 0.088;
  const berryDefs = (() => {
    const rnd = mulberry32(0xBE77);
    const out = [];
    const tops = [[0.36, 0.3], [-0.46, -0.06], [0.16, 0.5], [-0.42, 0.44], [0.52, -0.22], [-0.12, -0.42]];
    tops.forEach(([sx0, sz0], k) => {
      const { x, z } = toLocal(sx0, sz0);
      const r = Math.hypot(x, z), a = Math.atan2(z, x);
      const u = r / (SIG_EDGE * 0.84);
      const hp = 0.034 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.min(1, u), 2.6)));
      const v = new THREE.Vector3(x, pancakeTopY(topP, r) * thickF(topP, a) + hp + BR * 0.78, z).applyMatrix4(TOP.M);
      out.push({ pos: v, st: 0.902 + k * 0.009 + rnd() * 0.004, rot: new THREE.Euler(rnd() * 3, rnd() * 6, rnd() * 3), s: 0.92 + rnd() * 0.16 });
    });
    const plates = [[62, 1.24], [76, 1.36], [118, 1.25], [34, 1.3]];
    plates.forEach(([deg, r], k) => {
      const a = deg * DEG;
      const v = new THREE.Vector3(Math.cos(a) * r, 0.006 + Math.max(0, (r - 1.18)) * 0.25 + BR * 0.84, Math.sin(a) * r);
      out.push({ pos: v, st: 0.93 + k * 0.01 + rnd() * 0.004, rot: new THREE.Euler(rnd() * 3, rnd() * 6, rnd() * 3), s: 0.9 + rnd() * 0.18 });
    });
    return out;
  })();
  const berries = track(new THREE.InstancedMesh(berryGeo, berryMat, berryDefs.length));
  berries.castShadow = true; berries.receiveShadow = true;
  berries.frustumCulled = false;
  {
    const rnd = mulberry32(0xC0105);
    const c = new THREE.Color();
    berryDefs.forEach((b, k) => berries.setColorAt(k, c.setHSL(0.64 + (rnd() - 0.5) * 0.04, 0.3 + rnd() * 0.15, 0.55 + rnd() * 0.2)));
  }
  stage.add(berries);
  const _bm = new THREE.Matrix4(), _bq = new THREE.Quaternion(), _bs = new THREE.Vector3(), _be = new THREE.Euler();
  function poseBerries(p) {
    let any = false;
    berryDefs.forEach((b, k) => {
      const f = clamp((p - b.st) / 0.03);
      const q = clamp((p - b.st - 0.03) / 0.03);
      let s = b.s * BR;
      if (p < b.st) s = 0; else any = true;
      const y = b.pos.y + 2.8 * (1 - f * f) + 0.05 * Math.sin(Math.PI * q) * (1 - q);
      const sp = Math.pow(1 - f, 2) * 3;
      _be.set(b.rot.x + sp, b.rot.y + sp * 0.6, b.rot.z);
      _bq.setFromEuler(_be);
      _bs.set(s, s * (1 - 0.12 * Math.sin(Math.PI * clamp(q * 3)) * (1 - q)), s);
      _bm.compose(_lp.set(b.pos.x, y, b.pos.z), _bq, _bs);
      berries.setMatrixAt(k, _bm);
    });
    berries.visible = any;
    berries.instanceMatrix.needsUpdate = true;
  }

  /* ---------------- Particles: sugar dust, crumbs and soft bokeh (one draw call) ----------- */
  const PCOUNT = 170;
  const partGeo = track(new THREE.InstancedBufferGeometry());
  {
    const base = new THREE.PlaneGeometry(2, 2);
    partGeo.index = base.index;
    partGeo.setAttribute('position', base.attributes.position);
    partGeo.setAttribute('uv', base.attributes.uv);
    const rnd = mulberry32(0xD057);
    const a1 = new Float32Array(PCOUNT * 4), a2 = new Float32Array(PCOUNT * 4);
    for (let k = 0; k < PCOUNT; k++) {
      const u = rnd();
      const type = u < 0.62 ? 0 : u < 0.84 ? 1 : 2;      // sugar, crumb, bokeh
      const near = rnd() < 0.45 && type < 2;             // cluster some motes around the subject
      a1[k * 4] = near ? 0.36 + rnd() * 0.28 : rnd();
      a1[k * 4 + 1] = rnd();
      a1[k * 4 + 2] = near ? 0.32 + rnd() * 0.22 : rnd();
      a1[k * 4 + 3] = rnd();
      a2[k * 4] = type; a2[k * 4 + 1] = rnd(); a2[k * 4 + 2] = rnd(); a2[k * 4 + 3] = rnd();
    }
    partGeo.setAttribute('aR1', new THREE.InstancedBufferAttribute(a1, 4));
    partGeo.setAttribute('aR2', new THREE.InstancedBufferAttribute(a2, 4));
    partGeo.instanceCount = PCOUNT;
    base.dispose();
  }
  const partMat = track(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: {
      uTime: { value: 0 }, uBoxMin: { value: new THREE.Vector3() }, uBoxSize: { value: new THREE.Vector3(14, 9, 14) },
      uFocus: { value: 12 }, uPx: { value: 1000 }, uVp: { value: new THREE.Vector2(1, 1) }, uBokeh: { value: 30 },
      uDensity: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute vec4 aR1; attribute vec4 aR2;
      uniform float uTime; uniform vec3 uBoxMin; uniform vec3 uBoxSize; uniform float uFocus;
      uniform float uPx; uniform vec2 uVp; uniform float uBokeh; uniform float uDensity;
      varying vec2 vUv; varying float vA; varying float vSoft; varying vec3 vCol; varying float vType; varying float vAdd; varying float vSeed;
      void main() {
        float type = aR2.x;
        vec3 vel = vec3(0.025 * (aR2.y - 0.5), -0.045 - 0.05 * aR2.z, 0.02 * (aR2.w - 0.5));
        if (type > 1.5) vel *= 0.35;
        vec3 p = mod(aR1.xyz * uBoxSize + vel * uTime, uBoxSize);
        vec3 e = min(p, uBoxSize - p) / (uBoxSize * 0.1);
        float fade = clamp(min(min(e.x, e.y), e.z), 0.0, 1.0);
        p += uBoxMin;
        p.x += 0.1 * sin(uTime * (0.21 + 0.2 * aR2.y) + aR2.w * 6.283);
        p.z += 0.08 * cos(uTime * (0.17 + 0.2 * aR2.z) + aR2.y * 6.283);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float depth = max(0.2, -mv.z);
        float baseR = type < 0.5 ? 0.0075 + 0.008 * aR1.w : type < 1.5 ? 0.011 + 0.012 * aR1.w : 0.03 + 0.05 * aR1.w;
        float basePx = baseR * uPx / depth;
        float blurPx = uBokeh * abs(1.0 - uFocus / depth) * (type > 1.5 ? 1.6 : 1.0);
        float rPx = max(basePx, 0.7) + blurPx;
        rPx = min(rPx, uVp.y * 0.09);
        float energy = clamp(pow(max(basePx, 0.7) / rPx, 2.0), 0.0, 1.0);
        float tw = 0.75 + 0.25 * sin(uTime * (0.8 + aR2.w) + aR2.y * 20.0);
        if (type < 0.5) { vCol = vec3(1.0, 0.94, 0.84); vA = (0.35 + 0.65 * energy) * 0.9 * tw; vAdd = 1.0; }
        else if (type < 1.5) { vCol = vec3(0.72, 0.43, 0.2); vA = (0.25 + 0.75 * energy) * 0.85; vAdd = 0.0; }
        else { vCol = mix(vec3(1.0, 0.66, 0.42), vec3(1.0, 0.82, 0.6), aR2.w); vA = 0.10 + 0.12 * aR2.z; vAdd = 1.0; }
        vA *= fade * uDensity;
        vSoft = clamp(blurPx / rPx, 0.12, 1.0);
        vType = type; vSeed = aR2.y;
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * mv;
        gl_Position.xy += position.xy * rPx / uVp * 2.0 * gl_Position.w;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying float vA; varying float vSoft; varying vec3 vCol; varying float vType; varying float vAdd; varying float vSeed;
      void main() {
        float d = length(vUv);
        if (vType > 0.5 && vType < 1.5) {
          float ang = atan(vUv.y, vUv.x);
          d *= 1.0 + 0.22 * sin(ang * 3.0 + vSeed * 30.0) * (1.0 - vSoft);
        }
        float a = 1.0 - smoothstep(1.0 - 0.9 * vSoft - 0.08, 1.0, d);
        if (vType > 1.5) a *= 0.75 + 0.35 * smoothstep(0.55, 0.92, d);
        a *= vA;
        if (a < 0.002) discard;
        gl_FragColor = vec4(vCol * a, a * (1.0 - vAdd));
      }`,
  }));
  const particles = new THREE.Mesh(partGeo, partMat);
  particles.frustumCulled = false;
  particles.renderOrder = 10;
  scene.add(particles);

  let liqP = -1, liqT = -1;
  function poseToppings(p, t) {
    poseButter(p);
    poseBerries(p);
    const streamLive = p > SYRUP_IN && p < 0.97;
    if (p !== liqP || (streamLive && t !== liqT)) {
      buildSyrup(p, t);
      if (p !== liqP) buildMelt(p);
      liqP = p; liqT = t;
    }
  }

  /* ---------------- Camera framing (pure function of p and aspect) --------------------------- */
  const colTop = PS[N - 1].floatY0 + PS[N - 1].T / 2 + 0.45;
  const finalTop = PS.stackTop + 0.32;
  const _v = new THREE.Vector3();
  const framePts = [];
  for (let k = 0; k < 16; k++) framePts.push(new THREE.Vector3());
  const frame = { sx: 0.36, sy: 0, hy: 0.4 };

  function applyLensShift(sx, sy) {
    camera.updateProjectionMatrix();
    camera.projectionMatrix.elements[8] = -sx;
    camera.projectionMatrix.elements[9] = -sy;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  function poseCamera(p, aspect) {
    const desk = aspect >= 1.1;
    camera.fov = desk ? 24 : 30;
    camera.aspect = aspect;
    const k = sstep5(0.03, 0.9, p);
    // subject envelope: a vertical cylinder
    const y5 = PS[N - 1].floatY0 + (PS[N - 1].landY + G - PS[N - 1].floatY0) * clamp((p - DROP_START) / SLOT, 0, N) / (N - 1);
    const top = smax(y5 + PS[N - 1].T / 2 + 0.42, finalTop, 0.3);
    const bot = -0.09;
    const radB = 1.68, radT = lerp(1.3, 1.08, k);
    const elev = lerp(11, 19, k) * DEG;
    const azim = lerp(-12, 5, k) * DEG;
    let sx, sy, HY, HX;
    if (desk) { sx = 0.36; sy = -0.03; HY = lerp(0.92, 0.7, k); HX = 0.45; }
    else { sx = 0; sy = lerp(-0.36, -0.32, k); HY = lerp(0.57, 0.56, k); HX = 0.9; }
    for (let s = 0; s < 8; s++) {
      const a = (s / 8) * TAU;
      framePts[s].set(Math.cos(a) * radB, bot, Math.sin(a) * radB);
      framePts[s + 8].set(Math.cos(a) * radT, top, Math.sin(a) * radT);
    }
    const tanH = Math.tan(camera.fov * DEG / 2);
    let ty = (top + bot) / 2;
    let d = ((top - bot) / 2) / (HY * tanH);
    applyLensShift(sx, sy);
    for (let it = 0; it < 5; it++) {
      camera.position.set(Math.sin(azim) * Math.cos(elev) * d, ty + Math.sin(elev) * d, Math.cos(azim) * Math.cos(elev) * d);
      camera.lookAt(0, ty, 0);
      camera.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const pt of framePts) {
        _v.copy(pt).project(camera);
        x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x); y0 = Math.min(y0, _v.y); y1 = Math.max(y1, _v.y);
      }
      const hy = (y1 - y0) / 2, hx = (x1 - x0) / 2, cy = (y1 + y0) / 2;
      const sc = Math.max(hy / HY, hx / HX);
      ty += (cy - sy) * d * tanH * 0.9;
      d *= sc;
    }
    camera.position.set(Math.sin(azim) * Math.cos(elev) * d, ty + Math.sin(elev) * d, Math.cos(azim) * Math.cos(elev) * d);
    camera.lookAt(0, ty, 0);
    camera.updateMatrixWorld();
    frame.sx = sx; frame.sy = sy; frame.hy = HY; frame.desk = desk; frame.d = d; frame.ty = ty;
  }

  /* ---------------- Render ------------------------------------------------------------------ */
  let W = 0, H = 0;
  function renderAt(p, t = 0) {
    if (!W || !H) return;
    p = clamp(p);
    poseCamera(p, W / H);
    poseScene(p, t);
    poseToppings(p, t);
    const bufH = H * renderer.getPixelRatio(), bufW = W * renderer.getPixelRatio();
    const pu = partMat.uniforms;
    pu.uTime.value = t;
    pu.uBoxMin.value.set(-8, frame.ty - 4.6, -7);
    pu.uBoxSize.value.set(16, 9.6, 16);
    pu.uFocus.value = frame.d;
    pu.uPx.value = bufH / (2 * Math.tan(camera.fov * DEG / 2));
    pu.uVp.value.set(bufW, bufH);
    pu.uBokeh.value = 0.032 * bufH;
    bgMat.uniforms.uAspect.value = W / H;
    bgMat.uniforms.uCenter.value.set(frame.sx, frame.sy + 0.05);
    bgMat.uniforms.uSize.value.set(frame.desk ? 0.95 : 0.9, frame.desk ? 1.05 : 0.7);
    renderer.render(scene, camera);
  }

  /* ---------------- Mount, size, loop ------------------------------------------------------- */
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  host.appendChild(canvas);

  const fixedP = frozen ? clamp(frozen.p) : reducedMotion ? 1 : null;
  const fixedT = frozen ? (frozen.t ?? 2) : 0;
  let readyFlagged = false;
  const flagReady = () => {
    if (readyFlagged) return;
    readyFlagged = true;
    requestAnimationFrame(() => { window.__heroReady = true; });
    setTimeout(() => { window.__heroReady = true; }, 120);
  };

  function resize() {
    const w = Math.round(host.clientWidth), h = Math.round(host.clientHeight);
    if (!w || !h) return false;
    if (w === W && h === H) return true;
    W = w; H = h;
    const dpr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    return true;
  }

  let raf = 0, running = false, onScreen = true, destroyed = false;
  const t0 = performance.now();
  let pSmooth = null, lastNow = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    const target = clamp(getProgress());
    pSmooth = pSmooth === null ? target : pSmooth + (target - pSmooth) * (1 - Math.exp(-dt * 10));
    if (Math.abs(target - pSmooth) < 1e-4) pSmooth = target;
    renderAt(pSmooth, (now - t0) / 1000);
    flagReady();
  }
  function start() {
    if (running || destroyed || fixedP !== null) return;
    if (!onScreen || document.hidden) return;
    running = true; lastNow = 0;
    raf = requestAnimationFrame(tick);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  const ro = new ResizeObserver(() => {
    if (!resize()) return;
    if (fixedP !== null) { renderAt(fixedP, fixedT); flagReady(); }
  });
  ro.observe(host);
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    onScreen ? start() : stop();
  });
  io.observe(host);
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVis);

  if (resize()) {
    if (fixedP !== null) { renderAt(fixedP, fixedT); flagReady(); }
    else { renderAt(clamp(getProgress()), 0); flagReady(); start(); }
  } else if (fixedP === null) start();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    ro.disconnect(); io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    for (const o of disposables) o.dispose?.();
    key.shadow.dispose();
    envRT.dispose(); pmrem.dispose();
    renderer.dispose();
    canvas.remove();
  }

  return { renderAt: (p, t = 0) => { resize(); renderAt(p, t); }, destroy };
}

/* ============================================================================================
 * Small texture helpers
 * ========================================================================================== */
// Radial alpha falloff texture (stops: [radius 0..1, alpha]); white RGB, alpha in A.
function radialTexture(S, stops) {
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = Math.hypot((x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1);
      let a = 0;
      for (let k = 1; k < stops.length; k++) {
        if (r <= stops[k][0]) { const f = sstep(stops[k - 1][0], stops[k][0], r); a = lerp(stops[k - 1][1], stops[k][1], f); break; }
      }
      const o = (y * S + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255; data[o + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// A dark espresso "studio" with a few warm softboxes. Used as the environment map, so glossy
// surfaces (syrup, butter, plate rim) pick up crisp streaks instead of a flat grey room.
function makeStudioEnv() {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(30, 20, 30), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.03, 0.017, 0.01), side: THREE.BackSide }));
  room.position.y = 4;
  env.add(room);
  const panel = (w, h, col, k, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 1, 0);
    env.add(m);
  };
  panel(9, 3.2, 0xFFB27A, 5.5, [1.5, 6.5, -8]);     // big warm backlight / top-back softbox
  panel(11, 1.6, 0xFFC290, 2.6, [-0.5, 2.4, -9.5]); // low back strip: long highlights on syrup + plate
  panel(2.2, 7, 0xFFDDBB, 3.2, [-9, 3, 3.5]);      // key strip, camera left
  panel(1.6, 5, 0xFF9A55, 2.4, [8.5, 2, -3.5]);    // amber kicker, back right
  panel(5, 1.4, 0xFFE8D2, 0.9, [0.5, 7.5, 7]);     // small soft top-front fill
  return env;
}
