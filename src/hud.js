/**
 * hud.js — a thin wrapper over the DOM overlay in index.html.
 *
 * Deliberately minimal: hole info, stroke count, a power bar that only exists
 * while you're charging, and one line of contextual text. Everything fades.
 */

import { clamp } from './util.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      holeYds: $('holeYds'),
      strokes: $('strokes'),
      hint: $('hint'),
      power: $('power'),
      powerFill: $('powerFill'),
      powerLabel: $('powerLabel'),
      shot: $('shot'),
      card: $('card'),
      cardTitle: $('cardTitle'),
      cardSub: $('cardSub'),
      btnAgain: $('btnAgain'),
      btnSound: $('btnSound'),
      loader: $('loader'),
    };
    this._hintTimer = null;
    this._shotTimer = null;
  }

  hideLoader() {
    this.el.loader.classList.add('hide');
    setTimeout(() => { this.el.loader.style.display = 'none'; }, 950);
  }

  setHoleLength(yards) { this.el.holeYds.textContent = `${Math.round(yards)} yds`; }

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

  setPower(v) {
    const p = clamp(v, 0, 1);
    this.el.powerFill.style.width = `${p * 100}%`;
    if (p > 0.02) {
      this.el.powerLabel.textContent = `${Math.round(p * 100)}%`;
      this.el.powerLabel.classList.add('show');
    } else {
      this.el.powerLabel.classList.remove('show');
    }
  }

  shot(text, hold = 3.4) {
    clearTimeout(this._shotTimer);
    this.el.shot.textContent = text;
    this.el.shot.classList.add('show');
    this._shotTimer = setTimeout(() => this.el.shot.classList.remove('show'), hold * 1000);
  }

  card(title, sub) {
    this.el.cardTitle.textContent = title;
    this.el.cardSub.textContent = sub;
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
