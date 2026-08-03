/**
 * woodtex.js — the wood, drawn rather than downloaded.
 *
 * The interface was already wooden in its shapes: boards, slabs, hard outlines,
 * a lip under every button. What it did not have was any actual wood. Flat
 * brown is a colour; grain is a material, and the difference is the whole
 * distance between "this is themed like wood" and "this is made of wood".
 *
 * Generated on a canvas at load and handed out as data URLs, because the game
 * is a folder of ES modules served as they are — there is no build step to run
 * an image through and no reason to make anyone download one. Two tiles, about
 * a quarter of a megapixel each, generated once and cached here.
 *
 * The grain is the same idea in both: a smooth field warped by a second, much
 * coarser one, then pushed through a sine. Warping is what does the work — an
 * unwarped sine is corduroy, and it is the wobble that makes it timber.
 */

// ---------------------------------------------------------------- noise
const hash = (x, y, s) => {
  let h = x * 374761393 + y * 668265263 + s * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};

const smooth = (t) => t * t * (3 - 2 * t);

function value(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

function fbm(x, y, s, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    v += value(x * f, y * f, s + i * 17) * amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v;
}

// ---------------------------------------------------------------- helpers
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Mix two [r,g,b] arrays. */
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * A knot: concentric rings tightening toward a dark centre, with the
 * surrounding grain pulled around it.
 *
 * Knots are what stop a plank looking like a printed pattern — they are the
 * one feature the eye uses to decide a surface is a real cut through a real
 * tree, and two or three per tile is plenty.
 */
function knotAt(x, y, k) {
  const dx = (x - k.x) / k.rx, dy = (y - k.y) / k.ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1) return null;
  const rings = Math.sin(d * k.freq - 1.2) * 0.5 + 0.5;
  const core = 1 - smooth(clamp01(d / 0.26));
  return { fade: 1 - smooth(d), rings, core };
}

// ---------------------------------------------------------------- planks
/**
 * A wall of vertical planks. Dark, for backgrounds.
 *
 * Tiles horizontally only. The seams have to line up across the repeat and the
 * grain does not, so the tile is a whole number of planks wide and tall enough
 * that the vertical repeat lands off-screen on any sane window.
 */
export function plankWall(plankW = 104, planks = 5, h = 900) {
  const w = plankW * planks;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;

  // Three browns: the body of the wood, the dark of the late growth, and a
  // warmer light for where the plane has cut across the grain.
  const DARK = [46, 30, 17];
  const BODY = [86, 57, 32];
  const LIGHT = [122, 84, 48];

  const knots = [];
  for (let p = 0; p < planks; p++) {
    // Not every plank has one, and none of them has two.
    if (hash(p, 7, 3) < 0.45) continue;
    knots.push({
      x: p * plankW + plankW * (0.3 + hash(p, 11, 5) * 0.4),
      y: h * hash(p, 13, 9),
      rx: 13 + hash(p, 17, 2) * 9,
      ry: 20 + hash(p, 19, 4) * 16,
      freq: 2.4 + hash(p, 23, 6) * 1.4,
    });
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = Math.floor(x / plankW);
      const lx = x - p * plankW;             // position across this plank
      const seed = p * 31;

      // Each plank is cut from its own board, so each gets its own tone and
      // its own offset into the grain. Without this the wall is one wide
      // plank with lines ruled on it.
      const tone = 0.82 + hash(p, 3, 1) * 0.36;
      const yOff = hash(p, 5, 2) * 900;

      // Grain: fine rings across the plank, warped by a coarse field so they
      // wander the way real ones do.
      const warp = fbm(lx * 0.030, (y + yOff) * 0.0065, seed, 3) * 26;
      let g = Math.sin((lx + warp) * 0.42) * 0.5 + 0.5;
      g = Math.pow(g, 1.5);
      // A second, finer set, so close up there is something to look at.
      g = g * 0.78 + (Math.sin((lx + warp * 1.7) * 1.9) * 0.5 + 0.5) * 0.22;
      // And long streaks along the length of the board.
      const streak = fbm(lx * 0.09, (y + yOff) * 0.010, seed + 40, 3);

      let col = mix(BODY, DARK, g * 0.72);
      col = mix(col, LIGHT, clamp01(streak - 0.42) * 0.65);

      for (const k of knots) {
        const kn = knotAt(x, y, k);
        if (!kn) continue;
        col = mix(col, DARK, kn.fade * (0.35 + kn.rings * 0.45));
        col = mix(col, [26, 16, 9], kn.core * 0.85);
      }

      // The seam. A dark gap with a lit edge on one side, which is what
      // actually reads as two boards rather than a drawn line.
      const edge = Math.min(lx, plankW - 1 - lx);
      if (edge < 4) {
        const t = 1 - edge / 4;
        col = mix(col, [22, 13, 6], t * 0.85);
        if (lx > plankW / 2) col = mix(col, LIGHT, t * 0.10);
      }

      const o = (y * w + x) * 4;
      d[o] = col[0] * tone;
      d[o + 1] = col[1] * tone;
      d[o + 2] = col[2] * tone;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

/**
 * A pale board, for the panels the interface writes on.
 *
 * Grain runs along the width here rather than across it, because these are
 * signs cut from a plank lengthways and a sign with vertical grain reads as a
 * fence post someone has written on.
 */
export function boardFace(w = 512, h = 256) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;

  const PALE = [246, 231, 199];
  const MID = [225, 200, 156];
  const DEEP = [196, 163, 116];

  const knots = [
    { x: w * 0.22, y: h * 0.34, rx: 16, ry: 11, freq: 2.8 },
    { x: w * 0.74, y: h * 0.68, rx: 13, ry: 9, freq: 3.2 },
  ];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const warp = fbm(x * 0.0065, y * 0.030, 91, 3) * 24;
      let g = Math.sin((y + warp) * 0.40) * 0.5 + 0.5;
      g = Math.pow(g, 1.7);
      g = g * 0.75 + (Math.sin((y + warp * 1.6) * 1.7) * 0.5 + 0.5) * 0.25;
      const streak = fbm(x * 0.010, y * 0.085, 131, 3);

      let col = mix(PALE, MID, g * 0.55);
      col = mix(col, DEEP, clamp01(streak - 0.52) * 0.5);

      for (const k of knots) {
        const kn = knotAt(x, y, k);
        if (!kn) continue;
        col = mix(col, DEEP, kn.fade * (0.30 + kn.rings * 0.40));
        col = mix(col, [140, 104, 62], kn.core * 0.7);
      }

      const o = (y * w + x) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

// ---------------------------------------------------------------- cache
//
// Both tiles cost about forty milliseconds to draw and are wanted by four
// different stylesheets. Generated once, on first ask.
let _wall = null, _board = null;

export function wallURL() { return (_wall ??= plankWall()); }
export function boardURL() { return (_board ??= boardFace()); }

/**
 * Publish them as CSS custom properties on :root.
 *
 * One call, and every stylesheet in the app can say `var(--wood-wall)` without
 * importing anything or knowing they were drawn at all.
 */
export function installWoodVars() {
  const r = document.documentElement.style;
  r.setProperty('--wood-wall', `url(${wallURL()})`);
  r.setProperty('--wood-board', `url(${boardURL()})`);
}
