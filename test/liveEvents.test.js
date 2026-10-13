const test = require("node:test");
const assert = require("node:assert");
const { buildEventIndex, currentEvents } = require("../liveEvents");
const { parseScoreboard } = require("../espnSchedule");
const { M3UEPGAddon } = require("../addon");

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

const MNF = Date.parse("2026-10-13T00:15:00Z");

function mnfGame(extra = {}) {
  return {
    id: "401",
    sport: "NFL",
    importance: 80,
    start: MNF,
    teams: [["Buffalo", "Buffalo Bills", "Bills", "BUF"], ["Los Angeles", "Los Angeles Rams", "Rams", "LAR"]],
    label: "Buffalo Bills @ Los Angeles Rams",
    name: "Buffalo Bills @ Los Angeles Rams",
    networks: ["ESPN", "ABC"],
    state: "in",
    detail: "",
    ...extra,
  };
}

test("a game ESPN lists takes ESPN's name, and every listing of it joins one event", () => {
  const idx = index(
    [
      slot("mc", "CA - DAZN 05 : MANNINGCAST – MNF WITH PEYTON & ELI – BILLS @ RAMS OCT 12 – 8:15 PM ET / OCT 13 – 1:15 AM UK"),
      slot("e66", "US - ESPN PLUS 66 : BUFFALO BILLS @ LOS ANGELES RAMS OCT 12 – 8:15 PM ET / OCT 13 – 1:15 AM UK"),
      slot("e68", "US - ESPN PLUS 68 : BUFFALO BILLS @ LOS ANGELES RAMS – ESPAÑOL OCT 12 – 8:15 PM ET / OCT 13 – 1:15 AM UK"),
      guideChannel("krdo", "US - ABC 13 COLORADO SPRINGS (KRDO)", "USA LOCALS"),
    ],
    {
      krdo: [{ s: S("2026-10-13T00:15:00Z"), e: S("2026-10-13T03:30:00Z"), t: "Live: NFL Football", d: "The Rams host the Bills at SoFi Stadium. Buffalo lost its previous game to New England 29-17." }],
    },
    { now: MNF + 30 * 60000, schedule: [mnfGame()] },
  );
  assert.deepStrictEqual(titles(idx), ["Buffalo Bills @ Los Angeles Rams"]);
  const e = [...idx.values()][0];
  assert.deepStrictEqual(e.channels.map((c) => c.id).sort(), ["e66", "e68", "krdo", "mc"]);
  assert.deepStrictEqual(e.channels.filter((c) => c.alt).map((c) => c.id).sort(), ["e68", "mc"]);
});

test("'X host Y at venue' is Y @ X", () => {
  const idx = index(
    [guideChannel("krdo", "US - ABC 13 COLORADO SPRINGS (KRDO)", "USA LOCALS")],
    { krdo: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T22:00:00Z"), t: "Live: NFL Football", d: "The Rams host the Bills at SoFi Stadium." }] },
  );
  const events = [...idx.values()];
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].teams, ["Bills", "Rams"]);
});

test("ESPN names: home first for soccer, the round note, and the sport for college leagues", () => {
  const team = (displayName, homeAway) => ({ homeAway, team: { displayName, location: displayName } });
  const board = (away, home, notes = []) => ({
    events: [{ id: "1", date: "2026-10-12T19:00Z", status: { type: { state: "pre" } }, competitions: [{ notes, competitors: [team(away, "away"), team(home, "home")] }] }],
  });
  assert.strictEqual(parseScoreboard(board("Newcastle United", "Coventry City"), "Premier League", 30, { soccer: true })[0].name, "Coventry City vs Newcastle United");
  assert.strictEqual(parseScoreboard(board("Cleveland Guardians", "Tampa Bay Rays", [{ headline: "ALCS - Game 1" }]), "MLB", 30)[0].name, "Cleveland Guardians @ Tampa Bay Rays · ALCS Game 1");

  const duke = (sport) => ({
    ...mnfGame({ sport, start: Date.parse("2026-10-12T19:00:00Z"), state: "pre", networks: [] }),
    teams: [["Duke", "Duke Blue Devils", "Blue Devils", "DUKE"], ["North Carolina", "North Carolina Tar Heels", "Tar Heels", "UNC"]],
    name: "Duke Blue Devils vs North Carolina Tar Heels",
  });
  const listing = [slot("w", "US - ESPN PLUS 10 : Womens Soccer – Duke vs North Carolina 03:00 PM ET (Oct 12)")];
  assert.deepStrictEqual(titles(index(listing, {}, { schedule: [duke("Women's College Soccer")] })), ["Duke Blue Devils vs North Carolina Tar Heels · Women's Soccer"]);
  const mismatched = titles(index(listing, {}, { schedule: [duke("Men's College Soccer")] }));
  assert.ok(/^Womens Soccer/.test(mismatched[0]), mismatched[0]);
  const doubleBill = [slot("d", "US - ESPN PLUS 11 : Duke @ North Carolina – Racing Santander @ Valencia 03:00 PM ET (Oct 12)")];
  assert.ok(/Racing Santander/.test(titles(index(doubleBill, {}, { schedule: [duke("College Field Hockey")] }))[0]));
});

test("an ESPN-listed game uses ESPN's start time", () => {
  const idx = index(
    [slot("mc", "CA - DAZN 05 : MANNINGCAST – MNF WITH PEYTON & ELI – BILLS @ RAMS OCT 12 – 8:00 PM ET / OCT 13 – 1:00 AM UK")],
    {},
    { now: MNF + 30 * 60000, schedule: [mnfGame()] },
  );
  assert.strictEqual([...idx.values()][0].start, MNF);
});

test("alternate broadcasts play after the main broadcast and foreign guide matches", () => {
  const flagged = (title) => [...index([slot("x", `US - ESPN PLUS 01 : ${title} 03:00 PM ET (Oct 12)`)]).values()][0].channels[0].alt === true;
  assert.ok(flagged("Burgos @ Granada – ESPAÑOL"));
  assert.ok(flagged("Cádiz @ Sporting Gijón (SPANISH)"));
  assert.ok(flagged("EN ESPAÑOL – Tenerife @ Girona FC"));
  assert.ok(!flagged("Hockey - Iroquois Falls Storm vs French River Rapids"));
  assert.ok(!flagged("Rugby - Stade Francais vs Vodacom Bulls"));
  const programmes = {
    sky: { s: 0, e: Infinity, t: "NFL", d: "LA Rams play the Buffalo Bills at SoFi Stadium." },
    krdo: { s: 0, e: Infinity, t: "Live: NFL Football", d: "The Rams host the Bills at SoFi Stadium." },
  };
  const pool = {
    channelById: (id) => ({ id, epg: id }),
    epgIdOf: (item) => item.epg,
    programmeAt: (epg) => programmes[epg] || null,
    channelWeight: () => 1,
  };
  const e = {
    start: MNF,
    teams: ["Bills", "Rams"],
    gameTeams: mnfGame().teams,
    channels: [
      { id: "mc", slot: "CA - DAZN 05", kind: "slot", alt: true },
      { id: "e66", slot: "US - ESPN PLUS 66", kind: "slot" },
      { id: "sky", slot: "UK - SKY SPORTS MAIN EVENT" },
      { id: "krdo", slot: "US - ABC 13 COLORADO SPRINGS (KRDO)" },
    ],
  };
  const order = M3UEPGAddon.prototype.rankedEventChannels.call(pool, e).map((c) => c.id);
  assert.deepStrictEqual(order, ["krdo", "e66", "sky", "mc"]);
});
