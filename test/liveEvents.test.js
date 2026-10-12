const test = require("node:test");
const assert = require("node:assert");
const { buildEventIndex, currentEvents } = require("../liveEvents");

const NOW = Date.parse("2026-10-12T19:00:00Z");
const S = (iso) => Math.floor(Date.parse(iso) / 1000);

function slot(id, text) {
  return { id, type: "tv", name: text, category: "ESPN PLUS" };
}

function guideChannel(id, name, group = "SPORTS") {
  return { id, type: "tv", name, category: group, epg: id };
}

function index(channels, epgData = {}, extra = {}) {
  return buildEventIndex(channels, { now: NOW, groupOf: (c) => c.category, epgData, epgIdOf: (c) => c.epg || null, ...extra });
}

const titles = (idx) => [...idx.values()].map((e) => e.title).sort();

test("the same game under two labels is one event", () => {
  const idx = index([
    slot("a", "US - ESPN PLUS 06 : Burgos @ Granada 03:05 PM ET (Oct 12)"),
    slot("b", "US - ESPN PLUS 07 : EN Español – Burgos @ Granada 03:05 PM ET (Oct 12)"),
    slot("c", "US - ESPN PLUS 08 : Levante @ Sevilla – Soccer 03:00 PM ET (Oct 12)"),
    slot("d", "US - ESPN PLUS 09 : Laliga – Levante Ud @ Sevilla FC 03:00 PM ET (Oct 12)"),
  ]);
  assert.strictEqual(idx.size, 2);
  for (const e of idx.values()) assert.strictEqual(e.channels.length, 2, e.title);
});

test("different games that share a word stay apart", () => {
  const idx = index([
    slot("a", "US - FLO 01 : Volleyball - Azusa Pacific Vs Cal Lutheran Womens 03:00 PM ET (Oct 12)"),
    slot("b", "US - FLO 02 : Volleyball - Pacific Lutheran Vs Pacific Womens 03:00 PM ET (Oct 12)"),
    slot("c", "US - ESPN PLUS 01 : Utah Tech @ Idaho State 03:00 PM ET (Oct 12)"),
    slot("d", "US - ESPN PLUS 02 : Southern Utah @ Weber State 03:00 PM ET (Oct 12)"),
    slot("e", "US - FLO 03 : FC - LA Roche Vs Hilbert College Mens 03:00 PM ET (Oct 12)"),
    slot("f", "US - FLO 04 : FC - Hilbert College Vs LA Roche Womens 03:00 PM ET (Oct 12)"),
    slot("g", "US - FLO 05 : FC - Moravian Vs Scranton Womens 03:00 PM ET (Oct 12)"),
    slot("h", "US - FLO 06 : Live - Scranton Vs Moravian Field Hockey 03:00 PM ET (Oct 12)"),
  ]);
  assert.strictEqual(idx.size, 8, titles(idx).join(" | "));
});

test("a league or show listing that names both teams joins the game", () => {
  const idx = index(
    [
      slot("a", "CA - DAZN 04 : Coventry City @ Newcastle United 03:00 PM ET (Oct 12)"),
      guideChannel("sky", "UK - SKY SPORTS MAIN EVENT"),
      guideChannel("see", "DK - SEE"),
    ],
    {
      sky: [{ s: S("2026-10-12T17:30:00Z"), e: S("2026-10-12T22:00:00Z"), t: "Monday Night Football", d: "Coventry City v Newcastle United Monday Night Football comes from the CBS Arena." }],
      see: [{ s: S("2026-10-12T18:55:00Z"), e: S("2026-10-12T21:00:00Z"), t: "Premier League: Coventry - Newcastle", d: "" }],
    },
  );
  assert.deepStrictEqual(titles(idx), ["Coventry City @ Newcastle United"]);
  assert.deepStrictEqual([...idx.values()][0].channels.map((c) => c.id).sort(), ["a", "see", "sky"]);
});

test("one programme on two spellings of a network is one event", () => {
  const p = { s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "International T20 Cricket", d: "T20 International cricket action from India." };
  const idx = index(
    [guideChannel("t1", "UK - TNT SPORT 4"), guideChannel("t2", "UK - TNT SPORTS 4")],
    { t1: [p], t2: [{ ...p, d: "3rd T20: India v West Indies T20 International cricket action from India." }] },
  );
  assert.strictEqual(idx.size, 1);
  assert.strictEqual([...idx.values()][0].channels.length, 2);
});

test("a venue line isn't read as a matchup", () => {
  const idx = index(
    [guideChannel("u", "US - ESPN U")],
    { u: [{ s: S("2026-10-12T17:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "College Football", d: "From Saban Field at Bryant-Denny Stadium in Tuscaloosa, Ala." }] },
  );
  assert.deepStrictEqual(titles(idx), ["College Football · ESPN U"]);
});

test("talk shows, podcasts and press conferences from event slots are dropped", () => {
  const idx = index([
    slot("a", "US - ESPN PLUS 50 : The Pat Mcafee Show 12:00 PM ET (Oct 12)"),
    slot("b", "US - ESPN PLUS 51 : NCAA Football – ACC Network Football Podcast 01:00 PM ET (Oct 12)"),
    slot("c", "US - ESPN PLUS 52 : Alabama Football Press Conference 02:00 PM ET (Oct 12)"),
    slot("d", "US - ESPN PLUS 53 : NCAA Football – Clemson @ Duke 02:00 PM ET (Oct 12)"),
  ]);
  assert.deepStrictEqual(titles(idx), ["NCAA Football – Clemson @ Duke"]);
});

test("replays: other-language replay text, and F1 outside its race weekend in German", () => {
  const races = [{ name: "Singapore Airlines Singapore Grand Prix", weekendStart: Date.parse("2026-10-09T11:30:00Z"), weekendEnd: Date.parse("2026-10-11T15:00:00Z"), raceStart: Date.parse("2026-10-11T12:00:00Z") }];
  const idx = index(
    [guideChannel("ol", "FR - OL TV"), guideChannel("tv3", "DK - TV3 SPORT"), guideChannel("bein", "AR - BEIN SPORTS 1 FRENCH")],
    {
      ol: [{ s: S("2026-10-12T18:30:00Z"), e: S("2026-10-12T20:30:00Z"), t: "Football : Ligue 1 McDonald's", d: "Revivez la rencontre entre le RC Lens et l'OL." }],
      tv3: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T21:00:00Z"), t: "Formel 1: Singapores Grand Prix", d: "" }],
      bein: [{ s: S("2026-10-12T18:40:00Z"), e: S("2026-10-12T20:45:00Z"), t: "Dijon vs Metz - Ligue 2", d: "Sport.", c: ["Football"] }],
    },
    { races },
  );
  assert.deepStrictEqual(titles(idx), ["Dijon vs Metz"]);
});

test("a Portuguese 'x' matchup is a matchup", () => {
  const idx = index(
    [guideChannel("sv", "BR - SPORTV 3", "BRAZIL"), guideChannel("sv2", "SPORTV 3", "BRASIL")],
    {
      sv: [{ s: S("2026-10-12T19:15:00Z"), e: S("2026-10-12T22:10:00Z"), t: "NFL: Las Vegas Raiders x New England Patriots", d: "" }],
      sv2: [{ s: S("2026-10-12T19:15:00Z"), e: S("2026-10-12T22:10:00Z"), t: "NFL: Las Vegas Raiders x New England Patriots", d: "Sinopse não disponível." }],
    },
  );
  const events = [...idx.values()];
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].teams, ["Las Vegas Raiders", "New England Patriots"]);
  assert.strictEqual(currentEvents(idx, NOW + 20 * 60000).length, 1);
});
