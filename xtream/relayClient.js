/**
 * The main process's side of the stream relay (xtream/relay.js): starts the relay process, registers play
 * sessions with it, and keeps what it reports, namely which provider connections it holds and how each stream
 * did. That record orders a channel's streams: ones that started fast and kept playing go first, ones that
 * just failed go last, and a provider that keeps turning the server away is handed to the TV directly instead.
 */
const path = require("path");
const { fork } = require("child_process");
const { newSessionId } = require("./relay");

const RECENT_FAIL_MS = 2 * 60 * 1000;
const REFUSALS_TO_REDIRECT = 3;
const REDIRECT_ONLY_MS = 30 * 60 * 1000;
const HALF_LIFE_MS = 6 * 3600 * 1000;
const PLAYED_OK_MS = 60 * 1000;
const RESPAWN_MS = 2000;

/** Success and failure counts that halve every HALF_LIFE_MS, so a stream's record follows how it does now. */
class Tally {
  constructor() {
    this.ok = 0;
    this.bad = 0;
    this.at = 0;
  }

  decay(t) {
    if (this.at) {
      const f = Math.pow(0.5, (t - this.at) / HALF_LIFE_MS);
      this.ok *= f;
      this.bad *= f;
    }
    this.at = t;
  }

  add(t, ok, weight = 1) {
    this.decay(t);
    if (ok) this.ok += weight;
    else this.bad += weight;
  }

  /** Share of good outcomes, pulled toward [prior] while there are few. */
  rate(t, prior = 0.5) {
    this.decay(t);
    return (this.ok + 2 * prior) / (this.ok + this.bad + 2);
  }

  samples() {
    return this.ok + this.bad;
  }
}

class SourceRecord {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.byKey = new Map();
    this.byPid = new Map();
    this.failedAt = new Map();
    this.refusals = new Map();
    this.redirectUntil = new Map();
    this.current = new Map();
  }

  tally(map, k) {
    let t = map.get(k);
    if (!t) map.set(k, (t = new Tally()));
    return t;
  }

  /** One outcome the relay reported for a stream. */
  record(o) {
    const t = this.now();
    if (o.ok && o.started) {
      this.tally(this.byKey, o.key).add(t, true);
      this.tally(this.byPid, o.pid).add(t, true);
      this.failedAt.delete(o.key);
      this.refusals.delete(o.pid);
      this.redirectUntil.delete(o.pid);
      if (o.user && o.streamId != null) this.current.set(`${o.user}/${o.streamId}`, o.key);
      return;
    }
    if (o.ok) return;
    // A stream that played a good while before dropping still counts as having worked.
    const played = Number(o.playedMs) || 0;
    if (played >= PLAYED_OK_MS) return;
    this.tally(this.byKey, o.key).add(t, false);
    this.tally(this.byPid, o.pid).add(t, false);
    this.failedAt.set(o.key, t);
    if (o.refused) {
      const n = (this.refusals.get(o.pid) || 0) + 1;
      this.refusals.set(o.pid, n);
      if (n >= REFUSALS_TO_REDIRECT) this.redirectUntil.set(o.pid, t + REDIRECT_ONLY_MS);
    }
  }

  recentlyFailed(key) {
    const at = this.failedAt.get(key);
    return at !== undefined && this.now() - at < RECENT_FAIL_MS;
  }

  /** The provider refused the server REFUSALS_TO_REDIRECT times in a row: TVs go to it directly for a while. */
  redirectOnly(pid) {
    const until = this.redirectUntil.get(pid);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.redirectUntil.delete(pid);
    this.refusals.set(pid, REFUSALS_TO_REDIRECT - 1);
    return false;
  }

  /** How likely [member] is to play: its own record once it has a few outcomes, else its provider's. */
  score(m, key) {
    const t = this.now();
    const provider = this.tally(this.byPid, m._pid).rate(t);
    const own = this.byKey.get(key);
    if (!own || own.samples() < 2) return provider;
    return own.rate(t, provider);
  }

  /**
   * [members] best first: streams that didn't just fail, then by score, with the pool's own order (provider
   * order, then quality) breaking ties. [isFull] puts streams on a full account after the rest.
   */
  order(members, keyOf, isFull = () => false) {
    const rows = members.map((m, i) => {
      const key = keyOf(m);
      return { m, i, key, failed: this.recentlyFailed(key), full: isFull(m._pid), score: this.score(m, key) };
    });
    rows.sort((a, b) => a.failed - b.failed || a.full - b.full || b.score - a.score || a.i - b.i);
    return rows.map((r) => r.m);
  }

  currentFor(user, streamId) {
    return this.current.get(`${user}/${streamId}`) || null;
  }
}

/** Starts the relay process and restarts it if it exits. */
class RelayClient {
  constructor({ port, users = "*", log = console, now = Date.now, forkImpl = fork } = {}) {
    this.port = port;
    this.users = users === "*" ? null : new Set(String(users).split(",").map((s) => s.trim()).filter(Boolean));
    this.log = log;
    this.record = new SourceRecord({ now });
    this.heldByPid = new Map();
    this.forkImpl = forkImpl;
    this.child = null;
    this.stopped = false;
  }

  start() {
    const child = this.forkImpl(path.join(__dirname, "relay.js"), [], { env: { ...process.env, RELAY_PORT: String(this.port) }, stdio: "inherit" });
    this.child = child;
    child.on("message", (msg) => this.onMessage(msg));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.heldByPid.clear();
      if (this.stopped) return;
      this.log.error(`[RELAY] Process exited (${signal || code}); restarting`);
      setTimeout(() => this.start(), RESPAWN_MS).unref();
    });
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
  }

  onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "held") this.heldByPid = new Map(Object.entries(msg.byPid || {}));
    else if (msg.type === "outcome") this.record.record(msg);
  }

  /** Whether [username]'s live streams go through the relay. */
  enabledFor(username) {
    return !!this.child && this.child.connected && (!this.users || this.users.has(username));
  }

  held(pid) {
    return this.heldByPid.get(pid) || 0;
  }

  /** Registers a play session and returns its id; the TV then fetches /relay/<id>.ts. */
  open(session) {
    const id = newSessionId();
    this.child.send({ type: "open", id, ...session });
    return id;
  }
}

module.exports = { RelayClient, SourceRecord, Tally };
