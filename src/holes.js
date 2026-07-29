/**
 * holes.js — the eighteen.
 *
 * Routings approximated from the course map and published yardages. These are
 * built to *play* like their counterparts — length, dogleg direction, where the
 * sand sits, which side the water is on, how the fairway pinches — rather than
 * to be surveyed reproductions. Anything here is easy to nudge.
 *
 * Features are authored in path-relative terms, because absolute world
 * coordinates are miserable to write and impossible to keep consistent when a
 * centreline moves:
 *
 *   at    yards along the centreline from the tee
 *   off   yards left (-) or right (+) of the centreline at that point
 *
 * course.js resolves them to world positions once the centreline is built.
 */

/** Half-widths sampled evenly from tee to green, in yards. */
const W_WIDE = [26, 25, 23, 22];
const W_NORMAL = [24, 22, 20, 19];
const W_TIGHT = [22, 19, 17, 16];

export const HOLES = [
  {
    n: 1, name: 'Tea Olive', par: 4, yards: 445,
    // Uphill, bending right; a bunker eats the right side of the drive zone.
    path: [[0, 6], [0, -110], [2, -230], [22, -330], [48, -420], [60, -468]],
    width: W_NORMAL,
    green: { at: 442, off: 2, r: 15 },
    bunkers: [
      { at: 300, off: 26, rx: 15, rz: 8, rot: 0.1 },
      { at: 430, off: -21, rx: 10, rz: 6.5, rot: 0.4 },
      { at: 452, off: 20, rx: 9, rz: 6, rot: -0.3 },
    ],
    mounds: [{ at: 470, off: 34, r: 24, h: 3.4 }],
  },
  {
    n: 2, name: 'Pink Dogwood', par: 5, yards: 575,
    // Long, downhill, swinging left. Reachable, with sand guarding both sides.
    path: [[0, 6], [-2, -120], [-6, -250], [-46, -370], [-92, -480], [-114, -558]],
    width: W_WIDE,
    green: { at: 572, off: 0, r: 16 },
    bunkers: [
      { at: 290, off: -28, rx: 16, rz: 9, rot: -0.2 },
      { at: 500, off: 24, rx: 12, rz: 7, rot: 0.3 },
      { at: 558, off: -22, rx: 11, rz: 7, rot: -0.35 },
      { at: 590, off: 18, rx: 9, rz: 6, rot: 0.2 },
    ],
    mounds: [{ at: 600, off: -32, r: 26, h: 3.8 }],
  },
  {
    n: 3, name: 'Flowering Peach', par: 4, yards: 350,
    // Short and drivable, defended by a cluster of sand up the left.
    path: [[0, 6], [-2, -80], [-6, -160], [-40, -240], [-72, -310], [-86, -350]],
    width: W_TIGHT,
    green: { at: 348, off: 0, r: 14 },
    bunkers: [
      { at: 210, off: -24, rx: 13, rz: 7.5, rot: -0.15 },
      { at: 245, off: -27, rx: 11, rz: 7, rot: -0.1 },
      { at: 336, off: 19, rx: 9, rz: 6, rot: 0.3 },
    ],
    mounds: [{ at: 360, off: -26, r: 22, h: 3.0 }],
  },
  {
    n: 4, name: 'Flowering Crab Apple', par: 3, yards: 240,
    // A brutally long one-shotter to a green pinched by two bunkers.
    path: [[0, 6], [-2, -80], [-4, -170], [-5, -265]],
    width: W_NORMAL,
    green: { at: 238, off: 0, r: 15 },
    bunkers: [
      { at: 222, off: -18, rx: 12, rz: 7, rot: -0.3 },
      { at: 248, off: 17, rx: 10, rz: 6.5, rot: 0.25 },
    ],
    mounds: [{ at: 262, off: -24, r: 20, h: 2.8 }],
  },
  {
    n: 5, name: 'Magnolia', par: 4, yards: 495,
    // Uphill dogleg left over two deep fairway bunkers.
    path: [[0, 6], [-4, -120], [-10, -240], [-54, -350], [-100, -455], [-120, -520]],
    width: W_TIGHT,
    green: { at: 492, off: 0, r: 15 },
    bunkers: [
      { at: 280, off: -26, rx: 16, rz: 9, rot: -0.25 },
      { at: 320, off: -28, rx: 14, rz: 8, rot: -0.2 },
      { at: 512, off: 20, rx: 10, rz: 6.5, rot: 0.3 },
    ],
    mounds: [{ at: 520, off: -28, r: 24, h: 3.6 }],
  },
  {
    n: 6, name: 'Juniper', par: 3, yards: 180,
    // Steeply downhill to a green shelved above a single bunker.
    path: [[0, 6], [4, -70], [8, -140], [10, -215]],
    width: W_NORMAL,
    green: { at: 178, off: 0, r: 15 },
    bunkers: [{ at: 164, off: -17, rx: 12, rz: 7, rot: -0.35 }],
    mounds: [{ at: 196, off: 22, r: 20, h: 3.2 }],
  },
  {
    n: 7, name: 'Pampas', par: 4, yards: 450,
    // A narrow chute of pines to a small green ringed with sand.
    path: [[0, 6], [2, -110], [6, -230], [24, -340], [44, -440], [54, -492]],
    width: [19, 17, 16, 15],
    green: { at: 448, off: 0, r: 14 },
    bunkers: [
      { at: 432, off: -19, rx: 10, rz: 6, rot: -0.3 },
      { at: 436, off: 19, rx: 10, rz: 6, rot: 0.3 },
      { at: 468, off: -16, rx: 9, rz: 5.5, rot: 0.2 },
      { at: 470, off: 16, rx: 9, rz: 5.5, rot: -0.2 },
    ],
    mounds: [],
  },
  {
    n: 8, name: 'Yellow Jasmine', par: 5, yards: 570,
    // Uphill and right, its green guarded by mounding rather than bunkers.
    path: [[0, 6], [4, -120], [10, -250], [58, -365], [106, -470], [128, -545]],
    width: W_WIDE,
    green: { at: 568, off: 0, r: 16 },
    bunkers: [{ at: 300, off: 27, rx: 17, rz: 9, rot: 0.2 }],
    mounds: [
      { at: 548, off: -24, r: 20, h: 4.0 },
      { at: 580, off: -26, r: 22, h: 4.4 },
      { at: 596, off: 24, r: 20, h: 3.6 },
    ],
  },
  {
    n: 9, name: 'Carolina Cherry', par: 4, yards: 460,
    // Downhill off the tee, then sharply back up to a green that repels.
    path: [[0, 6], [-2, -110], [-8, -230], [-48, -335], [-88, -430], [-106, -488]],
    width: W_NORMAL,
    green: { at: 458, off: 0, r: 15 },
    bunkers: [
      { at: 300, off: -26, rx: 14, rz: 8, rot: -0.2 },
      { at: 442, off: -20, rx: 11, rz: 7, rot: -0.3 },
    ],
    mounds: [{ at: 480, off: 24, r: 22, h: 3.4 }],
  },
  {
    n: 10, name: 'Camellia', par: 4, yards: 495,
    // A long, plunging dogleg left; one big bunker short-left of the green.
    path: [[0, 6], [-6, -110], [-16, -230], [-78, -330], [-140, -425], [-170, -482]],
    width: W_WIDE,
    green: { at: 492, off: 0, r: 15 },
    bunkers: [{ at: 470, off: -22, rx: 15, rz: 8.5, rot: -0.3 }],
    mounds: [{ at: 516, off: 26, r: 24, h: 3.8 }],
  },
  {
    n: 11, name: 'White Dogwood', par: 4, yards: 520,
    // Amen Corner begins: downhill, and a pond hard against the left of a
    // green that gives you all the room in the world to bail out right.
    path: [[0, 6], [-4, -120], [-12, -250], [-54, -365], [-96, -470], [-118, -540]],
    width: W_NORMAL,
    green: { at: 518, off: 0, r: 15 },
    bunkers: [{ at: 536, off: 20, rx: 11, rz: 7, rot: 0.25 }],
    water: { at: 512, off: -30, rx: 22, rz: 17 },
    mounds: [{ at: 546, off: 26, r: 22, h: 3.2 }],
  },
  {
    n: 12, name: 'Golden Bell', par: 3, yards: 155,
    // The most famous short hole in golf: a creek across the front, a wide
    // shallow green set on the diagonal, sand front and back.
    path: [[0, 6], [2, -60], [4, -120], [5, -180]],
    width: W_NORMAL,
    green: { at: 154, off: 0, r: 13, squash: 0.55, angle: 0.38 },
    bunkers: [
      { at: 138, off: 0, rx: 13, rz: 5.5, rot: 0.38 },
      { at: 172, off: -12, rx: 8, rz: 5, rot: 0.38 },
      { at: 174, off: 12, rx: 8, rz: 5, rot: 0.38 },
    ],
    water: { at: 116, off: 0, rx: 34, rz: 9, rot: 0.30 },
    mounds: [{ at: 186, off: 0, r: 26, h: 4.6 }],
  },
  {
    n: 13, name: 'Azalea', par: 5, yards: 545,
    // Sharp dogleg left around the creek, which then runs across the front of
    // the green. The whole hole is a decision about how much you'll risk.
    path: [[0, 6], [-6, -110], [-18, -230], [-100, -330], [-186, -422], [-238, -474]],
    width: W_WIDE,
    green: { at: 542, off: 0, r: 16 },
    bunkers: [
      { at: 566, off: -18, rx: 10, rz: 6, rot: -0.2 },
      { at: 572, off: 2, rx: 10, rz: 6, rot: 0.1 },
      { at: 570, off: 20, rx: 9, rz: 6, rot: 0.3 },
    ],
    water: { at: 522, off: -26, rx: 26, rz: 13, rot: -0.35 },
    mounds: [{ at: 590, off: 24, r: 24, h: 3.6 }],
  },
  {
    n: 14, name: 'Chinese Fir', par: 4, yards: 440,
    // Not a grain of sand anywhere on it. All the defence is in the ground.
    path: [[0, 6], [-4, -110], [-10, -230], [-46, -325], [-84, -412], [-100, -460]],
    width: W_WIDE,
    green: { at: 438, off: 0, r: 16 },
    bunkers: [],
    mounds: [
      { at: 424, off: -20, r: 20, h: 3.4 },
      { at: 452, off: 20, r: 20, h: 3.0 },
      { at: 462, off: -16, r: 18, h: 2.6 },
    ],
  },
  {
    n: 15, name: 'Firethorn', par: 5, yards: 550,
    // Reachable in two, over a pond that sits right against the front edge.
    path: [[0, 6], [-2, -120], [-6, -250], [-30, -370], [-56, -488], [-70, -556]],
    width: W_WIDE,
    green: { at: 548, off: 0, r: 15 },
    bunkers: [{ at: 566, off: 20, rx: 10, rz: 6.5, rot: 0.3 }],
    water: { at: 520, off: 0, rx: 26, rz: 11, rot: 0.05 },
    mounds: [{ at: 578, off: -24, r: 22, h: 3.4 }],
  },
  {
    n: 16, name: 'Redbud', par: 3, yards: 170,
    // Water the whole way. The green kicks anything left of centre toward
    // the hole, which is why you see so many aces here.
    path: [[0, 6], [-2, -60], [-4, -125], [-5, -195]],
    width: W_NORMAL,
    green: { at: 168, off: 0, r: 15 },
    bunkers: [
      { at: 156, off: 18, rx: 10, rz: 6, rot: 0.3 },
      { at: 186, off: 16, rx: 9, rz: 5.5, rot: -0.2 },
    ],
    water: { at: 96, off: -6, rx: 30, rz: 30 },
    mounds: [{ at: 196, off: -22, r: 22, h: 3.6 }],
  },
  {
    n: 17, name: 'Nandina', par: 4, yards: 440,
    // Uphill, tight off the tee, to a shallow green that falls away behind.
    path: [[0, 6], [2, -110], [8, -230], [36, -328], [64, -415], [78, -468]],
    width: W_TIGHT,
    green: { at: 438, off: 0, r: 14 },
    bunkers: [
      { at: 424, off: -18, rx: 11, rz: 6.5, rot: -0.3 },
      { at: 452, off: 17, rx: 9, rz: 6, rot: 0.2 },
    ],
    mounds: [{ at: 462, off: -22, r: 20, h: 3.0 }],
  },
  {
    n: 18, name: 'Holly', par: 4, yards: 465,
    // A narrow chute of pines off the tee, then hard uphill and right, with
    // two bunkers cut into the left of the drive zone.
    path: [[0, 6], [2, -110], [8, -230], [58, -328], [108, -415], [130, -470]],
    width: [18, 17, 19, 18],
    green: { at: 462, off: 0, r: 15 },
    bunkers: [
      { at: 292, off: -24, rx: 14, rz: 8, rot: -0.25 },
      { at: 318, off: -26, rx: 12, rz: 7.5, rot: -0.2 },
      { at: 444, off: -19, rx: 10, rz: 6.5, rot: -0.3 },
      { at: 478, off: 18, rx: 9, rz: 6, rot: 0.25 },
    ],
    mounds: [{ at: 494, off: 26, r: 24, h: 4.0 }],
  },
];

export const TOTAL_PAR = HOLES.reduce((s, h) => s + h.par, 0);
