const test = require("node:test");
const assert = require("node:assert");
const { channelKey, categoryCountry } = require("../channelMerge");
const { ProviderPool } = require("../providerPool");

test("categoryCountry reads US or UK from a provider's category name", () => {
  for (const c of ["USA | Entertainment", "|NA| USA ESPN+", "PLUTO TV USA", "→ USA II ←", "AM | USA | PPV", "United States"]) assert.strictEqual(categoryCountry(c), "US", c);
  for (const c of ["UK-Restream", "UK | SPORTS", "|UK| GENERAL", "RAKUTEN UK", "PLUTO TV GRAN BRETAÑA", "Scotland", "British TV"]) assert.strictEqual(categoryCountry(c), "UK", c);
});

test("categoryCountry leaves other and ambiguous categories alone", () => {
  for (const c of ["", "24/7 | ENGLISH", "Canada | British Columbia", "New England Sports", "NEW SOUTH WALES", "PLUS EVENTS", "BUSINESS", "US & UK NEWS", "AMERICA SAMOA", "Ex-YU"])
    assert.strictEqual(categoryCountry(c), "", c);
});

test("a name prefix still wins over the category", () => {
  assert.strictEqual(channelKey("CA: TSN 1", categoryCountry("USA | SPORTS")), "CA|TSN1");
  assert.strictEqual(channelKey("Sky Sports Main Event HD", categoryCountry("UK-Restream")), "UK|SKYSPORTSMAINEVENT");
});

test("a category country drops the name's own country word, but not from names that need it", () => {
  assert.strictEqual(channelKey("Blaze UK", "UK"), channelKey("UK: Blaze"));
  assert.strictEqual(channelKey("USA**:BEIN SPORTS 4", "US"), channelKey("US: beIN Sports 4"));
  assert.strictEqual(channelKey("USA IFC", "US"), channelKey("US| IFC"));
  assert.strictEqual(channelKey("USA Network", "US"), channelKey("US: USA Network"));
  assert.strictEqual(channelKey("GB News", "UK"), channelKey("UK: GB News"));
});

test("separator rows and numbered slots keep no country, so they never join a real tile", () => {
  for (const name of ["##### CBS MARYLAND #####", "✦●✦ GENERAL FHD✦●✦", " :NHL  11", "NCAAF 106", ":Milb  33 HD", "Paramount+ 84"])
    assert.ok(channelKey(name, "US").startsWith("|"), name);
  assert.notStrictEqual(channelKey(" :NHL  11", "US"), channelKey("USA: NHL 11"));
});

function pool(providers) {
  const p = new ProviderPool({
    settings: {},
    providers: providers.map(([id, country]) => ({ id, name: id, country, config: { provider: "direct", m3uUrl: "http://example.invalid/list.m3u" } })),
  }, null);
  return p;
}

const ch = (id, name, category) => ({ id, name, type: "tv", category, attributes: { "group-title": category } });

test("pool merges an unprefixed channel into the prefixed one from its category's country", () => {
  const p = pool([["a", ""], ["b", ""]]);
  p.childById.get("a").channels = [ch("1", "UK: Sky Sports Main Event", "UK SPORTS"), ch("2", "US: ESPN", "US SPORTS")];
  p.childById.get("b").channels = [ch("9", "Sky Sports Main Event FHD", "UK-Restream"), ch("8", "ESPN HD", "USA | Sports"), ch("7", "Rai 1", "Italy")];
  p.merge();
  const byKey = new Map(p.channels.map((t) => [t._key, t]));
  assert.deepStrictEqual([...byKey.keys()].sort(), ["UK|SKYSPORTSMAINEVENT", "US|ESPN", "|RAI1"]);
  assert.deepStrictEqual(byKey.get("UK|SKYSPORTSMAINEVENT")._members.map((m) => m._pid).sort(), ["a", "b"]);
  assert.deepStrictEqual(byKey.get("US|ESPN")._members.map((m) => m._pid).sort(), ["a", "b"]);
});

test("the provider country is still the fallback when the category names no country", () => {
  const p = pool([["org", "US"]]);
  p.childById.get("org").channels = [ch("1", "CNN", "News"), ch("2", "BBC One", "UK | General")];
  p.merge();
  assert.deepStrictEqual(p.channels.map((t) => t._key).sort(), ["UK|BBCONE", "US|CNN"]);
});

test("a guide id one provider put on unrelated channels is dropped from the ones it doesn't name", () => {
  const tvg = (id, name, category, tvgId) => ({ ...ch(id, name, category), attributes: { "group-title": category, "tvg-id": tvgId } });
  const p = pool([["polar", "US"], ["nova", "US"]]);
  p.childById.get("polar").channels = [
    tvg("1", "USA | Horror by Alter", "USA", "3tvktvkphoenixaz.us"),
    tvg("2", "USA Laff More", "USA", "3tvktvkphoenixaz.us"),
    tvg("3", "USA | Ebony TV", "USA", "3tvktvkphoenixaz.us"),
    tvg("4", "SE - SVT 1 SKÅNE", "Sweden", "svt1.se"),
    tvg("5", "SE - SVT 1 JÄMTLAND", "Sweden", "svt1.se"),
    tvg("6", "US - ESPN", "USA", "espn.us"),
    tvg("7", "CA CBC News Network", "Canada", "cbcnewsnetwork.ca"),
    tvg("8", "CA CBC News Toronto", "Canada", "cbcnewsnetwork.ca"),
    tvg("10", "DE: SKY SPORT BUNDESLIGA 5 HD", "Germany", "skybundesliga5.de"),
    tvg("11", "DE: |WOW| SKY SPORT BUNDESLIGA 5", "Germany", "skybundesliga5.de"),
  ];
  p.childById.get("nova").channels = [tvg("9", "US - HORROR BY ALTER FHD", "USA", "horrorbyalter.us")];
  const listing = [{ s: 1, e: 2, t: "Programme" }];
  p.childById.get("polar").epgData = { "3tvktvkphoenixaz.us": listing, "svt1.se": listing, "espn.us": listing, "cbcnewsnetwork.ca": listing, "skybundesliga5.de": listing };
  p.childById.get("nova").epgData = { "horrorbyalter.us": [{ s: 1, e: 2, t: "Night of the Living Dead" }] };
  p.merge();
  const epg = new Map(p.channels.map((t) => [t._key, t._epg]));
  assert.strictEqual(epg.get("US|HORRORBYALTER"), "nova/horrorbyalter.us");
  assert.strictEqual(epg.get("US|LAFFMORE"), null);
  assert.strictEqual(epg.get("US|EBONY"), null);
  assert.strictEqual(epg.get("SE|SVT1SKÅNE"), "polar/svt1.se");
  assert.strictEqual(epg.get("SE|SVT1JÄMTLAND"), "polar/svt1.se");
  assert.strictEqual(epg.get("US|ESPN"), "polar/espn.us");
  const guideOf = (name) => p.channels.find((t) => t.name.includes(name))._epg;
  assert.strictEqual(guideOf("CBC News Toronto"), "polar/cbcnewsnetwork.ca");
  assert.strictEqual(guideOf("CBC News Network"), "polar/cbcnewsnetwork.ca");
  const bundesliga = p.channels.filter((t) => /BUNDESLIGA/.test(t.name));
  assert.ok(bundesliga.length >= 1 && bundesliga.every((t) => t._epg === "polar/skybundesliga5.de"));
});
