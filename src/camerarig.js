/**
 * camerarig.js — soft, damped camera.
 *
 * Nothing here ever snaps. Every mode computes a *desired* position, look-at
 * and FOV, and the rig eases toward them with frame-rate independent damping.
 * Different modes just use different stiffnesses.
 */

import * as THREE from 'three';
import { clamp, lerp, damp, easeInOutSine } from './util.js';
import { heightAt } from './course.js';

/** Length of the opening move. Any tap skips to the last moments of it. */
export const INTRO_DUR = 3.6;

export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(0, 30, 60);
    this.look = new THREE.Vector3(0, 0, 0);
    this.desiredPos = this.pos.clone();
    this.desiredLook = this.look.clone();
    this.fov = camera.fov;
    this.desiredFov = camera.fov;

    this.mode = 'intro';
    this.introT = 0;
    this.time = 0;
    this._tmp = new THREE.Vector3();
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === 'intro') this.introT = 0;
  }

  /** Jump the camera straight to its desired framing (used at reset). */
  snap() {
    this.pos.copy(this.desiredPos);
    this.look.copy(this.desiredLook);
  }

  /**
   * @param ctx { ball:Vector3, aim:number, shotDir:Vector3|null,
   *              charge:number, ballHeight:number, holePos:Vector3 }
   */
  update(dt, ctx) {
    this.time += dt;
    const b = ctx.ball;
    const fwd = this._tmp.set(Math.sin(ctx.aim), 0, -Math.cos(ctx.aim));

    let lamPos = 3.2, lamLook = 4.5;

    switch (this.mode) {
      // ---- opening flourish: a slow drift down to the tee ----
      case 'intro': {
        this.introT += dt;
        const u = clamp(this.introT / INTRO_DUR, 0, 1);
        const e = easeInOutSine(u);
        // Start high and wide behind the tee, then drift down onto the ball.
        const th = ctx.aim - 0.72 * (1 - e);
        const r = lerp(62, 11.5, e);
        const h = lerp(34, 4.6, e);
        this.desiredPos.set(b.x - Math.sin(th) * r, b.y + h, b.z + Math.cos(th) * r);
        const gaze = lerp(46, 11, e);
        this.desiredLook.set(b.x + fwd.x * gaze, b.y + lerp(7, 1.5, e), b.z + fwd.z * gaze);
        this.desiredFov = lerp(47, 53, e);
        lamPos = 3.0; lamLook = 3.0;
        break;
      }

      // ---- standing over the ball ----
      case 'address': {
        // Directly behind the ball, looking straight down the aim line.
        //
        // Any sideways step at all costs heading: standing 1.15 yards to the
        // side and looking through the ball points the camera 6 degrees off the
        // line, so the aim arrow ran diagonally across the screen instead of
        // straight up it. Centring the ball and facing where the arrow faces
        // are the same requirement, and both need the camera on the line.
        //
        // The offset existed because dead behind, the shaft can cross the ball.
        // With the golfer standing perpendicular to the line that is a glance
        // rather than an occlusion, and it is not worth six degrees of heading.
        const back = lerp(10.6, 9.3, ctx.charge);
        // The whisper of life moved from a sideways sway to a vertical one, so
        // that it cannot disturb the heading.
        const up = lerp(4.3, 3.9, ctx.charge) + Math.sin(this.time * 0.28) * 0.10;
        this.desiredPos.set(b.x - fwd.x * back, b.y + up, b.z - fwd.z * back);
        this.desiredLook.set(b.x + fwd.x * 11, b.y + 1.5, b.z + fwd.z * 11);
        this.desiredFov = lerp(53, 50.5, ctx.charge);
        lamPos = 2.6; lamLook = 3.4;
        break;
      }

      // ---- following the shot ----
      case 'flight': {
        const dir = ctx.shotDir ?? fwd;
        const travel = ctx.travelled ?? 0;
        const back = 12 + clamp(travel * 0.055, 0, 20);
        const up = 4.5 + clamp(ctx.ballHeight * 0.36, 0, 26);
        this.desiredPos.set(b.x - dir.x * back, b.y + up - ctx.ballHeight * 0.28, b.z - dir.z * back);
        // Lead the ball slightly so the eye travels with it.
        this.desiredLook.set(b.x + dir.x * 7, b.y + 1.2, b.z + dir.z * 7);
        this.desiredFov = 55.5;
        lamPos = 2.1; lamLook = 3.6;
        break;
      }

      // ---- the ball has stopped; drift into a calm framing ----
      case 'settle': {
        const toHole = this._toHole(ctx);
        this.desiredPos.set(b.x - toHole.x * 10, b.y + 5.0, b.z - toHole.z * 10);
        this.desiredLook.set(b.x + toHole.x * 6, b.y + 1.2, b.z + toHole.z * 6);
        this.desiredFov = 52;
        lamPos = 1.9; lamLook = 2.6;
        break;
      }

      // ---- driving: a chase camera behind the cart ----
      //
      // Framed from the cart's heading rather than from its velocity. Velocity
      // is the obvious choice and it is wrong: reverse into a tree and the
      // camera whips round to look at your own bonnet, and stopping dead
      // leaves it with no direction at all. Heading always has one.
      //
      // It also sits further back the faster you go, which is the whole of
      // what makes speed feel like speed when the geometry is this simple.
      case 'drive': {
        const c = ctx.cart;
        const sp = Math.min(1, Math.abs(c.speed) / 12);
        const back = 7.4 + sp * 3.2;
        const hs = Math.sin(c.heading), hc = Math.cos(c.heading);
        this.desiredPos.set(
          c.pos.x - hs * back, c.pos.y + 3.5 + sp * 0.5, c.pos.z + hc * back
        );
        this.desiredLook.set(
          c.pos.x + hs * 7, c.pos.y + 1.3, c.pos.z - hc * 7
        );
        this.desiredFov = 56 + sp * 8;
        // Loose on the way in, tight on the way round, so a turn reads as a
        // turn instead of the world sliding past a fixed camera.
        lamPos = 3.6; lamLook = 5.0;
        break;
      }

      // ---- holed out: a slow, quiet orbit ----
      case 'holed': {
        const a = this.time * 0.16;
        this.desiredPos.set(b.x + Math.sin(a) * 9, b.y + 4.4, b.z + Math.cos(a) * 9);
        this.desiredLook.set(b.x, b.y + 0.9, b.z);
        this.desiredFov = 48;
        lamPos = 1.4; lamLook = 2.2;
        break;
      }
    }

    this.pos.x = damp(this.pos.x, this.desiredPos.x, lamPos, dt);
    this.pos.y = damp(this.pos.y, this.desiredPos.y, lamPos, dt);
    this.pos.z = damp(this.pos.z, this.desiredPos.z, lamPos, dt);
    this.look.x = damp(this.look.x, this.desiredLook.x, lamLook, dt);
    this.look.y = damp(this.look.y, this.desiredLook.y, lamLook, dt);
    this.look.z = damp(this.look.z, this.desiredLook.z, lamLook, dt);
    this.fov = damp(this.fov, this.desiredFov, 3.0, dt);

    // Never let the camera clip through a hill.
    const floor = heightAt(this.pos.x, this.pos.z) + 2.2;
    const y = Math.max(this.pos.y, floor);

    this.cam.position.set(this.pos.x, y, this.pos.z);
    this.cam.lookAt(this.look);
    if (Math.abs(this.cam.fov - this.fov) > 0.01) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }

  _toHole(ctx) {
    const d = new THREE.Vector3(ctx.holePos.x - ctx.ball.x, 0, ctx.holePos.z - ctx.ball.z);
    if (d.lengthSq() < 1e-4) d.set(0, 0, -1);
    return d.normalize();
  }

  get introDone() { return this.introT >= INTRO_DUR; }

  /** Fast-forward the opening move, leaving just enough to land softly. */
  skipIntro() {
    if (this.mode === 'intro') this.introT = Math.max(this.introT, INTRO_DUR - 0.55);
  }
}
