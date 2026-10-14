const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { buildEvents, eventNumber, interleave, EVENT_BASE } = require("../xtream/events");
const { createXtreamRouter, tileCountry } = require("../xtream/api");

const NOW = Date.UTC(2026, 9, 12, 23, 0);
const HOUR = 3600 * 1000;

function m(pid, src) {
  return { _pid: pid, _src: `iptv_live_${src}`, url: `http://${pid}.example/live/u/p/${src}.m3u8` };
}

function tile(id, key, name, members, extra = {}) {
  return { id, _key: key, name, logo: extra.logo || null, _members: members, _primary: members, _groups: [extra.group || "US| SPORTS"], _epg: extra.epg || null, _catchup: null, archiveDays: 0 };
}

function event(id, title, start, channels, extra = {}) {
  return { id, title, start, end: start + 3 * HOUR, sources: ["NFL"], channels: channels.map((c) => ({ id: c, slot: c, source: "NFL" })), assumedDay: false, ...extra };
}

function fakePool() {
  const tiles = [
    tile("t-espn", "US|ESPN", "ESPN", [m("teck", 1), m("nova", 1)], { epg: "teck/espn", logo: "http://logo/espn.png" }),
    tile("t-sky", "UK|SKYSPORTSMAINEVENT", "Sky Sports Main Event", [m("nova", 2)], { group: "UK| SPORTS" }),
    tile("t-dazn", "DE|DAZN1", "DAZN 1", [m("de", 3)], { group: "DE| SPORT" }),
    tile("t-cbs", "CALL|WCBS|CBS", "CBS 2 New York", [m("teck", 4), m("elite", 4)]),
  ];
  const events = [
    event("iptv_ev_live", "Bills @ Chiefs", NOW - HOUR, ["t-cbs", "t-espn"]),
    event("iptv_ev_soon", "Arsenal vs Chelsea", NOW + 30 * 60000, ["t-sky", "t-dazn"]),
    event("iptv_ev_de", "Bayern vs Dortmund", NOW - HOUR, ["t-dazn"]),
    event("iptv_ev_later", "Lakers @ Celtics", NOW + 5 * HOUR, ["t-espn"]),
    event("iptv_ev_done", "Yankees @ Red Sox", NOW - HOUR, ["t-espn"], { final: true }),
  ];
  return {
    channels: tiles,
    tileById: new Map(tiles.map((t) => [t.id, t])),
    epgData: { "teck/espn": [{ s: 1, e: 2, t: "x" }] },
    childById: new Map([["teck", { providerName: "xtream", config: {} }]]),
    liveEventIndex: () => new Map(events.map((e) => [e.id, e])),
    eventChannels: (e) => e.channels,
    formatEventTime: () => "7:30 PM EDT",
    accounts: { at: Date.now(), byId: new Map() },
    accountStatus: async () => new Map(),
    updateData: () => Promise.resolve(),
  };
}

test("interleave takes each channel's first member, then the second, without repeats", () => {
  const out = interleave([[m("a", 1), m("b", 1)], [m("c", 2)], [m("a", 1), m("d", 3)]], 10);
  assert.deepStrictEqual(out.map((x) => `${x._pid}/${x._src}`), ["a/iptv_live_1", "c/iptv_live_2", "b/iptv_live_1", "d/iptv_live_3"]);
  assert.strictEqual(interleave([[m("a", 1), m("b", 1)], [m("c", 2)]], 2).length, 2);
});

test("event numbers sit above channel numbers, stay put, and avoid clashes", () => {
  const taken = new Set();
  const a = eventNumber("iptv_ev_live", taken);
  assert.ok(a >= EVENT_BASE && a < 2 ** 31);
  assert.strictEqual(eventNumber("iptv_ev_live", new Set()), a);
  taken.add(a);
  assert.strictEqual(eventNumber("iptv_ev_live", taken), a + 1);
});

test("live and upcoming events become channels, filtered by country", () => {
  const pool = fakePool();
  const { entries, byStreamId } = buildEvents(pool, { countries: ["UK", "US"], categoryId: 7, tileCountry, now: NOW });
  assert.deepStrictEqual(entries.map((e) => e.stream.name), ["Bills @ Chiefs", "Arsenal vs Chelsea · 7:30 PM EDT"]);
  const bills = entries[0];
  assert.deepStrictEqual(bills.tile._members.map((x) => x._pid), ["teck", "teck", "elite", "nova"], "CBS first, then ESPN, then their backups");
  assert.strictEqual(bills.stream.epg_channel_id, "teck.espn", "the first ranked channel with guide data");
  assert.strictEqual(bills.stream.stream_icon, "http://logo/espn.png");
  assert.strictEqual(bills.stream.category_id, "7");
  const arsenal = entries[1].tile;
  assert.deepStrictEqual(arsenal._members.map((x) => x._pid), ["nova"], "DAZN Germany is outside US + UK");
  assert.strictEqual(byStreamId.get(entries[0].stream.stream_id), bills.tile);

  const all = buildEvents(pool, { countries: [], categoryId: 7, tileCountry, now: NOW });
  assert.strictEqual(all.entries.length, 3, "with no country filter the German game is listed too");
});

async function start(t) {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "xtream-live-"));
  const usersFile = path.join(dir, "users.json");
  fs.writeFileSync(usersFile, JSON.stringify({ users: [{ username: "tv1", password: "fakepassword123", countries: ["US", "UK"] }] }));
  const pool = fakePool();
  const app = express();
  app.use(createXtreamRouter({ usersFile, idsFile: null, getPool: async () => ({ pool, touch() {} }), log: { log() {}, error() {} } }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, q: "username=tv1&password=fakepassword123" };
}

test("Live Now is the first category and plays through the event's channels", async (t) => {
  const realNow = Date.now;
  Date.now = () => NOW;
  t.after(() => { Date.now = realNow; });
  const { base, q } = await start(t);
  const cats = await (await fetch(`${base}/player_api.php?${q}&action=get_live_categories`)).json();
  assert.strictEqual(cats[0].category_name, "Live Now");
  const all = await (await fetch(`${base}/player_api.php?${q}&action=get_live_streams`)).json();
  assert.deepStrictEqual(all.slice(0, 2).map((s) => s.name), ["Bills @ Chiefs", "Arsenal vs Chelsea · 7:30 PM EDT"]);
  assert.ok(all.some((s) => s.name === "ESPN"), "the normal channels follow");
  const live = await (await fetch(`${base}/player_api.php?${q}&action=get_live_streams&category_id=${cats[0].category_id}`)).json();
  assert.strictEqual(live.length, 2);
  assert.deepStrictEqual(live[0].pool_event, { title: "Football", category: "Football", start: (NOW - HOUR) / 1000, end: (NOW + 2 * HOUR) / 1000 });
  assert.strictEqual(all.find((s) => s.name === "ESPN").pool_event, undefined, "ordinary channels have no pool_event");
  const info = await (await fetch(`${base}/player_api.php?${q}&action=pool_info`)).json();
  assert.ok(info.features.includes("event_info"));

  const id = live[0].stream_id;
  const go = (n) => fetch(`${base}/live/tv1/fakepassword123/${id}.ts?try=${n}`, { redirect: "manual" });
  assert.strictEqual((await go(0)).headers.get("location"), "http://teck.example/live/u/p/4.ts");
  assert.strictEqual((await go(1)).headers.get("location"), "http://teck.example/live/u/p/1.ts", "next in order: ESPN on teck");
  assert.strictEqual((await go(2)).headers.get("location"), "http://elite.example/live/u/p/4.ts");
});
