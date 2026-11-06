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

  /**
   * The last [hours] as numbers: per provider (picks, failovers off it, account checks, how often full and how often
   * full with none of the pool's streams on it, refresh errors, channel range, and its connections over time), per
   * login, the channels that failed over most, and plays per hour.
   */
  data(hours = 24) {
    const now = this.now();
    const since = now - hours * 3600000;
    const events = this.events(since);
    const plays = events.filter((e) => e.k === "play");
    const accts = events.filter((e) => e.k === "acct");
    const counted = (list) => list.filter((e) => e.r !== "same").length;
    const providers = [...new Set([...accts.map((e) => e.p), ...plays.map((e) => e.p)])].sort().map((pid) => {
      const checks = accts.filter((e) => e.p === pid);
      const full = checks.filter((e) => e.max && e.used >= e.max);
      const counts = checks.map((e) => e.ch).filter(Number.isFinite);
      const last = checks[checks.length - 1] || null;
      return {
        id: pid,
        picked: counted(plays.filter((e) => e.p === pid)),
        failed: plays.filter((e) => e.f === pid).length,
        checks: checks.length,
        full: full.length,
        outside: full.filter((e) => !e.own).length,
        refreshErrors: checks.filter((e) => e.err).length,
        minChannels: counts.length ? Math.min(...counts) : null,
        maxChannels: counts.length ? Math.max(...counts) : null,
        last: last && { t: last.t, status: last.st, used: last.used, max: last.max, expires: last.exp, own: last.own, error: last.err || null },
        series: checks.map((e) => [e.t, e.used, e.max, e.own]),
      };
    });
    const logins = [...new Set(plays.map((e) => e.u))].sort().map((u) => {
      const mine = plays.filter((e) => e.u === u);
      return { user: u, plays: counted(mine), failovers: mine.filter((e) => e.r === "failover").length, allBusy: mine.filter((e) => e.r === "all-busy").length };
    });
    const byChannel = new Map();
    for (const e of plays) {
      const c = byChannel.get(e.c) || { channel: e.c, plays: 0, failovers: 0, allBusy: 0, failedOn: new Set() };
      if (e.r !== "same") c.plays++;
      if (e.r === "failover") c.failovers++;
      if (e.r === "all-busy") c.allBusy++;
      if (e.f) c.failedOn.add(e.f);
      byChannel.set(e.c, c);
    }
    const channels = [...byChannel.values()]
      .filter((c) => c.failovers || c.allBusy)
      .sort((a, b) => b.failovers + b.allBusy - (a.failovers + a.allBusy))
      .slice(0, TOP_CHANNELS)
      .map((c) => ({ ...c, failedOn: [...c.failedOn] }));
    const hourMs = 3600000;
    const hourly = [];
    for (let h = Math.floor(since / hourMs) * hourMs; h <= now; h += hourMs) {
      const inHour = plays.filter((e) => e.t >= h && e.t < h + hourMs);
      hourly.push({ t: h, plays: counted(inHour), failovers: inHour.filter((e) => e.r === "failover").length, allBusy: inHour.filter((e) => e.r === "all-busy").length });
    }
    return { now, hours, plays: plays.length, checks: accts.length, providers, logins, channels, hourly };
  }

  /** The plain-text summary for the last [hours]: providers, logins, the channels that failed most, and an hourly trend. */
  summary(hours = 24, zone = "America/New_York") {
    const d = this.data(hours);
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
    const pad = (v, n, left) => (left ? String(v).padEnd(n) : String(v).padStart(n));
    const when = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const lines = [`Pool metrics, last ${hours} h (${d.plays} plays, ${d.checks} account checks)`, ""];
    lines.push([pad("Provider", 10, 1), pad("Picked", 7), pad("Failed", 7), pad("Fail %", 7), pad("Full", 6), pad("Outside", 8),
      pad("Refresh errs", 13), pad("Channels", 16), "  Last check"].join(" "));
    for (const p of d.providers) {
      const range = p.minChannels === null ? "-" : `${p.minChannels.toLocaleString("en-US")}-${p.maxChannels.toLocaleString("en-US")}`;
      const l = p.last;
      const lastText = l ? `${l.status || "?"}, ${l.used ?? "?"}/${l.max ?? "?"}, expires ${l.expires ? String(l.expires).slice(0, 10) : "never"}` : "-";
      lines.push([pad(p.id, 10, 1), pad(p.picked, 7), pad(p.failed, 7), pad(pct(p.failed, p.picked), 7), pad(pct(p.full, p.checks), 6),
        pad(pct(p.outside, p.checks), 8), pad(p.refreshErrors, 13), pad(range, 16), `  ${lastText}`].join(" "));
    }
    lines.push("", "Failed: plays a retry moved off this provider. Full / Outside: share of checks the account was full / full with no pool stream on it.");
    lines.push("", [pad("Login", 10, 1), pad("Plays", 7), pad("Failovers", 10), pad("All busy", 9)].join(" "));
    for (const l of d.logins) lines.push([pad(l.user, 10, 1), pad(l.plays, 7), pad(l.failovers, 10), pad(l.allBusy, 9)].join(" "));
    if (d.channels.length) {
      lines.push("", `Channels with the most failovers`, [pad("Failovers", 10), pad("All busy", 9), "  Channel (providers it failed on)"].join(" "));
      for (const c of d.channels) lines.push([pad(c.failovers, 10), pad(c.allBusy, 9), `  ${c.channel}${c.failedOn.length ? ` (${c.failedOn.join(", ")})` : ""}`].join(" "));
    }
    const active = d.hourly.filter((h) => h.plays || h.failovers || h.allBusy);
    if (active.length) {
      lines.push("", "By hour", [pad("Hour", 16, 1), pad("Plays", 6), pad("Failovers", 10), pad("All busy", 9)].join(" "));
      for (const h of active) lines.push([pad(when(h.t), 16, 1), pad(h.plays, 6), pad(h.failovers, 10), pad(h.allBusy, 9)].join(" "));
    }
    return lines.join("\n") + "\n";
  }
}

module.exports = { PoolMetrics, RETENTION_DAYS };
