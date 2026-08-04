/**
 * match.js — online 1v1.
 *
 * Alternating stroke play. You hit, then they hit, and while it is their turn
 * you watch them do it — the camera goes to their ball and your swing is locked
 * out until their shot comes to rest.
 *
 * Turn arbitration is the part of a networked game most likely to be subtly
 * wrong, so there is no turn message and no negotiation. The turn simply
 * follows the last shot that finished: when my ball comes to rest I hand over,
 * and when their `ball` arrives I take it back. Every transition is driven by
 * an event both sides already had to send, so a turn cannot be invented, lost
 * in transit, or held by both players at once. If one of them holes out first,
 * the other keeps the turn until they are in too.
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
import { Golfer } from './golfer.js';
import { Cart } from './cart.js';
import { makeToonRamp } from './terrain.js';
import { heightAt, HOLE_POS } from './course.js';

const GHOST_COLOUR = 0xff8a5c;
// How long the opponent's backswing takes before the club comes down. Only
// needs to look like a swing — the shot it produces was decided on their
// machine and arrives separately.
const OPP_BACKSWING_MS = 550;

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
    // Has each side played its shot for this exchange?
    //
    // Separate from whose turn it is, and from who has holed out, because it
    // answers a different question: not "may I swing" but "have we both had
    // our go, so may we both set off". Cleared the moment a drive begins.
    this.myRested = false;
    this.oppRested = false;
    // 0 or 1 — the side whose shot the world is waiting on. Compared against
    // net.side, which the pairing already settled.
    this.turn = 0;

    this.onStatus = null;    // (text, kind)
    this.onAdvance = null;   // both players finished the hole
    this.onMatched = null;   // (meta) paired — build the host's course
    this.onTurn = null;      // (mine) the turn changed hands

    this._ghost = null;
    this._ghostTo = new THREE.Vector3();
    this._ghostHas = false;

    // The opponent, standing on the same grass as you. Built on the first look
    // message and kept in the scene rather than the per-hole group, so changing
    // hole does not throw them away.
    this._ramp = null;
    this._opp = null;
    // Their cart. Built on the first `cart` message rather than on matching,
    // because until somebody drives there is nothing to show and a parked
    // cart in the middle of the fairway would be a lie.
    this.oppCart = null;
    this._cartSent = 0;
    this._oppTo = new THREE.Vector3();
    this._oppHas = false;
    this._time = 0;
    this.myLook = null;      // set by main.js so we can tell them how we look

    this.net.onState = (s, d) => this._state(s, d);
    this.net.onMessage = (m) => this._message(m);
  }

  // ------------------------------------------------------------ lifecycle
  /**
   * Connect and start listening to the lobby, without joining anything. The
   * menu shows a list of open lobbies before you commit, so connecting and
   * committing have to be separate steps.
   */
  async browse(name) {
    try {
      await this.net.connect(name);
      return true;
    } catch {
      this.onStatus?.('Could not reach a matchmaking broker — check your connection.', 'error');
      return false;
    }
  }

  quick(meta) { this.net.quick(meta); this.onStatus?.('Looking for an opponent…', 'busy'); }
  host(meta) { this.net.host(meta); this.onStatus?.('Lobby open — waiting for someone to join…', 'busy'); }
  join(id) { return this.net.join(id); }
  set onLobbies(fn) { this.net.onLobbies = fn; }

  leave() {
    clearTimeout(this._swingTimer);
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
      // Whoever hosted decided the course and the time; both sides build the
      // same world from it. Surfaced rather than applied here, because the
      // world is main.js's to build.
      this.meta = d?.meta ?? null;
      this.myTotal = this.oppTotal = 0;
      this._resetHole();
      // Tell them what we look like. Both sides do this on matching, so each
      // renders the other's actual customised golfer rather than a stand-in.
      if (this.myLook) this.net.send({ t: 'look', look: this.myLook });
      this.onStatus?.(`Matched with ${d.opponent}`, 'good');
      this.onMatched?.(this.meta);
    } else if (s === 'left') {
      this.active = false;
      this._hideGhost();
      this.onStatus?.('Opponent left the match.', 'error');
    }
  }

  _resetHole() {
    this.myStrokes = this.oppStrokes = 0;
    this.myDone = this.oppDone = false;
    this.myRested = this.oppRested = false;
    this._ghostHas = false;
    this._hideGhost();
    // Honour alternates by hole, so neither player tees off first all round.
    this._setTurn(this.hole % 2);
  }

  _setTurn(side) {
    const was = this.turn;
    this.turn = side;
    if (was !== side) this.onTurn?.(this.myTurn);
  }

  /**
   * Both players have played, so both may drive.
   *
   * A player who has holed out counts as played for the rest of the hole —
   * they will never rest another ball, and without that the other one waits
   * for a shot that is never coming and never drives again.
   */
  get bothPlayed() {
    return (this.myRested || this.myDone) && (this.oppRested || this.oppDone);
  }

  /** Called when a drive starts: the exchange is over, the next one is open. */
  clearExchange() {
    this.myRested = false;
    this.oppRested = false;
  }

  /** True when the game should let us swing. */
  get myTurn() {
    if (!this.active) return true;
    if (this.oppDone) return true;        // they are in; play it out alone
    if (this.myDone) return false;        // we are in; watch them finish
    return this.turn === this.net.side;
  }

  /** True while we should be watching them instead of playing. */
  get spectating() {
    return this.active && !this.myTurn && !!this._opp;
  }

  /** Where the camera should be looking while spectating. */
  get watchPos() { return this._ghostTo; }

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
    this.myRested = true;
    // Our shot is over, so it is theirs — unless they are already in the hole,
    // in which case the turn never leaves us again.
    if (!this.oppDone) this._setTurn(1 - this.net.side);
  }

  /**
   * Where our cart is, ten times a second.
   *
   * Rate-limited here rather than by the caller, because the caller is a frame
   * loop and would send sixty a second without noticing. Ten is enough: the
   * ghost interpolates between them, and a cart is a slow thing that does not
   * change direction faster than that.
   *
   * Position, heading and speed only. No inputs, no acknowledgement, nothing
   * to reconcile — if a packet goes missing the ghost simply keeps gliding to
   * the last place it knew about, and the next one puts it right.
   */
  reportCart(cart) {
    if (!this.active) return;
    const now = performance.now();
    if (now - this._cartSent < 100) return;
    this._cartSent = now;
    this.net.send({
      t: 'cart',
      x: +cart.pos.x.toFixed(2), z: +cart.pos.z.toFixed(2),
      h: +cart.heading.toFixed(3), v: +cart.speed.toFixed(2),
    });
  }

  /** Their cart is parked and they are playing a shot — put it away. */
  hideCart() {
    if (this.oppCart) this.oppCart.visible = false;
  }

  /** We have struck the ball — let them watch us do it. */
  reportSwing(hole, power) {
    if (!this.active) return;
    this.net.send({ t: 'swing', h: hole, p: +power.toFixed(3) });
  }

  reportHoled(hole, strokes) {
    this.myStrokes = strokes;
    if (!this.active || this.myDone) return;
    this.myDone = true;
    this.myRested = true;
    this.myTotal += strokes;
    this.net.send({ t: 'hole', h: hole, s: strokes });
    if (!this.oppDone) this._setTurn(1 - this.net.side);
    this._checkHole();
  }

  /** Push a restyle mid-match, so changing your kit shows up on their screen. */
  sendLook(look) {
    this.myLook = look;
    if (this.active) this.net.send({ t: 'look', look });
  }

  /** True while we are waiting on the other player to finish this hole. */
  get waitingForOpponent() {
    return this.active && this.myDone && !this.oppDone;
  }

  /**
   * Put both of them on the tee at the start of a hole.
   *
   * Without this the opponent has no known position until their first shot
   * lands, so the first turn of every hole would be spent watching an empty
   * fairway. main.js calls it once the new hole is built and the tee is known.
   */
  placeAtTee(x, z) {
    if (!this.active) return;
    this._ghostTo.set(x, heightAt(x, z) + 0.15, z);
    const g = this._ensureGhost();
    g.position.copy(this._ghostTo);
    g.visible = true;
    this._ghostHas = true;
    this._placeOpponent(x, z);
    this.onTurn?.(this.myTurn);
  }

  // ------------------------------------------------------------ from the wire
  _message(m) {
    if (!this.active || !m) return;
    // Appearance is not tied to a hole, so it is handled before the hole check
    // — it usually arrives while both players are still on hole 1, but a late
    // joiner or a reconnect should not lose it.
    if (m.t === 'look') { this._buildOpponent(m.look); return; }
    if (m.t === 'cart') {
      this._ramp ??= makeToonRamp();
      this.oppCart ??= new Cart(this.scene, {
        // Their cart is the other colour, and it has to be obvious at forty
        // yards which one is coming at you.
        colour: 0xe8734a, ramp: this._ramp, ghost: true,
      });
      this.oppCart.target = { x: m.x, z: m.z, h: m.h, v: m.v ?? 0 };
      if (!this.oppCart.visible) {
        this.oppCart.place(m.x, m.z, m.h);
        this.oppCart.visible = true;
      }
      return;
    }
    if (m.t === 'parked') { this.hideCart(); return; }
    if (m.h !== this.hole) return;
    if (m.t === 'swing') { this._playOpponentSwing(m.p ?? 0.6); return; }
    if (m.t === 'ball') {
      this.oppStrokes = m.s ?? this.oppStrokes;
      this.oppRested = true;
      this._moveGhost(m.x, m.y, m.z);
      if (!this.myDone) this._setTurn(this.net.side);
    } else if (m.t === 'hole') {
      if (this.oppDone) return;         // duplicate; scores must not double
      this.oppDone = true;
      this.oppRested = true;
      this.oppStrokes = m.s ?? 0;
      this.oppTotal += this.oppStrokes;
      this._hideGhost();
      if (!this.myDone) this._setTurn(this.net.side);
      this._checkHole();
    }
  }

  // ------------------------------------------------------------ the opponent
  /** Build (or restyle) the other player's golfer. */
  _buildOpponent(look) {
    if (!this._opp) {
      this._ramp ??= makeToonRamp();
      this._opp = new Golfer(this._ramp, look ?? undefined);
      this._opp.visible = false;
      this.scene.add(this._opp.root);
    } else if (look) {
      this._opp.setLook(look);
    }
  }

  /**
   * Put them where their ball is, facing the hole.
   *
   * Their golfer stands at the ball rather than being interpolated separately:
   * a golfer and their ball are never in two places, and syncing one position
   * cannot desynchronise from itself.
   */
  _placeOpponent(x, z) {
    if (!this._opp) this._buildOpponent(null);
    const y = heightAt(x, z);
    const aim = Math.atan2(HOLE_POS.x - x, -(HOLE_POS.z - z));
    this._opp.place(x, y, z, aim, !this._oppHas);
    this._opp.visible = true;
    this._oppHas = true;
  }

  /**
   * Play their swing. Driven through the same rig a local swing uses, so it
   * has the same weight shift, wrist release and finish — it just gets its
   * numbers from the network instead of a thumb.
   */
  _playOpponentSwing(power) {
    const g = this._opp;
    if (!g) return;
    g.forceIdle();
    g.beginBackswing();
    g.setCharge(Math.max(0, Math.min(1, power)));
    clearTimeout(this._swingTimer);
    this._swingTimer = setTimeout(() => {
      if (g.beginDrive()) g.coastDrive(6 + power * 11);
    }, OPP_BACKSWING_MS);
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
    this._placeOpponent(x, z);
  }

  _hideGhost() {
    if (this._ghost) this._ghost.visible = false;
    if (this._opp) this._opp.visible = false;
    if (this.oppCart) this.oppCart.visible = false;
    this._oppHas = false;
  }

  /** Glide the ghost rather than teleporting it, so the eye can follow it. */
  update(dt) {
    this._time += dt;
    // The opponent animates whether or not their ball is on screen — they are
    // still standing there between shots, breathing and settling.
    if (this._opp && this._opp.visible) this._opp.update(dt, this._time);
    if (this.oppCart && this.oppCart.visible) this.oppCart.update(dt, null);
    const g = this._ghost;
    if (!g || !g.visible) return;
    g.position.lerp(this._ghostTo, Math.min(1, dt * 4));
    // A slow bob, so a stationary opponent ball still reads as a live thing.
    g.scale.setScalar(1 + Math.sin(performance.now() * 0.004) * 0.06);
  }

  /** Where the match stands, in words. The numbers live on the scoreboard. */
  get lead() {
    if (!this.active) return '';
    const d = this.myTotal - this.oppTotal;
    return d < 0 ? `${-d} ahead` : d > 0 ? `${d} behind` : 'All square';
  }
}
