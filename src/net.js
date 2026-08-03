/**
 * net.js — finding an opponent, over the open internet.
 *
 * Both players connect outwards to a public MQTT broker and meet there, so no
 * one has to run or expose a server and the game can be a plain static site.
 * Outbound is the only direction that reliably works from a home network — the
 * whole reason this does not live in serve.mjs any more.
 *
 * Three ways in:
 *
 *   quick   shout into the lobby and pair with whoever shouts back
 *   host    advertise a lobby and wait for someone to knock
 *   join    knock on a specific lobby
 *
 * A lobby carries the course and the time of day, and the joiner adopts both.
 * That is not a detail: two players on different courses is not a match, and
 * the alternative — negotiating settings after pairing — is a protocol where
 * one dropped message leaves them on different holes.
 *
 * No account and no key. These are the public test brokers the MQTT projects
 * run themselves; they take anonymous connections by design.
 *
 * WHAT THAT COSTS, PLAINLY: a public broker is unauthenticated, so anyone who
 * knew a topic could read or write it. Match topics carry 128 bits of
 * randomness. Nothing personal crosses the wire — a display name you choose,
 * ball positions, and stroke counts.
 */

const LIB = 'https://esm.sh/mqtt@5.10.1/dist/mqtt.esm.js';

// Tried in order. Several, because one free endpoint having a bad day should
// not be the same thing as the game being broken.
const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const NS = 'sunnylinks/v3';
const LOBBY = `${NS}/lobby`;
const ADVERTISE_MS = 1500;
// A lobby that has not re-advertised within this is treated as gone. A small
// multiple of the advertise interval, so one dropped packet does not make a
// live lobby flicker out of the list.
const LOBBY_STALE_MS = 5200;
const BEAT_MS = 4000;
const SILENT_MS = 15000;

const rid = (n = 16) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export class Net {
  constructor() {
    this.id = null;
    this.state = 'idle';    // idle | connecting | browsing | waiting | matched | left | closed
    this.side = 0;
    this.opponent = null;
    this.matchId = null;
    this.mode = null;       // quick | host | join
    this.meta = null;       // course + time, from whoever hosted

    this.onState = null;
    this.onMessage = null;
    this.onLobbies = null;  // (array) whenever the visible lobby list changes

    this._client = null;
    this._advertise = null;
    this._beat = null;
    this._lastHeard = 0;
    this._name = 'Player';
    this._lobbies = new Map();
    this._sweep = null;
  }

  _set(state, detail) {
    this.state = state;
    this.onState?.(state, detail);
  }

  get _topic() { return this.matchId ? `${NS}/m/${this.matchId}` : null; }

  /**
   * Connect and start listening to the lobby. Deliberately does not join
   * anything — the menu wants to show a list before committing to a match.
   */
  async connect(name = 'Player') {
    if (this._client) this.close();
    this._name = name;
    this.id = rid(8);
    this._set('connecting');

    const { default: mqtt } = await import(LIB);

    let client = null;
    for (const url of BROKERS) {
      client = await new Promise((resolve) => {
        let settled = false;
        const c = mqtt.connect(url, {
          connectTimeout: 8000,
          reconnectPeriod: 0,     // failover is handled here, in order
          clean: true,
          clientId: 'sl_' + this.id,
        });
        const done = (v) => {
          if (settled) return;
          settled = true;
          if (!v) { try { c.end(true); } catch { /* already gone */ } }
          resolve(v);
        };
        c.on('connect', () => done(c));
        c.on('error', () => done(null));
        setTimeout(() => done(null), 9000);
      });
      if (client) break;
    }
    if (!client) { this._set('closed'); throw new Error('no broker reachable'); }

    this._client = client;
    client.on('message', (topic, payload) => this._incoming(topic, payload));
    client.on('close', () => { if (this.state !== 'idle') this._set('closed'); });
    await new Promise((r) => client.subscribe(LOBBY, { qos: 0 }, r));

    // Lobbies disappear by going quiet rather than by announcing it, because a
    // host who closes their laptop cannot announce anything.
    clearInterval(this._sweep);
    this._sweep = setInterval(() => this._sweepLobbies(), 1200);

    // Say "nothing here" once, up front. onLobbies otherwise only fires when
    // the list changes, so a genuinely empty lobby leaves whatever the menu
    // was showing while it connected sitting there for ever.
    this._emitLobbies();
    this._set('browsing');
    return this.id;
  }

  // ------------------------------------------------------------ ways in
  /** Pair with anyone else also looking, without a lobby. */
  quick(meta) {
    this.mode = 'quick';
    this.meta = meta ?? null;
    this._startAdvertising({ t: 'hello' });
    this._set('waiting');
  }

  /** Open a lobby others can see and join. `meta` is course + time. */
  host(meta) {
    this.mode = 'host';
    this.meta = meta;
    this._startAdvertising({ t: 'lobby', ...meta });
    this._set('waiting');
  }

  /** Knock on a specific lobby. The joiner proposes the match. */
  join(hostId) {
    const lobby = this._lobbies.get(hostId);
    if (!lobby || !this._client) return false;
    this.mode = 'join';
    this.meta = { course: lobby.course, time: lobby.time };
    this.matchId = rid(16);
    this.side = 1;
    this.opponent = lobby.name ?? 'Player';
    this._client.subscribe(this._topic, { qos: 0 }, () => {
      this._pub(LOBBY, { t: 'invite', id: this.id, to: hostId, match: this.matchId, name: this._name });
    });
    this._set('waiting');
    return true;
  }

  _startAdvertising(payload) {
    clearInterval(this._advertise);
    const shout = () => this._pub(LOBBY, { ...payload, id: this.id, name: this._name });
    shout();
    this._advertise = setInterval(shout, ADVERTISE_MS);
  }

  // ------------------------------------------------------------ lobbies
  _sweepLobbies() {
    const now = Date.now();
    let changed = false;
    for (const [id, l] of this._lobbies) {
      if (now - l.seen > LOBBY_STALE_MS) { this._lobbies.delete(id); changed = true; }
    }
    if (changed) this._emitLobbies();
  }

  _emitLobbies() {
    this.onLobbies?.([...this._lobbies.values()].map((l) => ({ ...l })));
  }

  _pub(topic, obj) {
    try { this._client?.publish(topic, JSON.stringify(obj), { qos: 0 }); } catch { /* closing */ }
  }

  _incoming(topic, payload) {
    let m;
    try { m = JSON.parse(payload.toString()); } catch { return; }
    if (!m || m.id === this.id) return;      // never react to our own shouting

    if (topic === LOBBY) {
      if (m.t === 'lobby') {
        const had = this._lobbies.has(m.id);
        this._lobbies.set(m.id, {
          id: m.id, name: m.name ?? 'Player',
          course: m.course, time: m.time, seen: Date.now(),
        });
        if (!had) this._emitLobbies();
        return;
      }
      if (this.matchId) return;              // already committed

      if (m.t === 'hello' && this.mode === 'quick') {
        // Both sides hear both hellos, so pairing is decided without any
        // conversation: the lower id proposes, the higher waits to be invited.
        if (this.id < m.id) {
          this.matchId = rid(16);
          this.side = 0;
          this.opponent = m.name ?? 'Player';
          this._client.subscribe(this._topic, { qos: 0 });
          this._pub(LOBBY, {
            t: 'invite', id: this.id, to: m.id, match: this.matchId,
            name: this._name, ...(this.meta ?? {}),
          });
        }
      } else if (m.t === 'invite' && m.to === this.id) {
        this.matchId = m.match;
        this.side = this.mode === 'host' ? 0 : 1;
        this.opponent = m.name ?? 'Player';
        // A quick-match invite carries the proposer's settings; a lobby invite
        // does not, because the lobby itself already published them.
        if (m.course) this.meta = { course: m.course, time: m.time };
        this._client.subscribe(this._topic, { qos: 0 }, () => {
          this._pub(this._topic, { t: 'accept', id: this.id, name: this._name, ...(this.meta ?? {}) });
          this._begin();
        });
      }
      return;
    }

    if (topic !== this._topic) return;

    if (m.t === 'accept') {
      this.opponent = m.name ?? this.opponent;
      if (m.course) this.meta = { course: m.course, time: m.time };
      this._begin();
      return;
    }

    this._lastHeard = Date.now();
    if (m.t === 'bye') this._dropOpponent();
    else if (m.t === 'game') this.onMessage?.(m.d);
  }

  _begin() {
    if (this.state === 'matched') return;
    clearInterval(this._advertise);
    this._advertise = null;
    this._lastHeard = Date.now();
    clearInterval(this._beat);
    this._beat = setInterval(() => {
      if (!this._topic) return;
      this._pub(this._topic, { t: 'beat', id: this.id });
      if (Date.now() - this._lastHeard > SILENT_MS) this._dropOpponent();
    }, BEAT_MS);
    this._set('matched', {
      matchId: this.matchId, side: this.side,
      opponent: this.opponent, meta: this.meta,
    });
  }

  /** The opponent is gone, tidily or otherwise. */
  _dropOpponent() {
    if (!this.matchId) return;
    clearInterval(this._beat);
    this._beat = null;
    if (this._topic) this._client?.unsubscribe(this._topic);
    this.matchId = null;
    this._set('left');
  }

  send(obj) {
    if (!this._topic) return;
    this._pub(this._topic, { t: 'game', id: this.id, d: obj });
  }

  close() {
    clearInterval(this._advertise);
    clearInterval(this._beat);
    clearInterval(this._sweep);
    this._advertise = this._beat = this._sweep = null;
    this._lobbies.clear();

    // Capture before clearing: the goodbye needs the topic and the id, and the
    // socket has to outlive both for as long as it takes to send.
    const client = this._client;
    const topic = this._topic;
    const id = this.id;

    this._client = null;
    this.matchId = null;
    this.opponent = null;
    this.id = null;
    this.mode = null;
    this._set('idle');
    if (!client) return;

    // end(true) discards whatever is still queued, which silently ate this
    // message. Closing from the publish callback was not enough either: for
    // QoS 0 that fires when the packet reaches the stream, not when it has
    // gone. A graceful end flushes; the timer is the backstop.
    if (topic) {
      try { client.publish(topic, JSON.stringify({ t: 'bye', id }), { qos: 0 }); } catch { /* closing */ }
      try { client.end(false); } catch { /* already gone */ }
      setTimeout(() => { try { client.end(true); } catch { /* already gone */ } }, 1500);
    } else {
      try { client.end(true); } catch { /* already gone */ }
    }
  }
}
