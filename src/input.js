/**
 * input.js — the swipe swing.
 *
 * One pointer does everything, disambiguated by the dominant axis of the
 * first few pixels of movement:
 *
 *   mostly horizontal  →  AIM     (drag to swing the target line around)
 *   mostly vertical    →  CHARGE  (pull down/back to load the backswing)
 *                     →  DRIVE    (push back up: the club follows your thumb
 *                                  down through the ball, in real time)
 *
 * The downswing is not an animation that plays when you let go. Once the
 * gesture reverses, the club's position *is* your thumb's position, mapped
 * from the top of the backswing to the ball — so how hard the shot goes is
 * how fast you actually move, and stopping halfway stops the club halfway.
 * Lifting mid-downswing lets it finish at the speed it was already going.
 *
 * Lifting without ever starting forward simply cancels — no punishing mis-hit.
 */

import { clamp } from './util.js';

const DRIVE_START = 9;     // px of forward travel before the downswing takes over
const AXIS_LOCK = 11;      // px of movement before we commit to aim vs charge

export class SwipeSwing {
  constructor(el) {
    this.el = el;
    this.enabled = false;

    this.mode = 'none'; // none | pending | aim | charge | drive
    this.power = 0;
    this.samples = [];

    // Callbacks — wired up in main.js
    this.onStart = null;
    this.onAim = null;
    this.onChargeBegin = null;
    this.onCharge = null;
    this.onDriveBegin = null;
    this.onDrive = null;
    this.onDriveEnd = null;
    this.onCancel = null;

    this._down = this._down.bind(this);
    this._move = this._move.bind(this);
    this._up = this._up.bind(this);

    el.addEventListener('pointerdown', this._down, { passive: false });
    window.addEventListener('pointermove', this._move, { passive: false });
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);

    // Keyboard fallback: hold Space to charge, release to swing; ←/→ to aim.
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      if (this.keys[e.code]) return;
      this.keys[e.code] = true;
      if (e.code === 'Space' && this.enabled && this.mode === 'none') {
        this.mode = 'key';
        this.power = 0;
        this.onChargeBegin?.();
      }
      if (this.onStart) this.onStart();
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'Space' && this.mode === 'key') {
        this.mode = 'none';
        // A keyboard has no downswing to give, so it gets one: hand straight
        // over to the coast, at a speed the charge earned.
        if (this.power > 0.06) {
          this.onDriveBegin?.();
          this.onDriveEnd?.({ auto: this.power, lateral: 0 });
        } else this.onCancel?.();
        this.power = 0;
      }
    });
  }

  get chargePixels() {
    return clamp(window.innerHeight * 0.30, 150, 300);
  }

  // ------------------------------------------------------------- velocity
  _track(x, y) {
    const now = performance.now();
    this.samples.push({ x, y, t: now });
    while (this.samples.length > 2 && now - this.samples[0].t > 110) this.samples.shift();
  }

  _velocity() {
    if (this.samples.length < 2) return { vx: 0, vy: 0 };
    const a = this.samples[0], b = this.samples[this.samples.length - 1];
    const dt = Math.max(1, b.t - a.t) / 1000;
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  // ------------------------------------------------------------- pointer
  _down(e) {
    if (this.onStart) this.onStart();
    if (!this.enabled) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.mode = 'pending';
    this.startX = this.anchorX = e.clientX;
    this.startY = this.anchorY = e.clientY;
    this.peakDy = 0;
    this.peakX = e.clientX;
    this.peakVel = 0;
    this.power = 0;
    this.samples.length = 0;
    this._track(e.clientX, e.clientY);
  }

  _move(e) {
    if (this.mode === 'none' || this.mode === 'key') return;
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this._track(e.clientX, e.clientY);

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;

    // --- decide what this gesture is ---
    if (this.mode === 'pending') {
      if (Math.abs(dx) > AXIS_LOCK && Math.abs(dx) > Math.abs(dy) * 1.15) {
        this.mode = 'aim';
        this.lastAimX = e.clientX;
      } else if (Math.abs(dy) > AXIS_LOCK) {
        this.mode = 'charge';
        // Re-anchor so the club starts moving from exactly here — no jump.
        this.anchorY = e.clientY;
        this.anchorX = e.clientX;
        this.onChargeBegin?.();
      }
      return;
    }

    // --- aiming ---
    if (this.mode === 'aim') {
      const d = e.clientX - this.lastAimX;
      this.lastAimX = e.clientX;
      this.onAim?.(-d * 0.0026);
      return;
    }

    const pull = e.clientY - this.anchorY; // down-screen is positive = pulling back
    const forward = this.peakDy - pull;

    // --- driving the club down ---
    if (this.mode === 'drive') {
      this._drive(e.clientX, forward);
      return;
    }

    // --- charging the backswing ---
    const { vy } = this._velocity();
    if (pull > this.peakDy) {
      this.peakDy = pull;
      this.peakX = e.clientX;
      this.peakVel = Math.max(this.peakVel, vy);
    }
    this.power = clamp(Math.max(0, pull) / this.chargePixels, 0, 1);
    this.onCharge?.(this.power);

    // --- the gesture reverses: the club is yours from here ---
    if (this.power > 0.05 && forward > DRIVE_START) {
      this.mode = 'drive';
      // How much thumb travel maps to the whole downswing. Tied to how far
      // they actually pulled back, so a short backswing is a short stroke and
      // a full one is a full stroke — the arc you drew going back is the arc
      // you retrace coming down.
      this.driveSpan = Math.max(70, this.peakDy * 0.92);
      this.onDriveBegin?.();
      this._drive(e.clientX, forward);
    }
  }

  _up(e) {
    if (this.mode === 'none' || this.mode === 'key') return;
    if (e.pointerId !== undefined && e.pointerId !== this.pointerId) return;

    if (this.mode === 'drive') {
      // Thumb gone mid-swing. Let the club finish at the speed it had rather
      // than freezing it halfway down, which would be unreadable as anything
      // but a bug.
      this.mode = 'none';
      this.onDriveEnd?.({ lateral: this._lateral(e.clientX ?? this.peakX) });
      this.power = 0;
    } else if (this.mode === 'charge') {
      this.mode = 'none';
      this.onCancel?.();
      this.power = 0;
    } else {
      this.mode = 'none';
    }
  }

  _lateral(x) {
    // Where the thumb tracks relative to the top of the backswing shapes the
    // shot: come down inside the line to draw it, outside to fade it.
    return clamp((x - this.peakX) / (window.innerWidth * 0.22), -1, 1);
  }

  _drive(x, forward) {
    const progress = clamp(forward / this.driveSpan, 0, 1);
    this.onDrive?.({ progress, lateral: this._lateral(x) });
  }

  // ------------------------------------------------------------- per frame
  update(dt) {
    // Keyboard charge ramp + aim nudge.
    if (this.mode === 'key') {
      this.power = clamp(this.power + dt / 0.95, 0, 1);
      this.onCharge?.(this.power);
    }
    if (!this.enabled) return;
    let turn = 0;
    if (this.keys.ArrowLeft || this.keys.KeyA) turn += 1;
    if (this.keys.ArrowRight || this.keys.KeyD) turn -= 1;
    if (turn) this.onAim?.(turn * dt * 0.45);
  }

  reset() { this.mode = 'none'; this.power = 0; }
}
