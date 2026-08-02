/**
 * net.js — finding an opponent, over the open internet.
 *
 * This used to talk to a relay inside serve.mjs, which meant a match could only
 * happen between machines that could reach *your* computer. That turned out to
 * be the whole problem: on the router here, other devices on the same wifi
 * cannot reach it at all, and nothing on the machine can change that.
 *
 * So the matchmaking no longer involves your machine. Both players connect out
 * to a public MQTT broker — outbound, which every network allows — and find
 * each other there. The consequence that matters: the game is now a plain
 * static site. Put index.html and src/ on any static host and online play works,
 * with no server to run, keep alive, or expose.
 *
 * No account and no key. These brokers are the public test endpoints the MQTT
 * projects themselves run, and they take anonymous connections by design.
 *
 * WHAT THAT COSTS, PLAINLY: a public broker is unauthenticated, so anyone who
 * knew a topic could read or write it. Match topics are named with 128 bits of
 * randomness, which is not a secret worth attacking for a golf score, but it is
 * worth knowing rather than discovering. Nothing personal crosses the wire —
 * a display name, ball positions and stroke counts.
 */

const LIB = 'https://esm.sh/mqtt@5.10.1/dist/mqtt.esm.js';

// Tried in order. Two of them, because a single free endpoint having a bad day
// should not be the same thing as the game being broken.
const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const NS = 'sunnylinks/v2';
const LOBBY = `${NS}/lobby`;
const ADVERTISE_MS = 1500;
// Once matched, say something every few seconds even when nothing is happening.
// A goodbye only covers a tidy exit; a closed laptop, a dead battery or a lost
// signal never sends one, and without this the other player waits forever.
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
    this.state = 'idle';     // idle | connecting | waiting | matched | left | closed
    this.side = 0;
    this.opponent = null;
    this.matchId = null;

    this.onState = null;
    this.onMessage = null;

    this._client = null;
    this._advertise = null;
    this._beat = null;
    this._lastHeard = 0;
    this._name = 'Player';
  }

  _set(state, detail) {
    this.state = state;
    this.onState?.(state, detail);
  }

  get _topic() { return this.matchId ? `${NS}/m/${this.matchId}` : null; }

  /** Connect to a broker and start looking. Resolves once we are searching. */
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
          reconnectPeriod: 0,        // we handle failover ourselves, in order
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

    if (!client) {
      this._set('closed');
      throw new Error('no broker reachable');
    }

    this._client = client;
    client.on('message', (topic, payload) => this._incoming(topic, payload));
    client.on('close', () => { if (this.state !== 'idle') this._set('closed'); });

    await new Promise((r) => client.subscribe(LOBBY, { qos: 0 }, r));
    this._set('waiting');

    // Say we are here, repeatedly. Whoever is already waiting will hear it, and
    // anyone who arrives later will hear the next one — which removes any need
    // for the broker to retain state about who is looking.
    const shout = () => this._pub(LOBBY, { t: 'hello', id: this.id, name: this._name });
    shout();
    this._advertise = setInterval(shout, ADVERTISE_MS);
    return this.id;
  }

  _pub(topic, obj) {
    try { this._client?.publish(topic, JSON.stringify(obj), { qos: 0 }); } catch { /* closing */ }
  }

  _incoming(topic, payload) {
    let m;
    try { m = JSON.parse(payload.toString()); } catch { return; }
    if (!m || m.id === this.id) return;          // never react to our own shouting

    if (topic === LOBBY && !this.matchId) {
      if (m.t === 'hello') {
        // Both sides see both hellos, so the pairing has to be decided without
        // any conversation: the lower id proposes, the higher waits to be
        // invited. Comparing ids is the cheapest possible tiebreak that both
        // ends compute identically.
        if (this.id < m.id) {
          this.matchId = rid(16);
          this.side = 0;
          this.opponent = m.name ?? 'Player';
          this._client.subscribe(this._topic, { qos: 0 });
          this._pub(LOBBY, { t: 'invite', id: this.id, to: m.id, match: this.matchId, name: this._name });
        }
      } else if (m.t === 'invite' && m.to === this.id) {
        this.matchId = m.match;
        this.side = 1;
        this.opponent = m.name ?? 'Player';
        this._client.subscribe(this._topic, { qos: 0 }, () => {
          this._pub(this._topic, { t: 'accept', id: this.id, name: this._name });
          this._begin();
        });
      }
      return;
    }

    if (topic !== this._topic) return;

    if (m.t === 'accept') {
      this.opponent = m.name ?? this.opponent;
      this._begin();
      return;
    }

    // Anything at all from the opponent counts as a sign of life.
    this._lastHeard = Date.now();

    if (m.t === 'bye') {
      this._dropOpponent();
    } else if (m.t === 'game') {
      this.onMessage?.(m.d);
    }
  }

  _begin() {
    if (this.state === 'matched') return;
    clearInterval(this._advertise);
    this._advertise = null;
    this._client?.unsubscribe(LOBBY);
    this._lastHeard = Date.now();
    clearInterval(this._beat);
    this._beat = setInterval(() => {
      if (!this._topic) return;
      this._pub(this._topic, { t: 'beat', id: this.id });
      if (Date.now() - this._lastHeard > SILENT_MS) this._dropOpponent();
    }, BEAT_MS);
    this._set('matched', { matchId: this.matchId, side: this.side, opponent: this.opponent });
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

  /** Game traffic. Wrapped so lobby chatter and play cannot be confused. */
  send(obj) {
    if (!this._topic) return;
    this._pub(this._topic, { t: 'game', id: this.id, d: obj });
  }

  close() {
    clearInterval(this._advertise);
    clearInterval(this._beat);
    this._advertise = this._beat = null;

    // Capture before clearing: the goodbye needs the topic and the id, and the
    // socket has to outlive them both for as long as it takes to send.
    const client = this._client;
    const topic = this._topic;
    const id = this.id;

    this._client = null;
    this.matchId = null;
    this.opponent = null;
    this.id = null;
    this._set('idle');
    if (!client) return;

    // Give the goodbye time to actually leave.
    //
    // end(true) discards whatever is still queued, which silently ate this
    // message. Closing from the publish callback was not enough either: for
    // QoS 0 that callback fires when the packet is handed to the stream, not
    // when it has gone, so the socket still shut underneath it. A graceful end
    // flushes, and the timer is there in case the broker never acknowledges.
    if (topic) {
      try { client.publish(topic, JSON.stringify({ t: 'bye', id }), { qos: 0 }); } catch { /* closing */ }
      try { client.end(false); } catch { /* already gone */ }
      setTimeout(() => { try { client.end(true); } catch { /* already gone */ } }, 1500);
    } else {
      try { client.end(true); } catch { /* already gone */ }
    }
  }
}
