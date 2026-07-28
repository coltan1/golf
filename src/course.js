/**
 * course.js — the hole, described once.
 *
 * Every visual (the baked fairway texture, the sculpted terrain) and every
 * gameplay rule (where the ball rolls fast, where it plugs, where it splashes)
 * reads from the functions in this file. One source of truth means the ball
 * always behaves exactly the way the ground *looks* like it should.
 *
 * Units: 1 world unit ≈ 1 yard. The hole plays ~400 yards, par 4.
 * Play direction is -Z; the tee sits near the origin.
 */

import { CatmullRomCurve3, Vector3 } from 'three';
import { clamp, lerp, smoothstep, fbm2 } from './util.js';

// ---------------------------------------------------------------- world box
// The terrain plane and the baked course texture both cover this square.
export const WORLD_SIZE = 780;
export const WORLD_CX = 0;
export const WORLD_CZ = -190;

// ---------------------------------------------------------------- landmarks
export const TEE = { x: 0, z: 6 };
export const GREEN = { x: 31, z: -388, r: 17 };
export const HOLE_POS = { x: 33.5, z: -391 };
export const PAR = 4;

/**
 * Yards between mowing passes. The baked fairway bands below and the per-pixel
 * grooves in terrain.js both use this period against the same signed distance,
 * so the two patterns stay exactly in phase and reinforce each other.
 * Bigger number = wider, fewer stripes.
 */
export const MOW_PERIOD = 4.0;

/** Greenside + fairway bunkers (soft ellipses). */
const BUNKERS = [
  { x: 13, z: -372, rx: 11.5, rz: 7.5, rot: 0.42 },
  { x: 49, z: -391, rx: 9.5, rz: 6.5, rot: -0.35 },
  { x: -13, z: -198, rx: 10.5, rz: 7.0, rot: 0.18 },
];

/** A calm pond well left of the landing zone — pretty, and a gentle warning. */
const POND = { x: -58, z: -286, rx: 32, rz: 25 };

// ---------------------------------------------------------------- centreline
// Gentle late dogleg right. The last point runs past the green so the
// centreline never ends abruptly under the putting surface.
const PATH_POINTS = [
  new Vector3(0, 0, 6),
  new Vector3(-4, 0, -70),
  new Vector3(-9, 0, -152),
  new Vector3(2, 0, -242),
  new Vector3(22, 0, -322),
  new Vector3(31, 0, -388),
  new Vector3(34, 0, -436),
];

const N = 700;
const pX = new Float32Array(N);
const pZ = new Float32Array(N);
const pTX = new Float32Array(N); // unit tangent
const pTZ = new Float32Array(N);
const pS = new Float32Array(N);  // cumulative arc length (yards from the tee)

(function buildCentreline() {
  const curve = new CatmullRomCurve3(PATH_POINTS, false, 'catmullrom', 0.5);
  const tmp = new Vector3();
  for (let i = 0; i < N; i++) {
    curve.getPoint(i / (N - 1), tmp);
    pX[i] = tmp.x;
    pZ[i] = tmp.z;
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
})();

/** Total playing length, tee to cup (for the HUD). */
export const HOLE_LENGTH = (() => {
  const n = nearest(HOLE_POS.x, HOLE_POS.z, {});
  return n.s;
})();

// ---------------------------------------------------------------- queries
// A reusable result object keeps the texture bake (1M+ samples) allocation-free.
const _n = { dist: 0, side: 0, perp: 0, t: 0, s: 0, i: 0 };

/**
 * Nearest point on the centreline.
 * The path is monotonic in Z, so we jump straight to the right neighbourhood
 * instead of scanning all 700 samples — this is what makes the bake fast.
 */
export function nearest(x, z, out = _n) {
  // Seed at the sample with the matching Z, then scan outward. The window has
  // to be generous: where the hole runs diagonally, the *perpendicular*
  // closest point sits well up or down the path from the matching Z.
  const i0 = indexForZ(z);
  const lo = Math.max(0, i0 - 26), hi = Math.min(N - 1, i0 + 26);

  let best = i0, bestD2 = Infinity;
  for (let i = lo; i <= hi; i++) {
    const dx = x - pX[i], dz = z - pZ[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  const dx = x - pX[best], dz = z - pZ[best];
  out.dist = Math.sqrt(bestD2);
  // The 2D cross product with the unit tangent *is* the signed perpendicular
  // distance. Unlike `dist` it passes cleanly through zero at the centreline,
  // which is what the mowing grooves key off — `dist` would kink there.
  out.perp = pTZ[best] * dx - pTX[best] * dz;
  out.side = out.perp < 0 ? 1 : -1; // +1 = right of play
  out.t = best / (N - 1);
  out.s = pS[best];
  out.i = best;
  return out;
}

/**
 * Index of the last centreline sample at or before `z`.
 * The samples are uniform in curve *parameter*, not in Z, so estimating the
 * index by interpolating Z is wrong wherever the curve steepens — hence a
 * real (and still cheap) binary search. pZ decreases monotonically.
 */
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

/** Fairway half-width in yards — generous off the tee, pinched at the dogleg. */
export function fairwayHalfWidth(t) {
  return 17 + 7.5 * Math.sin(t * Math.PI) - 4 * smoothstep(0.72, 0.95, t);
}

/** A point `dist` yards further down the hole — used to aim the tee shot. */
export function aimPointAhead(x, z, dist) {
  const n = nearest(x, z);
  const target = n.s + dist;
  let i = n.i;
  while (i < N - 1 && pS[i] < target) i++;
  return { x: pX[i], z: pZ[i] };
}

/** Squared-ish normalised distance inside an ellipse (1.0 = on the edge). */
function ellipseField(x, z, e) {
  const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
  const dx = x - e.x, dz = z - e.z;
  const u = (dx * c + dz * s) / e.rx;
  const v = (-dx * s + dz * c) / e.rz;
  return Math.sqrt(u * u + v * v);
}

/** Smallest bunker field value at this point (<1 means inside a bunker). */
export function bunkerField(x, z) {
  let m = Infinity;
  for (let i = 0; i < BUNKERS.length; i++) m = Math.min(m, ellipseField(x, z, BUNKERS[i]));
  return m;
}
export function pondField(x, z) { return ellipseField(x, z, POND); }

export function distToHole(x, z) { return Math.hypot(x - HOLE_POS.x, z - HOLE_POS.z); }
function distToGreen(x, z) { return Math.hypot(x - GREEN.x, z - GREEN.z); }

/**
 * Surface classification — drives friction, bounce and the shot the player gets.
 * Priority: water > bunker > green > fairway > rough.
 */
export function surfaceAt(x, z) {
  if (pondField(x, z) < 1) return 'water';
  if (bunkerField(x, z) < 1) return 'sand';
  if (distToGreen(x, z) < GREEN.r) return 'green';
  const n = nearest(x, z);
  if (n.dist < fairwayHalfWidth(n.t)) return 'fairway';
  if (n.dist > 62) return 'deep';
  return 'rough';
}

/** True once the ball has wandered outside the playable world. */
export function isOutOfBounds(x, z) {
  const n = nearest(x, z);
  return n.dist > 130 || z > 48 || z < -470;
}

// ---------------------------------------------------------------- height
// Two octave sets: `rolling` for the wild country, `swell` for the mown
// corridor, which stays smooth so putts read true and stripes stay legible.
function rolling(x, z) {
  return (
    3.1 * fbm2(x * 0.0062, z * 0.0051) +
    1.5 * fbm2(x * 0.0169 + 4.1, z * 0.0141 - 2.2) +
    5.2 * Math.sin((x + z * 0.6) * 0.0043 + 1.9)
  );
}
function swell(x, z) {
  return 2.4 * fbm2(x * 0.0058 + 0.3, z * 0.0047 - 0.8) + 2.0 * Math.sin((x * 0.4 + z) * 0.0039 + 0.7);
}

export const WATER_Y = swell(POND.x, POND.z) - 1.15;
const GREEN_BASE = swell(GREEN.x, GREEN.z);

/**
 * Ground height at any point. Sculpted in layers:
 *   rolling country → flattened toward the mown corridor → green pad →
 *   bunker bowls with soft lips → pond basin → a low rim that hides the horizon.
 */
export function heightAt(x, z) {
  const n = nearest(x, z);
  const hw = fairwayHalfWidth(n.t);

  let h = rolling(x, z);

  // Ease the terrain toward the calmer `swell` inside and around the corridor.
  const mown = 1 - smoothstep(hw * 0.9, hw * 3.0, n.dist);
  h = lerp(h, swell(x, z), mown * 0.88);

  // Putting surface: a near-flat pad with a whisper of crown.
  const gd = distToGreen(x, z);
  const gb = 1 - smoothstep(GREEN.r * 0.45, GREEN.r * 1.45, gd);
  if (gb > 0) {
    // A gentle crown for putt break, and only a trace of undulation — enough
    // that putts read, little enough that the surface stays visually clean.
    const crown = 0.55 * Math.cos(clamp(gd / GREEN.r, 0, 1) * Math.PI * 0.5) +
                  0.16 * Math.sin(x * 0.06 + 1.1) * Math.cos(z * 0.055);
    h = lerp(h, GREEN_BASE + crown, gb);
  }

  // Bunkers: scooped bowl, gentle raised lip just outside the sand.
  for (let i = 0; i < BUNKERS.length; i++) {
    const f = ellipseField(x, z, BUNKERS[i]);
    if (f < 1.55) {
      const bowl = 1 - smoothstep(0.0, 1.0, f);
      const lip = smoothstep(0.92, 1.12, f) * (1 - smoothstep(1.12, 1.55, f));
      h -= 1.75 * bowl;
      h += 0.55 * lip;
    }
  }

  // Pond basin, always safely below the waterline.
  const pf = pondField(x, z);
  if (pf < 1.5) {
    const bed = 1 - smoothstep(0, 1.05, pf);
    h = lerp(h, WATER_Y - 3.2, bed);
    h -= 0.5 * smoothstep(1.3, 1.0, pf) * (1 - bed); // soft shoreline dip
  }

  // Rough is genuinely lumpy, not just a different colour. Real relief means
  // it catches the toon ramp's bands and casts its own little shadows, which
  // is what separates it from the billiard-flat mown surfaces. Wavelengths
  // stay well above the ~3 yard grid spacing so the mesh can resolve them.
  const mownTight = Math.max(
    1 - smoothstep(hw - 1, hw + 5, n.dist),
    1 - smoothstep(GREEN.r - 1, GREEN.r + 4, gd)
  );
  // One octave only, and a long one: fbm2's top harmonic is 6× its base, so
  // 0.072 bottoms out near a 14-yard wavelength — about four vertices per
  // bump on the ~3 yard grid. Anything shorter facets instead of undulating.
  if (mownTight < 0.999) {
    h += (1 - mownTight) * 1.25 * fbm2(x * 0.072 + 11.3, z * 0.069 - 7.1);
  }

  // Elevated tee. The hole falls away from you for the first hundred yards,
  // which opens the whole view up — the reference's downhill composition.
  const teeD = Math.hypot(x - TEE.x, z - TEE.z);
  h += 15 * (1 - smoothstep(9, 135, teeD));

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
  return pondField(x, z) < 1 ? Math.max(h, WATER_Y) : h;
}

/** Central-difference surface gradient — used for putt break and roll. */
export function gradientAt(x, z, out = { gx: 0, gz: 0 }) {
  const e = 1.2;
  out.gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  out.gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return out;
}

// ---------------------------------------------------------------- palette
// High-key and low-saturation, echoing the reference's sunlit snow: the value
// range is narrow and light, and colour does the work instead of contrast.
const C = {
  rough:    [0x7e, 0xba, 0x64],
  roughAlt: [0x6c, 0xa9, 0x52],
  roughDry: [0x9c, 0xc0, 0x66], // sun-bleached patches
  roughWet: [0x54, 0x92, 0x46], // lusher hollows
  deep:     [0x5e, 0x98, 0x4a],
  fairA:    [0x9a, 0xd6, 0x7b],
  fairB:    [0xa8, 0xe0, 0x89],
  collar:   [0x9e, 0xdb, 0x7f],
  greenA:   [0xb3, 0xe9, 0x96],
  greenB:   [0xbe, 0xf0, 0xa2],
  sand:     [0xf7, 0xeb, 0xd2],
  sandDark: [0xec, 0xdd, 0xbe],
  water:    [0x3f, 0x8d, 0xa6],
  waterEdge:[0x92, 0xd6, 0xdd],
  path:     [0xe8, 0xe1, 0xd4],
};

function mix(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/**
 * Bakes the whole course into one top-down canvas: rough, mowing stripes,
 * green, bunkers, cart path, shoreline. Painted rather than tiled, so every
 * transition is a soft smoothstep — no hard edges anywhere.
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
      // Three octaves of drift, plus two independent fields that push whole
      // areas dry or lush. This is the texture that survives into the
      // distance, once the shader's per-pixel grain has faded out.
      const mott = clamp(0.5 + 0.5 * (
        fbm2(x * 0.021, z * 0.019) * 0.46 +
        fbm2(x * 0.062 + 3.1, z * 0.058 - 1.4) * 0.33 +
        fbm2(x * 0.160 + 7.7, z * 0.150 + 2.2) * 0.21
      ), 0, 1);
      mix(C.rough, C.roughAlt, mott, col);

      const dry = 0.5 + 0.5 * fbm2(x * 0.034 - 5.2, z * 0.037 + 4.4);
      mix(col, C.roughDry, smoothstep(0.40, 0.88, dry) * 0.85, col);
      const wet = 0.5 + 0.5 * fbm2(x * 0.048 + 9.6, z * 0.044 - 6.8);
      mix(col, C.roughWet, smoothstep(0.44, 0.92, wet) * 0.8, col);

      const deepen = smoothstep(50, 95, n.dist);
      mix(col, C.deep, deepen * 0.75, col);

      // --- fairway, mown in passes running *down* the line of play ---
      // Keyed on perpendicular distance, so the bands run away from the tee
      // and curve with the dogleg — the corduroy in the reference. The fine
      // grooves on top of these are drawn per-pixel in the terrain shader.
      const hw = fairwayHalfWidth(n.t);
      const fairMask = 1 - smoothstep(hw - 3.0, hw + 3.5, n.dist);
      if (fairMask > 0.001) {
        const band = Math.sin((n.perp / MOW_PERIOD) * Math.PI * 2);
        const stripe = smoothstep(-0.6, 0.6, band);
        mix(C.fairA, C.fairB, stripe, tmp);
        // A touch of the same mottle keeps it organic.
        tmp[0] += (mott - 0.5) * 4; tmp[1] += (mott - 0.5) * 5; tmp[2] += (mott - 0.5) * 3;
        mix(col, tmp, fairMask, col);
      }

      // --- putting surface: collar ring, then a clean unstriped green ---
      // Deliberately no mowing lines here. A green is cut far shorter and in
      // its own pattern, so running the fairway stripes straight across it
      // makes the two surfaces look like one. Leaving it plain is what reads
      // as "this is the green".
      const gd = distToGreen(x, z);
      const collar = (1 - smoothstep(GREEN.r + 1.0, GREEN.r + 6.5, gd)) *
                     smoothstep(GREEN.r - 1.5, GREEN.r + 1.0, gd);
      if (collar > 0.001) mix(col, C.collar, collar * 0.85, col);
      const gMask = 1 - smoothstep(GREEN.r - 2.2, GREEN.r + 0.6, gd);
      if (gMask > 0.001) {
        // Flat colour, full stop — no stripes, no mottle, no grain. The green
        // is the shortest, most uniform cut on the course, and leaving it
        // completely clean is what makes it read that way against the
        // patchy rough and the striped fairway around it.
        mix(col, C.greenA, gMask, col);
      }

      // --- cart path: a pale ribbon offset to the right of play ---
      if (z < -18 && z > -352) {
        const pathMask = (1 - smoothstep(1.4, 2.6, Math.abs(n.dist - 38))) * (n.side > 0 ? 1 : 0);
        if (pathMask > 0.001) mix(col, C.path, pathMask * 0.9, col);
      }

      // --- bunkers: damp sand at the rim, bright sand in the middle ---
      const bf = bunkerField(x, z);
      if (bf < 1.25) {
        const m = 1 - smoothstep(0.94, 1.1, bf);
        mix(C.sandDark, C.sand, 1 - smoothstep(0.35, 0.95, bf), tmp);
        tmp[0] += (mott - 0.5) * 8; tmp[1] += (mott - 0.5) * 7; tmp[2] += (mott - 0.5) * 6;
        mix(col, tmp, m, col);
      }

      // --- pond: shoreline sand, then the dark bed under the water plane ---
      const pf = pondField(x, z);
      if (pf < 1.35) {
        const shore = (1 - smoothstep(1.02, 1.3, pf)) * smoothstep(0.9, 1.05, pf);
        mix(col, C.waterEdge, shore * 0.6, col);
        const bed = 1 - smoothstep(0.88, 1.02, pf);
        mix(col, C.water, bed, col);
      }

      const o = (py * size + px) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Convert a world XZ position into the baked texture's UV space. */
export function worldToUV(x, z) {
  const half = WORLD_SIZE / 2;
  return {
    u: (x - (WORLD_CX - half)) / WORLD_SIZE,
    v: 1 - (z - (WORLD_CZ - half)) / WORLD_SIZE,
  };
}

export { BUNKERS, POND };
