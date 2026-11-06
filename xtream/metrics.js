const fs = require("fs");
const path = require("path");

const RETENTION_DAYS = 30;
const DAY_MS = 86400000;
const TOP_CHANNELS = 15;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * A record of every live play and of each provider account check, one JSON line per event in a file per UTC day
 * under [dir]. Files older than [RETENTION_DAYS] are deleted. It lives in the data folder, so it survives a deploy.
 */
class PoolMetrics {
  constructor(dir, { now = Date.now, log = console } = {}) {
    this.dir = dir;
    this.now = now;
    this.log = log;
    this.day = null;
    this.warned = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  write(event) {
    const t = this.now();
    const d = day(t);
    try {
      if (d !== this.day) {
        this.day = d;
        this.prune(t);
      }
      fs.appendFileSync(path.join(this.dir, `${d}.jsonl`), JSON.stringify({ t, ...event }) + "\n");
    } catch (e) {
      if (!this.warned) this.log.error(`[METRICS] Write failed: ${e.message}`);
      this.warned = true;
    }
  }

  prune(t) {
    const oldest = day(t - RETENTION_DAYS * DAY_MS);
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(FILE_RE);
      if (m && m[1] < oldest) fs.unlinkSync(path.join(this.dir, f));
    }
  }

  /** A live play: the login, the stream, the provider picked, why, and the provider it moved off of on a failover. */
  play({ user, streamId, channel, pid, reason, from = null, attempt = null }) {
    const e = { k: "play", u: user, s: streamId, c: channel, p: pid, r: reason };
    if (from) e.f = from;
    if (attempt !== null) e.n = attempt;
    this.write(e);
  }

  /** One provider's account and channel refresh, with how many of its connections the pool's own logins hold. */
  account({ pid, status, used, max, expires, channels, leases, refreshError }) {
    const e = { k: "acct", p: pid, st: status, used, max, exp: expires, ch: channels, own: leases };
    if (refreshError) e.err = refreshError;
    this.write(e);
  }

  events(since) {
    const out = [];
    const first = day(since);
    for (const f of fs.readdirSync(this.dir).filter((x) => FILE_RE.test(x) && x.slice(0, 10) >= first).sort()) {
      for (const line of fs.readFileSync(path.join(this.dir, f), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.t >= since) out.push(e);
        } catch {
          // A line cut short by a crash is skipped.
        }
      }
    }
    return out;
  }

  /** The plain-text summary for the last [hours]: providers, logins, the channels that failed most, and an hourly trend. */
  summary(hours = 24, zone = "America/New_York") {
    const now = this.now();
    const events = this.events(now - hours * 3600000);
    const plays = events.filter((e) => e.k === "play");
    const accts = events.filter((e) => e.k === "acct");
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
    const pad = (v, n, left) => (left ? String(v).padEnd(n) : String(v).padStart(n));
    const when = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const lines = [`Pool metrics, last ${hours} h (${plays.length} plays, ${accts.length} account checks)`, ""];

    const pids = [...new Set([...accts.map((e) => e.p), ...plays.map((e) => e.p)])].sort();
    lines.push([pad("Provider", 10, 1), pad("Picked", 7), pad("Failed", 7), pad("Fail %", 7), pad("Full", 6), pad("Outside", 8),
      pad("Refresh errs", 13), pad("Channels", 16), "  Last check"].join(" "));
    for (const pid of pids) {
      const picked = plays.filter((e) => e.p === pid && e.r !== "same").length;
      const failed = plays.filter((e) => e.f === pid).length;
      const checks = accts.filter((e) => e.p === pid);
      const full = checks.filter((e) => e.max && e.used >= e.max);
      // Full with no pool login holding any of it: someone outside the pool is using the account.
      const outside = full.filter((e) => !e.own);
      const errs = checks.filter((e) => e.err).length;
      const counts = checks.map((e) => e.ch).filter(Number.isFinite);
      const range = counts.length ? `${Math.min(...counts).toLocaleString("en-US")}-${Math.max(...counts).toLocaleString("en-US")}` : "-";
      const last = checks[checks.length - 1];
      const lastText = last ? `${last.st || "?"}, ${last.used ?? "?"}/${last.max ?? "?"}, expires ${last.exp ? String(last.exp).slice(0, 10) : "never"}` : "-";
      lines.push([pad(pid, 10, 1), pad(picked, 7), pad(failed, 7), pad(pct(failed, picked), 7), pad(pct(full.length, checks.length), 6),
        pad(pct(outside.length, checks.length), 8), pad(errs, 13), pad(range, 16), `  ${lastText}`].join(" "));
    }
    lines.push("", "Failed: plays a retry moved off this provider. Full / Outside: share of checks the account was full / full with no pool stream on it.");

    lines.push("", [pad("Login", 10, 1), pad("Plays", 7), pad("Failovers", 10), pad("All busy", 9)].join(" "));
    for (const u of [...new Set(plays.map((e) => e.u))].sort()) {
      const mine = plays.filter((e) => e.u === u);
      lines.push([pad(u, 10, 1), pad(mine.filter((e) => e.r !== "same").length, 7), pad(mine.filter((e) => e.r === "failover").length, 10),
        pad(mine.filter((e) => e.r === "all-busy").length, 9)].join(" "));
    }

    const byChannel = new Map();
    for (const e of plays) {
      if (e.r !== "failover" && e.r !== "all-busy") continue;
      const c = byChannel.get(e.c) || { failover: 0, busy: 0, from: new Set() };
      if (e.r === "failover") c.failover++;
      else c.busy++;
      if (e.f) c.from.add(e.f);
      byChannel.set(e.c, c);
    }
    if (byChannel.size) {
      lines.push("", `Channels with the most failovers`, [pad("Failovers", 10), pad("All busy", 9), "  Channel (providers it failed on)"].join(" "));
      const top = [...byChannel].sort((a, b) => b[1].failover + b[1].busy - (a[1].failover + a[1].busy)).slice(0, TOP_CHANNELS);
      for (const [name, c] of top) lines.push([pad(c.failover, 10), pad(c.busy, 9), `  ${name}${c.from.size ? ` (${[...c.from].join(", ")})` : ""}`].join(" "));
    }

    if (plays.length) {
      lines.push("", "By hour", [pad("Hour", 16, 1), pad("Plays", 6), pad("Failovers", 10), pad("All busy", 9)].join(" "));
      const hourMs = 3600000;
      for (let h = Math.floor((now - hours * hourMs) / hourMs) * hourMs; h <= now; h += hourMs) {
        const inHour = plays.filter((e) => e.t >= h && e.t < h + hourMs);
        if (!inHour.length) continue;
        lines.push([pad(when(h), 16, 1), pad(inHour.filter((e) => e.r !== "same").length, 6), pad(inHour.filter((e) => e.r === "failover").length, 10),
          pad(inHour.filter((e) => e.r === "all-busy").length, 9)].join(" "));
      }
    }
    return lines.join("\n") + "\n";
  }
}

module.exports = { PoolMetrics, RETENTION_DAYS };
