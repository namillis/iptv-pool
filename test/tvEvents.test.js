const test = require("node:test");
const assert = require("node:assert");
const { buildEventIndex, currentEvents, categoryOf, importanceOf, programmeVerdict } = require("../liveEvents");
const { candidates } = require("../tvSchedule");
const { tentpoleOf } = require("../tentpoles");

const NOW = Date.parse("2026-11-06T01:05:00Z");
const S = (iso) => Math.floor(Date.parse(iso) / 1000);

function episode(name, { type = "Reality", weight = 99, season = 5, number = 9, network = "NBC", airstamp = "2026-11-06T01:00:00+00:00", runtime = 60, epName = "Episode" } = {}) {
  return {
    id: `${name}-${season}-${number}`.length * 1000 + number,
    name: epName,
    season,
    number,
    type: "regular",
    airstamp,
    runtime,
    summary: "<p>The players gather.</p>",
    show: { id: name.length, name, type, weight, network: { name: network } },
  };
}

function channel(id, name) {
  return { id, type: "tv", name, category: "USA ENTERTAINMENT", epg: id };
}

function index(channels, epgData, tv) {
  return buildEventIndex(channels, { now: NOW, groupOf: (c) => c.category, epgData, epgIdOf: (c) => c.epg || null, tv });
}

const listing = (t, extra = {}) => ({ s: S("2026-11-06T01:00:00Z"), e: S("2026-11-06T02:00:00Z"), t, ...extra });

test("weekly reality and game shows are kept, daily and plain scripted episodes are not", () => {
  const shows = candidates([
    episode("The Traitors"),
    episode("The Price is Right", { type: "Game Show", season: 2026, number: 163 }),
    episode("Jimmy Kimmel Live", { type: "Talk Show", season: 2026, number: 136 }),
    episode("Elsbeth", { type: "Scripted", season: 4, number: 4 }),
    episode("Mistletoe Murders", { type: "Scripted", season: 3, number: 1, network: "Hallmark Channel" }),
    episode("Small Local Show", { weight: 40 }),
    episode("Oscars", { type: "Award Show", season: 2027, number: 1, weight: 97, network: "ABC" }),
  ]);
  assert.deepStrictEqual(shows.map((s) => s.show).sort(), ["Elsbeth", "Mistletoe Murders", "Oscars", "The Traitors"]);
  assert.strictEqual(shows.find((s) => s.show === "Elsbeth").needsFinaleCheck, true);
  assert.strictEqual(shows.find((s) => s.show === "Mistletoe Murders").premiere, true);
  assert.strictEqual(shows.find((s) => s.show === "Oscars").tentpole.label, "Oscars");
});

test("a TVmaze show becomes a TV event on the North American channels whose guide lists it", () => {
  const [s] = candidates([episode("The Traitors")]);
  const idx = index(
    [channel("nbc", "US - NBC 4 WASHINGTON DC"), channel("uk", "UK - BBC ONE"), channel("cbs", "US - CBS 9")],
    { nbc: [listing("The Traitors")], uk: [listing("The Traitors")], cbs: [listing("Georgie & Mandy's First Marriage")] },
    [s]
  );
  const events = [...idx.values()];
  assert.strictEqual(events.length, 1);
  const e = events[0];
  assert.strictEqual(e.title, "The Traitors");
  assert.strictEqual(categoryOf(e), "TV");
  assert.deepStrictEqual(e.channels.map((c) => c.id), ["nbc"]);
  assert.strictEqual(e.guide.d, "The players gather.");
  assert.deepStrictEqual(currentEvents(idx, NOW, { genre: "TV" }).map((x) => x.id), [e.id]);
});

test("a show's name doesn't match a longer show that starts with it", () => {
  const [s] = candidates([episode("Law & Order", { type: "Reality" })]);
  const idx = index([channel("nbc", "US - NBC 4")], { nbc: [listing("Law & Order: Special Victims Unit")] }, [s]);
  assert.strictEqual(idx.size, 0);
});

test("a \"Show: Episode\" guide title matches when the rest is the episode", () => {
  const [s] = candidates([episode("Hell's Kitchen", { network: "FOX", epName: "Mystery Box" })]);
  const idx = index([channel("fox", "US - FOX 5")], { fox: [listing("Hell's Kitchen: Mystery Box")] }, [s]);
  assert.strictEqual(idx.size, 1);
});

test("TV events rank by Wikipedia views, not by premieres, and a tentpole ranks above them", () => {
  const shows = candidates([
    episode("The Traitors"),
    episode("Mistletoe Murders", { type: "Scripted", season: 3, number: 1, network: "Hallmark Channel" }),
    episode("Ask This Old House", { network: "PBS" }),
    episode("Oscars", { type: "Award Show", season: 2027, number: 1, network: "ABC" }),
  ]);
  const views = { "The Traitors": 6751, "Mistletoe Murders": 3155, "Ask This Old House": 8 };
  for (const s of shows) s.views = views[s.show] ?? null;
  const idx = index(
    [channel("nbc", "US - NBC 4"), channel("hall", "US - HALLMARK CHANNEL"), channel("pbs", "US - PBS"), channel("abc", "US - ABC 7")],
    { nbc: [listing("The Traitors")], hall: [listing("Mistletoe Murders")], pbs: [listing("Ask This Old House")], abc: [listing("The Oscars")] },
    shows
  );
  const ranked = currentEvents(idx, NOW).map((e) => [e.title, importanceOf(e)]);
  assert.deepStrictEqual(ranked, [
    ["Oscars", 70],
    ["The Traitors", 23.8],
    ["Mistletoe Murders · Season Premiere", 18.3],
    ["Ask This Old House", 0],
  ]);
  assert.strictEqual(categoryOf([...idx.values()].find((e) => e.title === "Oscars")), "Special");
});

test("a tentpole only the guide lists is a Special, and a replay of one is not", () => {
  const idx = index(
    [channel("cnn", "US - CNN"), channel("cnn2", "US - CNN INTERNATIONAL")],
    {
      cnn: [listing("Election Night in America", { l: 1 })],
      cnn2: [listing("Election Night in America", { r: 1, d: "A replay of last night's coverage." })],
    },
    []
  );
  const events = [...idx.values()];
  assert.strictEqual(events.length, 1);
  assert.strictEqual(categoryOf(events[0]), "Special");
  assert.deepStrictEqual(events[0].channels.map((c) => c.id), ["cnn"]);
});

test("a tentpole the sports listings already found is moved up instead of listed twice", () => {
  const idx = index(
    [channel("nbc", "US - NBC 4")],
    { nbc: [listing("Winter Olympics", { c: ["Sports"], l: 1, st: "Figure Skating" })] },
    []
  );
  const events = [...idx.values()];
  assert.strictEqual(events.length, 1);
  assert.ok(importanceOf(events[0]) >= 45);
});

test("a TV event's channel only matches while its guide lists the show", () => {
  const e = { show: "traitors", teams: null };
  assert.strictEqual(programmeVerdict(e, { t: "The Traitors" }), "match");
  assert.strictEqual(programmeVerdict(e, { t: "The Traitors: Episode 9" }), "match");
  assert.strictEqual(programmeVerdict(e, { t: "Local News at 9" }), "other");
});

test("tentpoles leave out the Youth and Special Olympics", () => {
  assert.strictEqual(tentpoleOf("Swimming - 2026 Youth Olympic Games – Dakar"), null);
  assert.strictEqual(tentpoleOf("Special Olympics World Games"), null);
  assert.strictEqual(tentpoleOf("Winter Olympics").label, "Olympics");
  assert.strictEqual(tentpoleOf("2028 Summer Olympics Opening Ceremony").label, "Olympics ceremony");
});
