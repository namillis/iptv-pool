const fs = require("fs");
const path = require("path");

const SAVE_DELAY_MS = 5000;
const SLICE_MS = 25;
const SAVE_ENTRIES_PER_PAUSE = 2000;

function emptyState() {
  return { keys: {}, members: {}, categories: {}, nextStream: 1, nextCategory: 1 };
}

function memberKey(m) {
  return `${m._pid}/${m._src}`;
}

// Runs [steps] (a generator that yields where it can pause) in slices of about [sliceMs], letting other work run in
// between, unless [stop] says someone else finished it.
async function runSliced(steps, stop = () => false, sliceMs = SLICE_MS) {
  let sliceStart = performance.now();
  let step;
  while (!stop() && !(step = steps.next()).done) {
    if (performance.now() - sliceStart < sliceMs) continue;
    await new Promise((resolve) => setImmediate(resolve));
    sliceStart = performance.now();
  }
  return step && step.done ? step.value : undefined;
}

function runToEnd(steps) {
  let step;
  while (!(step = steps.next()).done);
  return step.value;
}

// JSON.stringify(state), pausing between entries. The state's values are all numbers.
function* stateJson(state) {
  const parts = ["{"];
  let n = 0;
  for (const name of ["keys", "members", "categories"]) {
    parts.push(`${name === "keys" ? "" : ","}${JSON.stringify(name)}:{`);
    let first = true;
    for (const k in state[name]) {
      parts.push(`${first ? "" : ","}${JSON.stringify(k)}:${state[name][k]}`);
      first = false;
      if (++n % SAVE_ENTRIES_PER_PAUSE === 0) yield;
    }
    parts.push("}");
  }
  parts.push(`,"nextStream":${state.nextStream},"nextCategory":${state.nextCategory}}`);
  return parts.join("");
}

class XtreamIds {
  constructor(file, { log = console } = {}) {
    this.file = file;
    this.log = log;
    this.state = emptyState();
    this.timer = null;
    // The sliced assignment in progress: { steps, finished, result, done }.
    this.running = null;
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

  /** Stream ids for [tiles], in one go. A sliced assignment in progress is finished first, so the two never mix. */
  assignStreams(tiles) {
    this.finishRunning();
    if (this.lastTiles === tiles) return this.lastIds;
    return runToEnd(this.assignSteps(tiles));
  }

  /** The same ids as assignStreams, worked out in slices that let other work run. Assignments run one at a time. */
  async assignStreamsSliced(tiles, sliceMs = SLICE_MS) {
    while (this.running) await this.running.done;
    if (this.lastTiles === tiles) return this.lastIds;
    const run = { steps: this.assignSteps(tiles), finished: false, result: undefined };
    run.done = runSliced(run.steps, () => run.finished, sliceMs).then((result) => {
      if (!run.finished) {
        run.finished = true;
        run.result = result;
      }
    }).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    await run.done;
    return run.result;
  }

  finishRunning() {
    const run = this.running;
    if (!run || run.finished) return;
    run.result = runToEnd(run.steps);
    run.finished = true;
  }

  /**
   * The work of assigning stream ids to [tiles], keeping each channel's id across merges. A tile object the last
   * call also got, with the same id, has the same members (the pool reuses a channel only when its streams are
   * unchanged), so their ids are already recorded and aren't checked again. That keeps a merge where one provider
   * changed from walking every stream of all the others.
   */
  *assignSteps(tiles) {
    const { keys, members } = this.state;
    const ids = new Map();
    const claimed = new Set();
    const fresh = [];
    const previous = this.lastIds || new Map();
    let changed = false;

    for (const tile of tiles) {
      yield;
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
      yield;
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
          for (const k in keys) {
            owners.set(keys[k], k);
            yield;
          }
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
      yield;
      if (previous.get(tile) === id) continue;
      for (const m of tile._members) {
        const k = memberKey(m);
        if (members[k] !== id) {
          members[k] = id;
          changed = true;
        }
      }
    }

    if (changed) this.scheduleSave();
    this.lastTiles = tiles;
    this.lastIds = ids;
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
      this.saveSliced();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  // Writes the ids in one go, blocking until it's on disk.
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

  // The same file as save, built in slices and written without blocking. Saves never overlap.
  saveSliced() {
    const previous = this.saving || Promise.resolve();
    this.saving = previous.then(async () => {
      try {
        const json = await runSliced(stateJson(this.state));
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.promises.writeFile(tmp, json);
        await fs.promises.rename(tmp, this.file);
      } catch (e) {
        this.log.error(`[XTREAM] Saving ${this.file} failed: ${e.message}`);
      }
    });
    return this.saving;
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }
}

module.exports = { XtreamIds, stateJson };
