const fs = require("fs");
const path = require("path");

const REMEMBER_MS = 12 * 3600 * 1000;
const SAVE_DELAY_MS = 5000;

/**
 * What the pool learned from catch-up lists, per channel key: which provider stream had listings
 * when it wasn't the channel's first catch-up stream, and which channels had none on every
 * provider tried. Both are forgotten after [REMEMBER_MS]. Apps only ask for the list of a channel
 * advertised with catch-up, so a hidden channel is only checked again once it's forgotten.
 */
class ArchiveMemory {
  constructor(file, { now = Date.now, log = console } = {}) {
    this.file = file;
    this.now = now;
    this.log = log;
    this.picks = new Map();
    this.missing = new Map();
    this.rev = 0;
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") this.log.error(`[XTREAM] Reading ${this.file} failed: ${e.message}`);
      return;
    }
    const t = this.now();
    for (const [key, v] of Object.entries(raw?.picks || {}))
      if (v && typeof v.member === "string" && v.until > t) this.picks.set(key, { member: v.member, until: v.until });
    for (const [key, until] of Object.entries(raw?.missing || {})) if (until > t) this.missing.set(key, until);
  }

  prune() {
    const t = this.now();
    let changed = false;
    for (const [key, v] of this.picks)
      if (v.until <= t) {
        this.picks.delete(key);
        changed = true;
      }
    for (const [key, until] of this.missing)
      if (until <= t) {
        this.missing.delete(key);
        this.rev++;
        changed = true;
      }
    if (changed) this.scheduleSave();
  }

  /** Changes whenever the set of hidden channels does, so views know to rebuild. */
  revision() {
    this.prune();
    return this.rev;
  }

  hidden() {
    this.prune();
    return new Set(this.missing.keys());
  }

  picked(key) {
    const v = this.picks.get(key);
    return v && v.until > this.now() ? v.member : null;
  }

  /** [member] (a member key) had listings. [preferred] says it's the channel's usual catch-up stream. */
  found(key, member, preferred) {
    if (preferred) this.picks.delete(key);
    else this.picks.set(key, { member, until: this.now() + REMEMBER_MS });
    if (this.missing.delete(key)) this.rev++;
    this.scheduleSave();
  }

  /** Every catch-up stream tried for [key] answered with an empty list. */
  none(key) {
    this.picks.delete(key);
    if (!this.missing.has(key)) this.rev++;
    this.missing.set(key, this.now() + REMEMBER_MS);
    this.scheduleSave();
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ picks: Object.fromEntries(this.picks), missing: Object.fromEntries(this.missing) }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.error(`[XTREAM] Saving ${this.file} failed: ${e.message}`);
    }
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }
}

module.exports = { ArchiveMemory, REMEMBER_MS };
