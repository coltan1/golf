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
 * Palm Cay — nine holes on a clifftop, above the sea.
 *
 * The sea is not a hazard laid into the ground. It is thirty yards below the
 * course, past a lava cliff, and it runs to the horizon. Each hole declares a
 * `shore`: which side the water is on, and how far off the centreline the
 * cliff top sits at each point along the hole. Everything else — the drop, the
 * rock, the splash, the horizon left open — follows from that in course.js.
 *
 * Because the shore is a curve rather than a distance, it can cut across the
 * line of play. That is what makes The Cove and Little Bay: the cliff swings
 * inland far enough to swallow the corridor, and the shot is a carry over open
 * water with nothing underneath it.
 *
 * Bunkering is deliberately sparse and large. On a course where the trouble is
 * a cliff, a scattering of small pot bunkers is noise; two or three big flowing
 * ones short and inland of each green is what these holes actually have.
 */
const SEA = -30;

const BEACH = [
  {
    n: 1, name: 'Kiawe Ridge', par: 4, yards: 396,
    path: [[0, 6], [-4, -112], [-10, -242], [-18, -352], [-22, -402]],
    width: W_OPEN,
    elev: [0, 2, 4, 5],
    green: { at: 392, off: -6, r: 16, squash: 1.15 },
    // Opens wide off the tee and tightens all the way in, so the last shot is
    // the one played hard against the edge.
    shore: { side: 1, y: SEA, off: [[0, 86], [180, 66], [330, 46], [402, 38]] },
    bunkers: [
      { at: 252, off: 30, rx: 24, rz: 15, rot: 0.16 },
      { at: 368, off: -24, rx: 17, rz: 12, rot: 0.42 },
    ],
    mounds: [{ at: 300, off: -38, r: 26, h: 3.4 }],
  },
  {
    n: 2, name: 'The Cove', par: 3, yards: 176,
    path: [[0, 6], [3, -86], [6, -174]],
    width: W_WIDE,
    elev: [0, 1, 2],
    green: { at: 172, off: 4, r: 15 },
    // The cliff swings right across the hole between tee and green. There is
    // no ground at all for a hundred yards of it.
    shore: { side: 1, y: SEA,
             off: [[0, 74], [40, 40], [70, -46], [130, -44], [156, 34], [200, 62]] },
    bunkers: [
      { at: 166, off: 22, rx: 18, rz: 12, rot: -0.24 },
      { at: 192, off: 2, rx: 20, rz: 10, rot: 0.05 },
    ],
    mounds: [{ at: 190, off: -26, r: 20, h: 3.0 }],
  },
  {
    n: 3, name: 'Windward', par: 5, yards: 546,
    path: [[0, 6], [-6, -132], [-20, -266], [-56, -378], [-88, -478], [-98, -534]],
    width: W_WIDE,
    elev: [0, -2, 0, 3],
    green: { at: 542, off: -6, r: 16 },
    shore: { side: -1, y: SEA, off: [[0, -60], [220, -44], [400, -50], [546, -40]] },
    bunkers: [
      { at: 286, off: 28, rx: 22, rz: 14, rot: 0.1 },
      { at: 516, off: 24, rx: 18, rz: 12, rot: -0.38 },
    ],
    mounds: [{ at: 420, off: 36, r: 28, h: 4.0 }],
  },
  {
    n: 4, name: 'Lava Point', par: 4, yards: 362,
    path: [[0, 6], [-8, -110], [-22, -230], [-34, -326], [-40, -370]],
    width: W_WIDE,
    elev: [0, 4, 7, 8],
    green: { at: 358, off: -8, r: 15 },
    // The green sits out on a point with the drop on two thirds of its circle.
    shore: { side: 1, y: SEA, off: [[0, 72], [200, 52], [320, 30], [370, 22]] },
    bunkers: [
      { at: 214, off: -26, rx: 19, rz: 13, rot: 0.2 },
      { at: 340, off: -26, rx: 16, rz: 11, rot: 0.5 },
    ],
    mounds: [{ at: 288, off: -36, r: 24, h: 4.2 }],
  },
  {
    n: 5, name: 'Long Reach', par: 5, yards: 562,
    path: [[0, 6], [-2, -142], [-5, -282], [-9, -410], [-13, -522], [-15, -558]],
    width: W_OPEN,
    elev: [0, -3, -4, -2],
    green: { at: 558, off: -2, r: 17, squash: 1.15 },
    shore: { side: -1, y: SEA, off: [[0, -96], [260, -72], [440, -56], [562, -44]] },
    bunkers: [
      { at: 268, off: 30, rx: 26, rz: 16, rot: 0 },
      { at: 430, off: 27, rx: 20, rz: 13, rot: 0.3 },
      { at: 540, off: 22, rx: 16, rz: 11, rot: -0.4 },
    ],
    mounds: [{ at: 350, off: 38, r: 28, h: 3.8 }],
  },
  {
    n: 6, name: 'Little Bay', par: 3, yards: 152,
    path: [[0, 6], [-3, -74], [-5, -150]],
    width: W_WIDE,
    elev: [0, 3, 5],
    green: { at: 148, off: -4, r: 14 },
    // A shorter carry than the second, over the corner of a bay rather than
    // across the whole of it — but the green is right on the lip.
    shore: { side: 1, y: SEA,
             off: [[0, 60], [46, 20], [86, -18], [124, 14], [170, 26]] },
    bunkers: [
      { at: 136, off: -20, rx: 16, rz: 11, rot: 0.4 },
      { at: 164, off: -6, rx: 17, rz: 9, rot: 0 },
    ],
    mounds: [{ at: 104, off: -30, r: 20, h: 3.2 }],
  },
  {
    n: 7, name: 'The Bluff', par: 4, yards: 424,
    path: [[0, 6], [6, -120], [16, -242], [58, -342], [88, -420], [96, -442]],
    width: W_WIDE,
    elev: [0, 2, 4, 4],
    green: { at: 420, off: 6, r: 15 },
    // Pinches hard at driving distance, then eases: the tee shot is the one
    // that has to be brave.
    shore: { side: -1, y: SEA,
             off: [[0, -72], [230, -34], [300, -30], [430, -52]] },
    bunkers: [
      { at: 266, off: 30, rx: 22, rz: 14, rot: 0.2 },
      { at: 402, off: 24, rx: 17, rz: 11, rot: 0.5 },
    ],
    mounds: [{ at: 336, off: 36, r: 24, h: 3.4 }],
  },
  {
    n: 8, name: 'Sea Cliff', par: 4, yards: 381,
    path: [[0, 6], [-9, -118], [-24, -240], [-42, -344], [-50, -388]],
    width: W_WIDE,
    elev: [0, -1, -2, 0],
    green: { at: 377, off: -8, r: 15 },
    shore: { side: 1, y: SEA, off: [[0, 66], [190, 40], [300, 34], [388, 44]] },
    bunkers: [
      { at: 236, off: -26, rx: 20, rz: 13, rot: -0.2 },
      { at: 360, off: -24, rx: 15, rz: 11, rot: 0.3 },
    ],
    mounds: [{ at: 280, off: -34, r: 22, h: 3.0 }],
  },
  {
    n: 9, name: 'Homeward Point', par: 4, yards: 448,
    path: [[0, 6], [7, -130], [18, -258], [38, -366], [48, -440], [52, -466]],
    width: W_OPEN,
    elev: [0, 3, 6, 8],
    green: { at: 444, off: 6, r: 16 },
    // Home along the top of the cliff, with the last green on the point.
    shore: { side: -1, y: SEA, off: [[0, -78], [240, -52], [380, -36], [470, -26]] },
    bunkers: [
      { at: 274, off: 28, rx: 23, rz: 15, rot: 0.1 },
      { at: 424, off: 22, rx: 17, rz: 12, rot: 0.4 },
    ],
    mounds: [{ at: 356, off: 34, r: 26, h: 4.0 }],
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
    blurb: 'Nine holes on a clifftop, thirty yards above the sea. Two of them carry it.',
    holes: BEACH,
    // Sparse and windswept. What grows on a headland in this much salt wind is
    // a handful of flat-topped kiawe leaning away from the water, not a forest
    // — and the whole point of the place is the view past them.
    trees: 0.045,
    coastal: true,
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
