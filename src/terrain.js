/**
 * terrain.js — the sculpted ground mesh and the pond surface.
 *
 * The mesh is a hand-built grid (rather than PlaneGeometry) so the UVs line up
 * exactly with the baked course texture from course.js.
 *
 * It also carries a custom `aCourse` attribute — signed distance from the
 * centreline, and signed distance to the fairway and green edges — which the
 * material uses to draw the mowing lines, the cut seams, the turf grain and
 * the cart path per-pixel. Baking detail that fine into the texture would need
 * a 4k+ canvas and would still alias; doing it in the shader keeps it crisp
 * underfoot and lets it fade out cleanly with distance.
 */

import * as THREE from 'three';
import {
  WORLD_SIZE, WORLD_CX, WORLD_CZ, WATER_Y, POND, MOW_PERIOD, CART_PATH,
  SURFACE_COLORS, heightAt, makeCourseTexture, nearest, fairwayHalfWidth, greenEdge,
  bunkerEdge,
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
 * Signed distance, in yards, to each mowing boundary — positive inside.
 *
 * Raw distances rather than pre-blended masks, because the fragment shader
 * needs to sharpen them against its own pixel footprint. A mask baked at
 * vertex resolution is already blurred over ~2 yards of ground by the time it
 * interpolates, and no amount of shader work gets that edge back.
 */
function surfaceEdges(x, z, n, out) {
  out.fair = fairwayHalfWidth(n.t) - n.dist;
  out.green = greenEdge(x, z);
  out.sand = bunkerEdge(x, z);
  return out;
}

/** Surface colours the shader needs to rebuild a hard edge, in linear space. */
function colorUniform(rgb) {
  return new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
}

/**
 * A separate ramp for the ground.
 *
 * Sharing the prop ramp is what made the turf look wrong. Open ground sits at
 * dotNL ≈ 0.71 under a 45° sun, which lands almost exactly on a step, so a
 * slope of six degrees — less undulation than any real fairway has — tips a
 * patch into the next band. The result is bands wandering across the fairway
 * as soft blotches that read as a rendering fault.
 *
 * So this ramp holds *one* value across everything roughly sun-facing. Flat
 * turf and gently rolling turf then shade identically, while genuinely steep
 * ground — bunker faces, mounding, the shoulders of a green — still drops a
 * band and keeps its shape. The terminator stays hard, so it is still cel.
 */
export function makeGroundRamp() {
  const steps = [
    0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, // facing away
    0.46, 0.46, 0.46,                               // steep, turned away
    0.72, 0.72,                                     // moderately tilted
    1.00, 1.00, 1.00,                               // anything roughly sunward
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

export function createTerrain(renderer, toonRamp) {
  // ~2.4 yards per quad, whatever the hole's extent. Fine enough that no
  // triangle reads as a triangle, and that a bunker bowl gets eight or ten
  // quads across it instead of three.
  const SEG = Math.round(WORLD_SIZE / 2.4);
  const half = WORLD_SIZE / 2;
  const x0 = WORLD_CX - half;
  const z0 = WORLD_CZ - half;
  const step = WORLD_SIZE / SEG;

  const vertCount = (SEG + 1) * (SEG + 1);
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const course = new Float32Array(vertCount * 4);
  const indices = new Uint32Array(SEG * SEG * 6);

  const edges = { fair: 0, green: 0, sand: 0 };
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
      surfaceEdges(x, z, n, edges);
      course[v * 4] = n.perp;
      course[v * 4 + 1] = edges.fair;
      course[v * 4 + 2] = edges.green;
      course[v * 4 + 3] = edges.sand;
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
  geo.setAttribute('aCourse', new THREE.BufferAttribute(course, 4));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const map = new THREE.CanvasTexture(makeCourseTexture(1024));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;

  const mat = new THREE.MeshToonMaterial({ map, gradientMap: toonRamp });

  // Everything the baked texture cannot hold: crisp mowing seams, fine
  // grooves, turf grain and cart-path detail — all drawn per-pixel and
  // antialiased against the pixel footprint so nothing shimmers as it recedes.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRough  = { value: colorUniform(SURFACE_COLORS.roughAlt) };
    shader.uniforms.uFairA  = { value: colorUniform(SURFACE_COLORS.fairA) };
    shader.uniforms.uFairB  = { value: colorUniform(SURFACE_COLORS.fairB) };
    shader.uniforms.uCollar = { value: colorUniform(SURFACE_COLORS.collar) };
    shader.uniforms.uGreen  = { value: colorUniform(SURFACE_COLORS.greenA) };
    shader.uniforms.uSand   = { value: colorUniform(SURFACE_COLORS.sand) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aCourse;
        varying vec4 vCourse;
        varying vec2 vWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCourse = aCourse;
        vWorld = position.xz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vCourse;
        varying vec2 vWorld;
        uniform vec3 uRough;
        uniform vec3 uSand;
        uniform vec3 uFairA;
        uniform vec3 uFairB;
        uniform vec3 uCollar;
        uniform vec3 uGreen;

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
        }
        // A band centred on d = 0, never thinner than one pixel, and faded
        // out once a pixel spans so much ground that it would read as a smear.
        float ccSeam(float d, float minWidth) {
          float fp = fwidth(d);
          float w = max(minWidth, fp * 1.2);
          float k = d / w;
          return exp(-k * k) * (1.0 - smoothstep(1.2, 3.5, fp));
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          // Signed yards inside each mown surface, sharpened per-pixel. Doing
          // the threshold here rather than at vertices is what keeps a mowing
          // line looking like a line right under the camera.
          float fe = vCourse.y;
          float ge = vCourse.z;
          float fairM  = smoothstep(-fwidth(fe), fwidth(fe), fe);
          float greenM = smoothstep(-fwidth(ge), fwidth(ge), ge);
          float offGreen = 1.0 - greenM;

          // --- cart path ---------------------------------------------------
          float pd = abs(vCourse.x + ${CART_PATH.offset.toFixed(1)});
          float inZ = step(${CART_PATH.zTo.toFixed(1)}, vWorld.y)
                    * step(vWorld.y, ${CART_PATH.zFrom.toFixed(1)});
          float pathM = (1.0 - smoothstep(
            ${(CART_PATH.halfWidth - 0.35).toFixed(2)},
            ${(CART_PATH.halfWidth + 0.35).toFixed(2)}, pd)) * inZ;

          // Expansion joints every few yards, plus a crisp shadowed edge where
          // the slab meets turf. Both are far too fine for the baked texture.
          float joint = ccSeam(fract(vWorld.y / 7.5) - 0.5, 0.035) * pathM;
          float slabEdge = ccSeam(pd - ${CART_PATH.halfWidth.toFixed(2)}, 0.22) * inZ;
          diffuseColor.rgb *= 1.0 - 0.20 * joint - 0.16 * slabEdge;

          // --- hard surface boundaries -------------------------------------
          // The bake can only resolve an edge to a texel or so, and a texel is
          // most of a yard. Within a couple of yards of a cut line we discard
          // its blur and rebuild the colour from the two pure surfaces using
          // the per-pixel mask, which is what makes the edge genuinely hard
          // instead of merely tight.
          float period = ${MOW_PERIOD.toFixed(2)};  // yards between passes
          float stripe = smoothstep(-0.6, 0.6, sin(vCourse.x * (6.2831853 / period)));
          vec3 fairCol = mix(uFairA, uFairB, stripe);

          float nearF = 1.0 - smoothstep(0.6, 2.6, abs(fe));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uRough, fairCol, fairM),
                                 nearF * 0.92 * offGreen * (1.0 - pathM));

          float nearG = 1.0 - smoothstep(0.5, 2.2, abs(ge));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uCollar, uGreen, greenM),
                                 nearG * 0.92 * (1.0 - pathM));

          // Sand last, so it wins wherever a bunker meets anything. Without
          // this the bake's single-texel edge magnifies into a pale smear and
          // the bunker stops looking like a bunker at all.
          float be = vCourse.w;
          float sandM = smoothstep(-fwidth(be), fwidth(be), be);
          float nearB = 1.0 - smoothstep(0.5, 2.2, abs(be));
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 mix(mix(uRough, fairCol, fairM), uSand, sandM),
                                 nearB * 0.94);
          // A darker rim just inside the sand: bunkers are dug, and the lip
          // shades the near edge.
          diffuseColor.rgb *= 1.0 - 0.14 * ccSeam(be, 0.34);

          // --- mowing grooves ----------------------------------------------
          float footprint = fwidth(vCourse.x);
          float groove = sin(vCourse.x * (6.2831853 / period));
          float gaa = 1.0 - smoothstep(period * 0.22, period * 0.60, footprint);
          diffuseColor.rgb *= 1.0 + groove * 0.05 * gaa * fairM * offGreen * (1.0 - sandM);

          // --- the cut lines themselves ------------------------------------
          // Long rough standing against short grass throws a thin shadow along
          // every mowing boundary. It is a small effect that does more for the
          // "this is a golf course" read than any amount of colour difference.
          diffuseColor.rgb *= 1.0 - 0.13 * ccSeam(fe, 0.38) * offGreen * (1.0 - pathM) * (1.0 - sandM);
          diffuseColor.rgb *= 1.0 - 0.11 * ccSeam(ge, 0.32);

          // --- turf grain ---------------------------------------------------
          // The baked texture is ~0.76 yards per texel and cannot resolve
          // anything at tuft scale, so close-up roughness lives here.
          float fw = fwidth(vWorld.x) + fwidth(vWorld.y);

          // Three scales, each faded at its *own* Nyquist limit — an octave
          // must vanish before the pixel footprint reaches half its
          // wavelength, or it aliases and the rough boils as the camera moves.
          float patches = ccNoise(vWorld * 0.10) - 0.5;   // ~10 yd
          float clumps  = ccNoise(vWorld * 0.40) - 0.5;   // ~2.5 yd
          float tufts   = ccNoise(vWorld * 1.60) - 0.5;   // ~0.6 yd
          float grain =
            patches * 0.28 * (1.0 - smoothstep(2.5, 5.0,  fw)) +
            clumps  * 0.30 * (1.0 - smoothstep(0.6, 1.25, fw)) +
            tufts   * 0.26 * (1.0 - smoothstep(0.15, 0.31, fw));

          // Full in the rough, a trace on the fairway so it isn't plastic,
          // none on the green or the concrete.
          grain *= offGreen * (1.0 - 0.82 * fairM) * (1.0 - pathM) * (1.0 - sandM);

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
