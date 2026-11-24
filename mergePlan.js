// The pool merge's planning: naming each provider stream (channel key, quality, guide key), grouping streams into
// channels, dropping guide ids a provider put on unrelated channels, and ordering each channel's streams. It works on
// plain strings and numbers, so it can run in the merge worker (mergeWorker.js) while the main thread keeps serving.
const { channelKey, categoryCountry, streamQuality, groupByKey } = require('./channelMerge');

const GENERIC_WORDS = new Set(['HD', 'FHD', 'UHD', 'SD', '4K', '8K', 'HDR', 'HEVC', 'RAW', 'TV', 'THE', 'AND', 'OF', 'CHANNEL', 'NETWORK', 'VIP',
    'BY', 'LIVE', 'SPORT', 'SPORTS', 'NEWS', 'CH', 'MULTI', 'USA', 'US', 'UK', 'CA', 'EN', 'FR', 'DE', 'ES']);

const compactName = (s) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The words that tell one channel from another, without its [prefix]: "GR - Horror by Alter" -> HORROR, ALTER.
const nameWords = (name, prefix) => new Set(String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/[^A-Z0-9]+/)
    .filter(w => w.length >= 2 && w !== prefix && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w)));

// "polar/3tvktvkphoenixaz.us" -> "3tvktvkphoenixaz": the channel part of a member's guide key, without the provider or country.
const guideStem = (guideKey) => compactName(guideKey.slice(guideKey.indexOf('/') + 1).split('.')[0]);

// Which of [names] (tile key -> channel name) a shared guide id [guide] really belongs to. A channel whose name carries the
// id keeps it, along with the channels whose names share a word with it ("CA CBC News Toronto" on cbcnewsnetwork.ca).
// With no such channel, the id stays only on a set of like-named channels that makes up most of them ("Sky Sport
// Bundesliga 5", "... 6"); unrelated channels sharing it (Horror by ALTER, Laff More, Ebony TV) all lose it.
function guideOwners(guide, names) {
    const stem = guideStem(guide);
    const keys = [...names.keys()];
    // Channels are linked when their names share a word, and a chain of links joins them. The groups are found by
    // joining each channel to the first one with each of its words, so a guide id one provider put on thousands of
    // channels costs a pass over their words, not a comparison of every pair.
    const parent = new Map(keys.map(k => [k, k]));
    const find = (k) => {
        while (parent.get(k) !== k) {
            parent.set(k, parent.get(parent.get(k)));
            k = parent.get(k);
        }
        return k;
    };
    const firstWith = new Map();
    for (const k of keys) {
        for (const w of nameWords(names.get(k), k.slice(0, k.indexOf('|')))) {
            const other = firstWith.get(w);
            if (other === undefined) firstWith.set(w, k);
            else parent.set(find(k), find(other));
        }
    }
    const groups = new Map();
    for (const k of keys) {
        const root = find(k);
        let group = groups.get(root);
        if (!group) groups.set(root, group = new Set());
        group.add(k);
    }
    const carries = (k) => compactName(k.slice(k.indexOf('|') + 1)).includes(stem) || compactName(names.get(k)).includes(stem);
    const anchors = stem.length >= 2 ? keys.filter(carries) : [];
    if (anchors.length) return new Set(anchors.flatMap(k => [...groups.get(find(k))]));
    let largest = new Set();
    for (const group of groups.values()) if (group.size > largest.size) largest = group;
    return largest.size * 2 > keys.length ? largest : new Set();
}

// Providers sometimes give unrelated channels one guide id: Polar tags Horror by ALTER, Laff More and Ebony TV with
// Phoenix's KTVK guide, so a Suns game on KTVK looked like it aired on all of them. A guide id on one channel name is
// left alone; a shared one is kept only by the channels [guideOwners] picks.
function misfiledGuides(members) {
    const namesByGuide = new Map();
    for (const m of members) {
        if (!m._epgKey || !m._key) continue;
        let names = namesByGuide.get(m._epgKey);
        if (!names) namesByGuide.set(m._epgKey, names = new Map());
        if (!names.has(m._key)) names.set(m._key, m.name);
    }
    const misfiled = new Set();
    for (const [guide, names] of namesByGuide) {
        if (names.size < 2) continue;
        const owners = guideOwners(guide, names);
        for (const key of names.keys()) if (!owners.has(key)) misfiled.add(`${guide}\n${key}`);
    }
    return misfiled;
}

// Each channel in a plan's layout is [stream count, primary count, guide position, catch-up position] and then the
// global index of each of its streams, best first. A position is -1 when the channel has none.
const TILE_HEADER = 4;

/** Keeps each provider's streams as plain fields and plans a merge of all of them. */
class MergePlanner {
    constructor() {
        this.providers = new Map();
    }

    /**
     * One provider's streams, from the main thread: [names], [groups] (category), [epgIds] (guide id or null),
     * [catchup] (1 when catch-up works on it), [guides] ([guide id, listing count] for ids that have listings) and the
     * provider's [country].
     * Returns each stream's channel key and quality label, and each label's rank.
     */
    setProvider({ pid, country, names, groups, epgIds, catchup, guides }) {
        const countryOf = new Map();
        const n = names.length;
        const keys = new Array(n);
        const qLabels = new Array(n);
        const qRanks = new Float64Array(n);
        const epgKeys = new Array(n);
        const qualities = {};
        for (let i = 0; i < n; i++) {
            const group = groups[i];
            let c = countryOf.get(group);
            if (c === undefined) countryOf.set(group, c = categoryCountry(group) || country);
            keys[i] = channelKey(names[i], c);
            const q = streamQuality(names[i]);
            qLabels[i] = q.label;
            qRanks[i] = q.rank;
            qualities[q.label] = q.rank;
            epgKeys[i] = epgIds[i] ? `${pid}/${epgIds[i]}` : null;
        }
        this.providers.set(pid, { pid, names, epgIds, catchup, keys, qRanks, epgKeys, guides: new Map(guides) });
        return { keys, qLabels, qualities };
    }

    /** The merge of the providers in [order] (failover order): channel keys and the layout above. */
    plan(order) {
        const rank = new Map(order.map((pid, i) => [pid, i]));
        const members = [];
        let g = 0;
        let placeholders = 0;
        for (const pid of order) {
            const p = this.providers.get(pid);
            if (!p) throw new Error(`No streams for provider ${pid}`);
            for (let i = 0; i < p.keys.length; i++, g++) {
                const key = p.keys[i];
                if (!key) { placeholders++; continue; }
                const epgId = p.epgIds[i];
                members.push({
                    g, _key: key, _epgKey: p.epgKeys[i], name: p.names[i], _pid: pid, rank: rank.get(pid), q: p.qRanks[i],
                    catchup: p.catchup[i] === 1, guided: epgId ? p.guides.get(epgId) || 0 : 0,
                });
            }
        }
        const groups = groupByKey(members, m => m._key);
        const misfiled = misfiledGuides(members);
        const keys = new Array(groups.length);
        let size = 0;
        for (const { members: list } of groups) size += TILE_HEADER + list.length;
        const layout = new Int32Array(size);
        let pos = 0;
        groups.forEach(({ key, members: list }, t) => {
            keys[t] = key;
            // Providers in failover order, then better quality; each provider's best stream comes first.
            const sorted = [...list].sort((a, b) => a.rank - b.rank || a.q - b.q);
            const primary = [];
            const rest = [];
            const seen = new Set();
            for (const m of sorted) {
                if (seen.has(m._pid)) rest.push(m);
                else { seen.add(m._pid); primary.push(m); }
            }
            const ordered = primary.concat(rest);
            const dropped = new Set(list.filter(m => misfiled.has(`${m._epgKey}\n${key}`)).map(m => m._epgKey));
            const trusted = m => m._epgKey && !dropped.has(m._epgKey);
            // The guide with the most listings: a provider whose guide for the channel is one old entry would leave it
            // with nothing on now.
            let guidedPos = -1;
            ordered.forEach((m, i) => {
                if (trusted(m) && m.guided > (guidedPos >= 0 ? ordered[guidedPos].guided : 0)) guidedPos = i;
            });
            layout[pos++] = ordered.length;
            layout[pos++] = primary.length;
            layout[pos++] = guidedPos >= 0 ? guidedPos : trusted(ordered[0]) ? 0 : -1;
            layout[pos++] = ordered.findIndex(m => m.catchup);
            for (const m of ordered) layout[pos++] = m.g;
        });
        return { keys, layout, placeholders, streams: g };
    }
}

module.exports = { MergePlanner, misfiledGuides, guideOwners, TILE_HEADER };
