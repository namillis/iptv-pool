const fs = require('fs');
const { M3UEPGAddon, baseManifest, initialLoad, buildInterface, EVENT_STREAMS_MAX } = require('./addon');

const SEP = '~';
const ID_RE = /^[a-z0-9]{1,8}$/;
const MAX_PROVIDERS = 10;
const POOL_CONCURRENCY = 2;
const RETRY_MS = 10 * 60 * 1000;
const POOL_ADDON_ID = 'org.stremio.m3u-epg-addon.pool';
const POOL_ADDON_NAME = 'M3U/EPG TV Pool';

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

        const { id: _id, name, ...fields } = p;
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
        return { id, name: String(name || id.toUpperCase()).slice(0, 24), config };
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
            child.retryAt = 0;
            return child;
        });
        this.childById = new Map(this.children.map(c => [c.poolId, c]));
        this.taggedLists = new Map();
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
            lists[kind] = { src, items: src.map(i => ({ ...i, id: i.id + SEP + pid, _pid: pid })) };
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
        this.channels = [].concat(...this.children.map(c => this.tagged(c, 'channels')));
        this.movies = [].concat(...this.children.map(c => this.tagged(c, 'movies')));
        this.series = [].concat(...this.children.map(c => this.tagged(c, 'series')));
        this.epgData = epgData;
        this.lastUpdate = lastUpdate;
        this.buildGenresInManifest();
    }

    route(id) {
        const i = typeof id === 'string' ? id.lastIndexOf(SEP) : -1;
        const child = i === -1 ? null : this.childById.get(id.slice(i + 1));
        return child ? { child, id: id.slice(0, i) } : null;
    }

    epgIdOf(item) {
        const id = super.epgIdOf(item);
        return id && item._pid ? `${item._pid}/${id}` : id;
    }

    catchupEnabledFor(item) {
        const child = item && this.childById.get(item._pid);
        return !!child && child.catchupEnabledFor(item);
    }

    generateMetaPreview(item) {
        const meta = super.generateMetaPreview(item);
        const child = this.childById.get(item._pid);
        if (child && this.children.length > 1) meta.description = `${meta.description}\n🔌 ${child.poolName}`;
        return meta;
    }

    getStream(id) {
        const r = this.route(id);
        const stream = r && r.child.getStream(r.id);
        return stream ? { ...stream, name: r.child.poolName } : null;
    }

    async getCatchupStreams(id) {
        const r = this.route(id);
        if (!r) return [];
        const streams = await r.child.getCatchupStreams(r.id);
        return streams.map(s => ({ ...s, name: `${r.child.poolName}\n${s.name}` }));
    }

    eventStreamName(ch, stream) {
        return `${stream.name}\n${ch.source}`;
    }

    eventChannelLabel(ch) {
        const r = this.route(ch.id);
        return r && this.children.length > 1 ? `${ch.slot} · ${r.child.poolName}` : ch.slot;
    }

    eventChannels(e) {
        const sort = e.channels.length > EVENT_STREAMS_MAX;
        const lists = this.children.map(child => {
            const list = e.channels.filter(ch => this.route(ch.id)?.child === child);
            return sort ? list.sort((a, b) => a.slot.length - b.slot.length) : list;
        }).filter(l => l.length);
        const out = [];
        for (let i = 0; out.length < EVENT_STREAMS_MAX && lists.some(l => i < l.length); i++) {
            for (const l of lists) if (i < l.length && out.length < EVENT_STREAMS_MAX) out.push(l[i]);
        }
        return out;
    }

    getDetailedMeta(id) {
        const r = this.route(id);
        const meta = r && r.child.getDetailedMeta(r.id);
        if (!meta) return null;
        const out = { ...meta, id };
        if (this.children.length > 1) out.description = `${meta.description}\n\n🔌 PROVIDER: ${r.child.poolName}`;
        return out;
    }

    async getDetailedMetaAsync(id, type) {
        const r = this.route(id);
        if (!r) return null;
        const meta = await r.child.getDetailedMetaAsync(r.id, type);
        if (!meta) return null;
        const out = { ...meta, id };
        if (Array.isArray(meta.videos)) out.videos = meta.videos.map(v => ({ ...v, id: v.id + SEP + r.child.poolId }));
        return out;
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
    const iface = buildInterface(pool, manifest);
    iface.isPool = true;
    return iface;
}

module.exports = { loadPoolConfig, createPoolAddon, ProviderPool };
