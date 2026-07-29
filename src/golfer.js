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
  sock: 0xfdfdfb,
  glove: 0xf4f6f8,
  lace: 0xe6e9ec,
  spike: 0x98a3ab,
  brow: 0x5a3b28,
  mouth: 0xc9776a,
  seam: 0xef7f52,
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
    // Carried across the release so the downswing starts at the speed the club
    // is already travelling, and the wrist from where it actually is.
    this._thetaVel = 0;
    this.thetaVel0 = 0;
    this.hingeTop = 0;
    this._impactVel = 0;
    this.onImpact = null;
    this.popT = 1; // 0→1 scale-in when the golfer walks up to a new lie

    this._build();
  }

  // -------------------------------------------------------------- construction
  /**
   * Several primitives, welded into one mesh.
   *
   * Detail on a character is dozens of small rigid pieces, and a mesh each
   * would put fifty draw calls on screen for one figure — which on the machine
   * that is already struggling for frame rate costs more than the detail is
   * worth. Anything sharing a colour that never moves relative to its parent
   * can be baked together once, at build time, and cost one call.
   *
   * Position and normal only: these materials carry a gradient ramp rather than
   * a texture, and toon shading looks the ramp up by dot(N,L), so there is no
   * UV to preserve.
   */
  _weld(color, parent, parts, extra = {}) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const baked = [];
    let vTotal = 0, iTotal = 0;
    for (const p of parts) {
      const g = p.geo.index ? p.geo : p.geo.toNonIndexed();
      e.set(...(p.rot ?? [0, 0, 0]));
      m.compose(
        new THREE.Vector3(...(p.pos ?? [0, 0, 0])),
        q.setFromEuler(e),
        new THREE.Vector3(...(p.scale ?? [1, 1, 1]))
      );
      g.applyMatrix4(m);
      baked.push(g);
      vTotal += g.attributes.position.count;
      iTotal += g.index.count;
    }
    const position = new Float32Array(vTotal * 3);
    const normal = new Float32Array(vTotal * 3);
    const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
    let vo = 0, io = 0;
    for (const g of baked) {
      position.set(g.attributes.position.array, vo * 3);
      normal.set(g.attributes.normal.array, vo * 3);
      const src = g.index.array;
      for (let k = 0; k < src.length; k++) index[io + k] = src[k] + vo;
      vo += g.attributes.position.count;
      io += src.length;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(geo, this._mat(color, extra));
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

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

    // ---- legs: hip → knee → ankle, one chain per side ----
    // Jointed rather than a single capsule, so the knees can take the weight
    // shift and the trail heel can come off the ground at the finish. Those two
    // things are most of what separates a golf swing from a torso spinning on a
    // pole, and neither is possible on a rigid leg.
    this.legs = new THREE.Group();
    this.stance.add(this.legs);
    this.legRig = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(0, 0.60, s * 0.20);
      hip.rotation.x = s * 0.055;
      this.legs.add(hip);
      this._weld(COL.skin, hip, [
        { geo: new THREE.CapsuleGeometry(0.134, 0.15, 10, 26), pos: [0, -0.12, 0] },
        { geo: new THREE.SphereGeometry(0.126, 22, 16), pos: [0, -0.235, 0] },   // kneecap
      ]);

      const knee = new THREE.Group();
      knee.position.y = -0.235;
      hip.add(knee);
      this._weld(COL.skin, knee, [
        { geo: new THREE.CapsuleGeometry(0.112, 0.13, 10, 24), pos: [0, -0.12, 0] },  // calf
        { geo: new THREE.SphereGeometry(0.118, 18, 14), pos: [0.03, -0.07, 0], scale: [0.8, 1.1, 0.9] },
        { geo: new THREE.SphereGeometry(0.082, 18, 14), pos: [0, -0.245, 0] },        // ankle
      ]);
      this._weld(COL.sock, knee, [
        { geo: new THREE.CylinderGeometry(0.098, 0.092, 0.115, 26), pos: [0, -0.215, 0] },
        { geo: new THREE.TorusGeometry(0.096, 0.016, 10, 26), pos: [0, -0.158, 0], rot: [Math.PI / 2, 0, 0] },
      ]);

      const foot = new THREE.Group();
      foot.position.y = -0.275;
      knee.add(foot);
      this._weld(COL.shoe, foot, [
        { geo: new THREE.SphereGeometry(0.20, 26, 18), pos: [-0.055, 0.05, 0], scale: [1.30, 0.58, 0.86] },
        { geo: new THREE.SphereGeometry(0.115, 20, 14), pos: [0.085, 0.062, 0], scale: [0.92, 0.9, 0.96] },
        { geo: new THREE.SphereGeometry(0.075, 16, 12), pos: [-0.20, 0.045, 0], scale: [0.9, 0.7, 1.0] },
      ]);
      this._weld(COL.sole, foot, [
        { geo: new THREE.CylinderGeometry(0.196, 0.186, 0.048, 30), pos: [-0.055, 0.014, 0], scale: [1.26, 1, 0.86] },
      ]);
      this._weld(COL.lace, foot, [
        { geo: new THREE.BoxGeometry(0.052, 0.015, 0.095), pos: [-0.095, 0.115, 0], rot: [0, 0, 0.1] },
        { geo: new THREE.BoxGeometry(0.052, 0.015, 0.088), pos: [-0.163, 0.098, 0], rot: [0, 0, 0.16] },
      ]);
      const spikes = [];
      for (const dx of [-0.185, -0.055, 0.075]) {
        for (const dz of [-0.055, 0.055]) {
          spikes.push({ geo: new THREE.CylinderGeometry(0.015, 0.012, 0.026, 8), pos: [dx, -0.014, dz] });
        }
      }
      this._weld(COL.spike, foot, spikes);

      this.legRig.push({ s, hip, knee, foot });
    }

    // ---- hips → torso → head chain (each rotates a little more than the last) ----
    this.hips = new THREE.Group();
    this.hips.position.y = 0.55;
    this.stance.add(this.hips);
    this._weld(COL.shorts, this.hips, [
      { geo: new THREE.SphereGeometry(0.30, 32, 24), pos: [0, 0.02, 0], scale: [0.92, 0.78, 1.0] },
      // Short legs, so the shorts read as tailored rather than painted on.
      { geo: new THREE.CylinderGeometry(0.145, 0.152, 0.13, 24), pos: [0, -0.15, 0.145], rot: [0.06, 0, 0] },
      { geo: new THREE.CylinderGeometry(0.145, 0.152, 0.13, 24), pos: [0, -0.15, -0.145], rot: [-0.06, 0, 0] },
      { geo: new THREE.BoxGeometry(0.02, 0.20, 0.012), pos: [-0.275, -0.02, 0] },   // fly seam
    ]);

    this.torso = new THREE.Group();
    this.torso.position.y = 0.14;
    this.hips.add(this.torso);

    // The chest stays its own mesh — update() breathes with its scale.
    this.chest = this._mesh(new THREE.SphereGeometry(0.36, 36, 26), COL.shirt, this.torso, [0, 0.20, 0]);
    this.chest.scale.set(0.86, 1.02, 1.0);
    // Shoulder caps and short sleeves, welded into one piece with the placket.
    this._weld(COL.shirt, this.torso, [
      { geo: new THREE.SphereGeometry(0.145, 22, 16), pos: [0, 0.36, 0.26], scale: [0.95, 0.9, 1.05] },
      { geo: new THREE.SphereGeometry(0.145, 22, 16), pos: [0, 0.36, -0.26], scale: [0.95, 0.9, 1.05] },
      { geo: new THREE.CylinderGeometry(0.128, 0.138, 0.20, 24), pos: [0, 0.24, 0.30], rot: [0.20, 0, 0] },
      { geo: new THREE.CylinderGeometry(0.128, 0.138, 0.20, 24), pos: [0, 0.24, -0.30], rot: [-0.20, 0, 0] },
      { geo: new THREE.BoxGeometry(0.055, 0.30, 0.075), pos: [-0.30, 0.24, 0], rot: [0, 0, -0.06] },
    ]);
    // Sleeve hems and three buttons, in the trim colour.
    this._weld(COL.collar, this.torso, [
      { geo: new THREE.TorusGeometry(0.132, 0.020, 10, 26), pos: [0, 0.145, 0.325], rot: [Math.PI / 2 + 0.20, 0, 0] },
      { geo: new THREE.TorusGeometry(0.132, 0.020, 10, 26), pos: [0, 0.145, -0.325], rot: [Math.PI / 2 - 0.20, 0, 0] },
      { geo: new THREE.SphereGeometry(0.021, 10, 8), pos: [-0.335, 0.335, 0] },
      { geo: new THREE.SphereGeometry(0.021, 10, 8), pos: [-0.338, 0.255, 0] },
      { geo: new THREE.SphereGeometry(0.021, 10, 8), pos: [-0.330, 0.175, 0] },
    ]);
    // A soft collar reads as a polo without any extra geometry cost.
    const collar = this._mesh(new THREE.TorusGeometry(0.155, 0.055, 16, 40), COL.collar, this.torso, [0, 0.50, 0]);
    collar.rotation.x = Math.PI / 2;
    // Belt at the waist: a small band, but it separates shirt from shorts and
    // stops the torso reading as one moulded lump.
    const belt = this._mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.085, 32), COL.belt, this.torso, [0, -0.11, 0]);
    belt.scale.set(0.94, 1, 1.02);
    this._weld(COL.buckle, this.torso, [
      { geo: new THREE.BoxGeometry(0.085, 0.075, 0.03), pos: [-0.28, -0.11, 0] },
      { geo: new THREE.TorusGeometry(0.030, 0.008, 8, 18), pos: [-0.283, -0.11, 0], rot: [0, Math.PI / 2, 0] },
    ]);
    this._weld(COL.belt, this.torso, [
      { geo: new THREE.BoxGeometry(0.035, 0.105, 0.055), pos: [-0.20, -0.11, 0.21] },
      { geo: new THREE.BoxGeometry(0.035, 0.105, 0.055), pos: [-0.20, -0.11, -0.21] },
      { geo: new THREE.BoxGeometry(0.035, 0.105, 0.055), pos: [0.26, -0.11, 0.10] },
      { geo: new THREE.BoxGeometry(0.035, 0.105, 0.055), pos: [0.26, -0.11, -0.10] },
    ]);

    this.head = new THREE.Group();
    this.head.position.y = 0.60;
    this.torso.add(this.head);
    // Skull, jaw, ears, nose and neck, welded. Individually these are tiny
    // pieces of geometry, but a head that is one sphere is the single thing
    // that reads most strongly as unfinished, whatever else is going on.
    this._weld(COL.skin, this.head, [
      { geo: new THREE.SphereGeometry(0.30, 40, 28), pos: [0, 0.24, 0] },
      // jaw and chin, pulled forward and down off the skull
      { geo: new THREE.SphereGeometry(0.215, 28, 20), pos: [-0.055, 0.115, 0], scale: [1.02, 0.86, 0.94] },
      { geo: new THREE.SphereGeometry(0.085, 18, 14), pos: [-0.175, 0.085, 0], scale: [0.95, 0.8, 0.9] },
      // ears
      { geo: new THREE.SphereGeometry(0.072, 16, 12), pos: [0.035, 0.235, 0.275], scale: [0.75, 1.15, 0.5] },
      { geo: new THREE.SphereGeometry(0.072, 16, 12), pos: [0.035, 0.235, -0.275], scale: [0.75, 1.15, 0.5] },
      // Nose, sitting below the sunglasses and proud of both the skull and the
      // jaw — each of which reaches about x = -0.28, so anything shallower than
      // this is simply inside the head and invisible.
      { geo: new THREE.SphereGeometry(0.052, 16, 12), pos: [-0.300, 0.150, 0], scale: [1.15, 0.90, 0.80] },
      // neck
      { geo: new THREE.CylinderGeometry(0.115, 0.135, 0.16, 22), pos: [0.01, -0.03, 0] },
    ]);
    // Brows and mouth. Flat colour on the surface — no rigging, but it gives
    // the face a direction, which is what makes it look at the ball.
    // No brows — they would sit behind the sunglasses, which reach further
    // forward than the skull does. The mouth has to clear the chin.
    this._weld(COL.mouth, this.head, [
      { geo: new THREE.SphereGeometry(0.040, 16, 12), pos: [-0.272, 0.072, 0], scale: [0.55, 0.42, 1.30] },
    ]);
    // Hair: a back mass plus temple tufts under the visor band.
    this._weld(COL.hair, this.head, [
      { geo: new THREE.SphereGeometry(0.19, 24, 18), pos: [0.20, 0.20, 0], scale: [0.75, 0.85, 1.0] },
      { geo: new THREE.SphereGeometry(0.145, 20, 14), pos: [0.155, 0.30, 0.155], scale: [0.8, 0.7, 0.85] },
      { geo: new THREE.SphereGeometry(0.145, 20, 14), pos: [0.155, 0.30, -0.155], scale: [0.8, 0.7, 0.85] },
      { geo: new THREE.SphereGeometry(0.10, 16, 12), pos: [0.055, 0.255, 0.245], scale: [0.9, 0.8, 0.6] },
      { geo: new THREE.SphereGeometry(0.10, 16, 12), pos: [0.055, 0.255, -0.245], scale: [0.9, 0.8, 0.6] },
    ]);
    // visor: band + brim, tipped forward over the eyes
    const band = this._mesh(new THREE.CylinderGeometry(0.305, 0.30, 0.14, 44, 1, true), COL.visor,
      this.head, [0, 0.36, 0], { side: THREE.DoubleSide });
    band.rotation.z = 0.10;
    const brim = this._mesh(new THREE.CylinderGeometry(0.40, 0.40, 0.045, 44), COL.brim, this.head,
      [-0.20, 0.33, 0]);
    brim.scale.set(0.62, 1, 1.0);
    brim.rotation.z = 0.22;
    // Sunglasses: a wrapped frame with two lenses set into it, rather than one
    // flattened band. Still no facial rigging, but the lenses catch the light
    // separately from the frame, which is what makes them read as glass.
    this._weld(COL.shades, this.head, [
      { geo: new THREE.SphereGeometry(0.30, 32, 24), pos: [-0.045, 0.225, 0], scale: [0.99, 0.175, 1.02] },
      // arms of the frame, running back to the ears
      { geo: new THREE.BoxGeometry(0.28, 0.028, 0.022), pos: [0.055, 0.235, 0.255], rot: [0, -0.12, 0] },
      { geo: new THREE.BoxGeometry(0.28, 0.028, 0.022), pos: [0.055, 0.235, -0.255], rot: [0, 0.12, 0] },
    ]);
    this._weld(COL.face, this.head, [
      { geo: new THREE.SphereGeometry(0.30, 28, 20), pos: [-0.062, 0.228, 0.105], scale: [0.97, 0.115, 0.42] },
      { geo: new THREE.SphereGeometry(0.30, 28, 20), pos: [-0.062, 0.228, -0.105], scale: [0.97, 0.115, 0.42] },
    ]);

    // ---- swing assembly: plane → arm → wrist → club ----
    this.swingPlane = new THREE.Group();
    this.swingPlane.position.copy(HANDS).sub(this.stance.position);
    this.swingPlane.rotation.z = PLANE_TILT;
    this.stance.add(this.swingPlane);

    this.swingArm = new THREE.Group();
    this.swingPlane.add(this.swingArm);

    // Arms with an elbow in them, converging on the grip.
    const armParts = [];
    for (const s of [-1, 1]) {
      armParts.push(
        // upper arm
        { geo: new THREE.CapsuleGeometry(0.104, 0.15, 10, 24), pos: [0, -0.115, s * 0.155], rot: [-s * 0.30, 0, 0] },
        // elbow
        { geo: new THREE.SphereGeometry(0.098, 18, 14), pos: [0, -0.225, s * 0.135] },
        // forearm, tapering into the hands
        { geo: new THREE.CapsuleGeometry(0.086, 0.16, 10, 24), pos: [0, -0.335, s * 0.085], rot: [-s * 0.34, 0, 0] },
      );
    }
    this._weld(COL.skin, this.swingArm, armParts);
    // Both hands on the grip: a glove on the lead hand, bare on the trail,
    // with a thumb apiece. It is a small thing but the hands are the closest
    // part of the figure to the camera at address.
    this._weld(COL.glove, this.swingArm, [
      { geo: new THREE.SphereGeometry(0.108, 22, 16), pos: [0, -0.445, 0.045], scale: [0.95, 1.15, 0.85] },
      { geo: new THREE.CapsuleGeometry(0.030, 0.055, 8, 14), pos: [-0.06, -0.425, 0.055], rot: [0, 0, 0.5] },
    ]);
    this._weld(COL.skin, this.swingArm, [
      { geo: new THREE.SphereGeometry(0.104, 22, 16), pos: [0, -0.49, -0.035], scale: [0.95, 1.1, 0.85] },
      { geo: new THREE.CapsuleGeometry(0.028, 0.05, 8, 14), pos: [-0.058, -0.475, -0.03], rot: [0, 0, 0.5] },
    ]);

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
    // Carry the club's actual state across the transition instead of
    // re-deriving it. Both of these were being thrown away, and that is what
    // made the release feel like a mechanism rather than a swing.
    this.thetaVel0 = this._thetaVel;
    this.hingeTop = this.hinge;
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
    this._thetaVel = 0; this.hingeTop = 0; this._impactVel = 0;
  }

  /**
   * Pose the follow-through from `this.timer`. Returns true once it is spent.
   *
   * Split out so the downswing can hand over *within* a frame. A frame almost
   * never lands exactly on impact, and the two obvious ways of dealing with
   * that both show: clamp the club to the ball for the leftover fraction and it
   * stalls at the fastest moment of the swing, or carry the leftover into the
   * next phase while still clamping and it stalls and then lurches. Spending
   * the remainder here instead means the club simply passes through the ball
   * between frames, the way it actually would.
   */
  _poseThrough() {
    const u = clamp(this.timer / THROUGH_DUR, 0, 1);
    const end = FINISH * lerp(0.72, 1, this.power);
    // Enters at exactly the speed it left the ball with, and comes to rest at
    // the finish. Matching velocity across impact is what stops the
    // follow-through reading as a separate animation played back to back.
    const m0 = (this._impactVel || 0) * THROUGH_DUR;
    const u2 = u * u, u3 = u2 * u;
    this.theta = (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * end;
    this.hinge = lerp(0, 0.75, easeOutCubic(u));
    return u >= 1;
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
      case 'back': {
        // Damped so the club follows the thumb smoothly rather than snapping.
        const was = this.theta;
        this.theta = damp(this.theta, this.thetaGoal, 11, dt);
        this.hinge = damp(this.hinge, this.hingeGoal, 9, dt);
        // Kept so the downswing can start at the speed the club is already
        // travelling, rather than from rest.
        if (dt > 1e-4) this._thetaVel = (this.theta - was) / dt;
        break;
      }

      case 'down': {
        this.timer += dt;
        // Slightly quicker on a big shot — reads as more committed — and
        // quicker again off a short backswing, so a half swing is crisp
        // instead of drifting down at the pace of a full one.
        const backFrac = clamp((this.thetaTop - ADDRESS) / (BACK_MAX - ADDRESS), 0, 1);
        const dur = DOWN_DUR * lerp(1.12, 0.9, this.power) * lerp(0.74, 1, backFrac);
        const u = clamp(this.timer / dur, 0, 1);

        // A cubic Hermite rather than a power curve.
        //
        // A power curve has zero slope at u = 0, so the club stopped dead at
        // the top no matter how fast it was still moving, then set off again
        // from nothing. Hermite takes a velocity at each end: it leaves the
        // top still carrying whatever the backswing had — which produces the
        // small float at the top that a real swing has, for free — and arrives
        // at the ball at a speed we choose, so the fastest instant is impact.
        const m0 = this.thetaVel0 * dur;
        const m1 = -this.thetaTop * 1.9;
        this._impactVel = m1 / dur;

        if (this.timer < dur) {
          const u2 = u * u, u3 = u2 * u;
          this.theta = (2 * u3 - 3 * u2 + 1) * this.thetaTop
                     + (u3 - 2 * u2 + u) * m0
                     + (u3 - u2) * m1;
          // Wrist lag: hold the cock through the first third, then release it
          // into the ball. Starting from where the wrist actually is matters —
          // this used to restart from a recomputed value of the opposite sign
          // and flip instantly at release.
          const rel = clamp((u - 0.34) / 0.62, 0, 1);
          this.hinge = lerp(this.hingeTop, 0, easeInOutSine(rel));
        } else {
          // Impact happened partway through this frame. Fire it, then spend
          // what is left of the frame in the follow-through rather than
          // parking the club on the ball until the next one.
          this.state = 'through';
          this.timer -= dur;
          if (this.onImpact) this.onImpact(this.power);
          if (this._poseThrough()) { this.state = 'hold'; this.timer = 0; }
        }
        break;
      }

      case 'through':
        this.timer += dt;
        if (this._poseThrough()) {
          this.state = 'hold';
          this.timer = Math.max(0, this.timer - THROUGH_DUR);
        }
        break;

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

    // Legs work. A little flex at address, more as the body coils away, and
    // then the lead leg posts up and straightens as the weight arrives on it
    // while the trail heel comes off the ground — which is the pose everyone
    // recognises as the end of a golf swing, and it costs three rotations.
    const coil = clamp(-t, 0, -BACK_MAX) / -BACK_MAX;
    for (const L of this.legRig) {
      const trail = L.s > 0;               // the target is -Z, so +Z is the trail side
      const flex = 0.15 + coil * 0.19 - (trail ? 0 : fwd * 0.20);
      L.knee.rotation.x = flex;
      L.foot.rotation.x = -flex;           // sole stays level under the shin
      L.foot.rotation.z = trail ? fwd * 0.62 : -fwd * 0.10;
      L.foot.position.y = -0.275 + (trail ? fwd * 0.05 : 0);
      L.hip.rotation.x = L.s * 0.055 + coil * (trail ? 0.06 : -0.04);
    }

    // Breathing — 1.5% is enough to read as alive without ever distracting.
    const breathe = 1 + Math.sin(time * 1.6) * 0.015;
    this.chest.scale.set(0.86, 1.02 * breathe, 1.0);
  }
}

export { CLUB_LEN, PLANE_TILT };
