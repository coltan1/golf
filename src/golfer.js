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
// The shoulder pivot the arms and club swing about, and the one number the
// whole figure is built around: club length is measured from it to the ball.
//
// It dropped a long way with the toy proportions. This figure is under four
// heads tall and stands close to the ball, so the shoulders sit at 0.78 rather
// than 1.32 and the stance moved in to 0.62 — which keeps the swing plane at
// about the same angle off vertical as before, so the club still travels down
// the target line and does not sweep out sideways.
const HANDS = new THREE.Vector3(0.45, 0.78, 0);
const BALL = new THREE.Vector3(0, 0.045, 0);
const _d = BALL.clone().sub(HANDS);
const CLUB_LEN = _d.length();
const PLANE_TILT = Math.asin(_d.x / CLUB_LEN); // tilts the swing plane off vertical
// Shoulder to grip. Short arms on a short figure; the shaft takes the rest.
const ARM_LEN = 0.26;

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
 * What the golfer looks like.
 *
 * Every field here is meant to be changed at runtime. The model is built so
 * that each of these owns exactly one mesh per rig group — nothing is shared,
 * nothing is half a cluster — so recolouring is a lookup and a `.set()` rather
 * than a rebuild, and adding a new option means adding a field here and one
 * more `_region` call below.
 *
 * Deliberately simple. The previous figure had spikes, laces, belt loops, ear
 * lobes and a heel counter, all hand-placed: lovely to look at once, and
 * impossible for anyone to restyle without editing geometry. Fewer, larger
 * shapes recolour cleanly and read better at the distance the game is actually
 * played from.
 */
export const DEFAULT_LOOK = {
  skin: 0xdcb98f,
  shirt: 0x3f56bd,
  trim: 0xa8896a,
  trousers: 0xd7b78c,
  shoes: 0xa03a3a,
  cap: 0xcbad86,
  hair: 0x6f4a33,
  glove: 0xdcb98f,
  headwear: 'bucket',  // 'bucket' | 'cap' | 'visor' | 'none'
  hairStyle: 'none',   // 'short' | 'long' | 'none'
  shades: false,
};

/** Ready-made looks, so there is something to pick from before mixing your own. */
export const LOOK_PRESETS = {
  classic: {},
  masters: { shirt: 0xfbfbf9, trim: 0x1f7a4d, trousers: 0x2e3540, cap: 0x1f7a4d,
             headwear: 'cap', hairStyle: 'short' },
  sunday:  { shirt: 0xe8433f, trim: 0x22262c, trousers: 0x22262c, cap: 0x22262c,
             headwear: 'cap', hairStyle: 'short' },
  links:   { shirt: 0xf6e9c8, trim: 0x9d6b3e, trousers: 0xcdb98e, cap: 0xc9a86b },
  retro:   { shirt: 0xffd05c, trim: 0xf4744e, trousers: 0xfbfbf9, cap: 0xffd05c,
             headwear: 'visor', hairStyle: 'short' },
  cool:    { skin: 0x8d5a3b, shirt: 0x2f6fd0, trim: 0x1b3f7a, trousers: 0xfbfbf9,
             cap: 0x1b3f7a, shades: true },
  cap:     { headwear: 'cap', hairStyle: 'short' },
  bare:    { headwear: 'none', hairStyle: 'short' },
};

/** Colours that are not the player's business: the club, and the lens tint. */
const KIT = {
  shaft: 0x4a4a4c,
  clubHead: 0x3d3d40,
  grip: 0x2b2b2d,
  ferrule: 0x2b2b2d,
  face: 0x6e6e72,
  frame: 0x2b3a44,
  lens: 0x8fb6c4,
  eye: 0x2c2420,
  mouth: 0x2c2420,
  sock: 0xf6f5f0,
};

export class Golfer {
  constructor(toonRamp, look) {
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

    // Appearance lives in one plain object so it can be handed around, saved,
    // and changed at any time. _build reads it; setLook rewrites it.
    this.look = { ...DEFAULT_LOOK, ...(look || {}) };

    this._build();
    this.setLook({});
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

  /**
   * One mesh, welded from `parts`, tagged as belonging to a look region.
   *
   * The tag is the whole point: `setLook` walks the regions rather than the
   * scene graph, so a colour change is a handful of `Color.set` calls and never
   * has to know how the figure is put together.
   */
  _region(name, parent, parts, extra = {}) {
    const mesh = this._weld(this.look[name] ?? 0xffffff, parent, parts, extra);
    (this.regions[name] ??= []).push(mesh);
    return mesh;
  }

  /**
   * Restyle the golfer. Accepts any subset of DEFAULT_LOOK.
   *
   * Colours apply immediately. The three structural options — headwear, hair
   * and sunglasses — are built once and shown or hidden, because swapping a cap
   * for a visor by rebuilding would mean disposing geometry mid-swing.
   */
  setLook(partial = {}) {
    Object.assign(this.look, partial);
    for (const [name, meshes] of Object.entries(this.regions)) {
      const c = this.look[name];
      if (c === undefined) continue;
      for (const m of meshes) m.material.color.set(c);
    }
    for (const [style, group] of Object.entries(this.headwear)) {
      group.visible = this.look.headwear === style;
    }
    for (const [style, group] of Object.entries(this.hairPieces)) {
      group.visible = this.look.hairStyle === style;
    }
    if (this.shadesGroup) this.shadesGroup.visible = !!this.look.shades;
    return this.look;
  }

  /** Apply a named preset from LOOK_PRESETS, on top of the defaults. */
  setPreset(name) {
    const p = LOOK_PRESETS[name];
    if (!p) return null;
    return this.setLook({ ...DEFAULT_LOOK, ...p });
  }

  _build() {
    this.regions = {};
    this.headwear = {};
    this.hairPieces = {};

    // A wrapper we scale for the "pop in" when moving to the next lie.
    this.scaler = new THREE.Group();
    this.root.add(this.scaler);

    // Toy proportions: a big round head on a short, soft body, everything made
    // of capsules and spheres with no hard edge anywhere. Under four heads
    // tall, where the previous figure was nearly six.
    this.stance = new THREE.Group();
    this.stance.position.set(0.62, 0, 0.05);
    this.scaler.add(this.stance);

    // ---- legs ----
    this.legs = new THREE.Group();
    this.stance.add(this.legs);
    this.legRig = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(0, 0.46, side * 0.105);
      hip.rotation.x = side * 0.04;
      this.legs.add(hip);
      // Bare legs, so thigh and calf are skin and the shorts sit over the top.
      this._region('skin', hip, [
        { geo: new THREE.CapsuleGeometry(0.072, 0.09, 8, 16), pos: [0, -0.10, 0] },
      ]);

      const knee = new THREE.Group();
      knee.position.y = -0.20;
      hip.add(knee);
      this._region('skin', knee, [
        { geo: new THREE.CapsuleGeometry(0.066, 0.08, 8, 16), pos: [0, -0.08, 0] },
      ]);
      this._weld(KIT.sock, knee, [
        { geo: new THREE.CylinderGeometry(0.070, 0.068, 0.075, 16), pos: [0, -0.175, 0] },
        { geo: new THREE.SphereGeometry(0.070, 14, 10), pos: [0, -0.140, 0] },
      ]);

      const foot = new THREE.Group();
      foot.position.y = -0.215;
      knee.add(foot);
      this._region('shoes', foot, [
        { geo: new THREE.SphereGeometry(0.082, 18, 13), pos: [-0.030, 0.062, 0], scale: [1.55, 0.90, 1.05] },
      ]);

      this.legRig.push({ s: side, hip, knee, foot });
    }

    // ---- hips ----
    this.hips = new THREE.Group();
    this.hips.position.y = 0.46;
    this.stance.add(this.hips);
    this._region('trousers', this.hips, [
      { geo: new THREE.SphereGeometry(0.150, 22, 16), pos: [0, 0.030, 0], scale: [0.98, 0.92, 1.06] },
      { geo: new THREE.CylinderGeometry(0.146, 0.140, 0.10, 20), pos: [0, 0.095, 0], scale: [0.98, 1, 1.06] },
    ]);

    // ---- torso ----
    this.torso = new THREE.Group();
    this.torso.position.y = 0.10;
    this.hips.add(this.torso);

    // Chest keeps its own mesh — update() breathes with its scale.
    this.chest = this._mesh(new THREE.CapsuleGeometry(0.158, 0.155, 10, 22),
      this.look.shirt, this.torso, [0, 0.092, 0]);
    this.chest.scale.set(0.98, 1.0, 1.10);
    (this.regions.shirt ??= []).push(this.chest);

    // Round shoulder caps and stubby sleeves, all one soft shape.
    this._region('shirt', this.torso, [
      { geo: new THREE.SphereGeometry(0.088, 16, 12), pos: [0, 0.180, 0.135] },
      { geo: new THREE.SphereGeometry(0.088, 16, 12), pos: [0, 0.180, -0.135] },
      { geo: new THREE.CapsuleGeometry(0.076, 0.05, 8, 16), pos: [0, 0.130, 0.152], rot: [0.14, 0, 0] },
      { geo: new THREE.CapsuleGeometry(0.076, 0.05, 8, 16), pos: [0, 0.130, -0.152], rot: [-0.14, 0, 0] },
    ]);

    // ---- head ----
    this.head = new THREE.Group();
    this.head.position.y = 0.30;
    this.torso.add(this.head);

    this._region('skin', this.head, [
      { geo: new THREE.SphereGeometry(0.205, 30, 22), pos: [0, 0.150, 0], scale: [1.0, 1.02, 0.98] },
      // neck
      { geo: new THREE.CylinderGeometry(0.062, 0.075, 0.09, 16), pos: [0, -0.020, 0] },
      // small round nose, proud of a skull that reaches x = -0.205
      { geo: new THREE.SphereGeometry(0.030, 14, 11), pos: [-0.196, 0.142, 0] },
    ]);
    // Face: two dark ovals and a small mouth, sitting on the surface. No
    // rigging, no expression — the reference gets all of its character from
    // how simple this is, and anything more starts to fight it.
    this._weld(KIT.eye, this.head, [
      { geo: new THREE.SphereGeometry(0.034, 14, 11), pos: [-0.190, 0.190, 0.072], scale: [0.55, 1.10, 0.85] },
      { geo: new THREE.SphereGeometry(0.034, 14, 11), pos: [-0.190, 0.190, -0.072], scale: [0.55, 1.10, 0.85] },
    ]);
    this._weld(KIT.mouth, this.head, [
      { geo: new THREE.SphereGeometry(0.030, 14, 10), pos: [-0.192, 0.088, 0], scale: [0.42, 0.40, 1.25] },
    ]);

    // Hair, hidden by default — the bucket hat covers it.
    this.hairPieces.short = new THREE.Group();
    this.head.add(this.hairPieces.short);
    this._region('hair', this.hairPieces.short, [
      { geo: new THREE.SphereGeometry(0.190, 18, 13), pos: [0.030, 0.168, 0], scale: [0.94, 0.94, 1.02] },
    ]);
    this.hairPieces.long = new THREE.Group();
    this.head.add(this.hairPieces.long);
    this._region('hair', this.hairPieces.long, [
      { geo: new THREE.SphereGeometry(0.200, 18, 13), pos: [0.028, 0.160, 0], scale: [0.96, 1.0, 1.05] },
      { geo: new THREE.CylinderGeometry(0.150, 0.115, 0.24, 16), pos: [0.075, 0.010, 0], scale: [0.8, 1, 1.1] },
    ]);
    this.hairPieces.none = new THREE.Group();
    this.head.add(this.hairPieces.none);

    // ---- headwear ----
    // The bucket hat is the whole silhouette of this design: a wide soft brim
    // and a rounded crown, with a band where the two meet.
    this.headwear.bucket = new THREE.Group();
    this.head.add(this.headwear.bucket);
    this._region('cap', this.headwear.bucket, [
      { geo: new THREE.CylinderGeometry(0.315, 0.300, 0.036, 30), pos: [0, 0.268, 0] },
      { geo: new THREE.TorusGeometry(0.305, 0.028, 10, 30), pos: [0, 0.262, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: new THREE.SphereGeometry(0.202, 26, 18, 0, Math.PI * 2, 0, Math.PI * 0.60),
        pos: [0, 0.256, 0], scale: [1.0, 0.98, 1.0] },
      { geo: new THREE.CylinderGeometry(0.202, 0.212, 0.09, 26), pos: [0, 0.292, 0] },
    ]);
    this._region('trim', this.headwear.bucket, [
      { geo: new THREE.CylinderGeometry(0.216, 0.216, 0.048, 28), pos: [0, 0.300, 0] },
    ]);

    this.headwear.cap = new THREE.Group();
    this.head.add(this.headwear.cap);
    this._region('cap', this.headwear.cap, [
      { geo: new THREE.SphereGeometry(0.212, 22, 15, 0, Math.PI * 2, 0, Math.PI * 0.56), pos: [0, 0.145, 0] },
      { geo: new THREE.CylinderGeometry(0.205, 0.205, 0.030, 24, 1, false, Math.PI * 0.62, Math.PI * 0.76),
        pos: [-0.068, 0.132, 0], rot: [0, 0, 0.20], scale: [1.34, 1, 1.02] },
    ]);

    this.headwear.visor = new THREE.Group();
    this.head.add(this.headwear.visor);
    this._region('cap', this.headwear.visor, [
      { geo: new THREE.CylinderGeometry(0.210, 0.206, 0.085, 24, 1, true), pos: [0, 0.200, 0] },
      { geo: new THREE.CylinderGeometry(0.205, 0.205, 0.030, 24, 1, false, Math.PI * 0.62, Math.PI * 0.76),
        pos: [-0.068, 0.166, 0], rot: [0, 0, 0.20], scale: [1.34, 1, 1.02] },
    ], { side: THREE.DoubleSide });

    this.headwear.none = new THREE.Group();
    this.head.add(this.headwear.none);

    // Sunglasses, off by default here but kept for anyone who wants them.
    this.shadesGroup = new THREE.Group();
    this.head.add(this.shadesGroup);
    this._weld(KIT.frame, this.shadesGroup, [
      { geo: new THREE.SphereGeometry(0.206, 20, 14), pos: [-0.014, 0.186, 0], scale: [0.99, 0.145, 1.02] },
    ]);
    this._weld(KIT.lens, this.shadesGroup, [
      { geo: new THREE.SphereGeometry(0.206, 16, 12), pos: [-0.022, 0.188, 0.070], scale: [0.97, 0.098, 0.40] },
      { geo: new THREE.SphereGeometry(0.206, 16, 12), pos: [-0.022, 0.188, -0.070], scale: [0.97, 0.098, 0.40] },
    ]);

    // ---- swing assembly: plane -> arm -> wrist -> club ----
    this.swingPlane = new THREE.Group();
    this.swingPlane.position.copy(HANDS).sub(this.stance.position);
    this.swingPlane.rotation.z = PLANE_TILT;
    this.stance.add(this.swingPlane);

    this.swingArm = new THREE.Group();
    this.swingPlane.add(this.swingArm);

    // Soft tapered arms converging on the grip — no elbow, in keeping with a
    // figure that has no hard edges anywhere else either.
    this._region('skin', this.swingArm, [
      { geo: new THREE.CapsuleGeometry(0.058, 0.16, 8, 16), pos: [0, -0.115, 0.072], rot: [-0.30, 0, 0] },
      { geo: new THREE.CapsuleGeometry(0.058, 0.16, 8, 16), pos: [0, -0.115, -0.072], rot: [0.30, 0, 0] },
    ]);
    this._region('glove', this.swingArm, [
      { geo: new THREE.SphereGeometry(0.068, 16, 12), pos: [0, -0.238, 0], scale: [0.95, 1.20, 0.92] },
    ]);

    this.wrist = new THREE.Group();
    this.wrist.position.y = -ARM_LEN;
    this.swingArm.add(this.wrist);

    // The wrist hinge lives between the hands and the shaft — this is the
    // detail that makes the swing look like a swing and not a windmill.
    const shaftLen = CLUB_LEN - ARM_LEN;
    this._mesh(new THREE.CylinderGeometry(0.034, 0.042, shaftLen, 16), KIT.shaft, this.wrist,
      [0, -shaftLen / 2, 0]);
    this._mesh(new THREE.CylinderGeometry(0.045, 0.042, 0.30, 16), KIT.grip, this.wrist, [0, -0.10, 0]);

    // Ferrule and hosel, then the head. Three small pieces, but a club that
    // just ends in a blob is the first thing that reads as untooled.
    this._mesh(new THREE.CylinderGeometry(0.040, 0.046, 0.075, 16), KIT.ferrule, this.wrist,
      [0, -shaftLen + 0.09, 0]);
    const hosel = this._mesh(new THREE.CylinderGeometry(0.036, 0.040, 0.13, 16), KIT.clubHead, this.wrist,
      [-0.005, -shaftLen + 0.04, 0.005]);
    hosel.rotation.z = 0.10;

    const head = this._mesh(new THREE.SphereGeometry(0.13, 28, 20), KIT.clubHead, this.wrist,
      [-0.02, -shaftLen + 0.02, 0.05]);
    head.scale.set(0.9, 0.72, 1.5);
    this.clubHead = head;
    // Flat striking face, slightly proud so it catches the light separately.
    const face = this._mesh(new THREE.BoxGeometry(0.017, 0.155, 0.30), KIT.face, this.wrist,
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
      // Near enough proportional. This ran through easeOutCubic, which puts
      // 87% of the backswing into the first half of the pull — so every shot
      // was very nearly a full swing whether you meant it or not, and there was
      // no way to take it back short and hit it short. Taking it back is how a
      // golfer chooses distance; the curve was quietly removing that choice.
      this.thetaGoal = lerp(ADDRESS, BACK_MAX, Math.pow(this.charge, 0.9));
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
    this._prevGoal = 0;
    this._goalRate = 0;
    this._peakGoalRate = 0;
    this.state = 'drive';
    return true;
  }

  /** Angular speed the player has generated, in radians per second. */
  _clubSpeed() {
    if (this.driveAuto) return this.driveAuto;
    return this._peakGoalRate * (1.10 - this.thetaTop);
  }

  /**
   * The shot this swing would produce if the ball were struck right now.
   *
   * Two ingredients, deliberately. How far you took it back is worth most of
   * the shot on its own, so a full backswing at any sane tempo is always a
   * decent strike — that is the difference between a game that rewards a good
   * swing and one that punishes an imperfect one. Speed supplies the rest, and
   * is what separates a good strike from a great one.
   *
   * Read live by the power meter, so the bar shows the shot rather than some
   * internal quantity that happens to correlate with it.
   */
  get livePower() {
    if (this.state !== 'drive') return this.power;
    const backFrac = clamp((this.thetaTop - ADDRESS) / (BACK_MAX - ADDRESS), 0, 1);
    const speedFrac = clamp((this._clubSpeed() - 2.5) / 11.0, 0, 1);
    // Weighted toward the backswing, and the speed term reaches full at a pace
    // an ordinary thumb can actually produce. Tuned by driving real pointer
    // events through the real input path rather than by calling the golfer
    // directly — event sampling is coarser and slower than a synthetic loop,
    // and calibrating against the clean version made every real swing weak.
    return clamp(0.55 * backFrac + 0.45 * speedFrac, 0.05, 1);
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
    this._prevGoal = 0; this._goalRate = 0; this._peakGoalRate = 0;
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

        // Read the *thumb*, not the club.
        //
        // The club is damped toward the thumb, and damping closes a fixed
        // fraction of whatever gap it is given each frame — so the first frame
        // of any downswing, however lazy, snaps a big chunk of a two-and-a-half
        // radian gap and clocks a huge instantaneous speed. Taking the club's
        // peak therefore measured the damping's eagerness rather than the
        // player's, which is why gentle swings still launched it and why the
        // result felt disconnected from what you did.
        //
        // How fast the *goal* advances is the honest measure: it is the thumb's
        // speed, mapped through the arc the backswing set up.
        if (dt > 1e-4 && !this.driveAuto) {
          const rate = (this.driveGoal - (this._prevGoal ?? 0)) / dt;
          // Light smoothing: pointer events arrive unevenly, and a single
          // coarse frame should not decide the shot.
          this._goalRate += (rate - this._goalRate) * clamp(dt * 14, 0, 1);
          this._peakGoalRate = Math.max(this._peakGoalRate, this._goalRate);
        }
        this._prevGoal = this.driveGoal;

        // Wrist holds its cock through the first third of the way down and
        // releases into the ball — same shape as before, but on the player's
        // clock rather than a fixed one.
        const rel = clamp((this.driveGoal - 0.30) / 0.62, 0, 1);
        this.hinge = lerp(this.hingeTop, 0, easeInOutSine(rel));

        if (this.theta >= 0) {
          // Impact.
          //
          // Two ingredients, deliberately. How far you took it back is worth
          // most of the shot on its own, so a full backswing at any sane tempo
          // is always a decent strike — that is the difference between a game
          // that rewards a good swing and one that punishes an imperfect one.
          // Speed supplies the rest, and is what separates a good strike from
          // a great one.
          this.power = this.livePower;
          const speed = Math.max(this._clubSpeed(), 5);
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
