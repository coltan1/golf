/**
 * freecam.js — a detached fly-through camera for inspecting the course.
 *
 * Purely a development / sightseeing tool: the game keeps simulating while
 * it's active, so you can launch a shot and then go and watch it from
 * anywhere, or fly down to the pond to check how the water is reading.
 *
 * Toggle with F, or call `freecam()` from the browser console.
 */

import * as THREE from 'three';
import { clamp } from './util.js';

const LOOK_SENSITIVITY = 0.0032;   // radians per pixel
const PITCH_LIMIT = 1.5;           // just shy of straight up/down
const BASE_SPEED = 28;             // yards per second
const FAST = 3.5;                  // shift
const SLOW = 0.25;                 // ctrl

export class FreeCam {
  constructor(camera, dom) {
    this.cam = camera;
    this.dom = dom;

    this.active = false;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.speed = BASE_SPEED;

    this.keys = Object.create(null);
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;

    // Listeners stay attached always but bail unless active, so the game's
    // own swipe input is never competing with these.
    dom.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this._dragging = true;
      this._pointerId = e.pointerId;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
    }, { passive: false });

    window.addEventListener('pointermove', (e) => {
      if (!this.active || !this._dragging || e.pointerId !== this._pointerId) return;
      this.yaw -= (e.clientX - this._lastX) * LOOK_SENSITIVITY;
      this.pitch = clamp(
        this.pitch - (e.clientY - this._lastY) * LOOK_SENSITIVITY,
        -PITCH_LIMIT, PITCH_LIMIT
      );
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });

    const endDrag = () => { this._dragging = false; };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    dom.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.speed = clamp(this.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1.5, 400);
    }, { passive: false });

    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => { this.keys = Object.create(null); });
  }

  /** Start flying from wherever the game camera currently is. */
  enable() {
    if (this.active) return;
    this.active = true;
    this.pos.copy(this.cam.position);

    // Derive yaw/pitch from the live camera so there's no jump on entry.
    const dir = new THREE.Vector3();
    this.cam.getWorldDirection(dir);
    this.pitch = Math.asin(clamp(dir.y, -1, 1));
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.speed = BASE_SPEED;
  }

  disable() {
    this.active = false;
    this._dragging = false;
  }

  toggle() { this.active ? this.disable() : this.enable(); }

  /** Jump somewhere specific — handy from the console. */
  goto(x, y, z) {
    this.enable();
    this.pos.set(x, y, z);
  }

  /** Point at a world position from wherever we are. */
  lookAt(x, y, z) {
    const dx = x - this.pos.x, dy = y - this.pos.y, dz = z - this.pos.z;
    const flat = Math.hypot(dx, dz) || 1e-4;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = clamp(Math.atan2(dy, flat), -PITCH_LIMIT, PITCH_LIMIT);
  }

  update(dt) {
    if (!this.active) return;

    // Movement basis from yaw only, so W always tracks the horizon.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);

    let f = 0, r = 0, u = 0;
    const k = this.keys;
    if (k.KeyW || k.ArrowUp) f += 1;
    if (k.KeyS || k.ArrowDown) f -= 1;
    if (k.KeyD || k.ArrowRight) r += 1;
    if (k.KeyA || k.ArrowLeft) r -= 1;
    if (k.KeyE || k.Space) u += 1;
    if (k.KeyQ) u -= 1;

    let v = this.speed;
    if (k.ShiftLeft || k.ShiftRight) v *= FAST;
    if (k.ControlLeft || k.ControlRight) v *= SLOW;
    v *= dt;

    this.pos.x += (fx * f + rx * r) * v;
    this.pos.z += (fz * f + rz * r) * v;
    this.pos.y += u * v;

    this.cam.position.copy(this.pos);
    this.cam.rotation.order = 'YXZ';
    this.cam.rotation.set(this.pitch, this.yaw, 0);
  }

  /** One-line status for the HUD. */
  status() {
    return `FREECAM  ·  ${this.speed.toFixed(0)} yd/s\n` +
           `x ${this.pos.x.toFixed(0)}  y ${this.pos.y.toFixed(0)}  z ${this.pos.z.toFixed(0)}\n` +
           `WASD move · Q/E down/up · drag look\nshift fast · ctrl slow · wheel speed · F exit`;
  }
}
