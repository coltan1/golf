/**
 * ramps.js — the kickers.
 *
 * The cart can already fly; what it could not do was choose to. Air came off
 * whatever the terrain happened to offer, which meant it happened to you
 * rather than because of you, and a jump you did not aim at is a bump.
 *
 * A ramp is a wedge with a height function. That is the whole design, and it
 * is deliberately NOT baked into the terrain: heightAt drives the mown lines,
 * the lie the ball gets, where grass grows and where trees are allowed, and a
 * ramp is none of those things — it is an object standing on the ground. So
 * the ramps keep their own surface, the cart takes whichever is higher, and
 * nothing else in the game has to learn a new concept.
 *
 * They are placed rather than authored. Twenty-seven holes across two courses
 * would be eighty hand-placed coordinates that all need revisiting the next
 * time a fairway moves; derived from the corridor, they follow it.
 */

import * as THREE from 'three';
import { mulberry32, lerp, clamp } from './util.js';
import {
  heightAt, centreXAt, fairwayHalfWidth, nearest, greenEdge, bunkerEdge,
  TEE, WORLD_CZ, WORLD_SIZE, shoreEdge, OCEAN,
} from './course.js';

// A kicker is short, wide enough to hit without aiming perfectly, and not very
// tall. Height is the least important number of the three: the launch comes
// from the ground dropping away at the lip, so what matters is how quickly it
// rises, not how far.
const LEN = 8.0;
const HALF_W = 3.2;
const RISE = 2.4;

/**
 * The profile, and the one number in this file that decides whether a ramp
 * works at all: the slope AT THE LIP.
 *
 * The first version used a smoothstep, which is flat at both ends — so the
 * cart rolled up it, levelled off at the top, and stepped off the edge with no
 * upward speed whatever. It cleared the lip by about a foot. A kicker is the
 * opposite shape: gentle where you meet it so it does not stop you, steepest
 * where you leave it, because the launch is entirely the slope of the last
 * inch. A square law does that — flat entry, and twice the average gradient at
 * the top.
 */
const profile = (t) => RISE * t * t;

let ramps = [];

/** Ramp surface height at a point, or -Infinity if there is no ramp there. */
export function rampHeightAt(x, z) {
  let best = -Infinity;
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i];
    const dx = x - r.x, dz = z - r.z;
    // Into the ramp's own frame: u runs up the ramp, v across it.
    const u = dx * r.sin + dz * -r.cos;
    if (u < 0 || u > LEN) continue;
    const v = dx * r.cos + dz * r.sin;
    if (v < -HALF_W || v > HALF_W) continue;
    const h = r.base + profile(u / LEN);
    if (h > best) best = h;
  }
  return best;
}

/** True if the point is on a ramp at all — the cart uses it to stay planted. */
export function onRamp(x, z) { return rampHeightAt(x, z) > -Infinity; }

// ---------------------------------------------------------------- geometry
function wedgeGeo() {
  // A solid: the sloped deck, two sides, a back wall and the lip.
  const N = 8;
  const pos = [];
  const P = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const deck = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    deck.push([t * LEN, profile(t)]);
  }
  for (let i = 0; i < N; i++) {
    const [u0, y0] = deck[i], [u1, y1] = deck[i + 1];
    // deck
    P([u0, y0, -HALF_W], [u1, y1, -HALF_W], [u0, y0, HALF_W]);
    P([u0, y0, HALF_W], [u1, y1, -HALF_W], [u1, y1, HALF_W]);
    // sides
    P([u0, 0, -HALF_W], [u0, y0, -HALF_W], [u1, 0, -HALF_W]);
    P([u1, 0, -HALF_W], [u0, y0, -HALF_W], [u1, y1, -HALF_W]);
    P([u0, 0, HALF_W], [u1, 0, HALF_W], [u0, y0, HALF_W]);
    P([u1, 0, HALF_W], [u1, y1, HALF_W], [u0, y0, HALF_W]);
  }
  // The lip, square on, which is the face you see coming.
  P([LEN, 0, -HALF_W], [LEN, RISE, -HALF_W], [LEN, 0, HALF_W]);
  P([LEN, 0, HALF_W], [LEN, RISE, -HALF_W], [LEN, RISE, HALF_W]);
  // And the underside, so it is a closed solid rather than a shell.
  P([0, 0, -HALF_W], [LEN, 0, -HALF_W], [0, 0, HALF_W]);
  P([0, 0, HALF_W], [LEN, 0, -HALF_W], [LEN, 0, HALF_W]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Chevrons painted up the deck, so it reads as a thing to drive at. */
function chevronGeo() {
  const pos = [];
  const P = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let k = 0; k < 3; k++) {
    const t0 = 0.22 + k * 0.24, t1 = t0 + 0.11;
    const y = (t) => profile(t) + 0.02;
    const u = (t) => t * LEN;
    // A shallow V pointing up the ramp.
    P([u(t0), y(t0), -HALF_W * 0.72], [u(t1), y(t1), 0], [u(t0), y(t0), -HALF_W * 0.38]);
    P([u(t0), y(t0), HALF_W * 0.72], [u(t0), y(t0), HALF_W * 0.38], [u(t1), y(t1), 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- placing
/**
 * Where a ramp is allowed to be.
 *
 * Just off the mown line, not on the green, not in a bunker, not over a cliff,
 * and on ground flat enough that the wedge does not float at one corner. The
 * near edge of the rough is the right place for all of them: far enough that
 * driving straight down the fairway never hits one by accident, near enough
 * that taking one is a small deliberate detour rather than an expedition.
 */
function placeable(x, z) {
  const n = nearest(x, z);
  const hw = fairwayHalfWidth(n.t);
  if (n.dist < hw + 2 || n.dist > hw + 26) return false;
  if (greenEdge(x, z) > -14) return false;
  if (bunkerEdge(x, z) > -4) return false;
  if (OCEAN && shoreEdge(x, z) < 18) return false;
  const y = heightAt(x, z);
  if (y < -1) return false;
  // Flat enough. Sampled at the four corners of the footprint rather than by
  // the gradient, because the gradient is the slope at a point and what
  // matters is whether this particular nine-yard box sits level.
  let lo = y, hi = y;
  for (const [ox, oz] of [[LEN, 0], [0, HALF_W], [0, -HALF_W], [LEN, HALF_W]]) {
    const h = heightAt(x + ox, z + oz);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return hi - lo < 1.6;
}

/**
 * Build this hole's ramps.
 *
 * Facing down the line of play, so hitting one throws you toward the green
 * rather than into the trees — a ramp that launches you the wrong way is a
 * punishment for using it.
 */
export function createRamps(toonRamp, seed = 1) {
  const group = new THREE.Group();
  group.name = 'ramps';
  ramps = [];

  const rnd = mulberry32(90210 + seed * 7717);
  const zNear = TEE.z - 40;
  const zFar = WORLD_CZ - WORLD_SIZE * 0.30;

  for (let attempt = 0; attempt < 600 && ramps.length < 7; attempt++) {
    const z = lerp(zNear, zFar, rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    const n0 = nearest(centreXAt(z), z);
    const off = fairwayHalfWidth(n0.t) + lerp(4, 20, rnd());
    const x = centreXAt(z) + side * off;
    if (!placeable(x, z)) continue;
    // Spread out, or they cluster where the corridor happens to be widest.
    if (ramps.some((r) => Math.hypot(r.x - x, r.z - z) < 55)) continue;

    // Down the hole, with a little skew so they are not all identical.
    const ahead = nearest(x, z);
    const face = Math.atan2(centreXAt(z - 40) - x, -(z - 40 - z)) + lerp(-0.35, 0.35, rnd());
    void ahead;
    ramps.push({
      x, z, base: heightAt(x, z),
      sin: Math.sin(face), cos: Math.cos(face), face,
    });
  }
  if (!ramps.length) return group;

  const wood = new THREE.MeshToonMaterial({ color: 0xb98a52, gradientMap: toonRamp });
  const paint = new THREE.MeshToonMaterial({ color: 0xf6c542, gradientMap: toonRamp });

  const geo = wedgeGeo();
  const chev = chevronGeo();
  const deck = new THREE.InstancedMesh(geo, wood, ramps.length);
  const marks = new THREE.InstancedMesh(chev, paint, ramps.length);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  ramps.forEach((r, i) => {
    // The wedge is authored along +X; `face` is a heading where zero is -Z,
    // so the rotation that lines them up is face minus a quarter turn.
    e.set(0, r.face - Math.PI / 2, 0);
    q.setFromEuler(e);
    m.compose(p.set(r.x, r.base - 0.06, r.z), q, one);
    deck.setMatrixAt(i, m);
    marks.setMatrixAt(i, m);
  });
  deck.instanceMatrix.needsUpdate = true;
  marks.instanceMatrix.needsUpdate = true;
  deck.castShadow = true;
  deck.frustumCulled = marks.frustumCulled = false;
  marks.castShadow = false;
  group.add(deck);
  group.add(marks);
  return group;
}

/** Where they are, for the console and for anything that wants to aim at one. */
export function rampList() { return ramps.map((r) => ({ ...r })); }

/** Forget them. Called when a hole is torn down, so stale ramps cannot linger. */
export function clearRamps() { ramps = []; }

export const RAMP = { LEN, HALF_W, RISE };
void clamp;
