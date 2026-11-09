const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const express = require("express");
const { XtreamIds } = require("../xtream/ids");
const { createXtreamRouter, buildView, buildGuide, guideWindow, tileCountry, xmltvTime, xmlEscape } = require("../xtream/api");

function tile(key, name, members, extra = {}) {
  return {
    _key: key,
    name,
    logo: extra.logo || null,
    _members: members.map(([pid, src]) => ({ _pid: pid, _src: src })),
    _groups: extra.groups || ["US| NEWS"],
    _epg: extra.epg || null,
    _catchup: extra.catchup || null,
    archiveDays: extra.archiveDays || 0,
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "xtream-test-"));
}

const gunzipJson = (buf) => JSON.parse(zlib.gunzipSync(buf).toString());

test("stream ids stay the same across merges and are never reused", () => {
  const ids = new XtreamIds(null);
  const a = tile("US|CNN", "CNN", [["teck", "1"]]);
  const b = tile("US|ESPN", "ESPN", [["teck", "2"]]);
  const first = ids.assignStreams([a, b]);
  assert.deepStrictEqual([first.get(a), first.get(b)], [1, 2]);

  const a2 = tile("US|CNN", "CNN", [["teck", "1"]]);
  const c = tile("UK|BBCONE", "BBC One", [["uk1", "9"]]);
  const second = ids.assignStreams([c, a2]);
  assert.strictEqual(second.get(a2), 1);
  assert.strictEqual(second.get(c), 3);

  const b2 = tile("US|ESPN", "ESPN", [["teck", "2"]]);
  assert.strictEqual(ids.assignStreams([b2]).get(b2), 2);
});

test("a renamed key keeps its number through a shared member", () => {
  const ids = new XtreamIds(null);
  const old = tile("US|FOXNEWS", "Fox News", [["teck", "5"], ["nova", "7"]]);
  ids.assignStreams([old]);
  const renamed = tile("US|FOXNEWSCHANNEL", "Fox News Channel", [["nova", "7"]]);
  assert.strictEqual(ids.assignStreams([renamed]).get(renamed), 1);
  assert.strictEqual(ids.state.keys["US|FOXNEWS"], undefined);
});

test("a member's old number is not taken from a tile that still has it", () => {
  const ids = new XtreamIds(null);
  const a = tile("US|A", "A", [["p", "1"], ["p", "2"]]);
  ids.assignStreams([a]);
  const a2 = tile("US|A", "A", [["p", "1"]]);
  const split = tile("US|B", "B", [["p", "2"]]);
  const got = ids.assignStreams([split, a2]);
  assert.strictEqual(got.get(a2), 1);
  assert.strictEqual(got.get(split), 2);
});

test("ids survive a save and reload", () => {
  const file = path.join(tmpDir(), "ids.json");
  const ids = new XtreamIds(file);
  const a = tile("US|CNN", "CNN", [["teck", "1"]]);
  ids.assignStreams([tile("US|X", "X", [["teck", "0"]]), a]);
  ids.categoryId("US| NEWS");
  ids.flush();
  const again = new XtreamIds(file);
  const a2 = tile("US|CNN", "CNN", [["teck", "1"]]);
  const fresh = tile("US|NEW", "New", [["teck", "3"]]);
  const got = again.assignStreams([a2, fresh]);
  assert.strictEqual(got.get(a2), 2);
  assert.strictEqual(got.get(fresh), 3);
  assert.strictEqual(again.categoryId("US| NEWS"), 1);
  assert.strictEqual(again.categoryId("UK| NEWS"), 2);
});

test("country of a tile comes from its key, local stations count as US", () => {
  assert.strictEqual(tileCountry("US|CNN"), "US");
  assert.strictEqual(tileCountry("CALL|WABC|ABC"), "US");
  assert.strictEqual(tileCountry("UK|BBCONE"), "UK");
  assert.strictEqual(tileCountry("|ESPN"), "");
  assert.strictEqual(tileCountry("RAW|???"), "RAW");
});

function fakePool() {
  return {
    channels: [
      tile("US|CNN", "CNN", [["teck", "1"]], { epg: "teck/cnn.us", logo: "http://x/cnn.png?a=1&b=2" }),
      tile("UK|BBCONE", "BBC One", [["uk1", "9"]], { groups: ["UK| ENTERTAINMENT", "UK| ALL"], catchup: { _pid: "uk1" }, archiveDays: 7 }),
      tile("CALL|WABC|ABC", "ABC 7 (WABC)", [["teck", "3"]], { groups: ["US| LOCALS"], epg: "teck/wabc" }),
      tile("DE|ARD", "ARD", [["de1", "4"]], { groups: ["DE| TV"] }),
      tile("US|MSNBC", "MSNBC", [["teck", "6"]]),
    ],
    epgData: {
      "teck/cnn.us": [{ s: 1791800000, e: 1791803600, t: "News & <Views>", d: "Desc \"quoted\"", c: ["News"], l: 1 }],
      "teck/wabc": [],
    },
    updateData: () => Promise.resolve(),
  };
}

test("a view filters by country, orders categories and indexes streams by category", () => {
  const pool = fakePool();
  const view = buildView(pool, new XtreamIds(null), ["UK", "US"], null);
  const cats = gunzipJson(view.categoriesGz);
  assert.deepStrictEqual(cats.map((c) => c.category_name), ["Local ABC", "News", "UK | Entertainment"]);
  const streams = gunzipJson(view.streamsGz);
  assert.deepStrictEqual(streams.map((s) => s.name), ["ABC 7 (WABC)", "CNN", "MSNBC", "BBC One"], "grouped by category, in category order");
  assert.deepStrictEqual(streams.map((s) => s.num), [1, 2, 3, 4]);
  const byName = new Map(streams.map((s) => [s.name, s]));
  assert.strictEqual(byName.get("CNN").epg_channel_id, "teck.cnn.us");
  assert.strictEqual(byName.get("ABC 7 (WABC)").epg_channel_id, "", "a guide id with no programmes is left out");
  assert.strictEqual(byName.get("BBC One").tv_archive, 1);
  assert.strictEqual(byName.get("BBC One").tv_archive_duration, 7);
  assert.deepStrictEqual(byName.get("BBC One").category_ids, [Number(cats[2].category_id)], "one pool category per channel");
  const news = gunzipJson(view.categoryStreams.get(cats[1].category_id));
  assert.deepStrictEqual(news.map((s) => s.name), ["CNN", "MSNBC"]);

  const all = buildView(pool, new XtreamIds(null), [], null);
  assert.strictEqual(all.count, 5);
});

test("a guide window starts on the hour, is clamped to what the pool keeps, and keeps only overlapping programmes", async () => {
  const now = Date.UTC(2026, 10, 9, 14, 40);
  const hour = Date.UTC(2026, 10, 9, 14) / 1000;
  assert.strictEqual(guideWindow({}, now), null, "no parameters is the full guide");
  assert.deepStrictEqual(guideWindow({ past_hours: "2", future_hours: "12" }, now), { pastHours: 2, futureHours: 12, from: hour - 2 * 3600, to: hour + 13 * 3600 });
  assert.deepStrictEqual(guideWindow({ past_hours: "99", future_hours: "-3" }, now), { pastHours: 6, futureHours: 1, from: hour - 6 * 3600, to: hour + 2 * 3600 });
  assert.strictEqual(guideWindow({ future_hours: "8" }, now).pastHours, 6, "a missing bound takes the pool's own");

  const window = guideWindow({ past_hours: "1", future_hours: "2" }, now);
  const at = (h) => hour + h * 3600;
  const tile = { name: "CNN", logo: null };
  const view = { entries: [{ tile, epgKey: "teck/cnn" }] };
  const epgData = { "teck/cnn": [
    { s: at(-3), e: at(-2), t: "Too early" },
    { s: at(-2), e: at(-0.5), t: "Ends inside" },
    { s: at(1), e: at(4), t: "Starts inside" },
    { s: at(3), e: at(4), t: "Too late" },
  ] };
  const g = await buildGuide(view, epgData, window);
  const xml = zlib.gunzipSync(g.body).toString();
  assert.deepStrictEqual([...xml.matchAll(/<title>([^<]+)</g)].map((m) => m[1]), ["Ends inside", "Starts inside"]);
  assert.strictEqual((await buildGuide(view, epgData)).programmes, 4, "no window keeps everything");
});

test("xmltv helpers", () => {
  assert.strictEqual(xmltvTime(0), "19700101000000 +0000");
  assert.strictEqual(xmlEscape(`a&b<c>"d'\u0001`), "a&amp;b&lt;c&gt;&quot;d&apos;");
});

async function startServer(users) {
  const dir = tmpDir();
  const usersFile = path.join(dir, "users.json");
  fs.writeFileSync(usersFile, JSON.stringify({ users }));
  const pool = fakePool();
  let touched = 0;
  const router = createXtreamRouter({
    usersFile,
    idsFile: path.join(dir, "ids.json"),
    getPool: async () => ({ pool, touch: () => touched++ }),
    log: { log() {}, error() {} },
  });
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, touched: () => touched };
}

test("player_api and xmltv over HTTP", async (t) => {
  const { base, server, touched } = await startServer([
    { username: "living-room", password: "correct-horse-battery", countries: ["us", "uk"] },
  ]);
  t.after(() => server.close());
  const q = "username=living-room&password=correct-horse-battery";

  const bad = await (await fetch(`${base}/player_api.php?username=living-room&password=nope`)).json();
  assert.deepStrictEqual(bad, { user_info: { auth: 0 } });

  const login = await (await fetch(`${base}/player_api.php?${q}`)).json();
  assert.strictEqual(login.user_info.auth, 1);
  assert.strictEqual(login.server_info.timezone, "UTC");

  const post = await (await fetch(`${base}/player_api.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `${q}&action=get_live_categories`,
  })).json();
  assert.strictEqual(post.length, 3);

  const res = await fetch(`${base}/player_api.php?${q}&action=get_live_streams`);
  assert.strictEqual(res.headers.get("content-encoding"), "gzip");
  const streams = await res.json();
  assert.strictEqual(streams.length, 4);

  const uk = post.find((c) => c.category_name === "UK | Entertainment");
  const one = await (await fetch(`${base}/player_api.php?${q}&action=get_live_streams&category_id=${uk.category_id}`)).json();
  assert.deepStrictEqual(one.map((s) => s.name), ["BBC One"]);
  const none = await (await fetch(`${base}/player_api.php?${q}&action=get_live_streams&category_id=999`)).json();
  assert.deepStrictEqual(none, []);
  assert.deepStrictEqual(await (await fetch(`${base}/player_api.php?${q}&action=get_vod_streams`)).json(), []);

  const guideRes = await fetch(`${base}/xmltv.php?${q}`);
  assert.strictEqual(guideRes.status, 200);
  const xml = await guideRes.text();
  assert.match(xml, /<channel id="teck\.cnn\.us"><display-name>CNN<\/display-name><icon src="http:\/\/x\/cnn\.png\?a=1&amp;b=2"\/><\/channel>/);
  assert.match(xml, /<programme start="\d{14} \+0000" stop="\d{14} \+0000" channel="teck\.cnn\.us"><title>News &amp; &lt;Views&gt;<\/title>/);
  assert.match(xml, /<desc>Desc &quot;quoted&quot;<\/desc><category>News<\/category><live\/>/);
  assert.doesNotMatch(xml, /teck\.wabc/);

  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/xmltv.php?${q}`, { headers: { "if-none-match": guideRes.headers.get("etag") } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }).on("error", reject);
  });
  assert.strictEqual(status, 304);
  // The fake CNN programme is long past, so a window around now keeps the channel but not the programme.
  const windowed = await fetch(`${base}/xmltv.php?${q}&past_hours=2&future_hours=12`);
  const windowedXml = await windowed.text();
  assert.match(windowedXml, /<channel id="teck\.cnn\.us">/);
  assert.doesNotMatch(windowedXml, /<programme /);
  assert.notStrictEqual(windowed.headers.get("etag"), guideRes.headers.get("etag"), "each window has its own ETag");
  assert.strictEqual((await fetch(`${base}/xmltv.php?username=living-room&password=x`)).status, 401);
  assert.ok(touched() > 0);
});

test("bad users files are refused", () => {
  const { loadUsers } = require("../xtream/api");
  const write = (users) => {
    const f = path.join(tmpDir(), "u.json");
    fs.writeFileSync(f, JSON.stringify({ users }));
    return f;
  };
  assert.throws(() => loadUsers(write([])), /non-empty/);
  assert.throws(() => loadUsers(write([{ username: "a", password: "short" }])), /at least 12/);
  assert.throws(() => loadUsers(write([{ username: "a", password: "long-enough-pass", countries: ["USA1"] }])), /invalid country/);
  assert.throws(() => loadUsers(write([{ username: "a", password: "long-enough-pass" }, { username: "a", password: "long-enough-pass" }])), /used twice/);
});

test("prebuild builds each country set's view and guide before the first request, and again once startup settles", async (t) => {
  const dir = tmpDir();
  const usersFile = path.join(dir, "users.json");
  fs.writeFileSync(usersFile, JSON.stringify({
    users: [
      { username: "tv1", password: "correct-horse-battery", countries: ["us", "uk"] },
      { username: "tv2", password: "correct-horse-battery", countries: ["us", "uk"] },
      { username: "de", password: "correct-horse-battery", countries: ["de"] },
    ],
  }));
  const pool = fakePool();
  const lines = [];
  const router = createXtreamRouter({
    usersFile,
    idsFile: path.join(dir, "ids.json"),
    getPool: async () => ({ pool, touch() {} }),
    log: { log: (m) => lines.push(m), error: (m) => lines.push(m) },
  });
  const built = () => lines.filter((l) => /\[XTREAM\] (View|Guide) /.test(l)).map((l) => l.replace(/:.*$/, ""));

  let settle;
  const prebuild = router.prebuild(new Promise((resolve) => { settle = resolve; }));
  for (let i = 0; i < 200 && built().length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(built().sort(), ['[XTREAM] Guide "DE"', '[XTREAM] Guide "UK,US"', '[XTREAM] View "DE"', '[XTREAM] View "UK,US"']);
  pool.channels = [...pool.channels];
  settle();
  await prebuild;
  assert.deepStrictEqual(built().filter((l) => l.includes("View")).sort(), ['[XTREAM] View "DE"', '[XTREAM] View "DE"', '[XTREAM] View "UK,US"', '[XTREAM] View "UK,US"']);

  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const before = lines.length;
  const base = `http://127.0.0.1:${server.address().port}/player_api.php?username=tv1&password=correct-horse-battery`;
  const streams = await (await fetch(`${base}&action=get_live_streams`)).json();
  assert.strictEqual(streams.length, 4);
  assert.deepStrictEqual(lines.slice(before).filter((l) => /\[XTREAM\] (View|Guide) /.test(l)), []);
});
