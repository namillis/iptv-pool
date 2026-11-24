const test = require("node:test");
const assert = require("node:assert");
const { baseManifest } = require("../addon");
const { ProviderPool, loadPoolConfig } = require("../providerPool");

const ch = (id, name, category) => ({ id, name, type: "tv", category, url: `http://a.example/${id}.ts`, attributes: { "group-title": category } });

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

const fakeRelay = (enabled = true) => ({ enabled: () => enabled, order: (pool, tile) => [...tile._members].reverse() });

test("with the relay on, a channel's first stream is the relay, then up to 3 direct streams in relay order", async () => {
  const { p } = await pool(["US"]);
  p.publicBase = "https://iptv.example/pool-key";
  const cnn = p.channels.find((t) => t._key === "US|CNN");
  cnn._members = [...cnn._members, ...cnn._members, ...cnn._members, ...cnn._members];
  assert.ok(p.getStreams(cnn.id).every((s) => !s.url.includes("/play/")), "no hook, no relay");
  p.stremioRelay = fakeRelay();
  const streams = p.getStreams(cnn.id);
  assert.strictEqual(streams[0].url, `https://iptv.example/pool-key/play/${cnn.id}.ts`);
  assert.strictEqual(streams[0].name, "Auto");
  cnn._members = [{ ...cnn._members[0], _quality: { label: "HD", rank: 0 } }, { ...cnn._members[0], _quality: { label: "FHD backup", rank: 0.5 } }];
  assert.strictEqual(p.getStreams(cnn.id)[0].name, "Auto\nFHD", "Auto carries the best resolution among the channel's streams");
  cnn._members = [...Array(4)].map(() => ({ ...cnn._members[0], _quality: { label: "", rank: 1 } }));
  assert.strictEqual(streams.length, 4);
  assert.ok(streams.slice(1).every((s) => s.url === "http://a.example/1.ts"));
  p.stremioRelay = fakeRelay(false);
  assert.ok(!p.getStreams(cnn.id)[0].url.includes("/play/"), "relay down, direct streams");
});

test("with the relay on, an event lists one relay stream per channel, then up to 3 direct streams", async () => {
  const { p } = await pool(["US"]);
  p.publicBase = "https://iptv.example/pool-key";
  p.stremioRelay = fakeRelay();
  const tile = (key) => p.channels.find((t) => t._key === key);
  const e = { id: "iptv_ev_1", channels: [{ id: tile("US|CNN").id, source: "CNN", slot: "CNN" }, { id: tile("US|FOXNEWS").id, source: "Fox News", slot: "Fox News" }] };
  p.liveEventIndex = () => new Map([[e.id, e]]);
  p.eventChannels = (ev) => ev.channels;
  const streams = p.getEventStreams(e.id);
  assert.deepStrictEqual(streams.slice(0, 2).map((s) => s.url), [`https://iptv.example/pool-key/play/${tile("US|CNN").id}.ts`, `https://iptv.example/pool-key/play/${tile("US|FOXNEWS").id}.ts`]);
  assert.deepStrictEqual(streams.slice(2).map((s) => s.url), ["http://a.example/1.ts", "http://a.example/2.ts"]);
});

test("a channel's description says what Auto does, with no provider list or catch-up, and its streams have no catch-up", async () => {
  const { p } = await pool(["US"]);
  p.publicBase = "https://iptv.example/pool-key";
  p.stremioRelay = fakeRelay();
  const cnn = p.channels.find((t) => t._key === "US|CNN");
  cnn._catchup = cnn._members[0];
  cnn.archiveDays = 2;
  const { description } = p.getDetailedMeta(cnn.id);
  assert.match(description, /Auto plays the best of 1 stream from 1 provider and switches if one stalls/);
  assert.doesNotMatch(description, /PROVIDERS|CATCH-UP/);
  assert.deepStrictEqual(await p.getCatchupStreams(cnn.id), []);
  p.stremioRelay = fakeRelay(false);
  assert.match(p.getDetailedMeta(cnn.id).description, /🔌 1 stream from 1 provider$/);
});

test("All Channels' genres are the Xtream login's categories, in the same order with the same channels", async () => {
  const { buildView } = require("../xtream/api");
  const { XtreamIds } = require("../xtream/ids");
  const { p, manifest } = await pool(["US", "UK"]);
  const view = buildView(p, new XtreamIds(null), ["UK", "US"]);
  const all = manifest.catalogs.find((c) => c.id === "iptv_channels");
  assert.deepStrictEqual(all.genres, ["All Channels", ...view.categoryList.map((c) => c.category_name)]);
  const byStreamId = new Map(view.entries.map((e) => [e.stream.stream_id, e.tile]));
  for (const c of view.categoryList) {
    const xtream = view.streamList.filter((s) => s.category_id === c.category_id).map((s) => byStreamId.get(s.stream_id)._key);
    assert.deepStrictEqual(p.genreChannels(p.listedChannels(), c.category_name).map((t) => t._key), xtream, c.category_name);
  }
  const cnn = p.channels.find((t) => t._key === "US|CNN");
  assert.deepStrictEqual(p.generateMetaPreview(cnn).genres, ["News"]);
  assert.deepStrictEqual(p.genreChannels(p.listedChannels(), "UK | News").map((t) => t._key), ["UK|BBCNEWS"]);
});
