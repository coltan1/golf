/**
 * courses.js — which course you are playing.
 *
 * `HOLES` and `TOTAL_PAR` are exported as live bindings and swapped by
 * `setCourse`. Everything downstream already imports them by name, so changing
 * course is a reassignment here rather than a rewrite everywhere — ES modules
 * re-read a `let` export on every access, which is exactly the property needed
 * and the reason these are not `const`.
 *
 * A course is a routing plus a character. The routing is the holes; the
 * character is a handful of flags the prop and ambience builders read — what
 * grows here, what is scattered on the sand, what flies overhead. That is most
 * of the difference between a course cut through pines and one lying along a
 * shoreline.
 */

import { HOLES as PARKLAND } from './holes.js';

const W_OPEN = [30, 28, 26, 25];
const W_WIDE = [26, 25, 23, 22];

/**
 * A beach along the near edge of a hole's water.
 *
 * The terrain only knows two kinds of ground that are not grass: sand and
 * water, and sand is a list of ellipses. So rather than teach it about a
 * shoreline, the shoreline *is* a row of overlapping bunkers laid along the
 * water's inland edge — which means the surface lookup, the lie, the colour,
 * the ball physics and the shell scatter all work on it already, with nothing
 * new to keep in step.
 *
 * They are dug like bunkers too, two yards below the turf, which is what a
 * beach should do anyway: the ground has to fall to meet the sea.
 */
function shoreline(water, n = 11) {
  const side = Math.sign(water.off) || 1;
  // Centred on the water's edge, not inland of it. The pond outline wanders by
  // a fifth of its radius — that is what stops it looking like a drawn oval —
  // so sand placed to stop neatly at the average edge leaves grass showing
  // wherever the water pulls back. These straddle it and are wide enough that
  // the wander stays inside them.
  const off = water.off - side * water.rx * 0.94;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    out.push({
      at: water.at + (t - 0.5) * water.rz * 1.9,
      off: off + Math.sin(t * 5.1) * 6,
      rx: 40, rz: water.rz * (1.9 / n) * 1.05,
      rot: 0,
    });
  }
  return out;
}

/**
 * Palm Cay — nine holes along the water.
 *
 * Every hole has the sea on one side, and it alternates, so the trouble is
 * never in the same place two holes running. Corridors are wide and the ground
 * barely moves: the difficulty is the water and the sand, not the contours.
 *
 * The sea is a pond. There is one water body per hole in the terrain, and
 * rather than add a second concept for an ocean, this makes the pond enormous
 * and pushes it far enough off the centreline that its near edge is a beach
 * running the length of the hole. Everything downstream — the splash, the
 * penalty, the waterline, the reflection — already works on a pond.
 */
const BEACH = [
  {
    n: 1, name: 'Shell Beach', par: 4, yards: 388,
    path: [[0, 6], [-3, -110], [-8, -240], [-16, -350], [-20, -398]],
    width: W_OPEN,
    elev: [0, 1, 2, 2],
    green: { at: 384, off: -4, r: 16, squash: 1.15 },
    water: { at: 230, off: 96, rx: 78, rz: 150 },
    bunkers: [
      ...shoreline({ at: 230, off: 96, rx: 78, rz: 150 }),
      { at: 250, off: 34, rx: 20, rz: 12, rot: 0.1 },
      { at: 366, off: -20, rx: 11, rz: 8, rot: 0.4 },
    ],
    mounds: [{ at: 300, off: -34, r: 24, h: 3.0 }],
  },
  {
    n: 2, name: 'The Reef', par: 3, yards: 162,
    path: [[0, 6], [4, -78], [8, -160]],
    width: W_WIDE,
    elev: [0, 2, 3],
    green: { at: 159, off: 6, r: 15 },
    // Straight over the corner of the bay. Short, and entirely about nerve.
    water: { at: 96, off: -74, rx: 66, rz: 96 },
    bunkers: [
      ...shoreline({ at: 96, off: -74, rx: 66, rz: 96 }),
      { at: 146, off: 17, rx: 11, rz: 8, rot: -0.3 },
      { at: 172, off: 5, rx: 12, rz: 7, rot: 0 },
    ],
    mounds: [{ at: 120, off: 30, r: 18, h: 2.4 }],
  },
  {
    n: 3, name: 'Palm Row', par: 5, yards: 534,
    path: [[0, 6], [6, -130], [20, -262], [58, -372], [92, -472], [104, -528]],
    width: W_WIDE,
    elev: [0, -1, 0, 1],
    green: { at: 530, off: 6, r: 16 },
    water: { at: 330, off: -92, rx: 70, rz: 130 },
    bunkers: [
      ...shoreline({ at: 330, off: -92, rx: 70, rz: 130 }),
      { at: 268, off: 26, rx: 14, rz: 9, rot: 0.1 },
      { at: 508, off: -20, rx: 11, rz: 7, rot: 0.4 },
      { at: 512, off: 21, rx: 10, rz: 7, rot: -0.4 },
    ],
    mounds: [{ at: 420, off: 34, r: 26, h: 3.4 }],
  },
  {
    n: 4, name: 'Driftwood', par: 4, yards: 356,
    path: [[0, 6], [-7, -108], [-20, -226], [-32, -322], [-38, -366]],
    width: W_WIDE,
    elev: [0, 3, 5, 6],
    green: { at: 352, off: -6, r: 15 },
    water: { at: 210, off: 88, rx: 66, rz: 120 },
    bunkers: [
      ...shoreline({ at: 210, off: 88, rx: 66, rz: 120 }),
      { at: 198, off: -22, rx: 12, rz: 8, rot: 0.2 },
      { at: 334, off: -19, rx: 10, rz: 7, rot: 0.5 },
      { at: 340, off: 18, rx: 9, rz: 6, rot: -0.4 },
    ],
    mounds: [{ at: 280, off: -32, r: 22, h: 3.8 }],
  },
  {
    n: 5, name: 'Long Tide', par: 5, yards: 549,
    path: [[0, 6], [-2, -140], [-5, -278], [-9, -404], [-13, -512], [-15, -544]],
    width: W_OPEN,
    elev: [0, -2, -3, -1],
    green: { at: 545, off: -2, r: 17, squash: 1.15 },
    water: { at: 340, off: -100, rx: 76, rz: 170 },
    bunkers: [
      ...shoreline({ at: 340, off: -100, rx: 76, rz: 170 }),
      { at: 262, off: 28, rx: 16, rz: 10, rot: 0 },
      { at: 418, off: 25, rx: 13, rz: 8, rot: 0.3 },
      { at: 528, off: 20, rx: 10, rz: 7, rot: -0.4 },
    ],
    mounds: [{ at: 340, off: 36, r: 28, h: 3.6 }],
  },
  {
    n: 6, name: 'Gull Point', par: 3, yards: 148,
    path: [[0, 6], [-3, -72], [-5, -146]],
    width: W_WIDE,
    elev: [0, 2, 4],
    green: { at: 145, off: -4, r: 14 },
    water: { at: 92, off: 70, rx: 60, rz: 92 },
    bunkers: [
      ...shoreline({ at: 92, off: 70, rx: 60, rz: 92 }),
      { at: 132, off: -16, rx: 10, rz: 7, rot: 0.4 },
      { at: 158, off: -3, rx: 11, rz: 6, rot: 0 },
    ],
    mounds: [{ at: 100, off: -26, r: 18, h: 2.6 }],
  },
  {
    n: 7, name: 'The Sandbar', par: 4, yards: 418,
    path: [[0, 6], [5, -118], [14, -238], [54, -336], [84, -414], [92, -436]],
    width: W_WIDE,
    elev: [0, 1, 2, 2],
    green: { at: 414, off: 5, r: 15 },
    water: { at: 270, off: -88, rx: 64, rz: 118 },
    bunkers: [
      ...shoreline({ at: 270, off: -88, rx: 64, rz: 118 }),
      { at: 258, off: 30, rx: 18, rz: 11, rot: 0.2 },
      { at: 396, off: -20, rx: 11, rz: 7, rot: 0.5 },
    ],
    mounds: [{ at: 330, off: 34, r: 24, h: 3.2 }],
  },
  {
    n: 8, name: 'Coral', par: 4, yards: 375,
    path: [[0, 6], [-9, -116], [-24, -238], [-42, -340], [-50, -384]],
    width: W_WIDE,
    elev: [0, -1, -2, -1],
    green: { at: 371, off: -8, r: 15 },
    water: { at: 300, off: 86, rx: 62, rz: 124 },
    bunkers: [
      ...shoreline({ at: 300, off: 86, rx: 62, rz: 124 }),
      { at: 226, off: -24, rx: 12, rz: 8, rot: -0.2 },
      { at: 354, off: 19, rx: 10, rz: 7, rot: 0.3 },
    ],
    mounds: [{ at: 270, off: -30, r: 22, h: 2.8 }],
  },
  {
    n: 9, name: 'Homeward Bay', par: 4, yards: 442,
    path: [[0, 6], [7, -128], [18, -256], [38, -364], [48, -436], [52, -462]],
    width: W_OPEN,
    elev: [0, 2, 4, 6],
    green: { at: 438, off: 5, r: 16 },
    water: { at: 300, off: -94, rx: 72, rz: 140 },
    bunkers: [
      ...shoreline({ at: 300, off: -94, rx: 72, rz: 140 }),
      { at: 268, off: 27, rx: 15, rz: 10, rot: 0.1 },
      { at: 418, off: -20, rx: 11, rz: 7, rot: 0.4 },
      { at: 424, off: 20, rx: 10, rz: 7, rot: -0.4 },
    ],
    mounds: [{ at: 350, off: 34, r: 26, h: 3.8 }],
  },
];

export const COURSES = [
  {
    id: 'augusta',
    name: 'Sunny Links',
    blurb: 'Eighteen holes through the pines. Fast greens, water at the turn.',
    holes: PARKLAND,
    // Multiplies the tree passes in props.js. Parkland is the baseline.
    trees: 1,
  },
  {
    id: 'beach',
    name: 'Palm Cay',
    blurb: 'Nine holes on the shoreline. Palms, sand, and the sea always on one side.',
    holes: BEACH,
    // Palms are thinner than pines and read as clutter in a crowd, so there are
    // fewer of them — but they are what grows here, so the treeline is entirely
    // palm rather than palms mixed into a forest.
    trees: 0.34,
    palms: true,
    shells: true,
    gulls: true,
  },
];

const parOf = (holes) => holes.reduce((s, h) => s + h.par, 0);

// Live bindings. Reassigned by setCourse, and re-read by every importer on
// every access — which is the whole mechanism that makes switching course a
// one-line change rather than a refactor.
export let HOLES = COURSES[0].holes;
export let TOTAL_PAR = parOf(HOLES);
export let COURSE = COURSES[0];

export function setCourse(id) {
  COURSE = COURSES.find((c) => c.id === id) ?? COURSES[0];
  HOLES = COURSE.holes;
  TOTAL_PAR = parOf(HOLES);
  return COURSE;
}
