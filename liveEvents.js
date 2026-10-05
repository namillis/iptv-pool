const crypto = require('crypto');

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const ZONES = { ET: 'America/New_York', UK: 'Europe/London' };
const DASH = '[-–—]';
const MON = '(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\\.?';
const TOKEN = `(?:${MON}\\s+(\\d{1,2})\\s*${DASH}\\s*)?(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\s*(ET|UK)(?:\\s*\\(\\s*${MON}\\s+(\\d{1,2})\\s*\\))?`;
const TOKEN_GROUPS = 8;
const SCHEDULE_RE = new RegExp(`\\s*(?:${DASH}\\s*)?${TOKEN}(?:\\s*\\/\\s*${TOKEN})?\\s*$`, 'i');
const SLOT_SPLIT_RE = /\s:\s?|:\s/;
const WEEKDAY_TAGS = [[/\(TNF\)|THURSDAY NIGHT/i, 4], [/\(MNF\)|MONDAY NIGHT/i, 1], [/\(SNF\)|SUNDAY NIGHT/i, 0]];
const NOISE_PARENS = /\s*\((?:ESP|ESPAÑOL|ESPANOL|SPANISH|PORTUGUÊS|PORTUGUES|FRENCH|FRANÇAIS|ITALIANO|DEUTSCH|ENG|ENGLISH|UHD|FHD|HD|SD|4K|ALT|ALTERNATE)\)/gi;
const ACRONYMS = new Set(['DAZN', 'UFC', 'NFL', 'NHL', 'NBA', 'MLB', 'MLS', 'WNBA', 'NCAA', 'NCAAF', 'NCAAB', 'ATP', 'WTA', 'PGA', 'LPGA', 'F1', 'F2', 'F3',
    'WRC', 'IMSA', 'UCI', 'AEW', 'WWE', 'PFL', 'BMX', 'MMA', 'PPV', 'TV', 'FC', 'SC', 'AFC', 'CF', 'KR', 'II', 'III', 'IV', 'US', 'USA', 'UK',
    'UEFA', 'FIFA', 'PDC', 'BKFC', 'MPC', 'VPRC', 'SNF', 'MNF', 'TNF', 'ODI', 'T20', 'NY', 'LA', 'PSG', 'RB', 'AC', 'CBS', 'ESPN', 'ESPN2', 'ESPNU', 'NJ',
    'UC', 'VCU', 'UCLA', 'USC', 'LSU', 'TCU', 'SMU', 'BYU', 'UCF', 'UNLV', 'UTEP', 'UTSA', 'FIU', 'FAU', 'UAB', 'UNC', 'NC', 'UIC', 'NJIT', 'SIU', 'UMBC', 'CSU', 'FGCU', 'SEC', 'ACC', 'AAC', 'MAC', 'CAA', 'NEC', 'SWAC', 'MEAC',
    'TNT', 'NESN', 'MUTV', 'TYC', 'BT', 'SNY', 'BTN', 'NBC', 'ABC', 'TSN', 'GOL', 'EN', 'ES', 'MLBN', 'NBCSN', 'BBC', 'ITV']);

const DEFAULT_DURATION_MS = 3 * 3600000;
const DURATIONS = [
    [/WEIGH-?IN|PRESS CONFERENCE|DESK SHOW|PRE-?SHOW|POST-?SHOW|STUDIO/i, 1.5 * 3600000],
    [/PRACTICE|QUALIFYING|SHOOTOUT/i, 1.5 * 3600000],
    [/GOLF|PGA|LPGA|FEATURED GROUPS|CHAMPIONSHIP .*ROUND|CRICKET|\bODI\b|\bTEST\b|T20|RACE|RALLY|GRAND PRIX|IMSA|NASCAR|INDYCAR/i, 5 * 3600000]
];
const SOON_MS = 60 * 60000;
const EARLY_MS = 15 * 60000;
const CARD_COLORS = ['1e3a8a', '7f1d1d', '14532d', '581c87', '78350f', '134e4a', '312e81', '831843'];
const CARD_LINE = 24;
const CARD_TEXT_MAX = 58;

const offsetCache = new Map();
function tzOffsetMs(zone, utcMs) {
    const key = zone + ':' + Math.floor(utcMs / 900000);
    let off = offsetCache.get(key);
    if (off === undefined) {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric'
        });
        const p = {};
        for (const { type, value } of fmt.formatToParts(new Date(utcMs))) p[type] = value;
        off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
        if (offsetCache.size > 2000) offsetCache.clear();
        offsetCache.set(key, off);
    }
    return off;
}

function zonedToUtc(zone, y, mo, d, h, mi) {
    const wall = Date.UTC(y, mo, d, h, mi, 0);
    let utc = wall - tzOffsetMs(zone, wall);
    return wall - tzOffsetMs(zone, utc);
}

function zonedParts(zone, utcMs) {
    const shifted = new Date(utcMs + tzOffsetMs(zone, utcMs));
    return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate(), wd: shifted.getUTCDay() };
}

function to24(h, ap) {
    h = parseInt(h, 10) % 12;
    return ap.toUpperCase() === 'PM' ? h + 12 : h;
}

function readToken(m, i) {
    if (!m[i + 2]) return null;
    const mon = m[i] || m[i + 6];
    const day = m[i] ? m[i + 1] : m[i + 7];
    return {
        mon: mon ? MONTHS[mon.slice(0, 3).toUpperCase()] : null,
        day: day ? parseInt(day, 10) : null,
        h: to24(m[i + 2], m[i + 4]),
        mi: parseInt(m[i + 3], 10),
        zone: ZONES[m[i + 5].toUpperCase()]
    };
}

function datedInstant(tok, now) {
    const { y } = zonedParts(tok.zone, now);
    let best = null;
    for (const year of [y - 1, y, y + 1]) {
        const t = zonedToUtc(tok.zone, year, tok.mon, tok.day, tok.h, tok.mi);
        if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
    }
    return best;
}

function undatedInstant(tok, title, now) {
    const today = zonedParts(tok.zone, now);
    let target = null;
    for (const [re, wd] of WEEKDAY_TAGS) if (re.test(title)) target = wd;
    if (target === null && /\bNFL\b/i.test(title)) target = 0;
    let addDays = 0;
    if (target !== null) addDays = (target - today.wd + 7) % 7;
    return {
        start: zonedToUtc(tok.zone, today.y, today.mo, today.d + addDays, tok.h, tok.mi),
        inferred: target !== null
    };
}

function durationFor(title) {
    for (const [re, ms] of DURATIONS) if (re.test(title)) return ms;
    return DEFAULT_DURATION_MS;
}

function titleCase(s) {
    return s.toLowerCase().replace(/[\p{L}\p{N}][\p{L}\p{N}'’.+]*/gu, w => {
        const up = w.toUpperCase();
        if (ACRONYMS.has(up.replace(/[.'’]+$/, '')) || /\d/.test(w)) return up;
        return w.charAt(0).toUpperCase() + w.slice(1);
    });
}

function sourceLabel(group) {
    const parts = String(group || '').split('|').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'Live Event';
}

function parseEventSlot(name, now, hintText = '') {
    const parts = String(name || '').split(SLOT_SPLIT_RE);
    if (parts.length < 2) return null;
    const slot = parts[0].trim();
    const rest = parts.slice(1).join(': ').trim();
    if (!rest) return null;
    const m = rest.match(SCHEDULE_RE);
    if (!m) return null;
    const title = rest.slice(0, m.index).replace(/[\s\-–—]+$/, '').trim();
    if (!title) return null;
    const a = readToken(m, 1);
    const b = readToken(m, 1 + TOKEN_GROUPS);
    const toks = [a, b].filter(Boolean);
    const explicit = toks.filter(t => t.mon !== null && t.day !== null);
    const pick = explicit.find(t => t.zone === ZONES.ET) || explicit[0];
    let start;
    let day = 'dated';
    if (pick) {
        start = datedInstant(pick, now);
    } else {
        const et = toks.find(t => t.zone === ZONES.ET) || toks[0];
        const undated = undatedInstant(et, `${title} ${hintText}`, now);
        start = undated.start;
        day = undated.inferred ? 'inferred' : 'assumed';
    }
    return { slot, title, start, end: start + durationFor(title), day };
}

function wrapLines(text, width) {
    const lines = [];
    let line = '';
    for (const word of text.replace(/ +([–—-]|@|vs\.?) +/gi, '\u00a0$1 ').split(/ +/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > width) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function cardText(title) {
    const words = title.split(/ +/).filter(Boolean);
    let text = wrapLines(title, CARD_LINE).join('\\n');
    while (text.length > CARD_TEXT_MAX && words.length > 1) {
        words.pop();
        text = wrapLines(words.join(' ') + '…', CARD_LINE).join('\\n');
    }
    return text.slice(0, CARD_TEXT_MAX).replace(/\\+$/, '');
}

function brightness(hex) {
    const n = parseInt(hex, 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function cardTitleFor(e) {
    let title = e.network ? e.title.replace(` · ${e.network}`, '') : e.title;
    const tag = title.match(/\s*\(([^)]+)\)\s*$/);
    if (tag && e.sport && e.sport.toLowerCase().includes(tag[1].toLowerCase())) title = title.slice(0, tag.index);
    return title;
}

function eventCardUrl(e) {
    const source = e.sources[0] || '';
    const teamColor = [e.color, e.altColor].find(c => typeof c === 'string' && /^[0-9a-f]{6}$/i.test(c));
    const color = teamColor || CARD_COLORS[parseInt(crypto.createHash('md5').update(source).digest('hex').slice(0, 6), 16) % CARD_COLORS.length];
    const textColor = brightness(color) > 0.6 ? '111111' : 'FFFFFF';
    const footer = e.sport || e.network || source;
    let text = cardText(cardTitleFor(e));
    if (footer && text.length + 2 + footer.length <= CARD_TEXT_MAX) text += `\\n${footer}`;
    return `https://placehold.co/640x360/${color}/${textColor}/png?font=oswald&text=${encodeURIComponent(text)}`;
}

function eventKey(title, start) {
    const t = title.toUpperCase().replace(NOISE_PARENS, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
    return `${t}|${Math.round(start / 300000)}`;
}

// Conference streams can lead with their network, as in "SEC Network+ #11 Tennessee @ #7 Florida".
const NETWORK_PREFIXES = [
    [/^(?:SEC\s*Network\s*\+|SECN\s*\+)\s+/i, 'SEC Network+'],
    [/^ACC\s*(?:NX|Network Extra)\s+/i, 'ACCNX'],
    [/^(?:Big Ten|B1G)\s*\+\s+/i, 'B1G+'],
    [/^ESPN\s*\+\s+/i, 'ESPN+'],
    [/^ESPNU\s+/i, 'ESPNU']
];

function splitNetworkPrefix(title) {
    for (const [re, network] of NETWORK_PREFIXES) {
        const m = title.match(re);
        if (m && title.length > m[0].length) return { network, title: title.slice(m[0].length) };
    }
    return { network: null, title };
}

const SPORT_CATEGORY = /sport|football|soccer|f[uú]tbol|basketball|baseball|hockey|tennis|golf|cricket|rugby|boxing|mma|martial|wrestling|motor|racing|cycling|athletics|volleyball|darts|snooker|lacrosse|softball|deportes/i;
const SPORT_CHANNEL = /sport|espn|\bfs[12]\b|fox soccer|\btnt\b|\btbs\b|nbc ?sports|cbs ?sports|bein|dazn|eurosport|\bnfl\b|nhl network|mlb network|nba tv|big ?ten|\bbtn\b|sec network|acc network|golf|tennis|setanta|\btsn\b|sportsnet|willow|supersport|premier sports|bt ?sport|fight|\bufc\b|racing|\bmsg\b|nesn|marquee|altitude|monumental|root sports|fubo|trutv/i;
const SPORT_TITLE = /\b(football|soccer|f[uú]tbol|basketball|baseball|hockey|tennis|golf|cricket|rugby|boxing|mma|ufc|wrestling|volleyball|lacrosse|softball|darts|snooker|cycling|nascar|indycar|motogp|formula 1|f1|grand prix|nfl|nba|wnba|mlb|nhl|mls|ncaa|premier league|la ?liga|serie a|bundesliga|ligue 1|champions league|europa league|nations league|world cup)\b/i;
// Films like "Love & Basketball" match the sport words, so movie channels never contribute games.
const MOVIE_CHANNEL = /\b(?:cinemas?|movies?|films?|filmes|pel[ií]culas|cine|showtime|sho|hbo|starz|encore|cinemax|mgm\+?|epix|tcm|amc|ifc|sundance|hallmark|lifetime|bet)\b/i;
const NOT_LIVE_TITLE = /\b(highlights?|hl|magazine|show|preview|review|countdown|tonight|today|center|centre|report|update|news|talk|daily|plays of the week|inside|recap|rewind|classics?|best of|replay|encore|pre-?game|post-?game|kickoff|studio|analysis|podcast|documentary|30 for 30|debrief|upcoming)\b|\blive\s*$/i;
const REPLAY_DESC = /\b(relive|highlights|best of|looks? back|replay|rewind|classic|revisit|from earlier|from last)\b/i;
// Studio shows on event channels ("NFL Gameday Final", "Sunday NFL Countdown", "Inside The NBA"). Matchups are never studio shows.
const STUDIO_SHOW_RE = /\b(?:highlights?|countdown|pre-?game|post-?game|pre-?kick|studio|halftime|huddle|scoreboard|band performances?|warm-?ups?|recap|primetime|sportscenter|sportsnet central|espn fc|in the crease|coach'?e?s show|college gameday|gameday (?:final|live|kickoff)|nfl live|(?:night|sec|acc|big ten|college) football final)\b|^inside the\b|\b(?:live|today|tonight|center|centre)\s*$/i;
// A team name, optionally followed by a two-letter state tag as in "Maryville (Mo)".
const SIDE = "([\\p{Lu}\\p{N}][\\p{L}\\p{N}.'’&/ -]{0,40}?(?:\\s\\(\\p{Lu}\\p{L}\\.?\\))?)";
// A ranking in front of a team ("#24 Colorado", "No. 3 Kentucky"). It is matched but kept out of the team name.
const RANK = '(?:[Nn][Oo]\\.?\\s?\\d+\\s+|#\\d+\\s+)?';
// A period ends the matchup, except in abbreviations like "St. Bonaventure".
const SIDE_END = '\\s*(?:(?<!\\b(?:St|Mt|Ft))\\.|[,:;(]|\\s[-–]\\s|$)';
const VERSUS_RE = new RegExp(`^\\s*(?:[Tt]he\\s+)?${RANK}${SIDE}\\s+([Vv][Ss]\\.?|[Vv]\\.?|[Aa][Tt]|@)\\s+(?:[Tt]he\\s+)?${RANK}${SIDE}${SIDE_END}`, 'u');
const HOST_RE = new RegExp(`^\\s*(?:the\\s+)?${RANK}${SIDE}\\s+(host|visit|welcome|face|meet|take on)s?\\s+(?:the\\s+)?${RANK}${SIDE}\\s*(?:[.,;(]|\\s(?:at|in|on|for|from)\\s)`, 'iu');
const MAX_SIDE_WORDS = 5;
const SPORT_NOUN = '(?:football|soccer|basketball|baseball|hockey|tennis|golf|cricket|rugby|volleyball|softball|lacrosse|darts|snooker|wrestling|boxing|racing|cycling|swimming|athletics|gymnastics|bowling|handball|futsal|motocross|supercross)';
const GAME_END_RE = new RegExp(`\\b(?:${SPORT_NOUN}|league|cup|championship|open|trophy|series|grand prix|tour|games|race|rally|match|derby|bowl|final|semi-?final|playoffs?)\\s*$`, 'i');
const GAME_PREFIX_RE = new RegExp(`^(?:${SPORT_NOUN}|formula \\d|f1|motogp|nascar|indycar|ufc \\d+|wwe|aew)\\b\\s*[:,]`, 'i');
const SERIES_RE = /^(?:formula (?:1|2|3|e)|f1|motogp|moto2|moto3|nascar\b.*|indycar\b.*|supercars|world superbike|ufc \d+.*|ufc fight night.*|pfl\b.*|bellator\b.*|nfl|nba|wnba|mlb|nhl|mls)$/i;
const SPANISH_GAME_RE = /^(?:f[uú]tbol|baloncesto|b[eé]isbol|tenis)\b.*\b(?:liga|primera|serie|divisi[oó]n|copa|mls|nba|wnba|mlb|nfl|nhl|amistosos?|internacional(?:es)?|argentino|mexicano|uruguayo|brasileir[oã]o|champions|europa|libertadores|sudamericana)\b/i;

function looksLikeGame(title) {
    const t = title.trim();
    if (/^the\s/i.test(t)) return false;
    const head = t.split(/:\s|\s[-–—]\s/)[0];
    return GAME_END_RE.test(t) || GAME_END_RE.test(head) || GAME_PREFIX_RE.test(t) ||
        SERIES_RE.test(t) || SERIES_RE.test(head) || SPANISH_GAME_RE.test(t);
}
const MERGE_WINDOW_MS = 45 * 60000;
const GUIDE_BEFORE_MS = 10 * 60000;
const GUIDE_AHEAD_MS = 70 * 60000;
const MIN_GAME_SECONDS = 50 * 60;
const MIN_MATCHUP_SECONDS = 25 * 60;

function cleanSide(s) {
    return s.replace(/\s*\((?:week|wk|round|rd|game|match|md)[^)]*\)\s*$/i, '').trim();
}

function validSide(s) {
    const words = s.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= MAX_SIDE_WORDS && !NOT_LIVE_TITLE.test(s);
}

function matchupOf(text) {
    if (!text) return null;
    for (const seg of String(text).split(/\s[-–—]\s|:\s/)) {
        let m = seg.match(VERSUS_RE);
        if (m) {
            const a = cleanSide(m[1]);
            const b = cleanSide(m[3]);
            if (!validSide(a) || !validSide(b)) continue;
            const away = /^(at|@)$/i.test(m[2]);
            return { teams: [a, b], label: away ? `${a} @ ${b}` : `${a} vs ${b}` };
        }
        m = seg.match(HOST_RE);
        if (m) {
            const a = cleanSide(m[1]);
            const b = cleanSide(m[3]);
            if (!validSide(a) || !validSide(b)) continue;
            const verb = m[2].toLowerCase();
            if (verb === 'host' || verb === 'welcome') return { teams: [b, a], label: `${b} @ ${a}` };
            if (verb === 'visit') return { teams: [a, b], label: `${a} @ ${b}` };
            return { teams: [a, b], label: `${a} vs ${b}` };
        }
    }
    return null;
}

function teamWords(side) {
    return side.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

function sideMatches(a, b) {
    const wa = teamWords(a);
    const wb = teamWords(b);
    if (!wa.length || !wb.length) return false;
    return wb.includes(wa[wa.length - 1]) || wa.includes(wb[wb.length - 1]);
}

function sameMatchup(x, y) {
    return (sideMatches(x[0], y[0]) && sideMatches(x[1], y[1])) || (sideMatches(x[0], y[1]) && sideMatches(x[1], y[0]));
}

const SCHEDULE_WINDOW_MS = 75 * 60000;
const IN_PROGRESS_GRACE_MS = 20 * 60000;

function nameMatches(side, name) {
    const a = teamWords(side);
    const b = teamWords(name);
    if (!a.length || !b.length) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.every(w => long.includes(w));
}

function teamMatches(side, names) {
    return names.some(n => nameMatches(side, n));
}

function hasTeams(g, [x, y]) {
    return (teamMatches(x, g.teams[0]) && teamMatches(y, g.teams[1])) ||
        (teamMatches(x, g.teams[1]) && teamMatches(y, g.teams[0]));
}

function findGame(e, games) {
    let best = null;
    for (const g of games) {
        const d = Math.abs(g.start - e.start);
        if (d > SCHEDULE_WINDOW_MS) continue;
        if (hasTeams(g, e.teams) && (!best || d < best.d)) best = { g, d };
    }
    return best ? best.g : null;
}

// A guide airing of a game that ESPN already lists as finished earlier in the day is a replay.
function dropGuideReplays(byKey, games) {
    if (!games || !games.length) return;
    for (const [key, e] of byKey) {
        if (!e.fromGuide || !e.teams || findGame(e, games)) continue;
        if (games.some(g => g.state === 'post' && g.start < e.start && hasTeams(g, e.teams))) byKey.delete(key);
    }
}

// Polymarket sides are [full name, name, alias]. College names are mascots ("Warhawks"), so one side may match
// on any of its names as long as the other matches on the full name.
function sidesMatch(a, b) {
    const full = (x, y) => x.some(n => teamMatches(n, [y[0]]));
    const any = (x, y) => x.some(n => teamMatches(n, y));
    const pair = (x0, y0, x1, y1) => (full(x0, y0) && any(x1, y1)) || (any(x0, y0) && full(x1, y1));
    return pair(a[0], b[0], a[1], b[1]) || pair(a[0], b[1], a[1], b[0]);
}

function applyLiveActivity(index, games) {
    for (const e of index.values()) {
        delete e.liveBoost;
        if (!e.teams || !games || !games.length) continue;
        const sides = e.gameTeams || e.teams.map(t => [t]);
        let best = null;
        for (const g of games) {
            const d = Math.abs(g.start - e.start);
            if (d > SCHEDULE_WINDOW_MS || !sidesMatch(sides, g.teams)) continue;
            if (!best || d < best.d) best = { g, d };
        }
        if (best && best.g.boost) e.liveBoost = best.g.boost;
    }
}

function annotateWithSchedule(byKey, games, now) {
    if (!games || !games.length) return;
    for (const e of byKey.values()) {
        if (!e.teams) continue;
        const g = findGame(e, games);
        if (!g) continue;
        e.sport = g.sport;
        e.game = g;
        e.importance = g.importance;
        e.color = g.color;
        e.altColor = g.altColor;
        e.status = g.state;
        e.statusDetail = g.detail;
        if (g.state === 'post') e.final = true;
        else if (g.state === 'in') e.end = Math.max(e.end, now + IN_PROGRESS_GRACE_MS);
    }
}

function networkName(channelName) {
    return String(channelName || '')
        .trim()
        .replace(/^(?:[A-Z]{2,7}-)?[A-Z]{2,7}\s*[-|:]\s*/, '')
        .replace(/[◉ᵛᶦᵖ]+/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\b(UHD|FHD|HD|SD|HEVC|4K|H265)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function networkBrand(network) {
    const brand = network.replace(/\s+\d+\s+\S.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    return brand || network;
}

function topBrand(counts) {
    let best = null;
    for (const [brand, n] of counts) if (!best || n > best[1]) best = [brand, n];
    return best ? best[0] : null;
}

function pastYearReplay(desc, now) {
    const m = String(desc || '').match(/\b(?:from|on|aired|recorded)\s+[A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+((?:19|20)\d{2})\b/);
    return !!m && parseInt(m[1], 10) < new Date(now).getUTCFullYear();
}

function guideEvent(p, channelLabel, now = Date.now()) {
    if (p.r && !p.l) return null;
    if (!p.l && pastYearReplay(p.d, now)) return null;
    const title = p.t || '';
    const sportCat = SPORT_CATEGORY.test((p.c || []).join(' '));
    const sportTitle = SPORT_TITLE.test(title);
    const sportChannel = SPORT_CHANNEL.test(channelLabel);
    if (!sportCat && !sportTitle && !(sportChannel && p.l)) return null;
    if (!p.l && !sportCat && !sportChannel && MOVIE_CHANNEL.test(channelLabel)) return null;
    if (!p.l && NOT_LIVE_TITLE.test(title)) return null;
    if (!p.l && REPLAY_DESC.test(p.d || '')) return null;
    const matchup = matchupOf(p.st) || matchupOf(title) || matchupOf(p.d);
    if (!matchup && !p.l && !looksLikeGame(title)) return null;
    if (!p.l && p.e - p.s < (matchup ? MIN_MATCHUP_SECONDS : MIN_GAME_SECONDS)) return null;
    const fromTitle = matchup && title.includes(matchup.teams[0]) && title.includes(matchup.teams[1]);
    const league = fromTitle
        ? title.split(/\s[-–—]\s/).filter(s => !s.includes(matchup.teams[0])).join(' – ') || null
        : (matchup ? title : null);
    let name = matchup ? matchup.label : title;
    if (!matchup && p.st && p.st.length <= 50) name = `${title}: ${p.st}`;
    return { name, league, teams: matchup ? matchup.teams : null };
}

// "Singapore Grand Prix", "Bahrain GP", or the European order: "GP de Mónaco", "GP Bahrain".
const GP_NAME_RES = [
    /([\p{L}]+)\s+(?:grand prix|gp)\b/iu,
    /\b(?:grand prix|gran premio|grande pr[eé]mio|gp)\s+(?:(?:de|do|da|del|di|of|von)\s+)?([\p{L}]+)/iu
];
const F1_RE = /\bf1\b|formula (?:1|one)\b/i;
const RACE_LIVE_WINDOW_MS = 3 * 3600000;
const WEEKEND_LEAD_MS = 12 * 3600000;
const WEEKEND_MS = 4 * 86400000;

function gpStem(title) {
    for (const re of GP_NAME_RES) {
        const m = String(title || '').match(re);
        if (m) return m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 5);
    }
    return null;
}

function raceWeekendCovers(r, start) {
    const last = r.raceStart || r.weekendEnd;
    const end = last ? last + RACE_LIVE_WINDOW_MS : r.weekendStart + WEEKEND_MS;
    return start >= r.weekendStart - WEEKEND_LEAD_MS && start <= end;
}

// Guides rarely flag repeats, so F1 that airs outside its race weekend on ESPN's calendar is treated as a replay.
// A broadcast that names its Grand Prix has to fall in that race's weekend; one that doesn't, in any weekend.
function isRaceReplay(p, start, races) {
    if (!races || !races.length) return false;
    const title = p.t || '';
    if (!F1_RE.test(`${title} ${p.d || ''}`)) return false;
    const stem = gpStem(title);
    const named = stem ? races.filter(r => gpStem(r.name) === stem) : [];
    return !(named.length ? named : races).some(r => raceWeekendCovers(r, start));
}

function addGuideEvents(byKey, slotEvents, epgData, channelsByEpgId, groupOf, now, races = null) {
    for (const [epgId, list] of Object.entries(epgData || {})) {
        const chans = channelsByEpgId.get(epgId);
        if (!chans || !Array.isArray(list)) continue;
        const first = chans[0];
        const label = `${groupOf(first) || ''} ${first.name || ''} ${epgId}`;
        for (const p of list) {
            const start = p.s * 1000;
            const end = p.e * 1000;
            if (end <= now - GUIDE_BEFORE_MS || start >= now + GUIDE_AHEAD_MS) continue;
            const g = guideEvent(p, label, now);
            if (!g || isRaceReplay(p, start, races)) continue;
            const src = sourceLabel(groupOf(first));
            const network = titleCase(networkName(first.name));
            const links = chans.map(c => ({ id: c.id, slot: (c.name || '').trim(), source: src, logo: c.logo || c.attributes?.['tvg-logo'] || null }));
            const target = g.teams && slotEvents.find(e => e.teams && Math.abs(e.start - start) <= MERGE_WINDOW_MS && sameMatchup(e.teams, g.teams));
            if (target) {
                if (!target.sources.includes(src)) target.sources.push(src);
                for (const l of links) if (!target.channels.some(c => c.id === l.id)) target.channels.push(l);
                if (!target.league && g.league) target.league = g.league;
                continue;
            }
            const descSig = (p.st || p.d || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
            const key = g.teams
                ? eventKey(g.name, start)
                : eventKey(descSig ? `${g.name}|${descSig}` : `${g.name} · ${network}`, start);
            let entry = byKey.get(key);
            if (!entry) {
                entry = {
                    id: 'iptv_ev_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16),
                    title: g.name,
                    baseName: g.teams ? null : g.name,
                    league: g.league,
                    network,
                    brands: new Map(),
                    teams: g.teams,
                    start,
                    end,
                    assumedDay: false,
                    fromGuide: true,
                    sources: [],
                    channels: []
                };
                byKey.set(key, entry);
            }
            for (const c of chans) {
                const brand = networkBrand(titleCase(networkName(c.name)));
                if (brand) entry.brands.set(brand, (entry.brands.get(brand) || 0) + 1);
            }
            if (!entry.sources.includes(src)) entry.sources.push(src);
            for (const l of links) if (!entry.channels.some(c => c.id === l.id)) entry.channels.push(l);
        }
    }
    for (const e of byKey.values()) {
        if (!e.brands) continue;
        e.network = topBrand(e.brands) || e.network;
        if (e.baseName) {
            e.title = `${e.baseName} · ${e.network}`;
            e.programme = e.baseName;
        }
        delete e.brands;
        delete e.baseName;
    }
}

const BROADCAST_NETWORKS = [
    { names: ['ESPN'], re: /^ESPN(?: 1)?$/ },
    { names: ['ESPN2'], re: /^ESPN ?2$/ },
    { names: ['ESPNU'], re: /^ESPN ?U(?: COLLEGE SPORTS)?$/ },
    { names: ['ESPNEWS', 'ESPN News'], re: /^ESPN ?NEWS$/ },
    { names: ['ESPN Deportes'], re: /^ESPN DEPORTES$/ },
    { names: ['ACC Network', 'ACCN'], re: /^(?:ESPN )?ACC NETWORK$/ },
    { names: ['SEC Network', 'SECN'], re: /^(?:ESPN )?SEC NETWORK$/ },
    { names: ['BTN', 'Big Ten Network'], re: /^(?:BTN|BIG TEN NETWORK)$/ },
    { names: ['CBSSN', 'CBS Sports Network'], re: /^CBS SPORTS NETWORK$/ },
    { names: ['CBS Sports Golazo', 'Golazo'], re: /^CBS SPORTS GOLAZO(?: NETWORK)?$/ },
    { names: ['FS1'], re: /^(?:FS1|FOX SPORTS 1)$/ },
    { names: ['FS2'], re: /^(?:FS2|FOX SPORTS 2)$/ },
    { names: ['TNT'], re: /^TNT(?: EAST| WEST)?$/ },
    { names: ['TBS'], re: /^TBS(?: EAST| WEST)?$/ },
    { names: ['truTV'], re: /^TRU ?TV(?: EAST| WEST)?$/ },
    { names: ['USA Net', 'USA Network'], re: /^USA NETWORK(?: EAST| WEST)?$/ },
    { names: ['NFL Net', 'NFL Network'], re: /^NFL NETWORK$/ },
    { names: ['NHL Net', 'NHL Network'], re: /^NHL NETWORK$/ },
    { names: ['MLB Net', 'MLBN', 'MLB Network'], re: /^MLB NETWORK$/ },
    { names: ['NBA TV'], re: /^NBA TV$/ },
    { names: ['NESN'], re: /^NESN(?: BOSTON)?$/ },
    { names: ['MSG'], re: /^MSG$/ },
    { names: ['MSGSN', 'MSG+'], re: /^MSG (?:PLUS|2)$/ },
    { names: ['SNY'], re: /^(?:SNY|SPORTSNET NEW YORK)$/ },
    { names: ['YES'], re: /^YES(?: NETWORK)?$/ },
    { names: ['MNMT', 'Monumental Sports Network'], re: /^MONUMENTAL SPORTS NETWORK$/ },
    { names: ['Marquee', 'MARQ'], re: /^MARQUEE SPORTS NETWORK$/ },
    { names: ['NBC Sports Phil', 'NBCSP'], re: /^NBC SPORTS PHILADELPHIA$/ },
    { names: ['NBC Sports BA', 'NBCSBA'], re: /^NBC SPORTS BAY AREA$/ },
    { names: ['NBC Sports CA', 'NBCSCA'], re: /^NBC SPORTS CALIFORNIA$/ },
    { names: ['NBC Sports Boston', 'NBCSB'], re: /^NBC SPORTS BOSTON$/ },
    { names: ['CHSN'], re: /^CHICAGO SPORTS NETWORK$/ },
    { names: ['Altitude Sports', 'ALT'], re: /^ALTITUDE SPORTS$/ },
    { names: ['SCHN', 'Space City Home Network'], re: /^SPACE CITY HOME NETWORK$/ },
    { names: ['SportsNet LA', 'SNLA'], re: /^SPECTRUM SPORTSNET LA$/ },
    { names: ['ABC'], re: /^ABC(?: \d.*)?$/, broadcast: true, national: /^ABC$/ },
    { names: ['CBS'], re: /^CBS(?: \d.*)?$/, broadcast: true, national: /^CBS$/ },
    { names: ['FOX'], re: /^FOX(?: \d.*)?$/, broadcast: true, national: /^FOX$/ },
    { names: ['NBC'], re: /^NBC(?: \d.*)?$/, broadcast: true, national: /^NBC$/ },
    { names: ['CW'], re: /^CW(?: \d.*)?$/, broadcast: true, national: /^CW$/ }
];
const NETWORK_BY_NAME = new Map();
for (const n of BROADCAST_NETWORKS) for (const name of n.names) NETWORK_BY_NAME.set(name.toLowerCase().replace(/[^a-z0-9+]/g, ''), n);
const US_CHANNEL_RE = /^\s*USA?\s*[-|:]\s*/;
const NORTH_AMERICA_CHANNEL_RE = /^\s*(?:USA?|CA)\s*[-|:]\s*/;
const MIRROR_RE = /^NCAAF \d+ : (.+)$/;
const REGIONAL_WINDOW_MS = 3 * 3600000;
const GENERIC_MATCH_MS = 20 * 60000;
const SCHEDULE_BEFORE_MS = 6 * 3600000;
const SPORT_TITLE_WORDS = [
    [/football|nfl/i, /football|nfl/i],
    [/hockey|nhl/i, /hockey|nhl/i],
    [/basketball|nba|wnba/i, /basketball|baloncesto|nba|wnba/i],
    [/baseball|mlb/i, /baseball|b[eé]isbol|mlb/i],
    [/volleyball/i, /volleyball/i],
    [/lacrosse/i, /lacrosse/i],
    [/soccer|league|liga|bundesliga|ligue|serie|mls|nwsl|championship/i, /soccer|f[uú]tbol|football|league|liga|mls|nwsl/i]
];

function networkFor(espnName) {
    return NETWORK_BY_NAME.get(String(espnName).toLowerCase().replace(/[^a-z0-9+]/g, '')) || null;
}

function sportCompatible(sport, title) {
    for (const [s, t] of SPORT_TITLE_WORDS) if (s.test(sport)) return t.test(title);
    return false;
}

function buildNetworkIndex(channels, groupOf) {
    const index = new Map();
    const slot = (n) => {
        if (!index.has(n)) index.set(n, { all: [], national: [], mirrors: [] });
        return index.get(n);
    };
    for (const c of channels) {
        if (!c || c.type !== 'tv' || !US_CHANNEL_RE.test(c.name || '')) continue;
        const name = networkName(c.name).toUpperCase();
        const link = { id: c.id, slot: (c.name || '').trim(), source: sourceLabel(groupOf(c)), logo: c.logo || c.attributes?.['tvg-logo'] || null };
        const mirror = name.match(MIRROR_RE);
        if (mirror) {
            const n = networkFor(mirror[1]);
            if (n) slot(n).mirrors.push(link);
            continue;
        }
        for (const n of BROADCAST_NETWORKS) {
            if (!n.re.test(name)) continue;
            // Station news channels like "NBC 2 News" match the affiliate pattern but don't carry network games.
            if (n.broadcast && /\bNEWS\b/.test(name)) break;
            slot(n).all.push(link);
            if (n.national && n.national.test(name)) slot(n).national.push(link);
            break;
        }
    }
    return index;
}

function isRegional(game, network, games) {
    if (!network.broadcast) return false;
    return games.some(o => o !== game && Math.abs(o.start - game.start) < REGIONAL_WINDOW_MS &&
        o.networks.some(name => networkFor(name) === network));
}

function addLinks(target, links) {
    for (const l of links) {
        if (target.channels.some(c => c.id === l.id)) continue;
        target.channels.push(l);
        if (!target.sources.includes(l.source)) target.sources.push(l.source);
    }
}

function applyGame(e, g, now) {
    e.game = g;
    e.sport = g.sport;
    e.importance = g.importance;
    e.status = g.state;
    e.statusDetail = g.detail;
    e.color = g.color;
    e.altColor = g.altColor;
    if (g.state === 'in') e.end = Math.max(e.end, now + IN_PROGRESS_GRACE_MS);
    if (isBareMatchup(e.title)) e.title = g.label;
}

const LEADING_SPORT_RE = /^(?:(?:men'?s|women'?s|mens|womens)\s+)?(?:college\s+)?(?:football|soccer|field hockey|hockey|volleyball|basketball|baseball|softball|lacrosse)\s+/i;

function isBareMatchup(title) {
    const rest = String(title).replace(LEADING_SPORT_RE, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/(^|\s)#\d+\s+/g, '$1').trim();
    const m = matchupOf(rest);
    return !!m && m.label.replace(/\s+/g, ' ').toLowerCase() === rest.replace(/\s+/g, ' ').toLowerCase();
}

function channelNetwork(slotName) {
    if (!US_CHANNEL_RE.test(slotName)) return null;
    const name = networkName(slotName).toUpperCase();
    const mirror = name.match(MIRROR_RE);
    if (mirror) return networkFor(mirror[1]);
    return BROADCAST_NETWORKS.find(n => n.re.test(name)) || null;
}

function keepListedNetworks(e, nets) {
    if (!nets.length) return;
    e.channels = e.channels.filter(c => {
        const n = channelNetwork(c.slot);
        return !n || nets.includes(n);
    });
}

function broadcastNetworkOf(slotName) {
    const n = channelNetwork(slotName);
    return n && n.broadcast ? n.names[0] : null;
}

// A bare "US - NBC" feed has no city or call sign, so its guide mapping is a guess.
function isNationalFeed(slotName) {
    const n = channelNetwork(slotName);
    return !!(n && n.national && n.national.test(networkName(slotName).toUpperCase()));
}

function isNorthAmerican(slotName) {
    return NORTH_AMERICA_CHANNEL_RE.test(slotName || '');
}

function sideNamed(names, words) {
    return names.some(n => {
        const w = teamWords(n);
        return w.length > 0 && words.has(w[w.length - 1]);
    });
}

// Whether a channel's guide programme at game time is this game: 'match', 'other' when something else is on,
// or 'unknown' when there's no listing, the event has no teams, or the listing is a generic one like "NFL Football".
function programmeVerdict(e, p) {
    if (!p || !e.teams) return 'unknown';
    const words = new Set(teamWords([p.t, p.st, p.d].filter(Boolean).join(' ')));
    const sides = e.gameTeams || e.teams.map(t => [t]);
    if (sides.every(names => sideNamed(names, words))) return 'match';
    if (matchupOf(p.st) || matchupOf(p.t)) return 'other';
    return SPORT_TITLE.test(p.t || '') || looksLikeGame(p.t || '') ? 'unknown' : 'other';
}

function addScheduleNetworks(byKey, games, channels, groupOf, now) {
    const netIndex = buildNetworkIndex(channels, groupOf);
    const dayEnd = dayBounds(now).end;
    const byGame = new Map();
    for (const [key, e] of byKey) {
        if (!e.game) continue;
        const first = byGame.get(e.game);
        if (!first) { byGame.set(e.game, e); continue; }
        addLinks(first, e.channels);
        byKey.delete(key);
    }
    for (const g of games) {
        if (g.state === 'post') continue;
        if (g.start >= dayEnd || (g.state !== 'in' && g.start < now - SCHEDULE_BEFORE_MS)) continue;
        const nets = [...new Set(g.networks.map(networkFor).filter(Boolean))];
        const links = [];
        const exact = [];
        for (const n of nets) {
            const found = netIndex.get(n);
            const regional = isRegional(g, n, games);
            if (regional) continue;
            exact.push(n);
            if (!found) continue;
            links.push(...found.all);
            if (/college football/i.test(g.sport)) links.push(...found.mirrors);
        }
        let target = byGame.get(g) || null;
        const generic = [];
        for (const [key, e] of byKey) {
            if (e.teams || !e.programme || !e.network) continue;
            if (Math.abs(e.start - g.start) > GENERIC_MATCH_MS || !sportCompatible(g.sport, e.programme)) continue;
            const net = e.network.toUpperCase();
            const northAmerican = e.channels.some(c => NORTH_AMERICA_CHANNEL_RE.test(c.slot));
            if ((northAmerican && exact.some(n => n.re.test(net))) || e.channels.some(c => exact.includes(channelNetwork(c.slot)))) generic.push([key, e]);
        }
        const espnNetworks = g.networks.filter(networkFor).slice(0, 2).join(' · ');
        if (!target && generic.length) {
            const [, e] = generic.shift();
            target = e;
            target.league = target.programme;
            target.title = g.label;
            target.teams = g.teams.map(names => names[1] || names[0]);
            if (espnNetworks) target.network = espnNetworks;
            delete target.programme;
        }
        for (const [key, e] of generic) {
            addLinks(target, e.channels);
            byKey.delete(key);
        }
        if (!target) {
            if (!links.length) continue;
            const key = `espn|${eventKey(g.label, g.start)}`;
            target = {
                id: 'iptv_ev_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16),
                title: g.label,
                teams: g.teams.map(names => names[1] || names[0]),
                start: g.start,
                end: g.start + DEFAULT_DURATION_MS,
                assumedDay: false,
                sources: [],
                channels: []
            };
            byKey.set(key, target);
        }
        if (!target.network && espnNetworks) target.network = espnNetworks;
        applyGame(target, g, now);
        addLinks(target, links);
        keepListedNetworks(target, nets);
        byGame.set(g, target);
    }
}

function buildEventIndex(channels, { now = Date.now(), groupOf = c => c.category || c.attributes?.['group-title'], epgData = null, epgIdOf = null, schedule = null, races = null } = {}) {
    const byKey = new Map();
    const channelsByEpgId = new Map();
    for (const c of channels) {
        if (!c || c.type !== 'tv') continue;
        const epgId = epgIdOf ? epgIdOf(c) : null;
        if (epgId) {
            if (!channelsByEpgId.has(epgId)) channelsByEpgId.set(epgId, []);
            channelsByEpgId.get(epgId).push(c);
        }
        const group = groupOf(c) || '';
        const ev = parseEventSlot(c.name, now, group);
        if (!ev) continue;
        const key = eventKey(ev.title, ev.start);
        let entry = byKey.get(key);
        if (!entry) {
            const { network, title } = splitNetworkPrefix(titleCase(ev.title.replace(NOISE_PARENS, '').trim()));
            const teams = matchupOf(title)?.teams || null;
            if (!teams && STUDIO_SHOW_RE.test(title)) continue;
            entry = {
                id: 'iptv_ev_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16),
                title,
                teams,
                start: ev.start,
                end: ev.end,
                assumedDay: ev.day === 'assumed',
                sources: [],
                channels: []
            };
            if (network) entry.network = network;
            byKey.set(key, entry);
        }
        if (ev.day !== 'assumed') entry.assumedDay = false;
        const src = sourceLabel(group);
        if (!entry.sources.includes(src)) entry.sources.push(src);
        entry.channels.push({ id: c.id, slot: ev.slot, source: src, logo: c.logo || c.attributes?.['tvg-logo'] || null, kind: 'slot' });
    }
    if (epgData) addGuideEvents(byKey, [...byKey.values()], epgData, channelsByEpgId, groupOf, now, races);
    dropGuideReplays(byKey, schedule);
    annotateWithSchedule(byKey, schedule, now);
    if (schedule && schedule.length) addScheduleNetworks(byKey, schedule, channels, groupOf, now);
    for (const e of byKey.values()) {
        if (e.game) e.gameTeams = e.game.teams;
        delete e.game;
        delete e.fromGuide;
    }
    const byId = new Map();
    for (const e of byKey.values()) byId.set(e.id, e);
    return byId;
}

function eventState(e, now = Date.now()) {
    if (e.final) return null;
    if (now >= e.start - EARLY_MS && now < e.end) return now < e.start ? 'soon' : 'live';
    if (now < e.start && e.start - now <= SOON_MS) return 'soon';
    return null;
}

const SPORT_CATEGORIES = ['Football', 'Basketball', 'Baseball', 'Hockey', 'Soccer', 'Volleyball', 'Field Hockey', 'Lacrosse',
    'Tennis', 'Golf', 'Motorsport', 'Fighting', 'Wrestling', 'Rugby', 'Cricket', 'Darts', 'Snooker', 'Cycling', 'Horse Racing'];
const CATEGORY_RULES = [
    ['Field Hockey', /field hockey/i],
    ['Horse Racing', /horse|thoroughbred|breeders|keeneland|racecourse|raceday|\bracing tv\b/i],
    ['Soccer', /soccer|f[uú]tbol|futsal|premier league|\befl\b|la ?liga|serie a|bundesliga|ligue 1|eredivisie|\bmls\b|\bnwsl\b|concacaf|uefa|fifa|champions league|europa league|nations league|copa\b|live football|liga mx|primera divisi/i],
    ['Football', /football|\bnfl\b|\bncaaf\b|\bcfl\b/i],
    ['Basketball', /basketball|baloncesto|\bnba\b|\bwnba\b|\bncaab\b/i],
    ['Baseball', /baseball|b[eé]isbol|\bmlb\b/i],
    ['Hockey', /hockey|\bnhl\b/i],
    ['Volleyball', /volleyball/i],
    ['Lacrosse', /lacrosse/i],
    ['Tennis', /tennis|\batp\b|\bwta\b|padel/i],
    ['Golf', /\bgolf\b|\bpga\b|\blpga\b|liv golf/i],
    ['Darts', /darts/i],
    ['Motorsport', /formula (?:1|2|3|e)|\bf1\b|motogp|moto2|moto3|nascar|indycar|\bimsa\b|grand prix|rally|\bwrc\b|supercars|motocross|supercross|\bracing\b|\bbmx\b|sprint cars?|world of outlaws|\barca\b|off[- ]?road|late models?|speedway/i],
    ['Fighting', /\bufc\b|\bmma\b|boxing|bare knuckle|\bbkfc\b|\bpfl\b|\bfights?\b|fight night|bellator|kickboxing|muay thai|\bbjj\b/i],
    ['Wrestling', /wrestling|\baew\b|\bwwe\b/i],
    ['Rugby', /rugby/i],
    ['Cricket', /cricket|\bodi\b|\bt20\b/i],
    ['Snooker', /snooker/i],
    ['Cycling', /cycling|\buci\b|tour de /i]
];

const FC_SIDE = /(?:^|\s)fc$|^fc\s/i;

function categoryOf(e) {
    if (e.category !== undefined) return e.category;
    const text = [e.sport, e.league, e.programme, e.title, ...(e.sources || [])].filter(Boolean).join(' | ');
    const hit = CATEGORY_RULES.find(([, re]) => re.test(text));
    if (hit) e.category = hit[0];
    else e.category = matchupOf(e.title)?.teams.some(t => FC_SIDE.test(t)) ? 'Soccer' : null;
    return e.category;
}

// Events ESPN doesn't list are scored from their sport, network and channel group, below most ESPN games.
const CATEGORY_IMPORTANCE = {
    Football: 15, Fighting: 15, Basketball: 12, Baseball: 12, Motorsport: 12, Hockey: 10, Soccer: 10,
    Golf: 8, Tennis: 8, Rugby: 8, Cricket: 8, Darts: 5, Wrestling: 5, Snooker: 4, Cycling: 4,
    'Horse Racing': 4, Lacrosse: 3, Volleyball: 3, 'Field Hockey': 2
};
const MAJOR_NETWORK_RE = /^(?:ABC|CBS|NBC|FOX|ESPN2?|TNT|TBS|TRU ?TV|FS1|USA)(?:\s|$)|^sky sports main event$|^tnt sports 1$/i;
const PPV_SOURCE_RE = /^(?!.*\bMAX\b).*\bPPV\b/i;
const NFL_SOURCE_RE = /^NFL$/i;
const LOW_SOURCE_RE = /^FLO\b/i;
const HEADLINE_EVENT_RE = /\bUFC \d{3}\b|\bformula (?:1|one)\b|\bF1\b(?! academy)/i;
const STUDIO_TITLE_RE = /\b(?:scoreboard|halftime|huddle|band performances?|warm-?ups?|highlights?|countdown|pre-?game|post-?game|studio|press conference|weigh-?ins?)\b|\b(?:live|today|tonight|center|centre)\s*$/i;

function importanceOf(e) {
    if (e.importance !== undefined) return e.importance;
    let score = CATEGORY_IMPORTANCE[categoryOf(e)] || 0;
    if (e.network && MAJOR_NETWORK_RE.test(e.network)) score += 8;
    if (e.sources.some(s => PPV_SOURCE_RE.test(s))) score += 15;
    if (e.sources.some(s => NFL_SOURCE_RE.test(s))) score += 20;
    if (HEADLINE_EVENT_RE.test(e.title)) score += 20;
    if (e.sources.length && e.sources.every(s => LOW_SOURCE_RE.test(s))) score -= 10;
    if (STUDIO_TITLE_RE.test(e.programme || e.title)) score -= 20;
    e.importance = score;
    return score;
}

function liveRank(e) {
    return importanceOf(e) + (e.liveBoost || 0);
}

function matchesGenre(e, genre, includeAssumed) {
    if (!genre) return !e.assumedDay || includeAssumed;
    if (SPORT_CATEGORIES.includes(genre)) return categoryOf(e) === genre && (!e.assumedDay || includeAssumed);
    return e.sources.includes(genre);
}

function dayBounds(now, zone = 'America/New_York') {
    const { y, mo, d } = zonedParts(zone, now);
    const start = zonedToUtc(zone, y, mo, d, 0, 0);
    const end = zonedToUtc(zone, y, mo, d + 1, 0, 0);
    return { start, end };
}

function currentEvents(index, now = Date.now(), { genre = null, source = null, includeAssumed = false } = {}) {
    const filter = genre || source;
    const live = [];
    const soon = [];
    for (const e of index.values()) {
        if (!matchesGenre(e, filter, includeAssumed)) continue;
        const s = eventState(e, now);
        if (s === 'live') live.push(e);
        else if (s === 'soon') soon.push(e);
    }
    live.sort((a, b) => liveRank(b) - liveRank(a) || b.start - a.start || a.title.localeCompare(b.title));
    soon.sort((a, b) => a.start - b.start || importanceOf(b) - importanceOf(a) || a.title.localeCompare(b.title));
    return [...live, ...soon];
}

function todayEvents(index, now = Date.now(), { genre = null, includeAssumed = false, zone = 'America/New_York' } = {}) {
    const { start, end } = dayBounds(now, zone);
    const out = [];
    for (const e of index.values()) {
        if (e.final || e.end <= now || e.start >= end || e.start < start - 12 * 3600000) continue;
        if (!matchesGenre(e, genre, includeAssumed)) continue;
        out.push(e);
    }
    return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

module.exports = { isRaceReplay, parseEventSlot, buildEventIndex, currentEvents, todayEvents, eventState, eventCardUrl, cardTitleFor, findGame, applyLiveActivity, categoryOf, importanceOf, titleCase, sourceLabel, programmeVerdict, broadcastNetworkOf, isNationalFeed, isNorthAmerican, SPORT_CATEGORIES };
