/**
 * terrain.js — the sculpted ground mesh and the pond surface.
 *
 * The mesh is a hand-built grid (rather than PlaneGeometry) so the UVs line up
 * exactly with the baked course texture from course.js.
 *
 * It also carries a custom `aCourse` attribute — signed distance from the
 * centreline, and signed distance to the fairway and green edges — which the
 * material uses to draw the mowing lines, the cut seams, the pine straw beds
 * and the turf grain per-pixel. Baking detail that fine in would need
 * a 4k+ canvas and would still alias; doing it in the shader keeps it crisp
 * underfoot and lets it fade out cleanly with distance.
 */

import * as THREE from 'three';
import {
  WORLD_SIZE, WORLD_CX, WORLD_CZ, WATER_Y, POND, CREEK, MOW_PERIOD,
  SURFACE_COLORS, heightAt, makeCourseTexture, nearest, fairwayHalfWidth, greenEdge,
  bunkerEdge, BUNKERS,
} from './course.js';
import { smoothstep } from './util.js';

/**
 * The cel ramp — the single most important thing about the look.
 *
 * three.js samples this at `dotNL * 0.5 + 0.5`, so texel 0 is fully
 * facing-away and texel 15 is straight at the light. Half the ramp is
 * therefore spent on the unlit hemisphere; the lit bands above it are spaced
 * so they come out roughly even in *angle* rather than even in dot product,
 * which is what makes them read as deliberate bands on a curved surface
 * instead of a thin rind around the terminator.
 *
 * The floor is low (0.15) on purpose. Shadow fill comes from the hemisphere
 * light, not from flattening this ramp — that's how you get crisp steps and
 * light, coloured shadows at the same time.
 */
export function makeToonRamp() {
  // Toon lighting looks up this ramp at `0.5 + 0.5 * dotNL`, not at dotNL —
  // so a face square-on to the sun lands at texel 12, not 15. Putting the
  // highlight only in texel 15 therefore lights nothing that is actually flat:
  // a bridge deck or a cabin roof came out at 0.56 while the turf beside it sat
  // at 1.00, so every horizontal surface read as though it were in shade, cool
  // and grey because only the blue fill was reaching it.
  //
  // The top band starts at texel 12 for the same reason it does in the ground
  // ramp — dotNL 0.5 — so the two agree about what "lit" means. The three
  // bands below it still give rounded things like tree crowns their gradation.
  const steps = [
    0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, // facing away
    0.38, 0.38,                                     // terminator
    0.66, 0.66,                                     // mid
    1.00, 1.00, 1.00, 1.00,                         // anything roughly sunward
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
  // The top band reaches down to dotNL 0.5 (60° off the light). Open turf
  // under a 38° sun sits at 0.62, comfortably inside it, so undulation never
  // tips the fairway into a darker step — while bunker faces and mounding,
  // which turn much further, still drop one and keep their shape.
  // Texels 12-15 must all hold 1.0: open turf under a 38° sun lands on texel
  // 12, and anything less than full there darkens the entire course. What can
  // be tuned is the size of the *first* step down. At 1.00 → 0.70 any slope
  // that just crosses the boundary announces itself with a 30% drop; at 0.82
  // the same slope is far less conspicuous, while genuinely steep ground still
  // reaches the darker bands below it.
  const steps = [
    0.28, 0.28, 0.28, 0.28, 0.28, 0.28, 0.28, 0.28, // facing away
    0.55, 0.55,                                     // steep, turned away
    0.82, 0.82,                                     // moderately tilted
    1.00, 1.00, 1.00, 1.00,                         // anything roughly sunward
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

export function createTerrain(renderer, toonRamp, treeMap) {
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
    shader.uniforms.uRough  = { value: colorUniform(SURFACE_COLORS.roughMean) };
    shader.uniforms.uFairA  = { value: colorUniform(SURFACE_COLORS.fairA) };
    shader.uniforms.uFairB  = { value: colorUniform(SURFACE_COLORS.fairB) };
    shader.uniforms.uCollar = { value: colorUniform(SURFACE_COLORS.collar) };
    shader.uniforms.uGreen  = { value: colorUniform(SURFACE_COLORS.greenA) };
    shader.uniforms.uSand   = { value: colorUniform(SURFACE_COLORS.sand) };
    shader.uniforms.uStraw  = { value: colorUniform(SURFACE_COLORS.straw) };
    shader.uniforms.uStrawB = { value: colorUniform(SURFACE_COLORS.strawAlt) };
    // Where the trees actually stand, so the beds can sit under them.
    shader.uniforms.uTreeMap = { value: treeMap ? treeMap.tex : null };
    shader.uniforms.uTreeOrg = {
      value: treeMap
        ? new THREE.Vector3(treeMap.origin.x, treeMap.origin.z, treeMap.origin.size)
        : new THREE.Vector3(0, 0, 1),
    };
    shader.uniforms.uHasTrees = { value: treeMap ? 1 : 0 };

    // Bunker outlines go to the shader as parameters rather than as an
    // interpolated vertex attribute. The field is radial and nonlinear, so
    // interpolating it across 2.4-yard triangles turns the edge into a
    // polygon — visibly so on a bunker only a few triangles wide. Evaluated
    // per-pixel it is exactly the curve course.js sculpted.
    const MAX = 8;
    const A = [], B = [], HA = [], HP = [];
    for (let i = 0; i < MAX; i++) {
      const b = BUNKERS[i];
      A.push(b ? new THREE.Vector4(b.x, b.z, b.rx, b.rz) : new THREE.Vector4(0, 0, 1, 1));
      B.push(b ? new THREE.Vector4(b.rot, (b.rx + b.rz) * 0.5, 0, 0) : new THREE.Vector4(0, 1, 0, 0));
      HA.push(b ? new THREE.Vector3(b.h[0], b.h[2], b.h[4]) : new THREE.Vector3());
      HP.push(b ? new THREE.Vector3(b.h[1], b.h[3], b.h[5]) : new THREE.Vector3());
    }
    shader.uniforms.uBunkA = { value: A };
    shader.uniforms.uBunkB = { value: B };
    shader.uniforms.uBunkHA = { value: HA };
    shader.uniforms.uBunkHP = { value: HP };
    shader.uniforms.uBunkN = { value: Math.min(MAX, BUNKERS.length) };

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
        // Set during map_fragment, read again after lighting.
        float ccSandM;

        uniform vec4 uBunkA[8];    // centre.xy, radii.zw
        uniform vec4 uBunkB[8];    // rotation, mean radius
        uniform vec3 uBunkHA[8];   // outline harmonic amplitudes
        uniform vec3 uBunkHP[8];   // outline harmonic phases
        uniform int  uBunkN;

        /** Signed yards inside the nearest bunker. Mirrors shapeField(). */
        // Signed yards to the nearest bunker outline. Positive inside.
        //
        // This has to be *continuous*, which is a stronger requirement than it
        // looks. Everything downstream sharpens it against its own derivative
        // — sandM is a smoothstep whose edges are ±fwidth(be) — so a step in
        // the field, however far out in the grass it sits, blows fwidth up and
        // drags that smoothstep back toward the middle of its range. Skipping
        // distant bunkers with a sentinel put a step of several hundred yards
        // at the cutoff radius, and smoothstep(-989, 989, -9.6) is 0.49, not
        // 0: sand shading came out half-strength along a one-pixel ellipse
        // ringing every bunker, out in clean fairway.
        //
        // So nothing bails out. The harmonics fade to nothing by r = 2.1,
        // which is well outside the outline they shape (that lives near
        // r = 1), leaving a plain radial field beyond it — cheap, since the
        // atan goes away with them, and smooth all the way out.
        float ccBunkerEdge(vec2 p) {
          float best = -1e4;
          for (int i = 0; i < 8; i++) {
            if (i >= uBunkN) break;
            vec4 A = uBunkA[i];
            vec4 B = uBunkB[i];
            float c = cos(B.x), sn = sin(B.x);
            vec2 d = p - A.xy;
            vec2 e = vec2((d.x * c + d.y * sn) / A.z, (-d.x * sn + d.y * c) / A.w);
            float r = length(e);
            float k = 1.0;
            if (r > 0.001 && r < 2.1) {
              float a = atan(e.y, e.x);
              vec3 ha = uBunkHA[i], hp = uBunkHP[i];
              float hw = 1.0 - smoothstep(1.30, 2.10, r);
              k = 1.0 + hw * (ha.x * sin(a * 2.0 + hp.x)
                            + ha.y * sin(a * 3.0 + hp.y)
                            + ha.z * sin(a * 5.0 + hp.z));
            }
            best = max(best, (1.0 - r / k) * B.y);
          }
          return best;
        }
        uniform vec3 uRough;
        uniform vec3 uSand;
        uniform vec3 uFairA;
        uniform vec3 uFairB;
        uniform vec3 uCollar;
        uniform vec3 uGreen;
        uniform vec3 uStraw;
        uniform vec3 uStrawB;
        uniform sampler2D uTreeMap;
        uniform vec3 uTreeOrg;   // minX, minZ, size
        uniform float uHasTrees;

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
      .replace('#include <opaque_fragment>', `
        {
          // Sand shades far too hard for what it is.
          //
          // A bunker wall turns enough to drop a cel band, and the bowl spans
          // only a couple of triangles, so that band lands as a hard, straight
          // edged wedge lying across the sand — the "dark spot in the bunker".
          // Softening the ramp does not fix it, because the ramp is doing
          // exactly what it is meant to; the sand simply should not be on it.
          //
          // So sand opts out. It is re-lit from a smooth Lambert term over a
          // deliberately narrow range: bright, bouncing light around inside
          // its own hollow, shading just enough to read as a scoop rather than
          // a sticker. Bands cannot appear in something that never touches the
          // ramp. Enough of the original survives that shadows thrown across a
          // bunker still register, without the hollow going dark on its own.
          #if NUM_DIR_LIGHTS > 0
            float sNdL = dot(normalize(normal), normalize(directionalLights[0].direction));
            float sSoft = mix(0.86, 1.05, smoothstep(-0.25, 0.90, sNdL));
          #else
            float sSoft = 1.0;
          #endif
          outgoingLight = mix(outgoingLight, uSand * 0.86 * sSoft, ccSandM * 0.82);
        }
        #include <opaque_fragment>`)
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

          // Sand is resolved first even though it is composited last. A bunker
          // that straddles a mowing line sits under the fairway/green colour
          // overrides below, and those would otherwise paint grass across the
          // sand wherever that line crosses it — green streaks inside the
          // bunker, repaired only within a yard of the bunker's own edge.
          float be = ccBunkerEdge(vWorld);
          float sandM = smoothstep(-fwidth(be), fwidth(be), be);
          ccSandM = sandM;
          float offSand = 1.0 - sandM;


          // --- hard surface boundaries -------------------------------------
          // The bake can only resolve an edge to a texel or so, and a texel is
          // most of a yard, so right at a cut line we discard its blur and
          // rebuild the colour from the two pure surfaces using the per-pixel
          // mask.
          //
          // The band this happens over has to be *narrow*. The pure colours
          // are flat, while the baked rough is mottled with dry and wet
          // patches — override too wide a strip and you get a band of flat
          // colour running alongside every fairway, meeting textured rough
          // beyond it. That halo reads worse than the soft edge it replaced.
          // A yard is enough to harden the edge and too thin to see as a band.
          float period = ${MOW_PERIOD.toFixed(2)};  // yards between passes
          float stripe = smoothstep(-0.6, 0.6, sin(vCourse.x * (6.2831853 / period)));
          vec3 fairCol = mix(uFairA, uFairB, stripe);

          float nearF = 1.0 - smoothstep(0.30, 1.10, abs(fe));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uRough, fairCol, fairM),
                                 nearF * 0.92 * offGreen * offSand);

          float nearG = 1.0 - smoothstep(0.28, 1.00, abs(ge));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uCollar, uGreen, greenM),
                                 nearG * 0.92 * offSand);

          // Sand composited last, so it wins wherever a bunker meets anything.
          // Without this the bake's single-texel edge magnifies into a pale
          // smear and the bunker stops looking like a bunker at all.
          float nearB = 1.0 - smoothstep(0.30, 1.10, abs(be));
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 mix(mix(uRough, fairCol, fairM), uSand, sandM),
                                 nearB * 0.94);
          // A darker rim just inside the sand: bunkers are dug, and the lip
          // shades the near edge.
          diffuseColor.rgb *= 1.0 - 0.07 * ccSeam(be, 0.34);

          // --- mowing grooves ----------------------------------------------
          float footprint = fwidth(vCourse.x);
          float groove = sin(vCourse.x * (6.2831853 / period));
          float gaa = 1.0 - smoothstep(period * 0.22, period * 0.60, footprint);
          diffuseColor.rgb *= 1.0 + groove * 0.05 * gaa * fairM * offGreen * (1.0 - sandM);

          // --- the cut lines themselves ------------------------------------
          // Long rough standing against short grass throws a thin shadow along
          // every mowing boundary. It is a small effect that does more for the
          // "this is a golf course" read than any amount of colour difference.
          diffuseColor.rgb *= 1.0 - 0.13 * ccSeam(fe, 0.38) * offGreen * (1.0 - sandM);
          diffuseColor.rgb *= 1.0 - 0.11 * ccSeam(ge, 0.32);

          // --- pine straw beds ----------------------------------------------
          // Under the trees there is no grass at all. The ground is a carpet
          // of needles raked into irregular beds around the trunks, and it is
          // most of why the reference reads as *this* course rather than a
          // generic parkland one: a warm red-brown band separating the green
          // corridor from the dark of the forest.
          //
          // Keyed off distance past the fairway edge, so the beds begin about
          // where the trees do, then broken up by noise so their outlines
          // wander instead of running parallel to the hole.
          float strawN = ccNoise(vWorld * 0.048) * 0.62 + ccNoise(vWorld * 0.150) * 0.38;
          // Under the canopy, and only there. Distance past the fairway edge
          // was the obvious key and it was wrong: it spreads straw across open
          // rough that has no tree anywhere near it, because "far enough out
          // that a tree is allowed" is nothing like "a tree is here". This
          // samples where they actually ended up. The fairway term stays, so a
          // tree leaning over the short grass cannot drop a bed onto it.
          vec2 tuv = (vWorld - uTreeOrg.xy) / uTreeOrg.z;
          float canopy = texture2D(uTreeMap, tuv).r * uHasTrees;
          float strawReach = smoothstep(0.10, 0.40, canopy) * smoothstep(-2.0, -8.0, fe);
          float strawM = strawReach
                       * smoothstep(0.40, 0.58, strawN + strawReach * 0.26)
                       * offGreen * offSand;
          vec3 strawCol = mix(uStraw, uStrawB, ccNoise(vWorld * 0.85));
          diffuseColor.rgb = mix(diffuseColor.rgb, strawCol, strawM * 0.94);
          float offStraw = 1.0 - strawM;

          // --- grass types ---------------------------------------------------
          // A course is not one turf. Coarser, denser strains grow in patches
          // against the fine stuff — a shade deeper, and cooler for being
          // thick enough to shade its own soil.
          float zone = ccNoise(vWorld * 0.026 + 5.7);
          float dense = smoothstep(0.50, 0.76, zone) * offStraw * offSand * offGreen;
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.90, 0.98, 0.87), dense);

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
          grain *= offGreen * (1.0 - 0.82 * fairM) * (1.0 - sandM) * offStraw;

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
// ---------------------------------------------------------------- water
/**
 * Colours and time, shared by every body of water on a hole.
 *
 * The pond adds its outline harmonics on top; the creek needs none, because
 * its shape is the geometry.
 */
function waterUniforms() {
  return {
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(0x1c6b86) },
    uShallow: { value: new THREE.Color(0x63cbd8) },
    // Pale blue, not near-white. Crests are mixed in at a third or so over
    // a dark teal, and against that a near-white reads as a painted stripe
    // rather than as light catching a ripple.
    uCrest: { value: new THREE.Color(0x9fdcea) },
    uFoam: { value: new THREE.Color(0xffffff) },
  };
}

/**
 * The stylised water surface, applied to a fragment shader.
 *
 * Deliberately unlit. Toon lighting on a rippling surface gives bands that
 * follow the wave normals, which reads as shiny plastic; cartoon water wants
 * flat shapes drawn *on* the surface instead. So the colour is authored: a
 * depth gradient from turquoise shallows to deep teal, hard-thresholded crest
 * highlights drifting across it, and foam hugging the bank.
 *
 * The only thing it asks of the geometry is `vField` — 0 at the middle of the
 * water, 1 at the bank. A pond gets that from a radial outline, a creek from
 * its across-strip coordinate, and neither needs to know about the other.
 */
function waterFragment(src) {
  return src
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uCrest;
        uniform vec3 uFoam;
        varying vec2 vLocal;
        varying float vField;

        float cwHash(vec2 p) {
          p = fract(p * vec2(127.31, 311.7));
          p += dot(p, p + 34.23);
          return fract(p.x * p.y);
        }
        float cwNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(cwHash(i),                  cwHash(i + vec2(1.0, 0.0)), f.x),
            mix(cwHash(i + vec2(0.0, 1.0)), cwHash(i + vec2(1.0, 1.0)), f.x),
            f.y);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // Outside the ellipse there is no pond — cut it rather than letting
        // the plane's corners float over the grass.
        if (vField > 1.0) discard;

        float depth = 1.0 - smoothstep(0.0, 1.0, vField);
        vec3 water = mix(uShallow, uDeep, depth);

        // Crests, thresholded hard. The hard edge is the whole point — soft
        // highlights would read as specular, these read as drawn shapes.
        //
        // Driven by warped noise rather than summed sines. Sines were the
        // obvious thing and they were wrong: any small number of them, on a
        // pond only a few wavelengths across, thresholds into evenly spaced
        // parallel stripes with rows of identical dots between them. It read
        // as wallpaper. Noise has no preferred direction and no period, so the
        // crests come out as scattered patches that never repeat, and warping
        // the lookup by a little more noise keeps their outlines from looking
        // like contour lines.
        float fp = fwidth(vLocal.x) + fwidth(vLocal.y);
        float waa = 1.0 - smoothstep(1.6, 3.4, fp);
        vec2 q = vLocal * 0.16 + vec2(uTime * 0.06, uTime * -0.04);
        q += 0.55 * vec2(cwNoise(q * 1.7 + 3.1), cwNoise(q * 1.7 + 8.4)) - 0.275;
        water = mix(water, uCrest, smoothstep(0.60, 0.69, cwNoise(q)) * 0.34 * waa);

        // A finer, faster set so the surface never looks frozen. Faded out on
        // its own footprint: it is small enough to alias into a crawling moiré
        // once a pixel covers more than a yard of pond.
        float saa = 1.0 - smoothstep(0.55, 1.20, fp);
        vec2 q2 = vLocal * 0.52 + vec2(uTime * -0.11, uTime * 0.08);
        water = mix(water, uCrest, smoothstep(0.74, 0.83, cwNoise(q2)) * 0.24 * saa);

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
}

export function createWater() {
  const SEG = 72;
  // The plane overhangs the pond and the shader discards everything outside
  // the outline, so the waterline is the true shore rather than a square edge.
  // It has to overhang generously: the harmonics push the bank out to about
  // 1.4x the nominal radius at its furthest, and a plane sized for the plain
  // ellipse would slice the bays clean off.
  const geo = new THREE.PlaneGeometry(POND.rx * 3.0, POND.rz * 3.0, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const uniforms = Object.assign(waterUniforms(), {
    uRadii: { value: new THREE.Vector2(POND.rx, POND.rz) },
    // Same three harmonics course.js uses, so the rendered waterline and the
    // basin carved into the terrain are the same curve.
    uWobA: { value: new THREE.Vector3(POND.h[0], POND.h[2], POND.h[4]) },
    uWobP: { value: new THREE.Vector3(POND.h[1], POND.h[3], POND.h[5]) },
  });

  const mat = new THREE.MeshBasicMaterial({ transparent: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec2 uRadii;
        uniform vec3 uWobA;
        uniform vec3 uWobP;
        varying vec2 vLocal;
        varying float vField;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = vec2(position.x, position.z);
        // 1.0 is exactly the shoreline. Matches shapeField() in course.js.
        vec2 e = vLocal / uRadii;
        float rr = length(e);
        float aa = atan(e.y, e.x);
        float kk = 1.0 + uWobA.x * sin(aa * 2.0 + uWobP.x)
                       + uWobA.y * sin(aa * 3.0 + uWobP.y)
                       + uWobA.z * sin(aa * 5.0 + uWobP.z);
        vField = rr / kk;
        transformed.y +=
          0.16 * sin(position.x * 0.13 + uTime * 0.55) +
          0.11 * sin(position.z * 0.17 - uTime * 0.42) +
          0.07 * sin((position.x + position.z) * 0.09 + uTime * 0.80);`);
    shader.fragmentShader = waterFragment(shader.fragmentShader);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(POND.x, WATER_Y, POND.z);
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  mesh.userData.tick = (time) => { uniforms.uTime.value = time; };
  return mesh;
}

/**
 * The creek — stylised water again, but as a *ribbon* rather than a discarded
 * plane.
 *
 * A pond can be a rectangle with everything outside its outline thrown away.
 * A creek cannot: it winds, so a plane big enough to contain it would be
 * mostly waste, and the outline is a path rather than a closed curve. Building
 * the geometry along the polyline instead means the mesh *is* the creek, with
 * no discard at all.
 *
 * The fragment shader is shared with the pond. All it needs is `vField` — 0 at
 * the centre of the water, 1 at the bank — which the ribbon gets from its
 * across-strip coordinate instead of from a radial distance.
 */
export function createCreek() {
  const pts = CREEK.pts;
  const SUB = 6;                  // subdivisions per source segment
  const rows = [];

  // Resample the polyline so the ribbon bends smoothly and has enough
  // vertices along its length for the wave displacement to read.
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k < SUB; k++) rows.push(sampleCreek(i + k / SUB));
  }
  rows.push(sampleCreek(pts.length - 1.0001));

  const count = rows.length;
  const positions = new Float32Array(count * 2 * 3);
  const cross = new Float32Array(count * 2);
  const indices = new Uint32Array((count - 1) * 6);

  for (let i = 0; i < count; i++) {
    const r = rows[i];
    // Widen slightly at the ends so the creek runs off into the trees rather
    // than stopping dead at a visible squared-off tip.
    const w = CREEK.w * (1 + 0.10 * Math.sin((i / (count - 1)) * Math.PI));
    positions[i * 6 + 0] = r.x - r.nx * w;
    positions[i * 6 + 1] = CREEK.y;
    positions[i * 6 + 2] = r.z - r.nz * w;
    positions[i * 6 + 3] = r.x + r.nx * w;
    positions[i * 6 + 4] = CREEK.y;
    positions[i * 6 + 5] = r.z + r.nz * w;
    cross[i * 2] = -1;
    cross[i * 2 + 1] = 1;
  }
  for (let i = 0, t = 0; i < count - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices[t++] = a; indices[t++] = c; indices[t++] = b;
    indices[t++] = b; indices[t++] = c; indices[t++] = d;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aCross', new THREE.BufferAttribute(cross, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const uniforms = waterUniforms();
  const mat = new THREE.MeshBasicMaterial({ transparent: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute float aCross;
        varying vec2 vLocal;
        varying float vField;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = vec2(position.x, position.z);
        vField = abs(aCross);
        transformed.y +=
          0.09 * sin(position.x * 0.20 + uTime * 0.75) +
          0.06 * sin(position.z * 0.24 - uTime * 0.55);`);
    shader.fragmentShader = waterFragment(shader.fragmentShader);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.userData.tick = (time) => { uniforms.uTime.value = time; };
  return mesh;
}

/** Position and unit normal at a fractional index along the creek polyline. */
function sampleCreek(f) {
  const pts = CREEK.pts;
  const i = Math.min(pts.length - 2, Math.floor(f));
  const t = f - i;
  const a = pts[i], b = pts[i + 1];
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  // Left-hand normal to the direction of flow.
  return { x, z, nx: -dz / len, nz: dx / len };
}
