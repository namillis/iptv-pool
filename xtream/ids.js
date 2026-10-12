const fs = require("fs");
const path = require("path");

const SAVE_DELAY_MS = 5000;

function emptyState() {
  return { keys: {}, members: {}, categories: {}, nextStream: 1, nextCategory: 1 };
}

function memberKey(m) {
  return `${m._pid}/${m._src}`;
}

class XtreamIds {
  constructor(file, { log = console } = {}) {
    this.file = file;
    this.log = log;
    this.state = emptyState();
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const state = emptyState();
    for (const k of ["keys", "members", "categories"])
      if (raw[k] && typeof raw[k] === "object") state[k] = raw[k];
    const max = (obj) => Object.values(obj).reduce((a, b) => Math.max(a, b), 0);
    state.nextStream = Math.max(Number(raw.nextStream) || 1, max(state.keys) + 1, max(state.members) + 1);
    state.nextCategory = Math.max(Number(raw.nextCategory) || 1, max(state.categories) + 1);
    this.state = state;
  }

  assignStreams(tiles) {
    const { keys, members } = this.state;
    const ids = new Map();
    const claimed = new Set();
    const fresh = [];
    let changed = false;

    for (const tile of tiles) {
      const id = keys[tile._key];
      if (id && !claimed.has(id)) {
        ids.set(tile, id);
        claimed.add(id);
      } else {
        fresh.push(tile);
      }
    }

    let owners = null;
    for (const tile of fresh) {
      let id = 0;
      for (const m of tile._members) {
        const old = members[memberKey(m)];
        if (old && !claimed.has(old)) {
          id = old;
          break;
        }
      }
      if (id) {
        if (!owners) {
          owners = new Map();
          for (const [k, v] of Object.entries(keys)) owners.set(v, k);
        }
        const prevKey = owners.get(id);
        if (prevKey !== undefined) delete keys[prevKey];
      } else {
        id = this.state.nextStream++;
      }
      keys[tile._key] = id;
      ids.set(tile, id);
      claimed.add(id);
      changed = true;
    }

    for (const [tile, id] of ids) {
      for (const m of tile._members) {
        const k = memberKey(m);
        if (members[k] !== id) {
          members[k] = id;
          changed = true;
        }
      }
    }

    if (changed) this.scheduleSave();
    return ids;
  }

  categoryId(name) {
    const { categories } = this.state;
    let id = categories[name];
    if (!id) {
      id = categories[name] = this.state.nextCategory++;
      this.scheduleSave();
    }
    return id;
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
      fs.writeFileSync(tmp, JSON.stringify(this.state));
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

module.exports = { XtreamIds };
