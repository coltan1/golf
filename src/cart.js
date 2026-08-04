/**
 * cart.js — the buggy you drive between shots.
 *
 * The ball used to arrive by teleport: it came to rest, the screen waited a
 * second and a half, and the golfer was suddenly standing over it. That is a
 * loading screen with no loading in it. Now the distance is yours to cover.
 *
 * THE PHYSICS IS ARCADE AND UNASHAMED. A cart has a position, a heading and a
 * scalar speed; steering turns the heading and the whole thing moves where its
 * nose points. There is no slip angle, no tyre model, no suspension. Three
 * things are simulated because they are the three the player can feel:
 *
 *   grip changes with the ground, so the fairway is quick and the rough is a
 *     slog and it is worth staying on the short grass;
 *   the hill you are on pulls you, so a slope is a real decision;
 *   and hitting something hurts, because that is the point of the other cart.
 *
 * Everything else — the lean into a turn, the squat under braking, the wheels
 * spinning up — is drawn rather than solved. It is cosmetic, so it belongs in
 * the render and not in the integrator.
 */

import * as THREE from 'three';
import { heightAt, gradientAt, surfaceAt, isOutOfBounds, waterLevelAt } from './course.js';
import { clamp, lerp } from './util.js';

// ---------------------------------------------------------------- handling
// Yards and seconds. A real cart does about 14 mph, which is 6.8 yards a
// second — quick enough that a two-hundred-yard walk is half a minute, slow
// enough that you can place it beside a ball without fighting it.
const TOP_SPEED = 13.5;
const REVERSE_SPEED = 5.0;
// Two and a half seconds to top speed, not one. Eleven yards a second squared
// is about a g, which is a sports car — it made the cart feel weightless, and
// weightless is most of what "not normal" means for a vehicle.
const ACCEL = 7.0;
const BRAKE = 14.0;
// And it coasts. At 0.9 a released throttle stopped it in about a second,
// which reads as an engine brake nobody asked for; a cart rolls.
const DRAG = 0.55;

// Turn rate falls away with speed. A cart that turns as hard at full pelt as
// it does at walking pace feels like it is on ice, and one that cannot turn
// when stopped cannot be parked.
//
// These were nearly twice as high and the cart span like a shopping trolley.
// The number that matters is the turning circle at speed — radius is speed
// over turn rate, so 13.5 over 0.72 is about nineteen yards, which is a wide
// sweeping arc rather than a pirouette.
const TURN_SLOW = 1.55;
const TURN_FAST = 0.72;

// Boost. A shade over half again, which is enough to feel and not so much
// that the cart becomes a different vehicle you have to relearn.
const BOOST_MUL = 1.55;
const BOOST_DRAIN = 0.55;      // full tank lasts a bit under two seconds
const BOOST_REFILL = 0.24;     // and takes four to come back

// Drift. Holding the button drops the grip and lets the direction of travel
// lag behind where the nose is pointing; letting go hooks them back together.
const DRIFT_GRIP = 0.30;       // how fast travel catches up to heading, drifting
const HOLD_GRIP = 26.0;        // and how fast it does when not — near instant
const DRIFT_TURN = 1.85;       // the tail comes round faster than the nose
const DRIFT_SCRUB = 0.62;      // sideways speed you lose per second

// How much of the top speed each surface allows.
const GRIP = {
  fairway: 1.0, green: 0.92, rough: 0.72, deep: 0.5, sand: 0.42, water: 0.28,
};

const WHEEL_R = 0.30;
const BODY = { len: 2.5, wide: 1.35 };
/** Two carts closer than this are touching. */
export const HIT_RADIUS = 1.55;

// ---------------------------------------------------------------- geometry
function box(w, h, d, x, y, z, mat, name, rot) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.rotateX(rot[0] || 0), g.rotateY(rot[1] || 0), g.rotateZ(rot[2] || 0);
  g.translate(x, y, z);
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  m.castShadow = true;
  return m;
}

/**
 * The cart, in about four hundred triangles.
 *
 * Built to be read at forty yards from behind, which is where it spends its
 * life: a canopy, a bench and four wheels. The canopy is the important part —
 * it is the only bit whose silhouette is unlike anything else on a golf
 * course, and it is what tells you at a glance which cart is which when
 * somebody is bearing down on you.
 */
export function buildCartMesh(bodyColour = 0xf2f4f6, ramp = null) {
  const root = new THREE.Group();
  root.name = 'cart';

  const toon = (c) => (ramp
    ? new THREE.MeshToonMaterial({ color: c, gradientMap: ramp })
    : new THREE.MeshLambertMaterial({ color: c }));

  const shell = toon(bodyColour);
  const dark = toon(0x2a2f34);
  const seat = toon(0x3c4650);
  const trim = toon(0xc8ced4);

  // The whole vehicle hangs off a group turned to face -Z.
  //
  // The game's heading of zero points down -Z — that is the direction of play
  // and every other thing in the world agrees about it — while a cart is far
  // easier to author nose-forward along +Z. Turning the assembly once here is
  // the alternative to negating a z in forty places and missing one.
  const face = new THREE.Group();
  face.name = 'facing';
  face.rotation.y = Math.PI;
  root.add(face);

  const hull = new THREE.Group();
  hull.name = 'hull';
  face.add(hull);

  // Floor pan and nose
  hull.add(box(BODY.wide, 0.22, BODY.len, 0, 0.44, 0, shell, 'pan'));
  hull.add(box(BODY.wide * 0.92, 0.30, 0.72, 0, 0.62, 0.92, shell, 'nose'));
  hull.add(box(BODY.wide * 0.86, 0.10, 0.44, 0, 0.80, 1.02, trim, 'dash'));

  // Bench: base, back and a headrest lip
  hull.add(box(BODY.wide * 0.94, 0.20, 0.70, 0, 0.68, -0.10, seat, 'seatBase'));
  hull.add(box(BODY.wide * 0.94, 0.62, 0.18, 0, 1.06, -0.44, seat, 'seatBack'));

  // Bag well behind the seat
  hull.add(box(BODY.wide * 0.80, 0.36, 0.46, 0, 0.72, -0.95, shell, 'well'));

  // Four posts and the canopy
  for (const sx of [-1, 1]) {
    for (const sz of [1, -1]) {
      hull.add(box(0.09, 1.10, 0.09,
        sx * BODY.wide * 0.42, 1.34, sz * 0.86, dark, 'post'));
    }
  }
  hull.add(box(BODY.wide * 1.06, 0.11, BODY.len * 0.86, 0, 1.94, -0.02, shell, 'canopy'));
  hull.add(box(BODY.wide * 1.06, 0.05, 0.16, 0, 1.90, 1.02, trim, 'canopyLip'));

  // Steering column and wheel
  hull.add(box(0.07, 0.46, 0.07, -0.34, 0.98, 0.74, dark, 'column', [0.5, 0, 0]));
  const w = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.035, 6, 14), dark);
  w.rotation.set(Math.PI * 0.42, 0, 0);
  w.position.set(-0.34, 1.16, 0.60);
  w.name = 'wheel';
  hull.add(w);

  // Wheels. Named so the renderer can spin and steer them.
  const wheels = [];
  const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.22, 10);
  tyre.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) {
    for (const sz of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * BODY.wide * 0.52, WHEEL_R, sz * 0.86);
      const m = new THREE.Mesh(tyre, dark);
      m.castShadow = true;
      pivot.add(m);
      pivot.userData.spinner = m;
      pivot.userData.steers = sz > 0;
      face.add(pivot);
      wheels.push(pivot);
    }
  }
  root.userData.wheels = wheels;
  root.userData.hull = hull;
  return root;
}

// ---------------------------------------------------------------- the cart
export class Cart {
  constructor(scene, { colour = 0xf2f4f6, ramp = null, ghost = false } = {}) {
    this.root = buildCartMesh(colour, ramp);
    this.root.visible = false;
    scene.add(this.root);

    this.pos = new THREE.Vector3();
    this.heading = 0;          // radians, 0 = -Z — where the nose points
    // Where the cart is actually travelling.
    //
    // Normally welded to the heading: a cart that slides a little all the
    // time reads as one that is permanently out of control, and the first
    // version of this looked exactly like that even though nothing was
    // sliding at all — a body roll on every turn was enough to suggest it.
    // The two only come apart while the drift button is down.
    this.travel = 0;
    this.speed = 0;            // yards a second, signed
    this.boost = 1;            // 0..1 fuel
    this.boosting = false;
    this.drifting = false;
    this.slip = 0;             // |heading - travel|, for the render and the dust
    this.steer = 0;            // -1..1, smoothed
    this.spin = 0;             // wheel rotation, for the render
    this.lean = 0;             // body roll, ditto
    this.pitch = 0;
    this.bump = new THREE.Vector3();   // impulse from a collision, decays
    this.ghost = ghost;        // an opponent's cart: driven by the wire
    this._t = 0;
  }

  get visible() { return this.root.visible; }
  set visible(v) { this.root.visible = v; }

  place(x, z, heading) {
    this.pos.set(x, heightAt(x, z), z);
    this.heading = heading ?? 0;
    this.travel = this.heading;
    this.slip = 0;
    this.speed = 0;
    this.bump.set(0, 0, 0);
    this._apply();
  }

  /** The point a passenger steps out at — beside the cart, on the left. */
  dropPoint(out = new THREE.Vector3()) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    // Right-hand perpendicular to the heading, negated: out of the left side.
    return out.set(this.pos.x + c * -1.5, 0, this.pos.z - s * -1.5);
  }

  /**
   * One step.
   *
   * `input` is { throttle: -1..1, steer: -1..1 }. Everything else the cart
   * works out for itself from where it is standing.
   */
  update(dt, input) {
    this._t += dt;
    if (this.ghost) { this._applyGhost(dt); return; }

    const th = clamp(input?.throttle ?? 0, -1, 1);
    const st = clamp(input?.steer ?? 0, -1, 1);
    // Steering is smoothed rather than applied raw: a key is either down or it
    // is not, and a cart that snaps to full lock on a keypress cannot be
    // driven in a straight line.
    this.steer = lerp(this.steer, st, 1 - Math.exp(-9 * dt));

    const ground = surfaceAt(this.pos.x, this.pos.z);
    const grip = GRIP[ground] ?? 0.8;

    // Boost: held, and only while there is anything in the tank. It refills
    // whenever it is not being used, so it is a thing you spend rather than a
    // thing you run out of for the rest of the hole.
    this.drifting = !!input?.drift && Math.abs(this.speed) > 2.0;
    this.boosting = !!input?.boost && this.boost > 0.02 && th > 0;
    this.boost = clamp(
      this.boost + (this.boosting ? -BOOST_DRAIN : BOOST_REFILL) * dt, 0, 1
    );
    const push = this.boosting ? BOOST_MUL : 1;
    const top = TOP_SPEED * grip * push;

    if (th > 0.01) this.speed += ACCEL * grip * push * th * dt;
    else if (th < -0.01) this.speed -= (this.speed > 0 ? BRAKE : ACCEL * 0.7) * -th * dt;
    else this.speed -= this.speed * DRAG * dt;

    // Gravity along the slope.
    //
    // This was the loudest wrong thing about the handling. A fairway rolls
    // through gradients of a tenth all over it, and at the old deadband of
    // 0.04 and a multiplier of nine that is nearly a yard a second squared of
    // free acceleration almost everywhere — the cart crept off on its own,
    // sped up and slowed down for no visible reason, and never held a steady
    // speed. A real cart on ordinary undulation does none of that.
    //
    // So: a deadband wide enough to ignore anything that is not a hill, a
    // third of the pull, and rolling resistance underneath it so what is left
    // settles at a slow roll instead of accelerating for ever.
    const g = gradientAt(this.pos.x, this.pos.z);
    const along = -(Math.sin(this.heading) * g.gx - Math.cos(this.heading) * g.gz);
    let pull = 0;
    if (Math.abs(along) > 0.11) {
      pull = (along - Math.sign(along) * 0.11) * 3.2;
      this.speed += pull * dt;
      this.speed -= this.speed * 0.5 * dt;      // rolling resistance
    }

    this.speed = clamp(this.speed, -REVERSE_SPEED * grip, top);
    // Snapped to a dead stop only when nothing is pushing it. Left
    // unconditional, this ate the slope entirely: gravity adds a few
    // thousandths of a yard a second per frame, which is below the threshold,
    // so every frame zeroed it again and the cart sat motionless on a
    // one-in-five hill.
    if (Math.abs(this.speed) < 0.04 && Math.abs(th) < 0.01 && Math.abs(pull) < 0.05) {
      this.speed = 0;
    }

    // Turn rate falls off with speed, and reverses when reversing, because a
    // cart backing up steers the other way and everyone expects it to.
    const f = Math.min(1, Math.abs(this.speed) / TOP_SPEED);
    const rate = lerp(TURN_SLOW, TURN_FAST, f) * (this.drifting ? DRIFT_TURN : 1);
    // Steering fades in from a crawl rather than from walking pace, so the
    // last yard of parking is still steerable.
    const moving = Math.min(1, Math.abs(this.speed) / 0.7);
    this.heading += this.steer * rate * dt * moving * Math.sign(this.speed || 1);

    // Travel chases heading. The rate is the whole drift model: fast enough
    // normally that the two are the same number, slow enough on the button
    // that the cart carries on the way it was going while the nose comes
    // round. Wrapped to the shortest way, or a cart that crosses due south
    // spins its travel direction the long way and briefly drives backwards.
    let d = ((this.heading - this.travel + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    this.travel += d * (1 - Math.exp(-(this.drifting ? DRIFT_GRIP * 12 : HOLD_GRIP) * dt));
    this.slip = Math.abs(d);
    // Sliding sideways scrubs speed off, which is what stops a drift being a
    // free way to go round corners faster than not drifting.
    if (this.drifting) this.speed -= Math.abs(this.speed) * this.slip * DRIFT_SCRUB * dt;

    const s = Math.sin(this.travel), c = Math.cos(this.travel);
    let nx = this.pos.x + (s * this.speed + this.bump.x) * dt;
    let nz = this.pos.z + (-c * this.speed + this.bump.z) * dt;
    this.bump.multiplyScalar(Math.exp(-3.4 * dt));

    // Water and the world edge are walls, not hazards. Losing the cart down a
    // cliff would need a recovery flow nobody asked for, and the honest fix is
    // simply not to let it happen.
    if (waterLevelAt(nx, nz) > -900 || isOutOfBounds(nx, nz)) {
      this.speed *= -0.32;
      this.bump.multiplyScalar(0.2);
      nx = this.pos.x; nz = this.pos.z;
    }

    this.pos.x = nx;
    this.pos.z = nz;
    this.pos.y = heightAt(nx, nz);

    // Cosmetics.
    this.spin += (this.speed / WHEEL_R) * dt * (this.drifting ? 1.5 : 1);
    // Barely any roll under normal cornering.
    //
    // It was 0.16 and that alone made the cart look permanently sideways —
    // the eye reads a leaning vehicle as one that is sliding, whether or not
    // it is. It is nearly flat now, and the big lean is reserved for an actual
    // drift, where it is telling the truth.
    const want = -this.steer * f * 0.045 - Math.sign(this.steer || 1) * this.slip * 0.42;
    this.lean = lerp(this.lean, clamp(want, -0.30, 0.30), 1 - Math.exp(-8 * dt));
    this.pitch = lerp(this.pitch, clamp(-along * 0.6, -0.22, 0.22), 1 - Math.exp(-5 * dt));
    this._apply();
  }

  /** A ghost cart is told where it is; it only has to get there smoothly. */
  _applyGhost(dt) {
    if (!this.target) { this._apply(); return; }
    const k = 1 - Math.exp(-7 * dt);
    this.pos.x = lerp(this.pos.x, this.target.x, k);
    this.pos.z = lerp(this.pos.z, this.target.z, k);
    this.pos.y = heightAt(this.pos.x, this.pos.z);
    // Shortest way round, or a cart that crosses due south spins the long way.
    let d = ((this.target.h - this.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    this.heading += d * k;
    // Their speed is carried on the wire and kept here, not just used to spin
    // the wheels. The collision reads it: without it a ghost is always
    // stationary as far as the maths is concerned, so standing still while
    // somebody drives into you at full pelt did nothing at all.
    this.speed = this.target.v ?? 0;
    this.travel = this.heading;
    this.spin += this.speed / WHEEL_R * dt;
    this._apply();
  }

  _apply() {
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.heading, 0);
    const hull = this.root.userData.hull;
    hull.rotation.set(this.pitch, 0, this.lean);
    for (const w of this.root.userData.wheels) {
      w.userData.spinner.rotation.x = this.spin;
      w.rotation.y = w.userData.steers ? this.steer * 0.45 : 0;
    }
  }

  /**
   * Ram another cart.
   *
   * Each client runs its own cart and applies the bump to *itself* — the two
   * sides never argue about who hit whom, because neither is allowed to move
   * the other one. They agree because they are solving the same collision from
   * opposite ends, and where they disagree slightly it is a ghost drifting a
   * yard, which nobody can see and nothing depends on.
   */
  collide(other) {
    if (!other || !other.root.visible) return 0;
    const dx = this.pos.x - other.pos.x;
    const dz = this.pos.z - other.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > HIT_RADIUS * 2 || d < 1e-4) return 0;

    const nx = dx / d, nz = dz / d;
    // Closing speed along the line between them. Only a real shunt counts, so
    // rolling gently alongside somebody does nothing.
    const mine = Math.sin(this.heading) * this.speed * nx + -Math.cos(this.heading) * this.speed * nz;
    const theirs = other.speed
      ? Math.sin(other.heading) * other.speed * nx + -Math.cos(other.heading) * other.speed * nz
      : 0;
    const closing = Math.max(0, theirs - mine);

    // Push apart first, so they cannot end up inside one another and stay
    // there trading impulses for ever.
    const overlap = HIT_RADIUS * 2 - d;
    this.pos.x += nx * overlap * 0.5;
    this.pos.z += nz * overlap * 0.5;

    const kick = 3.2 + closing * 1.15;
    this.bump.x += nx * kick;
    this.bump.z += nz * kick;
    this.speed *= 0.55;
    // A shove also turns you, which is what makes it worth doing to somebody.
    this.heading += (nx * Math.cos(this.heading) + nz * Math.sin(this.heading)) * 0.35;
    return closing;
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

// ---------------------------------------------------------------- controls
/**
 * Keyboard and thumb.
 *
 * Both feed one { throttle, steer } object because the cart should not know
 * or care which is driving it — and because on a laptop with a touchscreen
 * both are live at once, and a cart that listened to only the last one used
 * would stall every time a hand moved.
 */
export function createCartControls() {
  const keys = new Set();
  // Shift and space come off `e.key`, which is ' ' for the space bar and the
  // side-agnostic 'Shift' for either shift key. Reading `code` instead would
  // mean listing ShiftLeft and ShiftRight and getting it wrong on one layout.
  const DRIVE = ['w', 'a', 's', 'd',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift'];
  const onKey = (e, down) => {
    const k = e.key.toLowerCase();
    if (DRIVE.includes(k)) {
      if (down) keys.add(k); else keys.delete(k);
      // Space scrolls the page and shift does nothing, but only swallow them
      // while actually driving — the swing uses the space bar too.
      if (state.active) e.preventDefault();
    }
  };
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  // A key held while the window loses focus is a key that never comes up.
  window.addEventListener('blur', () => keys.clear());

  const state = {
    active: false,
    touch: { throttle: 0, steer: 0, boost: 0, drift: 0 },
  };
  const el = buildPad(state);
  const fuel = el.querySelector('#dFuel');
  const fuelIn = el.querySelector('#dFuelIn');

  return {
    setActive(on) {
      state.active = on;
      el.classList.toggle('on', on);
      if (!on) {
        keys.clear();
        state.touch.throttle = state.touch.steer = 0;
        state.touch.boost = state.touch.drift = 0;
      }
    },
    /** Show how much boost is left. Called by the frame loop with the cart. */
    setFuel(v) {
      fuelIn.style.transform = `scaleX(${Math.max(0, Math.min(1, v))})`;
      fuel.classList.toggle('low', v < 0.25);
    },
    read() {
      let throttle = 0, steer = 0;
      if (keys.has('w') || keys.has('arrowup')) throttle += 1;
      if (keys.has('s') || keys.has('arrowdown')) throttle -= 1;
      if (keys.has('a') || keys.has('arrowleft')) steer -= 1;
      if (keys.has('d') || keys.has('arrowright')) steer += 1;
      return {
        throttle: clamp(throttle + state.touch.throttle, -1, 1),
        steer: clamp(steer + state.touch.steer, -1, 1),
        boost: keys.has('shift') || state.touch.boost > 0,
        drift: keys.has(' ') || state.touch.drift > 0,
      };
    },
  };
}

function buildPad(state) {
  const style = document.createElement('style');
  style.textContent = `
    #drivePad{position:fixed;inset:0;z-index:20;pointer-events:none;
      opacity:0;transition:opacity .25s ease}
    #drivePad.on{opacity:1}
    #drivePad .dBtn{
      position:absolute;bottom:calc(env(safe-area-inset-bottom, 0px) + 26px);
      width:74px;height:74px;border-radius:18px;pointer-events:auto;
      display:grid;place-items:center;font-size:26px;font-weight:900;
      color:#fff;text-shadow:0 2px 0 rgba(0,0,0,.35);cursor:pointer;
      border:3px solid var(--ink);user-select:none;touch-action:none;
      background:linear-gradient(180deg,#fdf6e6,#c8a86e);
      box-shadow:0 5px 0 rgba(61,39,22,.6),inset 0 2px 0 rgba(255,255,255,.5);
    }
    #drivePad .dBtn.down{transform:translateY(4px);box-shadow:0 1px 0 rgba(61,39,22,.6)}
    /* Every one of these is scoped to the pad, and it has to be.
       The shared rule is "#drivePad .dBtn" — an id plus a class — which
       outranks a bare "#dGo", so the per-button sizes were being thrown away
       and every button came out the same 74 square in the same corner. */
    #drivePad #dLeft{left:22px} #drivePad #dRight{left:112px}
    #drivePad #dRev{right:112px;background:linear-gradient(180deg,#e3945f,#b34627)}
    #drivePad #dGo{right:22px;width:88px;height:88px;
      background:linear-gradient(180deg,#9ad966,#4f9330)}
    /* env() needs its fallback spelled out.
       Without the second argument the whole calc is invalid wherever the
       variable is unsupported, which takes the entire bottom declaration with
       it — and these then fell back to .dBtn's value and stacked on top of
       the steering buttons. */
    #drivePad #dDrift{left:22px;bottom:calc(env(safe-area-inset-bottom, 0px) + 114px);
      width:164px;height:52px;font-size:14px;letter-spacing:1px;
      background:linear-gradient(180deg,#7fd0ea,#2b86b4)}
    #drivePad #dBoost{right:22px;bottom:calc(env(safe-area-inset-bottom, 0px) + 124px);
      width:88px;height:56px;font-size:14px;letter-spacing:1px;
      background:linear-gradient(180deg,#ffd970,#cf7c0d)}
    /* The gauge sits on the boost button rather than anywhere else on screen,
       because it is the only thing it describes and a bar in a corner is one
       more place to have to look. */
    #drivePad #dFuel{
      position:absolute;right:22px;
      bottom:calc(env(safe-area-inset-bottom, 0px) + 188px);
      width:88px;height:11px;border-radius:6px;overflow:hidden;
      border:3px solid var(--ink);background:rgba(30,20,10,.55);
    }
    #drivePad #dFuelIn{height:100%;width:100%;transform-origin:left center;
      background:linear-gradient(180deg,#ffe08a,#f0961a);
      transition:opacity .2s}
    #drivePad #dFuel.low #dFuelIn{background:linear-gradient(180deg,#f0a0a0,#c0392b)}
  `;
  document.head.appendChild(style);

  const pad = document.createElement('div');
  pad.id = 'drivePad';
  pad.innerHTML = `
    <div class="dBtn" id="dLeft">◀</div>
    <div class="dBtn" id="dRight">▶</div>
    <div class="dBtn" id="dRev">▼</div>
    <div class="dBtn" id="dGo">▲</div>
    <div class="dBtn" id="dDrift">DRIFT</div>
    <div class="dBtn" id="dBoost">BOOST</div>
    <div id="dFuel"><div id="dFuelIn"></div></div>`;
  document.body.appendChild(pad);

  const hold = (id, set) => {
    const b = pad.querySelector('#' + id);
    const down = (e) => { e.preventDefault(); b.classList.add('down'); set(); };
    const up = () => { b.classList.remove('down'); set(0); };
    b.addEventListener('pointerdown', down);
    // Released on the button, off it, or when the pointer is taken away —
    // miss any of the three and the cart drives off on its own.
    b.addEventListener('pointerup', up);
    b.addEventListener('pointerleave', up);
    b.addEventListener('pointercancel', up);
  };
  hold('dGo', (v) => { state.touch.throttle = v === 0 ? 0 : 1; });
  hold('dRev', (v) => { state.touch.throttle = v === 0 ? 0 : -1; });
  hold('dLeft', (v) => { state.touch.steer = v === 0 ? 0 : -1; });
  hold('dRight', (v) => { state.touch.steer = v === 0 ? 0 : 1; });
  hold('dBoost', (v) => { state.touch.boost = v === 0 ? 0 : 1; });
  hold('dDrift', (v) => { state.touch.drift = v === 0 ? 0 : 1; });

  return pad;
}
