const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { XtreamIds } = require("../xtream/ids");
const { loadHome, buildView, tileCountry } = require("../xtream/api");
const { buildEvents } = require("../xtream/events");
const { channelKey, KEY_ALIASES } = require("../channelMerge");
const shipped = require("../xtream/home.json");

const gunzipJson = (buf) => JSON.parse(zlib.gunzipSync(buf).toString());

function tile(key, name, groups, extra = {}) {
  return { id: `t-${key}`, _key: key, name, logo: null, _members: [{ _pid: "p", _src: key }], _primary: [{ _pid: "p", _src: key }], _groups: groups, _epg: null, _catchup: null, archiveDays: 0, ...extra };
}

const HOME = loadHome({
  country: "US",
  categories: [
    { name: "Local", keys: ["CALL|WUSA|CBS", "CALL|WRC|NBC"] },
    { name: "Sports", keys: ["US|ESPN", "US|NOTHERE", "US|FOXSPORTS1"] },
    { name: "Kids", keys: ["US|GONE"] },
  ],
});

function fakePool() {
  return {
    channels: [
      tile("UK|SKYSPORTSMAINEVENT", "Sky Sports Main Event", ["EU | UK | SPORTS"]),
      tile("UK|BBCONE", "BBC One", ["EU | UK | GENERAL"]),
      tile("US|FOXSPORTS1", "Fox Sports 1", ["AM | USA | SPORTS"]),
      tile("US|ESPNU", "ESPNU", ["AM | USA | SPORTS"]),
      tile("US|NFLNETWORK", "NFL Network", ["AM | USA | SPORTS"]),
      tile("CALL|WRC|NBC", "NBC 4 Washington", ["AM | USA | NBC"]),
      tile("US|ESPN", "ESPN", ["AM | USA | SPORTS", "US| ESPN"]),
      tile("CALL|WUSA|CBS", "CBS 9 Washington", ["AM | USA | CBS"]),
      tile("UK|SKYNEWS", "Sky News", ["AM | USA | SPORTS"]),
    ],
    epgData: {},
  };
}

test("home categories come first, in order, ranked, with the channels moved into them", () => {
  const view = buildView(fakePool(), new XtreamIds(null), ["UK", "US"], HOME);
  const cats = gunzipJson(view.categoriesGz);
  assert.deepStrictEqual(cats.map((c) => c.category_name), ["Local", "Sports", "AM | USA | SPORTS", "EU | UK | SPORTS", "EU | UK | GENERAL"],
    "empty home and provider categories are left out; US provider categories go before UK ones");
  const rail = (name) => gunzipJson(view.categoryStreams.get(cats.find((c) => c.category_name === name).category_id)).map((s) => s.name);
  assert.deepStrictEqual(rail("Local"), ["CBS 9 Washington", "NBC 4 Washington"]);
  assert.deepStrictEqual(rail("Sports"), ["ESPN", "Fox Sports 1"], "home.json order, keys the pool doesn't have are skipped");
  assert.deepStrictEqual(rail("AM | USA | SPORTS"), ["ESPNU", "NFL Network", "Sky News"], "a moved channel is only in its home category");

  const streams = gunzipJson(view.streamsGz);
  assert.deepStrictEqual(streams.map((s) => s.name).slice(0, 4), ["CBS 9 Washington", "NBC 4 Washington", "ESPN", "Fox Sports 1"]);
  assert.deepStrictEqual(streams.map((s) => s.num), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const espn = streams.find((s) => s.name === "ESPN");
  assert.strictEqual(espn.category_id, cats[1].category_id, "the Guide files a channel under its one category_id");
  assert.strictEqual(espn.category_ids.length, 3, "plus its provider categories");
  assert.strictEqual(view.homeCountry, "US");
});

test("a provider category counts as US when most of its channels are", () => {
  const pool = fakePool();
  pool.channels.push(tile("UK|SKYSPORTSF1", "Sky Sports F1", ["AM | USA | SPORTS"]));
  const cats = gunzipJson(buildView(pool, new XtreamIds(null), ["UK", "US"], HOME).categoriesGz).map((c) => c.category_name);
  assert.deepStrictEqual(cats.slice(2), ["EU | UK | SPORTS", "EU | UK | GENERAL", "AM | USA | SPORTS"], "two US channels against two UK is not most");
});

test("logins without the home country get the provider categories as before", () => {
  const view = buildView(fakePool(), new XtreamIds(null), ["UK"], HOME);
  const cats = gunzipJson(view.categoriesGz).map((c) => c.category_name);
  assert.deepStrictEqual(cats, ["EU | UK | SPORTS", "EU | UK | GENERAL", "AM | USA | SPORTS"]);
  assert.strictEqual(view.homeCountry, null);
  const all = gunzipJson(buildView(fakePool(), new XtreamIds(null), [], HOME).categoriesGz).map((c) => c.category_name);
  assert.strictEqual(all[0], "Local", "a login with no country filter gets the home categories");
});

test("home categories keep their ids across rebuilds", () => {
  const ids = new XtreamIds(null);
  const first = gunzipJson(buildView(fakePool(), ids, ["US"], HOME).categoriesGz);
  const again = gunzipJson(buildView(fakePool(), ids, ["US"], HOME).categoriesGz);
  assert.deepStrictEqual(again.map((c) => c.category_id), first.map((c) => c.category_id));
  assert.notStrictEqual(ids.categoryId("Sports"), Number(first[1].category_id), "a provider category named Sports is a different category");
});

test("bad home files are refused", () => {
  assert.throws(() => loadHome({ country: "USA1", categories: [] }), /country/);
  assert.throws(() => loadHome({ country: "US" }), /categories/);
  assert.throws(() => loadHome({ country: "US", categories: [{ keys: [] }] }), /name/);
  assert.throws(() => loadHome({ country: "US", categories: [{ name: "A", keys: ["US|X"] }, { name: "B", keys: ["US|X"] }] }), /twice/);
});

test("the shipped home.json loads and only uses keys the merge can produce", () => {
  const home = loadHome(shipped);
  assert.strictEqual(home.country, "US");
  assert.deepStrictEqual(home.categories.map((c) => c.name).slice(0, 5), ["Local", "Sports", "News", "Entertainment", "Movies"]);
  for (const key of home.slots.keys()) {
    assert.match(key, /^(US\|[A-Z0-9]+|CALL\|[KW][A-Z]{2,3}\|[A-Z]+)$/, key);
    assert.strictEqual(KEY_ALIASES[key], undefined, `${key} is folded into another key`);
    assert.strictEqual(tileCountry(key), "US", key);
  }
});

test("network names providers spell differently share one key", () => {
  const same = [
    ["US: MSNBC", "US - MS NOW", "USA MS NOW (MSNBC)"],
    ["US: FS 1", "US - FOX SPORTS 1"],
    ["US: BTN", "US - BIG TEN NETWORK"],
    ["US - NICK", "USA**:NICKELODEON"],
    ["US: EPIX", "USA: MGM", "US - MGM+ EAST"],
    ["| US | ESPNEWS", "US - ESPN NEWS"],
    ["US - FOX 5+ WASHINGTON DC (WDCA)", "US| MYTV 20 (WDCA) WASHINGTON DC"],
  ];
  for (const names of same) {
    const keys = new Set(names.map((n) => channelKey(n, "US")));
    assert.strictEqual(keys.size, 1, names.join(" / "));
  }
  assert.strictEqual(channelKey("US: MSNBC"), "US|MSNBC");
  for (const [from, to] of Object.entries(KEY_ALIASES)) assert.strictEqual(KEY_ALIASES[to], undefined, `${from} -> ${to} chains`);
});

test("Live Now lists events on home-country channels first", () => {
  const now = Date.UTC(2026, 9, 12, 23, 0);
  const tiles = [
    tile("UK|SKYSPORTSMAINEVENT", "Sky Sports Main Event", ["UK"]),
    tile("US|ESPN", "ESPN", ["US"]),
  ];
  const ev = (id, title, channel, liveBoost) => ({ id, title, start: now - 3600e3, end: now + 3600e3, sources: ["x"], channels: [{ id: channel }], assumedDay: false, liveBoost });
  const events = [ev("e1", "Rugby", "t-UK|SKYSPORTSMAINEVENT", 100), ev("e2", "Football", "t-US|ESPN", 0), ev("e3", "Cricket", "t-UK|SKYSPORTSMAINEVENT", 50)];
  const pool = {
    tileById: new Map(tiles.map((t) => [t.id, t])),
    epgData: {},
    liveEventIndex: () => new Map(events.map((e) => [e.id, e])),
    eventChannels: (e) => e.channels,
    formatEventTime: () => "",
  };
  const names = (homeCountry) => buildEvents(pool, { countries: ["UK", "US"], categoryId: 1, tileCountry, homeCountry, now }).entries.map((e) => [e.stream.name, e.stream.num]);
  assert.deepStrictEqual(names(null), [["Rugby", 1], ["Cricket", 2], ["Football", 3]]);
  assert.deepStrictEqual(names("US"), [["Football", 1], ["Rugby", 2], ["Cricket", 3]], "the rest keep their order");
});
