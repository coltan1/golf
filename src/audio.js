/**
 * audio.js — every sound is synthesised at runtime, so the game stays
 * asset-free and loads instantly.
 *
 * The brief is "gentle audio cues": a breeze bed you stop noticing after ten
 * seconds, occasional birdsong, and short soft cues for contact and the cup.
 * Nothing is loud, nothing is percussive, nothing repeats often enough to nag.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.started = false;
  }

  /** Must be called from a user gesture — browsers require it. */
  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.started = true;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(this.ctx.destination);

    this._buildBreeze();
    this._scheduleBird();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(on ? 1 : 0, this.ctx.currentTime + 0.4);
    }
  }

  // ------------------------------------------------------------ noise source
  _noiseBuffer(seconds = 2) {
    const n = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      // Brown-ish noise: softer and warmer than white.
      last = (last + Math.random() * 2 - 1) * 0.5;
      d[i] = last;
    }
    return buf;
  }

  /** A quiet, slowly breathing wind bed. */
  _buildBreeze() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(4);
    src.loop = true;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.5;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.045;

    // Two slow LFOs so the breeze never settles into an audible loop.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 190;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();

    const lfo2 = this.ctx.createOscillator();
    lfo2.frequency.value = 0.021;
    const lfo2Gain = this.ctx.createGain();
    lfo2Gain.gain.value = 0.022;
    lfo2.connect(lfo2Gain).connect(gain.gain);
    lfo2.start();

    src.connect(lp).connect(gain).connect(this.master);
    src.start();
  }

  // ------------------------------------------------------------ helpers
  _env(node, peak, attack, decay, t0) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _tone(freq, { type = 'sine', peak = 0.1, attack = 0.008, decay = 0.3, delay = 0, glide = null } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + attack + decay);
    const g = this.ctx.createGain();
    this._env(g, peak, attack, decay, t0);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.06);
  }

  _noise({ peak = 0.1, attack = 0.005, decay = 0.15, type = 'bandpass', f0 = 800, f1 = null, q = 1, delay = 0 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.6);
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t0);
    if (f1) filt.frequency.exponentialRampToValueAtTime(f1, t0 + attack + decay);
    const g = this.ctx.createGain();
    this._env(g, peak, attack, decay, t0);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + attack + decay + 0.05);
  }

  // ------------------------------------------------------------ cues
  /** Air moving past the club through the downswing. */
  whoosh(power = 1) {
    this._noise({ peak: 0.05 + power * 0.06, attack: 0.09, decay: 0.13, type: 'bandpass', f0: 380, f1: 1500, q: 0.9 });
  }

  /** The strike. A wooden thock with a soft body underneath it. */
  impact(power = 1) {
    this._noise({ peak: 0.12 + power * 0.1, attack: 0.002, decay: 0.055, type: 'bandpass', f0: 2100, q: 1.6 });
    this._tone(150 + power * 40, { type: 'sine', peak: 0.16 + power * 0.1, attack: 0.003, decay: 0.11, glide: 90 });
  }

  putt() {
    this._noise({ peak: 0.07, attack: 0.002, decay: 0.035, type: 'bandpass', f0: 1500, q: 2 });
    this._tone(230, { peak: 0.08, attack: 0.003, decay: 0.09, glide: 170 });
  }

  bounce(strength = 1) {
    this._tone(110, { peak: 0.03 + strength * 0.02, attack: 0.004, decay: 0.09, glide: 70 });
    this._noise({ peak: 0.02 + strength * 0.015, attack: 0.003, decay: 0.06, type: 'lowpass', f0: 700 });
  }

  splash() {
    this._noise({ peak: 0.16, attack: 0.01, decay: 0.45, type: 'lowpass', f0: 1400, f1: 240 });
    this._tone(420, { peak: 0.07, attack: 0.01, decay: 0.32, glide: 130 });
  }

  /** Ball dropping in: a little rattle, then a warm major chime. */
  holed() {
    this._noise({ peak: 0.07, attack: 0.002, decay: 0.12, type: 'bandpass', f0: 900, q: 3 });
    [[587.33, 0.06], [739.99, 0.18], [880.0, 0.30], [1174.7, 0.44]].forEach(([f, d], i) => {
      this._tone(f, { type: 'sine', peak: 0.11 - i * 0.012, attack: 0.02, decay: 1.5, delay: d });
    });
  }

  /** Soft confirmation when the ball comes to rest somewhere good. */
  land() {
    this._tone(520, { type: 'sine', peak: 0.045, attack: 0.02, decay: 0.35, glide: 660 });
  }

  // ------------------------------------------------------------ birds
  _scheduleBird() {
    const wait = 7000 + Math.random() * 12000;
    setTimeout(() => {
      if (this.ctx && this.enabled) this._bird();
      this._scheduleBird();
    }, wait);
  }

  _bird() {
    const n = 2 + Math.floor(Math.random() * 3);
    const base = 2100 + Math.random() * 1300;
    for (let i = 0; i < n; i++) {
      const f = base * (1 + (Math.random() - 0.5) * 0.25);
      this._tone(f, {
        type: 'sine',
        peak: 0.028,
        attack: 0.012,
        decay: 0.09 + Math.random() * 0.06,
        delay: i * (0.10 + Math.random() * 0.09),
        glide: f * (1.25 + Math.random() * 0.5),
      });
    }
  }
}
