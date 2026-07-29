/**
 * course.js — the active hole, described once.
 *
 * Every visual (the baked fairway texture, the sculpted terrain) and every
 * gameplay rule (where the ball rolls fast, where it plugs, where it splashes)
 * reads from the functions in this file. One source of truth means the ball
 * always behaves exactly the way the ground *looks* like it should.
 *
 * The layout itself lives in holes.js. `setHole()` resolves a hole definition
 * into the sampled centreline and world-space features everything else queries,
 * so switching holes is a matter of calling it and rebuilding the world.
 *
 * Units: 1 world unit ≈ 1 yard.
 */

import { CatmullRomCurve3, Vector3 } from 'three';
import { clamp, lerp, smoothstep, fbm2, mulberry32 } from './util.js';
import { HOLES } from './holes.js';

// ---------------------------------------------------------------- world box
// The terrain plane and the baked course texture both cover this square. It is
// re-centred per hole so long holes get the room they need.
export let WORLD_SIZE = 900;
export let WORLD_CX = 0;
export let WORLD_CZ = -300;

/**
 * Yards between mowing passes. The baked fairway bands and the per-pixel
 * grooves in terrain.js both use this against the same signed distance, so the
 * two patterns stay exactly in phase. Bigger = wider, fewer stripes.
 */
export const MOW_PERIOD = 4.0;

// ---------------------------------------------------------------- live state
export let HOLE = null;          // the active definition from holes.js
export let TEE = { x: 0, z: 6 };
export let GREEN = { x: 0, z: 0, r: 15, rx: 15, rz: 15, rot: 0 };
export let HOLE_POS = { x: 0, z: 0 };
export let PAR = 4;
export let HOLE_LENGTH = 0;
export let WATER_Y = -999;
export let BUNKERS = [];
export let POND = null;
export let MOUNDS = [];
export let CART_PATH = { offset: 40, halfWidth: 3.4, zFrom: -20, zTo: -400 };

// Sampled centreline.
const N = 700;
const pX = new Float32Array(N);
const pZ = new Float32Array(N);
const pTX = new Float32Array(N);
const pTZ = new Float32Array(N);
const pS = new Float32Array(N);

let widthProfile = [22, 20, 18, 17];
let elevProfile = [0, 0, 0, 0];
let GREEN_BASE = 0;

// ---------------------------------------------------------------- setup
/** Resolve a path-relative feature (`at` yards along, `off` yards right). */
function resolve(at, off) {
  let i = 0;
  while (i < N - 1 && pS[i] < at) i++;
  // Right-hand perpendicular: for a tangent heading -Z this is +X.
  return { x: pX[i] - pTZ[i] * off, z: pZ[i] + pTX[i] * off };
}

/** Load a hole and rebuild every derived value. */
export function setHole(def) {
  HOLE = def;
  PAR = def.par;
  widthProfile = def.width;
  elevProfile = def.elev ?? [0, 0, 0, 0];

  const pts = def.path.map(([x, z]) => new Vector3(x, 0, z));
  const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  const tmp = new Vector3();
  for (let i = 0; i < N; i++) {
    curve.getPoint(i / (N - 1), tmp);
    pX[i] = tmp.x; pZ[i] = tmp.z;
  }
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
    let tx = pX[b] - pX[a], tz = pZ[b] - pZ[a];
    const len = Math.hypot(tx, tz) || 1;
    pTX[i] = tx / len; pTZ[i] = tz / len;
    if (i > 0) acc += Math.hypot(pX[i] - pX[i - 1], pZ[i] - pZ[i - 1]);
    pS[i] = acc;
  }

  TEE = { x: pX[0], z: pZ[0] };

  const g = resolve(def.green.at, def.green.off ?? 0);
  const gr = def.green.r;
  const squash = def.green.squash ?? 1;
  GREEN = {
    x: g.x, z: g.z, r: gr,
    rx: gr, rz: gr * squash, rot: def.green.angle ?? 0,
    // Gentle: a green is shaped, but it is still a putting surface.
    h: outline(def.n * 7717 + 11, 0.13, 0.08, 0.045),
  };
  HOLE_POS = { x: g.x + 1.5, z: g.z - 2 };

  BUNKERS = (def.bunkers ?? []).map((b, i) => {
    const p = resolve(b.at, b.off);
    // Strong: bunkers are the most irregular thing on a golf course.
    return {
      x: p.x, z: p.z, rx: b.rx, rz: b.rz, rot: b.rot ?? 0,
      h: outline(def.n * 9931 + i * 197 + 3, 0.22, 0.15, 0.09),
    };
  });

  POND = null;
  if (def.water) {
    const p = resolve(def.water.at, def.water.off);
    POND = {
      x: p.x, z: p.z, rx: def.water.rx, rz: def.water.rz, rot: def.water.rot ?? 0,
      // Enough to give the bank a bay or two rather than a drawn oval.
      h: outline(def.n * 6151 + 29, 0.19, 0.12, 0.07),
    };
  }

  MOUNDS = (def.mounds ?? []).map((m) => {
    const p = resolve(m.at, m.off);
    return { x: p.x, z: p.z, r: m.r, h: m.h };
  });

  // Frame the world around the hole so nothing runs off the edge.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, pX[i]); maxX = Math.max(maxX, pX[i]);
    minZ = Math.min(minZ, pZ[i]); maxZ = Math.max(maxZ, pZ[i]);
  }
  WORLD_CX = (minX + maxX) / 2;
  WORLD_CZ = (minZ + maxZ) / 2;
  WORLD_SIZE = Math.max(760, (maxZ - minZ) * 1.55, (maxX - minX) * 2.6);

  HOLE_LENGTH = nearest(HOLE_POS.x, HOLE_POS.z, {}).s;
  GREEN_BASE = swell(GREEN.x, GREEN.z);
  WATER_Y = POND ? swell(POND.x, POND.z) - 1.15 : -999;

  CART_PATH = {
    offset: 40,
    halfWidth: 3.4,
    zFrom: pZ[0] - 24,
    zTo: pZ[N - 1] + 30,
  };
}

/** 0…1 coverage of the cart path at a point. `n` is a `nearest()` result. */
export function cartPathAt(x, z, n) {
  if (z > CART_PATH.zFrom || z < CART_PATH.zTo || n.side < 0) return 0;
  const d = Math.abs(n.dist - CART_PATH.offset);
  const fade = smoothstep(CART_PATH.zFrom - 6, CART_PATH.zFrom - 16, z) *
               smoothstep(CART_PATH.zTo + 6, CART_PATH.zTo + 16, z);
  return (1 - smoothstep(CART_PATH.halfWidth - 0.45, CART_PATH.halfWidth + 0.45, d)) * fade;
}

// ---------------------------------------------------------------- queries
const _n = { dist: 0, side: 0, perp: 0, t: 0, s: 0, i: 0 };

/** Index of the last centreline sample at or before `z` (pZ decreases). */
function indexForZ(z) {
  if (z >= pZ[0]) return 0;
  if (z <= pZ[N - 1]) return N - 2;
  let lo = 0, hi = N - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pZ[mid] > z) lo = mid; else hi = mid;
  }
  return lo;
}

/** X of the fairway centreline at a given Z. */
export function centreXAt(z) {
  if (z >= pZ[0]) return pX[0];
  if (z <= pZ[N - 1]) return pX[N - 1];
  const i = indexForZ(z);
  const t = (z - pZ[i]) / (pZ[i + 1] - pZ[i]);
  return lerp(pX[i], pX[i + 1], t);
}

/** A point `dist` yards further down the hole — used to aim. */
export function aimPointAhead(x, z, dist) {
  const n = nearest(x, z);
  const target = n.s + dist;
  let i = n.i;
  while (i < N - 1 && pS[i] < target) i++;
  return { x: pX[i], z: pZ[i] };
}

/**
 * Nearest point on the centreline. Seeded by a binary search on Z, then
 * scanned outward.
 *
 * The window has to be generous. Where the hole runs diagonally the
 * perpendicular closest point sits well up or down the path from the sample
 * with the matching Z — roughly `dist × tan(turn)` yards away, which on a 40°
 * dogleg is most of a hundred yards out in the trees. Too narrow a window and
 * the fairway silently bulges at every corner.
 */
export function nearest(x, z, out = _n) {
  const i0 = indexForZ(z);
  const lo = Math.max(0, i0 - 90), hi = Math.min(N - 1, i0 + 90);

  let best = i0, bestD2 = Infinity;
  for (let i = lo; i <= hi; i++) {
    const dx = x - pX[i], dz = z - pZ[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  const dx = x - pX[best], dz = z - pZ[best];
  out.dist = Math.sqrt(bestD2);
  // The 2D cross product with the unit tangent *is* the signed perpendicular
  // distance, and unlike `dist` it passes cleanly through zero at the
  // centreline — which is what the mowing grooves key off.
  out.perp = pTZ[best] * dx - pTX[best] * dz;
  out.side = out.perp < 0 ? 1 : -1; // +1 = right of play
  out.t = best / (N - 1);
  out.s = pS[best];
  out.i = best;
  return out;
}

/**
 * Height of the hole's own landform at `t`, in yards relative to the tee.
 *
 * This is the biggest single thing separating a real course from a flat field.
 * A hole that climbs plays long and hides its green; one that plunges opens
 * the whole thing out in front of you. It is applied before anything else, so
 * greens, bunkers, mounding and water all sit on top of it.
 */
export function elevationAt(t) {
  const e = elevProfile;
  const f = clamp(t, 0, 1) * (e.length - 1);
  const i = Math.floor(f);
  const j = Math.min(e.length - 1, i + 1);
  return lerp(e[i], e[j], f - i);
}

/**
 * Fairway half-width in yards. The profile sets the broad shape; the two sine
 * terms give the mown line an organic wander so it isn't a ruler-straight
 * ribbon down the hole. Periods work out around 270 and 120 yards.
 */
export function fairwayHalfWidth(t) {
  const w = widthProfile;
  const f = clamp(t, 0, 1) * (w.length - 1);
  const i = Math.floor(f);
  const j = Math.min(w.length - 1, i + 1);
  const base = lerp(w[i], w[j], f - i);
  return base + 2.6 * Math.sin(t * 14.0 + 1.3) + 1.7 * Math.sin(t * 31.0 - 0.7);
}

/**
 * Normalised distance inside a feature outline — 1.0 is exactly on the edge.
 *
 * Not an ellipse. The radius is modulated by three angular harmonics, which
 * makes an irregular, lobed outline that is still a closed curve *by
 * construction* — it cannot self-intersect, pinch off or leave a gap the way a
 * hand-drawn polygon or a noise-displaced boundary can. Greens get gentle
 * lobes, bunkers get the deep scalloping real ones have, water gets a bay or
 * two. Every consumer of this — surface classification, the terrain sculpt,
 * the baked texture, the shader's per-pixel edges — follows the new outline
 * without knowing anything changed.
 *
 * The early-outs matter: this runs for every bunker at every one of a million
 * texture pixels, and three sines plus an atan2 is not free. Far outside or
 * deep inside a shape the wobble cannot change any decision made from the
 * result, so the plain radius is returned instead.
 */
function shapeField(x, z, e) {
  const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
  const dx = x - e.x, dz = z - e.z;
  const u = (dx * c + dz * s) / e.rx;
  const v = (-dx * s + dz * c) / e.rz;
  const r = Math.sqrt(u * u + v * v);
  const h = e.h;
  if (!h || r > 1.9 || r < 0.25) return r;

  const a = Math.atan2(v, u);
  const k = 1 + h[0] * Math.sin(a * 2 + h[1])
              + h[2] * Math.sin(a * 3 + h[3])
              + h[4] * Math.sin(a * 5 + h[5]);
  return r / k;
}

/** Deterministic harmonic weights and phases for one feature outline. */
function outline(seed, a1, a2, a3) {
  const r = mulberry32(seed);
  return [
    lerp(0.55, 1, r()) * a1, r() * Math.PI * 2,
    lerp(0.55, 1, r()) * a2, r() * Math.PI * 2,
    lerp(0.55, 1, r()) * a3, r() * Math.PI * 2,
  ];
}

export function bunkerField(x, z) {
  let m = Infinity;
  for (let i = 0; i < BUNKERS.length; i++) m = Math.min(m, shapeField(x, z, BUNKERS[i]));
  return m;
}
export function pondField(x, z) { return POND ? shapeField(x, z, POND) : Infinity; }
export function greenField(x, z) { return shapeField(x, z, GREEN); }

/**
 * Signed yards inside the nearest bunker — positive on the sand. The fairway
 * and green get their edges sharpened per-pixel; without this the sand does
 * not, and a bunker smears into a pale stain the moment you stand near one.
 */
export function bunkerEdge(x, z) {
  let best = -999;
  for (let i = 0; i < BUNKERS.length; i++) {
    const b = BUNKERS[i];
    const e = (1 - shapeField(x, z, b)) * ((b.rx + b.rz) * 0.5);
    if (e > best) best = e;
  }
  return best;
}

/** Signed yards inside the green — positive on the putting surface. */
export function greenEdge(x, z) {
  return (1 - greenField(x, z)) * ((GREEN.rx + GREEN.rz) * 0.5);
}

export function distToHole(x, z) { return Math.hypot(x - HOLE_POS.x, z - HOLE_POS.z); }

/**
 * Surface classification — drives friction, bounce and the shot you get.
 * Priority: water > bunker > green > fairway > rough.
 */
export function surfaceAt(x, z) {
  if (pondField(x, z) < 1) return 'water';
  if (bunkerField(x, z) < 1) return 'sand';
  if (greenField(x, z) < 1) return 'green';
  const n = nearest(x, z);
  if (n.dist < fairwayHalfWidth(n.t)) return 'fairway';
  if (n.dist > 62) return 'deep';
  return 'rough';
}

/** True once the ball has wandered outside the playable world. */
export function isOutOfBounds(x, z) {
  const n = nearest(x, z);
  return n.dist > 130 || z > pZ[0] + 45 || z < pZ[N - 1] - 45;
}

// ---------------------------------------------------------------- height
function rolling(x, z) {
  return (
    3.1 * fbm2(x * 0.0062, z * 0.0051) +
    1.5 * fbm2(x * 0.0169 + 4.1, z * 0.0141 - 2.2) +
    5.2 * Math.sin((x + z * 0.6) * 0.0043 + 1.9)
  );
}
// Its own scratch result. `nearest()` hands back a shared object, and
// heightAt() is holding that object across its whole body — if swell() called
// nearest() bare it would clobber the caller's `n` halfway down, silently
// corrupting every distance read after it.
const _swellN = { dist: 0, side: 0, perp: 0, t: 0, s: 0, i: 0 };

function swell(x, z, t) {
  // Includes the landform, because this is what the green pad and the
  // waterline are levelled against — without it a green on an uphill hole
  // would be cut into a pit.
  const tt = t !== undefined ? t : nearest(x, z, _swellN).t;
  return 2.4 * fbm2(x * 0.0058 + 0.3, z * 0.0047 - 0.8) +
         2.0 * Math.sin((x * 0.4 + z) * 0.0039 + 0.7) +
         elevationAt(tt);
}

/**
 * Ground height at any point. Sculpted in layers:
 *   rolling country → flattened toward the mown corridor → green pad →
 *   mounding → bunker bowls → pond basin → grass-height lips → world rim.
 */
export function heightAt(x, z) {
  const n = nearest(x, z);
  const hw = fairwayHalfWidth(n.t);

  // The hole's landform first: everything else is built on top of it.
  let h = rolling(x, z) + elevationAt(n.t);

  // Ease the terrain toward the calmer `swell` inside and around the corridor.
  const mown = 1 - smoothstep(hw * 0.9, hw * 3.0, n.dist);
  h = lerp(h, swell(x, z, n.t), mown * 0.88);

  // Putting surface: a near-flat pad on a defined shoulder. The blend is
  // deliberately tight — a green is built up as a pad, and that shoulder is a
  // big part of why a green reads as a green rather than as mown fairway.
  const ge = greenEdge(x, z);
  const gb = smoothstep(-3.0, 1.0, ge);
  if (gb > 0) {
    // A gentle crown for putt break, plus a whisper of tier.
    const crown = 0.55 * clamp(ge / GREEN.r, 0, 1) +
                  0.16 * Math.sin(x * 0.06 + 1.1) * Math.cos(z * 0.055);
    h = lerp(h, GREEN_BASE + crown, gb);
  }

  // Free-standing mounding, suppressed over the putting surface.
  for (let i = 0; i < MOUNDS.length; i++) {
    const m = MOUNDS[i];
    const d = Math.hypot(x - m.x, z - m.z);
    if (d < m.r) {
      const k = Math.cos((d / m.r) * Math.PI * 0.5);
      h += m.h * k * k * (1 - gb);
    }
  }

  // Bunkers are dug, not dished. A flat sand floor out to about half the
  // radius, then a steep face up to the lip — a smooth saucer reads as a pale
  // patch painted on the grass rather than as a hazard you have to climb out
  // of. The wall lands across two or three quads, which the mesh can hold.
  for (let i = 0; i < BUNKERS.length; i++) {
    const f = shapeField(x, z, BUNKERS[i]);
    if (f < 1.55) {
      const bowl = 1 - smoothstep(0.55, 1.0, f);
      const lip = smoothstep(0.94, 1.14, f) * (1 - smoothstep(1.14, 1.55, f));
      h -= 2.3 * bowl;
      h += 0.70 * lip;
    }
  }

  // Pond basin, always safely below the waterline.
  if (POND) {
    const pf = pondField(x, z);
    if (pf < 1.5) {
      const bed = 1 - smoothstep(0, 1.05, pf);
      h = lerp(h, WATER_Y - 3.2, bed);
      h -= 0.5 * smoothstep(1.3, 1.0, pf) * (1 - bed);
    }
  }

  // Rough is genuinely lumpy — real relief so it catches the toon ramp's bands
  // and shades itself. One long octave only: fbm2's top harmonic is 6x its
  // base, so anything shorter facets on the terrain grid.
  const mownTight = Math.max(
    1 - smoothstep(hw - 0.8, hw + 1.2, n.dist),
    smoothstep(-1.2, 0.8, ge)
  );
  const path = cartPathAt(x, z, n);
  const unmown = (1 - mownTight) * (1 - path);
  // Rolling relief in the rough only. Mown ground stays smooth: a cel ramp
  // turns every gentle undulation into a wandering band edge, and on a fairway
  // that reads as a shading fault rather than as ground.
  if (unmown > 0.001) {
    h += unmown * 1.5 * fbm2(x * 0.040 + 11.3, z * 0.038 - 7.1);
  }

  // Grass height is real height. Rough is left long and the fairway and green
  // are cut short, so every mowing line has an actual lip at it — that step
  // catches the light and is what makes the boundaries read as boundaries
  // instead of as a change of paint.
  h += 0.34 * unmown;

  // The cart path is graded: sits just below the turf either side of it.
  h -= 0.22 * path;

  // A distant rim so the world never shows a cut edge against the sky.
  const rim = Math.max(0, n.dist - 150) * 0.11;
  h += Math.min(rim, 26) + smoothstep(150, 320, n.dist) * 12;

  return h;
}

/**
 * The height the *ball* collides with: the ground, or the waterline where the
 * pond covers it. Without this the ball sinks to the pond bed before the
 * splash triggers, and you see it pass through the water.
 */
export function surfaceHeightAt(x, z) {
  const h = heightAt(x, z);
  return POND && pondField(x, z) < 1 ? Math.max(h, WATER_Y) : h;
}

/** Central-difference surface gradient — used for putt break and roll. */
export function gradientAt(x, z, out = { gx: 0, gz: 0 }) {
  const e = 1.2;
  out.gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  out.gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return out;
}

// ---------------------------------------------------------------- palette
// High-key and low-saturation: the value range is narrow and light, and colour
// does the work instead of contrast.
export const SURFACE_COLORS = {
  rough:    [0x7e, 0xba, 0x64],
  roughAlt: [0x6c, 0xa9, 0x52],
  roughMean:[0x79, 0xb4, 0x5d], // what the shader blends to at a cut line
  roughDry: [0x9c, 0xc0, 0x66],
  roughWet: [0x54, 0x92, 0x46],
  deep:     [0x5e, 0x98, 0x4a],
  fairA:    [0x9a, 0xd6, 0x7b],
  fairB:    [0xa8, 0xe0, 0x89],
  collar:   [0x9e, 0xdb, 0x7f],
  greenA:   [0xb3, 0xe9, 0x96],
  sand:     [0xf9, 0xee, 0xd2],
  sandDark: [0xe9, 0xd9, 0xb4],
  water:    [0x3f, 0x8d, 0xa6],
  waterEdge:[0x92, 0xd6, 0xdd],
  path:     [0xe4, 0xdd, 0xcf],
  pathAlt:  [0xd6, 0xce, 0xbe],
  pathWear: [0xc6, 0xbd, 0xac],
  pathEdge: [0xb4, 0xae, 0x9a],
};
const C = SURFACE_COLORS;

function mix(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/**
 * Bakes the hole into one top-down canvas: rough, mowing stripes, green,
 * bunkers, cart path, shoreline.
 *
 * Boundaries between surfaces are baked as hard as a texel allows and then
 * re-sharpened per-pixel in the terrain shader, which is the only way to get a
 * mowing line that still looks like a line when you're standing on it.
 */
export function makeCourseTexture(size = 1024) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const half = WORLD_SIZE / 2;
  const x0 = WORLD_CX - half;
  const z0 = WORLD_CZ - half;
  const step = WORLD_SIZE / size;

  const col = [0, 0, 0];
  const tmp = [0, 0, 0];
  const n = { dist: 0, side: 0, perp: 0, t: 0, s: 0, i: 0 };

  for (let py = 0; py < size; py++) {
    // Canvas row 0 maps to the far end of the hole (uv v = 1).
    const z = z0 + py * step;
    for (let px = 0; px < size; px++) {
      const x = x0 + px * step;
      nearest(x, z, n);

      // --- base: rough, in layered patches ---
      const mott = clamp(0.5 + 0.5 * (
        fbm2(x * 0.021, z * 0.019) * 0.46 +
        fbm2(x * 0.062 + 3.1, z * 0.058 - 1.4) * 0.33 +
        fbm2(x * 0.160 + 7.7, z * 0.150 + 2.2) * 0.21
      ), 0, 1);
      mix(C.rough, C.roughAlt, mott, col);

      const dry = 0.5 + 0.5 * fbm2(x * 0.034 - 5.2, z * 0.037 + 4.4);
      mix(col, C.roughDry, smoothstep(0.44, 0.90, dry) * 0.58, col);
      const wet = 0.5 + 0.5 * fbm2(x * 0.048 + 9.6, z * 0.044 - 6.8);
      mix(col, C.roughWet, smoothstep(0.48, 0.94, wet) * 0.52, col);

      const deepen = smoothstep(50, 95, n.dist);
      mix(col, C.deep, deepen * 0.75, col);

      // --- fairway, mown in passes running down the line of play ---
      const hw = fairwayHalfWidth(n.t);
      const fairMask = 1 - smoothstep(hw - 0.4, hw + 0.4, n.dist);
      if (fairMask > 0.001) {
        const band = Math.sin((n.perp / MOW_PERIOD) * Math.PI * 2);
        const stripe = smoothstep(-0.6, 0.6, band);
        mix(C.fairA, C.fairB, stripe, tmp);
        tmp[0] += (mott - 0.5) * 4; tmp[1] += (mott - 0.5) * 5; tmp[2] += (mott - 0.5) * 3;
        mix(col, tmp, fairMask, col);
      }

      // --- putting surface: a fringe ring, then a clean unstriped green ---
      const ge = greenEdge(x, z);
      const collar = (1 - smoothstep(-0.4, 0.4, ge)) * smoothstep(-3.4, -2.4, ge);
      if (collar > 0.001) mix(col, C.collar, collar * 0.95, col);
      const gMask = smoothstep(-0.4, 0.4, ge);
      if (gMask > 0.001) mix(col, C.greenA, gMask, col);

      // --- cart path: concrete, offset to the right of play ---
      const pathMask = cartPathAt(x, z, n);
      if (pathMask > 0.001) {
        const pd = Math.abs(n.dist - CART_PATH.offset);
        const agg = 0.5 + 0.5 * fbm2(x * 0.62 + 21.4, z * 0.59 - 13.7);
        mix(C.path, C.pathAlt, agg, tmp);
        const wear = Math.exp(-Math.pow((pd - 1.45) / 0.62, 2));
        mix(tmp, C.pathWear, wear * 0.45, tmp);
        const kerb = smoothstep(CART_PATH.halfWidth - 1.1, CART_PATH.halfWidth - 0.2, pd);
        mix(tmp, C.pathEdge, kerb * 0.75, tmp);
        mix(col, tmp, pathMask, col);
      }

      // --- bunkers: bright sand, damp at the rim ---
      const bf = bunkerField(x, z);
      if (bf < 1.15) {
        const m = 1 - smoothstep(0.97, 1.03, bf);
        mix(C.sandDark, C.sand, 1 - smoothstep(0.35, 0.95, bf), tmp);
        tmp[0] += (mott - 0.5) * 6; tmp[1] += (mott - 0.5) * 5; tmp[2] += (mott - 0.5) * 4;
        mix(col, tmp, m, col);
      }

      // --- pond: shoreline, then the dark bed under the water plane ---
      if (POND) {
        const pf = pondField(x, z);
        if (pf < 1.35) {
          const shore = (1 - smoothstep(1.02, 1.3, pf)) * smoothstep(0.9, 1.05, pf);
          mix(col, C.waterEdge, shore * 0.6, col);
          const bed = 1 - smoothstep(0.94, 1.02, pf);
          mix(col, C.water, bed, col);
        }
      }

      const o = (py * size + px) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return cv;
}

// Load the first hole so importers have valid state immediately.
setHole(HOLES[0]);
