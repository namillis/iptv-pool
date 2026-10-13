const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { Playback, memberUrl, convertStart } = require("../xtream/playback");
const { createXtreamRouter } = require("../xtream/api");

function member(pid, src, base = `http://${pid}.example`) {
  return { _pid: pid, _src: `iptv_live_${src}`, url: `${base}/live/${pid}user/${pid}pass/${src}.m3u8` };
}

function tile(key, name, members, extra = {}) {
  return { _key: key, name, logo: null, _members: members, _groups: ["US| SPORTS"], _epg: null, _catchup: extra.catchup || null, archiveDays: extra.archiveDays || 0 };
}

const user = (username = "tv1", maxConnections = 1) => ({ username, maxConnections });
const status = (entries) => new Map(Object.entries(entries));

function clock(start = 1_800_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

test("memberUrl keeps the requested extension for Xtream links and leaves others alone", () => {
  assert.strictEqual(memberUrl(member("teck", 5), "ts"), "http://teck.example/live/teckuser/teckpass/5.ts");
  assert.strictEqual(memberUrl({ url: "https://cdn.example/espn/index.m3u8" }, "ts"), "https://cdn.example/espn/index.m3u8");
  assert.strictEqual(memberUrl({ url: "" }, "ts"), null);
});

test("convertStart turns a UTC start into the provider's wall time, across DST", () => {
  assert.strictEqual(convertStart("2026-10-12:20-00", "America/New_York"), "2026-10-12:16-00");
  assert.strictEqual(convertStart("2026-12-01:20-00", "America/New_York"), "2026-12-01:15-00");
  assert.strictEqual(convertStart("2026-11-01:05-30", "America/New_York"), "2026-11-01:01-30");
  assert.strictEqual(convertStart("2026-11-01:06-30", "America/New_York"), "2026-11-01:01-30");
  assert.strictEqual(convertStart("2026-10-12:23-30", "Europe/London"), "2026-10-13:00-30");
  assert.strictEqual(convertStart("2026-10-12:20-00", "UTC"), "2026-10-12:20-00");
  assert.strictEqual(convertStart("2026-10-12:20-00", "Not/AZone"), "2026-10-12:20-00");
  assert.strictEqual(convertStart("2026-10-12 20:00", "UTC"), null);
});

test("picks the first member, and skips a provider whose account is full", () => {
  const pb = new Playback({ now: clock() });
  const espn = tile("US|ESPN", "ESPN", [member("teck", 1), member("nova", 2)]);
  assert.strictEqual(pb.live(user(), 10, espn, "ts", null).member._pid, "teck");

  const busy = status({ teck: { maxConnections: 1, activeConnections: 1 } });
  const pick = new Playback({ now: clock() }).live(user(), 10, espn, "ts", busy);
  assert.strictEqual(pick.member._pid, "nova");
  assert.strictEqual(pick.reason, "skipped-busy");
});

test("a channel switch frees the provider the old channel used", () => {
  const pb = new Playback({ now: clock() });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const b = tile("US|B", "B", [member("teck", 2), member("nova", 2)]);
  const teckOne = status({ teck: { maxConnections: 1, activeConnections: 1 } });
  assert.strictEqual(pb.live(user(), 1, a, "ts", status({ teck: { maxConnections: 1, activeConnections: 0 } })).member._pid, "teck");
  assert.strictEqual(pb.live(user(), 2, b, "ts", teckOne).member._pid, "teck", "the TV's own stream doesn't count against it");
  assert.strictEqual(pb.activeCount("tv1"), 1);
});

test("two TVs on a one-connection provider: the second goes elsewhere", () => {
  const pb = new Playback({ now: clock() });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const st = status({ teck: { maxConnections: 1, activeConnections: 0 } });
  assert.strictEqual(pb.live(user("tv1"), 1, a, "ts", st).member._pid, "teck");
  assert.strictEqual(pb.live(user("tv2"), 1, a, "ts", st).member._pid, "nova");
});

test("a repeat request within a minute fails over to the next member", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1), member("elite", 1)]);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null).member._pid, "teck");
  now.advance(5000);
  const second = pb.live(user(), 1, a, "ts", null);
  assert.strictEqual(second.member._pid, "nova");
  assert.strictEqual(second.reason, "failover");
  now.advance(5000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null).member._pid, "elite");
  now.advance(5000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null).member._pid, "teck", "all failed: start over");
});

test("coming back to a channel after a minute is not a failure", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  pb.live(user(), 1, a, "ts", null);
  now.advance(61000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null).member._pid, "teck");
});

test("HLS playlist re-fetches stay on the same member", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  pb.live(user(), 1, a, "m3u8", null);
  for (let i = 0; i < 5; i++) {
    now.advance(6000);
    assert.strictEqual(pb.live(user(), 1, a, "m3u8", null).member._pid, "teck");
  }
});

test("after a switch on the same provider, LiveWire's quick connection retries keep the same member", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const b = tile("US|B", "B", [member("teck", 2), member("nova", 2)]);
  pb.live(user(), 1, a, "ts", null);
  now.advance(30000);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null).member._pid, "teck");
  now.advance(1500);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null).reason, "settling");
  now.advance(3000);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null).member._pid, "teck");
  now.advance(2000);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null).member._pid, "nova", "the user's retry fails over");
});

test("leases run out after 4 hours", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const st = status({ teck: { maxConnections: 1, activeConnections: 0 } });
  pb.live(user("tv1"), 1, a, "ts", st);
  now.advance(4 * 3600 * 1000 + 1);
  assert.strictEqual(pb.live(user("tv2"), 1, a, "ts", st).member._pid, "teck");
});

test("everything busy still hands out the first member", () => {
  const pb = new Playback({ now: clock() });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const full = status({ teck: { maxConnections: 1, activeConnections: 1 }, nova: { maxConnections: 2, activeConnections: 2 } });
  const pick = pb.live(user(), 1, a, "ts", full);
  assert.strictEqual(pick.member._pid, "teck");
  assert.strictEqual(pick.reason, "all-busy");
});

function fakePool() {
  const catchup = member("uk1", 77, "http://uk1.example:8080");
  const cnnNova = { ...member("nova", 4), archive: true };
  const cnn = [cnnNova, member("teck", 4), { ...member("nova", 40), archive: true }, { ...member("ksenqw", 5), archive: true }];
  const channels = [
    tile("US|ESPN", "ESPN", [member("teck", 1), member("nova", 2)]),
    tile("UK|SKYSPORTSMAIN", "Sky Sports Main Event", [member("nova", 3), catchup], { catchup, archiveDays: 7 }),
    tile("US|IPTVORG", "Some FAST channel", [{ _pid: "org", _src: "x", url: "https://cdn.example/fast/index.m3u8" }]),
    tile("US|CNN", "CNN", cnn, { catchup: cnnNova, archiveDays: 2 }),
  ];
  const cfg = (pid) => ({ providerName: "xtream", config: { xtreamUrl: `http://${pid}.example${pid === "uk1" ? ":8080" : ""}`, xtreamUsername: `${pid}user`, xtreamPassword: `${pid}pass` } });
  const pool = {
    channels,
    epgData: {},
    childById: new Map([["teck", cfg("teck")], ["nova", cfg("nova")], ["uk1", cfg("uk1")], ["ksenqw", cfg("ksenqw")], ["org", { providerName: "direct", config: {} }]]),
    catchupEnabledFor: (m) => !!m.archive,
    accounts: null,
    statusCalls: 0,
    async accountStatus() {
      this.statusCalls++;
      const byId = new Map([["uk1", { maxConnections: 2, activeConnections: 0, serverTimezone: "Europe/London" }]]);
      this.accounts = { at: Date.now(), byId };
      return byId;
    },
    updateData: () => Promise.resolve(),
  };
  return pool;
}

async function start(t, { fetchImpl, now, archiveFile } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "xtream-play-"));
  const usersFile = path.join(dir, "users.json");
  fs.writeFileSync(usersFile, JSON.stringify({ users: [{ username: "tv1", password: "grapecloverplanet" }] }));
  const pool = fakePool();
  const app = express();
  const router = createXtreamRouter({ usersFile, idsFile: null, archiveFile, getPool: async () => ({ pool, touch() {} }), log: { log() {}, error() {} }, fetchImpl, now });
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = "username=tv1&password=grapecloverplanet";
  const streams = await (await fetch(`${base}/player_api.php?${q}&action=get_live_streams`)).json();
  const id = (name) => streams.find((s) => s.name === name).stream_id;
  const get = (p) => fetch(base + p, { redirect: "manual" });
  const live = async () => (await fetch(`${base}/player_api.php?${q}&action=get_live_streams`)).json();
  const table = async (streamId) => (await fetch(`${base}/player_api.php?${q}&action=get_simple_data_table&stream_id=${streamId}`)).json();
  return { base, q, id, get, pool, live, table, router };
}

const LISTING = { title: "VGVzdA==", start_timestamp: "1", stop_timestamp: "2", has_archive: 1 };

/** A fake provider API: [lists] maps a provider to its catch-up answer ("empty", "fail" or listings). */
function tables(lists) {
  const calls = [];
  const fetchImpl = async (url) => {
    const pid = new URL(url).hostname.split(".")[0];
    calls.push(pid);
    const answer = lists[pid] || "empty";
    if (answer === "fail") throw new Error("timeout");
    return { ok: true, json: async () => ({ epg_listings: answer === "empty" ? [] : answer }) };
  };
  return { calls, fetchImpl };
}

test("live and archive redirects over HTTP", async (t) => {
  const { base, id, get, q } = await start(t);
  const espn = id("ESPN");
  let r = await get(`/live/tv1/grapecloverplanet/${espn}.ts`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get("location"), "http://teck.example/live/teckuser/teckpass/1.ts");
  assert.strictEqual(r.headers.get("cache-control"), "no-store");

  r = await get(`/live/tv1/grapecloverplanet/${espn}.ts`);
  assert.strictEqual(r.headers.get("location"), "http://nova.example/live/novauser/novapass/2.ts", "retry fails over");

  r = await get(`/live/tv1/grapecloverplanet/${id("Some FAST channel")}.ts`);
  assert.strictEqual(r.headers.get("location"), "https://cdn.example/fast/index.m3u8");

  assert.strictEqual((await get(`/live/tv1/wrong-password-x/${espn}.ts`)).status, 401);
  assert.strictEqual((await get(`/live/tv1/grapecloverplanet/999999.ts`)).status, 404);
  assert.strictEqual((await get(`/live/tv1/grapecloverplanet/${espn}.mkv`)).status, 404);

  const sky = id("Sky Sports Main Event");
  r = await get(`/timeshift/tv1/grapecloverplanet/90/2026-10-12:19-00/${sky}.ts`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get("location"), "http://uk1.example:8080/timeshift/uk1user/uk1pass/90/2026-10-12:20-00/77.ts");
  r = await get(`/streaming/timeshift.php?username=tv1&password=grapecloverplanet&stream=${sky}&start=2026-10-12:19-00&duration=90`);
  assert.strictEqual(r.headers.get("location"), "http://uk1.example:8080/streaming/timeshift.php?username=uk1user&password=uk1pass&stream=77&start=2026-10-12%3A20-00&duration=90");
  assert.strictEqual((await get(`/timeshift/tv1/grapecloverplanet/90/2026-10-12:19-00/${espn}.ts`)).status, 404, "no archive");
  assert.strictEqual((await get(`/timeshift/tv1/grapecloverplanet/abc/2026-10-12:19-00/${sky}.ts`)).status, 400);

  const login = await (await fetch(`${base}/player_api.php?${q}`)).json();
  assert.strictEqual(login.user_info.active_cons, "1");
});

test("catch-up listings come from the provider that has the archive, cached", async (t) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ epg_listings: [{ title: "VGVzdA==", start_timestamp: "1", stop_timestamp: "2", has_archive: 1 }] }) };
  };
  const { base, q, id } = await start(t, { fetchImpl });
  const sky = id("Sky Sports Main Event");
  const body = await (await fetch(`${base}/player_api.php?${q}&action=get_simple_data_table&stream_id=${sky}`)).json();
  assert.strictEqual(body.epg_listings.length, 1);
  await fetch(`${base}/player_api.php?${q}&action=get_simple_data_table&stream_id=${sky}`);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /^http:\/\/uk1\.example:8080\/player_api\.php\?username=uk1user&password=uk1pass&action=get_simple_data_table&stream_id=77$/);
  const none = await (await fetch(`${base}/player_api.php?${q}&action=get_simple_data_table&stream_id=${id("ESPN")}`)).json();
  assert.deepStrictEqual(none, { epg_listings: [] });
  assert.strictEqual(calls.length, 1);
});

test("a failing catch-up lookup returns an empty list", async (t) => {
  const { base, q, id } = await start(t, { fetchImpl: async () => { throw new Error("timeout"); } });
  const body = await (await fetch(`${base}/player_api.php?${q}&action=get_simple_data_table&stream_id=${id("Sky Sports Main Event")}`)).json();
  assert.deepStrictEqual(body, { epg_listings: [] });
});

test("an empty list falls back to the next provider's catch-up, and replays play from it", async (t) => {
  const { calls, fetchImpl } = tables({ ksenqw: [LISTING] });
  const { id, get, table } = await start(t, { fetchImpl });
  const cnn = id("CNN");
  assert.strictEqual((await table(cnn)).epg_listings.length, 1);
  assert.deepStrictEqual(calls, ["nova", "ksenqw"], "one stream per provider, and not the one without catch-up");
  await table(cnn);
  assert.strictEqual(calls.length, 2, "cached");
  const r = await get(`/timeshift/tv1/grapecloverplanet/60/2026-10-12:19-00/${cnn}.ts`);
  assert.strictEqual(r.headers.get("location"), "http://ksenqw.example/timeshift/ksenqwuser/ksenqwpass/60/2026-10-12:19-00/5.ts");
});

test("a channel with no listings anywhere stops advertising catch-up, and is checked again after 12 hours", async (t) => {
  const now = clock();
  const { calls, fetchImpl } = tables({});
  const { id, live, table } = await start(t, { fetchImpl, now });
  const cnn = id("CNN");
  const archived = async () => (await live()).find((s) => s.stream_id === cnn).tv_archive;
  assert.deepStrictEqual(await table(cnn), { epg_listings: [] });
  assert.deepStrictEqual(calls, ["nova", "ksenqw"]);
  assert.strictEqual(await archived(), 1, "the lineup is rebuilt for this at most once a minute");
  now.advance(61 * 1000);
  assert.strictEqual(await archived(), 0);
  now.advance(12 * 3600 * 1000);
  assert.strictEqual(await archived(), 1);
});

test("a failed catch-up request hides nothing", async (t) => {
  const now = clock();
  const { calls, fetchImpl } = tables({ nova: "fail" });
  const { id, live, table } = await start(t, { fetchImpl, now });
  const cnn = id("CNN");
  assert.deepStrictEqual(await table(cnn), { epg_listings: [] });
  assert.deepStrictEqual(calls, ["nova", "ksenqw"]);
  now.advance(61 * 1000);
  assert.strictEqual((await live()).find((s) => s.stream_id === cnn).tv_archive, 1);
  await table(cnn);
  assert.strictEqual(calls.length, 4, "not cached, so the next look tries again");
});

test("the provider that had listings stays first, and survives a restart", async (t) => {
  const archiveFile = path.join(fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "xtream-archive-")), "archive.json");
  const first = tables({ ksenqw: [LISTING] });
  const a = await start(t, { fetchImpl: first.fetchImpl, archiveFile });
  await a.table(a.id("CNN"));
  a.router.flush();
  const again = tables({ ksenqw: [LISTING], nova: [LISTING] });
  const b = await start(t, { fetchImpl: again.fetchImpl, archiveFile });
  assert.strictEqual((await b.table(b.id("CNN"))).epg_listings.length, 1);
  assert.deepStrictEqual(again.calls, ["ksenqw"]);
});

test("stream requests are rate limited per login", async (t) => {
  const { get, id } = await start(t);
  const espn = id("ESPN");
  let last;
  for (let i = 0; i < 31; i++) last = await get(`/live/tv1/grapecloverplanet/${espn}.m3u8`);
  assert.strictEqual(last.status, 429);
});

test("with attempt numbers, only a higher attempt fails over", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1), member("elite", 1)]);
  const sig = (attempt, refused = false) => ({ attempt, refused });
  assert.strictEqual(pb.live(user(), 1, a, "ts", null, sig(0)).member._pid, "teck");
  now.advance(2000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null, sig(0)).reason, "same", "a reopen at the same attempt is not a failure");
  now.advance(2000);
  const retry = pb.live(user(), 1, a, "ts", null, sig(1));
  assert.strictEqual(retry.member._pid, "nova");
  assert.strictEqual(retry.reason, "failover");
  now.advance(2000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null, sig(1)).member._pid, "nova", "the same attempt twice fails over once");
  now.advance(5 * 60 * 1000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null, sig(2)).member._pid, "teck", "a retry long after the first play still fails over; teck's failure has expired");
});

test("with attempt numbers, a refused retry right after a same-provider switch stays put", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const b = tile("US|B", "B", [member("teck", 2), member("nova", 2)]);
  pb.live(user(), 1, a, "ts", null, { attempt: 0, refused: false });
  now.advance(30000);
  pb.live(user(), 2, b, "ts", null, { attempt: 0, refused: false });
  now.advance(1500);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null, { attempt: 1, refused: true }).reason, "settling");
  now.advance(3000);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null, { attempt: 2, refused: true }).member._pid, "teck");
  now.advance(2000);
  assert.strictEqual(pb.live(user(), 2, b, "ts", null, { attempt: 3, refused: false }).member._pid, "nova", "a plain retry fails over");
});

test("stop frees the provider for another TV", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1)]);
  const st = status({ teck: { maxConnections: 1, activeConnections: 0 } });
  pb.live(user("tv1"), 1, a, "ts", st);
  assert.strictEqual(pb.stop("tv1", 1), 0, "a stop within 5 s of the request is for the previous session");
  now.advance(6000);
  assert.strictEqual(pb.stop("tv1", 99), 0, "another stream id releases nothing");
  assert.strictEqual(pb.stop("tv1", 1), 1);
  assert.strictEqual(pb.live(user("tv2"), 1, a, "ts", st).member._pid, "teck");
  pb.archive(user("tv1"), 5, member("teck", 5));
  now.advance(6000);
  assert.strictEqual(pb.stop("tv1", 5), 1, "an archive lease is released by its stream id");
  assert.strictEqual(pb.stop("nobody"), 0);
});

test("pool_info, pool_stop and the try parameter over HTTP", async (t) => {
  const now = clock(Date.now());
  const { base, q, id, get } = await start(t, { now });
  const info = await (await fetch(`${base}/player_api.php?${q}&action=pool_info`)).json();
  assert.deepStrictEqual(info, { pool: 1, version: 1, features: ["retry", "stop", "sources", "event_info"] });
  const bad = await (await fetch(`${base}/player_api.php?username=tv1&password=wrong-pass-123&action=pool_info`)).json();
  assert.deepStrictEqual(bad, { user_info: { auth: 0 } });

  const espn = id("ESPN");
  let r = await get(`/live/tv1/grapecloverplanet/${espn}.ts?try=0`);
  assert.strictEqual(r.headers.get("location"), "http://teck.example/live/teckuser/teckpass/1.ts");
  r = await get(`/live/tv1/grapecloverplanet/${espn}.ts?try=0`);
  assert.strictEqual(r.headers.get("location"), "http://teck.example/live/teckuser/teckpass/1.ts");
  r = await get(`/live/tv1/grapecloverplanet/${espn}.ts?try=1`);
  assert.strictEqual(r.headers.get("location"), "http://nova.example/live/novauser/novapass/2.ts");

  let login = await (await fetch(`${base}/player_api.php?${q}`)).json();
  assert.strictEqual(login.user_info.active_cons, "1");
  now.advance(6000);
  const stopped = await (await fetch(`${base}/player_api.php?${q}&action=pool_stop&stream_id=${espn}`)).json();
  assert.deepStrictEqual(stopped, { ok: 1, released: 1 });
  login = await (await fetch(`${base}/player_api.php?${q}`)).json();
  assert.strictEqual(login.user_info.active_cons, "0");
  assert.strictEqual((await fetch(`${base}/player_api.php?${q}&action=pool_stop&stream_id=abc`)).status, 400);
  assert.deepStrictEqual(await (await fetch(`${base}/player_api.php?${q}&action=pool_stop`)).json(), { ok: 1, released: 0 });
});

test("a picked source plays that stream, and a later retry fails over from it", () => {
  const now = clock();
  const pb = new Playback({ now });
  const a = tile("US|A", "A", [member("teck", 1), member("nova", 1), member("elite", 1)]);
  pb.live(user(), 1, a, "ts", null, { attempt: 0, refused: false, source: null });
  now.advance(5000);
  const picked = pb.live(user(), 1, a, "ts", null, { attempt: 0, refused: false, source: "elite.1" });
  assert.strictEqual(picked.member._pid, "elite");
  assert.strictEqual(picked.reason, "picked");
  now.advance(5000);
  assert.strictEqual(pb.live(user(), 1, a, "ts", null, { attempt: 0, refused: false, source: null }).member._pid, "elite", "a reopen stays on the pick");
  assert.strictEqual(pb.live(user(), 1, a, "ts", null, { attempt: 1, refused: false, source: null }).member._pid, "teck", "a retry moves on");
  const unknown = pb.live(user(), 1, a, "ts", null, { attempt: 0, refused: false, source: "nobody.9" });
  assert.notStrictEqual(unknown.reason, "picked");
});

test("sources list the channel's streams in order and mark the current one", () => {
  const pb = new Playback({ now: clock() });
  const a = tile("US|A", "A", [
    { ...member("teck", 1), name: "US - ESPN HD ", _quality: { label: "HD" } },
    { ...member("nova", 2), name: "US| ESPN [BK]", _quality: { label: "HD backup" } },
  ]);
  pb.live(user(), 7, a, "ts", null, { attempt: 0, refused: false, source: "nova.2" });
  const names = { teck: "Main", nova: "Nova" };
  assert.deepStrictEqual(pb.sources("tv1", 7, a, (pid) => names[pid]), [
    { source: "teck.1", provider: "Main", name: "US - ESPN HD", quality: "HD", backup: false, current: false, failed: false },
    { source: "nova.2", provider: "Nova", name: "US| ESPN [BK]", quality: "HD", backup: true, current: true, failed: false },
  ]);
  assert.ok(pb.sources("tv2", 7, a, (pid) => pid).every((s) => !s.current));
});

test("pool_sources and source= over HTTP", async (t) => {
  const { base, q, id, get } = await start(t);
  const espn = id("ESPN");
  let r = await get(`/live/tv1/grapecloverplanet/${espn}.ts?try=0`);
  assert.strictEqual(r.headers.get("location"), "http://teck.example/live/teckuser/teckpass/1.ts");
  let body = await (await fetch(`${base}/player_api.php?${q}&action=pool_sources&stream_id=${espn}`)).json();
  assert.deepStrictEqual(body.sources.map((s) => [s.source, s.current]), [["teck.1", true], ["nova.2", false]]);
  r = await get(`/live/tv1/grapecloverplanet/${espn}.ts?try=0&source=nova.2`);
  assert.strictEqual(r.headers.get("location"), "http://nova.example/live/novauser/novapass/2.ts");
  body = await (await fetch(`${base}/player_api.php?${q}&action=pool_sources&stream_id=${espn}`)).json();
  assert.deepStrictEqual(body.sources.map((s) => s.current), [false, true]);
  r = await get(`/live/tv1/grapecloverplanet/${espn}.ts?try=0&source=../../etc`);
  assert.strictEqual(r.status, 302, "a malformed source is ignored, not an error");
  assert.deepStrictEqual(await (await fetch(`${base}/player_api.php?${q}&action=pool_sources&stream_id=999`)).json(), { sources: [] });
});
