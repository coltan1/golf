/**
 * hud.js — a thin wrapper over the DOM overlay in index.html.
 *
 * Deliberately minimal: hole info, stroke count, a power bar that only exists
 * while you're charging, and one line of contextual text. Everything fades.
 */

import { clamp } from './util.js';

// Geometry of the swing bar, matching the SVG in index.html.
const BAR_MID = 36;
const BAR_TOP = 26;
const BAR_BOTTOM = 294;
// How far the fill leans at full deflection.
//
// Deliberately more than the track can hold. Kept inside, the bend was legible
// only by comparing it against the outline; bowing out of the track makes the
// shape of the shot obvious at a glance, which is the whole reason the bar
// bends at all. The SVG is overflow:visible so it draws outside its box.
const BAR_BEND = 26;

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      holeNo: $('holeNo'),
      holeName: $('holeName'),
      holePar: $('holePar'),
      holeYds: $('holeYds'),
      strokes: $('strokes'),
      hint: $('hint'),
      power: $('power'),
      powerLabel: $('powerLabel'),
      shot: $('shot'),
      card: $('card'),
      cardTitle: $('cardTitle'),
      cardSub: $('cardSub'),
      btnAgain: $('btnAgain'),
      btnSound: $('btnSound'),
      freecam: $('freecamHud'),
      loader: $('loader'),
      swingFill: $('swingFill'),
      swingMark: $('swingMark'),
    };
    this._hintTimer = null;
    this._shotTimer = null;
  }

  /** Bring the loading screen back for a hole change. */
  showLoader(sub) {
    const el = this.el.loader;
    el.style.display = '';
    // Force a reflow so the browser sees display and opacity change in two
    // steps; set together, it skips the transition and the screen pops.
    void el.offsetHeight;
    el.classList.remove('hide');
    if (sub) {
      const s = document.getElementById('loaderSub');
      if (s) s.textContent = sub;
    }
  }

  hideLoader() {
    this.el.loader.classList.add('hide');
    setTimeout(() => { this.el.loader.style.display = 'none'; }, 950);
  }

  /** Hole number, name, par and measured length. */
  setHole(number, name, par, yards) {
    this.el.holeNo.textContent = `Hole ${number}`;
    this.el.holeName.textContent = name;
    this.el.holePar.textContent = `Par ${par}`;
    this.el.holeYds.textContent = `${Math.round(yards)} yds`;
  }

  setStatus(stroke, club, toPin) {
    const bits = [`Stroke ${stroke}`];
    if (club) bits.push(club);
    if (toPin != null) bits.push(`${Math.round(toPin)} to pin`);
    this.el.strokes.innerHTML = bits
      .map((b, i) => (i === 0 ? b : `<span class="dim">${b}</span>`))
      .join('<span class="sep">·</span>');
  }

  /** `hold` in seconds, or 0 to leave it up until the next call. */
  hint(text, hold = 0) {
    clearTimeout(this._hintTimer);
    if (!text) { this.el.hint.classList.remove('show'); return; }
    this.el.hint.textContent = text;
    this.el.hint.classList.add('show');
    if (hold) this._hintTimer = setTimeout(() => this.el.hint.classList.remove('show'), hold * 1000);
  }

  showPower(on) {
    this.el.power.classList.toggle('show', on);
    if (!on) this.el.powerLabel.classList.remove('show');
  }

  /**
   * Put a notch across the bar, as a 0..1 height, or null to hide it. Used on
   * putts, where the meter reads as a fraction of the distance needed and the
   * halfway point is therefore a real target rather than a number.
   */
  setPowerTarget(v) {
    const el = this.el.swingMark;
    if (!el) return;
    const on = v !== null && v !== undefined;
    el.classList.toggle('on', on);
    if (on) {
      const y = (BAR_BOTTOM - clamp(v, 0, 1) * (BAR_BOTTOM - BAR_TOP)).toFixed(1);
      el.setAttribute('y1', y);
      el.setAttribute('y2', y);
    }
  }

  /**
   * How far the swing is cutting across the ball, -1 (left) to 1 (right).
   *
   * The fill bends the *opposite* way, because that is the shape of the shot
   * rather than the shape of the stroke: a stroke coming across to the right
   * puts left-hand spin on the ball and the flight bends left. So the bar shows
   * you where the ball is going, not where your thumb went — which is the only
   * version of this that is any use while you are swinging.
   */
  setSwingCurve(v) {
    this._curve = clamp(v ?? 0, -1, 1);
    this._drawSwing();
  }

  setPower(v) {
    this._power = clamp(v, 0, 1);
    this._drawSwing();
    if (this._power > 0.02) {
      this.el.powerLabel.textContent = `${Math.round(this._power * 100)}%`;
      this.el.powerLabel.classList.add('show');
    } else {
      this.el.powerLabel.classList.remove('show');
    }
  }

  _drawSwing() {
    const el = this.el.swingFill;
    if (!el) return;
    const p = this._power ?? 0;
    const bend = -(this._curve ?? 0) * BAR_BEND;
    // Quadratic from the bottom of the track to the top. The control point
    // leans further than the end point, so the fill bows rather than merely
    // tilting — a straight line at an angle does not read as spin.
    el.setAttribute('d',
      `M${BAR_MID} ${BAR_BOTTOM} Q ${(BAR_MID + bend * 1.35).toFixed(1)} 160 ` +
      `${(BAR_MID + bend).toFixed(1)} ${BAR_TOP}`);
    el.style.strokeDashoffset = `${(100 - p * 100).toFixed(1)}`;
  }

  shot(text, hold = 3.4) {
    clearTimeout(this._shotTimer);
    this.el.shot.textContent = text;
    this.el.shot.classList.add('show');
    this._shotTimer = setTimeout(() => this.el.shot.classList.remove('show'), hold * 1000);
  }

  /** Freecam overlay: controls plus a live position readout. */
  setFreecam(on, text) {
    this.el.freecam.classList.toggle('show', on);
    if (on && text) this.el.freecam.textContent = text;
  }

  card(title, sub, buttonLabel) {
    this.el.cardTitle.textContent = title;
    this.el.cardSub.textContent = sub;
    if (buttonLabel) this.el.btnAgain.textContent = buttonLabel;
    this.el.card.classList.add('show');
  }

  hideCard() { this.el.card.classList.remove('show'); }

  onAgain(fn) { this.el.btnAgain.addEventListener('click', fn); }

  onSound(fn) {
    this.el.btnSound.addEventListener('click', () => {
      const on = this.el.btnSound.textContent.trim() === '🔇';
      this.el.btnSound.textContent = on ? '🔊' : '🔇';
      fn(on);
    });
  }
}

/** Human-readable score name relative to par. */
export function scoreName(strokes, par) {
  const d = strokes - par;
  if (strokes === 1) return 'Hole in one!';
  if (d <= -3) return 'Albatross!';
  if (d === -2) return 'Eagle!';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double bogey';
  return `+${d}`;
}
