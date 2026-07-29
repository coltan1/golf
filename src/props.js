/**
 * props.js — everything that dresses the hole: trees, the clubhouse village,
 * the flagstick and the tee markers.
 *
 * Trees are instanced (3 draw calls for ~1500 pieces of geometry) and their
 * placement is filtered through course.js, so nothing ever grows on the
 * fairway, in a bunker, or out of the pond.
 */

import * as THREE from 'three';
import { mulberry32, lerp, hash3, clamp } from './util.js';
import {
  heightAt, nearest, centreXAt, fairwayHalfWidth, bunkerField, pondField,
  GREEN, HOLE_POS, TEE, WORLD_CX, WORLD_CZ, WORLD_SIZE,
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
function makeCanopyGeo() {
  const geo = new THREE.IcosahedronGeometry(1, 2);
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
 * Conifer built from one lathe. The profile bulges and pinches to make the
 * rounded tiers, then each tier's rim is scalloped around its circumference
 * so the silhouette is bumpy rather than a clean surface of revolution —
 * that lumpy branch edge is a lot of what sells the reference tree.
 *
 * Geometry stays indexed and smooth-normalled: with a hard cel ramp, smooth
 * normals are what produce clean curved bands. Flat shading would give you
 * facets instead, which is a different (and busier) look.
 */
function makePineGeo() {
  const profile = [
    [0.00, 0.00], [1.55, 0.05], [1.95, 0.34], [1.70, 0.74], [1.24, 1.04],
    [1.72, 1.34], [1.86, 1.64], [1.55, 2.04], [1.10, 2.34],
    [1.48, 2.64], [1.58, 2.94], [1.28, 3.34], [0.92, 3.64],
    [1.22, 3.94], [1.28, 4.24], [1.00, 4.64], [0.68, 4.94],
    [0.90, 5.24], [0.88, 5.54], [0.62, 5.94], [0.34, 6.35],
    [0.14, 6.80], [0.00, 7.10],
  ].map(([x, y]) => new THREE.Vector2(x, y));

  // 24 segments with 6 lobes gives exactly 4 samples per scallop — any
  // frequency that divides the segment count lands on the zero crossings and
  // the scallop silently disappears.
  const SEGS = 32, LOBES = 6;
  const geo = new THREE.LatheGeometry(profile, SEGS);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    // Scallop strength rises with radius, so the tier rims bump out while the
    // pinched waists between them stay tight.
    const theta = Math.atan2(z, x);
    const k = 1 + Math.sin(theta * LOBES) * 0.11 * Math.min(1, r / 1.2);
    p.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- trees
/** Is this a legal, sensible spot for a tree? */
function plantable(x, z) {
  const n = nearest(x, z);
  // Keep a generous mown apron either side — this is a golf hole, not a wood.
  if (n.dist < fairwayHalfWidth(n.t) + 20) return false;
  if (Math.hypot(x - GREEN.x, z - GREEN.z) < GREEN.r + 17) return false;
  if (Math.hypot(x - TEE.x, z - TEE.z) < 26) return false;
  if (bunkerField(x, z) < 1.7) return false;
  if (pondField(x, z) < 1.3) return false;
  // Keep the corridor behind the tee clear for the opening camera move.
  if (z > 8 && Math.abs(x) < 32) return false;
  return true;
}

export function createTrees(toonRamp) {
  const group = new THREE.Group();
  group.name = 'trees';
  const rnd = mulberry32(20250727);

  const trunks = [];
  const blobs = [];
  const pines = [];

  const plant = (x, z, sizeScale) => {
    if (!plantable(x, z)) return;
    const y = heightAt(x, z);
    if (y < -0.5) return; // never standing in the pond bed

    if (rnd() < 0.62) {
      const s = lerp(0.72, 1.25, rnd()) * sizeScale;
      pines.push({ x, y: y - 0.2, z, s, rot: rnd() * Math.PI * 2, v: rnd() });
      return;
    }

    const s = lerp(0.85, 1.35, rnd()) * sizeScale;
    trunks.push({ x, y, z, s, rot: rnd() * Math.PI * 2 });
    // 2–3 overlapping blobs make a soft, full canopy.
    const n = rnd() < 0.55 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = i === 0 ? 0 : lerp(0.5, 1.15, rnd());
      blobs.push({
        x: x + Math.cos(a) * r * s,
        y: y + (3.1 + (i === 0 ? 0.5 : lerp(-0.35, 1.0, rnd()))) * s,
        z: z + Math.sin(a) * r * s,
        s: (i === 0 ? lerp(1.9, 2.4, rnd()) : lerp(1.3, 1.9, rnd())) * s,
        rot: rnd() * Math.PI * 2,
        v: rnd(),
      });
    }
  };

  // The hole decides how much ground there is to plant.
  const zNear = TEE.z + 20;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.44;

  // Pass A — sparse specimen trees framing the corridor. Offsets are measured
  // from the centreline, so the tree line curves with the dogleg.
  for (let i = 0; i < 190; i++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    const off = lerp(34, 92, Math.pow(rnd(), 0.6));
    plant(centreXAt(z) + side * off + lerp(-6, 6, rnd()), z + lerp(-8, 8, rnd()), 1);
  }

  // Pass B — the treeline proper, further out, quietly closing the world off.
  for (let i = 0; i < 380; i++) {
    const z = lerp(zNear + 40, zFar - 30, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    plant(centreXAt(z) + side * lerp(105, 200, rnd()), z, lerp(0.9, 1.3, rnd()));
  }

  // Pass C — a scattered far forest that melts into the fog.
  for (let i = 0; i < 380; i++) {
    const a = rnd() * Math.PI * 2;
    const r = lerp(WORLD_SIZE * 0.24, WORLD_SIZE * 0.40, rnd());
    plant(WORLD_CX + Math.sin(a) * r, WORLD_CZ + Math.cos(a) * r, lerp(1.0, 1.5, rnd()));
  }

  // ------------------------------------------------------------ build meshes
  const trunkGeo = new THREE.CylinderGeometry(0.26, 0.42, 3.6, 20, 1);
  trunkGeo.translate(0, 1.8, 0);

  const meshes = {
    trunk: new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshToonMaterial({ color: 0x8d6547, gradientMap: toonRamp }),
      Math.max(1, trunks.length)
    ),
    blob: new THREE.InstancedMesh(
      makeCanopyGeo(),
      new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp }),
      Math.max(1, blobs.length)
    ),
    pine: new THREE.InstancedMesh(
      makePineGeo(),
      new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp }),
      Math.max(1, pines.length)
    ),
  };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  trunks.forEach((t, i) => {
    e.set(0, t.rot, 0);
    m.compose(pos.set(t.x, t.y, t.z), q.setFromEuler(e), scl.set(t.s, t.s, t.s));
    meshes.trunk.setMatrixAt(i, m);
  });

  blobs.forEach((b, i) => {
    e.set(lerp(-0.16, 0.16, b.v), b.rot, lerp(0.16, -0.16, b.v));
    m.compose(pos.set(b.x, b.y, b.z), q.setFromEuler(e), scl.set(b.s, b.s * 0.94, b.s));
    meshes.blob.setMatrixAt(i, m);
    // Vary leaf colour gently — vibrant, but never noisy.
    // Saturated and mid-toned: a pale canopy has nowhere for the ramp's bands
    // to land, and the tree flattens into a silhouette.
    col.setHSL(lerp(0.245, 0.31, b.v), lerp(0.46, 0.60, b.v), lerp(0.44, 0.32, b.v));
    meshes.blob.setColorAt(i, col);
  });

  pines.forEach((p, i) => {
    e.set(0, p.rot, 0);
    m.compose(pos.set(p.x, p.y, p.z), q.setFromEuler(e), scl.set(p.s, p.s * lerp(0.9, 1.2, p.v), p.s));
    meshes.pine.setMatrixAt(i, m);
    col.setHSL(lerp(0.29, 0.35, p.v), lerp(0.42, 0.54, p.v), lerp(0.40, 0.28, p.v));
    meshes.pine.setColorAt(i, col);
  });

  for (const mesh of Object.values(meshes)) {
    mesh.count = mesh === meshes.trunk ? Math.max(1, trunks.length)
               : mesh === meshes.blob ? Math.max(1, blobs.length)
               : Math.max(1, pines.length);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return group;
}

// ---------------------------------------------------------------- buildings
const toon = (color, ramp) => new THREE.MeshToonMaterial({ color, gradientMap: ramp });

/** Soft round alpha sprite, used for the chimney smoke. */
function softPuffTexture() {
  const S = 64;
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
  const slabLen = (w / 2) / Math.cos(0.62) + 1.0;
  const roofMat = toon(roofColor, ramp);
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(slabLen, 0.34, d + 1.6), roofMat);
    slab.position.set(s * (w / 4) * 1.02, h + rise / 2, 0);
    slab.rotation.z = -s * 0.62;
    slab.castShadow = slab.receiveShadow = true;
    g.add(slab);
  }

  // Warm windows and a door.
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffdf9c });
  for (const s of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(w * 0.19, h * 0.28, 0.2), winMat);
    win.position.set(s * w * 0.26, h * 0.6, d / 2 + 0.02);
    g.add(win);
  }
  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.17, h * 0.48, 0.2), toon(0x8f6244, ramp));
  door.position.set(0, h * 0.24, d / 2 + 0.02);
  g.add(door);

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
