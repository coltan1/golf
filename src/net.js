/**
 * net.js — the wire.
 *
 * One EventSource down, fetch POSTs up. That is the entire transport, and it is
 * deliberately the dumbest thing that works: a turn of golf sends a few dozen
 * bytes every several seconds, so there is nothing here worth a WebSocket
 * library, a build step, or a dependency.
 *
 * This module knows nothing about golf. It connects, queues for an opponent,
 * and hands whatever arrives to a callback. Everything about how a match is
 * played lives in match.js.
 */

export class Net {
  constructor() {
    this.id = null;
    this.es = null;
    this.state = 'idle';     // idle | connecting | waiting | matched | closed
    this.side = 0;
    this.opponent = null;

    // Callbacks, wired by match.js.
    this.onState = null;     // (state, detail)
    this.onMessage = null;   // (obj)
  }

  _set(state, detail) {
    this.state = state;
    this.onState?.(state, detail);
  }

  /** Open the stream and join the queue. Resolves once the server knows us. */
  connect(name = 'Player') {
    if (this.es) this.close();
    this._set('connecting');

    return new Promise((resolve, reject) => {
      const es = new EventSource(`/mp/events?name=${encodeURIComponent(name)}`);
      this.es = es;

      const fail = () => {
        // EventSource retries by itself, which is wrong here: if the relay is
        // not running we want to say so once rather than reconnect forever.
        if (this.state === 'connecting') { this.close(); reject(new Error('no relay')); }
        else this._set('closed');
      };

      es.addEventListener('hello', (e) => {
        this.id = JSON.parse(e.data).id;
        this._set('waiting');
        fetch(`/mp/queue?id=${this.id}`, { method: 'POST' }).catch(() => {});
        resolve(this.id);
      });
      es.addEventListener('matched', (e) => {
        const d = JSON.parse(e.data);
        this.side = d.side;
        this.opponent = d.opponent;
        this._set('matched', d);
      });
      es.addEventListener('msg', (e) => {
        let obj = null;
        try { obj = JSON.parse(e.data); } catch { return; }
        this.onMessage?.(obj);
      });
      es.addEventListener('left', () => this._set('left'));
      es.onerror = fail;
    });
  }

  /** Fire and forget. Ordering is guaranteed by the relay, not by us. */
  send(obj) {
    if (!this.id) return;
    fetch(`/mp/say?id=${this.id}`, {
      method: 'POST',
      body: JSON.stringify(obj),
    }).catch(() => {});
  }

  close() {
    if (this.id) navigator.sendBeacon?.(`/mp/leave?id=${this.id}`);
    this.es?.close();
    this.es = null;
    this.id = null;
    this.opponent = null;
    this._set('idle');
  }
}
