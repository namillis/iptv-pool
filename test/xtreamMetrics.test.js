const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PoolMetrics, RETENTION_DAYS } = require("../xtream/metrics");

const START = Date.UTC(2026, 10, 6, 15, 0);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "metrics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = START;
  const now = () => at;
  now.advance = (ms) => (at += ms);
  return { dir, now, metrics: new PoolMetrics(dir, { now, log: { error() {} } }) };
}

test("plays and account checks are kept as JSON lines in a file per day", (t) => {
  const { dir, metrics } = setup(t);
  metrics.play({ user: "tv1", streamId: 8, channel: "US - CNN", pid: "nova", reason: "first", attempt: 0 });
  metrics.account({ pid: "nova", status: "Active", used: 1, max: 1, expires: "2027-01-24", channels: 27447, leases: 1 });
  const lines = fs.readFileSync(path.join(dir, "2026-11-06.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines[0], { t: START, k: "play", u: "tv1", s: 8, c: "US - CNN", p: "nova", r: "first", n: 0 });
  assert.strictEqual(lines[1].own, 1);
});

test("the summary counts failures against the provider a retry moved off of, and flags outside use", (t) => {
  const { metrics, now } = setup(t);
  metrics.play({ user: "tv3", streamId: 1, channel: "US: CBS News", pid: "vip6071", reason: "first" });
  metrics.play({ user: "tv3", streamId: 1, channel: "US: CBS News", pid: "raptor", reason: "failover", from: "vip6071" });
  metrics.play({ user: "tv3", streamId: 1, channel: "US: CBS News", pid: "raptor", reason: "same" });
  metrics.play({ user: "tv1", streamId: 2, channel: "US - CNN", pid: "nova", reason: "all-busy" });
  metrics.account({ pid: "polar", status: "Active", used: 5, max: 5, expires: "2027-03-21", channels: 32661, leases: 0 });
  metrics.account({ pid: "nova", status: "Active", used: 1, max: 1, expires: "2027-01-24", channels: 27447, leases: 1, refreshError: "timeout" });
  now.advance(60000);
  const text = metrics.summary(24);
  const row = (pid) => text.split("\n").find((l) => l.startsWith(pid.padEnd(10)));
  assert.match(row("vip6071"), /^vip6071\s+1\s+1\s+100%/);
  assert.match(row("raptor"), /^raptor\s+1\s+0\s+0%/, "a repeat of the same pick isn't counted again");
  assert.match(row("polar"), /100%\s+100%\s+0\s+32,661-32,661/, "full with no pool stream on it is outside use");
  assert.match(row("nova"), /100%\s+0%\s+1\s/, "full because a pool login holds it, with one refresh error");
  assert.match(text, /^\s+1\s+0\s+US: CBS News \(vip6071\)$/m);
  assert.match(text, /^tv3\s+2\s+1\s+0$/m);
});

test("events older than the window are left out, and files past the retention are deleted", (t) => {
  const { dir, metrics, now } = setup(t);
  metrics.play({ user: "tv1", streamId: 1, channel: "Old", pid: "nova", reason: "first" });
  now.advance(2 * 86400000);
  metrics.play({ user: "tv1", streamId: 1, channel: "New", pid: "nova", reason: "first" });
  assert.match(metrics.summary(24), /\(1 plays/);
  assert.match(metrics.summary(72), /\(2 plays/);
  now.advance((RETENTION_DAYS + 1) * 86400000);
  metrics.play({ user: "tv1", streamId: 1, channel: "Later", pid: "nova", reason: "first" });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [new Date(now()).toISOString().slice(0, 10) + ".jsonl"]);
});

test("data() gives the dashboard each provider's history and the plays per hour", (t) => {
  const { metrics, now } = setup(t);
  metrics.account({ pid: "polar", status: "Active", used: 5, max: 5, expires: "2027-03-21", channels: 100, leases: 0 });
  metrics.play({ user: "tv1", streamId: 1, channel: "US - CNN", pid: "nova", reason: "first" });
  metrics.play({ user: "tv1", streamId: 1, channel: "US - CNN", pid: "polar", reason: "failover", from: "nova" });
  now.advance(60000);
  const d = metrics.data(24);
  assert.deepStrictEqual(d.providers.find((p) => p.id === "polar").series, [[START, 5, 5, 0]]);
  assert.strictEqual(d.hourly.reduce((s, h) => s + h.plays, 0), 2);
  assert.strictEqual(d.hourly.reduce((s, h) => s + h.failovers, 0), 1);
  assert.deepStrictEqual(d.channels.map((c) => [c.channel, c.failedOn]), [["US - CNN", ["nova"]]]);
});
