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
/**
 * The colour the bar climbs through as it charges.
 *
 * The gradient used to be fixed along the track, so the bar was green at the
 * bottom and orange at the top no matter how hard you were swinging — the
 * colour told you where you were looking, not how much power you had. Driving
 * the stops from the power instead means the whole bar warms as you pull back,
 * and the top of the fill is always the hottest colour you have earned.
 */
const RAMP = [
  [0.00, [122, 214, 132]],   // green
  [0.45, [255, 217, 122]],   // amber
  [0.78, [255, 159, 107]],   // orange
  [1.00, [255, 96, 88]],     // red
];

function rampAt(t) {
  const v = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < RAMP.length; i++) {
    if (v > RAMP[i][0] && i < RAMP.length - 1) continue;
    const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i];
    const k = t1 === t0 ? 0 : (v - t0) / (t1 - t0);
    return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)},` +
           `${Math.round(c0[1] + (c1[1] - c0[1]) * k)},` +
           `${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`;
  }
  return `rgb(${RAMP[0][1].join(',')})`;
}

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
      scoreboard: $('scoreboard'),
      sbMe: $('sbMe'), sbThem: $('sbThem'), sbState: $('sbState'),
      swingFill: $('swingFill'),
      swingStops: ['swingStop0', 'swingStop1', 'swingStop2'].map($),
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
  /**
   * The round score, in columns.
   *
   * `me` and `them` are strokes relative to par, already computed — the HUD
   * should not have to know what par is, and both sides of a match have to
   * agree on the arithmetic anyway, so it happens once where the holes live.
   * `them` of null means there is no opponent and the second row disappears.
   */
  setScore({ me = 0, them = null, themName = 'Opponent', state = '' } = {}) {
    const fmt = (v) => (v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
    const board = this.el.scoreboard;
    if (!board) return;
    board.classList.add('on');
    board.classList.toggle('match', them !== null);

    this.el.sbMe.querySelector('.sbScore').textContent = fmt(me);
    if (them !== null) {
      this.el.sbThem.querySelector('.sbName').textContent = themName;
      this.el.sbThem.querySelector('.sbScore').textContent = fmt(them);
      // Lower is better in golf, so the leader is the smaller number.
      this.el.sbMe.classList.toggle('lead', me < them);
      this.el.sbMe.classList.toggle('trail', me > them);
      this.el.sbThem.classList.toggle('lead', them < me);
      this.el.sbThem.classList.toggle('trail', them > me);
      this.el.sbState.textContent = state;
    } else {
      this.el.sbMe.classList.remove('lead', 'trail');
    }
  }

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

    // Base stays cooler than the tip, so the fill reads as heating from the
    // bottom up rather than flooding one flat colour.
    const stops = this.el.swingStops;
    if (stops && stops[0]) {
      stops[0].setAttribute('stop-color', rampAt(p * 0.30));
      stops[1].setAttribute('stop-color', rampAt(p * 0.68));
      stops[2].setAttribute('stop-color', rampAt(p));
      const hot = rampAt(p).replace('rgb(', 'rgba(').replace(')', `,${(0.30 + p * 0.35).toFixed(2)})`);
      el.style.setProperty('--swingGlow', hot);
    }
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
