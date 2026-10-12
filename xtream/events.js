const crypto = require("crypto");
const { currentEvents, eventState } = require("../liveEvents");

const LIVE_NOW = "Live Now";
const EVENT_BASE = 1_000_000_000;
const EVENT_SPAN = 2 ** 27;
const MEMBERS_MAX = 15;

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

/**
 * The pool's live and upcoming events (the Stremio "Live Now" list) as virtual channels for the
 * Xtream login. Each one plays the event's ranked channels in order, so the usual failover walks
 * through them. Channels outside the login's [countries] are left out, and an event with none left
 * is dropped. The guide id is the first ranked channel that has guide data, so the guide shows
 * what that channel is airing.
 */
function buildEvents(pool, { countries = [], categoryId, tileCountry, now = Date.now() }) {
  const wanted = countries.length ? new Set(countries) : null;
  const entries = [];
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
      num: entries.length + 1,
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
    entries.push({ stream, tile, epgKey });
    byStreamId.set(id, tile);
  }
  return { entries, byStreamId };
}

module.exports = { buildEvents, eventNumber, interleave, LIVE_NOW, EVENT_BASE };
