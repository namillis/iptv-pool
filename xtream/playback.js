const LEASE_MS = 4 * 3600 * 1000;
const REPEAT_MS = 60 * 1000;
const FAILED_MS = 2 * 60 * 1000;
const SETTLE_MS = 10 * 1000;
const SETTLE_RETRIES = 2;
const STOP_GRACE_MS = 5 * 1000;
const XTREAM_LIVE_RE = /^(.*\/live\/[^/]+\/[^/]+\/[^/.]+)\.([A-Za-z0-9]+)$/;
const START_RE = /^(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})$/;

function memberKey(m) {
  return `${m._pid}/${m._src}`;
}

function memberUrl(m, ext) {
  const url = m.url || "";
  const match = url.match(XTREAM_LIVE_RE);
  return match && ext ? `${match[1]}.${ext}` : url || null;
}

function validZone(zone) {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function convertStart(start, zone) {
  const m = String(start || "").match(START_RE);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (!Number.isFinite(ms)) return null;
  const tz = validZone(zone);
  if (!tz || tz === "UTC") return start;
  const parts = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  for (const { type, value } of fmt.formatToParts(new Date(ms))) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

class Playback {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.accounts = new Map();
    this.failed = new Map();
  }

  account(username) {
    let acct = this.accounts.get(username);
    if (!acct) this.accounts.set(username, (acct = { leases: [] }));
    return acct;
  }

  prune(now) {
    for (const acct of this.accounts.values()) acct.leases = acct.leases.filter((l) => now - l.at < LEASE_MS);
    if (this.failed.size > 500) for (const [k, at] of this.failed) if (now - at >= FAILED_MS) this.failed.delete(k);
  }

  activeCount(username) {
    const acct = this.accounts.get(username);
    return acct ? acct.leases.filter((l) => this.now() - l.at < LEASE_MS).length : 0;
  }

  replacedLease(acct, user, streamId) {
    const same = acct.leases.find((l) => l.streamId === streamId);
    if (same) return same;
    if (acct.leases.length < user.maxConnections) return null;
    return acct.leases.reduce((a, b) => (a.at <= b.at ? a : b));
  }

  isFull(pid, status, replaced) {
    const a = status && status.get(pid);
    const max = a && !a.error ? Number(a.maxConnections) : 0;
    if (!max) return false;
    let all = 0;
    let ours = 0;
    for (const acct of this.accounts.values())
      for (const l of acct.leases)
        if (l.pid === pid) {
          all++;
          if (l !== replaced) ours++;
        }
    const others = Math.max(0, (Number(a.activeConnections) || 0) - all);
    return ours + others >= max;
  }

  firstChoiceFull(user, streamId, tile, status) {
    const acct = this.account(user.username);
    this.prune(this.now());
    const m = tile._members[0];
    return !!m && this.isFull(m._pid, status, this.replacedLease(acct, user, streamId));
  }

  isFailed(key, now) {
    const at = this.failed.get(key);
    return at !== undefined && now - at < FAILED_MS;
  }

  /**
   * Pick a member for a live request. [signal] is set when the app reports its attempts
   * (`try=N`, `why=refused`): then a higher attempt number than the lease has seen is a retry and
   * anything else keeps the leased member, so nothing is guessed from timing. Without it, a repeat
   * request within a minute counts as a failure, as for any plain Xtream app.
   */
  live(user, streamId, tile, ext, status, signal = null) {
    const now = this.now();
    this.prune(now);
    const acct = this.account(user.username);
    const current = acct.leases.find((l) => l.streamId === streamId);
    let failed = false;

    if (current && signal) {
      if (signal.attempt <= current.attempt) {
        current.at = now;
        return { member: current.member, reason: "same" };
      }
      current.attempt = signal.attempt;
      current.repeats++;
      const settling = signal.refused && current.settles && current.repeats <= SETTLE_RETRIES && now - current.firstAt < SETTLE_MS;
      if (settling) {
        current.at = now;
        return { member: current.member, reason: "settling" };
      }
      failed = true;
    } else if (current && now - current.at < REPEAT_MS) {
      current.repeats++;
      if (ext === "m3u8") {
        current.at = now;
        return { member: current.member, reason: "same" };
      }
      const settling = current.settles && current.repeats <= SETTLE_RETRIES && now - current.firstAt < SETTLE_MS;
      if (settling) {
        current.at = now;
        return { member: current.member, reason: "settling" };
      }
      failed = true;
    }
    if (failed) this.failed.set(current.key, now);
    const failover = failed;
    const replaced = this.replacedLease(acct, user, streamId);

    let member = null;
    let reason = failover ? "failover" : "first";
    let skipped = 0;
    for (const m of tile._members) {
      if (this.isFailed(memberKey(m), now) || this.isFull(m._pid, status, replaced)) {
        skipped++;
        continue;
      }
      member = m;
      break;
    }
    if (!member) {
      member = tile._members.find((m) => !this.isFailed(memberKey(m), now)) || null;
      if (!member) {
        for (const m of tile._members) this.failed.delete(memberKey(m));
        member = tile._members[0] || null;
      }
      reason = "all-busy";
    } else if (skipped && !failover) {
      reason = "skipped-busy";
    }
    if (!member) return null;

    const lease = {
      streamId,
      member,
      key: memberKey(member),
      pid: member._pid,
      at: now,
      firstAt: now,
      repeats: 0,
      attempt: signal ? signal.attempt : 0,
      settles: !failover && !!replaced && replaced.streamId !== streamId && replaced.pid === member._pid,
    };
    acct.leases = acct.leases.filter((l) => l !== replaced);
    acct.leases.push(lease);
    return { member, reason, skipped };
  }

  /**
   * The app stopped playing: drop the login's lease on [streamId] (live or archive), or every
   * lease the login holds when no stream is given. Frees that provider for another TV at once.
   * A lease opened or refreshed in the last [STOP_GRACE_MS] is kept: that's a stop for the
   * previous session (a Guide preview, say) racing the new request for the same channel.
   */
  stop(username, streamId = null) {
    const acct = this.accounts.get(username);
    if (!acct) return 0;
    const now = this.now();
    const before = acct.leases.length;
    const matches = (l) => streamId === null || l.streamId === streamId || l.streamId === `archive:${streamId}`;
    acct.leases = acct.leases.filter((l) => !matches(l) || now - l.at < STOP_GRACE_MS);
    return before - acct.leases.length;
  }

  archive(user, streamId, member) {
    const now = this.now();
    this.prune(now);
    const acct = this.account(user.username);
    const id = `archive:${streamId}`;
    const replaced = this.replacedLease(acct, user, id);
    acct.leases = acct.leases.filter((l) => l !== replaced);
    acct.leases.push({ streamId: id, member, key: memberKey(member), pid: member._pid, at: now, firstAt: now, repeats: 0, settles: false });
  }
}

module.exports = { Playback, memberUrl, convertStart, memberKey, LEASE_MS, REPEAT_MS, FAILED_MS };
