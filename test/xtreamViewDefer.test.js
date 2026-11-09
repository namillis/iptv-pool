const test = require("node:test");
const assert = require("node:assert");
const { createXtreamRouter } = require("../xtream/api");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

function tile(id, key, name) {
  const m = { _pid: "p", _src: `iptv_live_${id}`, url: `http://p.example/live/u/p/${id}.ts` };
  return { id, _key: key, name, logo: null, _members: [m], _primary: [m], _groups: ["AM | USA | NEWS"], _epg: null, _catchup: null, archiveDays: 0 };
}

test("after a provider refresh, a request gets the current view and one rebuild follows a short wait", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "xtream-defer-"));
  const usersFile = path.join(dir, "users.json");
  fs.writeFileSync(usersFile, JSON.stringify({ users: [{ username: "tv1", password: "fakepassword123" }] }));
  const pool = { channels: [tile("t1", "US|CNN", "CNN")], epgData: {}, childById: new Map(), updateData: () => Promise.resolve() };
  const app = express();
  app.use(createXtreamRouter({ usersFile, idsFile: null, getPool: async () => ({ pool, touch() {} }), log: { log() {}, error() {} },
    viewRebuildDelayMs: 20, viewRebuildGapMs: 0 }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const names = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/player_api.php?username=tv1&password=fakepassword123&action=get_live_streams`)).json()).map((s) => s.name);
  assert.deepStrictEqual(await names(), ["CNN"]);
  pool.channels = [tile("t1", "US|CNN", "CNN"), tile("t2", "US|MSNBC", "MSNBC")];
  assert.deepStrictEqual(await names(), ["CNN"], "the request that notices the refresh gets the current view");
  pool.channels = [...pool.channels, tile("t3", "US|FOXNEWS", "Fox News")];
  assert.deepStrictEqual(await names(), ["CNN"], "a second refresh before the rebuild doesn't start another one");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual((await names()).sort(), ["CNN", "Fox News", "MSNBC"], "one rebuild picks up both refreshes");
});
