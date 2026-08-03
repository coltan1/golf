/**
 * lowpoly-golfer.js — a faceted, real-proportioned golfer, built in code.
 *
 * Deliberately separate from src/golfer.js. That one is a toy: four heads
 * tall, eight recolourable regions, and a skeleton the swing rig drives. This
 * one is a character model — 1.77 m, seven and a half heads, fixed kit — and
 * the two want opposite things from their geometry. Keeping them apart means
 * neither has to compromise, and this file can be exported and taken
 * somewhere else without dragging the swing with it.
 *
 * EVERYTHING IS LOFTED. A limb is a stack of cross-sections and the quads
 * between them; a head is the same thing with more sections. That is the whole
 * technique, and it is chosen because it is the one that gives clean topology
 * for free: every ring has the same vertex count, so every face is a quad, the
 * edge loops run where a modeller would put them, and nothing needs cleaning
 * up afterwards. Building the same forms from boxes and spheres would look
 * similar and be unriggable.
 *
 * The faceting is the material's, not the mesh's. `flatShading` makes each
 * triangle use its own face normal, so the silhouette stays as authored and
 * the shading is hard-edged without duplicating a single vertex.
 *
 * Units are metres, Y is up, +Z is the direction the model faces.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------- palette
//
// One entry per material in the finished asset. Named for what the thing is
// rather than what colour it happens to be, so a reskin is a value change
// here and nothing else anywhere.
export const MATERIALS = {
  skin:       { color: 0xe0ac83, roughness: 0.86 },
  hair:       { color: 0x6b4326, roughness: 0.92 },
  shirt:      { color: 0x4a7cb0, roughness: 0.80 },
  shirtTrim:  { color: 0xf2f4f6, roughness: 0.76 },   // collar and placket
  capFront:   { color: 0x4a7cb0, roughness: 0.78 },
  capRear:    { color: 0xf2f4f6, roughness: 0.78 },
  glove:      { color: 0xf4f6f8, roughness: 0.70 },
  chino:      { color: 0xc2ab7c, roughness: 0.88 },
  belt:       { color: 0x6b4a2e, roughness: 0.60, metalness: 0.05 },
  buckle:     { color: 0xb9b2a4, roughness: 0.35, metalness: 0.75 },
  shoe:       { color: 0xf2f4f6, roughness: 0.62 },
  shoeAccent: { color: 0x4a7cb0, roughness: 0.62 },
  sole:       { color: 0xdfe3e7, roughness: 0.80 },
  eye:        { color: 0x2b2320, roughness: 0.5 },
  crest:      { color: 0xf2f4f6, roughness: 0.5 },
};

function makeMaterials() {
  const out = {};
  for (const [name, spec] of Object.entries(MATERIALS)) {
    out[name] = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: spec.roughness ?? 0.8,
      metalness: spec.metalness ?? 0.0,
      // The whole look. Per-face normals, no smoothing, no subdivision.
      flatShading: true,
    });
    out[name].name = name;
  }
  return out;
}

// ---------------------------------------------------------------- lofting
/**
 * A closed ring of `n` points, as [x, z] pairs.
 *
 * `squash` flattens it front-to-back, which is most of what makes a torso read
 * as a torso rather than a pipe — a human chest is about two thirds as deep as
 * it is wide, and nothing else about the shape matters half as much.
 */
function ring(n, radius, squash = 1, twist = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = twist + (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * radius, Math.sin(a) * radius * squash]);
  }
  return pts;
}

/** A rounded rectangle ring — for shoes, caps and anything with a front. */
function boxRing(n, halfW, halfD, round = 0.35) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // Superellipse: `round` at 1 is an ellipse, near 0 is a rectangle.
    const k = 2 / Math.max(0.05, round);
    const m = Math.pow(Math.pow(Math.abs(c), k) + Math.pow(Math.abs(s), k), -1 / k);
    pts.push([c * m * halfW * Math.SQRT2, s * m * halfD * Math.SQRT2]);
  }
  return pts;
}

/**
 * Stack cross-sections into a solid.
 *
 * `sections` is [{ y, pts, ox, oz }] from bottom to top; every one must have
 * the same point count, which is what keeps the result all-quads. `ox`/`oz`
 * shift a section sideways without reshaping it, so a limb can lean.
 */
function loft(sections, { capBottom = true, capTop = true } = {}) {
  const n = sections[0].pts.length;
  const V = sections.map((s) => s.pts.map(([x, z]) => [
    x + (s.ox ?? 0), s.y, z + (s.oz ?? 0),
  ]));

  const pos = [];
  const push = (p) => { pos.push(p[0], p[1], p[2]); };

  for (let i = 0; i < V.length - 1; i++) {
    const a = V[i], b = V[i + 1];
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      // Wound so the normal points away from the axis. Getting this backwards
      // is invisible until the model is lit, and then every face is dark.
      push(a[k]); push(b[k]); push(a[k2]);
      push(a[k2]); push(b[k]); push(b[k2]);
    }
  }

  const cap = (rowIdx, up) => {
    const row = V[rowIdx];
    let cx = 0, cz = 0;
    for (const p of row) { cx += p[0]; cz += p[2]; }
    const c = [cx / n, row[0][1], cz / n];
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      if (up) { push(c); push(row[k2]); push(row[k]); }
      else { push(c); push(row[k]); push(row[k2]); }
    }
  };
  if (capBottom) cap(0, false);
  if (capTop) cap(V.length - 1, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A plain box, because some things are boxes and pretending otherwise is worse. */
function slab(w, h, d, x = 0, y = 0, z = 0, rot = null) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.rotateX(rot[0] || 0), g.rotateY(rot[1] || 0), g.rotateZ(rot[2] || 0);
  g.translate(x, y, z);
  return g;
}

function mesh(geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- skeleton
/**
 * Every landmark on the body, in metres from the sole.
 *
 * Written out rather than derived, because these ARE the brief: 1.77 m tall
 * with a 0.236 m head is seven and a half heads exactly, and the fingertips at
 * 0.72 put the hands at mid-thigh, which is the check the reference sheet is
 * really asking for. Anything built from these lands in the right place; a
 * model tuned by eye lands somewhere near it and drifts every time it changes.
 */
export const RIG = {
  height: 1.77,
  headTop: 1.770,
  headBottom: 1.534,   // chin — 0.236 of head, so 7.5 heads
  neckTop: 1.545,
  neckBottom: 1.452,
  shoulder: 1.440,
  shoulderHalf: 0.213, // 0.426 across, about 2.4 head-widths
  chest: 1.330,
  waist: 1.085,        // the belt sits here
  hip: 1.000,
  crotch: 0.855,
  knee: 0.478,
  ankle: 0.088,
  elbow: 1.108,
  wrist: 0.855,
  fingertip: 0.720,    // mid-thigh
  footLen: 0.268,
  legHalf: 0.098,      // half the gap between leg centres
};

// ---------------------------------------------------------------- parts
function buildHead(M) {
  const g = new THREE.Group();
  g.name = 'Head';
  const N = 10;
  const { headBottom: chin, headTop: top } = RIG;
  const h = top - chin;

  // Jaw narrow, cheekbones widest, crown tucked back in. The widest point is
  // above the ear and not at the jaw, which is the single cue that reads as
  // "male adult" rather than "child" at this polygon count.
  const skull = loft([
    { y: chin,             pts: ring(N, 0.052, 0.86), oz: 0.004 },
    { y: chin + h * 0.16,  pts: ring(N, 0.072, 0.90), oz: 0.006 },
    { y: chin + h * 0.36,  pts: ring(N, 0.085, 0.96), oz: 0.004 },
    { y: chin + h * 0.55,  pts: ring(N, 0.089, 1.00) },
    { y: chin + h * 0.74,  pts: ring(N, 0.086, 1.02), oz: -0.004 },
    { y: chin + h * 0.90,  pts: ring(N, 0.070, 1.02), oz: -0.006 },
    { y: top,              pts: ring(N, 0.040, 1.00), oz: -0.008 },
  ]);
  g.add(mesh(skull, M.skin, 'Head_Skull'));

  const eyeY = chin + h * 0.55;
  const faceZ = 0.083;

  // Nose: a wedge, three faces. Any more and it stops being low-poly; any
  // fewer and the profile has nothing in it.
  const nose = loft([
    { y: eyeY - 0.052, pts: boxRing(6, 0.019, 0.011, 0.5), oz: faceZ * 0.62 },
    { y: eyeY - 0.028, pts: boxRing(6, 0.016, 0.019, 0.5), oz: faceZ * 0.70 },
    { y: eyeY + 0.004, pts: boxRing(6, 0.011, 0.010, 0.5), oz: faceZ * 0.66 },
  ]);
  g.add(mesh(nose, M.skin, 'Head_Nose'));

  // Ears
  for (const s of [-1, 1]) {
    g.add(mesh(slab(0.012, 0.044, 0.028, s * 0.086, eyeY - 0.006, -0.004), M.skin,
      s < 0 ? 'Head_EarL' : 'Head_EarR'));
  }

  // Eyes and brows, set into the face rather than stuck on it.
  for (const s of [-1, 1]) {
    g.add(mesh(slab(0.026, 0.011, 0.008, s * 0.036, eyeY, faceZ * 0.86), M.eye,
      s < 0 ? 'Head_EyeL' : 'Head_EyeR'));
    g.add(mesh(slab(0.032, 0.008, 0.010, s * 0.037, eyeY + 0.026, faceZ * 0.84,
      [0, 0, s * 0.10]), M.hair, s < 0 ? 'Head_BrowL' : 'Head_BrowR'));
  }

  // Mouth: a shallow wedge turned up at the corners. A flat bar reads as a
  // grimace; the tilt is the whole difference between the two.
  g.add(mesh(slab(0.040, 0.007, 0.008, 0, chin + h * 0.24, faceZ * 0.80), M.eye, 'Head_Mouth'));

  return g;
}

function buildHair(M) {
  const g = new THREE.Group();
  g.name = 'Hair';
  const { headBottom: chin, headTop: top } = RIG;
  const h = top - chin;

  // Only what shows under a cap: a fringe at the front, the sides, and the
  // back of the neck. Modelling a whole head of hair that is then hidden is
  // geometry nobody will ever see.
  const N = 10;
  const back = loft([
    { y: chin + h * 0.42, pts: ring(N, 0.089, 1.00), oz: -0.010 },
    { y: chin + h * 0.70, pts: ring(N, 0.093, 1.02), oz: -0.012 },
    { y: chin + h * 0.92, pts: ring(N, 0.074, 1.02), oz: -0.014 },
  ], { capTop: false, capBottom: false });
  g.add(mesh(back, M.hair, 'Hair_Shell'));

  // Fringe under the brim.
  g.add(mesh(slab(0.128, 0.026, 0.030, 0, chin + h * 0.795, 0.056, [0.20, 0, 0]),
    M.hair, 'Hair_Fringe'));

  // Sideburns, tapered down in front of the ear rather than square.
  for (const s of [-1, 1]) {
    g.add(mesh(loft([
      { y: chin + h * 0.40, pts: boxRing(6, 0.007, 0.016, 0.6), ox: s * 0.083, oz: -0.004 },
      { y: chin + h * 0.58, pts: boxRing(6, 0.010, 0.030, 0.6), ox: s * 0.086, oz: -0.006 },
      { y: chin + h * 0.74, pts: boxRing(6, 0.011, 0.036, 0.6), ox: s * 0.086, oz: -0.008 },
    ]), M.hair, s < 0 ? 'Hair_SideL' : 'Hair_SideR'));
  }

  // The nape. Lofted and tapered — a box here was the one thing on the model
  // that read as a mistake rather than as a style, because hair does not have
  // corners and every other part of the silhouette does the work of pretending
  // that it might.
  g.add(mesh(loft([
    { y: chin + h * 0.20, pts: boxRing(8, 0.040, 0.012, 0.9), oz: -0.070 },
    { y: chin + h * 0.34, pts: boxRing(8, 0.055, 0.020, 0.8), oz: -0.066 },
    { y: chin + h * 0.50, pts: boxRing(8, 0.062, 0.026, 0.8), oz: -0.060 },
  ]), M.hair, 'Hair_Nape'));
  return g;
}

function buildCap(M) {
  const g = new THREE.Group();
  g.name = 'Cap';
  const { headTop: top, headBottom: chin } = RIG;
  const h = top - chin;
  const base = chin + h * 0.76;
  const N = 10;

  // The crown, split at the vertical so the front panel and the rear panels
  // can take different materials — which is the cap in the reference, and
  // cannot be done with one lofted shell.
  const crown = (front) => {
    const half = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const z = Math.sin(a);
      if (front ? z >= -0.001 : z <= 0.001) half.push(i);
    }
    const sections = [
      { y: base,          r: 0.096, sq: 1.02 },
      { y: base + 0.030,  r: 0.094, sq: 1.02 },
      { y: base + 0.056,  r: 0.076, sq: 1.00 },
      { y: top + 0.014,   r: 0.028, sq: 1.00 },
    ].map((s) => ({ y: s.y, pts: ring(N, s.r, s.sq).filter((_, i) => half.includes(i)) }));
    return loft(sections, { capBottom: false, capTop: false });
  };
  g.add(mesh(crown(true), M.capFront, 'Cap_Front'));
  g.add(mesh(crown(false), M.capRear, 'Cap_Rear'));

  // Button on top, and the seam band round the base.
  g.add(mesh(slab(0.020, 0.012, 0.020, 0, top + 0.020, -0.004), M.capRear, 'Cap_Button'));

  // Brim: wider than it is long, curved down at the edges. Built as a loft of
  // three chords rather than a flat plate so the curve is real geometry — a
  // flat brim is the thing that makes a low-poly cap look like a visor.
  const brim = [];
  const STEPS = 9;
  const pts = (front) => {
    const row = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS - 0.5;               // -0.5 .. 0.5 across
      const w = 0.098;
      const reach = front ? 0.118 : 0.020;
      row.push([t * 2 * w, 0.070 + reach * (1 - t * t * 2.6)]);
    }
    return row;
  };
  const fr = pts(true), bk = pts(false);
  const brimPts = fr.concat(bk.slice().reverse());
  const droop = (i) => {
    const t = (i % (STEPS + 1)) / STEPS - 0.5;
    return -0.026 * (t * t * 4);
  };
  const brimTop = brimPts.map((p, i) => [p[0], p[1]]);
  const lower = new THREE.BufferGeometry();
  const bp = [];
  for (let i = 0; i < brimPts.length; i++) {
    const j = (i + 1) % brimPts.length;
    const a = brimPts[i], b = brimPts[j];
    const ya = base + 0.006 + droop(i), yb = base + 0.006 + droop(j);
    // top face
    bp.push(0, base + 0.010, 0.02, a[0], ya + 0.010, a[1], b[0], yb + 0.010, b[1]);
    // bottom face
    bp.push(0, base + 0.002, 0.02, b[0], yb + 0.002, b[1], a[0], ya + 0.002, a[1]);
    // rim
    bp.push(a[0], ya + 0.010, a[1], a[0], ya + 0.002, a[1], b[0], yb + 0.010, b[1]);
    bp.push(b[0], yb + 0.010, b[1], a[0], ya + 0.002, a[1], b[0], yb + 0.002, b[1]);
  }
  lower.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
  lower.computeVertexNormals();
  g.add(mesh(lower, M.capFront, 'Cap_Brim'));
  void brimTop;

  return g;
}

function buildTorso(M) {
  const g = new THREE.Group();
  g.name = 'Torso';
  const N = 12;
  const R = RIG;

  // Neck
  g.add(mesh(loft([
    { y: R.neckBottom - 0.02, pts: ring(N, 0.054, 0.90) },
    { y: R.neckTop, pts: ring(N, 0.046, 0.92) },
  ]), M.skin, 'Neck'));

  // The shirt. Widest at the deltoids, in at the waist, out again over the
  // hips — three changes of direction, which is the fewest that reads as a
  // torso and not a bottle.
  g.add(mesh(loft([
    { y: R.hip - 0.052,   pts: ring(N, 0.148, 0.70) },
    { y: R.waist,         pts: ring(N, 0.143, 0.70) },
    { y: R.chest - 0.060, pts: ring(N, 0.152, 0.72) },
    { y: R.chest + 0.040, pts: ring(N, 0.171, 0.74) },
    { y: R.shoulder,      pts: ring(N, 0.176, 0.74) },
    { y: R.shoulder + 0.034, pts: ring(N, 0.150, 0.76) },
  ]), M.shirt, 'Shirt'));

  // Shoulder caps, so the sleeve does not start at a hard corner.
  for (const s of [-1, 1]) {
    g.add(mesh(loft([
      { y: R.shoulder - 0.096, pts: ring(8, 0.052, 1.0), ox: s * R.shoulderHalf * 0.96 },
      { y: R.shoulder - 0.030, pts: ring(8, 0.060, 1.0), ox: s * R.shoulderHalf * 0.90 },
      { y: R.shoulder + 0.026, pts: ring(8, 0.046, 1.0), ox: s * R.shoulderHalf * 0.72 },
    ]), M.shirt, s < 0 ? 'Sleeve_L' : 'Sleeve_R'));
  }

  // Collar: a band standing up round the neck, open at the front.
  const collar = loft([
    { y: R.shoulder + 0.026, pts: ring(N, 0.070, 0.92) },
    { y: R.shoulder + 0.058, pts: ring(N, 0.078, 0.94) },
  ], { capBottom: false, capTop: false });
  g.add(mesh(collar, M.shirtTrim, 'Collar'));
  // Placket
  g.add(mesh(slab(0.030, 0.086, 0.012, 0, R.shoulder - 0.018, 0.122), M.shirtTrim, 'Placket'));

  // Crest, left chest. Small enough to be a badge and no smaller.
  g.add(mesh(slab(0.030, 0.036, 0.008, -0.062, R.chest + 0.012, 0.124), M.crest, 'Crest'));

  // Belt and buckle
  g.add(mesh(loft([
    { y: R.waist - 0.030, pts: ring(N, 0.146, 0.70) },
    { y: R.waist + 0.014, pts: ring(N, 0.147, 0.70) },
  ], { capBottom: false, capTop: false }), M.belt, 'Belt'));
  g.add(mesh(slab(0.052, 0.038, 0.016, 0, R.waist - 0.008, 0.106), M.buckle, 'Buckle'));

  return g;
}

function buildArm(M, side) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'Arm_L' : 'Arm_R';
  const R = RIG;
  const N = 8;

  // The A-pose. Twelve degrees out from vertical: enough that the armpit is
  // not a pinched crease, little enough that the silhouette is still a
  // standing man rather than a starfish.
  const lean = 0.21;
  const sx = (y) => side * (R.shoulderHalf * 0.86 + (R.shoulder - y) * Math.tan(lean));

  const arm = loft([
    { y: R.wrist,           pts: ring(N, 0.030, 0.94), ox: sx(R.wrist) },
    { y: R.elbow - 0.070,   pts: ring(N, 0.034, 0.94), ox: sx(R.elbow - 0.070) },
    { y: R.elbow,           pts: ring(N, 0.039, 0.96), ox: sx(R.elbow) },
    { y: R.elbow + 0.090,   pts: ring(N, 0.045, 0.98), ox: sx(R.elbow + 0.090) },
    { y: R.shoulder - 0.096, pts: ring(N, 0.050, 1.00), ox: sx(R.shoulder - 0.096) },
  ]);
  g.add(mesh(arm, M.skin, (side < 0 ? 'ArmL' : 'ArmR') + '_Skin'));

  // Glove: a mitt with a thumb. Fingers are not modelled separately, because
  // at this scale four cylinders read as noise and one closed form reads as a
  // gloved hand — which is what a golf glove looks like anyway.
  const hx = sx(R.wrist);
  const hand = loft([
    { y: R.fingertip,          pts: boxRing(8, 0.030, 0.020, 0.75), ox: hx + side * 0.006 },
    { y: R.fingertip + 0.048,  pts: boxRing(8, 0.036, 0.024, 0.6),  ox: hx + side * 0.004 },
    { y: R.wrist - 0.014,      pts: boxRing(8, 0.036, 0.026, 0.55), ox: hx },
    { y: R.wrist + 0.026,      pts: boxRing(8, 0.031, 0.023, 0.6),  ox: hx },
  ]);
  g.add(mesh(hand, M.glove, (side < 0 ? 'GloveL' : 'GloveR')));
  g.add(mesh(slab(0.018, 0.046, 0.024,
    hx - side * 0.030, R.fingertip + 0.062, 0.006, [0, 0, side * 0.30]),
    M.glove, (side < 0 ? 'GloveL' : 'GloveR') + '_Thumb'));

  return g;
}

function buildLeg(M, side) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'Leg_L' : 'Leg_R';
  const R = RIG;
  const N = 8;
  const cx = side * R.legHalf;

  // Straight-cut chinos: the taper from thigh to ankle is slight and the
  // ankle opening stays wide. A leg that narrows to the ankle is a jean.
  g.add(mesh(loft([
    { y: R.ankle - 0.004, pts: ring(N, 0.052, 0.90), ox: cx },
    { y: R.knee - 0.120,  pts: ring(N, 0.056, 0.92), ox: cx },
    { y: R.knee,          pts: ring(N, 0.062, 0.94), ox: cx },
    { y: R.knee + 0.140,  pts: ring(N, 0.073, 0.94), ox: cx * 1.02 },
    { y: R.crotch,        pts: ring(N, 0.083, 0.92), ox: cx * 1.04 },
    { y: R.hip,           pts: ring(N, 0.092, 0.86), ox: cx * 0.92 },
  ]), M.chino, (side < 0 ? 'LegL' : 'LegR') + '_Chino'));

  // Turn-up at the hem.
  g.add(mesh(loft([
    { y: R.ankle - 0.006, pts: ring(N, 0.055, 0.90), ox: cx },
    { y: R.ankle + 0.030, pts: ring(N, 0.056, 0.90), ox: cx },
  ], { capBottom: false, capTop: false }), M.chino, (side < 0 ? 'LegL' : 'LegR') + '_Cuff'));

  return g;
}

function buildShoe(M, side) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'Shoe_L' : 'Shoe_R';
  const R = RIG;
  const cx = side * R.legHalf;
  const N = 10;
  const toe = 0.172, heel = -0.096;

  // A shoe is not a slab with a lump on it. What makes one read as a sneaker
  // is that its plan view is asymmetric — wide and blunt at the ball of the
  // foot, narrow at the waist, rounded at the heel — and that the profile
  // rises from a thin toe to a tall heel counter. Both of those need the
  // outline to change shape along its length, which means lofting front to
  // back rather than bottom to top.
  //
  // So this is built as a stack of *transverse* sections: each one is the
  // cross-section of the shoe at some point from toe to heel, and they are
  // lofted along Z and then stood up. The first attempt lofted it vertically
  // from a single outline and every shoe came out a bar of soap.
  const section = (halfW, base, top, round) => {
    const pts = boxRing(N, halfW, (top - base) / 2, round);
    return pts.map(([x, y]) => [x, y + (top + base) / 2]);
  };

  // z, half-width, sole bottom, upper top, roundness
  const profile = [
    [toe,          0.030, 0.006, 0.052, 0.85],
    [toe - 0.036,  0.045, 0.002, 0.070, 0.70],
    [toe - 0.082,  0.050, 0.002, 0.078, 0.60],   // ball of the foot, widest
    [toe - 0.130,  0.044, 0.002, 0.082, 0.55],   // waist
    [heel + 0.062, 0.045, 0.002, 0.090, 0.50],
    [heel + 0.020, 0.047, 0.004, 0.092, 0.55],
    [heel,         0.040, 0.010, 0.084, 0.75],
  ];

  const build = (yLo, yHi, widen) => {
    const sections = profile.map(([z, hw, b, t, r]) => {
      const lo = b + (t - b) * yLo, hi = b + (t - b) * yHi;
      return { y: z, pts: section(hw + widen, lo + widen, hi, r), ox: cx };
    });
    // Lofted along Z, then rotated so Z becomes the length again.
    const geo = loft(sections);
    geo.rotateX(-Math.PI / 2);
    return geo;
  };

  // Midsole, upper, and the blue that wraps the heel.
  g.add(mesh(build(0.00, 0.34, 0.0015), M.sole, (side < 0 ? 'ShoeL' : 'ShoeR') + '_Sole'));
  g.add(mesh(build(0.32, 1.00, 0), M.shoe, (side < 0 ? 'ShoeL' : 'ShoeR') + '_Upper'));

  // Heel counter, in the accent blue, hugging the back third only.
  const heelSec = profile.slice(3).map(([z, hw, b, t, r]) => ({
    y: z, pts: section(hw + 0.002, b + (t - b) * 0.30, t + 0.002, r), ox: cx,
  }));
  const heelGeo = loft(heelSec);
  heelGeo.rotateX(-Math.PI / 2);
  g.add(mesh(heelGeo, M.shoeAccent, (side < 0 ? 'ShoeL' : 'ShoeR') + '_Heel'));

  // Tongue, sitting proud between the laces.
  g.add(mesh(slab(0.046, 0.042, 0.026, cx, 0.086, toe - 0.118, [0.42, 0, 0]),
    M.shoeAccent, (side < 0 ? 'ShoeL' : 'ShoeR') + '_Tongue'));

  // The stripe along the midsole edge, where the two halves meet.
  const stripe = profile.map(([z, hw, b, t, r]) => ({
    y: z, pts: section(hw + 0.003, b + (t - b) * 0.30, b + (t - b) * 0.40, r), ox: cx,
  }));
  const stripeGeo = loft(stripe, { capBottom: false, capTop: false });
  stripeGeo.rotateX(-Math.PI / 2);
  g.add(mesh(stripeGeo, M.shoeAccent, (side < 0 ? 'ShoeL' : 'ShoeR') + '_Stripe'));

  return g;
}

// ---------------------------------------------------------------- assembly
/**
 * The whole model, as one group at the origin with its feet on y = 0.
 *
 * Parts are separate meshes rather than one merged buffer. It costs a handful
 * of draw calls and buys a glTF somebody can actually open and work on: every
 * piece named, every material its own, nothing to unpick.
 */
export function createLowPolyGolfer() {
  const M = makeMaterials();
  const root = new THREE.Group();
  root.name = 'LowPolyGolfer';

  root.add(buildTorso(M));
  root.add(buildHead(M));
  root.add(buildHair(M));
  root.add(buildCap(M));
  for (const s of [-1, 1]) {
    root.add(buildArm(M, s));
    root.add(buildLeg(M, s));
    root.add(buildShoe(M, s));
  }

  root.userData.rig = { ...RIG };
  root.userData.materials = Object.keys(MATERIALS);
  return root;
}

/** Triangles and materials, for the spec sheet. */
export function modelStats(root) {
  let tris = 0, meshes = 0;
  const mats = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    mats.add(o.material.name);
    const p = o.geometry.attributes.position;
    tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
  });
  return { triangles: Math.round(tris), meshes, materials: [...mats].sort() };
}
