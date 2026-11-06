const fetch = require('node-fetch');
const { tentpoleOf } = require('./tentpoles');

const SCHEDULE_URL = 'https://api.tvmaze.com/schedule?country=US&date=';
const SEASONS_URL = id => `https://api.tvmaze.com/shows/${id}/seasons`;
// TVmaze's weight is a 0-100 popularity score; nearly every network show is 95 or more.
const MIN_WEIGHT = 90;
// Shows that are an event every week. Scripted shows only count on a premiere or finale.
const EVENT_TYPES = new Set(['Reality', 'Game Show', 'Variety', 'Award Show']);
const DEFAULT_RUNTIME_MIN = 60;
const REFRESH_MS = 30 * 60000;
const RETRY_MS = 5 * 60000;
const TIMEOUT_MS = 10000;
const CONCURRENCY = 4;
const SEASONS_TTL_MS = 24 * 3600000;
// A show's popularity is how many people read its English Wikipedia article: Wikidata maps the TVmaze id to the
// article, and Wikimedia's pageview API gives its daily views. Both are free and need no key.
const WIKIDATA_URL = 'https://query.wikidata.org/sparql?format=json&query=';
const PAGEVIEWS_URL = (article, from, to) => 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/' +
    `${encodeURIComponent(article)}/daily/${from}/${to}`;
const VIEW_DAYS = 7;
const ARTICLE_TTL_MS = 7 * 24 * 3600000;
const VIEWS_TTL_MS = 24 * 3600000;
const WIKIDATA_BATCH = 100;
// Wikimedia rate-limits clients that don't name themselves, and bursts, so pageviews are fetched one at a time.
const USER_AGENT = 'iptv-pool/1.0 (https://git.namillis.me/namillis/iptv; Live Now ranking)';
const PAGEVIEW_GAP_MS = 250;

const state = { shows: [], version: 0, at: 0, failedAt: 0, loading: null };
const seasonsMemo = new Map();
const articleMemo = new Map();
const viewsMemo = new Map();

const utcDay = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

async function fetchJson(url) {
    const res = await fetch(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function stripHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/\s+/g, ' ').trim();
}

/**
 * The listings worth showing in Live Now: tentpoles of any type, every episode of a popular weekly reality, game,
 * variety or award show, and the premieres and finales of popular scripted shows. Daily shows (soaps, talk shows,
 * news, game shows like The Price Is Right) number their seasons by year and are left out unless they're a tentpole.
 */
function candidates(episodes) {
    const out = [];
    for (const ep of episodes) {
        const show = ep.show || {};
        const start = Date.parse(ep.airstamp);
        if (!show.id || !show.name || !Number.isFinite(start)) continue;
        const tentpole = tentpoleOf(show.name, ep.name);
        const daily = ep.season > 1900;
        const popular = (show.weight || 0) >= MIN_WEIGHT && !daily && ep.type === 'regular';
        const weekly = popular && EVENT_TYPES.has(show.type);
        const scripted = popular && (show.type === 'Scripted' || show.type === 'Animation');
        if (!tentpole && !weekly && !scripted) continue;
        const runtime = ep.runtime || show.runtime || DEFAULT_RUNTIME_MIN;
        out.push({
            id: ep.id,
            showId: show.id,
            show: show.name,
            type: show.type,
            episode: ep.name || null,
            season: ep.season,
            number: ep.number,
            network: show.network?.name || show.webChannel?.name || null,
            weight: show.weight || 0,
            start,
            end: start + runtime * 60000,
            summary: stripHtml(ep.summary) || null,
            // A yearly special like the Oscars is episode 1 of its year, not a premiere.
            premiere: !daily && !tentpole && ep.number === 1,
            seriesPremiere: !daily && !tentpole && ep.number === 1 && ep.season === 1,
            tentpole,
            needsFinaleCheck: scripted && !tentpole && ep.number !== 1
        });
    }
    return out;
}

async function seasonsOf(showId, now) {
    const memo = seasonsMemo.get(showId);
    if (memo && now - memo.at < SEASONS_TTL_MS) return memo.seasons;
    const seasons = await fetchJson(SEASONS_URL(showId));
    seasonsMemo.set(showId, { at: now, seasons });
    return seasons;
}

async function markFinales(shows, now) {
    const pending = shows.filter(s => s.needsFinaleCheck);
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
        const batch = pending.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(s => seasonsOf(s.showId, now)));
        results.forEach((r, k) => {
            if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
            const season = r.value.find(x => x.number === batch[k].season);
            if (season && season.episodeOrder && season.episodeOrder === batch[k].number) batch[k].finale = true;
        });
    }
    for (const id of seasonsMemo.keys()) if (now - seasonsMemo.get(id).at >= SEASONS_TTL_MS) seasonsMemo.delete(id);
    // A scripted show is only an event on a premiere or a finale.
    return shows.filter(s => !s.needsFinaleCheck || s.finale).map(({ needsFinaleCheck, ...s }) => s);
}

function expire(memo, ttl, now) {
    for (const [k, v] of memo) if (now - v.at >= ttl) memo.delete(k);
}

async function loadArticles(showIds, now) {
    const missing = showIds.filter(id => !articleMemo.has(id));
    for (let i = 0; i < missing.length; i += WIKIDATA_BATCH) {
        const batch = missing.slice(i, i + WIKIDATA_BATCH);
        const query = `SELECT ?tvm ?article WHERE { VALUES ?tvm { ${batch.map(id => `"${id}"`).join(' ')} } ?item wdt:P8600 ?tvm . ` +
            '?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }';
        const json = await fetchJson(WIKIDATA_URL + encodeURIComponent(query));
        const found = new Map((json.results?.bindings || []).map(b => [Number(b.tvm.value), decodeURIComponent(b.article.value.split('/wiki/')[1])]));
        for (const id of batch) articleMemo.set(id, { at: now, article: found.get(id) || null });
    }
}

/** Each show's average daily Wikipedia views over the last week, or null when it has no article or they didn't load. */
async function addViews(shows, now) {
    expire(articleMemo, ARTICLE_TTL_MS, now);
    expire(viewsMemo, VIEWS_TTL_MS, now);
    const ids = [...new Set(shows.filter(s => !s.tentpole).map(s => s.showId))];
    await loadArticles(ids, now).catch(e => console.warn('[TVMAZE] Wikidata lookup failed:', e.message));
    const to = utcDay(now - 86400000);
    const from = utcDay(now - VIEW_DAYS * 86400000);
    const pending = ids.filter(id => articleMemo.get(id)?.article && !viewsMemo.has(id));
    let failed = 0;
    for (const id of pending) {
        try {
            const json = await fetchJson(PAGEVIEWS_URL(articleMemo.get(id).article, from, to));
            const total = (json.items || []).reduce((sum, x) => sum + (x.views || 0), 0);
            viewsMemo.set(id, { at: now, views: Math.round(total / VIEW_DAYS) });
        } catch {
            failed++;
        }
        await new Promise(r => setTimeout(r, PAGEVIEW_GAP_MS));
    }
    if (failed) console.warn(`[TVMAZE] Pageviews failed for ${failed} of ${pending.length} shows`);
    for (const s of shows) s.views = viewsMemo.get(s.showId)?.views ?? null;
    return shows;
}

async function refresh(now) {
    // TVmaze lists a show under its Eastern airdate, so a 12:35 AM talk show is in the day before. Yesterday through
    // tomorrow covers every listing that can be on within the next few hours.
    const days = [-1, 0, 1].map(d => dateFmt.format(new Date(now + d * 86400000)));
    const results = await Promise.allSettled(days.map(d => fetchJson(SCHEDULE_URL + d)));
    const episodes = results.filter(r => r.status === 'fulfilled' && Array.isArray(r.value)).flatMap(r => r.value);
    if (!episodes.length) throw new Error('no schedule days loaded');
    return addViews(await markFinales(candidates(episodes), now), now);
}

function getTvSchedule(now = Date.now()) {
    const stale = now - state.at > REFRESH_MS && now - state.failedAt > RETRY_MS;
    if (stale && !state.loading) {
        state.loading = refresh(now)
            .then(shows => {
                state.shows = shows;
                state.at = Date.now();
                state.version++;
            })
            .catch(e => {
                state.failedAt = Date.now();
                console.warn('[TVMAZE] Schedule refresh failed:', e.message);
            })
            .finally(() => { state.loading = null; });
    }
    return state;
}

module.exports = { getTvSchedule, candidates };
