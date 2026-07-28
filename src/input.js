/**
 * input.js — the swipe swing.
 *
 * One pointer does everything, disambiguated by the dominant axis of the
 * first few pixels of movement:
 *
 *   mostly horizontal  →  AIM     (drag to swing the target line around)
 *   mostly vertical    →  CHARGE  (pull down/back to load the backswing,
 *                                  then flick up/forward to release)
 *
 * Power comes from how far you pull *and* how fast, so a lazy pull and a
 * confident one feel different in the hand. Lifting your finger without a
 * forward flick simply cancels — no punishing mis-hits.
 */

import { clamp } from './util.js';

const RELEASE_DIST = 34;   // px of forward travel before a release can fire
const RELEASE_VEL = 780;   // px/s of forward speed required
const AXIS_LOCK = 11;      // px of movement before we commit to aim vs charge

export class SwipeSwing {
  constructor(el) {
    this.el = el;
    this.enabled = false;

    this.mode = 'none'; // none | pending | aim | charge
    this.power = 0;
    this.samples = [];

    // Callbacks — wired up in main.js
    this.onStart = null;
    this.onAim = null;
    this.onChargeBegin = null;
    this.onCharge = null;
    this.onRelease = null;
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
        if (this.power > 0.06) this.onRelease?.({ power: this.power, lateral: 0, tempo: 0.55 });
        else this.onCancel?.();
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

    // --- charging the backswing ---
    const pull = e.clientY - this.anchorY; // down-screen is positive = pulling back
    const { vy } = this._velocity();
    if (pull > this.peakDy) {
      this.peakDy = pull;
      this.peakX = e.clientX;
      this.peakVel = Math.max(this.peakVel, vy);
    }

    // Distance is the main driver; speed adds a modest, forgiving bonus.
    const speedBonus = clamp(this.peakVel / 2600, 0, 0.17);
    this.power = clamp(Math.max(0, pull) / this.chargePixels + speedBonus, 0, 1);
    this.onCharge?.(this.power);

    // --- forward flick releases the swing ---
    const forward = this.peakDy - pull;
    if (this.power > 0.05 && forward > RELEASE_DIST && vy < -RELEASE_VEL) {
      this._fire(e.clientX, -vy);
    }
  }

  _up(e) {
    if (this.mode === 'none' || this.mode === 'key') return;
    if (e.pointerId !== undefined && e.pointerId !== this.pointerId) return;

    if (this.mode === 'charge') {
      const pull = e.clientY - this.anchorY;
      const forward = this.peakDy - pull;
      const { vy } = this._velocity();
      // Forgiving: any honest forward motion on release counts as a swing.
      if (this.power > 0.05 && forward > 22) this._fire(e.clientX, Math.max(-vy, 300));
      else { this.mode = 'none'; this.onCancel?.(); }
    } else {
      this.mode = 'none';
    }
  }

  _fire(x, forwardSpeed) {
    const w = window.innerWidth;
    // Where the forward swipe finishes, relative to the top of the backswing,
    // shapes the shot: swipe up-and-left to draw, up-and-right to fade.
    const lateral = clamp((x - this.peakX) / (w * 0.22), -1, 1);
    const tempo = clamp(forwardSpeed / 2800, 0, 1);
    // A committed forward swipe adds a little pop, but never subtracts.
    const power = clamp(this.power * (1 + tempo * 0.09), 0, 1);
    this.mode = 'none';
    this.power = 0;
    this.onRelease?.({ power, lateral, tempo });
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
