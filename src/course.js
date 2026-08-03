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
import { COURSE } from './courses.js';
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
/**
 * The sea.
 *
 * Not a pond. A pond is an ellipse lying in the ground with a bed under it;
 * the sea is everything past a line, thirty yards below the course, with a
 * cliff where the land stops. That difference is the whole character of a
 * clifftop hole — you are not carrying water, you are playing along the edge
 * of something that ends.
 *
 * `off` holds the cliff top's lateral offset sampled at every centreline
 * point, so working out which side of the edge a point falls on is an array
 * lookup rather than a curve solve.
 */
export let OCEAN = null;   // { side, y, off: Float64Array, seaward: {x, z} }
export let CREEK = null;   // { pts:[{x,z}], w: half-width, y: waterline }
export let MOUNDS = [];

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

  // Bunkers first, but the shore has to be known before they are placed: one
  // whose outline runs over the cliff cannot be dug (the ground it would sit
  // in has fallen away), and what is left is a shelf of sand hanging in the
  // rock face. Easier to refuse it than to carve around it.
  const shoreOffFor = def.shore ? (at) => {
    const pts = def.shore.off;
    let k = 0;
    while (k < pts.length - 2 && pts[k + 1][0] < at) k++;
    const [a0, o0] = pts[k];
    const [a1, o1] = pts[Math.min(k + 1, pts.length - 1)];
    const uu = a1 === a0 ? 0 : clamp((at - a0) / (a1 - a0), 0, 1);
    return o0 + (o1 - o0) * uu * uu * (3 - 2 * uu);
  } : null;

  BUNKERS = (def.bunkers ?? []).filter((b) => {
    if (!shoreOffFor) return true;
    const side = def.shore.side ?? 1;
    const inland = side > 0 ? shoreOffFor(b.at) - b.off : b.off - shoreOffFor(b.at);
    // Its own radius plus the wobble the coastline is allowed, plus margin.
    return inland > b.rx + 18;
  }).map((b, i) => {
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

  OCEAN = null;
  if (def.shore) {
    const side = def.shore.side ?? 1;
    const pts = def.shore.off;
    const off = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const dist = pS[i];
      let k = 0;
      while (k < pts.length - 2 && pts[k + 1][0] < dist) k++;
      const [a0, o0] = pts[k];
      const [a1, o1] = pts[Math.min(k + 1, pts.length - 1)];
      // Smoothstepped, not linear. A cove is described by two points a few
      // dozen yards apart, and interpolating them straight gives the cliff a
      // chamfered corner — it read as a quarry rather than as a bay.
      const uu = a1 === a0 ? 0 : clamp((dist - a0) / (a1 - a0), 0, 1);
      const u = uu * uu * (3 - 2 * uu);
      // Wobbled, or the coast is a drawn line. Two long wavelengths only:
      // anything shorter than a few dozen yards reads as noise on a cliff
      // rather than as headlands and coves.
      off[i] = o0 + (o1 - o0) * u
             + 7.0 * Math.sin(dist * 0.0135 + def.n * 1.7)
             + 3.5 * Math.sin(dist * 0.0310 + def.n * 3.1);
    }
    // Which way is out to sea, in world space — taken at the middle of the
    // hole, which is close enough for the backdrop and the ambience.
    const mid = (N / 2) | 0;
    OCEAN = {
      side, y: def.shore.y ?? -28, off,
      seaward: { x: -pTZ[mid] * side, z: pTX[mid] * side },
    };
  }

  CREEK = null;
  if (def.creek) {
    const pts = def.creek.points.map(([at, off]) => resolve(at, off));
    // One waterline for the whole run. A creek that followed the ground would
    // need a flowing surface and a graded bed; a single level reads fine at
    // this scale and keeps the ribbon flat, which is what lets the stylised
    // water shader work unchanged.
    let lo = Infinity;
    for (const p of pts) lo = Math.min(lo, swell(p.x, p.z));
    CREEK = { pts, w: def.creek.width, y: lo - 0.9 };
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

/**
 * Signed yards inland of the cliff top — positive on land, negative over the
 * sea. Takes an already-computed `nearest` where the caller has one, because
 * nearest() hands back a shared object and calling it again mid-way through
 * heightAt would clobber the copy that function is holding.
 */
export function shoreEdge(x, z, n) {
  if (!OCEAN) return 999;
  const nn = n ?? nearest(x, z);
  // perp is the negative of the hole-definition's `off`, so the lateral
  // offset of a point is -perp and the two comparisons fold into a sign.
  return OCEAN.side > 0 ? OCEAN.off[nn.i] + nn.perp : -nn.perp - OCEAN.off[nn.i];
}
export function greenField(x, z) { return shapeField(x, z, GREEN); }

/**
 * Normalised distance to the creek — 1.0 is the bank.
 *
 * A creek is a path, not an outline, so this is distance to a polyline rather
 * than a radial field. Same convention as the closed shapes, which is what
 * lets surface classification, the sculpt and the texture treat both the same.
 */
export function creekField(x, z) {
  if (!CREEK) return Infinity;
  const p = CREEK.pts;
  let best = Infinity;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i].x, az = p[i].z;
    const dx = p[i + 1].x - ax, dz = p[i + 1].z - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x - (ax + dx * t), qz = z - (az + dz * t);
    const d2 = qx * qx + qz * qz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best) / CREEK.w;
}

/** The waterline governing a point, or -999 where there is no water. */
export function waterLevelAt(x, z) {
  if (CREEK && creekField(x, z) < 1.35) return CREEK.y;
  if (POND && pondField(x, z) < 1.35) return WATER_Y;
  if (OCEAN && shoreEdge(x, z) < 1.5) return OCEAN.y;
  return -999;
}

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
  if (OCEAN && shoreEdge(x, z) < 0) return 'water';
  if (pondField(x, z) < 1 || creekField(x, z) < 1) return 'water';
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
  // Over the sea it is a splash, not a lost ball. Both cost a stroke, but one
  // of them is the hole's defining feature and deserves to be named as such.
  if (OCEAN && shoreEdge(x, z, n) < 0) return false;
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
  // Blended wide. The pad sits about a yard above its surroundings, and
  // over a four-yard shoulder that is a fourteen-degree slope, which drops
  // a cel band and rings the green with a dark collar.
  const gb = smoothstep(-9.0, 1.0, ge);
  if (gb > 0) {
    // A gentle crown for putt break, plus a whisper of tier.
    const crown = 0.55 * clamp(ge / GREEN.r, 0, 1) +
                  0.16 * Math.sin(x * 0.06 + 1.1) * Math.cos(z * 0.055);
    h = lerp(h, GREEN_BASE + crown, gb);
  }

  // How far inland this point is, worked out before anything is dug — a
  // bunker whose outline runs over the edge would otherwise hang its floor in
  // mid-air off the cliff face, and mounding would build headlands out of
  // nothing.
  let seaward = 0;
  if (OCEAN) {
    const se = OCEAN.side > 0 ? OCEAN.off[n.i] + n.perp : -n.perp - OCEAN.off[n.i];
    seaward = 1 - smoothstep(-6.0, 1.5, se);
    // The last thirty yards fall away toward the edge.
    //
    // Not decoration — it is what lets you see the water. The sea is thirty
    // yards below the cliff top, so from anywhere on flat ground it is hidden
    // behind the lip and the hole plays beside an ocean you cannot see. A
    // shoulder falling five yards over thirty tips the whole view outward and
    // the water comes up into frame. Suppressed over the green, which is a
    // built pad and must stay a pad.
    h -= 5.0 * (1 - smoothstep(2, 34, se)) * (1 - gb);
    // A lip of broken rock right at the edge, on top of the fall.
    h += 1.6 * (1 - smoothstep(0, 7, Math.abs(se - 3)));
  }
  const onLand = 1 - seaward;

  // Free-standing mounding, suppressed over the putting surface.
  for (let i = 0; i < MOUNDS.length; i++) {
    const m = MOUNDS[i];
    const d = Math.hypot(x - m.x, z - m.z);
    if (d < m.r) {
      const k = Math.cos((d / m.r) * Math.PI * 0.5);
      h += m.h * k * k * (1 - gb) * onLand;
    }
  }

  // Bunkers are dug, not dished: a flat sand floor, then a face up to the rim.
  //
  // The face is kept well inside the sand — done climbing by about 0.72 of the
  // radius — so there is a band of flat sand between the top of the wall and
  // the grass. Without it the rim vertices average their normals between the
  // steep wall and the flat turf, that tilt drops a cel band, and every bunker
  // wears a dark polygonal ring on the grass around it.
  let sandMask = 0;
  for (let i = 0; i < BUNKERS.length; i++) {
    const f = shapeField(x, z, BUNKERS[i]);
    // Wide on purpose. This mask fades the rough's relief out over the
    // bunker, and that relief is 1.5 yards tall — fade it over a couple of
    // yards and the fade itself becomes a thirty-degree slope ringing the
    // bunker, which drops a cel band and puts back the dark halo it was
    // meant to remove. Spread across ~15 yards the ramp stays under six
    // degrees, and the graded apron it leaves is what surrounds a real
    // bunker anyway.
    sandMask = Math.max(sandMask, 1 - smoothstep(0.90, 2.10, f));
    if (f < 1.90) {
      const bowl = 1 - smoothstep(0.25, 0.72, f);
      // Only a whisper of a lip. At any real height its outer face turns far
      // enough to drop a cel band, and that rings the bunker with a hard dark
      // crescent on the grass outside it — an artefact worth far more than
      // the detail is worth. Spread this thin, the slope stays under a degree.
      const lip = smoothstep(0.92, 1.22, f) * (1 - smoothstep(1.22, 1.90, f));
      h -= 2.0 * bowl * onLand;
      h += 0.20 * lip * onLand;
    }
  }

  // Creek channel: a cut trough with soft banks, carved along the polyline.
  if (CREEK) {
    const cf = creekField(x, z);
    if (cf < 1.9) {
      const bed = 1 - smoothstep(0.0, 1.05, cf);
      h = lerp(h, CREEK.y - 1.5, bed);
      h -= 0.22 * smoothstep(2.40, 1.05, cf) * (1 - bed);
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
  // Two masks, because the two things they gate differ tenfold in height.
  //
  // `tight` gates the grass-height lip at a mowing line — a third of a yard,
  // which can fade over a few yards and stay shallow. `wide` gates the rough's
  // relief, which is a yard and a half: fade that over the same few yards and
  // the fade is a thirty-degree wall along the edge of every fairway. Spread
  // over fifteen it stays under five degrees.
  const mownTight = Math.max(
    1 - smoothstep(hw - 2.0, hw + 3.0, n.dist),
    smoothstep(-2.5, 1.0, ge)
  );
  const mownWide = Math.max(
    1 - smoothstep(hw - 2.0, hw + 16.0, n.dist),
    smoothstep(-16.0, 1.0, ge)
  );
  // Sand is not long grass. Letting the rough's relief and its grass-height
  // lift run through a bunker makes the sand lumpy, and those bumps tilt
  // normals far enough to drop cel bands — which is most of the mottled dark
  // patching that shows up in and around bunkers cut into the rough.
  const unmown = (1 - mownTight) * (1 - sandMask);
  const unmownWide = (1 - mownWide) * (1 - sandMask);
  // Rolling relief in the rough only. Mown ground stays smooth: a cel ramp
  // turns every gentle undulation into a wandering band edge, and on a fairway
  // that reads as a shading fault rather than as ground.
  if (unmownWide > 0.001) {
    h += unmownWide * 1.5 * fbm2(x * 0.040 + 11.3, z * 0.038 - 7.1);
  }

  // Grass height is real height. Rough is left long and the fairway and green
  // are cut short, so every mowing line has an actual lip at it — that step
  // catches the light and is what makes the boundaries read as boundaries
  // instead of as a change of paint.
  h += 0.34 * unmown;

  // The cart path is graded: sits just below the turf either side of it.

  // The cliff itself. Steep on purpose — about seventy degrees, which at this
  // grid spacing is three quads. A gentler fall would be a beach, and what a
  // clifftop hole needs is ground that simply stops.
  if (seaward > 0) h = lerp(h, OCEAN.y - 7, seaward);

  // A distant rim so the world never shows a cut edge against the sky — but
  // not out to sea, where it would be a wall of land rising out of the water.
  const rim = Math.max(0, n.dist - 150) * 0.11;
  h += (Math.min(rim, 26) + smoothstep(150, 320, n.dist) * 12) * (1 - seaward);

  return h;
}

/**
 * The height the *ball* collides with: the ground, or the waterline where the
 * pond covers it. Without this the ball sinks to the pond bed before the
 * splash triggers, and you see it pass through the water.
 */
export function surfaceHeightAt(x, z) {
  const h = heightAt(x, z);
  if (OCEAN && shoreEdge(x, z) < 0) return Math.max(h, OCEAN.y);
  if (CREEK && creekField(x, z) < 1) return Math.max(h, CREEK.y);
  if (POND && pondField(x, z) < 1) return Math.max(h, WATER_Y);
  return h;
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
  rough:    [0x6b, 0x9e, 0x55],
  roughAlt: [0x5c, 0x90, 0x46],
  roughMean:[0x67, 0x99, 0x4f], // what the shader blends to at a cut line
  roughDry: [0x85, 0xa3, 0x57],
  roughWet: [0x47, 0x7c, 0x3c],
  deep:     [0x50, 0x81, 0x3f],
  fairA:    [0x79, 0xa9, 0x60],
  fairB:    [0x84, 0xb0, 0x6b],
  collar:   [0x7c, 0xac, 0x64],
  greenA:   [0x8c, 0xb7, 0x76],
  // Augusta's sand is famously near-white — it is not beach sand. Keeping a
  // little warmth in the damp rim stops it going blue in the fill light.
  sand:     [0xfb, 0xfa, 0xf6],
  sandDark: [0xe8, 0xe4, 0xd8],
  water:    [0x27, 0x6c, 0x87],
  waterEdge:[0x6b, 0xb2, 0xc6],
  // Pine straw. Warm red-brown, and darker than it looks in photographs —
  // it sits in tree shade nearly all day.
  // Weathered lava at the cliff edge. Dark, but not black: in this light a
  // true black reads as a hole cut in the ground rather than as rock.
  // Cool, not warm. A neutral grey turns brown the moment a low sun
  // multiplies into it, and brown rock reads as mud rather than as lava.
  rock:     [0x3c, 0x40, 0x46],
  rockLit:  [0x5c, 0x62, 0x6a],
  // Dry native scrub above the cliff — the tan fringe in every photograph of
  // a course like this, and the thing that keeps the green from running
  // straight into the blue.
  scrub:    [0xa8, 0x9c, 0x62],
  // Burnt native rough. Lush green next to a lava cliff reads as a lawn that
  // someone has been watering, which is the opposite of the place.
  roughCoast:  [0x8f, 0x91, 0x50],
  // The first few yards off the fairway: still green, just tired.
  roughCoastNear: [0x74, 0x95, 0x52],
  roughCoastB: [0xa9, 0x9c, 0x5a],
  ocean:    [0x14, 0x44, 0x6e],
  straw:    [0x9d, 0x6b, 0x3e],
  strawAlt: [0x85, 0x56, 0x31],
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
export function makeCourseTexture(size = 2048) {
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

  // ------------------------------------------------------ the smooth fields
  //
  // Five fbm2 calls per texel, each stacking harmonics, are most of the cost
  // of this bake — and they are the one part of it that does not need the
  // resolution. What reads as a low-resolution course texture is never the
  // mottling; it is the *edges*, the arc of a bunker or the line where the
  // fairway stops, and those come from analytic fields that cost little.
  //
  // So the noise gets its own half-resolution grid and is interpolated up.
  // Doubling the texture then costs roughly what the old one did, while every
  // edge in it comes out twice as sharp. At the sizes used here the noise grid
  // still lands under a yard per sample, which is where the finest harmonic
  // in these fields bottoms out anyway; anything finer than that is the
  // shader's turf grain, not this.
  const NS = size >> 1;
  const nstep = WORLD_SIZE / NS;
  const cells = (NS + 1) * (NS + 1);
  const fMott = new Float32Array(cells);
  const fDry = new Float32Array(cells);
  const fWet = new Float32Array(cells);

  for (let j = 0; j <= NS; j++) {
    const z = z0 + j * nstep;
    for (let i = 0; i <= NS; i++) {
      const x = x0 + i * nstep;
      const k = j * (NS + 1) + i;
      fMott[k] = clamp(0.5 + 0.5 * (
        fbm2(x * 0.021, z * 0.019) * 0.46 +
        fbm2(x * 0.062 + 3.1, z * 0.058 - 1.4) * 0.33 +
        fbm2(x * 0.160 + 7.7, z * 0.150 + 2.2) * 0.21
      ), 0, 1);
      fDry[k] = 0.5 + 0.5 * fbm2(x * 0.034 - 5.2, z * 0.037 + 4.4);
      fWet[k] = 0.5 + 0.5 * fbm2(x * 0.048 + 9.6, z * 0.044 - 6.8);
    }
  }

  /** Bilinear lookup into one of the fields above, at grid cell (i,j)+(fx,fy). */
  const field = (f, i, j, fx, fy) => {
    const row = j * (NS + 1) + i;
    const a = f[row], b = f[row + 1];
    const c = f[row + NS + 1], e = f[row + NS + 2];
    const top = a + (b - a) * fx;
    return top + ((c + (e - c) * fx) - top) * fy;
  };

  for (let py = 0; py < size; py++) {
    // Canvas row 0 maps to the far end of the hole (uv v = 1).
    const z = z0 + py * step;
    // Where this row sits on the noise grid, and how far between samples.
    const nv = (py * NS) / size;
    const nj = Math.min(NS - 1, nv | 0);
    const nfy = nv - nj;

    for (let px = 0; px < size; px++) {
      const x = x0 + px * step;
      nearest(x, z, n);

      const nu = (px * NS) / size;
      const ni = Math.min(NS - 1, nu | 0);
      const nfx = nu - ni;

      // --- base: rough, in layered patches ---
      const mott = field(fMott, ni, nj, nfx, nfy);
      mix(C.rough, C.roughAlt, mott, col);

      const dry = field(fDry, ni, nj, nfx, nfy);
      mix(col, C.roughDry, smoothstep(0.44, 0.90, dry) * 0.58, col);
      const wet = field(fWet, ni, nj, nfx, nfy);
      mix(col, C.roughWet, smoothstep(0.48, 0.94, wet) * 0.52, col);

      const deepen = smoothstep(50, 95, n.dist);
      mix(col, C.deep, deepen * 0.75, col);

      // --- burnt coastal rough ---
      // Only the fairways and greens are watered on a headland; everything
      // else is the colour the wind and the salt leave it. Keyed off distance
      // from the mown line rather than painted flat, so the change happens at
      // the mower's edge where the eye expects it.
      if (COURSE.coastal) {
        // Spread over twenty yards rather than fifteen, and starting a few
        // yards out from the cut. Beginning it at the mowing line put a hard
        // tan stripe hard against the fairway that read as a dirt path — the
        // change of colour has to happen well clear of the change of height,
        // or the two edges stack into one that looks built.
        const hwC = fairwayHalfWidth(n.t);
        const offCut = smoothstep(hwC + 4, hwC + 26, n.dist);
        mix(C.roughCoast, C.roughCoastB, mott, tmp);
        mix(col, tmp, offCut * (0.50 + 0.34 * dry), col);
      }

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

      // --- bunkers: bright sand, damp at the rim ---
      const bf = bunkerField(x, z);
      if (bf < 1.15 && (!OCEAN || shoreEdge(x, z, n) > 2)) {
        const m = 1 - smoothstep(0.97, 1.03, bf);
        mix(C.sandDark, C.sand, 1 - smoothstep(0.35, 0.95, bf), tmp);
        tmp[0] += (mott - 0.5) * 6; tmp[1] += (mott - 0.5) * 5; tmp[2] += (mott - 0.5) * 4;
        mix(col, tmp, m, col);
      }

      // --- creek: shoreline, then the dark bed under the ribbon ---
      if (CREEK) {
        const cf = creekField(x, z);
        if (cf < 1.5) {
          // Keyed to the waterline, not to the outline.
          //
          // The outline is the *maximum* extent of the water; the terrain
          // decides how much of that actually holds any, and on these basins
          // that is only about seventy percent. Painting a bed across the rest
          // left a ring of blue ground lying outside the water with nothing on
          // top of it — which reads as a moat, or as a shadow, or on a hole
          // where the pond is distant, as the water itself. Deriving both the
          // bed and its damp margin from the same height test the water plane
          // is clipped by puts the painted edge exactly under the real one.
          const g = heightAt(x, z);
          const wy = CREEK.y;
          const bed = 1 - smoothstep(wy - 0.10, wy + 0.45, g);
          const damp = smoothstep(wy + 0.05, wy + 0.55, g) * (1 - smoothstep(wy + 0.55, wy + 1.7, g));
          mix(col, C.waterEdge, damp * 0.35, col);
          mix(col, C.water, bed, col);
        }
      }

      // --- pond: shoreline, then the dark bed under the water plane ---
      if (POND) {
        const pf = pondField(x, z);
        if (pf < 1.35) {
          // Same as the creek above: the waterline decides, not the outline.
          const g = heightAt(x, z);
          const bed = 1 - smoothstep(WATER_Y - 0.10, WATER_Y + 0.45, g);
          const damp = smoothstep(WATER_Y + 0.05, WATER_Y + 0.55, g)
                     * (1 - smoothstep(WATER_Y + 0.55, WATER_Y + 1.7, g));
          mix(col, C.waterEdge, damp * 0.35, col);
          mix(col, C.water, bed, col);
        }
      }

      // --- the coast: scrub, then rock, then open sea ---
      if (OCEAN) {
        const se = OCEAN.side > 0 ? OCEAN.off[n.i] + n.perp : -n.perp - OCEAN.off[n.i];
        const scrub = smoothstep(34, 12, se) * (1 - smoothstep(12, 4, se) * 0.35);
        if (scrub > 0.001) mix(col, C.scrub, scrub * 0.72 * (1 - smoothstep(60, 24, n.dist)), col);
        const rock = 1 - smoothstep(3.0, 20.0, se);
        if (rock > 0.001) {
          mix(C.rock, C.rockLit, mott, tmp);
          mix(col, tmp, rock * 0.94, col);
        }
        const sea = 1 - smoothstep(-9.0, -1.5, se);
        if (sea > 0.001) mix(col, C.ocean, sea, col);
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
