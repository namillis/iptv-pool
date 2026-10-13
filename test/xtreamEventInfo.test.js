const test = require("node:test");
const assert = require("node:assert");
const { buildEventIndex, currentEvents } = require("../liveEvents");
const { parseScoreboard } = require("../espnSchedule");
const { poolEvent } = require("../xtream/events");

const KICKOFF = Date.parse("2026-10-13T00:15:00Z");
const S = (iso) => Math.floor(Date.parse(iso) / 1000);

function competitor(homeAway, displayName, shortDisplayName, record) {
  return { homeAway, team: { displayName, shortDisplayName, location: displayName }, records: record ? [{ type: "total", summary: record }] : [] };
}

function geo(shortName, type = "TV", market = "National") {
  return { media: { shortName }, type: { shortName: type }, market: { type: market } };
}

function board({ state = "pre", notes = [], week = 5, seasonType = 2, venue, broadcasts, competitors, neutralSite = false } = {}) {
  return {
    week: { number: week },
    events: [
      {
        id: "401",
        date: "2026-10-13T00:15Z",
        week: { number: week },
        season: { type: seasonType },
        status: { type: { state } },
        competitions: [
          {
            neutralSite,
            notes,
            venue: venue || { fullName: "SoFi Stadium", address: { city: "Inglewood", state: "CA", country: "USA" } },
            geoBroadcasts: broadcasts || [geo("ESPN"), geo("ABC"), geo("ESPN+", "Streaming"), geo("Westwood One", "Radio"), geo("KABC", "TV", "Home")],
            competitors: competitors || [competitor("home", "Los Angeles Rams", "Rams", "2-2"), competitor("away", "Buffalo Bills", "Bills", "3-1")],
          },
        ],
      },
    ],
  };
}

test("ESPN games carry the round, records, venue and national networks", () => {
  const [g] = parseScoreboard(board(), "NFL", 60);
  assert.deepStrictEqual(g.info, {
    round: "Week 5",
    short: ["Bills", "Rams"],
    records: ["3-1", "2-2"],
    venue: "SoFi Stadium, Inglewood, CA",
    neutral: false,
    soccer: false,
    tv: ["ESPN", "ABC", "ESPN+"],
  });
  assert.strictEqual(parseScoreboard(board({ seasonType: 1, week: 2 }), "NFL", 60)[0].info.round, "Preseason Week 2");
  assert.strictEqual(parseScoreboard(board({ seasonType: 3, week: 1 }), "NFL", 60)[0].info.round, null, "playoff week numbers mean nothing");
  assert.strictEqual(parseScoreboard(board({ notes: [{ headline: "ALCS - Game 1" }] }), "MLB", 30)[0].info.round, "ALCS Game 1");
  assert.strictEqual(parseScoreboard(board(), "MLB", 30)[0].info.round, null, "only football has weeks");
});

test("a finished game's records are dropped, since they already count the result", () => {
  const [g] = parseScoreboard(board({ state: "post", competitors: [competitor("home", "Los Angeles Rams", "Rams", "2-3"), competitor("away", "Buffalo Bills", "Bills", "4-1")] }), "NFL", 60);
  assert.deepStrictEqual(g.info.records, [null, null]);
});

function espnEvent(scoreboard, sport, extra = {}) {
  const schedule = parseScoreboard(scoreboard, sport, 60, extra.parse || {});
  const idx = buildEventIndex(
    [{ id: "e66", type: "tv", name: "US - ESPN PLUS 66 : BUFFALO BILLS @ LOS ANGELES RAMS OCT 12 – 8:15 PM ET / OCT 13 – 1:15 AM UK", category: "ESPN PLUS" }],
    { now: KICKOFF + 30 * 60000, groupOf: (c) => c.category, schedule },
  );
  return [...idx.values()][0];
}

test("an ESPN game's pool_event: league and week, teams with records, venue, networks, ESPN's times", () => {
  const e = espnEvent(board(), "NFL");
  assert.deepStrictEqual(poolEvent(e), {
    title: "NFL · Week 5",
    description: "Bills (3-1) at Rams (2-2). SoFi Stadium, Inglewood, CA. On ESPN, ABC and ESPN+.",
    category: "Football",
    start: S("2026-10-13T00:15:00Z"),
    end: Math.ceil(e.end / 1000),
  });
  assert.ok(e.end - e.start >= 3600000);
});

test("soccer lists home first, and a neutral site uses vs", () => {
  const soccer = poolEvent({
    title: "Coventry City vs Newcastle United",
    sport: "Premier League",
    start: KICKOFF,
    end: KICKOFF + 2 * 3600000,
    sources: [],
    info: { league: "Premier League", round: null, short: ["Newcastle", "Coventry"], records: ["4-1-1", "2-1-3"], venue: "Coventry Building Society Arena, Coventry, England", soccer: true, neutral: false, tv: ["USA Net"] },
  });
  assert.strictEqual(soccer.title, "Premier League");
  assert.strictEqual(soccer.description, "Coventry (2-1-3) vs Newcastle (4-1-1). Coventry Building Society Arena, Coventry, England. On USA Net.");
  assert.strictEqual(soccer.category, "Soccer");

  const neutral = poolEvent({
    title: "Texas Longhorns @ Oklahoma Sooners",
    start: KICKOFF,
    end: KICKOFF + 3 * 3600000,
    sources: [],
    info: { league: "College Football", round: "Week 6", short: ["Texas", "Oklahoma"], records: [null, null], venue: "Cotton Bowl, Dallas, TX", soccer: false, neutral: true, tv: ["ABC"] },
  });
  assert.strictEqual(neutral.description, "Texas vs Oklahoma. Cotton Bowl, Dallas, TX. On ABC.");
});

test("a guide event's pool_event uses its league and the description of the listing it came from", () => {
  const idx = buildEventIndex(
    [{ id: "u", type: "tv", name: "US - ESPN U", category: "USA SPORTS", epg: "u" }],
    {
      now: Date.parse("2026-10-12T18:00:00Z"),
      groupOf: (c) => c.category,
      epgIdOf: (c) => c.epg,
      epgData: { u: [{ s: S("2026-10-12T17:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Live: College Football", d: "From Saban Field at Bryant-Denny Stadium in Tuscaloosa, Ala." }] },
    },
  );
  const [e] = [...idx.values()];
  assert.deepStrictEqual(poolEvent(e), {
    title: "College Football",
    description: "From Saban Field at Bryant-Denny Stadium in Tuscaloosa, Ala.",
    category: "Football",
    start: S("2026-10-12T17:00:00Z"),
    end: S("2026-10-12T20:00:00Z"),
  });
});

test("an event slot with no guide gets a title but no description, and a bad time span gets nothing", () => {
  const slotOnly = poolEvent({ title: "Regis Prograis vs Joseph Diaz Jr", start: KICKOFF, end: KICKOFF + 3 * 3600000, sources: ["DAZN PPV"], network: "DAZN" });
  assert.ok(slotOnly.title);
  assert.strictEqual(slotOnly.description, undefined);
  assert.strictEqual(poolEvent({ title: "x", start: KICKOFF, end: KICKOFF, sources: [] }), null);
});

test("a slot's guide title gives the sport, without the matchup after the colon", () => {
  const p = poolEvent({
    title: "Regis Prograis vs Joseph Diaz Jr",
    start: KICKOFF,
    end: KICKOFF + 3600000,
    sources: ["DAZN PPV"],
    guide: { t: "Boxing : Regis Prograis vs. Joseph Diaz Jr.", d: "Former world champions battle in Chicago." },
  });
  assert.strictEqual(p.title, "Boxing");
  assert.strictEqual(p.category, "Fighting");
  assert.strictEqual(poolEvent({ title: "NASCAR · Premier Sports", start: KICKOFF, end: KICKOFF + 3600000, sources: [], league: "NASCAR O'Reilly Series: Charlotte 2" }).title, "NASCAR O'Reilly Series: Charlotte 2");
  assert.strictEqual(poolEvent({ title: "Fútbol Americano NFL · ESPN Deportes", start: KICKOFF, end: KICKOFF + 3600000, sources: [], programme: "Fútbol Americano NFL" }).category, "Football");
  assert.strictEqual(poolEvent({ title: "Bundesliga Basketball · Next Level Sports", start: KICKOFF, end: KICKOFF + 3600000, sources: [], programme: "Bundesliga Basketball" }).category, "Basketball");
});

test("a matchup written with 'at' is dropped from the title only when it names the event's teams", () => {
  const ev = (teams, t) => poolEvent({ title: "x", teams, start: KICKOFF, end: KICKOFF + 3600000, sources: [], guide: { t } });
  assert.strictEqual(ev(["North Texas", "Texas State"], "College Football : North Texas at Texas State").title, "College Football");
  assert.strictEqual(ev(null, "PGA Tour Golf: Final Round at Pebble Beach").title, "PGA Tour Golf: Final Round at Pebble Beach");
  assert.strictEqual(ev(["Clemson", "Florida State"], "College Softball: ACC Final at Clearwater").title, "College Softball: ACC Final at Clearwater");
});

test("a league-named listing of a game ESPN shows as finished doesn't come back as its own event", () => {
  const game = (state) => ({
    id: "402",
    sport: "College Football",
    importance: 50,
    start: Date.parse("2026-10-12T19:00:00Z"),
    teams: [["Ole Miss", "Ole Miss Rebels", "Ole Miss", "MISS"], ["Kentucky", "Kentucky Wildcats", "Kentucky", "UK"]],
    label: "Ole Miss Rebels @ Kentucky Wildcats",
    name: "Ole Miss Rebels @ Kentucky Wildcats",
    networks: ["SEC Network"],
    state,
    detail: "",
  });
  const build = (state, now) =>
    buildEventIndex([{ id: "sec", type: "tv", name: "US - SEC NETWORK", category: "USA SPORTS", epg: "sec" }], {
      now,
      groupOf: (c) => c.category,
      epgIdOf: (c) => c.epg,
      epgData: { sec: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T22:30:00Z"), t: "College Football", d: "" }] },
      schedule: [game(state)],
    });
  const during = build("in", Date.parse("2026-10-12T20:00:00Z"));
  assert.deepStrictEqual([...during.values()].map((e) => e.title), ["Ole Miss Rebels @ Kentucky Wildcats"]);
  const after = Date.parse("2026-10-12T21:45:00Z");
  assert.deepStrictEqual(currentEvents(build("post", after), after).map((e) => e.title), []);
});
