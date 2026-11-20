// Online layer: talks through several free public MQTT relays at the same time.
// Every message goes to every relay that's connected, duplicates are dropped.
// So if one relay is down or blocked on someone's wifi, the game keeps working.

export const DEFAULT_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const NS = 'kafish-ttt/v1/';

export class Relay {
  constructor(room, myId, { onState, onEvent, onStatus, onReady }) {
    this.room = room;
    this.myId = myId;
    this.base = NS + room;
    this.clients = [];
    this.seen = new Map();          // message id -> time, for de-duplication
    this.onState = onState;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onReady = onReady;         // fires once, ~2s after the first relay connects
    this.readyFired = false;
    this.getState = () => null;     // set by app — current state to push to late relays
    this.closed = false;
  }

  connect(brokers) {
    if (!window.mqtt) { this.onStatus(0, brokers.length); return; }
    brokers.forEach(url => {
      let client;
      try {
        client = window.mqtt.connect(url, {
          clientId: 'ttt_' + Math.random().toString(36).slice(2, 12),
          clean: true,
          keepalive: 30,
          reconnectPeriod: 3000,
          connectTimeout: 9000,
          resubscribe: false,
          will: { topic: this.base + '/evt', payload: JSON.stringify({ type: 'bye', from: this.myId, mid: 'bye-' + this.myId }), qos: 0, retain: false },
        });
      } catch (e) { console.warn('relay failed', url, e); return; }
      const entry = { url, client, up: false };
      this.clients.push(entry);

      client.on('connect', () => {
        entry.up = true;
        this._status();
        client.subscribe([this.base + '/state', this.base + '/evt'], { qos: 1 }, err => {
          if (err) return;
          // give retained state a moment to arrive, then make sure this relay has our latest
          setTimeout(() => {
            if (this.closed) return;
            const s = this.getState();
            if (s) this._pub(entry, this.base + '/state', s, true);
            if (!this.readyFired) { this.readyFired = true; this.onReady && this.onReady(); }
          }, 2000);
        });
      });
      const down = () => { if (entry.up) { entry.up = false; this._status(); } };
      client.on('close', down);
      client.on('offline', down);
      client.on('error', e => console.warn('relay error', url, e && e.message));
      client.on('message', (topic, buf) => this._msg(topic, buf));
    });
    this._status();
  }

  _status() { this.onStatus(this.clients.filter(c => c.up).length, this.clients.length); }

  _msg(topic, buf) {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (topic.endsWith('/state')) { this.onState(m); return; }
    if (m.from === this.myId) return;
    if (m.mid) {
      if (this.seen.has(m.mid)) return;
      this.seen.set(m.mid, Date.now());
      if (this.seen.size > 500) {
        const cut = Date.now() - 60000;
        for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k);
      }
    }
    this.onEvent(m);
  }

  _pub(entry, topic, obj, retain) {
    if (!entry.up) return;
    try { entry.client.publish(topic, JSON.stringify(obj), { qos: 1, retain }); } catch (e) { console.warn(e); }
  }

  publishState(state) {
    this.clients.forEach(e => this._pub(e, this.base + '/state', state, true));
  }

  send(type, data = {}) {
    const m = { ...data, type, from: this.myId, mid: Math.random().toString(36).slice(2) + Date.now().toString(36) };
    this.clients.forEach(e => {
      if (!e.up) return;
      try { e.client.publish(this.base + '/evt', JSON.stringify(m), { qos: 0, retain: false }); } catch {}
    });
  }

  get connected() { return this.clients.some(c => c.up); }

  close() {
    this.closed = true;
    try { this.send('bye'); } catch {}
    this.clients.forEach(e => { try { e.client.end(false); } catch {} });
    this.clients = [];
  }
}
