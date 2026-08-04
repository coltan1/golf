/**
 * audio.js — every sound is synthesised at runtime, so the game stays
 * asset-free and loads instantly.
 *
 * The brief is close, soft, tactile: the sort of golf audio you would get from
 * a microphone a foot from the ball rather than from a broadcast booth. That
 * changes the design in three specific ways.
 *
 *   Detail over impact. What makes a struck golf ball satisfying is not the
 *   thump, it is the 4 kHz tick of the face meeting the cover, and the tiny
 *   scuff of turf a moment later. Every cue here is layered so those live on
 *   their own envelopes instead of being buried under a bass drum.
 *
 *   Space. Dry one-shots sound like samples; a short soft reverb puts them
 *   somewhere. The impulse is generated rather than loaded — a cluster of early
 *   reflections and a fast dark tail, which is roughly what an open field
 *   ringed with trees does to a small sound.
 *
 *   Width. Each one-shot is panned slightly and randomly. Nothing sits dead
 *   centre, which is most of the difference between "in your head" and "in
 *   front of you".
 *
 * Nothing is loud, nothing is percussive, nothing repeats often enough to nag.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

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

    // master → gentle compressor → out. The compressor is not for loudness; it
    // is there so that two cues landing together can never produce an edge,
    // which at this listening distance would be the one unpleasant thing.
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;

    const comp = this.ctx.createDynamicsCompressor();
    // High enough that it only ever catches a genuine collision of cues. Set
    // lower it was compressing the transients that make the strike a strike.
    comp.threshold.value = -8;
    comp.knee.value = 20;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.008;
    comp.release.value = 0.28;

    this.master.connect(comp).connect(this.ctx.destination);

    // Everything one-shot goes through `bus`, which feeds dry and reverb.
    //
    // The gain here is not arbitrary. Rendered offline and measured, the cues
    // were sitting on top of an ambience bed that peaked at 0.034 while a
    // full-power strike reached 0.069 and a whoosh reached 0.034 — identical to
    // the bed, which is another way of saying inaudible. The whole mix was also
    // peaking around -23 dBFS and throwing away the headroom. This lifts the
    // one-shots without touching the bed, which connects to master directly.
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 2.6;
    this.bus.connect(this.master);

    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0.34;
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.15);
    this.bus.connect(this.reverb).connect(this.wet).connect(this.master);

    this._cacheNoise();
    this._buildBreeze();
    this._buildLeaves();
    this._scheduleBird();
    this._scheduleInsects();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(on ? 1 : 0, this.ctx.currentTime + 0.4);
    }
  }

  // ------------------------------------------------------------ noise sources
  /**
   * Three noise colours, generated once and shared.
   *
   * Every one-shot used to allocate its own buffer, which for layered cues
   * means several hundred thousand samples of Math.random per swing. These are
   * made once and played from a random offset, which is indistinguishable and
   * free.
   *
   * The colours matter: brown for body and wind, pink for turf and cloth, white
   * for the bright tick of contact. Using one for all three is most of why
   * synthesised audio ends up sounding like a kazoo.
   */
  _cacheNoise() {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * 3);
    const mk = (fill) => {
      const buf = this.ctx.createBuffer(1, n, sr);
      fill(buf.getChannelData(0));
      return buf;
    };
    this.noise = {
      white: mk((d) => { for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }),
      brown: mk((d) => {
        let last = 0;
        for (let i = 0; i < n; i++) { last = (last + Math.random() * 2 - 1) * 0.5; d[i] = last; }
      }),
      pink: mk((d) => {
        // Voss-McCartney, cheap and close enough.
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < n; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99765 * b0 + w * 0.0990460;
          b1 = 0.96300 * b1 + w * 0.2965164;
          b2 = 0.57000 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
        }
      }),
    };
  }

  /**
   * A generated impulse response: a few early reflections, then a dark tail.
   *
   * Two channels built independently so the reverb is genuinely stereo rather
   * than a mono tail heard from both sides.
   */
  _impulse(seconds) {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // Exponential decay, steep — a field, not a hall.
        const env = Math.pow(1 - t, 3.2);
        // Lowpass the tail as it decays, the way air and grass absorb the top.
        lp += ((Math.random() * 2 - 1) - lp) * 0.34;
        d[i] = lp * env;
      }
      // A handful of discrete early reflections gives it somewhere to be.
      for (const [ms, amp] of [[11, 0.5], [19, 0.36], [31, 0.26], [47, 0.17]]) {
        const k = Math.floor(sr * (ms + Math.random() * 4) / 1000);
        if (k < n) d[k] += amp * (c ? -1 : 1);
      }
    }
    return buf;
  }

  // ------------------------------------------------------------ helpers
  _env(node, peak, attack, decay, t0) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  /**
   * Placement. `at` pins a sound to an exact position; otherwise it lands
   * randomly within `spread`. Both matter: one-shots want to scatter, but a
   * bird's four notes have to come from the same tree.
   */
  _pan(spread = 0.35, at = null) {
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) p.pan.value = at !== null ? at : (Math.random() * 2 - 1) * spread;
    return p;
  }

  _out(node, spread, at = null) {
    const p = this._pan(spread, at);
    if (p) node.connect(p).connect(this.bus);
    else node.connect(this.bus);
  }

  _tone(freq, { type = 'sine', peak = 0.1, attack = 0.008, decay = 0.3, delay = 0,
                glide = null, pan = 0.3, panAt = null } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + attack + decay);
    const g = this.ctx.createGain();
    this._env(g, peak, attack, decay, t0);
    osc.connect(g);
    this._out(g, pan, panAt);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.06);
  }

  _noise({ colour = 'brown', peak = 0.1, attack = 0.005, decay = 0.15, type = 'bandpass',
           f0 = 800, f1 = null, q = 1, delay = 0, pan = 0.3, panAt = null } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise[colour] ?? this.noise.brown;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t0);
    if (f1) filt.frequency.exponentialRampToValueAtTime(f1, t0 + attack + decay);
    const g = this.ctx.createGain();
    this._env(g, peak, attack, decay, t0);
    src.connect(filt).connect(g);
    this._out(g, pan, panAt);
    // Random offset, so a repeated cue never plays the identical noise.
    src.start(t0, Math.random() * 2.4);
    src.stop(t0 + attack + decay + 0.05);
  }

  // ------------------------------------------------------------ ambience
  /** A quiet, slowly breathing wind bed. */
  _buildBreeze() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise.brown;
    src.loop = true;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.5;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.026;

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
    lfo2Gain.gain.value = 0.013;
    lfo2.connect(lfo2Gain).connect(gain.gain);
    lfo2.start();

    src.connect(lp).connect(gain).connect(this.master);
    src.start();
  }

  /**
   * Leaves, on its own layer well above the wind.
   *
   * The breeze alone is all body and no texture — it reads as a rumble. The
   * fine top end is what the ear hears as *outdoors*, and it has to breathe on
   * a different clock from the low bed or the two fuse into one sound.
   */
  _buildLeaves() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise.pink;
    src.loop = true;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 0.7;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.0095;

    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.037;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.0075;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();

    const pan = this._pan(0.5);
    if (pan) src.connect(bp).connect(gain).connect(pan).connect(this.master);
    else src.connect(bp).connect(gain).connect(this.master);
    src.start();
  }

  // ------------------------------------------------------------ cues
  /**
   * Air moving past the club on the way down. Fires *before* contact, so it
   * has somewhere to lead to.
   */
  // ---------------------------------------------------------------- engine
  /**
   * The cart's motor, as one sustained voice rather than a stream of one-shots.
   *
   * Everything else in here is a hit — a strike, a splash, a footfall — and the
   * shape of this file is built around firing and forgetting. A motor is the
   * opposite: it starts, it runs, and its pitch is a continuous function of
   * something the game already knows. So it gets its own three nodes, held for
   * as long as the drive lasts, and `engineDrive` moves them.
   *
   * Two saws a few cents apart through a low filter. One saw is a test tone;
   * the beating between two is what makes it a machine.
   */
  engineOn() {
    if (!this.ctx || this._eng) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.7;
    const a = this.ctx.createOscillator();
    const b = this.ctx.createOscillator();
    a.type = b.type = 'sawtooth';
    a.frequency.value = 46;
    b.frequency.value = 46 * 1.007;
    a.connect(lp); b.connect(lp);
    lp.connect(g).connect(this.master);
    a.start(t); b.start(t);
    this._eng = { a, b, g, lp };
  }

  /** `v` is 0..1 of top speed; `boost` widens the filter and lifts the pitch. */
  engineDrive(v = 0, boost = false) {
    if (!this._eng) return;
    const t = this.ctx.currentTime;
    const { a, b, g, lp } = this._eng;
    // Idle is audible, so the cart is never silent while you are sitting in it.
    const hz = 44 + v * 78 + (boost ? 16 : 0);
    a.frequency.setTargetAtTime(hz, t, 0.08);
    b.frequency.setTargetAtTime(hz * 1.007, t, 0.08);
    lp.frequency.setTargetAtTime(380 + v * 900 + (boost ? 420 : 0), t, 0.10);
    g.gain.setTargetAtTime(0.028 + v * 0.045, t, 0.10);
  }

  engineOff() {
    if (!this._eng) return;
    const { a, b, g } = this._eng;
    const t = this.ctx.currentTime;
    // Faded rather than cut. Stopping an oscillator at full gain is a click,
    // and a click at the end of every drive is the loudest thing in the game.
    g.gain.setTargetAtTime(0, t, 0.12);
    a.stop(t + 0.6); b.stop(t + 0.6);
    this._eng = null;
  }

  whoosh(power = 1) {
    const p = clamp01(power);
    this._noise({ colour: 'brown', peak: 0.035 + p * 0.05, attack: 0.10, decay: 0.16,
      type: 'bandpass', f0: 320, f1: 1400 + p * 700, q: 0.85, pan: 0.4 });
    // A thin top layer that tracks the same sweep — the hiss of the shaft.
    this._noise({ colour: 'pink', peak: 0.012 + p * 0.02, attack: 0.11, decay: 0.14,
      type: 'highpass', f0: 1800, f1: 4200, q: 0.6, pan: 0.4 });
  }

  /**
   * The strike: four layers on four envelopes.
   *
   * The tick is the important one and it is only six milliseconds long. Take it
   * out and the shot sounds like a thud in a box; leave it and the ball sounds
   * struck, however quiet everything under it is.
   */
  impact(power = 1) {
    const p = clamp01(power);
    // 1. contact tick — bright, immediate, tiny
    this._noise({ colour: 'white', peak: 0.10 + p * 0.10, attack: 0.0012, decay: 0.006,
      type: 'highpass', f0: 4200, q: 0.7, pan: 0.22 });
    // 2. the face — a woody band that gives the club its material
    this._noise({ colour: 'pink', peak: 0.07 + p * 0.08, attack: 0.002, decay: 0.05,
      type: 'bandpass', f0: 1900, q: 2.2, pan: 0.22 });
    // 3. body — felt more than heard
    this._tone(148 + p * 44, { type: 'sine', peak: 0.11 + p * 0.09, attack: 0.004,
      decay: 0.13, glide: 88, pan: 0.15 });
    // 4. turf, a breath later, as the club takes its divot
    this._noise({ colour: 'pink', peak: 0.02 + p * 0.05, attack: 0.012, decay: 0.16,
      type: 'bandpass', f0: 1500, f1: 500, q: 0.8, delay: 0.028, pan: 0.4 });
  }

  /**
   * The putt — the one everybody knows. A hollow pock with almost no bass and
   * a lot of very short high detail.
   */
  putt(power = 0.5) {
    const p = clamp01(power);
    this._noise({ colour: 'white', peak: 0.07 + p * 0.05, attack: 0.001, decay: 0.005,
      type: 'highpass', f0: 3800, q: 0.7, pan: 0.2 });
    this._tone(300 + p * 60, { type: 'sine', peak: 0.07 + p * 0.05, attack: 0.002,
      decay: 0.075, glide: 210, pan: 0.2 });
    this._tone(760, { type: 'sine', peak: 0.030, attack: 0.002, decay: 0.045, pan: 0.3 });
  }

  /** Club brushing grass on the way through — soft, wide, no pitch at all. */
  brush(strength = 1) {
    const s = clamp01(strength);
    this._noise({ colour: 'pink', peak: 0.048 + s * 0.065, attack: 0.02, decay: 0.20,
      type: 'bandpass', f0: 2000, f1: 700, q: 0.7, pan: 0.45 });
  }

  /** Out of sand: duller, longer, grainier than turf. */
  sand(power = 1) {
    const p = clamp01(power);
    this._noise({ colour: 'pink', peak: 0.09 + p * 0.07, attack: 0.006, decay: 0.30,
      type: 'lowpass', f0: 2600, f1: 900, q: 0.6, pan: 0.3 });
    this._tone(120, { type: 'sine', peak: 0.05, attack: 0.006, decay: 0.10, glide: 76, pan: 0.2 });
  }

  bounce(strength = 1) {
    const s = clamp01(strength);
    this._tone(112, { peak: 0.026 + s * 0.02, attack: 0.004, decay: 0.09, glide: 70, pan: 0.35 });
    this._noise({ colour: 'pink', peak: 0.016 + s * 0.018, attack: 0.003, decay: 0.07,
      type: 'lowpass', f0: 900, pan: 0.35 });
  }

  splash() {
    this._noise({ colour: 'brown', peak: 0.14, attack: 0.010, decay: 0.42,
      type: 'lowpass', f0: 1400, f1: 240, pan: 0.3 });
    this._tone(430, { peak: 0.06, attack: 0.010, decay: 0.30, glide: 130, pan: 0.3 });
    // Droplets after, at falling pitch — the part that sells water.
    for (let i = 0; i < 4; i++) {
      this._tone(900 + Math.random() * 900, {
        type: 'sine', peak: 0.020, attack: 0.002, decay: 0.05,
        delay: 0.13 + i * (0.05 + Math.random() * 0.06),
        glide: 420, pan: 0.6,
      });
    }
  }

  /**
   * Holing out: the rattle first, then the chime.
   *
   * The rattle is the whole point. A ball dropping into a cup bounces off the
   * liner two or three times in about a fifth of a second, accelerating and
   * getting quieter, and that little burst is what everyone recognises. The
   * chime is the reward; the rattle is the sound.
   */
  holed() {
    let t = 0;
    for (let i = 0; i < 4; i++) {
      this._noise({ colour: 'white', peak: 0.075 - i * 0.014, attack: 0.001,
        decay: 0.020 + i * 0.006, type: 'bandpass', f0: 2400 - i * 260, q: 5,
        delay: t, pan: 0.25 });
      this._tone(520 - i * 60, { type: 'sine', peak: 0.035 - i * 0.007, attack: 0.002,
        decay: 0.05, delay: t, pan: 0.25 });
      t += 0.075 - i * 0.013;   // accelerating, the way a settling ball does
    }
    [[587.33, 0.26], [739.99, 0.38], [880.0, 0.50], [1174.7, 0.64]].forEach(([f, d], i) => {
      this._tone(f, { type: 'sine', peak: 0.10 - i * 0.011, attack: 0.025, decay: 1.6,
        delay: d, pan: 0.2 });
    });
  }

  /** Soft confirmation when the ball comes to rest somewhere good. */
  land() {
    this._tone(520, { type: 'sine', peak: 0.040, attack: 0.02, decay: 0.35, glide: 660, pan: 0.3 });
    this._noise({ colour: 'pink', peak: 0.014, attack: 0.008, decay: 0.10,
      type: 'bandpass', f0: 1700, f1: 800, q: 0.9, pan: 0.4 });
  }

  /**
   * Pushing a tee into the ground. Two short scuffs and a soft stop.
   *
   * The levels look wildly out of line with the other cues and are not: `peak`
   * is a gain applied to the noise *source*, not an output level, and pink
   * noise through a narrow bandpass is a small fraction of full scale before
   * that gain ever reaches it. Cues with a tone underneath get their amplitude
   * from the oscillator; noise-only cues like this one have to ask for several
   * times as much to land in the same place. Measured, not guessed.
   */
  tee() {
    this._noise({ colour: 'pink', peak: 0.155, attack: 0.004, decay: 0.055,
      type: 'bandpass', f0: 1200, f1: 600, q: 0.9, pan: 0.3 });
    this._noise({ colour: 'pink', peak: 0.115, attack: 0.004, decay: 0.045,
      type: 'bandpass', f0: 900, f1: 420, q: 0.9, delay: 0.075, pan: 0.3 });
  }

  /** A footstep on turf. `firm` shifts it from soft rough to tight fairway. */
  step(firm = 0.5) {
    const f = clamp01(firm);
    this._noise({ colour: 'pink', peak: 0.085 + f * 0.045, attack: 0.004,
      decay: 0.075 + (1 - f) * 0.06, type: 'bandpass',
      f0: 900 + f * 900, f1: 380, q: 0.8, pan: 0.5 });
    this._tone(88, { type: 'sine', peak: 0.055, attack: 0.005, decay: 0.06, glide: 62, pan: 0.4 });
  }

  // ------------------------------------------------------------ wildlife
  _scheduleBird() {
    const wait = 6500 + Math.random() * 11000;
    setTimeout(() => {
      if (this.ctx && this.enabled) this._bird();
      this._scheduleBird();
    }, wait);
  }

  /**
   * Three rough species rather than one shape with jitter — a repeated call
   * with random parameters still reads as one bird with a stutter, where a few
   * distinct shapes read as a wood with things living in it.
   */
  _bird() {
    const kind = Math.floor(Math.random() * 3);
    const pan = (Math.random() * 2 - 1) * 0.7;
    const at = (f, o) => this._tone(f, { type: 'sine', ...o, panAt: pan });

    if (kind === 0) {
      // Rising two-note whistle.
      const base = 2300 + Math.random() * 900;
      at(base, { peak: 0.026, attack: 0.014, decay: 0.13, glide: base * 1.5 });
      at(base * 1.18, { peak: 0.022, attack: 0.014, decay: 0.16, delay: 0.17, glide: base * 1.9 });
    } else if (kind === 1) {
      // Quick chatter, four or five descending chips.
      const n = 4 + Math.floor(Math.random() * 2);
      const base = 3100 + Math.random() * 700;
      for (let i = 0; i < n; i++) {
        at(base - i * 130, { peak: 0.019, attack: 0.006, decay: 0.05, delay: i * 0.072,
          glide: base - i * 130 - 240 });
      }
    } else {
      // A single long fluting note, further off.
      const base = 1500 + Math.random() * 500;
      at(base, { peak: 0.016, attack: 0.05, decay: 0.42, glide: base * 1.12 });
    }
  }

  /** Distant insects, very quiet, only sometimes. */
  _scheduleInsects() {
    const wait = 14000 + Math.random() * 22000;
    setTimeout(() => {
      if (this.ctx && this.enabled) this._insects();
      this._scheduleInsects();
    }, wait);
  }

  _insects() {
    const n = 6 + Math.floor(Math.random() * 6);
    const f = 5200 + Math.random() * 1400;
    for (let i = 0; i < n; i++) {
      this._noise({ colour: 'white', peak: 0.006, attack: 0.002, decay: 0.018,
        type: 'bandpass', f0: f, q: 12, delay: i * 0.055, pan: 0.8 });
    }
  }
}
