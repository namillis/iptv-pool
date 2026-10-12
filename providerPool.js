const fs = require('fs');
const { M3UEPGAddon, baseManifest, initialLoad, buildInterface, markUsed, EVENT_STREAMS_MAX } = require('./addon');
const { channelKey, streamQuality, displayName, tileId, groupByKey } = require('./channelMerge');
const { fetchAccountInfo } = require('./src/js/providers/xtreamProvider');

const SEP = '~';
const ID_RE = /^[a-z0-9]{1,8}$/;
const MAX_PROVIDERS = 10;
const POOL_CONCURRENCY = 2;
const RETRY_MS = 10 * 60 * 1000;
const POOL_ADDON_ID = 'org.stremio.m3u-epg-addon.pool';
const POOL_ADDON_NAME = 'M3U/EPG TV Pool';
const COUNTRY_RE = /^[A-Z]{2,3}$/;
const TILE_PREFIX = 'iptv_ch_';
const ACCOUNT_CACHE_MS = 5 * 60 * 1000;

function loadPoolConfig(file) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`Cannot read ${file}: ${e.code || e.message}`);
    }
    const settings = { enableEpg: true, ...(raw.settings || {}) };
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
        const config = { ...settings, ...fields };
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
        this.accounts = null;
    }

    async loadFromCache() {
        await Promise.all(this.children.map(c => c.loadFromCache()));
        this.merge();
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
                this.merge();
            }
        };
        await Promise.all(Array.from({ length: Math.min(POOL_CONCURRENCY, due.length) }, worker));
    }

    tagged(child, kind) {
        const src = child[kind] || [];
        let lists = this.taggedLists.get(child);
        if (!lists) this.taggedLists.set(child, lists = {});
        if (lists[kind]?.src !== src) {
            const pid = child.poolId;
            lists[kind] = {
                src,
                items: src.map(i => {
                    const item = { ...i, id: i.id + SEP + pid, _pid: pid, _src: i.id };
                    if (kind === 'channels') {
                        item._key = channelKey(i.name, child.poolCountry);
                        item._quality = streamQuality(i.name);
                        const epg = M3UEPGAddon.prototype.epgIdOf.call(this, i);
                        item._epgKey = epg ? `${pid}/${epg}` : null;
                    }
                    return item;
                })
            };
        }
        return lists[kind].items;
    }

    merge() {
        const epgData = {};
        let lastUpdate = 0;
        for (const child of this.children) {
            for (const k in child.epgData) epgData[`${child.poolId}/${k}`] = child.epgData[k];
            lastUpdate = Math.max(lastUpdate, child.lastUpdate || 0);
        }
        const members = [].concat(...this.children.map(c => this.tagged(c, 'channels')));
        this.epgData = epgData;
        this.channels = this.buildTiles(members);
        this.tileById = new Map(this.channels.map(t => [t.id, t]));
        this.memberCount = members.length;
        this.movies = [].concat(...this.children.map(c => this.tagged(c, 'movies')));
        this.series = [].concat(...this.children.map(c => this.tagged(c, 'series')));
        this.lastUpdate = lastUpdate;
        this.buildGenresInManifest();
    }

    orderMembers(members) {
        const rank = m => this.childRank.get(m._pid);
        const sorted = [...members].sort((a, b) => rank(a) - rank(b) || a._quality.rank - b._quality.rank);
        const primary = [];
        const rest = [];
        const seen = new Set();
        for (const m of sorted) {
            if (seen.has(m._pid)) rest.push(m);
            else { seen.add(m._pid); primary.push(m); }
        }
        return { primary, ordered: primary.concat(rest) };
    }

    sameMembers(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    buildTiles(members) {
        const groups = groupByKey(members, m => m._key);
        const cache = new Map();
        let placeholders = 0;
        for (const m of members) if (!m._key) placeholders++;
        const tiles = groups.map(({ key, members: list }) => {
            const prev = this.tileCache.get(key);
            const tile = prev && this.sameMembers(prev.list, list) ? prev.tile : this.buildTile(key, list);
            cache.set(key, { list, tile });
            return tile;
        });
        this.tileCache = cache;
        this.placeholderCount = placeholders;
        return tiles;
    }

    buildTile(key, list) {
        const { primary, ordered } = this.orderMembers(list);
        const rep = primary[0];
        const guided = ordered.find(m => m._epgKey && this.epgData[m._epgKey]?.length);
        const logo = ordered.map(m => m.logo || m.attributes?.['tvg-logo']).find(Boolean) || null;
        const catchup = ordered.find(m => this.childById.get(m._pid).catchupEnabledFor(m)) || null;
        const groupNames = [...new Set(ordered.map(m => this.channelGroup(m)).filter(Boolean))];
        return {
            id: tileId(key),
            type: 'tv',
            name: displayName(rep.name),
            category: groupNames[0] || '',
            logo,
            attributes: { 'tvg-logo': logo || undefined, 'group-title': groupNames[0] || undefined },
            archiveDays: catchup ? catchup.archiveDays : 0,
            _key: key,
            _members: ordered,
            _primary: primary,
            _groups: groupNames,
            _epg: (guided || rep)._epgKey,
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

    providerSummary(tile, max = 3) {
        const names = tile._primary.map(m => this.childById.get(m._pid).poolName);
        return names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ');
    }

    generateMetaPreview(item) {
        const meta = super.generateMetaPreview(item);
        if (item._members && this.children.length > 1) meta.description = `${meta.description}\n🔌 ${this.providerSummary(item)}`;
        return meta;
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
        return stream ? { ...stream, name, title: m.name.trim() } : null;
    }

    getStreams(id) {
        const tile = this.tileById.get(id);
        if (!tile) {
            const stream = this.getStream(id);
            return stream ? [stream] : [];
        }
        const streams = [];
        for (const m of tile._members) {
            const label = m._quality.label;
            const s = this.memberStream(m, label ? `${this.childById.get(m._pid).poolName}\n${label}` : this.childById.get(m._pid).poolName);
            if (s) streams.push(s);
        }
        return streams;
    }

    getStream(id) {
        if (id.startsWith(TILE_PREFIX)) return this.tileById.has(id) ? this.getStreams(id)[0] || null : null;
        const r = this.route(id);
        const stream = r && r.child.getStream(r.id);
        return stream ? { ...stream, name: r.child.poolName } : null;
    }

    async getCatchupStreams(id) {
        const tile = this.tileById.get(id);
        const m = tile && tile._catchup;
        if (!m) return [];
        const child = this.childById.get(m._pid);
        const streams = await child.getCatchupStreams(m._src);
        return streams.map(s => ({ ...s, name: `${child.poolName}\n${s.name}` }));
    }

    // Each channel once first, so the cap isn't spent on copies of a few channels, then backups from other providers.
    getEventStreams(id) {
        const e = this.liveEventIndex().get(id);
        if (!e) return [];
        const lists = [];
        for (const ch of this.eventChannels(e)) {
            const tile = this.tileById.get(ch.id);
            if (tile) lists.push({ ch, members: [...tile._primary] });
        }
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
            if (streams.length >= EVENT_STREAMS_MAX) return streams;
            take(l);
        }
        while (streams.length < EVENT_STREAMS_MAX && lists.some(l => l.members.length)) {
            for (const l of lists) {
                if (streams.length >= EVENT_STREAMS_MAX) break;
                take(l);
            }
        }
        return streams;
    }

    eventChannelLabel(ch) {
        const tile = this.tileById.get(ch.id);
        return tile && this.children.length > 1 ? `${ch.slot} · ${this.providerSummary(tile, 2)}` : ch.slot;
    }

    getDetailedMeta(id) {
        const tile = this.tileById.get(id);
        if (tile) {
            const meta = super.getDetailedMeta(id);
            if (meta && this.children.length > 1) {
                const counts = new Map();
                for (const m of tile._members) counts.set(m._pid, (counts.get(m._pid) || 0) + 1);
                const lines = [...counts].map(([pid, n]) => `${this.childById.get(pid).poolName}${n > 1 ? ` (${n} streams)` : ''}`);
                meta.description = `${meta.description}\n\n🔌 PROVIDERS: ${lines.join(', ')}`;
            }
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

    async report(now = Date.now()) {
        const zone = this.timezone || 'America/New_York';
        const when = ms => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
        const num = n => Number(n || 0).toLocaleString('en-US');
        const pad = (v, n, left) => (left ? String(v).padEnd(n) : String(v).padStart(n));
        const accounts = await this.accountStatus(now);
        const overlap = this.overlapCounts();
        const lines = [
            `Provider pool: ${this.children.length} providers`,
            `${num(this.memberCount)} channels merged into ${num(this.channels.length)}` +
                (this.placeholderCount ? ` (${num(this.placeholderCount)} empty "NO MATCH"/"NO EVENT" slots left out)` : ''),
            '',
            [pad('ID', 9, 1), pad('Name', 12, 1), pad('Channels', 9), pad('Merged', 8), pad('Shared', 7), pad('Only here', 10), '  Last refresh'].join(' ')
        ];
        for (const child of this.children) {
            const row = overlap.get(child.poolId);
            const mine = row.get(child.poolId) || 0;
            let shared = 0;
            for (const t of this.channels) if (t._primary.length > 1 && t._primary.some(m => m._pid === child.poolId)) shared++;
            const status = child.retryAt > now ? `failed, retry ${when(child.retryAt)}${child.lastError ? `: ${child.lastError}` : ''}` : when(child.lastUpdate);
            lines.push([pad(child.poolId, 9, 1), pad(child.poolName, 12, 1), pad(num(child.channels.length), 9), pad(num(mine), 8),
                pad(mine ? `${Math.round(100 * shared / mine)}%` : '-', 7), pad(num(mine - shared), 10), `  ${status}`].join(' '));
        }
        lines.push('', 'Overlap: share of the row provider\'s channels that the column provider also has');
        const ids = this.children.map(c => c.poolId);
        lines.push(pad('', 9, 1) + ids.map(id => pad(id.slice(0, 7), 8)).join(''));
        for (const a of ids) {
            const row = overlap.get(a);
            const total = row.get(a) || 0;
            lines.push(pad(a, 9, 1) + ids.map(b => pad(a === b ? '-' : (total ? `${Math.round(100 * (row.get(b) || 0) / total)}%` : '-'), 8)).join(''));
        }
        lines.push('', `Accounts (checked ${when(this.accounts.at)}, cached 5 min)`);
        for (const child of this.children) {
            const a = accounts.get(child.poolId);
            let text = 'playlist, no account';
            if (a && a.error) text = `check failed: ${a.error}`;
            else if (a) {
                const cons = a.maxConnections ? `${a.activeConnections ?? '?'}/${a.maxConnections} connections in use` : 'connections unknown';
                const full = a.maxConnections && a.activeConnections >= a.maxConnections ? ' (FULL)' : '';
                text = `${a.status}, expires ${a.expiresAt ? a.expiresAt.slice(0, 10) : 'never'}, ${cons}${full}${a.isTrial ? ', trial' : ''}`;
            }
            lines.push(`${pad(child.poolId, 9, 1)}${text}`);
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
    iface.pool = pool;
    iface.touch = () => markUsed(pool);
    return iface;
}

module.exports = { loadPoolConfig, createPoolAddon, ProviderPool };
