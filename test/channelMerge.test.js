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
