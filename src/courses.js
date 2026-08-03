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
 * character is how densely it is wooded and how the turf is tinted, which is
 * most of the difference between a course cut through pines and one lying open
 * on the coast.
 */

import { HOLES as PARKLAND } from './holes.js';

const W_OPEN = [30, 28, 26, 25];
const W_WIDE = [26, 25, 23, 22];
const W_NORMAL = [24, 22, 20, 19];

/**
 * The Dunes — nine holes of links.
 *
 * Deliberately not a second parkland course. Wider corridors, far more sand,
 * humps and hollows instead of a steady climb, and greens you can run a ball
 * onto. Playing it should feel like a different sport to the tree-lined one,
 * which is the only reason to have a second course at all.
 */
const DUNES = [
  {
    n: 1, name: 'Sandpiper', par: 4, yards: 402,
    path: [[0, 6], [-4, -120], [-10, -250], [-24, -360], [-32, -412]],
    width: W_OPEN,
    elev: [0, -2, 1, 3],
    green: { at: 398, off: -3, r: 16, squash: 1.2 },
    bunkers: [
      { at: 240, off: -26, rx: 13, rz: 9, rot: 0.2 },
      { at: 262, off: 24, rx: 11, rz: 7, rot: -0.3 },
      { at: 386, off: -22, rx: 10, rz: 7, rot: 0.5 },
    ],
    mounds: [{ at: 300, off: 34, r: 26, h: 4.2 }, { at: 200, off: -38, r: 22, h: 3.6 }],
  },
  {
    n: 2, name: 'Marram', par: 3, yards: 168,
    path: [[0, 6], [2, -80], [4, -166]],
    width: W_WIDE,
    elev: [0, 4, 6],
    green: { at: 165, off: 3, r: 15 },
    bunkers: [
      { at: 150, off: -17, rx: 11, rz: 8, rot: 0.3 },
      { at: 156, off: 18, rx: 10, rz: 7, rot: -0.2 },
      { at: 176, off: 4, rx: 12, rz: 6, rot: 0 },
    ],
    mounds: [{ at: 120, off: 28, r: 20, h: 3.0 }],
  },
  {
    n: 3, name: 'The Cape', par: 5, yards: 528,
    path: [[0, 6], [8, -130], [26, -260], [70, -370], [104, -470], [116, -520]],
    width: W_WIDE,
    elev: [0, -3, -1, 2],
    green: { at: 524, off: 6, r: 16 },
    water: { at: 300, off: 52, rx: 34, rz: 26 },
    bunkers: [
      { at: 270, off: -25, rx: 14, rz: 9, rot: 0.1 },
      { at: 505, off: -21, rx: 11, rz: 7, rot: 0.4 },
    ],
    mounds: [{ at: 420, off: -36, r: 26, h: 4.0 }],
  },
  {
    n: 4, name: 'Bunker Hill', par: 4, yards: 372,
    path: [[0, 6], [-6, -110], [-18, -230], [-30, -330], [-36, -378]],
    width: W_NORMAL,
    elev: [0, 5, 9, 12],
    green: { at: 368, off: -4, r: 15 },
    bunkers: [
      { at: 205, off: -22, rx: 12, rz: 8, rot: 0.2 },
      { at: 225, off: 21, rx: 12, rz: 8, rot: -0.2 },
      { at: 350, off: -20, rx: 10, rz: 7, rot: 0.6 },
      { at: 356, off: 19, rx: 9, rz: 6, rot: -0.5 },
    ],
    mounds: [{ at: 290, off: 30, r: 24, h: 5.0 }],
  },
  {
    n: 5, name: 'Long Strand', par: 5, yards: 561,
    path: [[0, 6], [-2, -140], [-4, -280], [-8, -410], [-12, -520], [-14, -556]],
    width: W_OPEN,
    elev: [0, -4, -6, -3],
    green: { at: 557, off: -2, r: 17, squash: 1.15 },
    bunkers: [
      { at: 250, off: 27, rx: 15, rz: 9, rot: 0 },
      { at: 400, off: -26, rx: 13, rz: 8, rot: 0.3 },
      { at: 540, off: 20, rx: 10, rz: 7, rot: -0.4 },
    ],
    mounds: [{ at: 330, off: -34, r: 28, h: 4.4 }, { at: 470, off: 32, r: 24, h: 3.8 }],
  },
  {
    n: 6, name: 'Gullys', par: 3, yards: 142,
    path: [[0, 6], [-2, -70], [-3, -140]],
    width: W_WIDE,
    elev: [0, -3, -5],
    green: { at: 139, off: -2, r: 14 },
    bunkers: [
      { at: 126, off: -15, rx: 10, rz: 7, rot: 0.4 },
      { at: 130, off: 16, rx: 9, rz: 6, rot: -0.3 },
    ],
    mounds: [{ at: 95, off: 24, r: 18, h: 3.2 }],
  },
  {
    n: 7, name: 'The Elbow', par: 4, yards: 431,
    path: [[0, 6], [4, -120], [12, -240], [56, -340], [88, -420], [98, -448]],
    width: W_NORMAL,
    elev: [0, 2, 5, 4],
    green: { at: 427, off: 5, r: 15 },
    bunkers: [
      { at: 268, off: 28, rx: 14, rz: 9, rot: 0.2 },
      { at: 410, off: -20, rx: 11, rz: 7, rot: 0.5 },
    ],
    mounds: [{ at: 340, off: -34, r: 26, h: 4.6 }],
  },
  {
    n: 8, name: 'Saltmarsh', par: 4, yards: 388,
    path: [[0, 6], [-8, -120], [-22, -245], [-40, -350], [-48, -395]],
    width: W_NORMAL,
    elev: [0, -2, -4, -2],
    green: { at: 384, off: -6, r: 15 },
    water: { at: 330, off: -44, rx: 28, rz: 20 },
    bunkers: [
      { at: 232, off: 24, rx: 12, rz: 8, rot: -0.2 },
      { at: 366, off: 19, rx: 10, rz: 7, rot: 0.3 },
    ],
    mounds: [{ at: 280, off: 30, r: 22, h: 3.4 }],
  },
  {
    n: 9, name: 'Homeward', par: 4, yards: 455,
    path: [[0, 6], [6, -130], [16, -260], [34, -370], [44, -448], [48, -474]],
    width: W_WIDE,
    elev: [0, 3, 7, 10],
    green: { at: 451, off: 4, r: 16 },
    bunkers: [
      { at: 262, off: -26, rx: 13, rz: 9, rot: 0.1 },
      { at: 284, off: 25, rx: 12, rz: 8, rot: -0.3 },
      { at: 432, off: -21, rx: 11, rz: 7, rot: 0.4 },
      { at: 440, off: 20, rx: 10, rz: 7, rot: -0.4 },
    ],
    mounds: [{ at: 360, off: 36, r: 28, h: 5.2 }],
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
    id: 'dunes',
    name: 'The Dunes',
    blurb: 'Nine holes of open links. Wide off the tee, and sand everywhere.',
    holes: DUNES,
    // Barely wooded. A links course with a forest around it is a parkland
    // course with different hole names.
    trees: 0.18,
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
