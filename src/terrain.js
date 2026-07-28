/**
 * terrain.js — the sculpted ground mesh and the pond surface.
 *
 * The mesh is a hand-built grid (rather than PlaneGeometry) so the UVs line up
 * exactly with the baked course texture from course.js.
 *
 * It also carries a custom `aCourse` attribute — (signed distance from the
 * centreline, groove mask, grain mask) — which the material uses to draw the
 * mowing lines and the turf grain per-pixel. Baking detail that fine into the
 * texture would need a 4k+ canvas and would still alias; doing it in the
 * shader keeps it crisp underfoot and lets it fade out cleanly with distance.
 */

import * as THREE from 'three';
import {
  WORLD_SIZE, WORLD_CX, WORLD_CZ, WATER_Y, POND, GREEN, MOW_PERIOD,
  heightAt, makeCourseTexture, nearest, fairwayHalfWidth,
} from './course.js';
import { smoothstep } from './util.js';

/**
 * The cel ramp — the single most important thing about the look.
 *
 * three.js samples this at `dotNL * 0.5 + 0.5`, so texel 0 is fully
 * facing-away and texel 15 is straight at the light. Half the ramp is
 * therefore spent on the unlit hemisphere; the four lit bands are spaced so
 * they come out roughly even in *angle* rather than even in dot product,
 * which is what makes them read as deliberate bands on a curved surface
 * instead of a thin rind around the terminator.
 *
 * The floor is low (0.15) on purpose. Shadow fill comes from the hemisphere
 * light, not from flattening this ramp — that's how you get crisp steps and
 * light, coloured shadows at the same time.
 */
export function makeToonRamp() {
  const steps = [
    0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, // facing away
    0.36, 0.36, 0.36,                               // terminator
    0.56, 0.56,                                     // mid
    0.78, 0.78,                                     // light
    1.00,                                           // highlight
  ];
  const cv = document.createElement('canvas');
  cv.width = steps.length; cv.height = 1;
  const ctx = cv.getContext('2d');
  steps.forEach((v, i) => {
    const c = Math.round(v * 255);
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(i, 0, 1, 1);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The two surface masks the terrain shader needs. They have to be separate
 * values: the green wants no grooves *and* no grain, while the rough wants no
 * grooves but maximum grain — so one mask cannot drive both.
 *
 *   groove — where mowing lines are drawn. Fairway only; the green is cut on
 *            its own pattern, and running the fairway lines across it makes
 *            the two surfaces read as one stretch of grass.
 *   grain  — how rough the turf looks. Full in the rough, a trace on the
 *            fairway so it isn't plastic, zero on the green, which is the
 *            smoothest cut surface on the course.
 */
function surfaceMasks(x, z, n, out) {
  const hw = fairwayHalfWidth(n.t);
  const fair = 1 - smoothstep(hw - 2.5, hw + 2.0, n.dist);
  const gd = Math.hypot(x - GREEN.x, z - GREEN.z);
  const onGreen = 1 - smoothstep(GREEN.r - 2.5, GREEN.r + 1.5, gd);

  out.groove = fair * (1 - onGreen);
  out.grain = (1 - onGreen) * (1 - fair * 0.82);
  return out;
}

export function createTerrain(renderer, toonRamp) {
  const SEG = 256;
  const half = WORLD_SIZE / 2;
  const x0 = WORLD_CX - half;
  const z0 = WORLD_CZ - half;
  const step = WORLD_SIZE / SEG;

  const vertCount = (SEG + 1) * (SEG + 1);
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const course = new Float32Array(vertCount * 3);
  const indices = new Uint32Array(SEG * SEG * 6);

  const masks = { groove: 0, grain: 0 };
  let v = 0, t = 0;
  for (let j = 0; j <= SEG; j++) {
    const z = z0 + j * step;
    for (let i = 0; i <= SEG; i++) {
      const x = x0 + i * step;
      positions[v * 3] = x;
      positions[v * 3 + 1] = heightAt(x, z);
      positions[v * 3 + 2] = z;
      uvs[v * 2] = i / SEG;
      uvs[v * 2 + 1] = 1 - j / SEG; // row 0 = far end of the hole

      // Signed perpendicular distance is exactly linear away from a straight
      // centreline, so it interpolates across these quads without distortion.
      const n = nearest(x, z);
      surfaceMasks(x, z, n, masks);
      course[v * 3] = n.perp;
      course[v * 3 + 1] = masks.groove;
      course[v * 3 + 2] = masks.grain;
      v++;
    }
  }
  for (let j = 0; j < SEG; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * (SEG + 1) + i;
      const b = a + 1;
      const c = a + (SEG + 1);
      const d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aCourse', new THREE.BufferAttribute(course, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const map = new THREE.CanvasTexture(makeCourseTexture(1024));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;

  const mat = new THREE.MeshToonMaterial({ map, gradientMap: toonRamp });

  // Fine mowing grooves, drawn per-pixel and antialiased against the pixel
  // footprint so they never shimmer as they recede.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCourse;
        varying vec3 vCourse;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCourse = aCourse;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCourse;

        // Cheap value noise for turf grain. Prefixed to avoid colliding with
        // anything three.js declares.
        float ccHash(vec2 p) {
          p = fract(p * vec2(127.31, 311.7));
          p += dot(p, p + 34.23);
          return fract(p.x * p.y);
        }
        float ccNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(ccHash(i),                 ccHash(i + vec2(1.0, 0.0)), f.x),
            mix(ccHash(i + vec2(0.0,1.0)), ccHash(i + vec2(1.0, 1.0)), f.x),
            f.y);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float period = ${MOW_PERIOD.toFixed(2)};  // yards between grooves
          float lat = vCourse.x;
          float footprint = fwidth(lat);
          float groove = sin(lat * (6.2831853 / period));
          // Once a groove is finer than the pixel grid, fade it out entirely.
          float aa = 1.0 - smoothstep(period * 0.22, period * 0.60, footprint);
          diffuseColor.rgb *= 1.0 + groove * 0.05 * aa * vCourse.y;
        }
        {
          // --- turf grain -------------------------------------------------
          // The baked texture is ~0.76 yards per texel, which cannot resolve
          // anything at tuft scale, so the close-up roughness lives here.
          // The map UV is a linear function of world XZ, so it doubles as a
          // world-space coordinate for the noise.
          vec2 wp = vMapUv * ${WORLD_SIZE.toFixed(1)};
          float fw = fwidth(wp.x) + fwidth(wp.y);

          // Three scales, each faded out at its *own* Nyquist limit — an
          // octave has to vanish before the pixel footprint reaches half its
          // wavelength, or it aliases and the rough boils as the camera
          // moves. Coarse patches therefore survive far up the hole while
          // tufts drop away within a few yards.
          float patches = ccNoise(wp * 0.10) - 0.5;   // ~10 yd
          float clumps  = ccNoise(wp * 0.40) - 0.5;   // ~2.5 yd
          float tufts   = ccNoise(wp * 1.60) - 0.5;   // ~0.6 yd
          float grain =
            patches * 0.32 * (1.0 - smoothstep(2.5, 5.0,  fw)) +
            clumps  * 0.34 * (1.0 - smoothstep(0.6, 1.25, fw)) +
            tufts   * 0.28 * (1.0 - smoothstep(0.15, 0.31, fw));

          // Full strength in the rough, a trace on mown grass so the fairway
          // still reads as grass rather than plastic.
          grain *= vCourse.z;

          // Warm the bright side and cool the dark side — variation in hue as
          // well as value is what stops it looking like noise on flat paint.
          diffuseColor.rgb *= vec3(1.0 + grain * 1.30, 1.0 + grain, 1.0 + grain * 0.70);
        }`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/**
 * The pond — stylised cel-shaded water.
 *
 * Unlit on purpose. Toon *lighting* on a rippling surface gives you bands that
 * follow the wave normals, which reads as shiny plastic; cartoon water instead
 * wants flat shapes drawn *on* the surface. So the colour is authored directly:
 * a depth gradient from turquoise shallows to deep teal, hard-edged crest
 * highlights drifting across it, and a foam line hugging the shore.
 *
 * Everything animates in the shader from one `uTime` uniform, so there's no
 * per-frame vertex work and no normal recomputation at all.
 */
export function createWater() {
  const SEG = 64;
  // The plane overhangs the pond; the shader discards everything outside the
  // ellipse, so the waterline is the true shore rather than a square edge.
  const geo = new THREE.PlaneGeometry(POND.rx * 2.15, POND.rz * 2.15, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uTime: { value: 0 },
    uRadii: { value: new THREE.Vector2(POND.rx, POND.rz) },
    uDeep: { value: new THREE.Color(0x1c6b86) },
    uShallow: { value: new THREE.Color(0x63cbd8) },
    uCrest: { value: new THREE.Color(0xd6f4fa) },
    uFoam: { value: new THREE.Color(0xffffff) },
  };

  const mat = new THREE.MeshBasicMaterial({ transparent: true });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec2 uRadii;
        varying vec2 vLocal;
        varying float vField;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = vec2(position.x, position.z);
        // 1.0 is exactly the shoreline.
        vField = length(vLocal / uRadii);
        transformed.y +=
          0.16 * sin(position.x * 0.13 + uTime * 0.55) +
          0.11 * sin(position.z * 0.17 - uTime * 0.42) +
          0.07 * sin((position.x + position.z) * 0.09 + uTime * 0.80);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uCrest;
        uniform vec3 uFoam;
        varying vec2 vLocal;
        varying float vField;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // Outside the ellipse there is no pond — cut it rather than letting
        // the plane's corners float over the grass.
        if (vField > 1.0) discard;

        float depth = 1.0 - smoothstep(0.0, 1.0, vField);
        vec3 water = mix(uShallow, uDeep, depth);

        // Crests: two slow waves summed, then thresholded. The hard edge is
        // the whole point — soft highlights would read as specular, these
        // read as drawn shapes.
        float wave = sin(vLocal.x *  0.22 + vLocal.y * 0.10 + uTime * 0.90) * 0.6
                   + sin(vLocal.x * -0.13 + vLocal.y * 0.27 - uTime * 0.60) * 0.4;
        water = mix(water, uCrest, smoothstep(0.50, 0.58, wave) * 0.50);

        // A finer, faster set so the surface never looks frozen.
        float sparkle = sin(vLocal.x * 0.55 - vLocal.y * 0.42 + uTime * 1.60);
        water = mix(water, uCrest, smoothstep(0.84, 0.90, sparkle) * 0.42);

        // Foam hugging the shore, its width wobbling around the perimeter so
        // the ring never looks like a stroked ellipse. The epsilon keeps atan
        // defined at the exact centre.
        float wobble = sin(atan(vLocal.y + 1e-4, vLocal.x + 1e-4) * 9.0 + uTime * 0.70) * 0.022;
        float foam = smoothstep(0.90 + wobble, 0.963 + wobble, vField)
                   * (1.0 - smoothstep(0.985, 1.0, vField));
        water = mix(water, uFoam, foam);

        diffuseColor.rgb = water;
        // Shallows are more see-through; foam is nearly solid.
        diffuseColor.a = max(mix(0.74, 0.93, depth), foam * 0.95);`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(POND.x, WATER_Y, POND.z);
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  mesh.userData.tick = (time) => { uniforms.uTime.value = time; };
  return mesh;
}
