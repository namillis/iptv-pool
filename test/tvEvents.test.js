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

test("popular shows of any type are kept, except daily soaps and game shows, kids' shows and unpopular shows", () => {
  const shows = candidates([
    episode("The Traitors"),
    episode("The Price is Right", { type: "Game Show", season: 2026, number: 163 }),
    episode("General Hospital", { type: "Scripted", season: 2026, number: 150, network: "ABC" }),
    episode("Jimmy Kimmel Live", { type: "Talk Show", season: 2026, number: 136 }),
    episode("Anderson Cooper 360", { type: "News", season: 2026, number: 168, network: "CNN" }),
    episode("Last Week Tonight", { type: "Talk Show", season: 13, number: 29, network: "HBO" }),
    episode("Elsbeth", { type: "Scripted", season: 4, number: 4 }),
    episode("Late Night Law", { weight: 89, network: "A&E" }),
    episode("SpongeBob SquarePants", { type: "Animation", season: 17, number: 21, network: "Nickelodeon" }),
    episode("Mistletoe Murders", { type: "Scripted", season: 3, number: 1, network: "Hallmark Channel" }),
    episode("Small Local Show", { weight: 40 }),
    episode("Oscars", { type: "Award Show", season: 2027, number: 1, weight: 97, network: "ABC" }),
  ]);
  assert.deepStrictEqual(shows.map((s) => s.show).sort(), ["Anderson Cooper 360", "Elsbeth", "Jimmy Kimmel Live", "Last Week Tonight",
    "Late Night Law", "Mistletoe Murders", "Oscars", "The Traitors"]);
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

test("election coverage is a Special on national channels on election day, and a replay of it is not", () => {
  const night = Date.parse("2026-11-04T01:05:00Z");
  const at = (t, extra = {}) => ({ s: S("2026-11-04T01:00:00Z"), e: S("2026-11-04T05:00:00Z"), t, ...extra });
  const idx = buildEventIndex(
    [channel("cnn", "US - CNN"), channel("cnn2", "US - CNN HD"), channel("nbc", "US - NBC"), channel("ktuu", "US - NBC 2 ANCHORAGE (KTUU)")],
    {
      now: night,
      groupOf: (c) => c.category,
      epgIdOf: (c) => c.epg || null,
      tv: [],
      epgData: {
        cnn: [at("Election Night in America", { l: 1 })],
        cnn2: [at("Election Night in America", { r: 1, d: "A replay of last night's coverage." })],
        nbc: [at("Decision 2026", { l: 1 })],
        ktuu: [at("Alaska Live Election Coverage 2026", { l: 1 })],
      },
    }
  );
  const events = [...idx.values()];
  assert.deepStrictEqual(events.map((e) => e.channels.map((c) => c.id)).sort(), [["cnn"], ["nbc"]]);
  for (const e of events) assert.strictEqual(categoryOf(e), "Special");
});

test("election coverage after the day after election day is not a tentpole", () => {
  const idx = index([channel("cnn", "US - CNN")], { cnn: [listing("Election Night in America", { l: 1 })] }, []);
  const [e] = [...idx.values()];
  assert.strictEqual(categoryOf(e), "TV");
  assert.strictEqual(importanceOf(e), 7);
  assert.strictEqual(tentpoleOf(Date.parse("2026-11-06T01:00:00Z"), "Election Night in America"), null);
  assert.strictEqual(tentpoleOf(Date.parse("2026-11-04T20:00:00Z"), "Election Night in America").label, "Election night");
  assert.strictEqual(tentpoleOf(Date.parse("2028-11-08T02:00:00Z"), "Decision 2028").label, "Election night");
});

test("cable news is a TV event from 6 AM to midnight ranked by channel, and local, sports, short, replayed or overnight listings aren't", () => {
  const channels = [channel("cnn", "US - CNN"), channel("fnc", "US - FOX NEWS CHANNEL"), channel("ktuu", "US - NBC 2 ANCHORAGE (KTUU)"),
    channel("msn", "US - MS NOW"), channel("cbsn", "US - CBS NEWS"), channel("nbc", "US - NBC"), channel("tlc", "US - TLC"),
    channel("cnn2", "CA - CNN")];
  const idx = index(channels, {
    cnn: [listing("CNN Newsroom")],
    fnc: [listing("Hannity", { r: 1 })],
    ktuu: [listing("Channel 2 News at 5")],
    msn: [{ ...listing("Breaking News Update"), e: S("2026-11-06T01:10:00Z") }],
    cbsn: [listing("College Football: Ohio State at Michigan")],
    nbc: [listing("Special Report", { l: 1 })],
    tlc: [listing("Sister Wives Marathon")],
    cnn2: [listing("Live: CNN Newsroom")],
  }, []);
  const tv = [...idx.values()].filter((e) => categoryOf(e) === "TV");
  assert.deepStrictEqual(tv.map((e) => e.title).sort(), ["CNN Newsroom", "Special Report"]);
  assert.deepStrictEqual(tv.map((e) => [e.title, importanceOf(e)]).sort(), [["CNN Newsroom", 7], ["Special Report", 5]]);
  const late = Date.parse("2026-11-06T08:05:00Z");
  const overnight = buildEventIndex(channels, { now: late, groupOf: (c) => c.category, epgIdOf: (c) => c.epg || null, tv: [],
    epgData: { cnn: [{ s: S("2026-11-06T08:00:00Z"), e: S("2026-11-06T09:00:00Z"), t: "Anderson Cooper 360" }] } });
  assert.strictEqual(overnight.size, 0);
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
  assert.strictEqual(tentpoleOf(NOW, "Swimming - 2026 Youth Olympic Games – Dakar"), null);
  assert.strictEqual(tentpoleOf(NOW, "Special Olympics World Games"), null);
  assert.strictEqual(tentpoleOf(NOW, "Winter Olympics").label, "Olympics");
  assert.strictEqual(tentpoleOf(NOW, "2028 Summer Olympics Opening Ceremony").label, "Olympics ceremony");
});
