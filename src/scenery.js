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
import { OCEAN } from './course.js';
import { COURSE } from './courses.js';
import { mulberry32, lerp, fbm2 } from './util.js';
import { WORLD_CX, WORLD_CZ } from './course.js';

/**
 * Times of day.
 *
 * The sun's offset lives here and nowhere else, which is the whole point of
 * this table. Three files need to agree about where the sun is — this one
 * builds the light, main.js re-aims it at the player every frame so the tight
 * shadow camera follows, and ambience.js points the light shafts down the same
 * vector. They were three hand-copied constants with a comment on each begging
 * the next person to keep them in step. Now there is one.
 *
 * Elevation is the thing being chosen. Low sun means long shadows and a warm
 * key against a cool fill, which is most of why sunrise and sunset look the way
 * they do; the colours follow from that rather than being decoration on top.
 *
 * Every offset keeps roughly the same horizontal bearing, because the cel ramp
 * was tuned against a sun coming from the left — swinging it round would put
 * open turf on a different band and change the look of the whole course.
 */
/**
 * THE BAND, AND WHY THE LOW SUNS ARE BRIGHTER THAN THEY LOOK
 *
 * The ground ramp is sampled at 0.5 + 0.5·dotNL, so flat turf under a sun at
 * elevation e lands on texel floor((0.5 + 0.5·sin e)·16):
 *
 *   38°  →  u 0.81  →  texel 12  →  1.00      (day: what the ramp was tuned to)
 *   23°  →  u 0.70  →  texel 11  →  0.82
 *   21°  →  u 0.68  →  texel 10  →  0.82
 *
 * A low sun therefore loses 18% of its direct term to the band below before
 * any colour is chosen, which is exactly why the first pass at sunrise and
 * sunset came out looking like overcast rather than like low light. Raising
 * the sun to claw it back would cost the long shadows, which are the whole
 * point. So the two low presets carry an intensity multiplied by 1/0.82 ≈ 1.22
 * to land back where day sits — 1.62·1.22 ≈ 1.98, 1.70·1.22 ≈ 2.07.
 *
 * The fill is pulled down and warmed to match. A cool hemisphere at day
 * strength neutralises a warm key: it was the second half of why gold light
 * read as green.
 */
export const TIMES = {
  sunrise: {
    label: 'Sunrise',
    // Low and long. 21° puts shadows about two and a half times the height of
    // whatever casts them.
    sun: [-150, 61, -62],
    // Pale gold rather than orange — sunrise is the cooler of the two ends.
    sunColour: 0xffd9a6,
    sunIntensity: 1.98,
    // Fill stays faintly blue, so lit and shadowed ground split warm/cool.
    hemiSky: 0xc4d6f4,
    hemiGround: 0x9ec489,
    hemiIntensity: 0.92,
    rim: 0xffc9a0,
    fog: 0xf2e2d4,
    sky: [
      [0.00, '#4f86c6'], [0.26, '#8fb6dd'], [0.55, '#dcc6c4'],
      [0.80, '#f6d6b4'], [1.00, '#ffe6c6'],
    ],
  },
  day: {
    label: 'Day',
    // The original. 38°, late morning, and the angle the ground ramp's bands
    // were calibrated against.
    sun: [-135, 114, -55],
    sunColour: 0xfff0cf,
    sunIntensity: 1.78,
    hemiSky: 0xbfdcff,
    hemiGround: 0x93c97e,
    hemiIntensity: 1.14,
    rim: 0xcdecff,
    fog: 0xdcf0fa,
    sky: [
      [0.00, '#5fb4e9'], [0.28, '#8ccdf0'], [0.58, '#b8e2f7'],
      [0.82, '#d9f0fb'], [1.00, '#e9f7fd'],
    ],
  },
  sunset: {
    label: 'Sunset',
    sun: [-146, 68, -58],
    // The warmest key of the three, and the one that has to survive being
    // multiplied into green turf.
    sunColour: 0xffa855,
    sunIntensity: 2.07,
    // Lilac fill. Blue here cancels the gold; lilac lets the shadows go cool
    // without arguing with the key.
    hemiSky: 0xc3a8d4,
    hemiGround: 0x9a8664,
    hemiIntensity: 0.82,
    rim: 0xffa877,
    fog: 0xf0d3c0,
    sky: [
      [0.00, '#3f6fb4'], [0.24, '#7c9bd0'], [0.52, '#d3a9b8'],
      [0.78, '#f7b98a'], [1.00, '#ffd9a3'],
    ],
  },
};

let current = TIMES.day;

/** The active time of day. Read by everything that needs the sun. */
export function timeOfDay() { return current; }

/** Choose a time of day. Takes effect the next time the world is built. */
export function setTimeOfDay(key) {
  current = TIMES[key] ?? TIMES.day;
  return current;
}

export let FOG_COLOR = 0xdcf0fa;

/** Inverted sphere with a vertical gradient painted into it. */
export function createSky() {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  for (const [at, colour] of current.sky) g.addColorStop(at, colour);
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
  FOG_COLOR = current.fog;
  const hemi = new THREE.HemisphereLight(current.hemiSky, current.hemiGround, current.hemiIntensity);
  scene.add(hemi);

  // ~38° elevation — late afternoon. Long shadows are most of what makes
  // low light beautiful, and the ground ramp's top band is wide enough to
  // hold open turf at this angle without it dropping a step (see below).
  // The key is warm and the fill is cool, so lit and shadowed ground differ
  // in hue as well as value rather than just being two brightnesses.
  const sun = new THREE.DirectionalLight(current.sunColour, current.sunIntensity);
  sun.position.set(...current.sun);
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
  // Tight: a soft shadow edge next to a hard cel band looks like two
  // different renderers arguing.
  sun.shadow.radius = 1.2;
  scene.add(sun);
  scene.add(sun.target);

  // Kept deliberately weak — a second directional light adds a second set of
  // bands, and two overlapping ramps read as mush.
  const rim = new THREE.DirectionalLight(current.rim, 0.12);
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
  // Scaled to the form. A fixed amplitude is a decent canopy on a 200-yard
  // ridge and invisible on a 600-yard one, which is what turned the far
  // layers into bare smooth mountains — the wavelength stays put, so this
  // deepens the clumps without asking the mesh for detail it cannot carry.
  const amp = (24 + rnd() * 14) * (0.7 + w / 620);

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

/**
 * A volcano, for the horizon behind an island course.
 *
 * Built as a surface of revolution rather than by bumping a sphere the way the
 * forest ridges are, because the whole shape of one is in its profile: a
 * mountain range is a lumpy mass and a volcano is a curve. Get the curve wrong
 * and no amount of surface detail rescues it.
 *
 * The curve is concave — steep for the first third down from the summit, then
 * flattening the rest of the way out. That is what separates a volcano from a
 * cone: a cone has straight sides and reads as a slag heap or a circus tent,
 * and it is the single most common way this shape is drawn badly.
 *
 * On top of the profile, three things break the symmetry, and it needs all
 * three or it reads as a lathe turning:
 *
 *   the outline is lobed, so the base is not a circle;
 *   rills run down the flanks, deepening toward the bottom where water would
 *     have had the furthest to run;
 *   and the crater is off-centre with one side of its rim blown lower than the
 *     other, which is how they almost always are.
 */
function volcanoGeo(rnd, w, top, d) {
  const RAD = 96;      // around
  const RING = 34;     // summit to base
  const pos = new Float32Array((RAD + 1) * (RING + 1) * 3);
  const idx = new Uint32Array(RAD * RING * 6);

  // Its own character, drawn once so every vertex agrees about it.
  const lobeA = rnd() * Math.PI * 2;
  const lobeB = rnd() * Math.PI * 2;
  const rillPh = rnd() * Math.PI * 2;
  const rills = 9 + Math.floor(rnd() * 9);
  const craterR = 0.055 + rnd() * 0.055;      // fraction of the base radius
  const craterD = top * (0.05 + rnd() * 0.07);
  const breach = rnd() * Math.PI * 2;         // the low side of the rim
  const flank = 1.35 + rnd() * 0.55;          // how concave

  let v = 0;
  for (let j = 0; j <= RING; j++) {
    // Bunched toward the summit, where the curvature is.
    const t = Math.pow(j / RING, 1.35);
    for (let i = 0; i <= RAD; i++) {
      const a = (i / RAD) * Math.PI * 2;

      // Lobed outline, so no two directions off the summit are the same.
      const lobe = 1 + 0.13 * Math.sin(a * 3 + lobeA) + 0.07 * Math.sin(a * 7 + lobeB);
      let r = t * lobe;

      // The profile. 1 at the summit falling to 0 at the base, concave.
      let h = Math.pow(1 - t, flank);

      // Rills: shallow at the top, deep at the bottom.
      const rill = Math.sin(a * rills + rillPh + t * 2.4);
      h -= 0.055 * t * (1 - t) * (rill * 0.5 + 0.5) * 2.0;
      r += 0.035 * t * rill;

      // The crater, and its low side.
      if (t < craterR) {
        const u = t / craterR;
        h -= (craterD / top) * (1 - u * u);
      }
      const rimLow = Math.cos(a - breach) * 0.5 + 0.5;
      if (t < craterR * 1.5) {
        h -= (craterD / top) * 0.55 * rimLow * (1 - t / (craterR * 1.5));
      }

      pos[v] = Math.cos(a) * r * w;
      pos[v + 1] = h * top;
      pos[v + 2] = Math.sin(a) * r * d;
      v += 3;
    }
  }

  let k = 0;
  for (let j = 0; j < RING; j++) {
    for (let i = 0; i < RAD; i++) {
      const a0 = j * (RAD + 1) + i;
      const b0 = a0 + RAD + 1;
      idx[k++] = a0; idx[k++] = b0; idx[k++] = a0 + 1;
      idx[k++] = a0 + 1; idx[k++] = b0; idx[k++] = b0 + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // Sunk, so the skirt of the cone is under the horizon rather than sitting on
  // it like a plate.
  geo.translate(0, -top * 0.06, 0);
  geo.computeVertexNormals();
  return geo;
}

export function createBackdrop(toonRamp) {
  const group = new THREE.Group();
  group.name = 'backdrop';
  const rnd = mulberry32(4471);

  // Where there is open sea, the horizon is the sea. Ridges are dropped from
  // the arc facing out to water — a wall of hills behind an ocean is the one
  // thing that would give away that it is not one.
  const seaA = OCEAN ? Math.atan2(OCEAN.seaward.x, OCEAN.seaward.z) : null;
  // Tested by position, not by angle.
  //
  // An angular window is the obvious test and it does not work: a ridge is up
  // to six hundred yards wide, so one whose *centre* sits comfortably outside
  // the window still hangs most of itself over the water, and opening the
  // window far enough to catch that starts eating the land behind the player.
  // Where the ridge actually stands is the thing that matters, so that is what
  // gets measured — anything on the seaward side of the world, plus a margin
  // for its own width, is dropped.
  // The margin is the piece's own width, not a constant. A fixed margin is
  // wrong at both ends: large enough to hide a fifteen-hundred-yard volcano
  // and it deletes every eight-hundred-yard one on the whole ring, small
  // enough to keep those and the big ones hang over the water again. What is
  // being asked is "does any part of this reach the sea", and that depends on
  // how wide this one is.
  const openWater = (x, z, w) =>
    OCEAN !== null && OCEAN !== undefined &&
    (x - WORLD_CX) * OCEAN.seaward.x + (z - WORLD_CZ) * OCEAN.seaward.z > -w * 0.62;

  // Three layers, near to far. Colour carries the depth, not just fog: each
  // step is lighter, cooler and bluer than the one in front, so the backdrop
  // separates from the warm yellow-green of the course instead of melting into
  // it. Atmospheric perspective in hue, deliberate value contrast against the
  // foreground.
  // An island course has volcanoes behind it, not forest. Fewer of them,
  // much bigger, and standing further back — the whole point of one is that
  // it is a long way off and still fills the sky.
  const LAYERS = COURSE.coastal ? [
    // Kept inside the fog. The scene fogs out entirely at 2600 yards, so a
    // volcano standing further back than that is a white cut-out however it is
    // coloured — and the fog is what tints the backdrop at sunrise and sunset,
    // so putting the backdrop outside it would freeze the horizon at midday.
    // Big and near rather than huge and far.
    { count: 8,  ringR: 820,  top: [260, 400], w: [430, 700],   d: [340, 560],  color: 0x2b4636 },
    { count: 9,  ringR: 1350, top: [400, 600], w: [660, 1050],  d: [520, 840],  color: 0x33544f },
    { count: 10, ringR: 1950, top: [560, 860], w: [920, 1500],  d: [720, 1180], color: 0x3f606c },
  ] : [
    // Cool and clearly darker than the course, but not black: the ramp's
    // shadow band already multiplies these by ~0.48, and the far side of the
    // ring faces away from the sun, so a dark base colour turns the whole
    // horizon into a void when you're playing towards it.
    { count: 18, ringR: 620,  top: [95, 165],  w: [200, 340], d: [130, 210], color: 0x35674a },
    { count: 22, ringR: 1000, top: [150, 250], w: [280, 460], d: [180, 290], color: 0x407061 },
    { count: 26, ringR: 1500, top: [210, 330], w: [380, 620], d: [240, 380], color: 0x577f89 },
  ];

  // One mesh per layer, not one per ridge.
  //
  // A layer's ridges already share a material and never move relative to one
  // another, so they were sixty-six draw calls buying nothing that three could
  // not. Baking each ridge's placement into its vertices and concatenating
  // costs a little memory once, at build time, and hands the GPU one buffer.
  const merge = (geos) => {
    let vTotal = 0, iTotal = 0;
    for (const g of geos) { vTotal += g.attributes.position.count; iTotal += g.index.count; }
    const position = new Float32Array(vTotal * 3);
    const normal = new Float32Array(vTotal * 3);
    const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
    let vo = 0, io = 0;
    for (const g of geos) {
      position.set(g.attributes.position.array, vo * 3);
      normal.set(g.attributes.normal.array, vo * 3);
      const src = g.index.array;
      for (let k = 0; k < src.length; k++) index[io + k] = src[k] + vo;
      vo += g.attributes.position.count;
      io += src.length;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(position, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    return out;
  };

  const place = new THREE.Matrix4();
  for (const L of LAYERS) {
    const mat = new THREE.MeshToonMaterial({ color: L.color, gradientMap: toonRamp });
    const parts = [];
    for (let i = 0; i < L.count; i++) {
      const a = (i / L.count) * Math.PI * 2 + (rnd() - 0.5) * 0.30;
      const r = L.ringR * lerp(0.9, 1.12, rnd());
      // Every draw from `rnd` happens before the skip, so removing a piece
      // never reshuffles the ones that remain.
      const w = lerp(L.w[0], L.w[1], rnd());
      const top = lerp(L.top[0], L.top[1], rnd());
      const d = lerp(L.d[0], L.d[1], rnd());
      const px = WORLD_CX + Math.sin(a) * r;
      const pz = WORLD_CZ + Math.cos(a) * r;
      if (openWater(px, pz, w)) continue;
      const shape = COURSE.coastal ? volcanoGeo : forestRidgeGeo;
      const geo = shape(rnd, w, top, d);
      place.makeRotationY(a);
      place.setPosition(px, 0, pz);
      geo.applyMatrix4(place);
      parts.push(geo);
    }
    if (!parts.length) continue;
    const mesh = new THREE.Mesh(merge(parts), mat);
    // Far too big and far away to take part in the shadow map.
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = -88;
    group.add(mesh);
  }

  // Two low islands far out over the water.
  //
  // The seaward arc is deliberately empty of ridges, and empty is right — but
  // completely empty leaves the horizon with nothing to measure the sea
  // against. These sit at nearly twice the furthest ridge and stand a fifth as
  // tall, so they read as something a long way off rather than as land you
  // could reach.
  if (seaA !== null) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x7d9fb4, fog: false });
    const parts = [];
    const place = new THREE.Matrix4();
    for (let i = 0; i < 2; i++) {
      const a = seaA + (i === 0 ? -0.62 : 0.55) + (rnd() - 0.5) * 0.2;
      const r = 2600 * lerp(0.92, 1.08, rnd());
      const geo = forestRidgeGeo(rnd, lerp(700, 1100, rnd()), lerp(120, 190, rnd()),
                                 lerp(260, 400, rnd()));
      place.makeRotationY(a);
      place.setPosition(WORLD_CX + Math.sin(a) * r, -30, WORLD_CZ + Math.cos(a) * r);
      geo.applyMatrix4(place);
      parts.push(geo);
    }
    const isles = new THREE.Mesh(merge(parts), mat);
    isles.castShadow = isles.receiveShadow = false;
    isles.frustumCulled = false;
    isles.renderOrder = -90;
    group.add(isles);
  }

  return group;
}

// ---------------------------------------------------------------- clouds
/** Soft puffy alpha blob, built from stacked radial gradients. */
function makeCloudTexture() {
  const S = 512;
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

  // Trade-wind cumulus over the water: more of them, bigger, and sitting
  // lower. A coast has weather standing on the horizon in a way an inland
  // course does not, and half of what makes a sea view is what is above it.
  const coastal = !!COURSE.coastal;
  for (let i = 0; i < (coastal ? 34 : 20); i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
      opacity: lerp(0.42, 0.82, rnd()),
      color: new THREE.Color().setHSL(0.58, 0.22, lerp(0.95, 1.0, rnd())),
    });
    const sp = new THREE.Sprite(mat);
    const scale = coastal ? lerp(210, 520, rnd()) : lerp(140, 330, rnd());
    sp.scale.set(scale, scale * (coastal ? lerp(0.46, 0.70, rnd())
                                         : lerp(0.40, 0.58, rnd())), 1);
    sp.position.set(
      lerp(-1100, 1100, rnd()),
      coastal ? lerp(170, 430, rnd()) : lerp(230, 460, rnd()),
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
