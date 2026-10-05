const crypto = require('crypto');

const PREFIX_RE = /^\s*[|[(]?\s*([A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{2,6})?)\s*[-|:•\])]+\s*(?=\S)/;
const COMPOUND_REGIONS = new Set(['LATIN', 'ASIA', 'EU', 'AF', 'AM']);
const COUNTRY_ALIASES = { USA: 'US', GB: 'UK' };
const NORTH_AMERICA = new Set(['US', 'CA']);
const TRAILING_RE = /\s*(?:\[(?:BK|BACKUP|B|NOT 24\/7|GEO-BLOCKED)\]|\((?:BACKUP|BK|\d{3,4}P|SD|HD)\)|\b(?:UHD\+?|FHD\+?|HD\+?|SD|4K\+?|8K|HEVC|H\.?26[45]|RAW|LOW|VIP|BACKUP|BK|\d{2}\s?FPS|\d{3,4}P)|[◉●○★☆✪⭐♦|*\-–—:.]+)\s*$/;
const FEED_RE = /\s*(?:\((?:EAST|E)\)|\[EAST\]|(?<!MIDDLE)\s+EAST)\s*$/;
const GENERIC_TAIL_RE = /\s+(?:TV|CHANNEL)\s*$/;
const NETWORK_RE = /\b(ABC|CBS|NBC|FOX|PBS|CW|ION|METV|TELEMUNDO|UNIVISION|UNIMAS|MY(?:NETWORK)?(?:TV)?|IND(?:EPENDENT)?)\b/;
const CALL_PAREN_RE = /\(([KW][A-Z]{2,3})(?:-(?:TV|DT\d?|LD|CD\d?))?\)/;
const CALL_BARE_RE = /\b([KW][A-Z]{3})(?:-(?:TV|DT|LD|CD)|\s+TV)\s*$/;
const CALL_STOPWORDS = new Set(['WEST', 'WEEK', 'WILD', 'WIRE', 'WORK', 'WORLD', 'KIDS', 'KING', 'WOMEN', 'WOW', 'WWE']);
const PLACEHOLDER_RE = /^(?:NOMATCH|NOEVENTS?|NOEVENTSCHEDULED|NOEVENTTODAY|NOLIVEEVENT|OFFAIR|COMINGSOON)$/;

const QUALITY_RULES = [
    [/\b(?:4K|8K|UHD)\b/, 'UHD', 2],
    [/\b(?:FHD|1080P)\b/, 'FHD', 0],
    [/\b(?:HD|720P)\b/, 'HD', 0],
    [/\b(?:HEVC|H\.?265)\b/, 'HEVC', 3],
    [/\b(?:SD|LOW)\b/, 'SD', 4],
    [/\b\d{2}\s?FPS\b/, '50 FPS', 1]
];

function prepare(name) {
    return String(name || '').normalize('NFKC').replace(/ɪ/g, 'i').toUpperCase().replace(/\s+/g, ' ').trim();
}

function splitPrefix(text) {
    const m = text.match(PREFIX_RE);
    if (!m) return { prefix: '', rest: text };
    let prefix = m[1];
    const dash = prefix.indexOf('-');
    if (dash !== -1 && COMPOUND_REGIONS.has(prefix.slice(0, dash))) prefix = prefix.slice(dash + 1);
    return { prefix: COUNTRY_ALIASES[prefix] || prefix, rest: text.slice(m[0].length) };
}

function stripTrailing(text, { feeds = false } = {}) {
    let out = text;
    for (let i = 0; i < 10; i++) {
        let next = out.replace(TRAILING_RE, '');
        if (feeds && next === out) next = out.replace(FEED_RE, '');
        if (next === out || !next.trim()) break;
        out = next;
    }
    return out.trim();
}

function stationKey(text) {
    const net = (text.match(NETWORK_RE) || [])[1] || '';
    if (!net && !/\d/.test(text)) return null;
    let call = null;
    const paren = text.match(CALL_PAREN_RE);
    if (paren && !CALL_STOPWORDS.has(paren[1])) call = paren[1];
    if (!call && net) {
        const bare = text.match(CALL_BARE_RE);
        if (bare && !CALL_STOPWORDS.has(bare[1])) call = bare[1];
    }
    if (!call) return null;
    const network = net.startsWith('MY') ? 'MY' : (net.startsWith('IND') ? 'IND' : net);
    return `CALL|${call}|${network}`;
}

function compact(text) {
    return text.replace(/&/g, ' AND ').replace(/\+/g, ' PLUS ').replace(/\b0+(\d)/g, '$1').replace(/[^\p{L}\p{N}]+/gu, '');
}

function channelKey(name, defaultCountry = '') {
    const { prefix, rest } = splitPrefix(prepare(name));
    const country = prefix || defaultCountry;
    if (NORTH_AMERICA.has(country) || !country) {
        const station = stationKey(rest);
        if (station) return station;
    }
    let core = stripTrailing(rest, { feeds: NORTH_AMERICA.has(country) }).replace(/^THE\s+/, '');
    const generic = core.replace(GENERIC_TAIL_RE, '');
    if (country && compact(generic).length >= 3) core = generic;
    core = compact(core);
    if (PLACEHOLDER_RE.test(core)) return null;
    if (!core) return `RAW|${prepare(name)}`;
    return `${country}|${core}`;
}

const qualityCache = new Map();

function streamQuality(name) {
    const tail = prepare(name).slice(-24);
    const backup = /\[(?:BK|BACKUP|B)\]|\bBACKUP\b/.test(tail);
    let label = backup ? 'Backup' : '';
    let rank = backup ? 1.5 : 1;
    for (const [re, l, r] of QUALITY_RULES) {
        if (re.test(tail)) { label = backup ? `${l} backup` : l; rank = r + (backup ? 0.5 : 0); break; }
    }
    let q = qualityCache.get(label);
    if (!q) qualityCache.set(label, q = Object.freeze({ label, rank }));
    return q;
}

function displayName(name) {
    const text = String(name || '').normalize('NFKC').replace(/ɪ/g, 'i').replace(/\s+/g, ' ').trim();
    const stripped = stripTrailing(text);
    return stripped.length >= 2 ? stripped : text;
}

function tileId(key) {
    return 'iptv_ch_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function groupByKey(members, keyOf) {
    const byKey = new Map();
    for (const m of members) {
        const key = keyOf(m);
        if (!key) continue;
        let group = byKey.get(key);
        if (!group) byKey.set(key, group = { key, members: [] });
        group.members.push(m);
    }
    const byCall = new Map();
    for (const key of byKey.keys()) {
        if (!key.startsWith('CALL|')) continue;
        const call = key.split('|')[1];
        if (!byCall.has(call)) byCall.set(call, []);
        byCall.get(call).push(key);
    }
    for (const keys of byCall.values()) {
        const bare = keys.find(k => k.endsWith('|'));
        const named = keys.filter(k => !k.endsWith('|'));
        if (!bare || named.length !== 1) continue;
        byKey.get(named[0]).members.push(...byKey.get(bare).members);
        byKey.delete(bare);
    }
    return [...byKey.values()];
}

module.exports = { channelKey, streamQuality, displayName, tileId, groupByKey };
