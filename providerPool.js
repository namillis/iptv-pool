const fs = require('fs');
const { M3UEPGAddon, baseManifest, initialLoad, buildInterface, markUsed, EVENT_STREAMS_MAX } = require('./addon');
const { categoryCountry, displayName, cleanName, tileId } = require('./channelMerge');
const { TILE_HEADER } = require('./mergePlan');
const { MergeWorker, InlinePlanner } = require('./mergeWorker');
const { fetchAccountInfo } = require('./src/js/providers/xtreamProvider');
const { HOME, tileCountry } = require('./xtream/api');
const { categoryFor } = require('./xtream/categories');

const SEP = '~';
const ID_RE = /^[a-z0-9]{1,8}$/;
const MAX_PROVIDERS = 20;
const POOL_CONCURRENCY = 2;
const RETRY_MS = 10 * 60 * 1000;
const MERGE_GAP_MS = 60 * 1000;
// The main thread's part of a merge gives way to requests after this many streams or channels.
const MERGE_SLICE = 2000;
const yieldToLoop = () => new Promise(setImmediate);
const POOL_ADDON_ID = 'org.stremio.m3u-epg-addon.pool';
const POOL_ADDON_NAME = 'M3U/EPG TV Pool';
const COUNTRY_RE = /^[A-Z]{2,3}$/;
const TILE_PREFIX = 'iptv_ch_';
const ACCOUNT_CACHE_MS = 5 * 60 * 1000;
// The home lists (xtream/home.json) that get their own Stremio catalog, in catalog order after Live Sports and Popular on TV.
const HOME_CATALOGS = ['Local DC', 'News', 'Entertainment', 'Movies'];
const HOME_CATALOG_PREFIX = 'iptv_home_';
for (const name of HOME_CATALOGS)
    if (!HOME.categories.some(c => c.name === name)) throw new Error(`xtream/home.json has no "${name}" category`);
const homeCatalogId = (name) => HOME_CATALOG_PREFIX + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
// Direct streams listed under a relayed one, for picking a source by hand.
const RELAY_FALLBACKS = 3;
// Nuvio on Apple TV hides a stream with no quality in its name when others have one, so Auto carries the best
// resolution among the channel's streams, as the others do ("Raptor\nHD").
const AUTO_QUALITIES = ['UHD', 'FHD', 'HD', 'SD'];
function autoStreamName(tile) {
    const labels = new Set(tile._members.map(m => (m._quality ? m._quality.label : '').replace(/\s*backup$/i, '')));
    const best = AUTO_QUALITIES.find(q => labels.has(q));
    return best ? `Auto\n${best}` : 'Auto';
}

function loadPoolConfig(file) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`Cannot read ${file}: ${e.code || e.message}`);
    }
    const { countries: rawCountries, ...childSettings } = { enableEpg: true, ...(raw.settings || {}) };
    if (rawCountries !== undefined && !Array.isArray(rawCountries)) throw new Error('"settings.countries" must be a list like ["US", "UK"]');
    const countries = (rawCountries || []).map(c => String(c).toUpperCase());
    for (const c of countries) if (!COUNTRY_RE.test(c)) throw new Error(`"settings.countries" has an invalid country "${c}"`);
    const settings = { ...childSettings, countries };
    if (!Array.isArray(raw.providers) || !raw.providers.length)
        throw new Error('"providers" must be a non-empty list');
    if (raw.providers.length > MAX_PROVIDERS)
        throw new Error(`At most ${MAX_PROVIDERS} providers are supported`);

    const seen = new Set();
    const providers = raw.providers.map((p, i) => {
        if (!p || typeof p !== 'object') throw new Error(`providers[${i}] must be an object`);
        const id = String(p.id || '').toLowerCase();
        if (!ID_RE.test(id)) throw new Error(`providers[${i}].id must be 1-8 lowercase letters or digits`);
        if (seen.has(id)) throw new Error(`Provider id "${id}" is used twice`);
        seen.add(id);

        const { id: _id, name, country: rawCountry, ...fields } = p;
        const country = rawCountry ? String(rawCountry).toUpperCase() : '';
        if (country && !COUNTRY_RE.test(country)) throw new Error(`Provider "${id}" country must be a 2-3 letter code like US`);
        const config = { ...childSettings, ...fields };
        config.provider = config.provider || (config.xtreamUrl ? 'xtream' : 'direct');
        if (config.provider === 'xtream') {
            for (const k of ['xtreamUrl', 'xtreamUsername', 'xtreamPassword'])
                if (!config[k]) throw new Error(`Provider "${id}" needs ${k}`);
            config.xtreamUrl = String(config.xtreamUrl).trim().replace(/\/+$/, '');
        } else if (config.provider === 'direct') {
            if (!config.m3uUrl) throw new Error(`Provider "${id}" needs m3uUrl`);
        } else {
            throw new Error(`Provider "${id}" has unknown provider type "${config.provider}"`);
        }
        return { id, name: String(name || id.toUpperCase()).slice(0, 24), country, config };
    });
    return { settings, providers };
}

class ProviderPool extends M3UEPGAddon {
    constructor(poolConfig, manifestRef) {
        super({ ...poolConfig.settings, provider: 'pool' }, manifestRef);
        this.children = poolConfig.providers.map(p => {
            const child = new M3UEPGAddon(p.config, null);
            child.poolId = p.id;
            child.poolName = p.name;
            child.poolCountry = p.country;
            child.retryAt = 0;
            return child;
        });
        this.childById = new Map(this.children.map(c => [c.poolId, c]));
        this.childRank = new Map(this.children.map((c, i) => [c.poolId, i]));
        this.taggedLists = new Map();
        this.tileById = new Map();
        this.tileCache = new Map();
        this.streamLists = new Map();
        // The merge plans in a worker thread unless [inlineMerge] (tests) or the worker has failed.
        this.planner = poolConfig.inlineMerge ? new InlinePlanner() : null;
        this.accounts = null;
        // The countries the Stremio catalogs show (settings.countries), or null for all of them. Xtream logins pick
        // their own countries.
        const countries = poolConfig.settings.countries || [];
        this.countries = countries.length ? new Set(countries) : null;
        this.listed = null;
        this.stremioRelay = null;
    }

    async loadFromCache() {
        await Promise.all(this.children.map(c => c.loadFromCache()));
        await this.merge();
    }

    async saveToCache() { }

    childDue(child, now) {
        return child.needsRefresh(now) && !(child.retryAt > now);
    }

    needsRefresh(now = Date.now()) {
        return this.children.some(c => this.childDue(c, now));
    }

    updateData() {
        if (this.updatePromise) return this.updatePromise;
        const now = Date.now();
        const due = this.children.filter(c => this.childDue(c, now));
        if (!due.length) return Promise.resolve();
        this.updatePromise = this.refreshChildren(due).finally(() => { this.updatePromise = null; });
        return this.updatePromise;
    }

    async refreshChildren(due) {
        let next = 0;
        const worker = async () => {
            while (next < due.length) {
                const child = due[next++];
                const before = child.lastUpdate;
                await child.updateData();
                if (child.lastUpdate === before) {
                    child.retryAt = Date.now() + RETRY_MS;
                    this.log.warn(`[POOL] Provider ${child.poolId} did not refresh, retrying in ${RETRY_MS / 60000} min`);
                } else {
                    child.retryAt = 0;
                }
                // The first merge is waited for, so a pool starting with no cache has channels once this returns.
                await this.requestMerge();
            }
        };
        await Promise.all(Array.from({ length: Math.min(POOL_CONCURRENCY, due.length) }, worker));
    }

    /**
     * Merges the providers' new lists. A merge holds up every request for a few seconds, so refreshes that land
     * close together share one: at most one merge a minute, the rest wait for it. A pool with no channels yet
     * merges right away.
     */
    requestMerge() {
        const wait = MERGE_GAP_MS - (Date.now() - (this.mergedAt || 0));
        if (wait <= 0 || !this.channels.length) return this.merge();
        if (this.mergeTimer) return;
        this.mergeTimer = setTimeout(() => this.merge(), wait);
        if (this.mergeTimer.unref) this.mergeTimer.unref();
    }

    tagged(child, kind) {
        const src = child[kind] || [];
        let lists = this.taggedLists.get(child);
        if (!lists) this.taggedLists.set(child, lists = {});
        if (lists[kind]?.src !== src) {
            const pid = child.poolId;
            lists[kind] = { src, items: src.map(i => ({ ...i, id: i.id + SEP + pid, _pid: pid, _src: i.id })) };
        }
        return lists[kind].items;
    }

    plannerFor() {
        if (!this.planner) {
            try {
                this.planner = new MergeWorker();
            } catch (e) {
                console.error(`[POOL] Merge worker didn't start (${e.message}); merging on the main thread`);
                this.planner = new InlinePlanner();
            }
        }
        return this.planner;
    }

    /**
     * A provider's live streams as pool members, each with its channel key, quality and guide key. The naming runs
     * in the planner, which also learns which guide ids have listings. An unchanged list keeps its member objects,
     * so its channels are reused; it's sent again only when its guide changed.
     */
    async streamsOf(child, planner) {
        const src = child.channels || [];
        const prev = this.streamLists.get(child);
        if (prev && prev.src === src && prev.epg === child.epgData && prev.planner === planner) return prev.items;
        const pid = child.poolId;
        const epg = child.epgData || {};
        const guides = [];
        for (const k in epg) if (epg[k]?.length) guides.push(k);
        const epgIds = src.map(i => M3UEPGAddon.prototype.epgIdOf.call(this, i));
        const { keys, qLabels, qualities } = await planner.setProvider({
            pid,
            country: child.poolCountry,
            names: src.map(i => i.name),
            groups: src.map(i => this.channelGroup(i)),
            epgIds,
            catchup: Uint8Array.from(src, i => (child.catchupEnabledFor(i) ? 1 : 0)),
            guides,
        });
        if (prev && prev.src === src && prev.planner === planner) {
            this.streamLists.set(child, { ...prev, epg: child.epgData });
            return prev.items;
        }
        const quality = new Map(Object.entries(qualities).map(([label, rank]) => [label, Object.freeze({ label, rank })]));
        const items = new Array(src.length);
        for (let n = 0; n < src.length; n++) {
            const i = src[n];
            items[n] = {
                ...i, id: i.id + SEP + pid, _pid: pid, _src: i.id, _key: keys[n], _quality: quality.get(qLabels[n]),
                _epgKey: epgIds[n] ? `${pid}/${epgIds[n]}` : null,
            };
            if (n % MERGE_SLICE === MERGE_SLICE - 1) await yieldToLoop();
        }
        this.streamLists.set(child, { src, epg: child.epgData, planner, items });
        return items;
    }

    /**
     * Merges the providers' streams into channels. The planner (a worker thread) names, groups and orders the
     * streams; this thread builds the channels from its plan in slices that let requests through, and switches to
     * the new channels at once. Merges never overlap: one asked for during another runs after it.
     */
    merge() {
        clearTimeout(this.mergeTimer);
        this.mergeTimer = null;
        if (this.merging) {
            this.mergeAgain = true;
            return this.merging;
        }
        this.merging = this.runMerge()
            .catch(async (e) => {
                if (this.planner instanceof InlinePlanner) throw e;
                console.error(`[POOL] Merge worker failed (${e.message}); merging on the main thread`);
                if (this.planner) this.planner.stop();
                this.planner = new InlinePlanner();
                return this.runMerge();
            })
            .catch(e => console.error('[POOL] Merge failed:', e))
            .finally(() => {
                this.merging = null;
                if (this.mergeAgain) {
                    this.mergeAgain = false;
                    this.merge();
                }
            });
        return this.merging;
    }

    async runMerge() {
        const started = Date.now();
        const planner = this.plannerFor();
        const lists = [];
        for (const child of this.children) lists.push(await this.streamsOf(child, planner));
        const plan = await planner.plan(this.children.map(c => c.poolId));
        const members = [].concat(...lists);
        if (plan.streams !== members.length) throw new Error(`plan has ${plan.streams} streams, the pool ${members.length}`);
        const epgData = {};
        let lastUpdate = 0;
        for (const child of this.children) {
            for (const k in child.epgData) epgData[`${child.poolId}/${k}`] = child.epgData[k];
            lastUpdate = Math.max(lastUpdate, child.lastUpdate || 0);
        }
        const { tiles, cache, byId } = await this.buildTiles(plan, members);
        this.epgData = epgData;
        this.channels = tiles;
        this.tileCache = cache;
        this.placeholderCount = plan.placeholders;
        this.tileById = byId;
        this.memberCount = members.length;
        this.movies = [].concat(...this.children.map(c => this.tagged(c, 'movies')));
        this.series = [].concat(...this.children.map(c => this.tagged(c, 'series')));
        this.lastUpdate = lastUpdate;
        this.buildGenresInManifest();
        this.mergedAt = Date.now();
        if (tiles.length) console.log(`[POOL] Merged ${members.length} streams into ${tiles.length} channels in ${this.mergedAt - started} ms, heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);
    }

    /**
     * The channels in [plan] (see mergePlan.js), and a lookup by id, reusing each channel whose streams, guide and
     * catch-up are unchanged.
     */
    async buildTiles(plan, members) {
        const { keys, layout } = plan;
        const tiles = new Array(keys.length);
        const cache = new Map();
        const byId = new Map();
        let pos = 0;
        for (let t = 0; t < keys.length; t++) {
            const key = keys[t];
            const count = layout[pos];
            const primaryCount = layout[pos + 1];
            const guidePos = layout[pos + 2];
            const catchupPos = layout[pos + 3];
            pos += TILE_HEADER;
            const ordered = new Array(count);
            for (let i = 0; i < count; i++) ordered[i] = members[layout[pos + i]];
            pos += count;
            const prev = this.tileCache.get(key);
            const reuse = prev && prev.guidePos === guidePos && prev.catchupPos === catchupPos && this.sameMembers(prev.ordered, ordered);
            const tile = reuse ? prev.tile : this.buildTile(key, ordered, primaryCount, guidePos, catchupPos, prev && prev.tile.id);
            cache.set(key, { ordered, guidePos, catchupPos, tile });
            byId.set(tile.id, tile);
            tiles[t] = tile;
            if (t % MERGE_SLICE === MERGE_SLICE - 1) await yieldToLoop();
        }
        return { tiles, cache, byId };
    }

    sameMembers(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    buildTile(key, ordered, primaryCount, guidePos, catchupPos, id = null) {
        const primary = ordered.slice(0, primaryCount);
        const rep = primary[0];
        const logo = ordered.map(m => m.logo || m.attributes?.['tvg-logo']).find(Boolean) || null;
        const catchup = catchupPos >= 0 ? ordered[catchupPos] : null;
        const groupNames = [...new Set(ordered.map(m => this.channelGroup(m)).filter(Boolean))];
        return {
            id: id || tileId(key),
            type: 'tv',
            name: displayName(rep.name),
            label: cleanName(displayName(rep.name)),
            category: groupNames[0] || '',
            logo,
            attributes: { 'tvg-logo': logo || undefined, 'group-title': groupNames[0] || undefined },
            archiveDays: catchup ? catchup.archiveDays : 0,
            _key: key,
            _members: ordered,
            _primary: primary,
            _groups: groupNames,
            _epg: guidePos >= 0 ? ordered[guidePos]._epgKey : null,
            _catchup: catchup,
            _search: null
        };
    }

    overlapCounts() {
        const overlap = new Map(this.children.map(c => [c.poolId, new Map()]));
        for (const t of this.channels) {
            const pids = t._primary.map(m => m._pid);
            for (const a of pids) {
                const row = overlap.get(a);
                for (const b of pids) row.set(b, (row.get(b) || 0) + 1);
            }
        }
        return overlap;
    }

    memberEpgId(m) {
        if (m._epgKey !== undefined) return m._epgKey;
        const id = super.epgIdOf(m);
        return id ? `${m._pid}/${id}` : null;
    }

    route(id) {
        const i = typeof id === 'string' ? id.lastIndexOf(SEP) : -1;
        const child = i === -1 ? null : this.childById.get(id.slice(i + 1));
        return child ? { child, id: id.slice(0, i) } : null;
    }

    epgIdOf(item) {
        if (item._members) return item._epg;
        return item._pid ? this.memberEpgId(item) : super.epgIdOf(item);
    }

    channelGroups(c) {
        return c._groups || super.channelGroups(c);
    }

    inGroup(item, group) {
        return item._groups ? item._groups.includes(group) : super.inGroup(item, group);
    }

    searchText(item) {
        if (!item._members) return super.searchText(item);
        if (item._search === null) {
            const names = new Set(item._members.map(m => m.name.toLowerCase()));
            item._search = [...names, item._key.toLowerCase()].join('\n');
        }
        return item._search;
    }

    catchupEnabledFor(item) {
        if (item && item._members) return !!item._catchup;
        const child = item && this.childById.get(item._pid);
        return !!child && child.catchupEnabledFor(item);
    }

    tileListed(tile) {
        return !!tile && (!this.countries || this.countries.has(tileCountry(tile._key)));
    }

    /**
     * The channels in the pool's countries, and the home lists built from them the way an Xtream login's are: each
     * list's hand-picked channels in home.json order, then every other home-country channel filed under the same
     * category name. Built once per merge.
     */
    listedView() {
        if (this.listed && this.listed.channels === this.channels) return this.listed;
        const channels = this.countries ? this.channels.filter(t => this.tileListed(t)) : this.channels;
        const curated = !this.countries || this.countries.has(HOME.country);
        const lists = new Map(HOME_CATALOGS.map(name => [name, { picked: [], rest: [] }]));
        const byIndex = HOME.categories.map(c => lists.get(c.name) || null);
        for (const tile of channels) {
            const slot = curated && HOME.slots.get(tile._key);
            if (slot) {
                if (byIndex[slot.category]) byIndex[slot.category].picked[slot.rank] = tile;
                continue;
            }
            if (tileCountry(tile._key) !== HOME.country) continue;
            const list = lists.get(categoryFor(tile._groups, tile.name, true));
            if (list) list.rest.push(tile);
        }
        const home = new Map([...lists].map(([name, l]) => [homeCatalogId(name), [...l.picked.filter(Boolean), ...l.rest]]));
        this.listed = { channels: this.channels, listed: channels, home };
        return this.listed;
    }

    listedChannels() {
        return this.listedView().listed;
    }

    homeChannels(catalogId) {
        return this.listedView().home.get(catalogId) || [];
    }

    listedEvent(e) {
        if (!e || !this.countries) return e || null;
        const channels = e.channels.filter(ch => this.tileListed(this.tileById.get(ch.id)));
        return channels.length ? { ...e, channels } : null;
    }

    // Stremio and Nuvio only play what's on now, so the pool has no Catch-up TV catalog.
    buildCatchupCatalog() { }

    /**
     * The pool's Stremio TV catalogs, in order: Live Sports, Popular on TV, the HOME_CATALOGS lists and All Channels,
     * all limited to the pool's countries. Today and the provider group catalogs are left out.
     */
    buildGenresInManifest() {
        super.buildGenresInManifest();
        if (!this.manifestRef || !this.manifestReady) return;
        const catalogs = this.manifestRef.catalogs;
        const byId = new Map(catalogs.map(c => [c.id, c]));
        const all = byId.get('iptv_channels');
        if (all) {
            all.name = 'All Channels';
            const groups = [...new Set(this.listedChannels().flatMap(c => this.channelGroups(c)))].sort((a, b) => a.localeCompare(b));
            groups.unshift('All Channels');
            all.genres = groups;
            const genreExtra = all.extra.find(e => e.name === 'genre');
            if (genreExtra) genreExtra.options = [...groups];
        }
        const home = HOME_CATALOGS
            .filter(name => this.homeChannels(homeCatalogId(name)).length)
            .map(name => ({ type: 'tv', id: homeCatalogId(name), name, extra: [{ name: 'search' }, { name: 'skip' }] }));
        const tv = [byId.get('iptv_live_now'), byId.get('iptv_popular_tv'), ...home, all].filter(Boolean);
        catalogs.splice(0, catalogs.length, ...tv, ...catalogs.filter(c => c.type !== 'tv'));
    }

    channelById(id) {
        return this.tileById.get(id) || null;
    }

    channelWeight(ch) {
        const tile = this.tileById.get(ch.id);
        return tile ? tile._primary.length : 0;
    }

    memberStream(m, name) {
        const child = this.childById.get(m._pid);
        const stream = child && child.getStream(m._src);
        return stream ? { ...stream, name, title: cleanName(m.name) } : null;
    }

    getStreams(id) {
        const tile = this.tileById.get(id);
        if (!tile) {
            const stream = this.getStream(id);
            return stream ? [stream] : [];
        }
        if (!this.relayPlayable()) return this.directStreams(tile._members);
        return [this.relayStream(tile, autoStreamName(tile), tile.label), ...this.directStreams(this.stremioRelay.order(this, tile).slice(0, RELAY_FALLBACKS))];
    }

    directStreams(members) {
        const streams = [];
        for (const m of members) {
            const label = m._quality.label;
            const s = this.memberStream(m, label ? `${this.childById.get(m._pid).poolName}\n${label}` : this.childById.get(m._pid).poolName);
            if (s) streams.push(s);
        }
        return streams;
    }

    // Stremio and Nuvio play channels through the stream relay when server.js has given the pool its hook
    // (stremioRelay, from the Xtream router) and a request has set the public base for the play URL.
    relayPlayable() {
        return !!this.stremioRelay && !!this.publicBase && this.stremioRelay.enabled();
    }

    // The relay races the channel's sources and switches to another mid-show if one stalls.
    relayStream(tile, name, title) {
        return { name, title: `${title}\nSwitches sources by itself`, url: `${this.publicBase}/play/${tile.id}.ts`, behaviorHints: { notWebReady: true } };
    }

    // What a channel's stream list holds, for its description.
    sourcesLine(tile) {
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const from = `${plural(tile._members.length, 'stream')} from ${plural(new Set(tile._members.map(m => m._pid)).size, 'provider')}`;
        if (!this.relayPlayable()) return from;
        return `Auto plays the best of ${from} and switches if one stalls. The streams under it are backups to pick by hand.`;
    }

    getStream(id) {
        if (id.startsWith(TILE_PREFIX)) return this.tileById.has(id) ? this.getStreams(id)[0] || null : null;
        const r = this.route(id);
        const stream = r && r.child.getStream(r.id);
        return stream ? { ...stream, name: r.child.poolName } : null;
    }

    // Stremio and Nuvio only play what's on now, so a channel's streams have no catch-up. The Xtream logins keep it.
    catchupListed() {
        return false;
    }

    async getCatchupStreams() {
        return [];
    }

    // Through the relay, one stream per channel, then the first few direct streams as a manual fallback. Direct
    // streams take each channel once first, so the cap isn't spent on copies of a few channels, then backups from
    // other providers.
    getEventStreams(id) {
        const e = this.listedEvent(this.liveEventIndex().get(id));
        if (!e) return [];
        const lists = [];
        for (const ch of this.eventChannels(e)) {
            const tile = this.tileById.get(ch.id);
            if (tile) lists.push({ ch, tile, members: [...tile._primary] });
        }
        const relayed = this.relayPlayable() ? lists.map(l => this.relayStream(l.tile, `Auto\n${l.ch.source}`, cleanName(l.ch.slot))) : [];
        const max = relayed.length ? RELAY_FALLBACKS : EVENT_STREAMS_MAX;
        const streams = [];
        const take = ({ ch, members }) => {
            while (members.length) {
                const m = members.shift();
                const s = this.memberStream(m, `${this.childById.get(m._pid).poolName}\n${ch.source}`);
                if (s) {
                    streams.push(s);
                    return;
                }
            }
        };
        for (const l of lists) {
            if (streams.length >= max) break;
            take(l);
        }
        while (streams.length < max && lists.some(l => l.members.length)) {
            for (const l of lists) {
                if (streams.length >= max) break;
                take(l);
            }
        }
        return [...relayed, ...streams];
    }

    eventChannelLabel(ch) {
        return cleanName(ch.slot);
    }

    getDetailedMeta(id) {
        const tile = this.tileById.get(id);
        if (tile) {
            const meta = super.getDetailedMeta(id);
            if (meta) meta.description = `${meta.description}\n\n🔌 ${this.sourcesLine(tile)}`;
            return meta;
        }
        const r = this.route(id);
        const meta = r && r.child.getDetailedMeta(r.id);
        if (!meta) return null;
        const out = { ...meta, id };
        if (this.children.length > 1) out.description = `${meta.description}\n\n🔌 PROVIDER: ${r.child.poolName}`;
        return out;
    }

    async getDetailedMetaAsync(id, type) {
        if (this.tileById.has(id)) return this.getDetailedMeta(id);
        const r = this.route(id);
        if (!r) return null;
        const meta = await r.child.getDetailedMetaAsync(r.id, type);
        if (!meta) return null;
        const out = { ...meta, id };
        if (Array.isArray(meta.videos)) out.videos = meta.videos.map(v => ({ ...v, id: v.id + SEP + r.child.poolId }));
        return out;
    }

    async accountStatus(now = Date.now()) {
        if (this.accounts && now - this.accounts.at < ACCOUNT_CACHE_MS) return this.accounts.byId;
        const entries = await Promise.all(this.children.map(async child => {
            const c = child.config;
            if (child.providerName !== 'xtream') return [child.poolId, null];
            try {
                return [child.poolId, await fetchAccountInfo(c.xtreamUrl, c.xtreamUsername, c.xtreamPassword)];
            } catch (e) {
                return [child.poolId, { error: e.message }];
            }
        }));
        this.accounts = { at: now, byId: new Map(entries) };
        return this.accounts.byId;
    }

    /** The pool's providers, their channels, refresh and account state, and how much their channel lists overlap. */
    async status(now = Date.now()) {
        const accounts = await this.accountStatus(now);
        const overlap = this.overlapCounts();
        const providers = this.children.map(child => {
            const row = overlap.get(child.poolId);
            const merged = row.get(child.poolId) || 0;
            let shared = 0;
            for (const t of this.channels) if (t._primary.length > 1 && t._primary.some(m => m._pid === child.poolId)) shared++;
            const a = accounts.get(child.poolId);
            const failing = child.retryAt > now;
            return {
                id: child.poolId,
                name: child.poolName,
                channels: child.channels.length,
                merged,
                shared,
                onlyHere: merged - shared,
                lastRefresh: child.lastUpdate || null,
                refreshError: failing ? child.lastError || 'refresh failed' : null,
                retryAt: failing ? child.retryAt : null,
                account: !a ? null : a.error ? { error: a.error } : {
                    status: a.status,
                    expires: a.expiresAt || null,
                    used: a.activeConnections ?? null,
                    max: a.maxConnections || null,
                    trial: !!a.isTrial
                }
            };
        });
        const ids = this.children.map(c => c.poolId);
        return {
            members: this.memberCount,
            channels: this.channels.length,
            placeholders: this.placeholderCount || 0,
            checkedAt: this.accounts.at,
            providers,
            overlap: {
                ids,
                rows: ids.map(a => {
                    const row = overlap.get(a);
                    const total = row.get(a) || 0;
                    return ids.map(b => (a === b || !total ? null : Math.round(100 * (row.get(b) || 0) / total)));
                })
            }
        };
    }

    async report(now = Date.now()) {
        const zone = this.timezone || 'America/New_York';
        const when = ms => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
        const num = n => Number(n || 0).toLocaleString('en-US');
        const pad = (v, n, left) => (left ? String(v).padEnd(n) : String(v).padStart(n));
        const st = await this.status(now);
        const lines = [
            `Provider pool: ${st.providers.length} providers`,
            `${num(st.members)} channels merged into ${num(st.channels)}` +
                (st.placeholders ? ` (${num(st.placeholders)} empty "NO MATCH"/"NO EVENT" slots left out)` : ''),
            '',
            [pad('ID', 9, 1), pad('Name', 12, 1), pad('Channels', 9), pad('Merged', 8), pad('Shared', 7), pad('Only here', 10), '  Last refresh'].join(' ')
        ];
        for (const p of st.providers) {
            const status = p.refreshError ? `failed, retry ${when(p.retryAt)}: ${p.refreshError}` : when(p.lastRefresh);
            lines.push([pad(p.id, 9, 1), pad(p.name, 12, 1), pad(num(p.channels), 9), pad(num(p.merged), 8),
                pad(p.merged ? `${Math.round(100 * p.shared / p.merged)}%` : '-', 7), pad(num(p.onlyHere), 10), `  ${status}`].join(' '));
        }
        lines.push('', 'Overlap: share of the row provider\'s channels that the column provider also has');
        lines.push(pad('', 9, 1) + st.overlap.ids.map(id => pad(id.slice(0, 7), 8)).join(''));
        st.overlap.ids.forEach((a, i) => {
            lines.push(pad(a, 9, 1) + st.overlap.rows[i].map(v => pad(v === null ? '-' : `${v}%`, 8)).join(''));
        });
        lines.push('', `Accounts (checked ${when(st.checkedAt)}, cached 5 min)`);
        for (const p of st.providers) {
            const a = p.account;
            let text = 'playlist, no account';
            if (a && a.error) text = `check failed: ${a.error}`;
            else if (a) {
                const cons = a.max ? `${a.used ?? '?'}/${a.max} connections in use` : 'connections unknown';
                const full = a.max && a.used >= a.max ? ' (FULL)' : '';
                text = `${a.status}, expires ${a.expires ? a.expires.slice(0, 10) : 'never'}, ${cons}${full}${a.trial ? ', trial' : ''}`;
            }
            lines.push(`${pad(p.id, 9, 1)}${text}`);
        }
        return lines.join('\n') + '\n';
    }
}

async function createPoolAddon(file) {
    const poolConfig = loadPoolConfig(file);
    const count = poolConfig.providers.length;
    const manifest = baseManifest(poolConfig.settings, {
        id: POOL_ADDON_ID,
        name: POOL_ADDON_NAME,
        description: `Live TV, movies and series from ${count} IPTV provider${count === 1 ? '' : 's'}, with XMLTV guide info.`,
        configurable: false
    });
    const pool = new ProviderPool(poolConfig, manifest);
    console.log(`[POOL] ${count} provider${count === 1 ? '' : 's'}: ${pool.children.map(c => `${c.poolId} (${c.providerName})`).join(', ')}`);
    await initialLoad(pool);
    markUsed(pool);
    const iface = buildInterface(pool, manifest);
    iface.isPool = true;
    iface.poolReport = () => pool.report();
    iface.poolStatus = () => pool.status();
    iface.pool = pool;
    iface.touch = () => markUsed(pool);
    return iface;
}

module.exports = { loadPoolConfig, createPoolAddon, ProviderPool };
