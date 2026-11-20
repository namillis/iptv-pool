const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { Relay, syncOffset, TS_PACKET } = require("../xtream/relay");
const { SourceRecord } = require("../xtream/relayClient");
const { OUT_VIDEO_PID } = require("../xtream/tsNormalizer");
const { FakeTs, parse } = require("./tsFixture");

/**
 * A fake provider. Each path is a behaviour: /ok/<tag> streams packets, /refuse answers 401, /stall/<tag>
 * sends a little then goes quiet, /html answers 200 with a web page, /hop redirects to /ok/<tag>.
 */
async function provider(t) {
  const opened = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const [, kind, tag] = req.url.split("/");
    opened.push(req.url);
    if (kind === "refuse") return res.writeHead(401).end();
    if (kind === "html") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html>" + "x".repeat(40000) + "</html>");
    if (kind === "hop") return res.writeHead(302, { Location: `/ok/${tag}` }).end();
    res.writeHead(200, { "Content-Type": "video/mp2t" });
    // Each provider has its own PIDs and clock, as real ones do.
    const value = Number(tag);
    const src = new FakeTs({ tag: value, pmtPid: 0x20 + value, videoPid: 0x40 + value, audioPid: 0x60 + value, clock: value * 10_000_000 });
    let frames = 0;
    res.write(src.chunk(12));
    const timer = setInterval(() => {
      if (kind === "stall" && frames >= 40) return;
      const out = [];
      for (let i = 0; i < 10; i++) out.push(...src.frameOut(60));
      res.write(Buffer.concat(out));
      frames += 10;
    }, 20);
    res.on("close", () => clearInterval(timer));
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, opened, open: () => sockets.size };
}

async function relayServer(t, opts = {}) {
  const sent = [];
  const lines = [];
  const relay = new Relay({ send: (m) => sent.push(m), log: (l) => lines.push(l), ...opts });
  const server = http.createServer((req, res) => relay.serve(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { relay, sent, lines, url: (id) => `http://127.0.0.1:${server.address().port}/relay/${id}.ts` };
}

const ID = (n) => String(n).padStart(32, "0");
const cand = (base, path, pid, extra = {}) => ({ key: `${pid}/${path}`, pid, url: `${base}/${path}`, ...extra });

/** Reads a relay stream until [until] says stop; returns the payload tags seen in order (one per run) and the status. */
function watch(url, until) {
  return new Promise((resolve, reject) => {
    const tags = [];
    let bytes = 0;
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode, location: res.headers.location, tags, bytes });
      }
      let rest = Buffer.alloc(0);
      res.on("data", (chunk) => {
        const buf = Buffer.concat([rest, chunk]);
        const whole = buf.length - (buf.length % TS_PACKET);
        for (const p of parse(buf.subarray(0, whole))) {
          if (p.pid !== OUT_VIDEO_PID || p.start) continue;
          if (tags[tags.length - 1] !== p.first) tags.push(p.first);
        }
        rest = buf.subarray(whole);
        bytes += chunk.length;
        if (until({ tags, bytes })) {
          req.destroy();
          resolve({ status: 200, tags, bytes });
        }
      });
      res.on("end", () => resolve({ status: 200, tags, bytes, ended: true }));
    });
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("syncOffset finds the first of three packets in a row", () => {
  const buf = Buffer.concat([Buffer.from([1, 2, 0x47, 9]), new FakeTs().chunk(1)]);
  assert.strictEqual(syncOffset(buf), 4);
  assert.strictEqual(syncOffset(Buffer.alloc(1000, 0x20)), -1);
});

test("the relay plays the first stream that sends video, passing over refusals and web pages", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t);
  r.relay.open({ id: ID(1), user: "tv1", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC",
    candidates: [cand(p.base, "refuse", "a"), cand(p.base, "html", "b"), cand(p.base, "hop/3", "c")] });
  const got = await watch(r.url(ID(1)), ({ bytes }) => bytes > 50000);
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.tags, [3]);
  const outcomes = r.sent.filter((m) => m.type === "outcome");
  assert.deepStrictEqual(outcomes.map((o) => [o.pid, o.ok, !!o.refused]), [["a", false, true], ["b", false, false], ["c", true, false]]);
  assert.strictEqual(outcomes[2].streamId, 7);
  const held = r.sent.filter((m) => m.type === "held").pop();
  assert.deepStrictEqual(held.byPid, { c: 1 }, "only the stream playing holds a provider connection");
});

test("a TV that gives up during the race leaves no provider connection open", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t);
  r.relay.open({ id: ID(10), user: "tv1", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC", candidates: [cand(p.base, "ok/8", "a")] });
  await new Promise((resolve) => {
    const req = http.get(r.url(ID(10)));
    req.on("error", () => {});
    setImmediate(() => {
      req.destroy();
      resolve();
    });
  });
  await sleep(3600);
  assert.strictEqual(p.open(), 0);
});

test("a stream that stalls mid-show moves to the next one on the same connection", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t, { stallMs: 300 });
  r.relay.open({ id: ID(2), user: "tv1", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC",
    candidates: [cand(p.base, "stall/1", "a"), cand(p.base, "ok/2", "b")] });
  const got = await watch(r.url(ID(2)), ({ tags }) => tags.includes(2) && tags.length >= 2);
  assert.deepStrictEqual(got.tags, [1, 2]);
  assert.ok(r.lines.some((l) => /a stalled/.test(l) && /moved|trying/.test(l)));
  assert.ok(r.lines.some((l) => /moved to b/.test(l)));
});

test("two TVs on the same channel share one provider connection", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t);
  const candidates = [cand(p.base, "ok/4", "a")];
  r.relay.open({ id: ID(3), user: "tv1", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC", candidates });
  const first = watch(r.url(ID(3)), ({ bytes }) => bytes > 400000);
  await sleep(300);
  r.relay.open({ id: ID(4), user: "tv2", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC", candidates });
  const second = await watch(r.url(ID(4)), ({ bytes }) => bytes > 50000);
  assert.deepStrictEqual(second.tags, [4]);
  assert.strictEqual(p.opened.filter((u) => u === "/ok/4").length, 1);
  await first;
});

test("when the server is refused everywhere, the TV is sent to the refused stream directly", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t);
  r.relay.open({ id: ID(5), user: "tv1", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC",
    candidates: [cand(p.base, "refuse", "a"), cand(p.base, "ok/9", "b", { redirectOnly: true })] });
  const got = await watch(r.url(ID(5)), () => true);
  assert.strictEqual(got.status, 302);
  assert.strictEqual(got.location, `${p.base}/ok/9`);
});

test("an unknown session is a 404, and a session registered just after the request still plays", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t);
  assert.strictEqual((await watch(r.url(ID(6)), () => true)).status, 404);
  const late = watch(r.url(ID(7)), ({ bytes }) => bytes > 20000);
  await sleep(100);
  r.relay.open({ id: ID(7), user: "tv1", userMax: 1, streamId: 7, channel: "NBC", channelKey: "US|NBC", candidates: [cand(p.base, "ok/5", "a")] });
  assert.deepStrictEqual((await late).tags, [5]);
});

test("switching channels closes the provider connection of the channel left behind", async (t) => {
  const p = await provider(t);
  const r = await relayServer(t);
  r.relay.open({ id: ID(8), user: "tv1", userMax: 1, streamId: 7, channel: "A", channelKey: "US|A", candidates: [cand(p.base, "ok/6", "a")] });
  await watch(r.url(ID(8)), ({ bytes }) => bytes > 20000);
  await sleep(100);
  assert.strictEqual(p.open(), 1, "the idle grace keeps it a moment for a quick reconnect");
  r.relay.open({ id: ID(9), user: "tv1", userMax: 1, streamId: 8, channel: "B", channelKey: "US|B", candidates: [cand(p.base, "ok/7", "a")] });
  await sleep(100);
  assert.strictEqual(p.open(), 0);
});

test("the source record puts streams that just failed last and good ones first", () => {
  let t = 1_800_000_000_000;
  const rec = new SourceRecord({ now: () => t });
  const m = (pid, src) => ({ _pid: pid, _src: src });
  const key = (x) => `${x._pid}/${x._src}`;
  const members = [m("a", 1), m("b", 2), m("c", 3)];
  assert.deepStrictEqual(rec.order(members, key).map((x) => x._pid), ["a", "b", "c"], "no record keeps the pool's order");

  rec.record({ key: "a/1", pid: "a", ok: false, why: "HTTP 401" });
  for (let i = 0; i < 3; i++) rec.record({ key: "c/3", pid: "c", ok: true, started: true });
  assert.deepStrictEqual(rec.order(members, key).map((x) => x._pid), ["c", "b", "a"]);

  t += 3 * 60 * 1000;
  assert.ok(!rec.recentlyFailed("a/1"));
  assert.deepStrictEqual(rec.order(members, key).map((x) => x._pid), ["c", "b", "a"], "a's failure still lowers its score");

  rec.record({ key: "b/2", pid: "b", ok: false, why: "stalled", playedMs: 5 * 60 * 1000 });
  assert.ok(!rec.recentlyFailed("b/2"), "a drop after minutes of play is not a failed stream");
  assert.deepStrictEqual(rec.order(members, key, (pid) => pid === "c").map((x) => x._pid), ["b", "a", "c"], "a full account goes after the rest");
});

test("a provider that refuses the server three times in a row is handed to TVs directly for a while", () => {
  let t = 1_800_000_000_000;
  const rec = new SourceRecord({ now: () => t });
  for (let i = 0; i < 2; i++) rec.record({ key: `u/${i}`, pid: "u", ok: false, refused: true });
  assert.ok(!rec.redirectOnly("u"));
  rec.record({ key: "u/9", pid: "u", ok: false, refused: true });
  assert.ok(rec.redirectOnly("u"));
  t += 31 * 60 * 1000;
  assert.ok(!rec.redirectOnly("u"), "after a while the server tries it again");
  rec.record({ key: "u/9", pid: "u", ok: false, refused: true });
  assert.ok(rec.redirectOnly("u"), "one more refusal after the retry is enough");
  rec.record({ key: "u/1", pid: "u", ok: true, started: true });
  assert.ok(!rec.redirectOnly("u"), "a stream that plays clears it");
});

test("a refusal while the provider's account is full doesn't make it redirect-only", () => {
  const full = new Set(["u"]);
  const rec = new SourceRecord({ accountFull: (pid) => full.has(pid) });
  for (let i = 0; i < 3; i++) rec.record({ key: `u/${i}`, pid: "u", ok: false, refused: true });
  assert.ok(!rec.redirectOnly("u"));
  full.clear();
  for (let i = 0; i < 3; i++) rec.record({ key: `u/${i}`, pid: "u", ok: false, refused: true });
  assert.ok(rec.redirectOnly("u"));
});
