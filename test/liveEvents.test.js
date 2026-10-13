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

function past(sport, daysAgo, away, home) {
  return { id: `${away}-${home}`, sport, start: NOW - daysAgo * 86400000, teams: [away, home], label: `${away[0]} @ ${home[0]}`, state: "post" };
}

const VIKINGS = ["Minnesota", "Minnesota Vikings", "Vikings", "MIN"];
const SAINTS = ["New Orleans", "New Orleans Saints", "Saints", "NO"];
const FALCONS = ["Atlanta", "Atlanta Falcons", "Falcons", "ATL"];
const ARSENAL = ["Arsenal", "Arsenal", "Arsenal", "ARS"];
const LEEDS = ["Leeds United", "Leeds United", "Leeds", "LEE"];

test("guide airings of games ESPN listed as finished in the last days are replays", () => {
  const prog = (t, d, extra = {}) => [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T21:30:00Z"), t, d, ...extra }];
  const channels = [
    guideChannel("bein", "UK - BEIN SPORTS 2 ENGLISH"),
    guideChannel("sky", "UK - SKY SPORTS ACTION"),
    guideChannel("cup", "UK - SKY SPORTS MAIN EVENT"),
    guideChannel("live", "UK - SKY SPORTS NFL"),
  ];
  const epg = {
    bein: prog("Minnesota Vikings @ New Orleans Saints - NFL -National Footbal League – 2026/27", "The National Football League (NFL) is composed of 32 teams."),
    sky: prog("NFL Football", "The New Orleans Saints face the Atlanta Falcons in the NFL."),
    cup: prog("EFL Cup Football", "Arsenal v Leeds United. Third round action from the Emirates."),
    live: prog("NFL Football", "Atlanta Falcons v New Orleans Saints.", { l: 1 }),
  };
  const history = [past("NFL", 2, VIKINGS, SAINTS), past("NFL", 7, FALCONS, SAINTS), past("Premier League", 3, LEEDS, ARSENAL)];
  assert.strictEqual(titles(index(channels, epg)).length, 3);
  const kept = titles(index(channels, epg, { schedule: [], history }));
  assert.deepStrictEqual(kept.sort(), ["Arsenal vs Leeds United", "Atlanta Falcons vs New Orleans Saints"]);
});

test("a description listing several bouts is a compilation show, not a game", () => {
  const idx = index(
    [guideChannel("nbc", "US - NBC SPORTS CALIFORNIA")],
    { nbc: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Fight Sports MMA", d: "This episode features Aoiyama vs Takekaze, Kotoshogiku vs Terunofuji, Endo vs Kakuryu, Jokoryu vs Goeido." }] },
  );
  assert.deepStrictEqual(titles(idx), []);
});

test("a lead-in before the first team and 'face off against' are read correctly", () => {
  const idx = index(
    [guideChannel("tnt", "UK - TNT SPORTS 4"), guideChannel("tnt2", "UK - TNT SPORTS 3")],
    {
      tnt: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Serie A Football", d: "Serie A action as Como face off against Roma." }],
      tnt2: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Serie A Football", d: "Action from Serie A as Cagliari host Juventus." }],
    },
  );
  assert.deepStrictEqual([...idx.values()].map((e) => e.teams).sort(), [["Como", "Roma"], ["Juventus", "Cagliari"]]);
});

test("two guides an hour apart for one match are one event", () => {
  const idx = index(
    [guideChannel("uk", "UK - PREMIER SPORTS 2"), guideChannel("ie", "UK: PREMIER SPORTS 2 IRELAND")],
    {
      uk: [{ s: S("2026-10-12T18:30:00Z"), e: S("2026-10-12T20:30:00Z"), t: "LaLiga", d: "Alavés v Atlético Madrid." }],
      ie: [{ s: S("2026-10-12T19:30:00Z"), e: S("2026-10-12T21:30:00Z"), t: "LaLiga", d: "Alavés v Atlético Madrid." }],
    },
  );
  assert.strictEqual(idx.size, 1, titles(idx).join(" | "));
  assert.strictEqual([...idx.values()][0].channels.length, 2);
});

test("a sport-only listing of a game on the same channel at the same time is the same broadcast", () => {
  const idx = index(
    [guideChannel("dz", "DAZN Ringside", "PLUTO TV USA")],
    {
      dz: [
        { s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Boxing : Jose Resendiz vs. Jaime Munguia", d: "All the boxing action." },
        { s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Boxing", d: "All the boxing action." },
      ],
    },
  );
  assert.deepStrictEqual(titles(idx), ["Jose Resendiz vs Jaime Munguia"]);
});

test("NFL listings naming an earlier week than ESPN's are replays", () => {
  const sky = (d) => index(
    [guideChannel("sky", "UK - SKY SPORTS ACTION")],
    { sky: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "NFL Football", d }] },
    { schedule: [mnfGame({ start: Date.parse("2026-10-13T00:15:00Z"), state: "pre", info: { round: "Week 5" } })] },
  );
  assert.deepStrictEqual(titles(sky("A week four match-up from the 2026 NFL.")), []);
  assert.deepStrictEqual(titles(sky("The NFL touches down in London with a week 4 clash at the Tottenham Hotspur Stadium.")), []);
  assert.deepStrictEqual(titles(sky("Live coverage of a week five match-up from the 2026 NFL.")), ["NFL Football · Sky Sports Action"]);
  assert.deepStrictEqual(titles(sky("Live NFL coverage.")), ["NFL Football · Sky Sports Action"], "no week named");
});

test("listings named after a past year, ending in a production year, or an encore are replays", () => {
  const one = (p) => titles(index([guideChannel("c", "US - ACC NETWORK")], { c: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T22:00:00Z"), ...p }] }));
  assert.deepStrictEqual(one({ t: "2022 Softball Championship -- Clemson vs. Florida State", d: "The Tigers and Seminoles go down the wire." }), []);
  assert.deepStrictEqual(one({ t: "ICC World T20I 2024 - India vs Bangladesh-T20 Cricket", d: "" }), []);
  assert.deepStrictEqual(one({ t: "Fight Sports: World Class Championship Boxing", d: "Boxing action. 2012" }), []);
  assert.deepStrictEqual(one({ t: "Origin Sports: College Football", d: "From Nov. 09, 2002." }), []);
  assert.deepStrictEqual(one({ t: "Liverpool Football", d: "An encore presentation of Liverpool's on-field action from the past week." }), []);
  assert.strictEqual(one({ t: "UEFA Champions League 2026-27 - FC Porto x Man City", d: "" }).length, 1, "a season range is current");
  assert.strictEqual(one({ t: "Rolex Shanghai Masters 2026 Tennis", d: "From Qizhong Forest Sports City Arena." }).length, 1);
  assert.strictEqual(one({ t: "Snooker: China Open", d: "Coverage from Taiyuan. The 2019 final went to the last frame." }).length, 1, "a year inside a description is history");
});

test("'come face to face' isn't a matchup, and ESPN+ studio slots are dropped", () => {
  const vh1 = index(
    [guideChannel("vh1", "US - VH1 EAST", "ENTERTAINMENT")],
    { vh1: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T20:00:00Z"), t: "Basketball Wives", d: "Malaysia and Jackie come face to face; Liza is encouraged to move on." }] },
  );
  assert.deepStrictEqual(titles(vh1), []);
  const slots = index([
    slot("a", "US - ESPN PLUS 62 : MNF Playbook Kickoff 08:00 PM ET (Oct 12)"),
    slot("b", "US - ESPN PLUS 65 : SEC In 60 08:00 PM ET (Oct 12)"),
    slot("c", "US - HBO MAX 02 : MLB Lead Off – Episode 30 07:30 PM ET (Oct 12)"),
  ]);
  assert.deepStrictEqual(titles(slots), []);
});

test("a guide that double-books a slot with two sports keeps both", () => {
  const idx = index(
    [guideChannel("ie", "UK: PREMIER SPORTS 2 IRELAND")],
    {
      ie: [
        { s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T22:00:00Z"), t: "NASCAR O'Reilly Series", d: "The Blue Cross NC 300 from Charlotte Motor Speedway." },
        { s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T22:00:00Z"), t: "Elite Ice Hockey League", d: "Glasgow Clan v Guildford Flames." },
      ],
    },
  );
  assert.deepStrictEqual(titles(idx), ["Glasgow Clan vs Guildford Flames", "NASCAR O'Reilly Series · Premier Sports"]);
});

test("a game that took in an hour-off feed doesn't swallow what that feed shows at the game's time", () => {
  const idx = index(
    [guideChannel("uk", "UK - PREMIER SPORTS 2"), guideChannel("ie", "UK: PREMIER SPORTS 2 IRELAND")],
    {
      uk: [{ s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T21:00:00Z"), t: "Elite Ice Hockey League", d: "Glasgow Clan v Guildford Flames." }],
      ie: [
        { s: S("2026-10-12T19:00:00Z"), e: S("2026-10-12T22:00:00Z"), t: "NASCAR O'Reilly Series", d: "The Blue Cross NC 300 from Charlotte Motor Speedway." },
        { s: S("2026-10-12T20:00:00Z"), e: S("2026-10-12T22:00:00Z"), t: "Elite Ice Hockey League", d: "Glasgow Clan v Guildford Flames." },
      ],
    },
  );
  assert.deepStrictEqual(titles(idx), ["Glasgow Clan vs Guildford Flames", "NASCAR O'Reilly Series · Premier Sports"]);
});
