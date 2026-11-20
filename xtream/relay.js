/**
 * The stream relay: a separate process that plays live MPEG-TS for the TVs, so the pool sees whether a stream
 * really plays and the TV never has to hunt for a working source.
 *
 * The main process picks a channel's candidate streams and registers them here as a session (an IPC "open"
 * message), then redirects the TV to /relay/<session id>.ts. On that request the relay races the first
 * candidates, keeps the first one that sends video, and if it stalls or drops mid-show, it moves to the next
 * candidate on the same connection to the TV. Two TVs on the same channel share one provider connection.
 * When no candidate plays from the server but some refused it (a provider that blocks the server's IP), the
 * TV is redirected to the first refused one, as before the relay.
 *
 * It runs in its own process because the main process can block its event loop for seconds while it rebuilds
 * channel views, which would stall every stream.
 */
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { TsNormalizer } = require("./tsNormalizer");

const TS_PACKET = 188;
const TS_SYNC = 0x47;
const SESSION_UNUSED_MS = 60 * 1000;
const SESSION_REATTACH_MS = 60 * 1000;
const SESSION_WAIT_MS = 2000;
// A channel with no viewers keeps its provider connection this long, for a player's quick reconnect.
const IDLE_GRACE_MS = 3000;
const RACE_WIDTH = 2;
const START_BUDGET_MS = 10 * 1000;
const CONNECT_TIMEOUT_MS = 5000;
const START_BYTES = 32 * 1024;
// A stream is lost once the video it has sent falls BEHIND_MAX_S behind real time, measured from its first
// output (the TV's buffer is running dry); without a clock, after STALL_MS with no data. Some providers send a few
// seconds of video at once every several seconds, so a quiet spell alone isn't a stall, up to STALL_MAX_MS.
const STALL_MS = 8000;
const STALL_MAX_MS = 20 * 1000;
const STALL_GRACE_MS = 4000;
const BEHIND_MAX_S = 1.5;
const WATCH_EVERY_MS = 500;
// Mid-show, a stream that failed this long ago is worth another try; and recovery gives up after this many rounds in a row.
const RETRY_FAILED_MS = 15 * 1000;
const RECOVERY_ROUNDS = 3;
const MAX_REDIRECTS = 3;
const CLIENT_QUEUE_MAX = 8 * 1024 * 1024;
const REFUSED_STATUSES = new Set([401, 403, 405, 406, 407, 429, 451, 456, 458, 461, 462, 463, 509, 551]);
const DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";
const SESSION_ID_RE = /^\/relay\/([a-f0-9]{32})\.ts$/;

/** Offset of the first TS packet in [buf]: a sync byte followed by two more a packet apart, or -1. */
function syncOffset(buf) {
  for (let i = 0; i + 2 * TS_PACKET < buf.length; i++)
    if (buf[i] === TS_SYNC && buf[i + TS_PACKET] === TS_SYNC && buf[i + 2 * TS_PACKET] === TS_SYNC) return i;
  return -1;
}

/**
 * One request to a candidate stream, following the provider's redirects. Resolves with the response once a
 * 200 arrives, or rejects with an error whose `status` is the HTTP status when the provider answered.
 */
function request(url, { userAgent, timeoutMs = CONNECT_TIMEOUT_MS, hops = 0, agentFor = null } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error("bad url"));
    }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.get(target, { headers: { "User-Agent": userAgent || DEFAULT_UA, Accept: "*/*", Connection: "close" }, agent: agentFor ? agentFor(target) : undefined });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("connect timeout"), { code: "TIMEOUT" })), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        req.destroy();
        if (hops >= MAX_REDIRECTS) return reject(Object.assign(new Error("too many redirects"), { status: res.statusCode }));
        return request(new URL(res.headers.location, target).toString(), { userAgent, timeoutMs, hops: hops + 1, agentFor }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        req.destroy();
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
      }
      resolve({ res, req });
    });
  });
}

/**
 * Opens [candidate] and waits until it sends START_BYTES of MPEG-TS. Resolves with the open connection and the
 * aligned data read so far; rejects with `refused` set when the provider turned the server away.
 */
function openCandidate(candidate, { userAgent, abort, deadline, requestImpl = request }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let conn = null;
    let done = false;
    const chunks = [];
    let size = 0;
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (conn) conn.req.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error("no video in time"), { code: "TIMEOUT" })), Math.max(500, deadline - Date.now()));
    abort.signal.addEventListener("abort", () => fail(Object.assign(new Error("lost the race"), { code: "ABORTED" })), { once: true });
    requestImpl(candidate.url, { userAgent, timeoutMs: Math.min(CONNECT_TIMEOUT_MS, Math.max(500, deadline - Date.now())) }).then(
      (c) => {
        if (done) return c.req.destroy();
        conn = c;
        c.res.on("data", (chunk) => {
          if (done) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size < START_BYTES) return;
          const buf = Buffer.concat(chunks);
          const at = syncOffset(buf);
          if (at < 0) return fail(Object.assign(new Error("not MPEG-TS"), { code: "NOT_TS" }));
          done = true;
          clearTimeout(timer);
          c.res.pause();
          resolve({ ...c, first: buf.subarray(at), ttfbMs: Date.now() - started });
        });
        c.res.on("end", () => fail(Object.assign(new Error("ended before video"), { code: "ENDED" })));
        c.res.on("error", fail);
      },
      (e) => fail(Object.assign(e, { refused: REFUSED_STATUSES.has(e.status) }))
    );
  });
}

/**
 * Races [candidates] RACE_WIDTH at a time until one sends video or the start budget runs out. Returns
 * { winner, conn, failures } where failures lists every candidate that didn't play and why.
 */
async function race(candidates, { userAgent, budgetMs = START_BUDGET_MS, openImpl = openCandidate, onAttempt = () => {} }) {
  const deadline = Date.now() + budgetMs;
  const failures = [];
  const queue = [...candidates];
  while (queue.length && Date.now() < deadline) {
    const batch = [];
    const usedPids = new Set();
    // Two streams from one provider in the same batch would compete for that provider's connection.
    for (let i = 0; i < queue.length && batch.length < RACE_WIDTH; ) {
      if (usedPids.has(queue[i].pid)) {
        i++;
        continue;
      }
      usedPids.add(queue[i].pid);
      batch.push(queue.splice(i, 1)[0]);
    }
    const abort = new AbortController();
    onAttempt(batch, +1);
    const tries = batch.map((c) =>
      openImpl(c, { userAgent, abort, deadline }).then(
        (conn) => ({ c, conn }),
        (e) => {
          if (e.code !== "ABORTED") failures.push({ candidate: c, error: e });
          throw e;
        }
      )
    );
    let won = null;
    try {
      won = await Promise.any(tries);
    } catch {
      won = null;
    }
    abort.abort();
    // A slower candidate that also connected is closed at once, so its provider slot is free again.
    await Promise.allSettled(tries.map((t) => t.then(({ c, conn }) => (won && c === won.c ? null : conn.req.destroy()))));
    // Opening counts end here; the winner's connection is counted as the channel's current one from now on.
    onAttempt(batch, -1);
    if (won) return { winner: won.c, conn: won.conn, failures };
  }
  return { winner: null, conn: null, failures };
}

/**
 * One channel being played: the provider connection and every TV watching through it. It writes whole TS
 * packets to each TV, and moves to the next candidate when the stream stalls, slows to a crawl or drops.
 */
class Upstream {
  constructor({ key, candidates, userAgent, report, log, raceImpl = race, now = Date.now, stallMs = STALL_MS }) {
    this.key = key;
    this.candidates = candidates;
    this.userAgent = userAgent;
    this.report = report;
    this.log = log;
    this.raceImpl = raceImpl;
    this.now = now;
    this.stallMs = stallMs;
    this.clients = new Set();
    this.normalizer = new TsNormalizer({ now });
    this.failed = new Map();
    this.recoveries = 0;
    this.current = null;
    this.conn = null;
    this.closed = false;
    this.switching = null;
    this.watchdog = null;
    this.playStart = 0;
    this.lastDataAt = 0;
    this.startClock = null;
    this.opening = new Map();
  }

  /** The provider connections this channel holds or is opening, by provider id. */
  held() {
    const out = new Map();
    for (const [pid, n] of this.opening) if (n > 0) out.set(pid, (out.get(pid) || 0) + n);
    if (this.current && this.conn) out.set(this.current.pid, (out.get(this.current.pid) || 0) + 1);
    return out;
  }

  onAttempt(batch, delta) {
    for (const c of batch) this.opening.set(c.pid, (this.opening.get(c.pid) || 0) + delta);
    this.report.held();
  }

  /** Starts the channel: { ok } when a candidate plays, else { redirect } for a refused candidate or nothing. */
  async start() {
    const remaining = this.candidates.filter((c) => !c.redirectOnly);
    const { winner, conn, failures } = await this.raceImpl(remaining, { userAgent: this.userAgent, onAttempt: (b, d) => this.onAttempt(b, d) });
    this.noteFailures(failures);
    if (this.closed) {
      if (conn) conn.req.destroy();
      return { closed: true };
    }
    if (!winner) {
      const refused = failures.find((f) => f.error.refused) || null;
      const fallback = this.candidates.find((c) => c.redirectOnly) || (refused && refused.candidate) || null;
      return { redirect: fallback ? fallback.url : null, failures };
    }
    this.attach(winner, conn);
    this.report.outcome(winner, { ok: true, started: true, ttfbMs: conn.ttfbMs });
    return { ok: true, winner, failures };
  }

  noteFailures(failures) {
    for (const f of failures) {
      this.failed.set(f.candidate.key, this.now());
      this.report.outcome(f.candidate, { ok: false, why: f.error.status ? `HTTP ${f.error.status}` : f.error.code || f.error.message, refused: !!f.error.refused });
    }
  }

  /**
   * Where to go after losing the current stream: streams that haven't failed lately, in the channel's order,
   * else every stream, the one that failed longest ago first.
   */
  recoveryCandidates() {
    const t = this.now();
    const playable = this.candidates.filter((c) => !c.redirectOnly);
    const fresh = playable.filter((c) => !this.failed.has(c.key) || t - this.failed.get(c.key) > RETRY_FAILED_MS);
    if (fresh.length) return fresh;
    return [...playable].sort((a, b) => this.failed.get(a.key) - this.failed.get(b.key));
  }

  attach(candidate, conn) {
    this.current = candidate;
    this.conn = conn;
    this.normalizer.startSource();
    this.playStart = this.now();
    this.lastDataAt = this.playStart;
    this.startClock = null;
    this.report.held();
    this.write(conn.first);
    conn.res.on("data", (chunk) => this.write(chunk));
    conn.res.on("end", () => this.lost(candidate, "ended"));
    conn.res.on("error", (e) => this.lost(candidate, e.code || e.message));
    conn.res.resume();
    this.arm();
  }

  arm() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.check(), Math.min(WATCH_EVERY_MS, this.stallMs));
    if (this.watchdog.unref) this.watchdog.unref();
  }

  /** Seconds of video sent beyond real time since this stream started, from the output clock; null without one. */
  aheadSeconds() {
    const clock = this.normalizer.lastPcr;
    if (clock === null || this.startClock === null) return null;
    const media = (clock - this.startClock.pcr + 2 ** 33) % 2 ** 33 / 90000;
    return media - (this.now() - this.startClock.at) / 1000;
  }

  check() {
    if (this.closed || this.switching || !this.conn) return;
    const t = this.now();
    const quiet = t - this.lastDataAt;
    const ahead = this.aheadSeconds();
    if (quiet >= STALL_MAX_MS) return this.lost(this.current, "stalled");
    if (ahead === null) {
      if (quiet >= this.stallMs) this.lost(this.current, "stalled");
      return;
    }
    if (t - this.startClock.at >= STALL_GRACE_MS && ahead < -BEHIND_MAX_S)
      this.lost(this.current, `${quiet >= 1000 ? "stalled" : "too slow"}, ${(-ahead).toFixed(1)} s behind`);
  }

  /** [chunk] of the source, normalized (see TsNormalizer), to every TV. */
  write(chunk) {
    if (this.closed) return;
    this.lastDataAt = this.now();
    const out = this.normalizer.push(chunk);
    if (this.normalizer.formatChanged) return this.restartPlayers();
    // Real time for this stream starts at its first output.
    if (this.startClock === null && out.length && this.normalizer.lastPcr !== null) this.startClock = { pcr: this.normalizer.lastPcr, at: this.lastDataAt };
    if (out.length) for (const client of this.clients) client.send(out);
  }

  /** The current stream stalled or dropped: report it and move every TV to the next candidate. */
  lost(candidate, why) {
    if (this.closed || this.switching || candidate !== this.current) return;
    clearInterval(this.watchdog);
    const playedMs = this.now() - this.playStart;
    if (this.conn) this.conn.req.destroy();
    this.conn = null;
    this.failed.set(candidate.key, this.now());
    this.report.outcome(candidate, { ok: false, why, playedMs });
    this.report.held();
    this.recover(why, playedMs, candidate);
  }

  recover(why, playedMs, from) {
    if (this.closed) return;
    if (++this.recoveries > RECOVERY_ROUNDS) return this.close("no stream recovered");
    const next = this.recoveryCandidates();
    const pids = [...new Set(next.map((c) => c.pid))].slice(0, RACE_WIDTH);
    this.log(`[RELAY] "${this.key}" ${from.pid} ${why} after ${Math.round(playedMs / 1000)} s; trying ${pids.join(", ") || "nothing"}`);
    if (!next.length) return this.close("no streams");
    this.switching = this.raceImpl(next, { userAgent: this.userAgent, onAttempt: (b, d) => this.onAttempt(b, d) }).then(({ winner, conn, failures }) => {
      this.switching = null;
      this.noteFailures(failures);
      if (this.closed) {
        if (conn) conn.req.destroy();
        return;
      }
      if (!winner) return this.recover("nothing played", 0, from);
      this.recoveries = 0;
      this.log(`[RELAY] "${this.key}" moved to ${winner.pid} in ${conn.ttfbMs} ms`);
      this.report.outcome(winner, { ok: true, started: true, ttfbMs: conn.ttfbMs, failover: true });
      this.attach(winner, conn);
    });
  }

  /**
   * The new stream's audio or video format differs from what the TVs' players were set up for, which they can't
   * follow mid-stream. Their connections are reset so each app reopens the channel, and the output starts fresh
   * (it joins this stream, already playing, through a new session).
   */
  restartPlayers() {
    this.log(`[RELAY] "${this.key}" ${this.current.pid} has another stream format; restarting ${this.clients.size} player(s)`);
    for (const client of [...this.clients]) client.reset();
    this.normalizer = new TsNormalizer({ now: this.now });
    this.startClock = null;
  }

  /** A TV joining a channel already playing starts on the last keyframe, with the program table first. */
  add(client) {
    clearTimeout(this.idleTimer);
    const prefix = this.normalizer.joinPrefix();
    if (prefix.length) client.send(prefix);
    this.clients.add(client);
  }

  remove(client) {
    this.clients.delete(client);
    if (this.clients.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.clients.size) this.close("no viewers");
    }, IDLE_GRACE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  close(why) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.idleTimer);
    if (this.current && this.conn) {
      this.log(`[RELAY] "${this.key}" closed (${why}) after ${Math.round((this.now() - this.playStart) / 1000)} s on ${this.current.pid}`);
      this.report.outcome(this.current, { ok: true, ended: why, playedMs: this.now() - this.playStart });
    }
    if (this.conn) this.conn.req.destroy();
    this.conn = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.report.held();
    this.report.closed(this);
  }
}

/** A TV connection: queues what it can't take yet, and drops a TV that falls CLIENT_QUEUE_MAX behind. */
class Client {
  constructor(res, session, onGone) {
    this.res = res;
    this.session = session;
    this.queued = 0;
    this.gone = false;
    this.onGone = onGone;
    res.on("close", () => this.drop());
    res.on("drain", () => {
      this.queued = 0;
    });
  }

  send(buf) {
    if (this.gone) return;
    if (!this.res.write(buf)) {
      this.queued += buf.length;
      if (this.queued > CLIENT_QUEUE_MAX) {
        this.res.destroy();
        this.drop();
      }
    }
  }

  end() {
    if (this.gone) return;
    this.gone = true;
    this.res.end();
    this.onGone(this);
  }

  /** Drops the connection with an error, which makes a player retry rather than treat the stream as over. */
  reset() {
    if (this.gone) return;
    this.gone = true;
    this.res.destroy();
    this.onGone(this);
  }

  drop() {
    if (this.gone) return;
    this.gone = true;
    this.onGone(this);
  }
}

/**
 * The relay's sessions and channels. A session is one registered play request; a channel (Upstream) is one
 * provider connection, shared by every session watching that channel without a picked source.
 */
class Relay {
  constructor({ send = () => {}, log = console.log, now = Date.now, raceImpl = race, stallMs = STALL_MS } = {}) {
    this.send = send;
    this.log = log;
    this.now = now;
    this.raceImpl = raceImpl;
    this.stallMs = stallMs;
    this.sessions = new Map();
    this.channels = new Map();
    this.waiters = new Map();
  }

  /** Registers a session from the main process. */
  open(msg) {
    const s = { ...msg, createdAt: this.now(), lastSeen: this.now(), clients: new Set(), upstream: null };
    this.sessions.set(msg.id, s);
    const waiting = this.waiters.get(msg.id);
    if (waiting) {
      this.waiters.delete(msg.id);
      for (const w of waiting) w(s);
    }
    this.kickOverLimit(s);
    return s;
  }

  /**
   * A TV is switching channels: a channel it just left stops now instead of after the idle grace, and when the
   * TV is at its connection limit its oldest stream stops, so their provider connections are free for this one.
   */
  kickOverLimit(s) {
    for (const o of this.sessions.values()) {
      const u = o.upstream;
      if (o !== s && o.user === s.user && u && !u.closed && !u.clients.size && u.key !== s.channelKey) u.close("switched channel");
    }
    const mine = [...this.sessions.values()].filter((o) => o !== s && o.user === s.user && o.clients.size).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length && mine.length >= s.userMax) {
      const old = mine.shift();
      for (const c of [...old.clients]) c.end();
    }
  }

  sessionFor(id) {
    const s = this.sessions.get(id);
    if (s) return Promise.resolve(s);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) || [];
      list.push(resolve);
      this.waiters.set(id, list);
      setTimeout(() => {
        const l = this.waiters.get(id);
        if (l && l.includes(resolve)) {
          l.splice(l.indexOf(resolve), 1);
          if (!l.length) this.waiters.delete(id);
          resolve(null);
        }
      }, SESSION_WAIT_MS).unref?.();
    });
  }

  /** Provider connections open or opening, by provider id, so the main process knows which accounts are full. */
  held() {
    const byPid = {};
    const seen = new Set();
    for (const s of this.sessions.values()) {
      const u = s.upstream;
      if (!u || u.closed || seen.has(u)) continue;
      seen.add(u);
      for (const [pid, n] of u.held()) byPid[pid] = (byPid[pid] || 0) + n;
    }
    return { byPid };
  }

  reporter(session) {
    return {
      outcome: (candidate, result) => this.send({ type: "outcome", key: candidate.key, pid: candidate.pid, user: session.user, streamId: session.streamId, channel: session.channel, ...result }),
      held: () => this.send({ type: "held", ...this.held() }),
      closed: (upstream) => {
        if (this.channels.get(upstream.key) === upstream) this.channels.delete(upstream.key);
      },
    };
  }

  /** Serves GET /relay/<id>.ts. */
  async serve(req, res) {
    const m = SESSION_ID_RE.exec(req.url.split("?")[0]);
    if (!m) return res.writeHead(404).end();
    const s = await this.sessionFor(m[1]);
    if (!s) return res.writeHead(404).end();
    s.lastSeen = this.now();
    if (req.method === "HEAD") return res.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-store" }).end();
    // A TV can give up while the streams race; then nobody is left to watch what wins.
    let left = false;
    res.once("close", () => {
      left = true;
    });

    let upstream = s.upstream && !s.upstream.closed ? s.upstream : null;
    if (!upstream && !s.picked) {
      const shared = this.channels.get(s.channelKey);
      if (shared && !shared.closed && shared.current) upstream = shared;
    }
    let fresh = false;
    if (!upstream) {
      upstream = new Upstream({
        key: s.channelKey, candidates: s.candidates, userAgent: req.headers["user-agent"], report: this.reporter(s), log: this.log, raceImpl: this.raceImpl, now: this.now, stallMs: this.stallMs,
      });
      if (!s.picked) this.channels.set(s.channelKey, upstream);
      fresh = true;
    }
    s.upstream = upstream;

    if (fresh) {
      const started = this.now();
      const result = await upstream.start();
      if (result.closed) return res.writeHead(503).end();
      if (!result.ok) {
        upstream.close("did not start");
        const tried = [
          ...result.failures.map((f) => `${f.candidate.pid} ${f.error.status ? `HTTP ${f.error.status}` : f.error.code || f.error.message}`),
          ...s.candidates.filter((c) => c.redirectOnly).map((c) => `${c.pid} skipped, it refused the server lately`),
        ].join(", ");
        if (result.redirect) {
          this.log(`[RELAY] ${s.user} "${s.channel}" nothing played from the server (${tried || "no candidates"}); redirecting`);
          res.setHeader("Location", result.redirect);
          return res.writeHead(302).end();
        }
        this.log(`[RELAY] ${s.user} "${s.channel}" nothing played (${tried || "no candidates"})`);
        return res.writeHead(503, { "Retry-After": "2" }).end();
      }
      const lost = result.failures.map((f) => f.candidate.pid);
      this.log(`[RELAY] ${s.user} "${s.channel}" playing ${result.winner.pid} in ${this.now() - started} ms${lost.length ? ` (passed over ${lost.join(", ")})` : ""}`);
    } else {
      this.log(`[RELAY] ${s.user} "${s.channel}" joined ${upstream.current ? upstream.current.pid : "?"} (shared)`);
    }
    if (upstream.closed) return res.writeHead(503).end();
    if (left) {
      if (!upstream.clients.size) upstream.remove(null);
      return;
    }

    res.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    if (res.socket) res.socket.setNoDelay(true);
    const client = new Client(res, s, (c) => {
      s.clients.delete(c);
      s.lastSeen = this.now();
      upstream.remove(c);
    });
    s.clients.add(client);
    upstream.add(client);
  }

  /** Forgets sessions nobody used, or that nobody has watched for a while. */
  sweep() {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (s.clients.size) continue;
      const limit = s.upstream ? SESSION_REATTACH_MS : SESSION_UNUSED_MS;
      if (t - s.lastSeen > limit) this.sessions.delete(id);
    }
  }
}

function newSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

function main() {
  const port = Number(process.env.RELAY_PORT);
  const send = (msg) => {
    if (process.connected) process.send(msg);
  };
  const relay = new Relay({ send, log: (line) => console.log(line) });
  process.on("message", (msg) => {
    if (msg && msg.type === "open") relay.open(msg);
  });
  process.on("disconnect", () => process.exit(0));
  setInterval(() => relay.sweep(), 15000).unref();
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return res.writeHead(200).end("ok");
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    relay.serve(req, res).catch((e) => {
      console.error(`[RELAY] Request failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  server.listen(port, () => console.log(`[RELAY] Listening on ${port}`));
}

if (require.main === module) main();

module.exports = { Relay, Upstream, race, openCandidate, request, syncOffset, newSessionId, TS_PACKET };
