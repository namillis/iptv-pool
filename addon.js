// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const { parseXmltvStream } = require("./epgParser");
const { buildEventIndex, currentEvents, todayEvents, eventState, eventCardUrl, cardTitleFor, categoryOf, applyLiveActivity, SPORT_CATEGORIES } = require("./liveEvents");
const eventCards = require("./eventCard");
const { getSchedule } = require("./espnSchedule");
const { getLiveActivity } = require("./polymarketLive");
const { version: ADDON_VERSION } = require("./package.json");
const fetch = require('node-fetch');
const zlib = require('zlib');
const { once } = require('events');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const REDIS_TTL_MS = parseInt(process.env.REDIS_TTL_MS || (24 * 3600 * 1000).toString(), 10);
const REDIS_MAX_BYTES = parseInt(process.env.REDIS_MAX_BYTES || (9.5 * 1024 * 1024).toString(), 10);
const REDIS_TIMEOUT_MS = 4000;

let redisClient = null;
let redisLastError = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            connectTimeout: 10000
        });
        redisClient.on('error', e => {
            redisLastError = e.message;
            console.error('[REDIS] Error:', e.message);
        });
        redisClient.on('ready', () => {
            redisLastError = null;
            console.log('[REDIS] Ready');
        });
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

function redisStatus() {
    if (!redisClient) return 'off';
    if (redisClient.status === 'ready') return 'connected';
    return redisLastError ? 'error' : 'connecting';
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
    ]).finally(() => clearTimeout(timer));
}

const yieldToLoop = () => new Promise(setImmediate);
const GUIDE_LINES_PER_YIELD = 200;

async function redisSetGuide(key, epgData, lastEpgUpdate, ttl) {
    if (!redisClient) return;
    try {
        const gz = zlib.createGzip();
        const parts = [];
        gz.on('data', c => parts.push(c));
        const finished = new Promise((resolve, reject) => { gz.on('end', resolve); gz.on('error', reject); });
        gz.write(JSON.stringify({ lastEpgUpdate }) + '\n');
        let lines = 0;
        for (const ch in epgData) {
            if (!gz.write(JSON.stringify([ch, epgData[ch]]) + '\n')) await once(gz, 'drain');
            if (++lines % GUIDE_LINES_PER_YIELD === 0) await yieldToLoop();
        }
        gz.end();
        await finished;
        const packed = Buffer.concat(parts);
        if (packed.length > REDIS_MAX_BYTES) {
            console.warn(`[REDIS] Skipped guide save: ${(packed.length / 1048576).toFixed(1)} MB compressed is over the ${(REDIS_MAX_BYTES / 1048576).toFixed(1)} MB limit`);
            return;
        }
        await withTimeout(redisClient.set(key, packed, 'PX', ttl), REDIS_TIMEOUT_MS * 3);
        console.log(`[REDIS] Saved guide ${(packed.length / 1024).toFixed(0)} KB`);
    } catch (e) {
        console.warn('[REDIS] Guide save failed:', e.message);
    }
}

async function redisGetGuide(key) {
    if (!redisClient) return null;
    try {
        const raw = await withTimeout(redisClient.getBuffer(key), REDIS_TIMEOUT_MS);
        if (!raw || !raw.length) return null;
        const text = await gunzip(raw);
        let pos = text.indexOf(10);
        if (pos === -1) return null;
        const { lastEpgUpdate } = JSON.parse(text.toString('utf8', 0, pos));
        const epgData = {};
        let lines = 0;
        while (++pos < text.length) {
            let end = text.indexOf(10, pos);
            if (end === -1) end = text.length;
            const [ch, list] = JSON.parse(text.toString('utf8', pos, end));
            epgData[ch] = list;
            pos = end;
            if (++lines % GUIDE_LINES_PER_YIELD === 0) await yieldToLoop();
        }
        return { epgData, lastEpgUpdate };
    } catch (e) {
        console.warn('[REDIS] Guide read failed:', e.message);
        return null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await withTimeout(redisClient.getBuffer(key), REDIS_TIMEOUT_MS);
        if (!raw || !raw.length) return null;
        const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
        const text = isGzip ? (await gunzip(raw)).toString('utf8') : raw.toString('utf8');
        return JSON.parse(text);
    } catch (e) {
        console.warn('[REDIS] Read failed:', e.message);
        return null;
    }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        const packed = await gzip(Buffer.from(JSON.stringify(value), 'utf8'));
        if (packed.length > REDIS_MAX_BYTES) {
            console.warn(`[REDIS] Skipped save: ${(packed.length / 1048576).toFixed(1)} MB compressed is over the ${(REDIS_MAX_BYTES / 1048576).toFixed(1)} MB limit`);
            return;
        }
        await withTimeout(redisClient.set(key, packed, 'PX', ttl), REDIS_TIMEOUT_MS * 3);
        console.log(`[REDIS] Saved ${(packed.length / 1024).toFixed(0)} KB`);
    } catch (e) {
        console.warn('[REDIS] Save failed:', e.message);
    }
}

const GROUP_CATALOG_MAX = 100;
const SEPARATOR_RE = /^\s*[#=*\-_~|]{3,}.*[#=*\-_~|]{3,}\s*$/;

function isSeparator(item) {
    return !!item && typeof item.name === 'string' && SEPARATOR_RE.test(item.name);
}
const EPG_FUTURE_MS = 36 * 3600000;
const EPG_REFRESH_MS = parseInt(process.env.EPG_REFRESH_MS || (3600 * 1000).toString(), 10);
const EPG_CACHE_PREFIX = 'addon:epg:v2:';
const CATCHUP_TTL_MS = 5 * 60 * 1000;
const EVENT_INDEX_TTL_MS = 10 * 60 * 1000;
const LIVE_NOW_CACHE_S = 60;
const EVENT_STREAMS_MAX = 25;
const cardCache = new LRUCache({ max: 400, ttl: 12 * 3600 * 1000 });
const CATCHUP_CACHE_MAX = 200;
const EPG_DESC_MAX = 400;

function validTimezone(tz) {
    if (!tz || typeof tz !== 'string') return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        return null;
    }
}

function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        m3uUrl: config.m3uUrl,
        epgUrl: config.epgUrl,
        enableEpg: !!config.enableEpg,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        xtreamUseM3U: !!config.xtreamUseM3U,
        xtreamOutput: config.xtreamOutput,
        epgOffsetHours: config.epgOffsetHours,
        epgTimezone: config.epgTimezone,
        epgLocalTimes: !!config.epgLocalTimes,
        groupCatalogs: !!config.groupCatalogs,
        groupFilter: config.groupFilter || '',
        includeSeries: config.includeSeries !== false, // default true
        liveOnly: !!config.liveOnly,
        catchup: !!config.catchup,
        hideAdult: config.hideAdult !== false
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        this.seriesInfoCache = new Map(); // seriesId -> { videos: [...], fetchedAt }
        this.catchupCache = new Map();
        this.epgData = {};
        this.lastUpdate = 0;
        this.lastEpgUpdate = 0;
        this.log = makeLogger(config.debug);

        // Direct provider may populate this (seriesId -> episodes array)
        this.directSeriesEpisodeIndex = new Map();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours) > 48)
            this.config.epgOffsetHours = 0;
        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;
        this.timezone = validTimezone(this.config.epgTimezone);
        this.tzOffsetCache = new Map();
        if (this.timezone) {
            this.tzParts = new Intl.DateTimeFormat('en-US', {
                timeZone: this.timezone, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        }

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            epgOffsetHours: this.config.epgOffsetHours,
            includeSeries: this.config.includeSeries
        });
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            const [data, epg] = await Promise.all([
                redisGetJSON(cacheKey),
                redisGetGuide(EPG_CACHE_PREFIX + this.cacheKey)
            ]);
            if (data) {
                cached = {
                    channels: data.channels,
                    movies: data.movies,
                    series: data.series,
                    lastUpdate: data.lastUpdate,
                    epgData: epg?.epgData || {},
                    lastEpgUpdate: epg?.lastEpgUpdate || 0
                };
                dataCache.set(cacheKey, cached);
            }
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            this.lastEpgUpdate = cached.lastEpgUpdate || 0;
            this.dropAdult();
            // Direct series episodes index is not persisted; rebuild on next fetch
            this.log.debug('Cache hit for data', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                lastUpdate: new Date(this.lastUpdate).toISOString()
            });
        }
    }

    async saveToCache(epgChanged) {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const lists = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, { ...lists, epgData: this.epgData, lastEpgUpdate: this.lastEpgUpdate });
        await redisSetJSON(cacheKey, lists, REDIS_TTL_MS);
        if (epgChanged) {
            await redisSetGuide(EPG_CACHE_PREFIX + this.cacheKey, this.epgData, this.lastEpgUpdate, REDIS_TTL_MS);
        }
        this.log.debug('Saved data to cache', { epgChanged: !!epgChanged });
    }

    isAdult(i) {
        const text = `${i.name || ''} ${i.category || i.attributes?.['group-title'] || ''}`;
        return /xxx/i.test(text);
    }

    dropAdult() {
        if (this.config.hideAdult === false) return;
        this.channels = this.channels.filter(i => !this.isAdult(i));
        this.movies = this.movies.filter(i => !this.isAdult(i));
        this.series = this.series.filter(i => !this.isAdult(i));
    }

    channelGroup(c) {
        const g = c.category || c.attributes?.['group-title'];
        return g ? String(g).trim() : '';
    }

    epgIdOf(item) {
        return item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'] || null;
    }

    buildGroupCatalogs(tvCatalog) {
        const catalogs = this.manifestRef.catalogs;
        for (let i = catalogs.length - 1; i >= 0; i--) {
            if (catalogs[i].id.startsWith('iptv_grp_')) catalogs.splice(i, 1);
        }
        this.groupCatalogMap = new Map();
        if (!this.config.groupCatalogs) return;

        const terms = String(this.config.groupFilter || '')
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(Boolean);
        const ordered = [];
        const seen = new Set();
        for (const c of this.channels) {
            const g = this.channelGroup(c);
            if (!g || seen.has(g)) continue;
            seen.add(g);
            if (terms.length && !terms.some(t => g.toLowerCase().includes(t))) continue;
            ordered.push(g);
        }

        const groupCatalogs = ordered.slice(0, GROUP_CATALOG_MAX).map(name => {
            const id = 'iptv_grp_' + crypto.createHash('md5').update(name).digest('hex').slice(0, 12);
            this.groupCatalogMap.set(id, name);
            return { type: 'tv', id, name, extra: [{ name: 'search' }, { name: 'skip' }] };
        });
        catalogs.splice(catalogs.indexOf(tvCatalog) + 1, 0, ...groupCatalogs);
        this.log.debug('Group catalogs built', { matched: ordered.length, added: groupCatalogs.length });
    }

    buildCatchupCatalog(tvCatalog) {
        const catalogs = this.manifestRef.catalogs;
        const existing = catalogs.findIndex(c => c.id === 'iptv_catchup');
        if (existing !== -1) catalogs.splice(existing, 1);
        const channels = this.channels.filter(c => this.catchupEnabledFor(c));
        if (!channels.length) return;
        const groups = [...new Set(channels.map(c => this.channelGroup(c)).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
        catalogs.splice(catalogs.indexOf(tvCatalog) + 1, 0, {
            type: 'tv',
            id: 'iptv_catchup',
            name: 'Catch-up TV',
            extra: [{ name: 'genre', options: groups }, { name: 'search' }, { name: 'skip' }],
            genres: groups
        });
        this.log.debug('Catch-up catalog built', { channels: channels.length, groups: groups.length });
    }

    liveEventIndex() {
        const now = Date.now();
        const schedule = getSchedule(now);
        const activity = getLiveActivity(now);
        if (!this.eventIndex || this.eventIndexFor !== this.channels || this.eventIndexEpg !== this.epgData ||
            this.eventIndexSchedule !== schedule.version || now - this.eventIndexAt > EVENT_INDEX_TTL_MS) {
            this.eventIndex = buildEventIndex(this.channels, {
                now,
                groupOf: c => this.channelGroup(c),
                epgData: this.epgData,
                epgIdOf: c => this.epgIdOf(c),
                schedule: schedule.games
            });
            this.eventIndexFor = this.channels;
            this.eventIndexEpg = this.epgData;
            this.eventIndexSchedule = schedule.version;
            this.eventIndexAt = now;
            this.eventIndexActivity = null;
        }
        if (this.eventIndexActivity !== activity.version) {
            applyLiveActivity(this.eventIndex, activity.games);
            this.eventIndexActivity = activity.version;
        }
        return this.eventIndex;
    }

    buildLiveNowCatalog(tvCatalog) {
        const catalogs = this.manifestRef.catalogs;
        for (const id of ['iptv_live_now', 'iptv_today']) {
            const existing = catalogs.findIndex(c => c.id === id);
            if (existing !== -1) catalogs.splice(existing, 1);
        }
        const index = this.liveEventIndex();
        if (!index.size) return;
        const sources = [...new Set([...index.values()].flatMap(e => e.sources))].sort((a, b) => a.localeCompare(b));
        const options = [...SPORT_CATEGORIES, ...sources.filter(s => !SPORT_CATEGORIES.includes(s))];
        const extra = [{ name: 'genre', options }, { name: 'search' }, { name: 'skip' }];
        catalogs.splice(catalogs.indexOf(tvCatalog), 0,
            { type: 'tv', id: 'iptv_live_now', name: 'Live Now', extra, genres: options },
            { type: 'tv', id: 'iptv_today', name: 'Today', extra: extra.map(x => ({ ...x })), genres: options });
        this.log.debug('Live Now catalog built', { events: index.size, sources: sources.length });
    }

    formatEventTime(ms, now = Date.now()) {
        const opts = { timeZone: this.timezone || 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
        if (Math.abs(ms - now) > 12 * 3600000) opts.weekday = 'short';
        return new Date(ms).toLocaleString('en-US', opts);
    }

    eventMetaPreview(e, now = Date.now()) {
        const when = this.formatEventTime(e.start, now);
        const live = eventState(e, now) === 'live';
        const count = e.channels.length;
        const headline = e.status === 'in' && e.statusDetail
            ? `🔴 Live · ${e.statusDetail}`
            : (live ? `🔴 Live now · started ${when}` : `⏰ Starts ${when}`);
        return {
            id: e.id,
            type: 'tv',
            name: e.title,
            poster: this.eventPosterUrl(e),
            posterShape: 'landscape',
            description: `${headline}\n${[e.sport || e.league, e.network].filter(Boolean).map(s => s + ' · ').join('')}${e.sources.join(' · ')} · ${count} channel${count === 1 ? '' : 's'}`,
            genres: e.sources,
            runtime: live ? 'Live' : when
        };
    }

    eventChannels(e) {
        if (e.channels.length <= EVENT_STREAMS_MAX) return e.channels;
        return [...e.channels].sort((a, b) => a.slot.length - b.slot.length).slice(0, EVENT_STREAMS_MAX);
    }

    cardSpec(e) {
        const category = categoryOf(e);
        return {
            title: cardTitleFor(e),
            category,
            color: eventCards.cardColor(e, category),
            footer: [e.sport, e.network].filter(Boolean).join(' · ') || e.sources[0] || ''
        };
    }

    eventPosterUrl(e) {
        if (!eventCards.available() || !this.publicBase) return eventCardUrl(e);
        const v = crypto.createHash('md5').update(JSON.stringify(this.cardSpec(e))).digest('hex').slice(0, 10);
        return `${this.publicBase}/card/${e.id}.jpg?v=${v}`;
    }

    async renderEventCard(id) {
        const e = this.liveEventIndex().get(id);
        if (!e) return null;
        const spec = this.cardSpec(e);
        const key = JSON.stringify(spec);
        const cached = cardCache.get(key);
        if (cached) return cached;
        const buf = await eventCards.renderCard(spec);
        if (buf) cardCache.set(key, buf);
        return buf;
    }

    getEventMeta(id) {
        const e = this.liveEventIndex().get(id);
        if (!e) return null;
        const meta = this.eventMetaPreview(e);
        const shown = this.eventChannels(e);
        meta.description += '\n\n' + shown.map(c => `• ${this.eventChannelLabel(c)}`).join('\n');
        if (shown.length < e.channels.length) meta.description += `\n…and ${e.channels.length - shown.length} more`;
        return meta;
    }

    getEventStreams(id) {
        const e = this.liveEventIndex().get(id);
        if (!e) return [];
        const streams = [];
        for (const ch of this.eventChannels(e)) {
            const stream = this.getStream(ch.id);
            if (stream) streams.push({ ...stream, name: this.eventStreamName(ch, stream), title: ch.slot });
        }
        return streams;
    }

    eventStreamName(ch) {
        return ch.source;
    }

    eventChannelLabel(ch) {
        return ch.slot;
    }

    buildGenresInManifest() {
        if (!this.manifestRef || !this.manifestReady) return;
        const tvCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_channels');
        const movieCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_movies');
        const seriesCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_series');

        // Helper: set catalog.genres (options are added post-build to avoid SDK linter size limits)
        function setGenresOnCatalog(catalog, groups) {
            if (!catalog) return;
            catalog.genres = groups;
            const genreExtra = Array.isArray(catalog.extra) && catalog.extra.find(e => e.name === 'genre');
            if (genreExtra && groups.length) genreExtra.options = [...groups];
        }

        if (tvCatalog) {
            const groups = [
                ...new Set(
                    this.channels
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            if (!groups.includes('All Channels')) groups.unshift('All Channels');
            setGenresOnCatalog(tvCatalog, groups);
            this.buildGroupCatalogs(tvCatalog);
            this.buildCatchupCatalog(tvCatalog);
            this.buildLiveNowCatalog(tvCatalog);
        }

        if (movieCatalog) {
            const movieGroups = [
                ...new Set(
                    this.movies
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            setGenresOnCatalog(movieCatalog, movieGroups);
        }

        if (seriesCatalog) {
            const seriesGroups = [
                ...new Set(
                    this.series
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            setGenresOnCatalog(seriesCatalog, seriesGroups);
        }

        this.log.debug('Catalog genres built', {
            tvGenres: tvCatalog?.genres?.length || 0,
            movieGenres: movieCatalog?.genres?.length || 0,
            seriesGenres: seriesCatalog?.genres?.length || 0
        });
    }

    parseM3U(content) {
        const startTs = Date.now();
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (matches) {
                    currentItem = {
                        duration: parseInt(matches[1]),
                        attributes: this.parseAttributes(matches[2] || ''),
                        name: (matches[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id = currentItem.attributes['tvg-id'] || currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];

                const group = (currentItem.attributes['group-title'] || '').toLowerCase();
                const lower = currentItem.name.toLowerCase();

                const isMovie =
                    group.includes('movie') ||
                    lower.includes('movie') ||
                    this.isMovieFormat(currentItem.name);

                const isSeries =
                    !isMovie && (
                        group.includes('series') ||
                        group.includes('show') ||
                        /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name) ||
                        /\bSeason\s?\d+/i.test(currentItem.name)
                    );

                currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');
                currentItem.id = `iptv_${crypto.createHash('md5').update(currentItem.name + currentItem.url).digest('hex').substring(0, 16)}`;
                items.push(currentItem);
                currentItem = null;
            }
        }
        const ms = Date.now() - startTs;
        this.log.debug('M3U parsed', { lines: lines.length, items: items.length, ms });
        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return [/\(\d{4}\)/, /\d{4}\./, /HD$|FHD$|4K$/i].some(p => p.test(name));
    }

    async parseEPG(content) {
        const start = Date.now();
        try {
            const xml2js = require('xml2js');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            this.log.debug('EPG parsed', {
                channels: Object.keys(epgData).length,
                programmes: Object.values(epgData).reduce((a, b) => a + b.length, 0),
                ms: Date.now() - start
            });
            return epgData;
        } catch (e) {
            this.log.warn('EPG parse failed', e.message);
            return {};
        }
    }

    epgWantedChannels() {
        const ids = new Set();
        for (const c of this.channels) {
            const a = c.attributes || {};
            for (const v of [a['tvg-id'], a['tvg-name'], c.epg_channel_id]) if (v) ids.add(v);
        }
        return ids;
    }

    async parseEPGStream(stream) {
        const start = Date.now();
        const wanted = this.epgWantedChannels();
        const nowS = Math.floor(start / 1000);
        const endS = Math.floor((start + EPG_FUTURE_MS) / 1000);
        const timeCache = new Map();
        const toSec = (s) => {
            let v = timeCache.get(s);
            if (v === undefined) {
                v = Math.floor(this.epgTimeMs(s) / 1000);
                if (timeCache.size > 50000) timeCache.clear();
                timeCache.set(s, v);
            }
            return v;
        };
        const epgData = {};
        let kept = 0, seen = 0;
        try {
            ({ seen } = await parseXmltvStream(stream, {
                maxText: EPG_DESC_MAX,
                accept: (ch, startAttr, stopAttr) => {
                    if (wanted.size && !wanted.has(ch)) return null;
                    const s = toSec(startAttr);
                    const e = toSec(stopAttr);
                    return e > nowS && s <= endS ? [s, e] : null;
                },
                onProgramme: (ch, [s, e], title, desc, extra = {}) => {
                    const p = { s, e, t: title || 'Unknown' };
                    if (desc) p.d = desc;
                    if (extra.subTitle) p.st = extra.subTitle;
                    if (extra.categories?.length) p.c = extra.categories;
                    if (extra.live) p.l = 1;
                    if (extra.repeat) p.r = 1;
                    (epgData[ch] ||= []).push(p);
                    kept++;
                }
            }));
        } catch (e) {
            this.log.warn('EPG stream error', e.message);
        }
        for (const list of Object.values(epgData)) list.sort((a, b) => a.s - b.s);
        this.log.debug('EPG stream parsed', {
            channels: Object.keys(epgData).length,
            programmesSeen: seen,
            programmesKept: kept,
            wantedChannels: wanted.size,
            ms: Date.now() - start
        });
        return epgData;
    }

    tzOffsetMs(utcMs) {
        const bucket = Math.floor(utcMs / 900000);
        let off = this.tzOffsetCache.get(bucket);
        if (off === undefined) {
            const p = {};
            for (const { type, value } of this.tzParts.formatToParts(new Date(utcMs))) p[type] = value;
            off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
            this.tzOffsetCache.set(bucket, off);
        }
        return off;
    }

    zonedTimeToDate(year, month, day, hour, min, sec) {
        const wall = Date.UTC(year, month, day, hour, min, sec);
        let utc = wall - this.tzOffsetMs(wall);
        utc = wall - this.tzOffsetMs(utc);
        return new Date(utc);
    }

    formatTime(date) {
        const opts = { hour: '2-digit', minute: '2-digit' };
        if (this.timezone) opts.timeZone = this.timezone;
        return date.toLocaleTimeString([], opts);
    }

    epgTimeMs(s) {
        if (!s) return NaN;
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        let ms;
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);
            if (this.timezone && (!tz || this.config.epgLocalTimes)) {
                ms = this.zonedTimeToDate(year, month, day, hour, min, sec).getTime();
            } else if (tz) {
                const sign = tz[0] === '-' ? -1 : 1;
                const offMin = sign * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3, 5), 10));
                ms = Date.UTC(year, month, day, hour, min, sec) - offMin * 60000;
            } else {
                ms = new Date(year, month, day, hour, min, sec).getTime();
            }
        } else {
            ms = new Date(s).getTime();
        }
        return this.config.epgOffsetHours ? ms + this.config.epgOffsetHours * 3600000 : ms;
    }

    parseEPGTime(s) {
        return s ? new Date(this.epgTimeMs(s)) : new Date();
    }

    epgList(channelId) {
        return channelId && Object.hasOwn(this.epgData, channelId) ? this.epgData[channelId] : null;
    }

    epgProgram(p) {
        const startTime = new Date(p.s * 1000);
        const stopTime = new Date(p.e * 1000);
        return { title: p.t, description: p.d || '', start: startTime, stop: stopTime, startTime, stopTime };
    }

    getCurrentProgram(channelId) {
        const list = this.epgList(channelId);
        if (!list) return null;
        const now = Date.now() / 1000;
        for (const p of list) {
            if (p.s > now) break;
            if (now <= p.e) return this.epgProgram(p);
        }
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        const list = this.epgList(channelId);
        if (!list) return [];
        const now = Date.now() / 1000;
        const upcoming = [];
        for (const p of list) {
            if (p.s <= now) continue;
            upcoming.push(this.epgProgram(p));
            if (upcoming.length >= limit) break;
        }
        return upcoming;
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);

        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            if (typeof providerModule.fetchSeriesInfo === 'function') {
                const info = await providerModule.fetchSeriesInfo(this, seriesId);
                this.seriesInfoCache.set(seriesId, info);
                return info;
            }
        } catch (e) {
            this.log.warn('Series info fetch failed', seriesId, e.message);
        }
        // Fallback empty structure
        const empty = { videos: [] };
        this.seriesInfoCache.set(seriesId, empty);
        return empty;
    }

    hasEpg() {
        for (const _ in this.epgData) return true;
        return false;
    }

    epgDue(now = Date.now()) {
        if (!this.config.enableEpg) return false;
        const interval = this.hasEpg() ? EPG_REFRESH_MS : this.updateInterval;
        return now - (this.lastEpgUpdate || 0) >= interval;
    }

    needsRefresh(now = Date.now()) {
        return !this.lastUpdate || now - this.lastUpdate >= this.updateInterval || this.epgDue(now);
    }

    async updateData(force = false) {
        if (!force && CACHE_ENABLED && !this.needsRefresh()) {
            this.log.debug('Skip update (fresh)');
            return;
        }
        if (this.updatePromise) return this.updatePromise;
        this.updatePromise = this.runUpdate().finally(() => { this.updatePromise = null; });
        return this.updatePromise;
    }

    async runUpdate() {
        try {
            const start = Date.now();
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            const refreshEpg = this.epgDue(start);
            const staged = Object.create(this);
            staged.channels = [];
            staged.movies = [];
            staged.series = [];
            staged.epgData = refreshEpg ? {} : this.epgData;
            staged.directSeriesEpisodeIndex = new Map();
            await providerModule.fetchData(staged, { epg: refreshEpg });
            if (refreshEpg && !staged.hasEpg() && this.hasEpg()) {
                this.log.warn('[UPDATE] Guide came back empty, keeping the previous one');
                staged.epgData = this.epgData;
            }
            for (const key of Object.keys(staged)) this[key] = staged[key];
            this.channels = this.channels.filter(i => !isSeparator(i));
            this.movies = this.movies.filter(i => !isSeparator(i));
            this.series = this.series.filter(i => !isSeparator(i));
            this.dropAdult();
            this.lastUpdate = Date.now();
            if (refreshEpg) this.lastEpgUpdate = this.lastUpdate;
            if (CACHE_ENABLED) await this.saveToCache(refreshEpg);
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                epgRefreshed: refreshEpg,
                ms: Date.now() - start
            });
        } catch (e) {
            this.log.error('[UPDATE] Failed:', e.message);
        }
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        if (!tvgId)
            return `https://placehold.co/480x270/333333/FFFFFF/png?text=${encodeURIComponent(item.name)}`;
        return `logo/${encodeURIComponent(tvgId)}.png`;
    }

    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        if (item.type === 'tv') {
            const epgId = this.epgIdOf(item);
            const current = this.getCurrentProgram(epgId);
            meta.description = current
                ? `📡 Now: ${current.title}${current.description ? `\n${current.description}` : ''}`
                : '📡 Live Channel';
            meta.poster = this.deriveFallbackLogoUrl(item);
            meta.posterShape = 'landscape';
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']);
            meta.runtime = 'Live';
        } else if (item.type === 'movie') {
            meta.poster = item.poster ||
                item.attributes?.['tvg-logo'] ||
                `https://placehold.co/300x450/CC6600/FFFFFF/png?text=${encodeURIComponent(item.name)}`;
            meta.year = item.year;
            if (!meta.year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) meta.year = parseInt(m[1]);
            }
            meta.description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            meta.genres = item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'];
        } else if (item.type === 'series') {
            meta.poster = item.poster ||
                item.attributes?.['tvg-logo'] ||
                `https://placehold.co/300x450/3366CC/FFFFFF/png?text=${encodeURIComponent(item.name)}`;
            meta.description = item.plot || item.attributes?.['plot'] || 'Series / Show';
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Series']);
        }
        return meta;
    }

    getStream(id) {
        // Episode streams
        if (id.startsWith('iptv_series_ep_')) {
            const epEntry = this.lookupEpisodeById(id);
            if (!epEntry) return null;
            return {
                url: epEntry.url,
                title: `${epEntry.title || 'Episode'}${epEntry.season ? ` S${epEntry.season}E${epEntry.episode}` : ''}`,
                behaviorHints: { notWebReady: true }
            };
        }
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return {
            ...(item.type === 'tv' ? { name: 'Live' } : {}),
            url: item.url,
            title: item.type === 'tv' ? `${item.name} - Live` : item.name,
            behaviorHints: { notWebReady: true }
        };
    }

    catchupEnabledFor(item) {
        return !!(item && item.type === 'tv' && item.archiveDays && this.config.catchup &&
            this.providerName === 'xtream' && !this.config.xtreamUseM3U);
    }

    catchupLabel(entry) {
        let date = new Date(entry.startTs * 1000);
        const m = entry.start.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        if (m && this.timezone && this.config.epgLocalTimes) {
            date = this.zonedTimeToDate(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
        }
        const opts = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
        if (this.timezone) opts.timeZone = this.timezone;
        return date.toLocaleString('en-US', opts);
    }

    async getCatchupStreams(id) {
        const item = this.channels.find(i => i.id === id);
        if (!this.catchupEnabledFor(item)) return [];
        const cached = this.catchupCache.get(id);
        if (cached && Date.now() - cached.at < CATCHUP_TTL_MS) return cached.streams;

        let streams = [];
        try {
            const { fetchCatchup } = require('./src/js/providers/xtreamProvider.js');
            const entries = await fetchCatchup(this, item);
            streams = entries.map(e => ({
                name: e.nowPlaying ? 'Start over' : 'Catch-up',
                title: e.nowPlaying ? `⏪ ${e.title} (from ${this.catchupLabel(e)})` : `⏪ ${this.catchupLabel(e)} · ${e.title}`,
                url: e.url,
                behaviorHints: { notWebReady: true }
            }));
        } catch (e) {
            this.log.warn('Catch-up lookup failed', id, e.message);
        }
        this.catchupCache.set(id, { at: Date.now(), streams });
        if (this.catchupCache.size > CATCHUP_CACHE_MAX)
            this.catchupCache.delete(this.catchupCache.keys().next().value);
        return streams;
    }

    lookupEpisodeById(epId) {
        // Check cached series info
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info && Array.isArray(info.videos)) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        // Direct provider inline index
        for (const arr of this.directSeriesEpisodeIndex.values()) {
            const found = arr.find(v => v.id === epId);
            if (found) return found;
        }
        return null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const videos = (info?.videos || []).map(v => {
            // Ensure released is a valid ISO date or omit it
            let released = v.released || undefined;
            if (released && typeof released === 'string') {
                // If it's a unix timestamp string, convert
                if (/^\d{9,13}$/.test(released)) {
                    const ts = released.length <= 10
                        ? parseInt(released, 10) * 1000
                        : parseInt(released, 10);
                    const d = new Date(ts);
                    released = !isNaN(d.getTime()) ? d.toISOString() : undefined;
                } else if (!released.includes('T') && !released.includes('Z')) {
                    // Try parsing non-ISO date strings
                    const d = new Date(released);
                    released = !isNaN(d.getTime()) ? d.toISOString() : undefined;
                }
            }
            const video = {
                id: v.id,
                title: v.title,
                season: v.season,
                episode: v.episode,
                thumbnail: v.thumbnail || seriesItem.poster || seriesItem.attributes?.['tvg-logo']
            };
            if (released) video.released = released;
            return video;
        });

        return {
            id: seriesItem.id,
            type: 'series',
            name: seriesItem.name,
            poster: seriesItem.poster ||
                seriesItem.attributes?.['tvg-logo'] ||
                `https://placehold.co/300x450/3366CC/FFFFFF/png?text=${encodeURIComponent(seriesItem.name)}`,
            description: seriesItem.plot || seriesItem.attributes?.['plot'] || 'Series / Show',
            genres: seriesItem.category
                ? [seriesItem.category]
                : (seriesItem.attributes?.['group-title'] ? [seriesItem.attributes['group-title']] : ['Series']),
            videos
        };
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = this.series.find(s => s.id === id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem);
        }
        // fallback sync path
        return this.getDetailedMeta(id);
    }

    getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        if (item.type === 'tv') {
            const epgId = this.epgIdOf(item);
            const current = this.getCurrentProgram(epgId);
            const upcoming = this.getUpcomingPrograms(epgId, 3);
            let description = `📺 CHANNEL: ${item.name}`;
            if (current) {
                const start = (current.startTime ? this.formatTime(current.startTime) : '') || '';
                const end = (current.stopTime ? this.formatTime(current.stopTime) : '') || '';
                description += `\n\n📡 NOW: ${current.title}${start && end ? ` (${start}-${end})` : ''}`;
                if (current.description) description += `\n\n${current.description}`;
            }
            if (upcoming.length) {
                description += '\n\n📅 UPCOMING:\n';
                for (const p of upcoming) {
                    description += `${this.formatTime(p.startTime)} - ${p.title}\n`;
                }
            }
            if (this.catchupEnabledFor(item)) {
                const days = item.archiveDays;
                description += `\n\n⏪ CATCH-UP: shows from the last ${days} day${days === 1 ? '' : 's'} are in the stream list`;
            }
            return {
                id: item.id,
                type: 'tv',
                name: item.name,
                poster: this.deriveFallbackLogoUrl(item),
                posterShape: 'landscape',
                description,
                genres: item.category
                    ? [item.category]
                    : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
                runtime: 'Live'
            };
        } else {
            let year = item.year;
            if (!year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) year = parseInt(m[1]);
            }
            const description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            return {
                id: item.id,
                type: 'movie',
                name: item.name,
                poster: item.poster || item.attributes?.['tvg-logo'] ||
                    `https://placehold.co/300x450/CC6600/FFFFFF/png?text=${encodeURIComponent(item.name)}`,
                description,
                genres: item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'],
                year
            };
        }
    }
}

function baseManifest(config, { id = ADDON_ID, name = ADDON_NAME, description, configurable = true } = {}) {
    const manifest = {
        id,
        version: ADDON_VERSION,
        name,
        description: description || "Live TV, movies and series from an M3U playlist or Xtream Codes panel, with XMLTV guide info.",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_channels',
                name: 'IPTV Channels',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: 'IPTV Movies',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: 'IPTV Series',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            }
        ],
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable,
            configurationRequired: false
        }
    };

    if (config.liveOnly) {
        manifest.types = ["tv"];
        manifest.catalogs = manifest.catalogs.filter(c => c.type === 'tv');
    }
    return manifest;
}

async function initialLoad(addonInstance) {
    await addonInstance.loadFromCache();
    try {
        const hasData = addonInstance.channels.length || addonInstance.movies.length || addonInstance.series.length;
        const stale = addonInstance.needsRefresh();
        if (!hasData) {
            await addonInstance.updateData(true);
        } else if (stale) {
            addonInstance.updateData(true).catch(() => { });
        }
    } catch (e) {
        console.error('[ADDON] Initial update failed:', e);
    }
}

async function createAddon(config) {
    const manifest = baseManifest(config);

    config.instanceId = config.instanceId ||
        (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));

    const cacheKey = createCacheKey(config);
    const debugFlag = !!config.debug || DEBUG_ENV;
    if (debugFlag) {
        console.log('[DEBUG] createAddon start', { cacheKey, provider: config.provider, includeSeries: config.includeSeries !== false });
    } else {
        console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} for config ${cacheKey}`);
    }

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        if (debugFlag) console.log('[DEBUG] Reusing build promise', cacheKey);
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const addonInstance = new M3UEPGAddon(config, manifest);
        await initialLoad(addonInstance);
        return buildInterface(addonInstance, manifest);
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    return buildPromise;
}

function buildInterface(addonInstance, manifest) {
    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        const start = Date.now();
        try {
            // Background update
            addonInstance.updateData().catch(() => { });

            if (args.type === 'tv' && (args.id === 'iptv_live_now' || args.id === 'iptv_today')) {
                const extra = args.extra || {};
                const now = Date.now();
                const q = extra.search ? extra.search.toLowerCase() : '';
                const opts = { genre: extra.genre || null, includeAssumed: !!q };
                const index = addonInstance.liveEventIndex();
                let events = args.id === 'iptv_today'
                    ? todayEvents(index, now, { ...opts, zone: addonInstance.timezone || 'America/New_York' })
                    : currentEvents(index, now, opts);
                if (q) events = events.filter(e => e.title.toLowerCase().includes(q));
                const skip = extra.skip ? parseInt(extra.skip) : 0;
                const metas = events.slice(skip, skip + 100).map(e => addonInstance.eventMetaPreview(e, now));
                return { metas, cacheMaxAge: LIVE_NOW_CACHE_S };
            }

            let items = [];
            if (args.type === 'tv' && args.id === 'iptv_channels') {
                items = addonInstance.channels;
            } else if (args.type === 'tv' && args.id === 'iptv_catchup') {
                items = addonInstance.channels.filter(c => addonInstance.catchupEnabledFor(c));
            } else if (args.type === 'tv' && args.id.startsWith('iptv_grp_')) {
                const group = addonInstance.groupCatalogMap?.get(args.id);
                if (group) items = addonInstance.channels.filter(c => addonInstance.channelGroup(c) === group);
            } else if (args.type === 'movie' && args.id === 'iptv_movies') {
                items = addonInstance.movies;
            } else if (args.type === 'series' && args.id === 'iptv_series') {
                if (addonInstance.config.includeSeries !== false)
                    items = addonInstance.series;
            }

            const extra = args.extra || {}; // Stremio passes filter/genre here
            let filtered = items;
            
            // If specific genre selected
            if (extra.genre && extra.genre !== 'All Channels') {
                filtered = filtered.filter(i => {
                    const cat = i.category || i.attributes?.['group-title'];
                    return cat === extra.genre;
                });
            }
            
            // If searching
            if (extra.search) {
                const q = extra.search.toLowerCase();
                filtered = filtered.filter(i => i.name.toLowerCase().includes(q));
            }
            
            // Pagination / Skip
            const skip = extra.skip ? parseInt(extra.skip) : 0;
            const metas = filtered.slice(skip, skip + 100).map(i => addonInstance.generateMetaPreview(i));
            
            if (addonInstance.config.debug) {
                console.log('[DEBUG] Catalog handler', {
                    type: args.type,
                    id: args.id,
                    genre: extra.genre,
                    totalItems: items.length,
                    filtered: filtered.length,
                    returned: metas.length,
                    skip,
                    ms: Date.now() - start
                });
            }
            return { metas };
        } catch (e) {
            console.error('[CATALOG] Error', e);
            return { metas: [] };
        }
    });

    builder.defineStreamHandler(async ({ type, id }) => {
        try {
            if (id.startsWith('iptv_ev_')) {
                return { streams: addonInstance.getEventStreams(id) };
            }
            if (id.startsWith('iptv_series_ep_')) {
                const stream = addonInstance.getStream(id);
                if (!stream) return { streams: [] };
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Series Episode Stream request', { id, url: stream.url });
                }
                return { streams: [stream] };
            }
            const stream = addonInstance.getStream(id);
            if (!stream) return { streams: [] };
            if (addonInstance.config.debug) {
                console.log('[DEBUG] Stream request', { id, url: stream.url });
            }
            const catchup = type === 'tv' ? await addonInstance.getCatchupStreams(id) : [];
            return { streams: [stream, ...catchup] };
        } catch (e) {
            console.error('[STREAM] Error', e);
            return { streams: [] };
        }
    });

    builder.defineMetaHandler(async ({ type, id }) => {
        try {
            if (addonInstance.config.debug) {
                console.log('[DEBUG] Meta handler called', { type, id, seriesCount: addonInstance.series.length });
            }
            if (id.startsWith('iptv_ev_')) {
                return { meta: addonInstance.getEventMeta(id) };
            }
            if (type === 'series' || id.startsWith('iptv_series_')) {
                const meta = await addonInstance.getDetailedMetaAsync(id, 'series');
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Series meta result', { id, found: !!meta, videos: meta?.videos?.length });
                }
                if (!meta) {
                    // Fallback: Try to find in series list and return basic meta without episodes
                    const seriesItem = addonInstance.series.find(s => s.id === id);
                    if (seriesItem) {
                        const fallbackMeta = {
                            id: seriesItem.id,
                            type: 'series',
                            name: seriesItem.name,
                            poster: seriesItem.poster || seriesItem.attributes?.['tvg-logo'] ||
                                `https://placehold.co/300x450/3366CC/FFFFFF/png?text=${encodeURIComponent(seriesItem.name)}`,
                            description: seriesItem.plot || seriesItem.attributes?.['plot'] || 'Series / Show',
                            genres: seriesItem.category
                                ? [seriesItem.category]
                                : (seriesItem.attributes?.['group-title'] ? [seriesItem.attributes['group-title']] : ['Series']),
                            videos: []
                        };
                        if (addonInstance.config.debug) {
                            console.log('[DEBUG] Series meta fallback used', { id, name: seriesItem.name });
                        }
                        return { meta: fallbackMeta };
                    }
                }
                return { meta: meta || null };
            }
            const meta = addonInstance.getDetailedMeta(id);
            if (addonInstance.config.debug) {
                console.log('[DEBUG] Meta request', { id, type, found: !!meta });
            }
            return { meta };
        } catch (e) {
            console.error('[META] Error', e);
            return { meta: null };
        }
    });

    const iface = builder.getInterface();
    iface.setPublicBase = base => { addonInstance.publicBase = base; };
    iface.renderEventCard = id => addonInstance.renderEventCard(id);
    iface.eventCardFallback = id => {
        const e = addonInstance.liveEventIndex().get(id);
        return e ? eventCardUrl(e) : null;
    };
    addonInstance.manifestReady = true;
    addonInstance.buildGenresInManifest();

    // POST-BUILD: Inject 'options' into each catalog's genre extra entry.
    // This MUST happen after getInterface() because the SDK linter would reject
    // the large options arrays during build. The manifest object is shared by
    // reference, so mutating it here affects the iface.manifest served by our
    // custom manifest.json route in server.js.
    for (const catalog of manifest.catalogs) {
        if (Array.isArray(catalog.genres) && catalog.genres.length > 0) {
            if (Array.isArray(catalog.extra)) {
                const genreExtra = catalog.extra.find(e => e.name === 'genre');
                if (genreExtra) {
                    genreExtra.options = [...catalog.genres];
                }
            }
        }
    }

    return iface;
}

module.exports = createAddon;
module.exports.redisStatus = redisStatus;
module.exports.M3UEPGAddon = M3UEPGAddon;
module.exports.baseManifest = baseManifest;
module.exports.initialLoad = initialLoad;
module.exports.buildInterface = buildInterface;
module.exports.EVENT_STREAMS_MAX = EVENT_STREAMS_MAX;