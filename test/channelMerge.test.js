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
    inlineMerge: true,
    providers: providers.map(([id, country]) => ({ id, name: id, country, config: { provider: "direct", m3uUrl: "http://example.invalid/list.m3u" } })),
  }, null);
  return p;
}

const ch = (id, name, category) => ({ id, name, type: "tv", category, attributes: { "group-title": category } });

test("pool merges an unprefixed channel into the prefixed one from its category's country", async () => {
  const p = pool([["a", ""], ["b", ""]]);
  p.childById.get("a").channels = [ch("1", "UK: Sky Sports Main Event", "UK SPORTS"), ch("2", "US: ESPN", "US SPORTS")];
  p.childById.get("b").channels = [ch("9", "Sky Sports Main Event FHD", "UK-Restream"), ch("8", "ESPN HD", "USA | Sports"), ch("7", "Rai 1", "Italy")];
  await p.merge();
  const byKey = new Map(p.channels.map((t) => [t._key, t]));
  assert.deepStrictEqual([...byKey.keys()].sort(), ["UK|SKYSPORTSMAINEVENT", "US|ESPN", "|RAI1"]);
  assert.deepStrictEqual(byKey.get("UK|SKYSPORTSMAINEVENT")._members.map((m) => m._pid).sort(), ["a", "b"]);
  assert.deepStrictEqual(byKey.get("US|ESPN")._members.map((m) => m._pid).sort(), ["a", "b"]);
});

test("the provider country is still the fallback when the category names no country", async () => {
  const p = pool([["org", "US"]]);
  p.childById.get("org").channels = [ch("1", "CNN", "News"), ch("2", "BBC One", "UK | General")];
  await p.merge();
  assert.deepStrictEqual(p.channels.map((t) => t._key).sort(), ["UK|BBCONE", "US|CNN"]);
});

test("a guide id one provider put on unrelated channels is dropped from the ones it doesn't name", async () => {
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
  await p.merge();
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

test("a guide id one provider put on thousands of channels is sorted out quickly", async () => {
  const tvg = (id, name, tvgId) => ({ ...ch(id, name, "USA"), attributes: { "group-title": "USA", "tvg-id": tvgId } });
  const p = pool([["prem", "US"]]);
  const words = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"];
  p.childById.get("prem").channels = Array.from({ length: 4000 }, (_, i) =>
    tvg(String(i), `US: ${words[i % 10]} ${words[Math.floor(i / 10) % 10]} ${words[Math.floor(i / 100) % 10]} Z${i}`, "none.us"));
  p.childById.get("prem").epgData = { "none.us": [{ s: 1, e: 2, t: "Programme" }] };
  const start = Date.now();
  await p.merge();
  assert.ok(Date.now() - start < 3000, `merge took ${Date.now() - start} ms`);
  // Every name shares a word with another, so they form one group that is most of them, and keep the id.
  assert.ok(p.channels.every((t) => t._epg === "prem/none.us"));
});

test("refreshes close together share one merge", async () => {
  const p = pool([["a", "US"], ["b", "US"]]);
  p.childById.get("a").channels = [ch("1", "US: ESPN", "US")];
  await p.merge();
  let merges = 0;
  const merge = p.merge.bind(p);
  p.merge = () => { merges++; return merge(); };
  p.requestMerge();
  p.requestMerge();
  assert.strictEqual(merges, 0, "a merge just ran, so the next one waits");
  assert.ok(p.mergeTimer);
  p.mergedAt -= 61 * 1000;
  await p.requestMerge();
  assert.strictEqual(merges, 1);
  assert.strictEqual(p.mergeTimer, null, "the waiting merge was the one that ran");
});

test("the merge worker gives the same channels as merging in-process, and unchanged channels are reused", async () => {
  const build = async (inline) => {
    const p = new ProviderPool({ settings: {}, inlineMerge: inline, providers: [["a", "US"], ["b", ""]].map(([id, country]) => ({ id, name: id, country, config: { provider: "direct", m3uUrl: "http://example.invalid/list.m3u" } })) }, null);
    p.childById.get("a").channels = [ch("1", "UK: Sky Sports Main Event", "UK SPORTS"), ch("2", "US: ESPN", "US SPORTS"), ch("3", "US: ESPN FHD", "US SPORTS")];
    p.childById.get("b").channels = [ch("9", "Sky Sports Main Event FHD", "UK-Restream"), ch("8", "ESPN HD", "USA | Sports"), ch("7", "Rai 1", "Italy")];
    await p.merge();
    return p;
  };
  const shape = (p) => p.channels.map((t) => [t.id, t._key, t.name, t._members.map((m) => m.id), t._primary.length, t._epg]);
  const worker = await build(false);
  const inline = await build(true);
  try {
    assert.ok(worker.planner.constructor.name === "MergeWorker", "the pool used the worker");
    assert.deepStrictEqual(shape(worker), shape(inline));
    worker.childById.get("b").channels = [...worker.childById.get("b").channels, ch("6", "Rai 2", "Italy")];
    const sky = worker.channels.find((t) => t._key === "UK|SKYSPORTSMAINEVENT");
    await worker.merge();
    assert.notStrictEqual(worker.channels.find((t) => t._key === "UK|SKYSPORTSMAINEVENT"), sky, "a channel with a refreshed provider's stream is rebuilt");
    assert.ok(worker.channels.some((t) => t._key === "|RAI2"));
    const before = worker.channels.find((t) => t._key === "UK|SKYSPORTSMAINEVENT");
    await worker.merge();
    assert.strictEqual(worker.channels.find((t) => t._key === "UK|SKYSPORTSMAINEVENT"), before, "an unchanged channel is the same object");
  } finally {
    worker.planner.stop();
  }
});

test("a merge asked for during another runs after it, not alongside", async () => {
  const p = pool([["a", "US"]]);
  p.childById.get("a").channels = [ch("1", "US: ESPN", "US")];
  const first = p.merge();
  p.childById.get("a").channels = [ch("1", "US: ESPN", "US"), ch("2", "US: CNN", "US")];
  const second = p.merge();
  assert.strictEqual(first, second, "the second call joins the running merge");
  await first;
  while (p.merging) await p.merging;
  assert.deepStrictEqual(p.channels.map((t) => t._key).sort(), ["US|CNN", "US|ESPN"]);
});

test("cleanName drops the country and feed tags in front of a name, and keeps the name", () => {
  const { cleanName } = require("../channelMerge");
  const cases = [
    ["AT&T: CBS NEWS COLORADO", "CBS NEWS COLORADO"],
    ["US| NEWS 9 SAN DIEGO (KUSI)", "NEWS 9 SAN DIEGO (KUSI)"],
    ["USA: NAT GEO (WEST)", "NAT GEO (WEST)"],
    ["US | NBC04", "NBC04"],
    ["USA - NBC WEST", "NBC WEST"],
    ["| US | FOX WEATHER", "FOX WEATHER"],
    ["|UK| BBC ONE", "BBC ONE"],
    ["[UK] The Big Bang Theory", "The Big Bang Theory"],
    ["(US) ESPN PLAY 27 (D)", "ESPN PLAY 27 (D)"],
    ["USA**:FOX (KTTV - LOS ANGELES", "FOX (KTTV - LOS ANGELES"],
    ["US_HD:Cinema 11 PPV", "Cinema 11 PPV"],
    ["(US LOC) NBC 5 (KING) Seattle", "NBC 5 (KING) Seattle"],
    ["USA Latino | Telemundo 44 Charlotte", "Telemundo 44 Charlotte"],
    ["VIP UK: SKY TENNIS", "SKY TENNIS"],
    ["US (ESPN+ 434) | ESPN+: Hofstra vs. Fordham", "(ESPN+ 434) | ESPN+: Hofstra vs. Fordham"],
    ["US-DAZN 1 HD", "DAZN 1 HD"],
    ["Uk: ITV 1", "ITV 1"],
    ["US: USA NETWORK", "USA NETWORK"],
  ];
  for (const [name, want] of cases) assert.strictEqual(cleanName(name), want, name);
  for (const name of ["USA NETWORK", "UK GOLD", "USA PPV57", "flowrestling: Indee JH: 1", "24/7: Seinfeld", "US"])
    assert.strictEqual(cleanName(name), name, `${name} has no tag`);
});

test("a pool channel shows its name without the tag, and keeps the full name for matching", async () => {
  const p = pool([["a", ""]]);
  p.childById.get("a").channels = [ch("1", "USA: CNN", "USA | News")];
  await p.merge();
  assert.strictEqual(p.channels[0].name, "USA: CNN");
  assert.strictEqual(p.channels[0].label, "CNN");
  assert.strictEqual(p.generateMetaPreview(p.channels[0]).name, "CNN");
});

test("feed-tagged copies key with the main channel, and keep their country for matching", async () => {
  const { channelKey, countryTagged } = require("../channelMerge");
  assert.strictEqual(channelKey("AT&T: CNN", "US"), channelKey("USA: CNN", "US"));
  assert.strictEqual(channelKey("USA Kids | Disney XD", ""), channelKey("USA: DISNEY XD", ""));
  assert.strictEqual(channelKey("VIP UK: SKY TENNIS", ""), channelKey("UK: SKY TENNIS", ""));
  assert.strictEqual(channelKey("USA**:NBC (WRCDT WASHINGTON", ""), "CALL|WRC|NBC");
  assert.strictEqual(channelKey("USA**:FOX (WTTG - WASHINGTON D.C.)", ""), "CALL|WTTG|FOX");
  assert.strictEqual(channelKey("USA**:NC | WASHINGTON | NBC WITN", ""), "CALL|WITN|NBC");
  assert.strictEqual(countryTagged("AT&T: CNN"), "US: CNN");
  assert.strictEqual(countryTagged("USA: CNN"), "USA: CNN");

  const p = pool([["a", ""], ["b", ""]]);
  p.childById.get("a").channels = [ch("1", "AT&T: CNN", "AT&T")];
  p.childById.get("b").channels = [ch("2", "USA: CNN", "USA | News"), ch("3", "UK: CNN", "UK | News"), ch("4", "UK: ITV UK", "UK | General")];
  await p.merge();
  const byKey = new Map(p.channels.map((t) => [t._key, t]));
  assert.deepStrictEqual(byKey.get("US|CNN")._members.map((m) => m._pid).sort(), ["a", "b"], "the AT&T copy joined CNN");
  assert.match(byKey.get("US|CNN").name, /^USA?: CNN$/, "the full name keeps a US tag for event matching");
  assert.strictEqual(byKey.get("US|CNN").label, "CNN");
  assert.strictEqual(byKey.get("UK|CNN").label, "CNN (UK)");
  assert.strictEqual(byKey.get("UK|ITVUK").label, "ITV UK", "no (UK) when the name already says UK");
});
