/**
 * ambience.js — the things that are not the golf course but make it feel like
 * a place: shafts of light through the pines, butterflies over the azaleas,
 * and pollen drifting in the sun.
 *
 * All three are unlit and additive or alpha-tested, and none of them casts or
 * receives a shadow. They are atmosphere, and atmosphere that participates in
 * the lighting solution stops reading as atmosphere and starts reading as
 * geometry someone forgot to finish.
 */

import * as THREE from 'three';
import { mulberry32, lerp } from './util.js';
import { timeOfDay } from './scenery.js';
import {
  heightAt, centreXAt, fairwayHalfWidth, nearest, TEE, WORLD_CZ, WORLD_SIZE,
} from './course.js';

// Light travels the opposite way to the sun's offset. Derived rather than
// written out, so shafts cannot end up pointing somewhere the sun is not —
// which is exactly what would happen the first time the time of day changed.
function sunDir() {
  const [x, y, z] = timeOfDay().sun;
  return new THREE.Vector3(-x, -y, -z).normalize();
}

// ---------------------------------------------------------------- sun shafts
/**
 * A soft wedge of light, brightest along its spine and fading to nothing at
 * both ends. Drawn into a canvas rather than built from vertex colours so the
 * falloff is smooth in both axes at once.
 */
function shaftTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    // Along the shaft: fade in from the canopy, fade out before the ground.
    const t = y / (S - 1);
    const along = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.7;
    for (let x = 0; x < S; x++) {
      // Across the shaft: a soft core with no hard edge anywhere.
      const u = (x / (S - 1)) * 2 - 1;
      const across = Math.exp(-u * u * 3.4);
      const a = along * across;
      const i = (y * S + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 252; img.data[i + 2] = 232;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Shafts of light coming down through the trees.
 *
 * Each shaft is one quad whose long axis is locked to the sun direction and
 * which spins about that axis to stay as face-on to the camera as it can. A
 * quad that does not do this disappears whenever you happen to view it edge-on,
 * which on a camera that orbits is most of the time.
 */
export function createSunRays() {
  const group = new THREE.Group();
  group.name = 'sunrays';
  const rnd = mulberry32(770411);

  const tex = shaftTexture();
  const geo = new THREE.PlaneGeometry(1, 1);
  const shafts = [];
  const zNear = TEE.z - 30;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.28;

  // Fewer, because each one is a large additive quad and overlapping
  // translucency is fill rate, which is exactly what a modest GPU runs out
  // of first. Fifteen still reads as shafts through a canopy.
  for (let i = 0; i < 15; i++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    const n = nearest(centreXAt(z), z);
    // Out over the treeline, where there is a canopy for them to come through.
    const x = centreXAt(z) + side * (fairwayHalfWidth(n.t) + lerp(8, 62, rnd()));
    const len = lerp(52, 96, rnd());
    // A material each. They share the one texture, so this is cheap, and it is
    // the only way each shaft can brighten and fade on its own clock — with a
    // shared material the best you can do is average them, which reads as the
    // whole forest pulsing at once.
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,       // never occlude anything, only add to it
      side: THREE.DoubleSide,
      opacity: 0.3,
      toneMapped: false,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    shafts.push({
      mesh,
      // Anchor high: the shaft hangs from the canopy down toward the ground.
      anchor: new THREE.Vector3(x, heightAt(x, z) + lerp(30, 52, rnd()), z),
      len,
      wide: lerp(3.5, 9.0, rnd()),
      phase: rnd() * Math.PI * 2,
      rate: lerp(0.11, 0.26, rnd()),
    });
  }

  const cam = new THREE.Vector3();
  const axis = sunDir();
  const toCam = new THREE.Vector3();
  const wide = new THREE.Vector3();
  const face = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const scale = new THREE.Matrix4();
  const trans = new THREE.Matrix4();

  let t = 0;
  group.userData.tick = (dt, camera) => {
    t += dt;
    camera.getWorldPosition(cam);
    for (const s of shafts) {
      // Centre of the shaft, half its length down the sun vector.
      centre.copy(axis).multiplyScalar(s.len * 0.5).add(s.anchor);
      toCam.subVectors(cam, centre);

      // Spin about the sun axis until the quad's normal points at the camera.
      wide.crossVectors(axis, toCam);
      if (wide.lengthSq() < 1e-6) continue;   // dead on the axis; leave it be
      wide.normalize();
      face.crossVectors(wide, axis).normalize();

      basis.makeBasis(wide, axis, face);
      // The plane's own +Y must run *down* the shaft, so scale y by its length.
      trans.makeTranslation(centre.x, centre.y, centre.z);
      scale.makeScale(s.wide, s.len, 1);
      s.mesh.matrix.multiplyMatrices(trans, basis).multiply(scale);
      s.mesh.matrixWorldNeedsUpdate = true;

      // Breathe, so they are never quite static.
      s.mesh.material.opacity = 0.30 * (0.55 + 0.45 * Math.sin(t * s.rate + s.phase));
    }
  };

  return group;
}

// ---------------------------------------------------------------- butterflies
/** One wing: a rounded blade hinged along its inner edge at x = 0. */
function wingTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  // Two lobes, the forewing larger than the hind, which is what makes a
  // silhouette read as a butterfly rather than as a leaf.
  ctx.beginPath();
  ctx.ellipse(S * 0.42, S * 0.34, S * 0.40, S * 0.28, -0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(S * 0.34, S * 0.70, S * 0.31, S * 0.24, 0.18, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Butterflies over the flower beds.
 *
 * Two instances each — a left wing and a right wing hinged along the body —
 * rather than one billboarded sprite. Real orientation is worth the extra
 * instance: a butterfly that banks as it turns and shows its wings edge-on at
 * the top of a flap reads as alive, and a sprite that always faces you never
 * quite does.
 */
export function createButterflies() {
  const group = new THREE.Group();
  group.name = 'butterflies';
  const rnd = mulberry32(31882);

  const COUNT = 70;
  const flies = [];
  const zNear = TEE.z - 10;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.30;

  for (let i = 0; i < COUNT; i++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    const n = nearest(centreXAt(z), z);
    // Along the edge of the corridor, which is where the azaleas are.
    const x = centreXAt(z) + side * (fairwayHalfWidth(n.t) + lerp(2, 34, rnd()));
    const y = heightAt(x, z);
    if (y < -0.5) { continue; }
    flies.push({
      home: new THREE.Vector3(x, y, z),
      // Each one wanders its own ellipse at its own rate, so no two ever
      // fall into step.
      rx: lerp(3, 11, rnd()), rz: lerp(3, 11, rnd()),
      w1: lerp(0.14, 0.34, rnd()), w2: lerp(0.21, 0.48, rnd()),
      ph: rnd() * Math.PI * 2, ph2: rnd() * Math.PI * 2,
      bob: lerp(0.5, 1.6, rnd()),
      hover: lerp(1.1, 3.4, rnd()),
      flap: lerp(9, 15, rnd()),
      size: lerp(0.34, 0.55, rnd()),
      hue: rnd(),
    });
  }

  const geo = new THREE.PlaneGeometry(1, 0.82);
  geo.rotateX(-Math.PI / 2);       // lie flat, so the hinge is a body axis
  geo.translate(0.5, 0, 0);        // hinge at x = 0, wing extends along +x

  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: wingTexture(),
      transparent: true,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
    Math.max(2, flies.length * 2)
  );
  mesh.frustumCulled = false;
  mesh.castShadow = false;

  const col = new THREE.Color();
  flies.forEach((f, i) => {
    // Whites, sulphurs and a few orange fritillaries.
    if (f.hue < 0.45) col.setHSL(lerp(0.12, 0.17, f.hue), 0.22, 0.94);
    else if (f.hue < 0.8) col.setHSL(lerp(0.13, 0.16, f.hue), 0.85, 0.72);
    else col.setHSL(lerp(0.04, 0.08, f.hue), 0.82, 0.60);
    mesh.setColorAt(i * 2, col);
    mesh.setColorAt(i * 2 + 1, col);
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);

  const pos = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const mT = new THREE.Matrix4();
  const mY = new THREE.Matrix4();
  const mZ = new THREE.Matrix4();
  const mS = new THREE.Matrix4();
  const m = new THREE.Matrix4();

  let t = 0;
  group.userData.tick = (dt) => {
    t += dt;
    flies.forEach((f, i) => {
      // Where it is now, and where it was a moment ago — the difference is
      // which way it is pointing.
      const at = (u) => pos.set(
        f.home.x + Math.cos(u * f.w1 + f.ph) * f.rx,
        f.home.y + f.hover + Math.sin(u * f.w2 * 2.3 + f.ph2) * f.bob,
        f.home.z + Math.sin(u * f.w2 + f.ph2) * f.rz
      );
      at(t); prev.copy(pos);
      at(t - 0.08);
      const yaw = Math.atan2(prev.x - pos.x, prev.z - pos.z);
      at(t);

      // Wings sweep through most of a right angle and pause at the top, which
      // is roughly what a real one does.
      const flap = Math.sin(t * f.flap + f.ph) * 0.72 + 0.45;

      mT.makeTranslation(pos.x, pos.y, pos.z);
      mY.makeRotationY(yaw);
      for (let w = 0; w < 2; w++) {
        const sgn = w === 0 ? 1 : -1;
        mZ.makeRotationZ(flap * sgn);
        // Mirroring by a negative scale is what makes the second wing; the
        // material is DoubleSide, so the flipped winding does not matter.
        mS.makeScale(f.size * sgn, f.size, f.size);
        m.multiplyMatrices(mT, mY).multiply(mZ).multiply(mS);
        mesh.setMatrixAt(i * 2 + w, m);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  return group;
}

// ---------------------------------------------------------------- pollen
/**
 * Motes drifting in the light.
 *
 * Points rather than quads: they are a pixel or two across and never need an
 * orientation, and a hundred of them cost nothing. They rise slowly and wrap
 * around, so the field never empties.
 */
export function createMotes() {
  const group = new THREE.Group();
  group.name = 'motes';
  const rnd = mulberry32(9981);

  const COUNT = 260;
  const pos = new Float32Array(COUNT * 3);
  const seed = [];
  const zNear = TEE.z - 20;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.30;

  for (let i = 0; i < COUNT; i++) {
    const z = lerp(zNear, zFar, rnd());
    const x = centreXAt(z) + lerp(-70, 70, rnd());
    const base = heightAt(x, z);
    pos[i * 3] = x;
    pos[i * 3 + 1] = base + lerp(1, 16, rnd());
    pos[i * 3 + 2] = z;
    seed.push({ base, rise: lerp(0.25, 0.9, rnd()), sway: lerp(0.3, 1.2, rnd()), ph: rnd() * 6.28 });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const sprite = (() => {
    const S = 128, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,250,224,1)');
    g.addColorStop(1, 'rgba(255,250,224,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tx = new THREE.CanvasTexture(cv);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  })();

  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    map: sprite,
    size: 0.5,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.75,
    toneMapped: false,
  }));
  points.frustumCulled = false;
  group.add(points);

  let t = 0;
  group.userData.tick = (dt) => {
    t += dt;
    const a = geo.attributes.position;
    for (let i = 0; i < COUNT; i++) {
      const s = seed[i];
      let y = a.getY(i) + s.rise * dt;
      if (y > s.base + 18) y = s.base + 0.5;   // wrap, so it never runs dry
      a.setY(i, y);
      a.setX(i, a.getX(i) + Math.sin(t * 0.5 + s.ph) * s.sway * dt);
    }
    a.needsUpdate = true;
  };

  return group;
}
