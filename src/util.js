/**
 * util.js — small math helpers shared across the game.
 * Everything here is pure and allocation-free where it matters.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is roughly "how many e-folds per second" — bigger = snappier.
 * This is the backbone of every soft motion in the game.
 */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Same, but for angles (takes the short way around). */
export function dampAngle(current, target, lambda, dt) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return damp(current + d, target, lambda, dt);
}

// ---------------------------------------------------------------- easing
export const easeInQuad = (t) => t * t;
export const easeOutQuad = (t) => t * (2 - t);
export const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeOutBack = (t) => {
  const c1 = 1.32, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** Deterministic PRNG so the course looks identical every load. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap, smooth, tileable-ish value noise from summed sines. Good enough for hills. */
export function fbm2(x, y) {
  return (
    Math.sin(x * 1.00 + 1.7) * Math.cos(y * 0.87 - 0.4) * 0.50 +
    Math.sin(x * 2.13 - 0.9) * Math.cos(y * 1.91 + 1.2) * 0.28 +
    Math.sin(x * 4.07 + 2.4) * Math.cos(y * 3.71 - 2.1) * 0.14 +
    Math.sin((x + y) * 6.3 + 0.6) * 0.08
  );
}

/** Deterministic hash noise from a 3D position — used to jitter tree canopies. */
export function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Format a number of world units (≈ yards) for the HUD. */
export const yds = (v) => `${Math.round(v)} yds`;
