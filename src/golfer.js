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
// Not the hands — the *shoulder pivot* the arms and club swing about. Raised
// with the redesign: the new figure carries its shoulders at about 1.32, and
// leaving this at the old 1.05 sprouted the arms out of the middle of the
// chest. Everything downstream derives from it, so the club simply gets the
// length a taller golfer's would.
const HANDS = new THREE.Vector3(0.58, 1.32, 0);
const BALL = new THREE.Vector3(0, 0.045, 0);
const _d = BALL.clone().sub(HANDS);
const CLUB_LEN = _d.length();
const PLANE_TILT = Math.asin(_d.x / CLUB_LEN); // tilts the swing plane off vertical

// --- swing shape -------------------------------------------------------------
// At rest the club is soled just behind the ball, the way it actually would
// be — which also stops the club head from hiding the ball at address.
const ADDRESS = -0.30;
const BACK_MAX = -2.55;   // radians at the top of a full backswing
const FINISH = 2.80;      // radians at the end of the follow-through
const DOWN_DUR = 0.30;    // seconds, top → impact
const THROUGH_DUR = 0.55; // impact → finish
const HOLD_DUR = 0.85;    // admire the shot
const RETURN_DUR = 0.90;  // ease back to address

/**
 * Kit.
 *
 * Tournament dress rather than holiday dress: a white polo with a coral
 * placket, charcoal trousers, a navy cap. Against a course that is almost
 * entirely green and sand, white and near-black are the two values that read
 * cleanly at any distance, and the coral is the only saturated thing on the
 * figure so it is where the eye lands.
 */
const COL = {
  skin: 0xf0bd93,
  skinShade: 0xdca67c,
  polo: 0xfbfbf9,
  poloTrim: 0xf4744e,
  collar: 0xffffff,
  trouser: 0x3d4652,
  trouserDark: 0x333b46,
  cap: 0x24384f,
  capBrim: 0x1b2a3c,
  hair: 0x5c3d29,
  shades: 0x2b3a44,
  lens: 0x8fb6c4,
  shoe: 0xfafafa,
  shoeTrim: 0x24384f,
  sole: 0xe4e7ea,
  sock: 0xfdfdfb,
  glove: 0xf6f8fa,
  lace: 0xdfe3e7,
  spike: 0x9aa4ac,
  belt: 0x2a3038,
  buckle: 0xcfc08a,
  mouth: 0xc07a6c,
  shaft: 0xdde3e8,
  head: 0xc3ccd3,
  grip: 0x2b3238,
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
    // Carried across the release so the downswing starts at the speed the club
    // is already travelling, and the wrist from where it actually is.
    this._thetaVel = 0;
    this.thetaVel0 = 0;
    this.hingeTop = 0;
    this._impactVel = 0;
    this.driveGoal = 0;
    this.driveAuto = 0;
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
    //
    // Proportions are the redesign. The old figure was about three and a half
    // heads tall, which reads as a toddler holding a driver — fine for a
    // mascot, but it fights an art direction that is otherwise trying to look
    // like a real golf course. This one is close to six heads, with the mass in
    // the shoulders and legs long enough for an athletic posture to be legible.
    //
    // One fixed point constrains all of it: the hands sit at y = 1.05, because
    // that is where the club length was measured from. Everything else hangs
    // around that.
    this.stance = new THREE.Group();
    this.stance.position.set(0.80, 0, 0.05);
    this.scaler.add(this.stance);

    // ---- legs: hip -> knee -> ankle, one chain per side ----
    this.legs = new THREE.Group();
    this.stance.add(this.legs);
    this.legRig = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(0, 0.86, s * 0.17);
      hip.rotation.x = s * 0.05;
      this.legs.add(hip);

      // Thigh: trousers tapering to the knee, with a crease down the front.
      this._weld(COL.trouser, hip, [
        { geo: new THREE.CylinderGeometry(0.132, 0.108, 0.40, 22), pos: [0, -0.20, 0] },
        { geo: new THREE.SphereGeometry(0.132, 20, 15), pos: [0, -0.01, 0] },
        { geo: new THREE.SphereGeometry(0.106, 18, 14), pos: [0, -0.41, 0] },
      ]);
      this._weld(COL.trouserDark, hip, [
        { geo: new THREE.BoxGeometry(0.012, 0.38, 0.020), pos: [-0.104, -0.20, 0] },
      ]);

      const knee = new THREE.Group();
      knee.position.y = -0.41;
      hip.add(knee);
      // Calf, then the trouser breaking over the shoe.
      this._weld(COL.trouser, knee, [
        { geo: new THREE.CylinderGeometry(0.104, 0.086, 0.34, 22), pos: [0, -0.17, 0] },
        { geo: new THREE.CylinderGeometry(0.092, 0.098, 0.07, 22), pos: [0, -0.355, 0.008] },
      ]);
      this._weld(COL.trouserDark, knee, [
        { geo: new THREE.BoxGeometry(0.012, 0.32, 0.020), pos: [-0.088, -0.17, 0] },
      ]);
      this._weld(COL.sock, knee, [
        { geo: new THREE.CylinderGeometry(0.072, 0.070, 0.07, 18), pos: [0, -0.415, 0] },
      ]);

      const foot = new THREE.Group();
      foot.position.y = -0.45;
      knee.add(foot);
      // Golf shoe: low upper, toe cap, heel counter, welted sole.
      this._weld(COL.shoe, foot, [
        { geo: new THREE.SphereGeometry(0.155, 24, 17), pos: [-0.045, 0.058, 0], scale: [1.45, 0.62, 0.90] },
        { geo: new THREE.SphereGeometry(0.092, 18, 13), pos: [0.075, 0.072, 0], scale: [0.95, 1.00, 0.98] },
        { geo: new THREE.SphereGeometry(0.062, 16, 12), pos: [-0.185, 0.048, 0], scale: [0.95, 0.72, 1.00] },
      ]);
      this._weld(COL.shoeTrim, foot, [
        { geo: new THREE.TorusGeometry(0.078, 0.016, 10, 24), pos: [0.030, 0.100, 0], rot: [Math.PI / 2, 0, 0.10] },
        { geo: new THREE.BoxGeometry(0.075, 0.030, 0.016), pos: [-0.10, 0.055, 0.082], rot: [0, 0, 0.08] },
        { geo: new THREE.BoxGeometry(0.075, 0.030, 0.016), pos: [-0.10, 0.055, -0.082], rot: [0, 0, 0.08] },
      ]);
      this._weld(COL.sole, foot, [
        { geo: new THREE.CylinderGeometry(0.152, 0.144, 0.040, 26), pos: [-0.045, 0.018, 0], scale: [1.42, 1, 0.90] },
      ]);
      this._weld(COL.lace, foot, [
        { geo: new THREE.BoxGeometry(0.044, 0.013, 0.076), pos: [-0.055, 0.104, 0], rot: [0, 0, 0.06] },
        { geo: new THREE.BoxGeometry(0.044, 0.013, 0.070), pos: [-0.115, 0.093, 0], rot: [0, 0, 0.12] },
      ]);
      const spikes = [];
      for (const dx of [-0.155, -0.045, 0.065]) {
        for (const dz of [-0.045, 0.045]) {
          spikes.push({ geo: new THREE.CylinderGeometry(0.013, 0.010, 0.022, 7), pos: [dx, -0.005, dz] });
        }
      }
      this._weld(COL.spike, foot, spikes);

      this.legRig.push({ s, hip, knee, foot });
    }

    // ---- hips -> torso -> head ----
    this.hips = new THREE.Group();
    this.hips.position.y = 0.86;
    this.stance.add(this.hips);
    this._weld(COL.trouser, this.hips, [
      { geo: new THREE.SphereGeometry(0.215, 28, 20), pos: [0, 0.045, 0], scale: [0.95, 0.92, 1.06] },
      { geo: new THREE.CylinderGeometry(0.205, 0.198, 0.14, 26), pos: [0, 0.13, 0], scale: [0.96, 1, 1.05] },
    ]);
    this._weld(COL.belt, this.hips, [
      { geo: new THREE.CylinderGeometry(0.208, 0.208, 0.055, 30), pos: [0, 0.185, 0], scale: [0.96, 1, 1.05] },
    ]);
    this._weld(COL.buckle, this.hips, [
      { geo: new THREE.BoxGeometry(0.055, 0.048, 0.020), pos: [-0.200, 0.185, 0] },
    ]);

    this.torso = new THREE.Group();
    this.torso.position.y = 0.16;
    this.hips.add(this.torso);

    // The chest stays its own mesh — update() breathes with its scale. A
    // tapered capsule rather than a sphere: the V from shoulder down to waist
    // is most of what makes a figure read as athletic instead of as a snowman.
    this.chest = this._mesh(new THREE.CapsuleGeometry(0.205, 0.20, 12, 28), COL.polo, this.torso, [0, 0.14, 0]);
    this.chest.scale.set(0.94, 1.0, 1.14);

    this._weld(COL.polo, this.torso, [
      { geo: new THREE.SphereGeometry(0.115, 22, 16), pos: [0, 0.255, 0.185], scale: [1.0, 0.95, 1.05] },
      { geo: new THREE.SphereGeometry(0.115, 22, 16), pos: [0, 0.255, -0.185], scale: [1.0, 0.95, 1.05] },
      { geo: new THREE.CylinderGeometry(0.098, 0.104, 0.16, 22), pos: [0, 0.175, 0.215], rot: [0.16, 0, 0] },
      { geo: new THREE.CylinderGeometry(0.098, 0.104, 0.16, 22), pos: [0, 0.175, -0.215], rot: [-0.16, 0, 0] },
    ]);
    // Placket and sleeve trim — the only saturated colour on the figure, so it
    // is where the eye lands.
    this._weld(COL.poloTrim, this.torso, [
      { geo: new THREE.BoxGeometry(0.040, 0.19, 0.055), pos: [-0.196, 0.20, 0], rot: [0, 0, -0.05] },
      { geo: new THREE.TorusGeometry(0.100, 0.014, 10, 24), pos: [0, 0.098, 0.228], rot: [Math.PI / 2 + 0.16, 0, 0] },
      { geo: new THREE.TorusGeometry(0.100, 0.014, 10, 24), pos: [0, 0.098, -0.228], rot: [Math.PI / 2 - 0.16, 0, 0] },
    ]);
    this._weld(COL.collar, this.torso, [
      { geo: new THREE.TorusGeometry(0.108, 0.038, 14, 32), pos: [0, 0.325, 0], rot: [Math.PI / 2, 0, 0], scale: [1, 1.06, 1] },
    ]);

    this.head = new THREE.Group();
    this.head.position.y = 0.42;
    this.torso.add(this.head);

    // Skull, jaw, ears, neck. Smaller against the body than before and longer
    // than it is wide, which is the other half of leaving mascot proportions.
    this._weld(COL.skin, this.head, [
      { geo: new THREE.SphereGeometry(0.148, 32, 24), pos: [0, 0.115, 0], scale: [1.0, 1.10, 0.96] },
      { geo: new THREE.SphereGeometry(0.118, 24, 18), pos: [-0.028, 0.045, 0], scale: [1.02, 0.92, 0.90] },
      { geo: new THREE.SphereGeometry(0.048, 14, 11), pos: [-0.088, 0.012, 0], scale: [0.95, 0.80, 0.85] },
      { geo: new THREE.SphereGeometry(0.036, 14, 10), pos: [0.020, 0.108, 0.140], scale: [0.70, 1.20, 0.55] },
      { geo: new THREE.SphereGeometry(0.036, 14, 10), pos: [0.020, 0.108, -0.140], scale: [0.70, 1.20, 0.55] },
      { geo: new THREE.CylinderGeometry(0.062, 0.076, 0.10, 20), pos: [0.005, -0.055, 0] },
      // Nose, proud of the jaw — which reaches about x = -0.15, so anything
      // shallower than that is simply inside the head and invisible.
      { geo: new THREE.SphereGeometry(0.030, 16, 12), pos: [-0.152, 0.078, 0], scale: [1.10, 0.90, 0.80] },
    ]);
    this._weld(COL.mouth, this.head, [
      { geo: new THREE.SphereGeometry(0.024, 14, 10), pos: [-0.138, 0.018, 0], scale: [0.55, 0.42, 1.25] },
    ]);
    this._weld(COL.hair, this.head, [
      { geo: new THREE.SphereGeometry(0.128, 22, 16), pos: [0.052, 0.128, 0], scale: [0.90, 0.92, 1.02] },
      { geo: new THREE.SphereGeometry(0.058, 16, 12), pos: [0.030, 0.058, 0.126], scale: [0.90, 0.85, 0.60] },
      { geo: new THREE.SphereGeometry(0.058, 16, 12), pos: [0.030, 0.058, -0.126], scale: [0.90, 0.85, 0.60] },
    ]);

    // Cap instead of a visor: rounded crown, curved peak, button on top.
    this._weld(COL.cap, this.head, [
      { geo: new THREE.SphereGeometry(0.156, 30, 20, 0, Math.PI * 2, 0, Math.PI * 0.56), pos: [0, 0.112, 0], scale: [1.0, 1.02, 0.99] },
      { geo: new THREE.SphereGeometry(0.020, 12, 10), pos: [0, 0.266, 0] },
      { geo: new THREE.TorusGeometry(0.150, 0.016, 10, 30), pos: [0, 0.106, 0], rot: [Math.PI / 2, 0, 0] },
    ]);
    this._weld(COL.capBrim, this.head, [
      { geo: new THREE.CylinderGeometry(0.150, 0.150, 0.026, 30, 1, false, Math.PI * 0.62, Math.PI * 0.76),
        pos: [-0.050, 0.096, 0], rot: [0, 0, 0.20], scale: [1.34, 1, 1.02] },
    ]);

    // Sunglasses: frame plus two lenses, sitting on the nose.
    this._weld(COL.shades, this.head, [
      { geo: new THREE.SphereGeometry(0.150, 26, 18), pos: [-0.022, 0.090, 0], scale: [0.99, 0.165, 1.02] },
      { geo: new THREE.BoxGeometry(0.14, 0.018, 0.014), pos: [0.038, 0.098, 0.132], rot: [0, -0.10, 0] },
      { geo: new THREE.BoxGeometry(0.14, 0.018, 0.014), pos: [0.038, 0.098, -0.132], rot: [0, 0.10, 0] },
    ]);
    this._weld(COL.lens, this.head, [
      { geo: new THREE.SphereGeometry(0.150, 22, 16), pos: [-0.030, 0.092, 0.052], scale: [0.97, 0.108, 0.40] },
      { geo: new THREE.SphereGeometry(0.150, 22, 16), pos: [-0.030, 0.092, -0.052], scale: [0.97, 0.108, 0.40] },
    ]);

    // ---- swing assembly: plane → arm → wrist → club ----
    this.swingPlane = new THREE.Group();
    this.swingPlane.position.copy(HANDS).sub(this.stance.position);
    this.swingPlane.rotation.z = PLANE_TILT;
    this.stance.add(this.swingPlane);

    this.swingArm = new THREE.Group();
    this.swingPlane.add(this.swingArm);

    // Arms: upper arm, elbow, forearm, converging from the shoulders onto the
    // grip. Slimmer than the old mitten pair, in keeping with a figure that is
    // now built like an adult.
    const armParts = [];
    for (const s of [-1, 1]) {
      armParts.push(
        { geo: new THREE.CapsuleGeometry(0.070, 0.14, 10, 22), pos: [0, -0.105, s * 0.140], rot: [-s * 0.26, 0, 0] },
        { geo: new THREE.SphereGeometry(0.066, 16, 12), pos: [0, -0.225, s * 0.105] },
        { geo: new THREE.CapsuleGeometry(0.058, 0.15, 10, 22), pos: [0, -0.330, s * 0.062], rot: [-s * 0.28, 0, 0] },
      );
    }
    this._weld(COL.skin, this.swingArm, armParts);
    // Both hands on the grip, a glove on the lead one and a thumb apiece. The
    // hands are the closest part of the figure to the camera at address, so
    // they are worth the geometry.
    this._weld(COL.glove, this.swingArm, [
      { geo: new THREE.SphereGeometry(0.076, 20, 14), pos: [0, -0.425, 0.036], scale: [0.95, 1.20, 0.86] },
      { geo: new THREE.CapsuleGeometry(0.023, 0.046, 8, 12), pos: [-0.046, -0.408, 0.044], rot: [0, 0, 0.52] },
    ]);
    this._weld(COL.skin, this.swingArm, [
      { geo: new THREE.SphereGeometry(0.073, 20, 14), pos: [0, -0.466, -0.030], scale: [0.95, 1.14, 0.86] },
      { geo: new THREE.CapsuleGeometry(0.022, 0.042, 8, 12), pos: [-0.044, -0.452, -0.026], rot: [0, 0, 0.52] },
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

  /**
   * Hand the club over to the player for the way down.
   *
   * There is no timed downswing any more. `driveTo()` puts the club where the
   * thumb says it is, and impact happens when the club arrives at the ball
   * rather than when a clock runs out — so the power of the shot is the speed
   * the player actually generated, and a swing that stalls halfway is a swing
   * that stalls halfway.
   */
  beginDrive() {
    if (this.state !== 'back') return false;
    this.thetaTop = this.theta;
    this.hingeTop = this.hinge;
    this.driveGoal = 0;
    this.driveAuto = 0;
    this._peakVel = 0;
    this.state = 'drive';
    return true;
  }

  /** 0 at the top of the backswing, 1 with the club at the ball. */
  driveTo(p) {
    if (this.state === 'drive' && !this.driveAuto) this.driveGoal = clamp(p, 0, 1);
  }

  /**
   * Finish the swing without the player: thumb lifted, or a keyboard swing,
   * which has no downswing gesture to give. `vel` is in radians per second.
   */
  coastDrive(vel) {
    if (this.state !== 'drive') return;
    this.driveAuto = Math.max(4.5, vel || 0);
  }

  cancel() {
    if (this.state !== 'back' && this.state !== 'drive') return;
    this.state = 'return';
    this.timer = 0;
    this._returnFrom = this.theta;
    this._hingeFrom = this.hinge;
    this.charge = 0;
  }

  get isSwinging() {
    return this.state === 'drive' || this.state === 'down'
        || this.state === 'through' || this.state === 'hold';
  }
  get isBusy() { return this.state !== 'idle'; }

  /** Snap straight back to address — used when walking up to the next lie. */
  forceIdle() {
    this.state = 'idle';
    this.theta = ADDRESS; this.thetaGoal = ADDRESS;
    this.hinge = 0; this.hingeGoal = 0;
    this.charge = 0; this.timer = 0;
    this._thetaVel = 0; this.hingeTop = 0; this._impactVel = 0;
    this.driveGoal = 0; this.driveAuto = 0; this._peakVel = 0;
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
      // lerp(0.5, 0, 1 - s), which this was, evaluates to 0.5 at s = 1 — so the
      // pop finished by leaving the golfer parked a third of a yard in the air,
      // permanently. It wants to *start* high and settle to nothing.
      this.scaler.position.y = lerp(0.5, 0, s) * 0.6;
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

      case 'drive': {
        const was = this.theta;
        if (this.driveAuto) {
          this.theta += this.driveAuto * dt;
          this.driveGoal = clamp((this.theta - this.thetaTop) / (0.12 - this.thetaTop), 0, 1);
        } else {
          // The goal runs well *past* the ball, not just barely past it.
          //
          // Damping is asymptotic, so aiming at the ball meant the club spent
          // its last few frames decelerating onto it — arriving at a crawl no
          // matter how fast the thumb had moved, which made every shot come
          // out at the minimum. Aiming a radian beyond means the ball is struck
          // around three quarters of the way through the thumb's travel, with
          // the club still accelerating, and the rest of the gesture is
          // follow-through. Which is how swinging at something works.
          const goal = lerp(this.thetaTop, 1.10, this.driveGoal);
          this.theta = damp(this.theta, goal, 22, dt);
        }
        if (dt > 1e-4) this._thetaVel = (this.theta - was) / dt;
        this._peakVel = Math.max(this._peakVel, Math.abs(this._thetaVel));

        // Wrist holds its cock through the first third of the way down and
        // releases into the ball — same shape as before, but on the player's
        // clock rather than a fixed one.
        const rel = clamp((this.driveGoal - 0.30) / 0.62, 0, 1);
        this.hinge = lerp(this.hingeTop, 0, easeInOutSine(rel));

        if (this.theta >= 0) {
          // Impact. Club speed is the shot — nothing else feeds into it, which
          // is what makes the gesture worth performing rather than merely
          // completing. The fastest the club got is a fairer reading of the
          // swing than whatever one frame happened to catch at the crossing.
          const speed = Math.max(Math.abs(this._thetaVel), this._peakVel * 0.88);
          // Calibrated against real gesture speeds: a brisk quarter-second
          // stroke is most of the club, a hurried one is all of it, and a
          // slow deliberate one still gets a usable half rather than nothing.
          this.power = clamp((speed - 3.0) / 22.0, 0.05, 1);
          this._impactVel = Math.max(speed, 5);
          this.state = 'through';
          this.timer = 0;
          if (this.onImpact) this.onImpact(this.power);
          this._poseThrough();
        }
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
