const fetch = require('node-fetch');

const EVENTS_URL = 'https://gamma-api.polymarket.com/events';
// Data API v2: v1 was retired on 2026-11-02 and answers 410. v2 wraps rows in `data`; size, price and timestamp
// keep their names.
const TRADES_URL = 'https://data-api.polymarket.com/v2/trades';
// Polymarket's tag for single games, as opposed to season-long markets.
const GAMES_TAG = 100639;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const TRADES_LIMIT = 50;
const CONCURRENCY = 6;
const POLL_MS = 5 * 60000;
const WINDOW_S = 15 * 60;
const MIN_SPAN_S = 60;
const STALE_MS = 15 * 60000;
const IDLE_STOP_MS = 6 * 3600000;
const TIMEOUT_MS = 10000;
const RATE_FLOOR = 250;
const RATE_WEIGHT = 4;
const BOOST_MAX = 30;

const state = { games: [], version: 0, at: 0, usedAt: 0, timer: null, loading: null };

function boostFor(rate) {
    if (!(rate > RATE_FLOOR)) return 0;
    return Math.min(BOOST_MAX, Math.round(RATE_WEIGHT * Math.log2(rate / RATE_FLOOR) * 10) / 10);
}

async function fetchJson(url) {
    const res = await fetch(url, { timeout: TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Responses come through a CDN cache, so "now" for the data is shifted back by the cached copy's age.
    return { body: await res.json(), age: Number(res.headers.get('age')) || 0 };
}

async function liveGames() {
    const byGame = new Map();
    for (let page = 0; page < MAX_PAGES; page++) {
        const { body } = await fetchJson(`${EVENTS_URL}?tag_id=${GAMES_TAG}&active=true&closed=false&live=true` +
            `&include_markets=false&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
        if (!Array.isArray(body)) throw new Error('unexpected response');
        for (const ev of body) {
            const teams = (ev.teams || []).map(t => {
                const names = [t?.name, t?.alias].filter(Boolean);
                return names.length ? [names.join(' '), ...names] : null;
            }).filter(Boolean);
            const start = Date.parse(ev.startTime);
            if (!ev.id || teams.length !== 2 || !Number.isFinite(start)) continue;
            // Side markets (halftime, innings, props) are separate events; the game's busiest event stands in for it.
            const key = String(ev.gameId ?? ev.id);
            const volume = Number(ev.volume) || 0;
            const cur = byGame.get(key);
            if (!cur || volume > cur.volume) {
                byGame.set(key, { id: ev.id, title: String(ev.title || '').replace(/\s+-\s+.*$/, ''), teams, start, volume });
            }
        }
        if (body.length < PAGE_SIZE) break;
    }
    return [...byGame.values()];
}

function tradeRate(trades, nowS) {
    const recent = trades.filter(t => t.timestamp >= nowS - WINDOW_S);
    if (!recent.length) return 0;
    const usd = recent.reduce((sum, t) => sum + (Number(t.size) || 0) * (Number(t.price) || 0), 0);
    const span = recent.length >= TRADES_LIMIT
        ? Math.max(MIN_SPAN_S, nowS - Math.min(...recent.map(t => t.timestamp)))
        : WINDOW_S;
    return usd / (span / 60);
}

async function refresh() {
    const games = await liveGames();
    const out = [];
    for (let i = 0; i < games.length; i += CONCURRENCY) {
        const batch = await Promise.allSettled(games.slice(i, i + CONCURRENCY).map(async g => {
            const { body, age } = await fetchJson(`${TRADES_URL}?event_id=${g.id}&limit=${TRADES_LIMIT}`);
            // A documented miss is `data: null`, which is no trades rather than a failure.
            const trades = body && 'data' in body ? body.data || [] : null;
            if (!Array.isArray(trades)) throw new Error('unexpected response');
            const rate = tradeRate(trades, Date.now() / 1000 - age);
            return { title: g.title, teams: g.teams, start: g.start, rate: Math.round(rate), boost: boostFor(rate) };
        }));
        for (const r of batch) if (r.status === 'fulfilled') out.push(r.value);
    }
    if (games.length && !out.length) throw new Error('no trade data loaded');
    return out;
}

function setGames(games) {
    state.games = games;
    state.version++;
}

function stop() {
    clearInterval(state.timer);
    state.timer = null;
    if (state.games.length) setGames([]);
}

function poll() {
    if (state.loading) return;
    if (Date.now() - state.usedAt > IDLE_STOP_MS) {
        stop();
        return;
    }
    state.loading = refresh()
        .then(games => {
            state.at = Date.now();
            setGames(games);
        })
        .catch(e => {
            console.warn('[Polymarket] Live trading refresh failed:', e.message);
            if (state.games.length && Date.now() - state.at > STALE_MS) setGames([]);
        })
        .finally(() => { state.loading = null; });
}

function getLiveActivity(now = Date.now()) {
    state.usedAt = now;
    if (!state.timer) {
        state.timer = setInterval(poll, POLL_MS);
        if (state.timer.unref) state.timer.unref();
        poll();
    }
    return state;
}

module.exports = { getLiveActivity, tradeRate, boostFor };
