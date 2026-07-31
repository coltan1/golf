/**
 * match.js — online 1v1.
 *
 * Simultaneous stroke play, not alternating shots. Both players play the same
 * hole at their own pace, each sees the other's ball, and neither moves on
 * until both have holed out. Alternating would be more literally "turn based",
 * but it means one player sits watching a progress bar for half of every hole;
 * simultaneous keeps both people swinging and removes turn arbitration — which
 * is the part of a networked game most likely to be subtly wrong — entirely.
 *
 * The holes are already deterministic from their definitions, so there is no
 * course to synchronise: both clients build hole 1 identically. The only shared
 * state is where the two balls are and how many strokes each has taken.
 *
 * Nothing here trusts the network for anything it can compute locally. A
 * dropped or duplicated message costs a stale ghost ball for a second, never a
 * wrong score.
 */

import * as THREE from 'three';
import { Net } from './net.js';

const GHOST_COLOUR = 0xff8a5c;

export class Match {
  constructor(scene) {
    this.net = new Net();
    this.scene = scene;
    this.active = false;
    this.hole = 0;

    this.myStrokes = 0;
    this.oppStrokes = 0;
    this.myTotal = 0;
    this.oppTotal = 0;
    this.myDone = false;
    this.oppDone = false;

    this.onStatus = null;    // (text, kind)
    this.onAdvance = null;   // both players finished the hole

    this._ghost = null;
    this._ghostTo = new THREE.Vector3();
    this._ghostHas = false;

    this.net.onState = (s, d) => this._state(s, d);
    this.net.onMessage = (m) => this._message(m);
  }

  // ------------------------------------------------------------ lifecycle
  async find(name) {
    this.onStatus?.('Looking for an opponent…', 'busy');
    try {
      await this.net.connect(name);
    } catch {
      this.onStatus?.('No relay running — start the server and reload.', 'error');
    }
  }

  leave() {
    this.net.close();
    this.active = false;
    this._hideGhost();
    this.onStatus?.('', 'idle');
  }

  _state(s, d) {
    if (s === 'waiting') this.onStatus?.('Waiting for an opponent…', 'busy');
    else if (s === 'matched') {
      this.active = true;
      this.hole = 0;
      this.myTotal = this.oppTotal = 0;
      this._resetHole();
      this.onStatus?.(`Matched with ${d.opponent}`, 'good');
    } else if (s === 'left') {
      this.active = false;
      this._hideGhost();
      this.onStatus?.('Opponent left the match.', 'error');
    }
  }

  _resetHole() {
    this.myStrokes = this.oppStrokes = 0;
    this.myDone = this.oppDone = false;
    this._ghostHas = false;
    this._hideGhost();
  }

  // ------------------------------------------------------------ from the game
  /**
   * Our ball has come to rest. Sent on rest rather than every frame: a golf
   * ball is stationary almost all of the time, and the ghost glides to each new
   * position anyway, so a position per shot is all the fidelity there is to
   * have.
   */
  reportRest(hole, pos, strokes) {
    this.myStrokes = strokes;
    if (!this.active) return;
    this.net.send({ t: 'ball', h: hole, x: +pos.x.toFixed(2), y: +pos.y.toFixed(2),
      z: +pos.z.toFixed(2), s: strokes });
  }

  reportHoled(hole, strokes) {
    this.myStrokes = strokes;
    if (!this.active || this.myDone) return;
    this.myDone = true;
    this.myTotal += strokes;
    this.net.send({ t: 'hole', h: hole, s: strokes });
    this._checkHole();
  }

  /** True while we are waiting on the other player to finish this hole. */
  get waitingForOpponent() {
    return this.active && this.myDone && !this.oppDone;
  }

  // ------------------------------------------------------------ from the wire
  _message(m) {
    if (!this.active || !m || m.h !== this.hole) return;
    if (m.t === 'ball') {
      this.oppStrokes = m.s ?? this.oppStrokes;
      this._moveGhost(m.x, m.y, m.z);
    } else if (m.t === 'hole') {
      if (this.oppDone) return;         // duplicate; scores must not double
      this.oppDone = true;
      this.oppStrokes = m.s ?? 0;
      this.oppTotal += this.oppStrokes;
      this._hideGhost();
      this._checkHole();
    }
  }

  _checkHole() {
    if (this.myDone && this.oppDone) {
      const me = this.myStrokes, them = this.oppStrokes;
      const verdict = me < them ? 'Hole won' : me > them ? 'Hole lost' : 'Hole halved';
      this.onStatus?.(`${verdict} — ${me} to ${them}`, me < them ? 'good' : me > them ? 'bad' : 'idle');
      this.hole++;
      this._resetHole();
      this.onAdvance?.();
    } else if (this.myDone) {
      this.onStatus?.(`In with ${this.myStrokes}. Waiting for opponent…`, 'busy');
    }
  }

  // ------------------------------------------------------------ ghost ball
  _ensureGhost() {
    if (this._ghost) return this._ghost;
    const g = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 18, 14),
      new THREE.MeshBasicMaterial({ color: GHOST_COLOUR })
    );
    g.name = 'opponentBall';
    g.renderOrder = 4;
    g.visible = false;
    this.scene.add(g);
    this._ghost = g;
    return g;
  }

  _moveGhost(x, y, z) {
    const g = this._ensureGhost();
    this._ghostTo.set(x, y + 0.15, z);
    if (!this._ghostHas) { g.position.copy(this._ghostTo); this._ghostHas = true; }
    g.visible = true;
  }

  _hideGhost() { if (this._ghost) this._ghost.visible = false; }

  /** Glide the ghost rather than teleporting it, so the eye can follow it. */
  update(dt) {
    const g = this._ghost;
    if (!g || !g.visible) return;
    g.position.lerp(this._ghostTo, Math.min(1, dt * 4));
    // A slow bob, so a stationary opponent ball still reads as a live thing.
    g.scale.setScalar(1 + Math.sin(performance.now() * 0.004) * 0.06);
  }

  get scoreline() {
    if (!this.active) return '';
    const d = this.myTotal - this.oppTotal;
    const lead = d < 0 ? `${-d} up` : d > 0 ? `${d} down` : 'all square';
    return `You ${this.myTotal} · Them ${this.oppTotal} · ${lead}`;
  }
}
