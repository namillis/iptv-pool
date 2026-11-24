const test = require("node:test");
const assert = require("node:assert");
const { baseManifest } = require("../addon");
const { ProviderPool, loadPoolConfig } = require("../providerPool");

const ch = (id, name, category) => ({ id, name, type: "tv", category, attributes: { "group-title": category } });

async function pool(countries) {
  const manifest = baseManifest({ liveOnly: true });
  const p = new ProviderPool({
    settings: { liveOnly: true, countries },
    inlineMerge: true,
    providers: [{ id: "a", name: "a", country: "", config: { provider: "direct", m3uUrl: "http://example.invalid/list.m3u" } }],
  }, manifest);
  p.manifestReady = true;
  p.childById.get("a").channels = [
    ch("1", "US: CNN", "USA | News"),
    ch("2", "US: Fox News", "USA | News"),
    ch("3", "US: Some Local News", "USA | News"),
    ch("4", "US: NBC 4 (WRC) Washington", "USA | Locals"),
    ch("5", "UK: BBC News", "UK | News"),
    ch("6", "Rai 1", "Italy"),
    ch("7", "US: HBO", "USA | Movies"),
  ];
  await p.merge();
  return { p, manifest };
}

test("the pool's Stremio catalogs are the home lists and All Channels, with no Catch-up or Today", async () => {
  const { manifest } = await pool(["US", "UK"]);
  assert.deepStrictEqual(manifest.catalogs.map((c) => c.name), ["Local DC", "News", "Movies", "All Channels"]);
});

test("All Channels and the home lists keep only the pool's countries", async () => {
  const { p, manifest } = await pool(["US", "UK"]);
  const keys = (tiles) => tiles.map((t) => t._key);
  assert.ok(!keys(p.listedChannels()).includes("|RAI1"));
  assert.ok(keys(p.listedChannels()).includes("UK|BBCNEWS"));
  const news = keys(p.homeChannels("iptv_home_news"));
  assert.deepStrictEqual(news.slice(0, 2), ["US|FOXNEWS", "US|CNN"], "hand-picked channels come first, in home.json order");
  assert.ok(news.includes("US|SOMELOCALNEWS"), "then other US news channels");
  assert.ok(!news.includes("UK|BBCNEWS"), "UK channels are only in All Channels");
  assert.deepStrictEqual(keys(p.homeChannels("iptv_home_local_dc")), ["CALL|WRC|NBC"]);
  const all = manifest.catalogs.find((c) => c.id === "iptv_channels");
  assert.strictEqual(all.genres[0], "All Channels");
  assert.ok(!all.genres.includes("Italy"));
});

test("without countries the pool lists every channel", async () => {
  const { p } = await pool([]);
  assert.ok(p.listedChannels().some((t) => t._key === "|RAI1"));
});

test("an event keeps only channels in the pool's countries, and one with none left is dropped", async () => {
  const { p } = await pool(["US"]);
  const tile = (key) => p.channels.find((t) => t._key === key);
  const e = { id: "iptv_ev_1", channels: [{ id: tile("US|CNN").id }, { id: tile("UK|BBCNEWS").id }] };
  assert.deepStrictEqual(p.listedEvent(e).channels, [{ id: tile("US|CNN").id }]);
  assert.strictEqual(p.listedEvent({ id: "iptv_ev_2", channels: [{ id: tile("UK|BBCNEWS").id }] }), null);
});

test("settings.countries must be country codes", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pool-")), "providers.json");
  const write = (countries) => fs.writeFileSync(file, JSON.stringify({ settings: { countries }, providers: [{ id: "a", m3uUrl: "http://example.invalid/x.m3u" }] }));
  write(["us", "UK"]);
  const config = loadPoolConfig(file);
  assert.deepStrictEqual(config.settings.countries, ["US", "UK"]);
  assert.strictEqual(config.providers[0].config.countries, undefined, "providers don't get the pool's countries");
  write(["USA1"]);
  assert.throws(() => loadPoolConfig(file), /invalid country/);
  write("US");
  assert.throws(() => loadPoolConfig(file), /must be a list/);
});
