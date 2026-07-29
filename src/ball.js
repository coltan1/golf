/**
 * ball.js — arcade ball flight, bounce, roll, and the soft effects around it.
 *
 * Flight is *parametric*, not simulated: we decide up front where the ball is
 * going and trace a graceful arc to get there. That's what makes every shot
 * feel floaty and satisfying instead of twitchy.
 *
 * Once it lands we switch to a tiny, gently-tuned integrator so bounces and
 * roll respond to the actual ground — the arcade arc gets the poetry, the
 * integrator gets the last twenty yards right.
 */

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './util.js';
import {
  heightAt, surfaceHeightAt, gradientAt, surfaceAt, isOutOfBounds,
  distToHole, HOLE_POS, WATER_Y,
} from './course.js';

// --- clubs -------------------------------------------------------------------
// `apex` is apex-height / carry-distance. `roll` scales bounce + run-out.
export const CLUBS = {
  driver: { name: 'Driver',     carry: 262, apex: 0.150, roll: 1.00 },
  wood:   { name: '3 Wood',     carry: 224, apex: 0.172, roll: 0.86 },
  hybrid: { name: 'Hybrid',     carry: 196, apex: 0.194, roll: 0.72 },
  iron5:  { name: '5 Iron',     carry: 172, apex: 0.214, roll: 0.58 },
  iron7:  { name: '7 Iron',     carry: 148, apex: 0.243, roll: 0.46 },
  iron9:  { name: '9 Iron',     carry: 122, apex: 0.278, roll: 0.36 },
  wedge:  { name: 'Wedge',      carry:  96, apex: 0.330, roll: 0.24 },
  lob:    { name: 'Lob Wedge',  carry:  58, apex: 0.400, roll: 0.14 },
  putter: { name: 'Putter',     carry:   0, apex: 0.000, roll: 1.00 },
};

/**
 * Auto club selection: the club whose full swing just reaches the pin.
 *
 * @param landsWet optional predicate (carryYards, rollFactor) — does a
 *   straight shot with that club finish in a hazard, *including its run-out*?
 *   When the reaching club would put you in the water, the caddie lays up
 *   short of it instead. Checking carry alone is not enough: on a par 5 with a
 *   pond fronting the green the lay-up lands dry and then rolls straight in.
 */
export function pickClub(distance, surface, isTee, landsWet) {
  if (surface === 'green') return CLUBS.putter;
  if (surface === 'sand') return distance > 70 ? CLUBS.wedge : CLUBS.lob;

  // Driver only off the tee; from the deck the longest club is the 3 wood,
  // so a par 5 naturally becomes drive, lay up, approach.
  const order = ['lob', 'wedge', 'iron9', 'iron7', 'iron5', 'hybrid', 'wood'];
  if (isTee) order.push('driver');

  let reach = null;
  for (const k of order) if (CLUBS[k].carry >= distance * 0.98) { reach = CLUBS[k]; break; }
  const chosen = reach ?? (isTee ? CLUBS.driver : CLUBS.wood);

  if (!landsWet || !landsWet(chosen.carry, chosen.roll)) return chosen;
  // Step down to the longest club that still stops dry. If everything is wet
  // it is a forced carry, so hand back the reaching club and commit.
  for (let i = order.length - 1; i >= 0; i--) {
    const c = CLUBS[order[i]];
    if (c.carry < chosen.carry && !landsWet(c.carry, c.roll)) return c;
  }
  return chosen;
}

/** How much of your swing survives the lie. Gentle — this is not a punishment. */
const LIE_POWER = { fairway: 1.0, green: 1.0, rough: 0.87, deep: 0.74, sand: 0.80, water: 0.9 };

/** rest = bounciness, grip = horizontal speed lost per bounce, fric = roll decel. */
const SURF = {
  fairway: { rest: 0.40, grip: 0.24, fric: 7.5 },
  green:   { rest: 0.30, grip: 0.34, fric: 4.2 },
  rough:   { rest: 0.16, grip: 0.56, fric: 17.0 },
  deep:    { rest: 0.10, grip: 0.72, fric: 27.0 },
  sand:    { rest: 0.04, grip: 0.86, fric: 42.0 },
  water:   { rest: 0.00, grip: 1.00, fric: 60.0 },
};

const GRAVITY = 24;
const RADIUS = 0.21;
const REST_SPEED = 0.42;   // below this the ball is considered stopped
const CUP_RADIUS = 0.52;
const CUP_SPEED = 5.2;

// --- soft round sprite, reused by the trail, the puff and the splash ---------
function makeSoftSprite() {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A pooled cloud of fading sprites: trail, turf spray and splash all use it. */
class Puffs {
  constructor(scene, tex, count) {
    this.items = [];
    for (let i = 0; i < count; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0, fog: true,
      }));
      sp.visible = false;
      scene.add(sp);
      this.items.push({ sp, life: 0, max: 1, vel: new THREE.Vector3(), grav: 0, size: 1, fade: 1 });
    }
    this.cursor = 0;
  }

  spawn(pos, opts = {}) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.sp.position.copy(pos);
    it.sp.material.color.set(opts.color ?? 0xffffff);
    it.life = 0;
    it.max = opts.life ?? 0.9;
    it.size = opts.size ?? 0.7;
    it.fade = opts.opacity ?? 0.75;
    it.grav = opts.grav ?? 0;
    if (opts.vel) it.vel.copy(opts.vel); else it.vel.set(0, 0, 0);
    it.sp.scale.setScalar(it.size);
    it.sp.material.opacity = it.fade;
    it.sp.visible = true;
    return it;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.sp.visible) continue;
      it.life += dt;
      const u = it.life / it.max;
      if (u >= 1) { it.sp.visible = false; it.sp.material.opacity = 0; continue; }
      it.vel.y -= it.grav * dt;
      it.sp.position.addScaledVector(it.vel, dt);
      it.sp.material.opacity = it.fade * (1 - u) * (1 - u);
      it.sp.scale.setScalar(it.size * (1 + u * 0.9));
    }
  }
}

export class Ball {
  constructor(scene, toonRamp) {
    this.scene = scene;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.prev = new THREE.Vector3();

    this.state = 'rest'; // rest | flight | physics | holed | splash
    this.onRest = null;
    this.onHoled = null;
    this.onEvent = null; // ('splash' | 'ob' | 'bounce', payload)

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 32, 24),
      new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp })
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    const soft = makeSoftSprite();
    this.softTex = soft;

    // Ground shadow blob — the single biggest readability win in flight.
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({
        map: soft, transparent: true, depthWrite: false, opacity: 0.3, color: 0x1d3a2a,
      })
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 2;
    scene.add(this.blob);

    this.trail = new Puffs(scene, soft, 44);
    this.debris = new Puffs(scene, soft, 34);

    // Expanding ring used for splashes and the ball dropping in the cup.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 56),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);
    this.ringT = 0;

    this._trailTimer = 0;
    this.apexY = 0;
    this.carryFrom = new THREE.Vector3();
  }

  // ------------------------------------------------------------------ placing
  placeAt(x, z) {
    this.pos.set(x, heightAt(x, z) + RADIUS, z);
    this.vel.set(0, 0, 0);
    this.state = 'rest';
    this.mesh.position.copy(this.pos);
    this.mesh.visible = true;
    this._syncBlob();
  }

  get resting() { return this.state === 'rest' || this.state === 'holed'; }

  // ------------------------------------------------------------------ launch
  /**
   * @param aim      heading in radians (0 = -Z)
   * @param power    0…1 from the swing
   * @param club     entry from CLUBS
   * @param lateral  -1…1 swipe curve: negative draws left, positive fades right
   * @param surface  the lie we're playing from
   */
  launch({ aim, power, club, lateral, surface }) {
    this.carryFrom.copy(this.pos);
    const lie = LIE_POWER[surface] ?? 1;
    const p = clamp(power, 0.06, 1);

    // Direction: a small start-line offset plus a curve that builds late,
    // so shaping a shot feels like shaping, not like aiming.
    const startOffset = lateral * 0.055;
    const a = aim + startOffset;
    this.dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    this.perp = new THREE.Vector3(Math.cos(aim), 0, Math.sin(aim));

    if (club === CLUBS.putter) {
      // Putts skip the arc entirely and roll from the first frame.
      // Calibrated against green friction so distance ≈ 45 × power² yards:
      // a quarter of the bar is a ten-footer, full bar covers the green.
      const speed = p * 19.5 * lie;
      this.vel.copy(this.dir).multiplyScalar(speed);
      this.vel.y = 0;
      this.state = 'physics';
      this.club = club;
      this.grounded = true;
      this.apexY = this.pos.y;
      return;
    }

    const carry = club.carry * p * lie;
    this.club = club;
    this.carry = carry;
    this.H = carry * club.apex;
    this.T = 0.95 + carry / 78;
    this.curve = lateral * carry * 0.075;
    this.t = 0;

    const land = this.pos.clone()
      .addScaledVector(this.dir, carry)
      .addScaledVector(this.perp, this.curve);
    this.landY = heightAt(land.x, land.z);
    this.startY = this.pos.y;

    this.state = 'flight';
    this.prev.copy(this.pos);
    this.apexY = this.pos.y;
    this._trailTimer = 0;

    // Turf spray at the strike.
    if (surface !== 'green') {
      const col = surface === 'sand' ? 0xf0dfb2 : 0x6fb856;
      for (let i = 0; i < 9; i++) {
        const v = new THREE.Vector3(
          (Math.random() - 0.5) * 3.2,
          1.6 + Math.random() * 3.4,
          (Math.random() - 0.5) * 3.2
        ).addScaledVector(this.dir, 2.4 + Math.random() * 3);
        this.debris.spawn(this.pos, {
          vel: v, grav: 16, life: 0.55 + Math.random() * 0.3,
          size: 0.28 + Math.random() * 0.3, color: col, opacity: 0.7,
        });
      }
    }
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    if (this.state === 'flight') this._flight(dt);
    else if (this.state === 'physics') this._physics(dt);

    this.trail.update(dt);
    this.debris.update(dt);
    this._updateRing(dt);
    this.mesh.position.copy(this.pos);
    this._syncBlob();
  }

  _flight(dt) {
    this.t += dt;
    const u = clamp(this.t / this.T, 0, 1);
    this.prev.copy(this.pos);

    // Horizontal progress decays exponentially — a soft, floaty deceleration.
    const K = 1.55;
    const along = (1 - Math.exp(-K * u)) / (1 - Math.exp(-K));
    // Apex sits just past halfway, which is what gives the shot its hang.
    const rise = Math.sin(Math.PI * Math.pow(u, 1.12));
    const side = this.curve * Math.pow(u, 1.85);

    this.pos.copy(this.carryFrom)
      .addScaledVector(this.dir, this.carry * along)
      .addScaledVector(this.perp, side);
    this.pos.y = lerp(this.startY, this.landY, u) + this.H * rise;

    this.apexY = Math.max(this.apexY, this.pos.y);

    // Gentle backspin — visual only.
    this.mesh.rotation.x -= dt * 9;

    // Soft vapour trail.
    this._trailTimer -= dt;
    if (this._trailTimer <= 0) {
      this._trailTimer = 0.026;
      this.trail.spawn(this.pos, { life: 0.75, size: 0.34, opacity: 0.34 });
    }

    // Terrain can interrupt the arc early (a hill, a bunker lip, the pond).
    // Ignored for the first fraction of the flight: the ball starts *on* the
    // ground, so a steep lie would otherwise register an instant landing.
    const ground = surfaceHeightAt(this.pos.x, this.pos.z) + RADIUS;
    const done = u >= 1;
    if (done || (u > 0.08 && this.pos.y <= ground)) {
      // Velocity from the last step, so the hand-off to physics is seamless.
      this.vel.subVectors(this.pos, this.prev).divideScalar(Math.max(dt, 1e-4));
      this.pos.y = Math.max(this.pos.y, ground);
      this.state = 'physics';
      this.grounded = false;
      this._checkSurfaceEvents();
    }
  }

  _physics(dt) {
    const s = surfaceAt(this.pos.x, this.pos.z);

    if (s === 'water' && this.pos.y <= WATER_Y + RADIUS + 0.2) return this._splash();

    const sp = SURF[s] ?? SURF.rough;
    const rollScale = this.club === CLUBS.putter ? 1 : this.club.roll;

    // ---- airborne ----
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.mesh.rotation.x -= dt * 6;

      const ground = surfaceHeightAt(this.pos.x, this.pos.z) + RADIUS;
      if (this.pos.y <= ground) {
        this.pos.y = ground;
        const impact = Math.abs(this.vel.y);
        const rest = sp.rest * lerp(0.55, 1, rollScale);
        const grip = clamp(sp.grip / lerp(0.6, 1, rollScale), 0, 0.95);

        this.vel.y = impact * rest;
        this.vel.x *= 1 - grip;
        this.vel.z *= 1 - grip;

        if (impact > 2.2 && this.onEvent) this.onEvent('bounce', { impact, surface: s });
        if (impact > 3.5) {
          const col = s === 'sand' ? 0xf0dfb2 : 0x77bf5e;
          for (let i = 0; i < 5; i++) {
            this.debris.spawn(this.pos, {
              vel: new THREE.Vector3((Math.random() - 0.5) * 2.4, 1 + Math.random() * 2, (Math.random() - 0.5) * 2.4),
              grav: 16, life: 0.4, size: 0.22, color: col, opacity: 0.55,
            });
          }
        }
        if (this.vel.y < 1.4) { this.vel.y = 0; this.grounded = true; }
      }
      this._checkCup(dt);
      return;
    }

    // ---- rolling ----
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 1e-4) {
      // Friction opposes motion; slope nudges it. Both stay gentle by design.
      const decel = sp.fric * lerp(1.35, 1, rollScale) * dt;
      const ns = Math.max(0, speed - decel);
      this.vel.x *= ns / speed;
      this.vel.z *= ns / speed;
    }
    const g = gradientAt(this.pos.x, this.pos.z);
    this.vel.x -= g.gx * 15 * dt;
    this.vel.z -= g.gz * 15 * dt;

    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = heightAt(this.pos.x, this.pos.z) + RADIUS;

    const rollSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.mesh.rotation.x -= rollSpeed * dt * 1.4;

    if (this._checkCup(dt)) return;

    if (rollSpeed < REST_SPEED) {
      this.vel.set(0, 0, 0);
      this.state = 'rest';
      this._checkSurfaceEvents(true);
    }
  }

  _checkCup() {
    const d = distToHole(this.pos.x, this.pos.z);
    const speed = this.vel.length();
    if (d < CUP_RADIUS && speed < CUP_SPEED && this.pos.y < heightAt(this.pos.x, this.pos.z) + RADIUS + 0.6) {
      this.pos.x = HOLE_POS.x;
      this.pos.z = HOLE_POS.z;
      this.pos.y = heightAt(HOLE_POS.x, HOLE_POS.z) - 0.55;
      this.vel.set(0, 0, 0);
      this.state = 'holed';
      this._popRing(0xffffff, 1.4, 0.55);
      if (this.onHoled) this.onHoled();
      return true;
    }
    return false;
  }

  _checkSurfaceEvents(atRest = false) {
    if (isOutOfBounds(this.pos.x, this.pos.z)) {
      this.state = 'rest';
      this.vel.set(0, 0, 0);
      if (this.onEvent) this.onEvent('ob');
      return;
    }
    if (atRest && this.onRest) this.onRest({ surface: surfaceAt(this.pos.x, this.pos.z) });
  }

  _splash() {
    this.state = 'splash';
    this.vel.set(0, 0, 0);
    this.pos.y = WATER_Y;
    this.mesh.visible = false;
    this._popRing(0x9fe4f0, 4.5, 1.1);
    for (let i = 0; i < 14; i++) {
      this.debris.spawn(this.pos, {
        vel: new THREE.Vector3((Math.random() - 0.5) * 5, 2.5 + Math.random() * 4, (Math.random() - 0.5) * 5),
        grav: 18, life: 0.7, size: 0.3, color: 0xd6f4fa, opacity: 0.85,
      });
    }
    if (this.onEvent) this.onEvent('splash');
  }

  // ------------------------------------------------------------------ effects
  _popRing(color, growTo, life) {
    this.ring.position.set(this.pos.x, this.pos.y + 0.06, this.pos.z);
    this.ring.material.color.set(color);
    this.ring.material.opacity = 0.85;
    this.ring.scale.setScalar(0.3);
    this.ring.visible = true;
    this.ringT = 0;
    this._ringGrow = growTo;
    this._ringLife = life;
  }

  _updateRing(dt) {
    if (!this.ring.visible) return;
    this.ringT += dt;
    const u = clamp(this.ringT / this._ringLife, 0, 1);
    this.ring.scale.setScalar(lerp(0.3, this._ringGrow, u));
    this.ring.material.opacity = 0.85 * (1 - u);
    if (u >= 1) this.ring.visible = false;
  }

  _syncBlob() {
    const gy = heightAt(this.pos.x, this.pos.z);
    const h = clamp(this.pos.y - gy, 0, 60);
    this.blob.position.set(this.pos.x, gy + 0.07, this.pos.z);
    this.blob.scale.setScalar(0.7 + h * 0.055);
    // Fade in only once the ball is genuinely airborne — on the ground the
    // real shadow map already does the job, and the blob just adds clutter.
    this.blob.material.opacity =
      smoothstep(0.25, 2.5, h) * lerp(0.34, 0.05, clamp(h / 45, 0, 1));
    this.blob.visible = this.mesh.visible && this.state !== 'holed' && h > 0.25;
  }

  /** Keep the ball readable at distance without ever looking like a beach ball. */
  updateScale(camera) {
    const d = camera.position.distanceTo(this.pos);
    const s = clamp(1 + (d - 14) * 0.022, 1, 3.6);
    this.mesh.scale.setScalar(s);
  }

  /** Soft mercy-drop after water or out of bounds. */
  dropNear(x, z) {
    // Walk back along the fairway until we find honest ground.
    let bx = x, bz = z;
    for (let i = 0; i < 60; i++) {
      const s = surfaceAt(bx, bz);
      if (s !== 'water' && !isOutOfBounds(bx, bz)) break;
      bz += 4;
      bx += 0.4;
    }
    this.mesh.visible = true;
    this.placeAt(bx, bz);
  }
}

export { RADIUS as BALL_RADIUS };
