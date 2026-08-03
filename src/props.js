/**
 * props.js — everything that dresses the hole: trees, the clubhouse village,
 * the flagstick and the tee markers.
 *
 * Trees are instanced (3 draw calls for ~1500 pieces of geometry) and their
 * placement is filtered through course.js, so nothing ever grows on the
 * fairway, in a bunker, or out of the pond.
 */

import * as THREE from 'three';
import { mulberry32, lerp, hash3, clamp, fbm2 } from './util.js';
import { COURSE } from './courses.js';
import {
  heightAt, nearest, centreXAt, fairwayHalfWidth, bunkerField, pondField, shoreEdge,
  GREEN, HOLE_POS, TEE, WORLD_CX, WORLD_CZ, WORLD_SIZE,
  greenEdge, bunkerEdge, CREEK, OCEAN,
} from './course.js';

// ---------------------------------------------------------------- geometry
/**
 * Lumpy blob for broadleaf canopies. IcosahedronGeometry is non-indexed, so we
 * jitter by a hash of the *position* — duplicated verts get identical offsets
 * and the surface never tears apart.
 *
 * Normals are the normalised position rather than face normals: for a roughly
 * spherical blob that's an excellent smooth normal, and smooth is what the
 * reference wants — its foliage has soft gradients, no visible facets.
 */
function makeCanopyGeo(detail = 2) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const p = geo.attributes.position;
  const n = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = hash3(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100);
    const k = 1 + (h - 0.5) * 0.30;
    const nx = x * k, ny = y * k * 0.92, nz = z * k;
    p.setXYZ(i, nx, ny, nz);
    const len = Math.hypot(nx, ny, nz) || 1;
    n[i * 3] = nx / len; n[i * 3 + 1] = ny / len; n[i * 3 + 2] = nz / len;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return geo;
}

/**
 * Conifer built from one lathe.
 *
 * Mid-poly wants a rounded silhouette, so the profile carries five soft tiers
 * with eased shoulders rather than a stack of cones, and the radial count is
 * high enough that the outline reads as a curve. The tier rims are then
 * scalloped around the circumference so the shape is not a clean surface of
 * revolution.
 *
 * Geometry stays indexed and smooth-normalled: with a hard cel ramp, smooth
 * normals give clean curved bands, where flat shading would give facets.
 */
function makePineGeo(coarse = false) {
  const profile = [
    [0.00, 0.00], [1.15, 0.05], [1.78, 0.22], [2.00, 0.52],
    [1.84, 0.86], [1.48, 1.14], [1.18, 1.32],
    [1.62, 1.54], [1.86, 1.84], [1.72, 2.16], [1.40, 2.44], [1.10, 2.62],
    [1.48, 2.84], [1.68, 3.12], [1.56, 3.42], [1.26, 3.68], [0.98, 3.84],
    [1.30, 4.06], [1.44, 4.34], [1.32, 4.62], [1.06, 4.86], [0.82, 5.00],
    [1.02, 5.22], [1.10, 5.48], [0.96, 5.76], [0.74, 6.00],
    [0.52, 6.32], [0.30, 6.68], [0.12, 6.96], [0.00, 7.15],
  ].map(([x, y]) => new THREE.Vector2(x, y));

  // 28 segments with 7 lobes gives exactly 4 samples per scallop. Any lobe
  // count that divides the segment count lands on the zero crossings and the
  // scallop silently disappears.
  //
  // The coarse build is for trees deep in the forest, which are a silhouette
  // and nothing more. It keeps every third profile point and half the radial
  // segments — about a sixth of the triangles — and 12 with 5 lobes still
  // avoids the zero-crossing trap. At eighty-five yards and beyond there is
  // nothing in the detailed one left to see.
  const pts = coarse ? profile.filter((_, i) => i % 3 === 0 || i === profile.length - 1) : profile;
  const SEGS = coarse ? 12 : 28, LOBES = coarse ? 5 : 7;
  const geo = new THREE.LatheGeometry(pts, SEGS);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const theta = Math.atan2(z, x);
    const k = 1 + Math.sin(theta * LOBES) * 0.10 * Math.min(1, r / 1.2);
    p.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------ tree density
/**
 * A coverage map of where the trees actually are, rebuilt with each hole.
 *
 * Both the pine straw beds (in the terrain shader) and the grass tufts (on the
 * CPU) key off this. They cannot derive it themselves — tree placement is
 * rejection-sampled against half a dozen rules and then randomly thinned, so
 * "somewhere a tree is allowed" and "somewhere a tree is" are very different
 * regions, and straw spread over the first covers a lot of open rough.
 */
/**
 * One palm frond: a tapered blade that arcs away and droops at the tip.
 *
 * A strip of quads rather than a cone or a squashed sphere, because a frond is
 * the one part of a palm the eye actually reads. Eight triangles at full
 * detail, and there are seven or eight of them per tree, so a palm costs about
 * as much as one broadleaf canopy blob.
 */
function makeFrondGeo(coarse = false) {
  const seg = coarse ? 4 : 7;
  const pos = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    // Droop is quadratic, so the blade leaves the crown almost straight and
    // falls away at the tip — a linear droop reads as a bent stick.
    const y = -0.46 * t * t;
    // Widest around a third of the way out, pinched to a point at the tip.
    const w = 0.185 * Math.sin(Math.PI * Math.min(1, t * 1.1)) + 0.012;
    pos.push(t, y, -w, t, y, w);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A shell: half an ellipsoid with a few ribs, small enough to be a suggestion. */
function makeShellGeo() {
  const g = new THREE.SphereGeometry(0.5, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    // Ribs, and a taper toward one end, so it is a scallop rather than a dome.
    const rib = 1 + Math.cos(a * 7) * 0.07;
    p.setXYZ(i, x * rib * (1 + z * 0.35), y * 0.42, z * rib);
  }
  g.computeVertexNormals();
  return g;
}

const TMAP = 512;
let treeMap = null;            // Uint8Array, TMAP × TMAP
let treeTex = null;            // the same data, for the terrain shader
let treeOrigin = { x: 0, z: 0, size: 1 };

function buildTreeMap(trunks, pines) {
  // Hangs off a shader uniform rather than material.map, so disposeWorld()
  // will not find it — it has to let go of the last hole's texture itself.
  if (treeTex) treeTex.dispose();
  const data = new Uint8Array(TMAP * TMAP);
  const half = WORLD_SIZE / 2;
  treeOrigin = { x: WORLD_CX - half, z: WORLD_CZ - half, size: WORLD_SIZE };
  const perTexel = WORLD_SIZE / TMAP;

  const splat = (x, z, yards) => {
    const u = (x - treeOrigin.x) / perTexel;
    const v = (z - treeOrigin.z) / perTexel;
    const R = Math.max(1, Math.round(yards / perTexel));
    const ci = Math.round(u), cj = Math.round(v);
    for (let j = -R; j <= R; j++) {
      const pz = cj + j;
      if (pz < 0 || pz >= TMAP) continue;
      for (let i = -R; i <= R; i++) {
        const px = ci + i;
        if (px < 0 || px >= TMAP) continue;
        // Falls off to nothing at the edge of the kernel, so overlapping
        // canopies accumulate into a continuous field rather than tiling.
        const d2 = (i * i + j * j) / ((R + 0.5) * (R + 0.5));
        if (d2 >= 1) continue;
        const k = (1 - d2) * 150;
        const idx = pz * TMAP + px;
        data[idx] = Math.min(255, data[idx] + k);
      }
    }
  };

  for (const t of trunks) splat(t.x, t.z, 7);
  for (const p of pines) splat(p.x, p.z, 6 + p.s * 2.2);

  treeMap = data;
  treeTex = new THREE.DataTexture(data, TMAP, TMAP, THREE.RedFormat);
  treeTex.minFilter = treeTex.magFilter = THREE.LinearFilter;
  treeTex.wrapS = treeTex.wrapT = THREE.ClampToEdgeWrapping;
  treeTex.needsUpdate = true;
}

/** 0…1 tree coverage at a world point. Zero until createTrees has run. */
export function treeDensityAt(x, z) {
  if (!treeMap) return 0;
  const u = ((x - treeOrigin.x) / treeOrigin.size) * TMAP;
  const v = ((z - treeOrigin.z) / treeOrigin.size) * TMAP;
  const i = Math.floor(u), j = Math.floor(v);
  if (i < 0 || j < 0 || i >= TMAP || j >= TMAP) return 0;
  return treeMap[j * TMAP + i] / 255;
}

/** The same map as a texture, plus the transform the shader needs. */
export function treeMapTexture() {
  return treeTex ? { tex: treeTex, origin: treeOrigin } : null;
}

// ---------------------------------------------------------------- trees
/** Is this a legal, sensible spot for a tree? */
/**
 * Nothing grows on the cliff, or within a few yards of the lip.
 *
 * Shared by every scatter pass here. It is the same rule three times over —
 * trees, scrub and grass all stopped at the rock — and writing it once means
 * they stop at the same line rather than three slightly different ones.
 */
function ashore(x, z, margin = 5) {
  return shoreEdge(x, z) > margin;
}

function plantable(x, z) {
  const n = nearest(x, z);
  // Only a narrow strip of second cut before the treeline starts. The holes
  // are corridors cut through forest, not clearings in a park.
  if (n.dist < fairwayHalfWidth(n.t) + 11) return false;
  if (!ashore(x, z, 8)) return false;
  if (Math.hypot(x - GREEN.x, z - GREEN.z) < GREEN.r + 13) return false;
  if (Math.hypot(x - TEE.x, z - TEE.z) < 26) return false;
  if (bunkerField(x, z) < 1.7) return false;
  if (pondField(x, z) < 1.3) return false;
  // Keep the corridor behind the tee clear for the opening camera move.
  if (z > 8 && Math.abs(x) < 32) return false;
  return true;
}

/**
 * Is this a legal spot for a low shrub? Azaleas mass at the *front* of the
 * treeline, closer in than any tree is allowed, which is exactly what gives
 * the reference its band of colour along the edge of the corridor.
 */
function shrubbable(x, z) {
  const n = nearest(x, z);
  const hw = fairwayHalfWidth(n.t);
  if (n.dist < hw + 5 || n.dist > hw + 30) return false;
  if (!ashore(x, z, 5)) return false;
  if (Math.hypot(x - GREEN.x, z - GREEN.z) < GREEN.r + 10) return false;
  if (Math.hypot(x - TEE.x, z - TEE.z) < 22) return false;
  if (bunkerField(x, z) < 1.4) return false;
  if (pondField(x, z) < 1.15) return false;
  return true;
}

/**
 * Species mix.
 *
 * `loblolly` is the important one, and the reason trunks carry a non-uniform
 * scale: a mature pine here is a bare pole for most of its height with the
 * canopy only in the top third. Cones sitting on the ground read as Christmas
 * trees, which is what the treeline looked like before.
 */
const SPECIES = [
  { key: 'loblolly', weight: 0.30 },
  { key: 'pine', weight: 0.22 },
  { key: 'broadleaf', weight: 0.24 },
  { key: 'young', weight: 0.10 },
  { key: 'dogwood', weight: 0.09 },
  { key: 'maple', weight: 0.05 },
];

/**
 * What grows on a headland.
 *
 * Kiawe: a short thick trunk and a canopy that has been pressed flat by wind
 * off the water. It is the tree in every photograph of a course like this, and
 * it is nothing like a pine — the silhouette is wider than it is tall, and you
 * see the sea *through* it and under it, which is most of why these holes look
 * the way they do. A few palms among them, near the tees, and nothing else.
 */
const COAST_SPECIES = [
  { key: 'kiawe', weight: 0.74 },
  { key: 'palm', weight: 0.15 },
  { key: 'young', weight: 0.11 },
];

function pickSpecies(r) {
  let acc = 0;
  for (const s of (COURSE.coastal ? COAST_SPECIES : SPECIES)) {
    acc += s.weight;
    if (r <= acc) return s.key;
  }
  return COURSE.coastal ? 'kiawe' : 'pine';
}

export function createTrees(toonRamp) {
  const group = new THREE.Group();
  group.name = 'trees';
  const rnd = mulberry32(20250727);

  const trunks = [];   // { x,y,z, rx, ry, rot } — non-uniform, for bare poles
  const pines = [];    // { x,y,z, s, sy, rot, lean, hsl }
  const blobs = [];    // { x,y,z, s, squash, rot, hsl }
  const shrubs = [];   // { x,y,z, sx, sy, rot, hsl }
  const fronds = [];   // { x,y,z, len, yaw, pitch, hsl } — palms only
  const shells = [];   // { x,y,z, s, rot, hsl } — beaches only

  const plant = (x, z, sizeScale, far = false) => {
    if (!plantable(x, z)) return;
    const y = heightAt(x, z);
    if (y < -0.5) return; // never standing in the pond bed

    const kind = pickSpecies(rnd());
    const k = sizeScale;

    if (kind === 'loblolly') {
      // Tall bare pole, canopy only up top.
      const trunkH = lerp(11, 17, rnd()) * k;
      const girth = lerp(0.42, 0.60, rnd()) * k;
      trunks.push({ x, y, z, rx: girth, ry: trunkH / 3.6, rot: rnd() * Math.PI * 2, far });
      pines.push({
        far,
        x, y: y + trunkH * 0.58, z,
        s: lerp(0.95, 1.35, rnd()) * k, sy: lerp(0.85, 1.15, rnd()),
        rot: rnd() * Math.PI * 2, lean: rnd(),
        hsl: [lerp(0.30, 0.36, rnd()), lerp(0.34, 0.50, rnd()), lerp(0.13, 0.21, rnd())],
      });
      return;
    }

    if (kind === 'kiawe') {
      // Wider than it is tall, and leaning off the water. The canopy is a
      // flattened raft of blobs on a short bole rather than a ball on a stick:
      // a round canopy at this size reads as a shrub, and the flat top is the
      // whole silhouette.
      const sc = lerp(1.5, 2.6, rnd()) * k;
      const lean = lerp(-0.13, 0.13, rnd());
      const face = rnd() * Math.PI * 2;
      trunks.push({ x, y, z, rx: sc * 1.15, ry: sc * 0.72, rot: face, tilt: lean, far });
      const deck = y + sc * 2.5;
      const spread = sc * 2.5;
      const base = [lerp(0.20, 0.28, rnd()), lerp(0.30, 0.46, rnd()), lerp(0.24, 0.34, rnd())];
      const n = 4 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + lerp(-0.4, 0.4, rnd());
        const rr = i === 0 ? 0 : lerp(0.45, 1.0, rnd());
        blobs.push({
          far,
          x: x + Math.cos(a) * rr * spread + Math.sin(face) * lean * sc * 2,
          y: deck + lerp(-0.35, 0.5, rnd()) * sc,
          z: z + Math.sin(a) * rr * spread + Math.cos(face) * lean * sc * 2,
          s: (i === 0 ? lerp(1.9, 2.5, rnd()) : lerp(1.4, 2.1, rnd())) * sc,
          // Pressed flat. This is the number that makes it a kiawe.
          squash: lerp(0.30, 0.44, rnd()),
          rot: rnd() * Math.PI * 2,
          tilt: lerp(-0.08, 0.08, rnd()),
          hsl: [base[0] + lerp(-0.012, 0.012, rnd()), base[1], base[2] + lerp(-0.04, 0.04, rnd())],
        });
      }
      return;
    }

    if (kind === 'palm') {
      // Tall, thin, and leaning — a palm that stands to attention looks like a
      // lamp post. The lean is baked into the trunk's tilt and the crown is
      // offset to match, so the fronds sit on top of the trunk rather than
      // beside it.
      const trunkH = lerp(9, 15, rnd()) * k;
      const lean = lerp(-0.16, 0.16, rnd());
      const face = rnd() * Math.PI * 2;
      const dx = Math.sin(face) * Math.sin(lean) * trunkH * 0.5;
      const dz = Math.cos(face) * Math.sin(lean) * trunkH * 0.5;
      trunks.push({
        x, y, z, rx: lerp(0.30, 0.42, rnd()) * k, ry: trunkH / 3.6,
        rot: face, tilt: lean, far,
      });
      const crownY = y + trunkH * Math.cos(lean) * 0.97;
      const n = 9 + Math.floor(rnd() * 4);
      const hue = lerp(0.24, 0.30, rnd());
      const lit = lerp(0.26, 0.38, rnd());
      const spin = rnd() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        fronds.push({
          far,
          x: x + dx, y: crownY, z: z + dz,
          len: lerp(5.4, 8.2, rnd()) * k,
          yaw: spin + (i / n) * Math.PI * 2 + lerp(-0.18, 0.18, rnd()),
          // Mostly flat, a few lifting. Fronds that all point up read as a yucca.
          pitch: lerp(-0.06, 0.40, rnd()),
          hsl: [hue, lerp(0.40, 0.60, rnd()), lit + lerp(-0.05, 0.05, rnd())],
        });
      }
      // A few coconuts, tucked under the crown.
      if (rnd() < 0.55) {
        blobs.push({
          far, x: x + dx, y: crownY - 0.35, z: z + dz,
          s: 0.42 * k, squash: 0.9, rot: 0, tilt: 0,
          hsl: [0.09, 0.34, 0.22],
        });
      }
      return;
    }

    if (kind === 'pine') {
      pines.push({
        far,
        x, y: y - 0.2, z,
        s: lerp(1.7, 2.9, rnd()) * k, sy: lerp(0.9, 1.25, rnd()),
        rot: rnd() * Math.PI * 2, lean: rnd(),
        hsl: [lerp(0.29, 0.37, rnd()), lerp(0.38, 0.54, rnd()), lerp(0.14, 0.24, rnd())],
      });
      return;
    }

    // Everything else is a trunk plus a cluster of canopy blobs; only the
    // proportions and the colour change.
    const spec = {
      broadleaf: {
        h: [1.5, 2.3], lo: 2, hi: 3, sz: [1.9, 2.5], sq: 0.95,
        hsl: () => [lerp(0.22, 0.31, rnd()), lerp(0.44, 0.62, rnd()), lerp(0.20, 0.31, rnd())],
      },
      young: {
        h: [0.7, 1.1], lo: 1, hi: 2, sz: [1.5, 2.0], sq: 1.05,
        hsl: () => [lerp(0.24, 0.33, rnd()), lerp(0.48, 0.64, rnd()), lerp(0.24, 0.35, rnd())],
      },
      dogwood: {
        h: [0.9, 1.3], lo: 2, hi: 3, sz: [1.6, 2.2], sq: 0.62,
        hsl: () => [lerp(0.08, 0.16, rnd()), lerp(0.14, 0.30, rnd()), lerp(0.84, 0.93, rnd())],
      },
      maple: {
        h: [1.1, 1.6], lo: 2, hi: 3, sz: [1.7, 2.2], sq: 0.90,
        hsl: () => [lerp(0.96, 1.0, rnd()), lerp(0.44, 0.60, rnd()), lerp(0.21, 0.30, rnd())],
      },
    }[kind];

    const s = lerp(spec.h[0], spec.h[1], rnd()) * k;
    trunks.push({ x, y, z, rx: s, ry: s, rot: rnd() * Math.PI * 2, far });
    const n = Math.round(lerp(spec.lo, spec.hi, rnd()));
    const base = spec.hsl();
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = i === 0 ? 0 : lerp(0.5, 1.15, rnd());
      blobs.push({
        far,
        x: x + Math.cos(a) * r * s,
        y: y + (3.1 + (i === 0 ? 0.5 : lerp(-0.35, 1.0, rnd()))) * s,
        z: z + Math.sin(a) * r * s,
        s: (i === 0 ? lerp(spec.sz[0], spec.sz[1], rnd()) : lerp(1.3, 1.9, rnd())) * s,
        squash: spec.sq,
        rot: rnd() * Math.PI * 2,
        tilt: lerp(-0.14, 0.14, rnd()),
        // Slight drift around the tree's colour, so a canopy is not one flat shade.
        hsl: [base[0] + lerp(-0.012, 0.012, rnd()), base[1], base[2] + lerp(-0.05, 0.05, rnd())],
      });
    }
  };

  // How wooded this course is. A links course with a forest around it is a
  // parkland course with different hole names, so this scales every pass.
  const density = COURSE.trees ?? 1;
  const many = (n) => Math.max(0, Math.round(n * density));

  // The hole decides how much ground there is to plant.
  const zNear = TEE.z + 20;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.44;

  // Pass A — the treeline proper, biased hard toward the corridor edge.
  for (let i = 0, n = many(1500); i < n; i++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    const off = lerp(16, 95, Math.pow(rnd(), 1.8));
    plant(centreXAt(z) + side * off + lerp(-7, 7, rnd()), z + lerp(-9, 9, rnd()), 1);
  }

  // Pass B — deep forest behind it.
  for (let i = 0, n = many(2400); i < n; i++) {
    const z = lerp(zNear + 30, zFar - 20, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    plant(centreXAt(z) + side * lerp(85, 260, rnd()), z, lerp(0.9, 1.3, rnd()), true);
  }

  // Pass C — out to the property line.
  for (let i = 0, n = many(1600); i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = lerp(WORLD_SIZE * 0.20, WORLD_SIZE * 0.50, rnd());
    plant(WORLD_CX + Math.sin(a) * r, WORLD_CZ + Math.cos(a) * r, lerp(1.0, 1.5, rnd()), true);
  }

  // Pass D — azaleas, in drifts along the front of the treeline. One colour
  // per drift, so they read as planted beds rather than confetti.
  //
  // Not on a headland. Flowering ornamental beds belong to a manicured
  // parkland course; what grows in salt wind above a cliff is dry scrub, and
  // this pass is replaced by tussocks in the same places when the course says
  // it is coastal.
  for (let i = 0; i < (COURSE.coastal ? 90 : 170); i++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    const cx = centreXAt(z) + side * lerp(22, 52, rnd());
    if (!shrubbable(cx, z)) continue;

    const white = rnd() < 0.3;
    const hsl = COURSE.coastal
      // Bleached olive and straw — the fringe above the rocks.
      ? [lerp(0.11, 0.16, rnd()), lerp(0.20, 0.40, rnd()), lerp(0.34, 0.52, rnd())]
      : white
        ? [lerp(0.02, 0.10, rnd()), lerp(0.05, 0.18, rnd()), lerp(0.88, 0.95, rnd())]
        : [lerp(0.90, 0.99, rnd()), lerp(0.50, 0.72, rnd()), lerp(0.52, 0.66, rnd())];

    const count = 4 + Math.floor(rnd() * 7);
    for (let j = 0; j < count; j++) {
      const bx = cx + lerp(-7, 7, rnd());
      const bz = z + lerp(-7, 7, rnd());
      if (!shrubbable(bx, bz)) continue;
      shrubs.push({
        x: bx, y: heightAt(bx, bz) - 0.25, z: bz,
        sx: lerp(1.1, 2.1, rnd()) * (COURSE.coastal ? 0.85 : 1),
        sy: lerp(0.7, 1.2, rnd()) * (COURSE.coastal ? 0.55 : 1),
        rot: rnd() * Math.PI * 2,
        hsl: [hsl[0] % 1, hsl[1], hsl[2] + lerp(-0.05, 0.05, rnd())],
      });
    }
  }

  // Pass E — shells, on the sand. Sampled by rejection against the bunker
  // field rather than scattered near it: the beaches on this course are
  // enormous and irregular, and anything cheaper put shells on grass.
  if (COURSE.shells) {
    for (let i = 0; i < 4200 && shells.length < 900; i++) {
      const z = lerp(zNear - 40, zFar, rnd());
      const sx = centreXAt(z) + lerp(-140, 140, rnd());
      if (bunkerField(sx, z) > 0.92) continue;      // not on sand
      if (pondField(sx, z) < 1.02) continue;        // not in the water
      shells.push({
        x: sx, y: heightAt(sx, z) + 0.02, z,
        s: lerp(0.20, 0.44, rnd()),
        rot: rnd() * Math.PI * 2,
        tilt: lerp(-0.5, 0.5, rnd()),
        hsl: rnd() < 0.28
          ? [lerp(0.02, 0.07, rnd()), lerp(0.30, 0.55, rnd()), lerp(0.72, 0.84, rnd())]
          : [lerp(0.07, 0.11, rnd()), lerp(0.10, 0.30, rnd()), lerp(0.80, 0.93, rnd())],
      });
    }
  }

  // ------------------------------------------------------------ build meshes
  // Where the trees actually ended up, at about three yards a texel.
  //
  // The pine straw beds and the grass both need to know this, and neither can
  // work it out for itself: tree placement is rejection-sampled against half a
  // dozen rules, so "far enough out that trees are allowed" is nothing like
  // "trees are here". Splatting the real positions is the only honest answer,
  // and it costs one small texture per hole.
  buildTreeMap(trunks, pines);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  /**
   * One complete set of instanced meshes, at one level of detail.
   *
   * Four fifths of the triangles in this scene were trees, and four fifths of
   * the trees are deep forest or property line — eighty-five yards off the
   * corridor at the very nearest, where a canopy is a silhouette and nothing
   * more. Those get roughly a sixth of the geometry.
   *
   * They are also dropped from the shadow pass, which is the larger saving of
   * the two. The shadow camera is deliberately tight around the player, so a
   * tree that far out can only ever cast into ground nobody is looking at —
   * but an InstancedMesh's bounds span every instance, so it is never frustum
   * culled, and all of them were being re-rendered into the shadow map every
   * frame regardless.
   */
  const build = (far) => {
    const trunkGeo = new THREE.CylinderGeometry(0.26, 0.42, 3.6, far ? 8 : 20, 1);
    trunkGeo.translate(0, 1.8, 0);
    const canopyGeo = makeCanopyGeo(far ? 1 : 2);
    const leaf = () => new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp });
    const mine = (arr) => arr.filter((o) => !!o.far === far);

    const T = mine(trunks), B = mine(blobs), P = mine(pines), S = mine(shrubs);
    const F = mine(fronds);
    const trunkMesh = new THREE.InstancedMesh(trunkGeo,
      new THREE.MeshToonMaterial({ color: 0x8d6547, gradientMap: toonRamp }), Math.max(1, T.length));
    const blobMesh = new THREE.InstancedMesh(canopyGeo, leaf(), Math.max(1, B.length));
    const pineMesh = new THREE.InstancedMesh(makePineGeo(far), leaf(), Math.max(1, P.length));
    const shrubMesh = new THREE.InstancedMesh(canopyGeo, leaf(), Math.max(1, S.length));
    // Double-sided: half the fronds on any palm are seen from underneath.
    const frondMesh = new THREE.InstancedMesh(
      makeFrondGeo(far),
      new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp, side: THREE.DoubleSide }),
      Math.max(1, F.length)
    );

    T.forEach((t, i) => {
      // A palm carries a tilt; everything else is upright and passes zero.
      e.set(t.tilt ?? 0, t.rot, 0);
      m.compose(pos.set(t.x, t.y, t.z), q.setFromEuler(e), scl.set(t.rx, t.ry, t.rx));
      trunkMesh.setMatrixAt(i, m);
    });
    B.forEach((b, i) => {
      e.set(b.tilt, b.rot, -b.tilt);
      m.compose(pos.set(b.x, b.y, b.z), q.setFromEuler(e), scl.set(b.s, b.s * b.squash, b.s));
      blobMesh.setMatrixAt(i, m);
      col.setHSL(b.hsl[0], b.hsl[1], b.hsl[2]);
      blobMesh.setColorAt(i, col);
    });
    P.forEach((p, i) => {
      e.set(lerp(-0.05, 0.05, p.lean), p.rot, lerp(0.05, -0.05, p.lean));
      m.compose(pos.set(p.x, p.y, p.z), q.setFromEuler(e), scl.set(p.s, p.s * p.sy, p.s));
      pineMesh.setMatrixAt(i, m);
      col.setHSL(p.hsl[0], p.hsl[1], p.hsl[2]);
      pineMesh.setColorAt(i, col);
    });
    F.forEach((fr, i) => {
      // Euler XYZ composes as Rx·Ry·Rz, so the pitch in Z applies first — the
      // blade tilts up in its own frame — and the yaw then swings it round the
      // crown. The other order fans the fronds into a cone lying on its side.
      e.set(0, fr.yaw, fr.pitch);
      m.compose(pos.set(fr.x, fr.y, fr.z), q.setFromEuler(e), scl.set(fr.len, fr.len, fr.len));
      frondMesh.setMatrixAt(i, m);
      col.setHSL(fr.hsl[0], fr.hsl[1], fr.hsl[2]);
      frondMesh.setColorAt(i, col);
    });
    S.forEach((sh, i) => {
      e.set(0, sh.rot, 0);
      m.compose(pos.set(sh.x, sh.y, sh.z), q.setFromEuler(e), scl.set(sh.sx, sh.sy, sh.sx));
      shrubMesh.setMatrixAt(i, m);
      col.setHSL(sh.hsl[0], sh.hsl[1], sh.hsl[2]);
      shrubMesh.setColorAt(i, col);
    });

    for (const [mesh, n] of [[trunkMesh, T.length], [blobMesh, B.length],
                             [pineMesh, P.length], [shrubMesh, S.length],
                             [frondMesh, F.length]]) {
      mesh.count = n;
      mesh.visible = n > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = !far;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  };

  build(false);
  build(true);

  if (shells.length) {
    const shellMesh = new THREE.InstancedMesh(
      makeShellGeo(),
      new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp, side: THREE.DoubleSide }),
      shells.length
    );
    shells.forEach((sh, i) => {
      e.set(sh.tilt, sh.rot, 0);
      m.compose(pos.set(sh.x, sh.y, sh.z), q.setFromEuler(e), scl.set(sh.s, sh.s, sh.s));
      shellMesh.setMatrixAt(i, m);
      col.setHSL(sh.hsl[0], sh.hsl[1], sh.hsl[2]);
      shellMesh.setColorAt(i, col);
    });
    shellMesh.instanceMatrix.needsUpdate = true;
    if (shellMesh.instanceColor) shellMesh.instanceColor.needsUpdate = true;
    // No shadows: a shell is two inches across, and its shadow would be one
    // shadow-map texel of noise scattered nine hundred times.
    shellMesh.castShadow = false;
    shellMesh.frustumCulled = false;
    group.add(shellMesh);
  }

  return group;
}

/**
 * Sea stacks — the lumps of lava left standing offshore when the rest of the
 * headland went.
 *
 * Placed by rejection rather than by walking the coastline: `shoreEdge` already
 * says how far inland any point is, so throwing darts at the water and keeping
 * the ones that land in a band just off the rocks needs no new geometry and
 * cannot drift out of step with where the cliff actually ended up.
 *
 * They are the one thing on this course that sits *in* the water and so the one
 * thing that gives it a scale. Without them the sea is a flat blue plane and
 * could be any size at all.
 */
export function createSeaStacks(toonRamp) {
  const group = new THREE.Group();
  group.name = 'seaStacks';
  if (!OCEAN) return group;

  const rnd = mulberry32(60413);
  const zNear = TEE.z + 30;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.34;
  const picks = [];

  for (let i = 0; i < 900 && picks.length < 34; i++) {
    const z = lerp(zNear, zFar, rnd());
    // Straight out from the centreline, so the darts land in the water rather
    // than mostly inland where they would all be thrown away.
    const out = lerp(6, 120, Math.pow(rnd(), 1.4));
    const x = centreXAt(z) + OCEAN.seaward.x * out + lerp(-24, 24, rnd());
    const zz = z + OCEAN.seaward.z * out;
    const se = shoreEdge(x, zz);
    // Off the rocks but not out to sea: a stack a hundred yards offshore is a
    // island, and this is a coastline, not an archipelago.
    if (se > -6 || se < -95) continue;
    picks.push({ x, z: zz, se });
  }

  if (!picks.length) return group;

  // Four sides, so every stack is a chunk with flat faces that catch the cel
  // ramp differently — a smooth cone would shade as one band and read as a
  // traffic cone.
  const geo = new THREE.ConeGeometry(1, 1, 5, 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const h = hash3(p.getX(i) * 9.1, p.getY(i) * 7.7, p.getZ(i) * 5.3);
    p.setXYZ(i, p.getX(i) * (0.72 + h * 0.56), p.getY(i), p.getZ(i) * (0.72 + h * 0.56));
  }
  geo.computeVertexNormals();
  geo.translate(0, 0.5, 0);

  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp, flatShading: true }),
    picks.length
  );

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  picks.forEach((s, i) => {
    // Bigger close in, where they are the ruins of the cliff, and lower
    // further out where only the stubborn ones are left.
    const near = 1 - Math.min(1, -s.se / 95);
    const r = lerp(2.6, 7.5, rnd()) * lerp(0.6, 1.0, near);
    const h = lerp(5, 21, rnd()) * lerp(0.45, 1.0, near);
    e.set(lerp(-0.10, 0.10, rnd()), rnd() * Math.PI * 2, lerp(-0.10, 0.10, rnd()));
    // Based below the waterline so the sea meets rock rather than a floating rim.
    m.compose(pos.set(s.x, OCEAN.y - 5, s.z), q.setFromEuler(e), scl.set(r, h, r));
    mesh.setMatrixAt(i, m);
    // The same weathered lava as the cliff, and the same spread of tone.
    col.setHSL(0.08, lerp(0.04, 0.10, rnd()), lerp(0.20, 0.33, rnd()));
    mesh.setColorAt(i, col);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------- grass
/**
 * A tuft of three tapered blades, built by hand.
 *
 * Six triangles. That is the whole budget per tuft, because there are tens of
 * thousands of them — the effect comes from density, not from any one tuft
 * being detailed. Each blade is a quad tapering to a point and bent slightly
 * downrange, and the material is double-sided so a tuft reads from any angle
 * without needing back faces in the geometry.
 */
function makeTuftGeo() {
  const pos = [];
  const BLADES = 3;
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + 0.4;
    const dx = Math.cos(a), dz = Math.sin(a);
    const w = 0.075;                    // half-width at the base
    const lean = 0.34 + b * 0.06;       // how far the tip flops over
    const h = 1.0 - b * 0.14;

    // Base corners, perpendicular to the blade's own direction.
    const px = -dz * w, pz = dx * w;
    const b0 = [px, 0, pz];
    const b1 = [-px, 0, -pz];
    // A mid point so the blade can bend, and a tip.
    const m0 = [dx * lean * 0.45 + px * 0.55, h * 0.55, dz * lean * 0.45 + pz * 0.55];
    const m1 = [dx * lean * 0.45 - px * 0.55, h * 0.55, dz * lean * 0.45 - pz * 0.55];
    const tip = [dx * lean, h, dz * lean];

    pos.push(...b0, ...b1, ...m1);
    pos.push(...b0, ...m1, ...m0);
    pos.push(...m0, ...m1, ...tip);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Grass tufts through the rough.
 *
 * Scattered across the band either side of the corridor where the player
 * actually walks, and skipped anywhere the ground is mown, sand, water or
 * concrete. Density falls off with distance from the fairway: near the second
 * cut is where tufts are read against short grass and do the most work, and
 * further out the treeline takes over anyway.
 */
export function createGrass(toonRamp) {
  const group = new THREE.Group();
  group.name = 'grass';
  const rnd = mulberry32(60421);

  const zNear = TEE.z + 14;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.30;
  const tufts = [];

  for (let i = 0; i < 78000; i++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    // Biased inward: most tufts sit just off the short grass.
    const off = lerp(0, 46, Math.pow(rnd(), 1.6));
    const n0 = nearest(centreXAt(z), z);
    const x = centreXAt(z) + side * (fairwayHalfWidth(n0.t) + 1.5 + off);

    const n = nearest(x, z);
    // Only in the rough proper: not on mown grass, and not in a hazard.
    if (n.dist < fairwayHalfWidth(n.t) + 0.8) continue;
    if (greenEdge(x, z) > -1.5) continue;
    if (bunkerEdge(x, z) > -1.0) continue;
    if (pondField(x, z) < 1.15) continue;
    if (!ashore(x, z, 3)) continue;

    // Give way to the pine straw. Under a canopy the ground is needles, not
    // grass, and green tufts standing in brown needles read as a mistake — so
    // this reads the same tree map the terrain shader draws the beds from,
    // rather than guessing from distance. A few stragglers where the coverage
    // is thin look like weeds at the edge of a bed, which is right.
    if (treeDensityAt(x, z) > lerp(0.16, 0.42, rnd())) continue;

    const y = heightAt(x, z);
    if (y < -0.5) continue;

    // Different strains, in broad patches. One turf everywhere is the tell of
    // a generated course; real rough runs thick and coarse in places and thin
    // and wiry in others, and the patches are far bigger than any one tuft.
    // The same field drives how many blades stand here and how big they are,
    // so a thick patch reads as thick from any distance.
    const zone = 0.5 + 0.5 * fbm2(x * 0.026 + 5.7, z * 0.026 - 2.3);
    if (rnd() > 0.55 + 0.55 * zone) continue;

    tufts.push({
      x, y: y - 0.05, z,
      s: lerp(0.38, 0.62, rnd()) * lerp(0.90, 1.50, zone),
      sy: lerp(1.0, 1.6, rnd()) * lerp(0.95, 1.65, zone),
      rot: rnd() * Math.PI * 2,
      v: rnd(),
      zone,
    });
  }

  const mesh = new THREE.InstancedMesh(
    makeTuftGeo(),
    new THREE.MeshToonMaterial({
      color: 0xffffff, gradientMap: toonRamp, side: THREE.DoubleSide,
    }),
    Math.max(1, tufts.length)
  );

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();

  tufts.forEach((t, i) => {
    e.set(0, t.rot, 0);
    m.compose(p.set(t.x, t.y, t.z), q.setFromEuler(e), sc.set(t.s, t.s * t.sy, t.s));
    mesh.setMatrixAt(i, m);
    // A shade deeper and yellower than the turf under them, so a tuft reads as
    // a blade catching light rather than as speckle on the ground. Thick
    // patches go deeper and cooler still: dense enough growth shades its own
    // soil, which is most of why coarse turf looks darker than fine turf.
    col.setHSL(
      lerp(0.21, 0.29, t.v),
      lerp(0.48, 0.64, t.v),
      lerp(0.28, 0.39, t.v) * lerp(1.06, 0.78, t.zone)
    );
    mesh.setColorAt(i, col);
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Deliberately not shadow casters: tens of thousands of tiny casters costs a
  // great deal and buys almost nothing at this size.
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------- buildings
const toon = (color, ramp) => new THREE.MeshToonMaterial({ color, gradientMap: ramp });

/** Soft round alpha sprite, used for the chimney smoke. */
function softPuffTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A lazy plume of chimney smoke — the small moving detail that makes the
 * village feel lived-in, exactly as in the reference. Parented to the cabin,
 * so it inherits its placement for free.
 */
function attachSmoke(parent, local) {
  const tex = softPuffTexture();
  const COUNT = 12;
  const LIFE = 5.2;
  const puffs = [];
  for (let i = 0; i < COUNT; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, fog: true,
      color: 0xf4f8fb, opacity: 0,
    }));
    sp.position.copy(local);
    parent.add(sp);
    // Stagger the starts so the plume is continuous from the first frame.
    puffs.push({ sp, t: (i / COUNT) * LIFE, drift: 0.5 + Math.random() * 0.7 });
  }

  return (dt) => {
    for (const p of puffs) {
      p.t += dt;
      if (p.t > LIFE) p.t -= LIFE;
      const u = p.t / LIFE;
      const rise = u * 9.5;
      p.sp.position.set(
        local.x + Math.sin(u * 3.1 + p.drift * 6) * (0.4 + u * 2.2),
        local.y + rise,
        local.z + Math.cos(u * 2.3 + p.drift * 4) * (0.3 + u * 1.4)
      );
      p.sp.scale.setScalar(0.9 + u * 5.0);
      // Fade in fast off the chimney, then dissolve.
      p.sp.material.opacity = Math.min(1, u / 0.12) * Math.pow(1 - u, 1.5) * 0.5;
    }
  };
}

/** Gable-roofed cabin in the reference's warm-wood palette. */
function makeCabin(w, d, h, ramp, opts = {}) {
  const g = new THREE.Group();
  const wallColor = opts.wall ?? 0xd9a76a;
  const roofColor = opts.roof ?? 0xc25f4a;

  const roofMat = toon(roofColor, ramp);
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(wallColor, ramp));
  body.position.y = h / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // Gable infill: a 3-sided prism capping the box, so the roof has something
  // solid to sit on and you never see daylight underneath it.
  const rise = Math.tan(0.62) * (w / 2);
  const gable = new THREE.Mesh(new THREE.CylinderGeometry(0.001, w * 0.708, rise, 3, 1), toon(wallColor, ramp));
  gable.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  gable.scale.set(1, d / (w * 1.226), 1);
  gable.position.y = h + rise / 2;
  gable.castShadow = true;
  g.add(gable);

  // Roof: two slabs leaning against each other over the gable.
  const slabLen = (w / 2) / Math.cos(0.62) + 1.5;
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(slabLen, 0.30, d + 2.0), roofMat);
    slab.position.set(s * (w / 4) * 1.02, h + rise / 2, 0);
    slab.rotation.z = -s * 0.62;
    slab.castShadow = slab.receiveShadow = true;
    g.add(slab);
    // Fascia along the eave, so the roof has a visible thickness rather than
    // ending in a bare edge.
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.30, d + 2.0), toon(0x8a5a48, ramp));
    fascia.position.set(s * (slabLen / 2 - 0.07), 0, 0);
    slab.add(fascia);
  }

  // Warm windows, framed, with a sill.
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffdf9c });
  const trimMat = toon(0xf3ead8, ramp);
  const ww = w * 0.19, wh = h * 0.28;
  for (const s of [-1, 1]) {
    const cx = s * w * 0.26, cy = h * 0.6;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.16, wh + 0.16, 0.1), trimMat);
    frame.position.set(cx, cy, d / 2 + 0.02);
    frame.castShadow = true;
    g.add(frame);
    const win = new THREE.Mesh(new THREE.BoxGeometry(ww, wh, 0.2), winMat);
    win.position.set(cx, cy, d / 2 + 0.06);
    g.add(win);
    // Glazing bar, and a sill that catches the light.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.045, wh, 0.22), trimMat);
    bar.position.set(cx, cy, d / 2 + 0.07);
    g.add(bar);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.3, 0.075, 0.22), trimMat);
    sill.position.set(cx, cy - wh / 2 - 0.11, d / 2 + 0.08);
    sill.castShadow = true;
    g.add(sill);
  }

  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.17, h * 0.48, 0.2), toon(0x8f6244, ramp));
  door.position.set(0, h * 0.24, d / 2 + 0.04);
  g.add(door);
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(w * 0.17 + 0.14, h * 0.48 + 0.09, 0.1), trimMat);
  doorFrame.position.set(0, h * 0.24 + 0.03, d / 2 + 0.02);
  g.add(doorFrame);

  // Porch: a small roof on two posts over the door, plus a step.
  const porch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, 0.16, 1.5), roofMat);
  porch.position.set(0, h * 0.62, d / 2 + 0.7);
  porch.castShadow = true;
  g.add(porch);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, h * 0.62, 12), trimMat);
    post.position.set(s * w * 0.18, h * 0.31, d / 2 + 1.3);
    post.castShadow = true;
    g.add(post);
  }
  const step = new THREE.Mesh(new THREE.BoxGeometry(w * 0.34, 0.14, 0.8), trimMat);
  step.position.set(0, 0.07, d / 2 + 0.85);
  step.receiveShadow = true;
  g.add(step);

  if (opts.chimney) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3.0, 1.0), toon(0xb9705a, ramp));
    ch.position.set(w * 0.28, h + rise * 0.7, -d * 0.22);
    ch.castShadow = true;
    g.add(ch);
    // Remembered so the caller can hang a smoke plume off the top of it.
    g.userData.chimneyTop = ch.position.clone().setY(ch.position.y + 1.8);
  }
  return g;
}

/** A little clubhouse village off to the left of the tee, like the reference. */
export function createClubhouse(ramp) {
  const group = new THREE.Group();
  group.name = 'clubhouse';

  const place = (obj, x, z, ry, s = 1) => {
    obj.position.set(x, heightAt(x, z) - 0.15, z);
    obj.rotation.y = ry;
    obj.scale.setScalar(s);
    group.add(obj);
  };

  const main = makeCabin(11, 8, 5.0, ramp, { chimney: true });
  place(main, -86, -34, 0.42);
  place(makeCabin(7, 6, 3.8, ramp, { wall: 0xe4b87e, roof: 0xb85742 }), -103, -14, -0.25);
  place(makeCabin(6, 5, 3.4, ramp, { wall: 0xd0a06a, roof: 0xc76a4e }), -71, -11, 0.9, 0.95);

  const smokeTick = attachSmoke(main, main.userData.chimneyTop);

  // Practice-green flags near the village — a spot of colour in the distance.
  for (const [x, z] of [[-92, -52], [-79, -47]]) {
    const y = heightAt(x, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 16), toon(0xf6f6f6, ramp));
    pole.position.set(x, y + 1.2, z);
    group.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.7),
      new THREE.MeshToonMaterial({ color: 0xffcf5c, gradientMap: ramp, side: THREE.DoubleSide })
    );
    flag.position.set(x + 0.55, y + 2.05, z);
    group.add(flag);
  }

  group.userData.tick = smokeTick;
  return group;
}

// ---------------------------------------------------------------- the hole
/** Flagstick + cup, with a softly waving flag. */
export function createFlag(ramp) {
  const group = new THREE.Group();
  group.name = 'flag';
  const gy = heightAt(HOLE_POS.x, HOLE_POS.z);

  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.32, 1.1, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x16281d, side: THREE.DoubleSide })
  );
  cup.position.set(HOLE_POS.x, gy - 0.53, HOLE_POS.z);
  group.add(cup);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 32),
    new THREE.MeshBasicMaterial({ color: 0x0e1a14 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(HOLE_POS.x, gy - 1.05, HOLE_POS.z);
  group.add(floor);

  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.47, 40),
    new THREE.MeshBasicMaterial({ color: 0xeafadd, transparent: true, opacity: 0.9 })
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(HOLE_POS.x, gy + 0.03, HOLE_POS.z);
  group.add(rim);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 3.0, 16), toon(0xfafafa, ramp));
  pole.position.set(HOLE_POS.x, gy + 1.5, HOLE_POS.z);
  pole.castShadow = true;
  group.add(pole);

  const flagGeo = new THREE.PlaneGeometry(1.5, 0.95, 10, 1);
  flagGeo.translate(0.75, 0, 0);
  const flag = new THREE.Mesh(
    flagGeo,
    new THREE.MeshToonMaterial({ color: 0xff8a5c, gradientMap: ramp, side: THREE.DoubleSide })
  );
  flag.position.set(HOLE_POS.x, gy + 2.62, HOLE_POS.z);
  group.add(flag);

  const base = flagGeo.attributes.position.array.slice();
  group.userData.tick = (time) => {
    const p = flagGeo.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      const k = clamp(base[i] / 1.5, 0, 1);
      p[i + 2] = Math.sin(base[i] * 3.2 - time * 4.2) * 0.17 * k;
      p[i + 1] = base[i + 1] + Math.sin(base[i] * 2.1 - time * 3.4) * 0.06 * k;
    }
    flagGeo.attributes.position.needsUpdate = true;
    flagGeo.computeVertexNormals();
  };
  return group;
}

/** Two rounded tee markers, so the first shot has a sense of place. */
export function createTeeMarkers(ramp) {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.19, 24, 18);
  geo.scale(1, 0.85, 1);
  for (const s of [-1, 1]) {
    const x = TEE.x + s * 2.4, z = TEE.z + 1.1;
    const m = new THREE.Mesh(geo, toon(s < 0 ? 0xffffff : 0xff8f63, ramp));
    m.position.set(x, heightAt(x, z) + 0.12, z);
    m.castShadow = true;
    group.add(m);
  }
  return group;
}

// ---------------------------------------------------------------- bridge
/**
 * A stone arch bridge over the creek.
 *
 * The arches are built from voussoirs — a ring of small blocks stepped around
 * a semicircle. Modelling them as actual openings would need the solid to have
 * holes cut in it, which means CSG; stepping blocks around the arc gives the
 * same read for a handful of boxes and no boolean geometry at all.
 *
 * It places itself wherever the creek passes closest to the line of play,
 * which on a hole whose creek crosses in front of the green is exactly where
 * you would walk over it.
 */
export function createBridge(ramp) {
  if (!CREEK || CREEK.pts.length < 2) return null;

  // Find the point on the creek nearest the centreline, and the direction
  // across it there.
  let best = null, bestD = Infinity;
  for (let i = 0; i < CREEK.pts.length - 1; i++) {
    const a = CREEK.pts[i], b = CREEK.pts[i + 1];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
      const d = nearest(x, z).dist;
      if (d < bestD) {
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        bestD = d;
        best = { x, z, nx: -dz / len, nz: dx / len };
      }
    }
  }
  if (!best) return null;

  const g = new THREE.Group();
  g.name = 'bridge';
  g.position.set(best.x, CREEK.y, best.z);
  // Local +X points across the creek, local origin sits at the waterline.
  g.rotation.y = Math.atan2(-best.nz, best.nx);

  const stone = toon(0xbdb6a8, ramp);
  const stoneDark = toon(0x9a9388, ramp);

  // Everything measures off these, rather than off each other. Chaining
  // offsets is how the parapets ended up floating and the abutments ended up
  // hanging past the end of the deck.
  const span = CREEK.w * 2 + 6;    // pier centre to pier centre, outermost
  const deckW = 4.0;               // width of the crossing
  const deckTop = 2.4;             // roadway surface, above the waterline
  const deckThick = 0.38;
  const pierTop = deckTop - deckThick;
  const endW = 2.4, midW = 1.5;    // pier widths

  const box = (w, h, d, cx, cy, cz, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(cx, cy, cz);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // Piers, from the bed up to the underside of the deck.
  for (const [px, pw] of [[-span / 2, endW], [0, midW], [span / 2, endW]]) {
    box(pw, pierTop + 1.2, deckW, px, (pierTop - 1.2) / 2, 0, stoneDark);
  }

  // Two arch rings of voussoirs.
  //
  // Segmental, not semicircular: over an opening this wide a semicircle rises
  // higher than the roadway and the blocks burst up through it. Wide span,
  // shallow rise, crown tucked just under the deck, each block laid along the
  // local tangent of the ellipse.
  const halfOpen = (span - endW - midW) / 4;
  const spring = 0.3;
  const rise = pierTop - 0.15 - spring;
  for (const cx of [-(halfOpen + midW / 2), halfOpen + midW / 2]) {
    const BLOCKS = 13;
    for (let i = 0; i < BLOCKS; i++) {
      const a = Math.PI * (i + 0.5) / BLOCKS;
      const blk = box(
        halfOpen * 0.30, 0.40, deckW + 0.18,
        cx + Math.cos(a) * halfOpen, spring + Math.sin(a) * rise, 0, stone
      );
      blk.rotation.z = Math.atan2(rise * Math.cos(a), -halfOpen * Math.sin(a));
    }
  }

  // Deck: long enough to cover the outer face of both end piers and land on
  // the bank, with a slight overhang.
  const deckLen = span + endW + 2.4;
  box(deckLen, deckThick, deckW + 0.6, 0, deckTop - deckThick / 2, 0, stone);

  // Parapets sitting *on* the deck, inset from its edge.
  const parapetH = 0.7, parapetT = 0.34;
  for (const sgn of [-1, 1]) {
    box(deckLen, parapetH, parapetT,
        0, deckTop + parapetH / 2, sgn * (deckW / 2 + 0.13), stoneDark);
  }

  return g;
}
