/**
 * scenery.js — sky, light, fog, clouds and the painted mountain backdrop.
 *
 * The mountains are the reference image's loudest element, and they're built
 * to look *painted* rather than lit: each facet's colour is baked into vertex
 * colours from a fake sun direction, quantised into three tones, with the snow
 * line and the atmospheric haze mixed in. The material is unlit and unfogged,
 * so what you author is exactly what you see — the same control a matte
 * painter has, which is the whole point of the style.
 */

import * as THREE from 'three';
import { mulberry32, lerp, fbm2 } from './util.js';
import { WORLD_CX, WORLD_CZ } from './course.js';

export const FOG_COLOR = 0xdcf0fa;

/** Inverted sphere with a vertical gradient painted into it. */
export function createSky() {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#5fb4e9');
  g.addColorStop(0.28, '#8ccdf0');
  g.addColorStop(0.58, '#b8e2f7');
  g.addColorStop(0.82, '#d9f0fb');
  g.addColorStop(1.00, '#e9f7fd');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(2600, 32, 20),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  mesh.renderOrder = -100;
  return mesh;
}

/**
 * Lighting tuned for cel banding.
 *
 * Two things matter here. First, the hemisphere light is *indirect* — it is
 * added smoothly and never passes through the toon ramp — so if it dominates
 * it washes the bands out. It's kept just high enough to fill shadows.
 * Second, total light stays near 1.7 rather than 2.5: the tone curve
 * compresses everything above ~0.8, and compression is exactly what smears
 * the top two bands into each other.
 *
 * The sun is low (~34°) and off to the left for long shadows falling right
 * and toward the camera, and the fill is cool blue, so shadows read blue
 * rather than grey — as in the reference.
 */
export function createLights(scene) {
  // Note these look high: three.js divides diffuse by π, so the effective
  // multiplier on albedo is (hemi + sun·ramp)/π. Open ground lands on the
  // 0.78 band → (1.26 + 1.60·0.78)/π ≈ 0.80 of albedo, which is bright
  // without clipping; the deepest band works out near 0.48, so the steps
  // stay clearly separated instead of collapsing into the tone curve.
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8fc776, 1.26);
  scene.add(hemi);

  // ~45° elevation. Lower than this and flat ground never climbs out of a mid
  // band, which drags the whole course dark; much higher and the long shadows
  // that give the reference its shape disappear. 45° puts open ground in the
  // second band from the top, so rolls that tilt sunward pop to full and
  // rolls that tilt away drop a step — broad, deliberate banding on the turf.
  const sun = new THREE.DirectionalLight(0xfff8e8, 1.60);
  sun.position.set(-135, 146, -55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 460;
  const s = 78;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.8;
  sun.shadow.radius = 4;
  scene.add(sun);
  scene.add(sun.target);

  // Kept deliberately weak — a second directional light adds a second set of
  // bands, and two overlapping ramps read as mush.
  const rim = new THREE.DirectionalLight(0xcdecff, 0.12);
  rim.position.set(110, 60, 140);
  scene.add(rim);

  return { hemi, sun, rim };
}

// ---------------------------------------------------------------- forest
/**
 * The backdrop: layered forested ridges instead of a painted sky.
 *
 * These are real toon-shaded geometry, not a matte, so they cel-shade with the
 * exact same ramp as everything else and the horizon never looks like it's
 * from a different game. Each ridge is a squashed sphere displaced by
 * crown-scale noise — that bumpy silhouette is what reads as treetops from a
 * distance, for one smooth mesh instead of thousands of tree instances.
 *
 * Depth comes from fog rather than from baked haze, which is what lets them be
 * lit rather than painted.
 */
function forestRidgeGeo(rnd, w, top, d) {
  // `top` is how high the silhouette should sit; the rest is buried.
  const h = top / 0.72;
  // 112×56 puts vertices about 7 yards apart on these forms.
  const geo = new THREE.SphereGeometry(1, 112, 56);
  geo.scale(w, h, d);

  const p = geo.attributes.position;
  const sa = rnd() * 90, sb = rnd() * 90;
  const amp = 24 + rnd() * 14;

  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // One call only, and a low base frequency. fbm2 stacks harmonics up to
    // 6.3× its base internally, so 0.026 bottoms out near a 38-yard
    // wavelength — five vertices per clump. Ask for finer canopy than the
    // mesh can carry and it aliases into hard triangular facets instead.
    const n = fbm2(x * 0.026 + sa, z * 0.025 + sb);
    // Displace along the true ellipsoid normal so the bumps sit on the surface.
    const gx = x / (w * w), gy = y / (h * h), gz = z / (d * d);
    const gl = Math.hypot(gx, gy, gz) || 1;
    const k = n * amp;
    p.setXYZ(i, x + (gx / gl) * k, y + (gy / gl) * k, z + (gz / gl) * k);
  }

  geo.translate(0, -h * 0.28, 0);
  geo.computeVertexNormals();
  return geo;
}

export function createBackdrop(toonRamp) {
  const group = new THREE.Group();
  group.name = 'backdrop';
  const rnd = mulberry32(4471);

  // Near ridges are discrete with gaps, so the hazier layers behind show
  // through them; far ridges are dense and continuous to close the horizon.
  // Colour carries the depth, not just fog. Each layer steps darker, cooler
  // and bluer than the last, so the backdrop separates from the warm yellow-
  // green of the course instead of melting into it. Atmospheric perspective
  // in hue, deliberate value contrast against the foreground.
  const LAYERS = [
    // Cool and clearly darker than the course, but not black: the ramp's
    // shadow band already multiplies these by ~0.48, and the far side of the
    // ring faces away from the sun, so a dark base colour turns the whole
    // horizon into a void when you're playing towards it.
    { count: 18, ringR: 620,  top: [95, 165],  w: [200, 340], d: [130, 210], color: 0x4d8d61 },
    { count: 22, ringR: 1000, top: [150, 250], w: [280, 460], d: [180, 290], color: 0x559481 },
    { count: 26, ringR: 1500, top: [230, 380], w: [380, 620], d: [240, 380], color: 0x709fb6 },
  ];

  for (const L of LAYERS) {
    const mat = new THREE.MeshToonMaterial({ color: L.color, gradientMap: toonRamp });
    for (let i = 0; i < L.count; i++) {
      const a = (i / L.count) * Math.PI * 2 + (rnd() - 0.5) * 0.30;
      const r = L.ringR * lerp(0.9, 1.12, rnd());
      const mesh = new THREE.Mesh(
        forestRidgeGeo(
          rnd,
          lerp(L.w[0], L.w[1], rnd()),
          lerp(L.top[0], L.top[1], rnd()),
          lerp(L.d[0], L.d[1], rnd())
        ),
        mat
      );
      mesh.position.set(WORLD_CX + Math.sin(a) * r, 0, WORLD_CZ + Math.cos(a) * r);
      mesh.rotation.y = a;
      // Far too big and far away to take part in the shadow map.
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = -88;
      group.add(mesh);
    }
  }

  return group;
}

// ---------------------------------------------------------------- clouds
/** Soft puffy alpha blob, built from stacked radial gradients. */
function makeCloudTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const puffs = [
    [0.50, 0.56, 0.30], [0.32, 0.60, 0.21], [0.68, 0.60, 0.22],
    [0.42, 0.46, 0.20], [0.60, 0.47, 0.18], [0.22, 0.66, 0.14], [0.79, 0.65, 0.13],
  ];
  for (const [cx, cy, r] of puffs) {
    const g = ctx.createRadialGradient(cx * S, cy * S, 0, cx * S, cy * S, r * S);
    g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.68)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx * S, cy * S, r * S, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const CLOUD_TEXTURE = makeCloudTexture;

/**
 * Billboarded clouds. Sprites keep them perfectly soft from any angle and
 * cost nothing — they drift so slowly you only notice between shots.
 */
export function createClouds() {
  const group = new THREE.Group();
  group.name = 'clouds';
  const tex = makeCloudTexture();
  const rnd = mulberry32(9182);
  const drift = [];

  for (let i = 0; i < 20; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
      opacity: lerp(0.42, 0.82, rnd()),
      color: new THREE.Color().setHSL(0.58, 0.22, lerp(0.95, 1.0, rnd())),
    });
    const sp = new THREE.Sprite(mat);
    const scale = lerp(140, 330, rnd());
    sp.scale.set(scale, scale * lerp(0.40, 0.58, rnd()), 1);
    sp.position.set(
      lerp(-1100, 1100, rnd()),
      lerp(230, 460, rnd()),
      lerp(-1500, 400, rnd())
    );
    sp.renderOrder = -50;
    group.add(sp);
    drift.push(lerp(0.6, 2.0, rnd()));
  }

  group.userData.tick = (dt) => {
    group.children.forEach((sp, i) => {
      sp.position.x += drift[i] * dt;
      if (sp.position.x > 1160) sp.position.x = -1160;
    });
  };
  return group;
}
