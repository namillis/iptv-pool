const fetch = require('node-fetch');

// [path, label, tier, extra query]. The tier is the league's base importance for sorting Live Now.
const LEAGUES = [
    ['football/college-football', 'College Football', 40],
    // The default college football scoreboard only lists FBS games; group 81 is FCS.
    ['football/college-football', 'College Football', 10, 'groups=81'],
    ['football/nfl', 'NFL', 60],
    ['basketball/nba', 'NBA', 40],
    ['basketball/wnba', 'WNBA', 30],
    ['basketball/mens-college-basketball', "Men's College Basketball", 30],
    ['basketball/womens-college-basketball', "Women's College Basketball", 15],
    ['baseball/mlb', 'MLB', 30],
    ['baseball/college-baseball', 'College Baseball', 5],
    ['hockey/nhl', 'NHL', 30],
    ['hockey/mens-college-hockey', "Men's College Hockey", 8],
    ['hockey/womens-college-hockey', "Women's College Hockey", 4],
    ['soccer/usa.1', 'MLS', 15],
    ['soccer/usa.nwsl', 'NWSL', 10],
    ['soccer/usa.ncaa.m.1', "Men's College Soccer", 3],
    ['soccer/usa.ncaa.w.1', "Women's College Soccer", 3],
    ['soccer/eng.1', 'Premier League', 30],
    ['soccer/eng.2', 'EFL Championship', 10],
    ['soccer/esp.1', 'LaLiga', 25],
    ['soccer/esp.2', 'LaLiga 2', 5],
    ['soccer/ita.1', 'Serie A', 20],
    ['soccer/ger.1', 'Bundesliga', 20],
    ['soccer/fra.1', 'Ligue 1', 15],
    ['soccer/uefa.champions', 'Champions League', 35],
    ['soccer/uefa.europa', 'Europa League', 20],
    ['soccer/uefa.nations', 'UEFA Nations League', 25],
    ['soccer/concacaf.nations.league', 'CONCACAF Nations League', 20],
    ['soccer/mex.1', 'Liga MX', 15],
    ['volleyball/womens-college-volleyball', "Women's College Volleyball", 5],
    ['field-hockey/womens-college-field-hockey', 'College Field Hockey', 2],
    ['lacrosse/mens-college-lacrosse', "Men's College Lacrosse", 8],
    ['lacrosse/womens-college-lacrosse', "Women's College Lacrosse", 4]
];
const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/';
const FEATURED_URL = 'https://site.web.api.espn.com/apis/personalized/v2/scoreboard/header?region=us&lang=en&contentorigin=espn';
const BROADCAST_TV = new Set(['ABC', 'CBS', 'NBC', 'FOX']);
const MAJOR_TV = new Set(['ESPN', 'ESPN2', 'TNT', 'TBS', 'TRUTV', 'FS1', 'USA NET', 'PRIME VIDEO', 'NETFLIX']);
const NETWORK_POINTS = { broadcast: 20, major: 12, tv: 6 };
const POSTSEASON_RE = /post-?season|playoff|knockout|round-of|final/i;
const PRESEASON_RE = /pre-?season/i;
const POSTSEASON_BONUS = 40;
const PRESEASON_PENALTY = 25;
const RANKED_MAX = 25;
const RANK_WEIGHT = 0.6;
const BOTH_RANKED_BONUS = 10;
const RANK_FULL_TIER = 30;
const FEATURED_BONUS = 8;
const TICKET_FLOOR = 25;
const TICKET_WEIGHT = 3;
const TICKET_MAX = 8;
const TICKET_MEMO_MS = 36 * 3600000;
const REFRESH_MS = 15 * 60000;
const RETRY_MS = 2 * 60000;
const TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

const state = { games: [], races: [], history: [], version: 0, at: 0, failedAt: 0, loading: null, historyLoading: null };
const F1_URL = `${BASE_URL}racing/f1/scoreboard`;
// ESPN stops listing ticket prices once a game starts, so the last price seen is kept per game.
const ticketMemo = new Map();
// Finished games from the days before yesterday, so a guide airing of last weekend's game is recognized as a replay.
// A past day's results don't change, so each league's day is fetched once and kept until it leaves the window.
const HISTORY_DAYS = 10;
const HISTORY_MIN_TIER = 10;
const historyDays = new Map();

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function etDate(ms) {
    return dateFmt.format(new Date(ms)).replace(/-/g, '');
}

function teamNames(team) {
    return [team.location, team.displayName, team.shortDisplayName, team.abbreviation].filter(Boolean);
}

function rankOf(competitor) {
    const r = competitor.curatedRank?.current;
    return Number.isInteger(r) && r >= 1 && r <= RANKED_MAX ? r : null;
}

function ticketPrice(comp) {
    const m = String(comp.tickets?.[0]?.summary || '').match(/\$\s*([\d,]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function networkPoints(comp) {
    const national = (comp.geoBroadcasts || [])
        .filter(g => g.market?.type === 'National' && g.type?.shortName !== 'Radio' && g.media?.shortName)
        .map(g => ({ name: g.media.shortName.toUpperCase(), tv: g.type?.shortName === 'TV' }));
    if (!national.length) {
        for (const b of comp.broadcasts || []) {
            if (b.market === 'national') for (const n of b.names || []) national.push({ name: String(n).toUpperCase(), tv: true });
        }
    }
    let best = 0;
    for (const { name, tv } of national) {
        const pts = BROADCAST_TV.has(name) ? NETWORK_POINTS.broadcast
            : MAJOR_TV.has(name) ? NETWORK_POINTS.major
                : tv ? NETWORK_POINTS.tv : 0;
        best = Math.max(best, pts);
    }
    return best;
}

function baseImportance(tier, seasonSlug, ranks, netPts) {
    let score = tier + netPts;
    if (POSTSEASON_RE.test(seasonSlug)) score += POSTSEASON_BONUS;
    else if (PRESEASON_RE.test(seasonSlug)) score -= PRESEASON_PENALTY;
    const ranked = ranks.filter(Boolean);
    let rankPts = ranked.reduce((sum, r) => sum + (RANKED_MAX + 1 - r) * RANK_WEIGHT, 0);
    if (ranked.length === 2) rankPts += BOTH_RANKED_BONUS;
    return score + rankPts * Math.min(1, tier / RANK_FULL_TIER);
}

function ticketPoints(price) {
    if (!price || price <= TICKET_FLOOR) return 0;
    return Math.min(TICKET_MAX, TICKET_WEIGHT * Math.log2(price / TICKET_FLOOR));
}

// "Buffalo Bills @ Los Angeles Rams", or home first for soccer ("Coventry City vs Newcastle United"), plus ESPN's
// round note when it has one ("ALCS - Game 1" becomes "· ALCS Game 1").
function gameName(away, home, comp, soccer) {
    const a = away.team.displayName || away.team.location;
    const h = home.team.displayName || home.team.location;
    const note = roundNote(comp);
    const name = soccer ? `${h} vs ${a}` : `${a} @ ${h}`;
    return note ? `${name} · ${note}` : name;
}

function roundNote(comp) {
    return String(comp?.notes?.[0]?.headline || '').replace(/\s+[-–]\s+/g, ' ').trim();
}

// ESPN's round note, or the week for football ("Week 5", "Preseason Week 2"). Football playoff weeks have no
// meaningful number, so they only use the note.
function roundOf(ev, json, comp, sport) {
    const note = roundNote(comp);
    if (note) return note;
    const week = ev.week?.number ?? json?.week?.number;
    if (!/football|^nfl$/i.test(sport) || !Number.isInteger(week)) return null;
    const type = ev.season?.type;
    if (type === 1) return `Preseason Week ${week}`;
    return type === 3 ? null : `Week ${week}`;
}

function recordOf(competitor) {
    const r = (competitor.records || []).find(x => x.type === 'total') || competitor.records?.[0];
    return r && /^\d+(?:-\d+){1,2}$/.test(r.summary || '') ? r.summary : null;
}

function venueOf(comp) {
    const v = comp?.venue;
    if (!v?.fullName) return null;
    const a = v.address || {};
    const place = a.state || (a.country && a.country !== 'USA' ? a.country : null);
    return [v.fullName, a.city, place].filter(Boolean).filter((s, i, all) => all.indexOf(s) === i).join(', ');
}

// National TV first, then national streaming, without radio: ["ESPN", "ABC"], ["ESPN+"].
function nationalNetworks(comp) {
    const geo = (comp?.geoBroadcasts || []).filter(g => g.market?.type === 'National' && g.media?.shortName && g.type?.shortName !== 'Radio');
    const names = [
        ...geo.filter(g => g.type?.shortName === 'TV').map(g => g.media.shortName),
        ...geo.filter(g => g.type?.shortName !== 'TV').map(g => g.media.shortName)
    ];
    if (!names.length) for (const b of comp?.broadcasts || []) if (b.market === 'national') names.push(...(b.names || []));
    return [...new Set(names)];
}

function parseScoreboard(json, sport, tier = 0, { soccer = false } = {}) {
    const games = [];
    for (const ev of json?.events || []) {
        const comp = ev.competitions?.[0];
        const competitors = (comp?.competitors || []).filter(c => c.team);
        if (competitors.length !== 2) continue;
        const start = Date.parse(ev.date);
        if (!Number.isFinite(start)) continue;
        const away = competitors.find(c => c.homeAway === 'away') || competitors[0];
        const home = competitors.find(c => c !== away) || competitors[1];
        const networks = [...new Set([
            ...(comp.geoBroadcasts || []).map(g => g.media?.shortName),
            ...(comp.broadcasts || []).flatMap(b => b.names || [])
        ].filter(Boolean))];
        const type = ev.status?.type || {};
        games.push({
            id: ev.id ? String(ev.id) : null,
            sport,
            importance: baseImportance(tier, ev.season?.slug || '', [rankOf(away), rankOf(home)], networkPoints(comp)),
            ticket: ticketPrice(comp),
            start,
            teams: [teamNames(away.team), teamNames(home.team)],
            label: `${away.team.displayName || away.team.location} @ ${home.team.displayName || home.team.location}`,
            name: gameName(away, home, comp, soccer),
            networks,
            color: home.team.color || away.team.color || null,
            altColor: home.team.alternateColor || away.team.alternateColor || null,
            state: type.state || 'pre',
            detail: type.shortDetail || '',
            info: {
                round: roundOf(ev, json, comp, sport),
                short: [away.team.shortDisplayName || away.team.location, home.team.shortDisplayName || home.team.location],
                // A finished game's records already count its result.
                records: type.state === 'post' ? [null, null] : [recordOf(away), recordOf(home)],
                venue: venueOf(comp),
                neutral: !!comp.neutralSite,
                soccer,
                tv: nationalNetworks(comp)
            }
        });
    }
    return games;
}

async function fetchJson(url) {
    const res = await fetch(url, { timeout: TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function featuredIds() {
    try {
        const json = await fetchJson(FEATURED_URL);
        const ids = new Set();
        for (const s of json?.sports || []) for (const l of s.leagues || []) for (const ev of l.events || []) if (ev.id) ids.add(String(ev.id));
        return ids;
    } catch (e) {
        console.warn('[ESPN] Featured list failed:', e.message);
        return new Set();
    }
}

function scoreGames(games, featured, now) {
    for (const [id, memo] of ticketMemo) if (now - memo.at > TICKET_MEMO_MS) ticketMemo.delete(id);
    for (const g of games) {
        if (g.id && g.ticket) ticketMemo.set(g.id, { price: g.ticket, at: now });
        const price = g.ticket || (g.id && ticketMemo.get(g.id)?.price) || null;
        g.importance += ticketPoints(price) + (g.id && featured.has(g.id) ? FEATURED_BONUS : 0);
        g.importance = Math.round(g.importance * 10) / 10;
    }
    return games;
}

// Grand Prix weekends from ESPN's F1 calendar, plus the current weekend's race time and whether it has finished.
function parseRaces(json) {
    const races = [];
    for (const c of json?.leagues?.[0]?.calendar || []) {
        const start = Date.parse(c.startDate);
        const end = Date.parse(c.endDate);
        if (c.label && !isNaN(start)) races.push({ name: c.label, weekendStart: start, weekendEnd: isNaN(end) ? null : end });
    }
    for (const ev of json?.events || []) {
        const race = (ev.competitions || []).find(c => /^race$/i.test(c.type?.abbreviation || ''));
        const start = race && Date.parse(race.date);
        if (!ev.name || !start) continue;
        let entry = races.find(r => r.name === ev.name && Math.abs(r.weekendStart - start) < 7 * 86400000);
        if (!entry) races.push(entry = { name: ev.name, weekendStart: Date.parse(ev.date) || start });
        entry.raceStart = start;
        entry.finished = !!race.status?.type?.completed;
    }
    return races;
}

async function fetchRaces() {
    try {
        return parseRaces(await fetchJson(F1_URL));
    } catch (e) {
        console.warn('[ESPN] F1 calendar failed:', e.message);
        return null;
    }
}

async function refresh(now) {
    // Yesterday's scoreboards are loaded so a guide airing of a game that finished last night is recognized as a replay.
    const dates = [etDate(now - 86400000), etDate(now)];
    const jobs = [];
    for (const [path, sport, tier, query] of LEAGUES) {
        for (const d of dates) jobs.push({ url: `${BASE_URL}${path}/scoreboard?dates=${d}&limit=500${query ? '&' + query : ''}`, sport, tier, soccer: path.startsWith('soccer/') });
    }
    const featured = featuredIds();
    const races = fetchRaces();
    const games = [];
    const seen = new Set();
    let loaded = 0;
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const batch = await Promise.allSettled(
            jobs.slice(i, i + CONCURRENCY).map(j => fetchJson(j.url).then(json => parseScoreboard(json, j.sport, j.tier, { soccer: j.soccer })))
        );
        for (const r of batch) {
            if (r.status !== 'fulfilled') continue;
            loaded++;
            for (const g of r.value) {
                if (g.id && seen.has(g.id)) continue;
                if (g.id) seen.add(g.id);
                games.push(g);
            }
        }
    }
    if (!loaded) throw new Error('no scoreboards loaded');
    return { games: scoreGames(games, await featured, now), races: await races };
}

async function loadHistory(now) {
    const wanted = new Set();
    const jobs = [];
    for (let back = 2; back <= HISTORY_DAYS; back++) {
        const d = etDate(now - back * 86400000);
        for (const [path, sport, tier, query] of LEAGUES) {
            if (tier < HISTORY_MIN_TIER) continue;
            const key = `${path}|${query || ''}|${d}`;
            wanted.add(key);
            if (!historyDays.has(key)) jobs.push({ key, sport, url: `${BASE_URL}${path}/scoreboard?dates=${d}&limit=500${query ? '&' + query : ''}` });
        }
    }
    for (const key of historyDays.keys()) if (!wanted.has(key)) historyDays.delete(key);
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const batch = jobs.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(j => fetchJson(j.url).then(json => parseScoreboard(json, j.sport))));
        results.forEach((r, k) => {
            if (r.status !== 'fulfilled') return;
            historyDays.set(batch[k].key, r.value.filter(g => g.state === 'post').map(({ id, sport, start, teams, label }) => ({ id, sport, start, teams, label, state: 'post' })));
        });
    }
    const seen = new Set();
    const out = [];
    for (const games of historyDays.values()) {
        for (const g of games) {
            if (g.id && seen.has(g.id)) continue;
            if (g.id) seen.add(g.id);
            out.push(g);
        }
    }
    return out;
}

function getSchedule(now = Date.now()) {
    const stale = now - state.at > REFRESH_MS && now - state.failedAt > RETRY_MS;
    if (stale && !state.loading) {
        state.loading = refresh(now)
            .then(({ games, races }) => {
                state.games = games;
                if (races) state.races = races;
                state.at = Date.now();
                state.version++;
            })
            .catch(e => {
                state.failedAt = Date.now();
                console.warn('[ESPN] Schedule refresh failed:', e.message);
            })
            .finally(() => { state.loading = null; });
        // Past results load on their own, so they never hold up today's schedule.
        if (!state.historyLoading) {
            state.historyLoading = loadHistory(now)
                .then(history => {
                    if (history.length !== state.history.length) state.version++;
                    state.history = history;
                })
                .catch(e => console.warn('[ESPN] Results history failed:', e.message))
                .finally(() => { state.historyLoading = null; });
        }
    }
    return state;
}

module.exports = { getSchedule, parseScoreboard, parseRaces, LEAGUES };
