const crypto = require("crypto");
const { currentEvents, eventState, categoryOf } = require("../liveEvents");

const LIVE_NOW = "Live Now";
const EVENT_BASE = 1_000_000_000;
const EVENT_SPAN = 2 ** 27;
const MEMBERS_MAX = 15;
const TEXT_MAX = 400;
const LIVE_PREFIX_RE = /^\s*(?:live|en vivo|en directo|direct|ao vivo)\s*[:\-–|]\s*/i;
const MATCHUP_RE = /\s(?:vs\.?|v\.?|@|x)\s/i;

/**
 * A stream number for an event, from its id so it stays the same while the event is listed.
 * Events come and go every day, so these aren't kept in the ID map; they live in their own range
 * above every channel number, and [taken] resolves the rare clash within one listing.
 */
function eventNumber(eventId, taken) {
  let n = EVENT_BASE + (parseInt(crypto.createHash("sha1").update(eventId).digest("hex").slice(0, 8), 16) % EVENT_SPAN);
  while (taken.has(n)) n = n + 1 >= EVENT_BASE + EVENT_SPAN ? EVENT_BASE : n + 1;
  return n;
}

/** Each channel's first member, then each channel's second, and so on, up to [max], without repeats. */
function interleave(lists, max) {
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < max; i++) {
    let any = false;
    for (const list of lists) {
      const m = list[i];
      if (!m) continue;
      any = true;
      const key = `${m._pid}/${m._src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
      if (out.length >= max) break;
    }
    if (!any) break;
  }
  return out;
}

function listOf(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
}

function clip(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1).trimEnd()}…` : t;
}

/** "Bills (4-1) at Rams (2-3). SoFi Stadium, Inglewood, CA. On ESPN and ABC." No scores, so nothing is spoiled. */
function gameDescription(info) {
  const [away, home] = info.short || [];
  if (!away || !home) return null;
  const [ra, rh] = info.records || [];
  const side = (name, rec) => (rec ? `${name} (${rec})` : name);
  const parts = [
    info.soccer
      ? `${side(home, rh)} vs ${side(away, ra)}`
      : `${side(away, ra)} ${info.neutral ? "vs" : "at"} ${side(home, rh)}`,
  ];
  if (info.venue) parts.push(info.venue);
  if (info.tv && info.tv.length) parts.push(`On ${listOf(info.tv.slice(0, 3))}`);
  return `${parts.join(". ")}.`;
}

/** A guide or league title without a "Live:" lead-in or the matchup after a colon ("Boxing : A vs. B" is "Boxing"). */
function programmeName(text) {
  const t = String(text || "").replace(LIVE_PREFIX_RE, "").trim();
  const m = t.match(/^(.+?)\s*:\s+(.+)$/);
  return m && MATCHUP_RE.test(` ${m[2]} `) ? m[1] : t;
}

/**
 * What the app shows for an event instead of the guide of the channel it borrows (`event_info`).
 * An ESPN game gets its league and round, and the teams, venue and networks. Anything else gets its
 * league or programme name, and the description of the guide listing it was found in. Null when the
 * event has no usable time span.
 */
function poolEvent(e) {
  const start = Math.floor(e.start / 1000);
  const end = Math.ceil(e.end / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const category = categoryOf(e);
  let title;
  let description = null;
  if (e.info && e.info.league) {
    title = e.info.round ? `${e.info.league} · ${e.info.round}` : e.info.league;
    description = gameDescription(e.info);
  } else {
    const guide = e.guide || {};
    const named = [e.league, e.programme, guide.t].map(programmeName).find(Boolean);
    title = named || category || e.network || "Live event";
    description = guide.d || (guide.st && !e.title.includes(guide.st) ? guide.st : null);
  }
  const out = { title: clip(title), start, end };
  if (description) out.description = clip(description);
  if (category) out.category = category;
  return out;
}

/**
 * The pool's live and upcoming events (the Stremio "Live Now" list) as virtual channels for the
 * Xtream login. Each one plays the event's ranked channels in order, so the usual failover walks
 * through them. Channels outside the login's [countries] are left out, and an event with none left
 * is dropped. The guide id is the first ranked channel that has guide data, so the guide shows
 * what that channel is airing. With a [homeCountry], events on one of its channels come first.
 */
function buildEvents(pool, { countries = [], categoryId, tileCountry, homeCountry = null, now = Date.now() }) {
  const wanted = countries.length ? new Set(countries) : null;
  const entries = [];
  const away = [];
  const byStreamId = new Map();
  const taken = new Set();
  for (const e of currentEvents(pool.liveEventIndex(), now)) {
    const tiles = pool.eventChannels(e)
      .map((ch) => pool.tileById.get(ch.id))
      .filter((t) => t && (!wanted || wanted.has(tileCountry(t._key))));
    if (!tiles.length) continue;
    const members = interleave(tiles.map((t) => t._primary || t._members), MEMBERS_MAX);
    if (!members.length) continue;
    const guided = tiles.find((t) => t._epg && pool.epgData[t._epg]?.length);
    const live = eventState(e, now) === "live";
    const name = live ? e.title : `${e.title} · ${pool.formatEventTime(e.start, now)}`;
    const id = eventNumber(e.id, taken);
    taken.add(id);
    const epgKey = guided ? guided._epg : null;
    const tile = {
      _key: `EVENT|${e.id}`,
      name,
      logo: tiles.find((t) => t.logo)?.logo || null,
      _members: members,
      _primary: members,
      _groups: [LIVE_NOW],
      _epg: epgKey,
      _catchup: null,
      archiveDays: 0,
    };
    const stream = {
      num: 0,
      name,
      stream_type: "live",
      stream_id: id,
      stream_icon: tile.logo || "",
      epg_channel_id: epgKey ? epgKey.replace("/", ".") : "",
      added: "0",
      is_adult: "0",
      category_id: String(categoryId),
      category_ids: [categoryId],
      custom_sid: "",
      tv_archive: 0,
      tv_archive_duration: 0,
      direct_source: "",
    };
    const info = poolEvent(e);
    if (info) stream.pool_event = info;
    const home = !homeCountry || tiles.some((t) => tileCountry(t._key) === homeCountry);
    (home ? entries : away).push({ stream, tile, epgKey });
    byStreamId.set(id, tile);
  }
  entries.push(...away);
  entries.forEach((e, i) => { e.stream.num = i + 1; });
  return { entries, byStreamId };
}

module.exports = { buildEvents, eventNumber, interleave, poolEvent, LIVE_NOW, EVENT_BASE };
