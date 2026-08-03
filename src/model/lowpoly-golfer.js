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

/**
 * A flat plate from a 2-D outline, extruded along Z.
 *
 * For the things that really are flat and really do have a shape — a collar
 * point, a shield badge. Approximating those with boxes was the last place on
 * the model where the low-poly style was doing the work of hiding something
 * rather than describing it.
 */
function plate(outline, thickness, x = 0, y = 0, z = 0, rot = null) {
  const n = outline.length;
  const pos = [];
  const P = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const t = thickness / 2;
  const front = outline.map(([px, py]) => [px, py, t]);
  const back = outline.map(([px, py]) => [px, py, -t]);
  for (let i = 1; i < n - 1; i++) {
    P(front[0], front[i], front[i + 1]);
    P(back[0], back[i + 1], back[i]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    P(front[i], back[i], front[j]);
    P(front[j], back[i], back[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (rot) g.rotateX(rot[0] || 0), g.rotateY(rot[1] || 0), g.rotateZ(rot[2] || 0);
  g.translate(x, y, z);
  g.computeVertexNormals();
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

  // A HEAD IS DEEPER THAN IT IS WIDE, AND THE FIRST ONE HERE WAS ROUND.
  //
  // Roughly 155 mm across, 200 mm front to back, 236 mm tall. Built from
  // near-circular rings it came out as an egg on a stalk — too narrow at the
  // temples, too shallow at the back, and tapering to a point at the chin,
  // which together read as a caricature rather than as a man. So the squash
  // runs about 1.3 throughout: that one number is the difference.
  //
  // The jaw is wide and the taper stops well short of the bottom. A head that
  // narrows all the way to the chin has no mandible in it, and the mandible is
  // half of what makes a face male.
  const skull = loft([
    { y: chin,             pts: ring(N, 0.061, 1.16), oz: 0.010 },
    { y: chin + h * 0.13,  pts: ring(N, 0.068, 1.22), oz: 0.010 },
    { y: chin + h * 0.28,  pts: ring(N, 0.075, 1.26), oz: 0.006 },
    { y: chin + h * 0.44,  pts: ring(N, 0.078, 1.30), oz: 0.002 },
    { y: chin + h * 0.60,  pts: ring(N, 0.079, 1.32) },
    { y: chin + h * 0.76,  pts: ring(N, 0.077, 1.32), oz: -0.004 },
    { y: chin + h * 0.90,  pts: ring(N, 0.066, 1.28), oz: -0.008 },
    { y: top,              pts: ring(N, 0.042, 1.16), oz: -0.012 },
  ]);
  g.add(mesh(skull, M.skin, 'Head_Skull'));

  const eyeY = chin + h * 0.56;
  const faceZ = 0.104;   // the front of the face, now the skull is deeper

  // Brow ridge. One wedge across the forehead, and it does more for the face
  // than anything else here: it is what puts the eyes in shadow, and eyes in
  // shadow are most of what separates a head from an egg.
  g.add(mesh(loft([
    { y: eyeY + 0.012, pts: boxRing(8, 0.068, 0.024, 0.7), oz: faceZ * 0.44 },
    { y: eyeY + 0.032, pts: boxRing(8, 0.070, 0.030, 0.7), oz: faceZ * 0.38 },
  ], { capBottom: false }), M.skin, 'Head_Brow'));

  // Cheekbones, which give the middle of the face somewhere to be.
  for (const sd of [-1, 1]) {
    g.add(mesh(loft([
      { y: eyeY - 0.044, pts: boxRing(6, 0.024, 0.024, 0.9), ox: sd * 0.046, oz: faceZ * 0.38 },
      { y: eyeY - 0.010, pts: boxRing(6, 0.027, 0.030, 0.9), ox: sd * 0.049, oz: faceZ * 0.34 },
    ], { capBottom: false, capTop: false }), M.skin, sd < 0 ? 'Head_CheekL' : 'Head_CheekR'));
  }

  // Nose: bridge, tip, and a nostril block under it. Three pieces, because a
  // single wedge has no underside and the profile view is where a nose earns
  // its polygons.
  g.add(mesh(loft([
    { y: eyeY - 0.048, pts: boxRing(6, 0.017, 0.014, 0.6), oz: faceZ * 0.56 },
    { y: eyeY - 0.016, pts: boxRing(6, 0.014, 0.022, 0.6), oz: faceZ * 0.62 },
    { y: eyeY + 0.014, pts: boxRing(6, 0.010, 0.012, 0.7), oz: faceZ * 0.52 },
  ]), M.skin, 'Head_Nose'));
  g.add(mesh(slab(0.026, 0.010, 0.016, 0, eyeY - 0.050, faceZ * 0.58), M.skin, 'Head_Nostrils'));

  // Ears, lofted rather than slabbed — a rectangle on the side of a head is
  // the most obviously wrong thing a low-poly figure can have.
  for (const sd of [-1, 1]) {
    g.add(mesh(loft([
      { y: eyeY - 0.026, pts: boxRing(6, 0.006, 0.012, 0.9), ox: sd * 0.078, oz: -0.004 },
      { y: eyeY - 0.002, pts: boxRing(6, 0.008, 0.019, 0.9), ox: sd * 0.081, oz: -0.002 },
      { y: eyeY + 0.020, pts: boxRing(6, 0.006, 0.014, 0.9), ox: sd * 0.079, oz: -0.004 },
    ]), M.skin, sd < 0 ? 'Head_EarL' : 'Head_EarR'));
  }

  // Eyes, set under the brow and angled slightly, with a lid above each.
  for (const sd of [-1, 1]) {
    g.add(mesh(slab(0.024, 0.010, 0.008, sd * 0.036, eyeY, faceZ * 0.70,
      [0, 0, sd * 0.05]), M.eye, sd < 0 ? 'Head_EyeL' : 'Head_EyeR'));
    g.add(mesh(slab(0.028, 0.007, 0.009, sd * 0.037, eyeY + 0.008, faceZ * 0.69,
      [0, 0, sd * 0.06]), M.skin, sd < 0 ? 'Head_LidL' : 'Head_LidR'));
    g.add(mesh(slab(0.030, 0.008, 0.010, sd * 0.038, eyeY + 0.024, faceZ * 0.67,
      [0, 0, sd * 0.13]), M.hair, sd < 0 ? 'Head_BrowL' : 'Head_BrowR'));
  }

  // Mouth: two short bars meeting in the middle and tilted up at the ends.
  // One straight bar is a grimace, and the tilt is the entire difference.
  for (const sd of [-1, 1]) {
    g.add(mesh(slab(0.024, 0.006, 0.008,
      sd * 0.012, chin + h * 0.235, faceZ * 0.66, [0, 0, sd * 0.22]),
      M.eye, sd < 0 ? 'Head_MouthL' : 'Head_MouthR'));
  }

  // Chin and jawline. The mandible is a plane, not a curve, and cutting it in
  // is what stops the lower face reading as a chin-less blob.
  g.add(mesh(loft([
    { y: chin + 0.002, pts: boxRing(8, 0.034, 0.024, 0.85), oz: 0.032 },
    { y: chin + 0.034, pts: boxRing(8, 0.046, 0.034, 0.85), oz: 0.030 },
  ], { capTop: false }), M.skin, 'Head_Chin'));

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
    { y: chin + h * 0.34, pts: ring(N, 0.079, 1.30), oz: -0.008 },
    { y: chin + h * 0.50, pts: ring(N, 0.082, 1.32), oz: -0.010 },
    { y: chin + h * 0.62, pts: ring(N, 0.081, 1.32), oz: -0.010 },
  ], { capTop: false, capBottom: false });
  g.add(mesh(back, M.hair, 'Hair_Shell'));

  // Fringe under the brim.
  g.add(mesh(slab(0.116, 0.022, 0.028, 0, chin + h * 0.545, 0.086, [0.20, 0, 0]),
    M.hair, 'Hair_Fringe'));

  // Sideburns, tapered down in front of the ear rather than square.
  for (const s of [-1, 1]) {
    g.add(mesh(loft([
      { y: chin + h * 0.30, pts: boxRing(6, 0.007, 0.020, 0.6), ox: s * 0.075, oz: -0.006 },
      { y: chin + h * 0.44, pts: boxRing(6, 0.010, 0.036, 0.6), ox: s * 0.077, oz: -0.008 },
      { y: chin + h * 0.56, pts: boxRing(6, 0.011, 0.042, 0.6), ox: s * 0.077, oz: -0.010 },
    ]), M.hair, s < 0 ? 'Hair_SideL' : 'Hair_SideR'));
  }

  // The nape. Lofted and tapered — a box here was the one thing on the model
  // that read as a mistake rather than as a style, because hair does not have
  // corners and every other part of the silhouette does the work of pretending
  // that it might.
  g.add(mesh(loft([
    { y: chin + h * 0.20, pts: boxRing(8, 0.038, 0.012, 0.9), oz: -0.088 },
    { y: chin + h * 0.34, pts: boxRing(8, 0.052, 0.020, 0.8), oz: -0.084 },
    { y: chin + h * 0.50, pts: boxRing(8, 0.058, 0.026, 0.8), oz: -0.078 },
  ]), M.hair, 'Hair_Nape'));
  return g;
}

function buildCap(M) {
  const g = new THREE.Group();
  g.name = 'Cap';
  const { headTop: top, headBottom: chin } = RIG;
  const h = top - chin;
  // The band sits on the brow, not on the crown.
  //
  // At 0.76 of the head it perched on top like a bottle cap and left three
  // quarters of the face showing, which is what made the head read as tiny on
  // a long neck — the head was the right size all along, the cap was in the
  // wrong place. A real cap covers from the brow up.
  const base = chin + h * 0.555;
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
    // A dome, not a cone. Ending the crown on a small ring drew it to a point
    // and the cap looked like a party hat; the last ring has to stay wide and
    // the whole thing has to stop lower than the skull it sits on.
    const sections = [
      { y: base,          r: 0.090, sq: 1.30 },
      { y: base + 0.040,  r: 0.089, sq: 1.30 },
      { y: base + 0.078,  r: 0.078, sq: 1.26 },
      { y: top + 0.016,   r: 0.048, sq: 1.16 },
    ].map((s) => ({ y: s.y, pts: ring(N, s.r, s.sq).filter((_, i) => half.includes(i)) }));
    return loft(sections, { capBottom: false, capTop: false });
  };
  g.add(mesh(crown(true), M.capFront, 'Cap_Front'));
  g.add(mesh(crown(false), M.capRear, 'Cap_Rear'));

  // Button on top, and the strap and opening at the back — the one detail
  // that says "baseball cap" rather than "hat", and the reference sheet shows
  // it plainly in the back view.
  g.add(mesh(slab(0.020, 0.012, 0.020, 0, top + 0.024, -0.006), M.capRear, 'Cap_Button'));
  g.add(mesh(slab(0.058, 0.024, 0.012, 0, base + 0.022, -0.114), M.eye, 'Cap_Opening'));
  g.add(mesh(slab(0.084, 0.013, 0.014, 0, base + 0.009, -0.112), M.capRear, 'Cap_Strap'));

  // The brim.
  //
  // Rebuilt from an arc rather than from two straight chords. The chord
  // version reached twenty centimetres off the front of the head — a brim is
  // about six — and because both of its rows sat in front of the face it was
  // a plate floating clear of the cap rather than something growing out of it.
  //
  // So: an inner arc that follows the crown's own base exactly, an outer arc
  // pushed out from it along the same radius, and the strip between them. It
  // cannot detach from the cap, because it starts on it.
  const M_ = 12;
  const capRX = 0.088, capRZ = 0.088 * 1.30;
  const arc = [];
  for (let i = 0; i <= M_; i++) {
    // -95°..95°, so the brim wraps a little past the sides of the head.
    const phi = (-1 + (2 * i) / M_) * 1.66;
    const sn = Math.sin(phi), cs = Math.cos(phi);
    const inner = [capRX * sn, capRZ * cs];
    // Longest dead ahead and shortening round the sides, which is the shape of
    // every brim ever made.
    const reach = 0.062 * Math.pow(Math.max(0, cs), 0.55);
    const outer = [inner[0] * (1 + reach / capRX * 0.55), inner[1] + reach];
    // Droops at the tip and further at the corners.
    const drop = -0.013 - 0.020 * (1 - Math.max(0, cs));
    arc.push({ inner, outer, drop });
  }

  const TOP = base + 0.012, BOT = base + 0.003;
  const bp = [];
  const P = (p, q, r) => bp.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  const iT = (k) => [arc[k].inner[0], TOP, arc[k].inner[1]];
  const iB = (k) => [arc[k].inner[0], BOT, arc[k].inner[1]];
  const oT = (k) => [arc[k].outer[0], TOP + arc[k].drop, arc[k].outer[1]];
  const oB = (k) => [arc[k].outer[0], BOT + arc[k].drop, arc[k].outer[1]];

  for (let k = 0; k < M_; k++) {
    P(iT(k), oT(k), iT(k + 1));  P(iT(k + 1), oT(k), oT(k + 1));   // upper face
    P(iB(k), iB(k + 1), oB(k));  P(iB(k + 1), oB(k + 1), oB(k));   // under side
    P(oT(k), oB(k), oT(k + 1));  P(oT(k + 1), oB(k), oB(k + 1));   // outer rim
  }
  // Close the two ends.
  P(iT(0), iB(0), oT(0));           P(oT(0), iB(0), oB(0));
  P(iT(M_), oT(M_), iB(M_));        P(oT(M_), oB(M_), iB(M_));

  const brim = new THREE.BufferGeometry();
  brim.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
  brim.computeVertexNormals();
  g.add(mesh(brim, M.capFront, 'Cap_Brim'));

  return g;
}

function buildTorso(M) {
  const g = new THREE.Group();
  g.name = 'Torso';
  const N = 12;
  const R = RIG;

  // Neck, leaning very slightly forward as a real one does.
  //
  // Thicker than it looks like it should be, and it ends *above* the chin so
  // the join is hidden inside the jaw. Run it to the chin line and its taper
  // becomes the bottom of the face, which is what gave the first version a
  // long pointed jaw that belonged on a different character entirely.
  g.add(mesh(loft([
    { y: R.neckBottom - 0.026, pts: ring(N, 0.062, 0.94) },
    { y: R.neckTop + 0.028,    pts: ring(N, 0.055, 0.98), oz: 0.006 },
  ]), M.skin, 'Neck'));

  // The shirt.
  //
  // Widest at the deltoids, in at the waist, out again over the hips. The
  // `oz` offsets are the posture: the chest carried a little forward of the
  // hips and the small of the back tucked in behind them. Without them the
  // side view is a tube with a head on it, and no amount of front-view
  // shaping rescues that — a standing figure is read from its profile.
  g.add(mesh(loft([
    { y: R.hip - 0.056,      pts: ring(N, 0.150, 0.70), oz: -0.004 },
    { y: R.waist,            pts: ring(N, 0.142, 0.70), oz: -0.008 },
    { y: R.chest - 0.070,    pts: ring(N, 0.153, 0.73), oz: -0.002 },
    { y: R.chest + 0.030,    pts: ring(N, 0.172, 0.75), oz: 0.008 },
    { y: R.shoulder - 0.020, pts: ring(N, 0.177, 0.75), oz: 0.006 },
    { y: R.shoulder + 0.034, pts: ring(N, 0.148, 0.76), oz: 0.002 },
  ]), M.shirt, 'Shirt'));

  // Shoulder blades. Two shallow rises on the back, which is all the back
  // needs — the reference sheet's back view is otherwise a flat blue field.
  for (const sd of [-1, 1]) {
    g.add(mesh(loft([
      { y: R.chest - 0.030, pts: boxRing(6, 0.048, 0.014, 0.9),
        ox: sd * 0.070, oz: -0.104 },
      { y: R.chest + 0.056, pts: boxRing(6, 0.054, 0.018, 0.9),
        ox: sd * 0.074, oz: -0.108 },
    ], { capBottom: false, capTop: false }), M.shirt,
      sd < 0 ? 'Shirt_BladeL' : 'Shirt_BladeR'));
  }

  // Sleeves, with a hem. The hem is a ring of slightly larger radius at the
  // bottom, so the sleeve ends in an edge instead of dissolving into the arm.
  for (const sd of [-1, 1]) {
    g.add(mesh(loft([
      { y: R.shoulder - 0.120, pts: ring(8, 0.054, 1.0), ox: sd * R.shoulderHalf * 1.00 },
      { y: R.shoulder - 0.104, pts: ring(8, 0.058, 1.0), ox: sd * R.shoulderHalf * 0.98 },
      { y: R.shoulder - 0.040, pts: ring(8, 0.061, 1.0), ox: sd * R.shoulderHalf * 0.90 },
      { y: R.shoulder + 0.026, pts: ring(8, 0.046, 1.0), ox: sd * R.shoulderHalf * 0.72 },
    ]), M.shirt, sd < 0 ? 'Sleeve_L' : 'Sleeve_R'));
  }

  // Collar: a stand round the back of the neck and two points falling over
  // the chest. A polo collar is not a band — the points are the whole shape
  // of it, and a band is what a crew neck looks like.
  const stand = loft([
    { y: R.shoulder + 0.024, pts: ring(N, 0.070, 0.92), oz: -0.004 },
    { y: R.shoulder + 0.062, pts: ring(N, 0.079, 0.94), oz: -0.008 },
  ], { capBottom: false, capTop: false });
  g.add(mesh(stand, M.shirtTrim, 'Collar_Stand'));

  for (const sd of [-1, 1]) {
    const pt = plate([
      [0, 0.052], [sd * 0.052, 0.044], [sd * 0.040, -0.044], [0, -0.030],
    ], 0.010, sd * 0.030, R.shoulder + 0.010, 0.070,
      [0.42, sd * 0.30, 0]);
    g.add(mesh(pt, M.shirtTrim, sd < 0 ? 'Collar_PointL' : 'Collar_PointR'));
  }

  // Placket and two buttons.
  g.add(mesh(slab(0.028, 0.092, 0.012, 0, R.shoulder - 0.028, 0.120), M.shirtTrim, 'Placket'));
  for (const dy of [0.014, -0.030]) {
    g.add(mesh(slab(0.011, 0.011, 0.006, 0, R.shoulder - 0.028 + dy, 0.128),
      M.buckle, 'Placket_Button'));
  }

  // Crest: a shield, not a rectangle. Six points is enough for a heraldic
  // outline and a rectangle is not a badge.
  g.add(mesh(plate([
    [-0.016, 0.020], [0.016, 0.020], [0.016, -0.002],
    [0.008, -0.018], [0, -0.024], [-0.008, -0.018], [-0.016, -0.002],
  ], 0.007, -0.064, R.chest + 0.014, 0.126), M.crest, 'Crest'));

  // Belt, buckle and loops.
  g.add(mesh(loft([
    { y: R.waist - 0.032, pts: ring(N, 0.147, 0.70), oz: -0.008 },
    { y: R.waist + 0.014, pts: ring(N, 0.148, 0.70), oz: -0.008 },
  ], { capBottom: false, capTop: false }), M.belt, 'Belt'));
  g.add(mesh(slab(0.050, 0.036, 0.014, 0, R.waist - 0.009, 0.098), M.buckle, 'Buckle'));
  for (const lx of [-0.092, -0.030, 0.030, 0.092]) {
    g.add(mesh(slab(0.013, 0.054, 0.010, lx, R.waist - 0.009, 0.094 - Math.abs(lx) * 0.36),
      M.chino, 'Belt_Loop'));
  }

  return g;
}

function buildArm(M, side) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'Arm_L' : 'Arm_R';
  const R = RIG;
  const N = 8;
  const tag = side < 0 ? 'L' : 'R';

  // The A-pose. Twelve degrees out from vertical: enough that the armpit is
  // not a pinched crease, little enough that the silhouette is still a
  // standing man rather than a starfish.
  const lean = 0.21;
  const sx = (y) => side * (R.shoulderHalf * 0.86 + (R.shoulder - y) * Math.tan(lean));

  // Elbow slightly wider than the sections either side of it, so the arm has
  // a joint in it rather than being a smooth taper from shoulder to wrist.
  const arm = loft([
    { y: R.wrist,            pts: ring(N, 0.030, 0.94), ox: sx(R.wrist) },
    { y: R.elbow - 0.076,    pts: ring(N, 0.033, 0.94), ox: sx(R.elbow - 0.076) },
    { y: R.elbow - 0.012,    pts: ring(N, 0.040, 0.96), ox: sx(R.elbow - 0.012) },
    { y: R.elbow + 0.024,    pts: ring(N, 0.038, 0.96), ox: sx(R.elbow + 0.024) },
    { y: R.elbow + 0.100,    pts: ring(N, 0.046, 0.98), ox: sx(R.elbow + 0.100) },
    { y: R.shoulder - 0.100, pts: ring(N, 0.051, 1.00), ox: sx(R.shoulder - 0.100) },
  ]);
  g.add(mesh(arm, M.skin, 'Arm' + tag + '_Skin'));

  // The glove.
  //
  // Fingers modelled, not implied. The mitt it replaces read as a boxing
  // glove from any distance, and the reference is quite specific: a golf
  // glove has fingers, they are slightly parted, and the seams between them
  // are the only detail on an otherwise white shape. Four short prisms and a
  // thumb cost about a hundred and fifty triangles a hand, which on a model
  // this size is worth spending on the part people look at.
  const hx = sx(R.wrist);
  const palmTop = R.wrist + 0.020;
  const knuckle = R.fingertip + 0.052;

  // SHORT AND FAT, NOT LONG AND THIN.
  //
  // The first attempt gave each finger its true length measured from the
  // knuckle, and the hand came out as a broom: four pale spikes hanging off a
  // plate. Two things were wrong. Half a finger's length is inside the palm on
  // a real hand, so only the part past the knuckles should be modelled — and a
  // gloved finger is nearly as thick as it is wide, where these were slats.
  //
  // They are also built touching rather than splayed. Gaps between the fingers
  // of a relaxed hand are almost closed, and at this scale a visible gap is a
  // hole straight through the hand.
  g.add(mesh(loft([
    { y: knuckle,         pts: boxRing(8, 0.038, 0.026, 0.55), ox: hx },
    { y: R.wrist - 0.020, pts: boxRing(8, 0.039, 0.029, 0.5),  ox: hx },
    { y: palmTop,         pts: boxRing(8, 0.032, 0.025, 0.6),  ox: hx },
  ]), M.glove, 'Glove' + tag + '_Palm'));

  const fingers = [
    { off: -0.0255, len: 0.030, r: 0.0125 },
    { off: -0.0085, len: 0.034, r: 0.0130 },
    { off: 0.0085,  len: 0.031, r: 0.0128 },
    { off: 0.0255,  len: 0.024, r: 0.0115 },
  ];
  fingers.forEach((fg, i) => {
    const fx = hx + side * fg.off;
    const tip = knuckle - fg.len;
    g.add(mesh(loft([
      { y: tip,              pts: boxRing(6, fg.r * 0.88, 0.021, 0.75), ox: fx },
      { y: knuckle + 0.010,  pts: boxRing(6, fg.r, 0.025, 0.65), ox: fx },
    ]), M.glove, 'Glove' + tag + '_Finger' + (i + 1)));
  });

  // Thumb, off the side of the palm and angled forward.
  g.add(mesh(loft([
    { y: knuckle + 0.018, pts: boxRing(6, 0.013, 0.016, 0.85),
      ox: hx - side * 0.044, oz: 0.018 },
    { y: knuckle + 0.048, pts: boxRing(6, 0.015, 0.020, 0.8),
      ox: hx - side * 0.036, oz: 0.010 },
    { y: R.wrist - 0.016, pts: boxRing(6, 0.016, 0.023, 0.75),
      ox: hx - side * 0.022, oz: 0.002 },
  ]), M.glove, 'Glove' + tag + '_Thumb'));

  // The cuff, closing the glove at the wrist.
  g.add(mesh(loft([
    { y: R.wrist + 0.014, pts: boxRing(8, 0.033, 0.025, 0.6), ox: hx },
    { y: R.wrist + 0.034, pts: boxRing(8, 0.031, 0.023, 0.65), ox: hx },
  ], { capBottom: false }), M.glove, 'Glove' + tag + '_Cuff'));

  return g;
}

function buildLeg(M, side) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'Leg_L' : 'Leg_R';
  const R = RIG;
  const N = 8;
  const cx = side * R.legHalf;
  const tag = side < 0 ? 'L' : 'R';

  // Straight-cut chinos: the taper from thigh to ankle is slight and the
  // ankle opening stays wide. A leg that narrows to the ankle is a jean.
  //
  // The break is the last two sections. Trousers do not stop level above a
  // shoe — the front of the hem catches on the laces and rides up while the
  // back falls to the heel, and that little diagonal is the difference
  // between trousers and a pair of tubes.
  g.add(mesh(loft([
    { y: R.ankle + 0.024, pts: ring(N, 0.054, 0.90), ox: cx, oz: -0.010 },
    { y: R.ankle + 0.052, pts: ring(N, 0.055, 0.90), ox: cx, oz: -0.004 },
    { y: R.knee - 0.120,  pts: ring(N, 0.057, 0.92), ox: cx },
    { y: R.knee - 0.020,  pts: ring(N, 0.064, 0.94), ox: cx, oz: 0.006 },
    { y: R.knee + 0.030,  pts: ring(N, 0.062, 0.94), ox: cx, oz: 0.002 },
    { y: R.knee + 0.150,  pts: ring(N, 0.074, 0.94), ox: cx * 1.02 },
    { y: R.crotch,        pts: ring(N, 0.084, 0.92), ox: cx * 1.04, oz: -0.004 },
    { y: R.hip,           pts: ring(N, 0.093, 0.86), ox: cx * 0.92, oz: -0.006 },
  ]), M.chino, 'Leg' + tag + '_Chino'));

  // The turn-up, cut on the same diagonal as the hem above it.
  g.add(mesh(loft([
    { y: R.ankle + 0.018, pts: ring(N, 0.057, 0.90), ox: cx, oz: -0.012 },
    { y: R.ankle + 0.048, pts: ring(N, 0.058, 0.90), ox: cx, oz: -0.006 },
  ], { capBottom: false, capTop: false }), M.chino, 'Leg' + tag + '_Cuff'));

  // A crease down the front of each leg. One flat plane catching the light a
  // shade differently is all a pressed trouser is.
  g.add(mesh(loft([
    { y: R.ankle + 0.060, pts: boxRing(6, 0.010, 0.006, 0.9), ox: cx, oz: 0.048 },
    { y: R.knee + 0.040,  pts: boxRing(6, 0.012, 0.007, 0.9), ox: cx, oz: 0.058 },
    { y: R.crotch - 0.020, pts: boxRing(6, 0.012, 0.007, 0.9), ox: cx * 1.02, oz: 0.074 },
  ], { capBottom: false, capTop: false }), M.chino, 'Leg' + tag + '_Crease'));

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
