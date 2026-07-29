/**
 * golfer.js — the cartoon character and the swing rig.
 *
 * Rig space: the origin is the *ball*, the target is -Z. The golfer stands on
 * the +X side, facing -X. That means the swing plane always contains the world
 * Z axis, so the club naturally travels down the target line.
 *
 * The whole swing is one number: `theta`.
 *      theta < 0   backswing (club goes back over the shoulder)
 *      theta = 0   impact — the club head sits exactly on the ball
 *      theta > 0   follow-through
 * Coil, wrist hinge, weight shift and head rotation are all derived from it,
 * which is why the motion reads as one connected body instead of parts.
 */

import * as THREE from 'three';
import { clamp, lerp, damp, easeInOutSine, easeOutCubic, easeOutQuint } from './util.js';

// --- rig landmarks -----------------------------------------------------------
const HANDS = new THREE.Vector3(0.60, 1.05, 0);
const BALL = new THREE.Vector3(0, 0.045, 0);
const _d = BALL.clone().sub(HANDS);
const CLUB_LEN = _d.length();
const PLANE_TILT = Math.asin(_d.x / CLUB_LEN); // tilts the swing plane off vertical

// --- swing shape -------------------------------------------------------------
// At rest the club is soled just behind the ball, the way it actually would
// be — which also stops the club head from hiding the ball at address.
const ADDRESS = -0.38;
const BACK_MAX = -2.55;   // radians at the top of a full backswing
const FINISH = 2.80;      // radians at the end of the follow-through
const DOWN_DUR = 0.30;    // seconds, top → impact
const THROUGH_DUR = 0.55; // impact → finish
const HOLD_DUR = 0.85;    // admire the shot
const RETURN_DUR = 0.90;  // ease back to address

const COL = {
  skin: 0xf5c69f,
  shirt: 0xff8f63,
  collar: 0xfff4ec,
  shorts: 0xf8f8f6,
  visor: 0xffd05c,
  brim: 0xfff6df,
  hair: 0x6f4a33,
  shades: 0x33454f,
  shoe: 0xffffff,
  sole: 0xff8f63,
  shaft: 0xdde3e8,
  head: 0xc3ccd3,
  grip: 0x333b42,
  belt: 0x4a5560,
  buckle: 0xd8c98a,
  ferrule: 0x2b3238,
  face: 0xdfe6ea,
};

export class Golfer {
  constructor(toonRamp) {
    this.ramp = toonRamp;
    this.root = new THREE.Group();
    this.root.name = 'golfer';

    this.theta = 0;
    this.thetaGoal = 0;
    this.hinge = 0;
    this.hingeGoal = 0;
    this.charge = 0;
    this.state = 'idle';
    this.timer = 0;
    this.thetaTop = 0;
    this.power = 0;
    this.onImpact = null;
    this.popT = 1; // 0→1 scale-in when the golfer walks up to a new lie

    this._build();
  }

  // -------------------------------------------------------------- construction
  _mat(color, extra = {}) {
    return new THREE.MeshToonMaterial({ color, gradientMap: this.ramp, ...extra });
  }

  _mesh(geo, color, parent, pos, extra) {
    const m = new THREE.Mesh(geo, this._mat(color, extra));
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    m.castShadow = true;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  }

  _build() {
    // A wrapper we scale for the "pop in" when moving to the next lie.
    this.scaler = new THREE.Group();
    this.root.add(this.scaler);

    // Stance: feet planted either side of the ball, body facing -X.
    this.stance = new THREE.Group();
    this.stance.position.set(0.80, 0, 0.05);
    this.scaler.add(this.stance);

    // ---- legs & shoes ----
    this.legs = new THREE.Group();
    this.stance.add(this.legs);
    for (const s of [-1, 1]) {
      const leg = this._mesh(new THREE.CapsuleGeometry(0.135, 0.30, 8, 24), COL.skin, this.legs,
        [0, 0.36, s * 0.20]);
      leg.rotation.x = s * 0.10;
      const shoe = this._mesh(new THREE.SphereGeometry(0.20, 24, 18), COL.shoe, this.legs,
        [-0.07, 0.11, s * 0.21]);
      shoe.scale.set(1.25, 0.62, 0.85);
      this._mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 28), COL.sole, this.legs,
        [-0.07, 0.045, s * 0.21]).scale.set(1.2, 1, 0.85);
    }

    // ---- hips → torso → head chain (each rotates a little more than the last) ----
    this.hips = new THREE.Group();
    this.hips.position.y = 0.55;
    this.stance.add(this.hips);
    this._mesh(new THREE.SphereGeometry(0.30, 32, 24), COL.shorts, this.hips, [0, 0.02, 0])
      .scale.set(0.92, 0.78, 1.0);

    this.torso = new THREE.Group();
    this.torso.position.y = 0.14;
    this.hips.add(this.torso);

    this.chest = this._mesh(new THREE.SphereGeometry(0.36, 36, 26), COL.shirt, this.torso, [0, 0.20, 0]);
    this.chest.scale.set(0.86, 1.02, 1.0);
    // A soft collar reads as a polo without any extra geometry cost.
    const collar = this._mesh(new THREE.TorusGeometry(0.155, 0.055, 16, 40), COL.collar, this.torso, [0, 0.50, 0]);
    collar.rotation.x = Math.PI / 2;
    // Belt at the waist: a small band, but it separates shirt from shorts and
    // stops the torso reading as one moulded lump.
    const belt = this._mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.085, 32), COL.belt, this.torso, [0, -0.11, 0]);
    belt.scale.set(0.94, 1, 1.02);
    this._mesh(new THREE.BoxGeometry(0.085, 0.075, 0.03), COL.buckle, this.torso, [-0.28, -0.11, 0]);

    this.head = new THREE.Group();
    this.head.position.y = 0.60;
    this.torso.add(this.head);
    this._mesh(new THREE.SphereGeometry(0.30, 40, 28), COL.skin, this.head, [0, 0.24, 0]);
    // hair tuft at the back
    this._mesh(new THREE.SphereGeometry(0.19, 24, 18), COL.hair, this.head, [0.20, 0.20, 0])
      .scale.set(0.75, 0.85, 1.0);
    // visor: band + brim, tipped forward over the eyes
    const band = this._mesh(new THREE.CylinderGeometry(0.305, 0.30, 0.14, 44, 1, true), COL.visor,
      this.head, [0, 0.36, 0], { side: THREE.DoubleSide });
    band.rotation.z = 0.10;
    const brim = this._mesh(new THREE.CylinderGeometry(0.40, 0.40, 0.045, 44), COL.brim, this.head,
      [-0.20, 0.33, 0]);
    brim.scale.set(0.62, 1, 1.0);
    brim.rotation.z = 0.22;
    // sunglasses: a single rounded band, no facial rigging needed
    const shades = this._mesh(new THREE.SphereGeometry(0.30, 32, 24), COL.shades, this.head, [-0.045, 0.22, 0]);
    shades.scale.set(0.99, 0.20, 1.02); // proud of the head on every side — no z-fighting

    // ---- swing assembly: plane → arm → wrist → club ----
    this.swingPlane = new THREE.Group();
    this.swingPlane.position.copy(HANDS).sub(this.stance.position);
    this.swingPlane.rotation.z = PLANE_TILT;
    this.stance.add(this.swingPlane);

    this.swingArm = new THREE.Group();
    this.swingPlane.add(this.swingArm);

    // Stubby mitten arms converging on the grip.
    for (const s of [-1, 1]) {
      const arm = this._mesh(new THREE.CapsuleGeometry(0.105, 0.34, 8, 24), COL.skin, this.swingArm,
        [0, -0.24, s * 0.13]);
      arm.rotation.x = -s * 0.22;
    }
    this._mesh(new THREE.SphereGeometry(0.135, 24, 18), COL.collar, this.swingArm, [0, -0.46, 0]);

    // Wrist hinge lives between the hands and the shaft — this is the detail
    // that makes the swing look like a swing and not a windmill.
    this.wrist = new THREE.Group();
    this.wrist.position.y = -0.46;
    this.swingArm.add(this.wrist);

    const shaftLen = CLUB_LEN - 0.46;
    this._mesh(new THREE.CylinderGeometry(0.034, 0.042, shaftLen, 20), COL.shaft, this.wrist,
      [0, -shaftLen / 2, 0]);
    this._mesh(new THREE.CylinderGeometry(0.045, 0.042, 0.30, 20), COL.grip, this.wrist, [0, -0.10, 0]);

    // Ferrule and hosel, then the head. Three small pieces, but a club that
    // just ends in a blob is the first thing that reads as untooled.
    this._mesh(new THREE.CylinderGeometry(0.040, 0.046, 0.075, 16), COL.ferrule, this.wrist,
      [0, -shaftLen + 0.09, 0]);
    const hosel = this._mesh(new THREE.CylinderGeometry(0.036, 0.040, 0.13, 16), COL.head, this.wrist,
      [-0.005, -shaftLen + 0.04, 0.005]);
    hosel.rotation.z = 0.10;

    const head = this._mesh(new THREE.SphereGeometry(0.13, 28, 20), COL.head, this.wrist,
      [-0.02, -shaftLen + 0.02, 0.05]);
    head.scale.set(0.9, 0.72, 1.5);
    this.clubHead = head;
    // Flat striking face, slightly proud so it catches the light separately.
    const face = this._mesh(new THREE.BoxGeometry(0.017, 0.155, 0.30), COL.face, this.wrist,
      [-0.128, -shaftLen + 0.02, 0.05]);
    face.rotation.z = -0.06;

    // Cache rest positions so idle motion can nudge them.
    this._hipsY = this.hips.position.y;
    this._hipsZ = this.hips.position.z;
  }

  // -------------------------------------------------------------- placement
  /** Move the rig to a new lie. `pop` plays a soft scale-in. */
  place(x, y, z, aim, pop = false) {
    this.root.position.set(x, y, z);
    this.root.rotation.y = aim;
    if (pop) this.popT = 0;
  }

  setAim(aim) { this.root.rotation.y = aim; }

  get visible() { return this.root.visible; }
  set visible(v) { this.root.visible = v; }

  // -------------------------------------------------------------- swing API
  beginBackswing() {
    if (this.state === 'idle' || this.state === 'return') this.state = 'back';
  }

  /** 0…1 backswing charge. Damped in update() so the club never jitters. */
  setCharge(v) {
    this.charge = clamp(v, 0, 1);
    if (this.state === 'back') {
      this.thetaGoal = lerp(ADDRESS, BACK_MAX, easeOutCubic(this.charge));
      this.hingeGoal = -0.95 * this.charge;
    }
  }

  release(power) {
    if (this.state !== 'back') return false;
    this.power = clamp(power, 0, 1);
    this.thetaTop = this.theta;
    this.state = 'down';
    this.timer = 0;
    return true;
  }

  cancel() {
    if (this.state !== 'back') return;
    this.state = 'return';
    this.timer = 0;
    this._returnFrom = this.theta;
    this._hingeFrom = this.hinge;
    this.charge = 0;
  }

  get isSwinging() { return this.state === 'down' || this.state === 'through' || this.state === 'hold'; }
  get isBusy() { return this.state !== 'idle'; }

  /** Snap straight back to address — used when walking up to the next lie. */
  forceIdle() {
    this.state = 'idle';
    this.theta = ADDRESS; this.thetaGoal = ADDRESS;
    this.hinge = 0; this.hingeGoal = 0;
    this.charge = 0; this.timer = 0;
  }

  // -------------------------------------------------------------- per frame
  update(dt, time) {
    // Soft scale-in when the golfer arrives at a new ball.
    if (this.popT < 1) {
      this.popT = Math.min(1, this.popT + dt / 0.45);
      const s = easeOutQuint(this.popT);
      this.scaler.scale.setScalar(lerp(0.001, 1, s));
      this.scaler.position.y = lerp(0.5, 0, 1 - s) * 0.6;
    }

    switch (this.state) {
      case 'back':
        // Damped so the club follows the thumb smoothly rather than snapping.
        this.theta = damp(this.theta, this.thetaGoal, 11, dt);
        this.hinge = damp(this.hinge, this.hingeGoal, 9, dt);
        break;

      case 'down': {
        this.timer += dt;
        // Slightly quicker downswing on a big shot — reads as more committed.
        const dur = DOWN_DUR * lerp(1.12, 0.9, this.power);
        const u = clamp(this.timer / dur, 0, 1);
        // Accelerating curve: slow at the top, fastest exactly at impact.
        this.theta = lerp(this.thetaTop, 0, Math.pow(u, 1.75));
        // Wrists release late, which is what gives the swing its snap.
        this.hinge = lerp(this.thetaTop * -0.37, 0, easeInOutSine(clamp(u / 0.88, 0, 1)));
        if (u >= 1) {
          this.state = 'through';
          this.timer = 0;
          if (this.onImpact) this.onImpact(this.power);
        }
        break;
      }

      case 'through': {
        this.timer += dt;
        const u = clamp(this.timer / THROUGH_DUR, 0, 1);
        this.theta = lerp(0, FINISH * lerp(0.72, 1, this.power), easeOutCubic(u));
        this.hinge = lerp(0, 0.75, easeOutCubic(u));
        if (u >= 1) { this.state = 'hold'; this.timer = 0; }
        break;
      }

      case 'hold':
        this.timer += dt;
        if (this.timer >= HOLD_DUR) {
          this.state = 'return';
          this.timer = 0;
          this._returnFrom = this.theta;
          this._hingeFrom = this.hinge;
        }
        break;

      case 'return': {
        this.timer += dt;
        const u = clamp(this.timer / RETURN_DUR, 0, 1);
        const e = easeInOutSine(u);
        this.theta = lerp(this._returnFrom, ADDRESS, e);
        this.hinge = lerp(this._hingeFrom, 0, e);
        if (u >= 1) { this.state = 'idle'; this.charge = 0; this.hinge = 0; }
        break;
      }

      default: // idle — a barely-there waggle keeps the character alive
        this.theta = damp(this.theta, ADDRESS + Math.sin(time * 1.1) * 0.035, 6, dt);
        this.hinge = damp(this.hinge, 0, 6, dt);
    }

    this._applyPose(time);
  }

  /** Everything below is derived from `theta` — one motion, many parts. */
  _applyPose(time) {
    const t = this.theta;

    this.swingArm.rotation.x = t;
    this.wrist.rotation.x = this.hinge;

    // Coil: shoulders turn away on the backswing and through to the target.
    this.torso.rotation.y = -t * 0.30;
    this.torso.rotation.z = clamp(t, 0, FINISH) * 0.055;
    this.hips.rotation.y = -t * 0.14;

    // Eyes stay on the ball until well after impact.
    this.head.rotation.y = t * 0.21;
    this.head.rotation.z = -0.10 - clamp(-t, 0, 2.6) * 0.03;

    // Weight shifts back, then forward and up onto the front foot.
    const fwd = clamp(t, 0, FINISH) / FINISH;
    this.hips.position.z = this._hipsZ + t * 0.045;
    this.hips.position.y = this._hipsY + fwd * 0.07 + Math.sin(time * 1.4) * 0.006;
    this.legs.rotation.y = -t * 0.10;

    // Breathing — 1.5% is enough to read as alive without ever distracting.
    const breathe = 1 + Math.sin(time * 1.6) * 0.015;
    this.chest.scale.set(0.86, 1.02 * breathe, 1.0);
  }
}

export { CLUB_LEN, PLANE_TILT };
