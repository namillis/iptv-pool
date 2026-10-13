const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");
const express = require("express");
const { clientIp, isLockedOut, recordFailure, clearFailures } = require("../siteAuth");
const { XtreamIds } = require("./ids");
const { buildEvents, LIVE_NOW } = require("./events");
const { Playback, memberUrl, convertStart } = require("./playback");
const LRUCache = require("../lruCache");

const COUNTRY_RE = /^[A-Z]{2,3}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const GUIDE_MIN_AGE_MS = 15 * 60 * 1000;
const EMPTY_LIST_ACTIONS = new Set([
  "get_vod_categories",
  "get_vod_streams",
  "get_series_categories",
  "get_series",
]);
const EMPTY_OBJECT_ACTIONS = new Set(["get_vod_info", "get_series_info"]);
const API_PER_MIN = 60;
const STREAMS_PER_MIN = 30;
const STATUS_WAIT_MS = 4000;
const STATUS_REFRESH_MS = 30 * 1000;
const TABLE_TTL_MS = 5 * 60 * 1000;
const TABLE_TIMEOUT_MS = 6000;
const TABLE_CONCURRENCY = 2;
const LIVE_FILE_RE = /^(\d{1,10})\.(ts|m3u8)$/;
const ARCHIVE_FILE_RE = /^(\d{1,9})\.(ts|m3u8)$/;
const DURATION_RE = /^\d{1,4}$/;
const EVENTS_TTL_MS = 60 * 1000;
const LIVE_NOW_KEY = "\u0000LIVE NOW";
const HOME_KEY = "\u0000HOME|";
const POOL_API_VERSION = 1;
const POOL_FEATURES = ["retry", "stop", "sources", "event_info"];
const ATTEMPT_RE = /^\d{1,3}$/;
const SOURCE_RE = /^[a-z0-9]{1,8}\.[A-Za-z0-9_-]{1,40}$/;

/**
 * `try=N` (and `why=refused`) on a live URL, from an app that reports its attempts, plus
 * `source=` when the user picked a stream in the app; else null.
 */
function playbackSignal(query) {
  const t = query.try;
  if (typeof t !== "string" || !ATTEMPT_RE.test(t)) return null;
  const source = typeof query.source === "string" && SOURCE_RE.test(query.source) ? query.source : null;
  return { attempt: Number(t), refused: query.why === "refused", source };
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function loadUsers(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw.users) || !raw.users.length) throw new Error('"users" must be a non-empty list');
  const seen = new Set();
  return raw.users.map((u, i) => {
    if (!u || typeof u !== "object") throw new Error(`users[${i}] must be an object`);
    const username = String(u.username || "");
    if (!USERNAME_RE.test(username)) throw new Error(`users[${i}].username must be 1-64 letters, digits, . _ or -`);
    if (seen.has(username)) throw new Error(`Username "${username}" is used twice`);
    seen.add(username);
    if (typeof u.password !== "string" || u.password.length < 12)
      throw new Error(`User "${username}" needs a password of at least 12 characters`);
    const countries = (u.countries || []).map((c) => String(c).toUpperCase());
    for (const c of countries) if (!COUNTRY_RE.test(c)) throw new Error(`User "${username}" has an invalid country "${c}"`);
    const maxConnections = Number(u.maxConnections || 1);
    if (!Number.isInteger(maxConnections) || maxConnections < 1)
      throw new Error(`User "${username}" maxConnections must be a positive whole number`);
    return {
      username,
      passwordDigest: digest(u.password),
      maxConnections,
      countries: [...new Set(countries)].sort(),
      createdAt: Math.floor(Date.now() / 1000),
    };
  });
}

function tileCountry(key) {
  const prefix = key.slice(0, key.indexOf("|"));
  return prefix === "CALL" ? "US" : prefix;
}

function epgChannelId(epgKey) {
  return epgKey ? epgKey.replace("/", ".") : "";
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function xmltvTime(seconds) {
  const d = new Date(seconds * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

function panelTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The home lineup from xtream/home.json: categories of hand-picked channels (by tile key, most
 * watched first) that go ahead of the provider's own, for logins that include [country]. Each
 * key may appear once, since a channel can only be in one category.
 */
function loadHome(raw) {
  const country = String(raw?.country || "").toUpperCase();
  if (!COUNTRY_RE.test(country)) throw new Error('home "country" must be a country code');
  if (!Array.isArray(raw.categories)) throw new Error('home "categories" must be a list');
  const slots = new Map();
  const categories = raw.categories.map((c, i) => {
    const name = String(c?.name || "").trim();
    if (!name) throw new Error(`home categories[${i}] needs a name`);
    if (!Array.isArray(c.keys)) throw new Error(`home category "${name}" needs a "keys" list`);
    c.keys.forEach((key, rank) => {
      if (slots.has(key)) throw new Error(`home key "${key}" is listed twice`);
      slots.set(key, { category: i, rank });
    });
    return { name, size: c.keys.length };
  });
  return { country, categories, slots };
}

const HOME = loadHome(require("./home.json"));

function buildView(pool, ids, countries, home = HOME) {
  const wanted = countries.length ? new Set(countries) : null;
  const curated = home && (!wanted || wanted.has(home.country)) ? home : null;
  const streamIds = ids.assignStreams(pool.channels);
  const homeLists = curated
    ? curated.categories.map((c) => ({ id: ids.categoryId(HOME_KEY + c.name), name: c.name, list: new Array(c.size) }))
    : [];
  const provider = [];
  const byCategory = new Map();
  const entries = [];
  const byStreamId = new Map();
  for (const tile of pool.channels) {
    const country = tileCountry(tile._key);
    if (wanted && !wanted.has(country)) continue;
    const groups = tile._groups.length ? tile._groups : ["Other"];
    let catIds = groups.map((g) => ids.categoryId(g));
    const slot = curated && curated.slots.get(tile._key);
    const categoryId = slot ? homeLists[slot.category].id : catIds[0];
    if (slot) catIds = [categoryId, ...catIds];
    const epgKey = tile._epg && pool.epgData[tile._epg]?.length ? tile._epg : null;
    const stream = {
      num: 0,
      name: tile.name,
      stream_type: "live",
      stream_id: streamIds.get(tile),
      stream_icon: tile.logo || "",
      epg_channel_id: epgChannelId(epgKey),
      added: "0",
      is_adult: "0",
      category_id: String(categoryId),
      category_ids: catIds,
      custom_sid: "",
      tv_archive: tile._catchup ? 1 : 0,
      tv_archive_duration: tile._catchup ? tile.archiveDays || 1 : 0,
      direct_source: "",
    };
    entries.push({ stream, tile, epgKey });
    byStreamId.set(stream.stream_id, tile);
    if (slot) {
      homeLists[slot.category].list[slot.rank] = stream;
      continue;
    }
    let group = byCategory.get(categoryId);
    if (!group) {
      byCategory.set(categoryId, (group = { id: categoryId, name: groups[0], list: [], home: 0 }));
      provider.push(group);
    }
    group.list.push(stream);
    if (curated && country === curated.country) group.home++;
  }
  const ordered = homeLists.map((c) => ({ ...c, list: c.list.filter(Boolean) })).filter((c) => c.list.length);
  if (curated) {
    const isHome = (g) => g.home * 2 > g.list.length;
    ordered.push(...provider.filter(isHome), ...provider.filter((g) => !isHome(g)));
  } else {
    ordered.push(...provider);
  }
  const gz = (value) => zlib.gzipSync(JSON.stringify(value));
  const categories = ordered.map((c) => ({ category_id: String(c.id), category_name: c.name, parent_id: 0 }));
  const streamList = [];
  const categoryStreams = new Map();
  for (const c of ordered) {
    for (const s of c.list) s.num = streamList.push(s);
    categoryStreams.set(String(c.id), gz(c.list));
  }
  return {
    channels: pool.channels,
    builtAt: Date.now(),
    count: streamList.length,
    entries,
    byStreamId,
    homeCountry: curated ? curated.country : null,
    categoryList: categories,
    streamList,
    categoriesGz: gz(categories),
    streamsGz: gz(streamList),
    categoryStreams,
    live: null,
    guide: null,
    guideBuild: null,
  };
}

/**
 * The Live Now layer on top of [view]: the current events as a first category, rebuilt at most
 * every [EVENTS_TTL_MS] because events start, end and change state through the day. When there
 * are no events, the responses are the view's own.
 */
function buildLive(pool, ids, view, countries, now = Date.now()) {
  const categoryId = ids.categoryId(LIVE_NOW_KEY);
  let events = { entries: [], byStreamId: new Map() };
  if (typeof pool.liveEventIndex === "function") {
    try {
      events = buildEvents(pool, { countries, categoryId, tileCountry, homeCountry: view.homeCountry, now });
    } catch (e) {
      console.error(`[XTREAM] Live Now failed: ${e.message}`);
    }
  }
  if (!events.entries.length) {
    return { at: now, count: 0, byStreamId: events.byStreamId, categoryId: String(categoryId), categoriesGz: view.categoriesGz, streamsGz: view.streamsGz, eventsGz: null };
  }
  const gz = (value) => zlib.gzipSync(JSON.stringify(value));
  const list = events.entries.map((e) => e.stream);
  return {
    at: now,
    count: list.length,
    byStreamId: events.byStreamId,
    categoryId: String(categoryId),
    categoriesGz: gz([{ category_id: String(categoryId), category_name: LIVE_NOW, parent_id: 0 }, ...view.categoryList]),
    streamsGz: gz([...list, ...view.streamList]),
    eventsGz: gz(list),
  };
}

async function buildGuide(view, epgData) {
  const gzip = zlib.createGzip();
  const chunks = [];
  gzip.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  const write = async (text) => {
    if (!gzip.write(text)) await new Promise((r) => gzip.once("drain", r));
  };
  const channels = new Map();
  for (const { tile, epgKey } of view.entries) if (epgKey && !channels.has(epgKey)) channels.set(epgKey, tile);
  let programmes = 0;
  let rawBytes = 0;
  const out = async (text) => {
    rawBytes += Buffer.byteLength(text);
    await write(text);
  };
  await out('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="iptv-pool">\n');
  for (const [epgKey, tile] of channels) {
    const id = xmlEscape(epgChannelId(epgKey));
    const icon = tile.logo ? `<icon src="${xmlEscape(tile.logo)}"/>` : "";
    await out(`<channel id="${id}"><display-name>${xmlEscape(tile.name)}</display-name>${icon}</channel>\n`);
  }
  for (const epgKey of channels.keys()) {
    const id = xmlEscape(epgChannelId(epgKey));
    const parts = [];
    for (const p of epgData[epgKey] || []) {
      let xml = `<programme start="${xmltvTime(p.s)}" stop="${xmltvTime(p.e)}" channel="${id}"><title>${xmlEscape(p.t)}</title>`;
      if (p.st) xml += `<sub-title>${xmlEscape(p.st)}</sub-title>`;
      if (p.d) xml += `<desc>${xmlEscape(p.d)}</desc>`;
      if (p.c) for (const c of p.c) xml += `<category>${xmlEscape(c)}</category>`;
      if (p.l) xml += "<live/>";
      if (p.r) xml += "<previously-shown/>";
      parts.push(xml + "</programme>\n");
      programmes++;
    }
    if (parts.length) await out(parts.join(""));
  }
  await out("</tv>\n");
  gzip.end();
  await done;
  const body = Buffer.concat(chunks);
  const etag = `"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 20)}"`;
  return { body, etag, rawBytes, programmes, channels: channels.size, epgData, builtAt: Date.now() };
}

function sendGzip(req, res, body, type) {
  res.setHeader("Content-Type", type);
  res.setHeader("Vary", "Accept-Encoding");
  if (/\bgzip\b/.test(req.get("accept-encoding") || "")) {
    res.setHeader("Content-Encoding", "gzip");
    return res.end(body);
  }
  return res.end(zlib.gunzipSync(body));
}

function createXtreamRouter({ usersFile, idsFile, getPool, log = console, fetchImpl = require("node-fetch"), now = Date.now }) {
  const users = new Map(loadUsers(usersFile).map((u) => [u.username, u]));
  const ids = new XtreamIds(idsFile, { log });
  const views = new Map();
  const playback = new Playback({ now });
  const rates = new Map();
  const tables = new LRUCache({ max: 300, ttl: TABLE_TTL_MS });
  let tablesInFlight = 0;
  const tableQueue = [];
  let statusPromise = null;
  let statusRefreshedAt = 0;

  function authenticate(req, creds) {
    const src = creds || { ...(req.body || {}), ...req.query };
    const username = typeof src.username === "string" ? src.username : "";
    const password = typeof src.password === "string" ? src.password : "";
    const ip = clientIp(req);
    const now = Date.now();
    if (isLockedOut(ip, now)) return { locked: true };
    const user = users.get(username);
    const given = digest(password);
    const ok = user ? crypto.timingSafeEqual(given, user.passwordDigest) : false;
    if (!ok) {
      recordFailure(ip, now);
      return { user: null };
    }
    clearFailures(ip);
    return { user, password };
  }

  async function poolFor() {
    const iface = await getPool();
    iface.touch();
    iface.pool.updateData().catch(() => {});
    return iface.pool;
  }

  function viewFor(pool, user) {
    const profile = user.countries.join(",");
    let view = views.get(profile);
    if (!view || view.channels !== pool.channels) {
      const start = Date.now();
      const prev = view;
      view = buildView(pool, ids, user.countries);
      if (prev) view.guide = prev.guide;
      views.set(profile, view);
      log.log(`[XTREAM] View "${profile || "all"}": ${view.count} channels, streams ${view.streamsGz.length} bytes gzipped, ${Date.now() - start} ms`);
    }
    return view;
  }

  function liveFor(pool, view, user) {
    const now = Date.now();
    if (!view.live || now - view.live.at >= EVENTS_TTL_MS) {
      view.live = buildLive(pool, ids, view, user.countries, now);
      if (view.live.count) log.log(`[XTREAM] Live Now "${user.countries.join(",") || "all"}": ${view.live.count} events, ${Date.now() - now} ms`);
    }
    return view.live;
  }

  async function guideFor(pool, view, profile) {
    const stale = !view.guide || (view.guide.epgData !== pool.epgData && Date.now() - view.guide.builtAt > GUIDE_MIN_AGE_MS);
    if (stale && !view.guideBuild) {
      const start = Date.now();
      view.guideBuild = buildGuide(view, pool.epgData)
        .then((g) => {
          view.guide = g;
          log.log(`[XTREAM] Guide "${profile || "all"}": ${g.channels} channels, ${g.programmes} programmes, ${g.rawBytes} bytes raw, ${g.body.length} gzipped, ${Date.now() - start} ms`);
          return g;
        })
        .finally(() => {
          view.guideBuild = null;
        });
    }
    if (view.guide) return view.guide;
    return view.guideBuild;
  }

  function overLimit(user, kind, limit) {
    const now = Date.now();
    const key = `${user.username}:${kind}`;
    let w = rates.get(key);
    if (!w || now - w.start >= 60000) rates.set(key, (w = { start: now, count: 0 }));
    return ++w.count > limit;
  }

  function tooMany(res) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests" });
  }

  function refreshStatus(pool) {
    if (!statusPromise) {
      statusPromise = pool.accountStatus().finally(() => {
        statusPromise = null;
      });
      statusPromise.catch(() => {});
    }
    return statusPromise;
  }

  async function accountStatus(pool, { fresh = false } = {}) {
    const cached = pool.accounts;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (fresh && age > STATUS_REFRESH_MS && Date.now() - statusRefreshedAt > STATUS_REFRESH_MS && !statusPromise) {
      statusRefreshedAt = Date.now();
      pool.accounts = null;
    } else if (cached) {
      if (age >= 5 * 60 * 1000) refreshStatus(pool);
      return cached.byId;
    }
    const timeout = new Promise((resolve) => setTimeout(resolve, STATUS_WAIT_MS).unref());
    const got = await Promise.race([refreshStatus(pool).catch(() => null), timeout]);
    return got || (cached ? cached.byId : null);
  }

  function xtreamChild(pool, member) {
    const child = pool.childById.get(member._pid);
    if (!child || child.providerName !== "xtream") return null;
    const { xtreamUrl, xtreamUsername, xtreamPassword } = child.config;
    return { child, base: xtreamUrl, user: xtreamUsername, pass: xtreamPassword, src: String(member._src).replace(/^iptv_live_/, "") };
  }

  function enc(v) {
    return encodeURIComponent(v);
  }

  async function limited(fn) {
    if (tablesInFlight >= TABLE_CONCURRENCY) await new Promise((r) => tableQueue.push(r));
    tablesInFlight++;
    try {
      return await fn();
    } finally {
      tablesInFlight--;
      const next = tableQueue.shift();
      if (next) next();
    }
  }

  async function dataTable(pool, streamId, tile) {
    const x = tile._catchup && xtreamChild(pool, tile._catchup);
    if (!x) return { epg_listings: [] };
    const cached = tables.get(streamId);
    if (cached) return cached;
    const url = `${x.base}/player_api.php?username=${enc(x.user)}&password=${enc(x.pass)}&action=get_simple_data_table&stream_id=${enc(x.src)}`;
    try {
      const body = await limited(async () => {
        const resp = await fetchImpl(url, { timeout: TABLE_TIMEOUT_MS, headers: { "User-Agent": "IPTV pool (catchup)" } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      });
      const out = { epg_listings: Array.isArray(body?.epg_listings) ? body.epg_listings : [] };
      tables.set(streamId, out);
      return out;
    } catch (e) {
      log.error(`[XTREAM] Catch-up list from ${tile._catchup._pid} failed: ${e.message}`);
      return { epg_listings: [] };
    }
  }

  async function lookup(req, res, creds, streamId) {
    const auth = authenticate(req, creds);
    if (auth.locked) {
      lockedOut(res);
      return null;
    }
    if (!auth.user) {
      res.status(401).json({ error: "Invalid login" });
      return null;
    }
    if (overLimit(auth.user, "stream", STREAMS_PER_MIN)) {
      tooMany(res);
      return null;
    }
    let pool;
    try {
      pool = await poolFor();
    } catch (e) {
      log.error(`[XTREAM] Pool unavailable: ${e.message}`);
      res.status(503).json({ error: "Pool unavailable" });
      return null;
    }
    const view = viewFor(pool, auth.user);
    const tile = view.byStreamId.get(streamId) || liveFor(pool, view, auth.user).byStreamId.get(streamId);
    if (!tile) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return { user: auth.user, pool, tile };
  }

  function redirect(res, url) {
    res.setHeader("Location", url);
    return res.status(302).end();
  }

  function lockedOut(res) {
    res.setHeader("Retry-After", "900");
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "8kb" }));
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.all("/player_api.php", async (req, res) => {
    const auth = authenticate(req);
    if (auth.locked) return lockedOut(res);
    if (!auth.user) return res.json({ user_info: { auth: 0 } });
    const { user, password } = auth;
    if (overLimit(user, "api", API_PER_MIN)) return tooMany(res);
    const action = String(req.query.action || req.body?.action || "");

    if (!action) {
      const now = Date.now();
      const proto = (req.get("x-forwarded-proto") || req.protocol).split(",")[0];
      const port = proto === "https" ? "443" : "80";
      return res.json({
        user_info: {
          username: user.username,
          password,
          message: "",
          auth: 1,
          status: "Active",
          exp_date: null,
          is_trial: "0",
          active_cons: String(playback.activeCount(user.username)),
          created_at: String(user.createdAt),
          max_connections: String(user.maxConnections),
          allowed_output_formats: ["ts", "m3u8"],
        },
        server_info: {
          url: req.hostname,
          port,
          https_port: "443",
          server_protocol: proto,
          rtmp_port: "0",
          timezone: "UTC",
          timestamp_now: Math.floor(now / 1000),
          time_now: panelTime(now),
        },
      });
    }
    if (EMPTY_LIST_ACTIONS.has(action)) return res.json([]);
    if (EMPTY_OBJECT_ACTIONS.has(action)) return res.json({});
    if (action === "pool_info") return res.json({ pool: 1, version: POOL_API_VERSION, features: POOL_FEATURES });
    if (action === "pool_stop") {
      const raw = req.query.stream_id ?? req.body?.stream_id;
      const streamId = raw === undefined || raw === "" ? null : Number(raw);
      if (streamId !== null && !Number.isInteger(streamId)) return res.status(400).json({ error: "Bad stream_id" });
      const released = playback.stop(user.username, streamId);
      if (released) log.log(`[XTREAM] ${user.username} stopped ${streamId ?? "all"} (${released} released)`);
      return res.json({ ok: 1, released });
    }

    let pool;
    try {
      pool = await poolFor();
    } catch (e) {
      log.error(`[XTREAM] Pool unavailable: ${e.message}`);
      return res.status(503).json({ error: "Pool unavailable" });
    }
    const view = viewFor(pool, user);
    const json = "application/json; charset=utf-8";

    if (action === "get_live_categories") return sendGzip(req, res, liveFor(pool, view, user).categoriesGz, json);
    if (action === "get_live_streams") {
      const live = liveFor(pool, view, user);
      const cat = req.query.category_id ?? req.body?.category_id;
      if (cat === undefined || cat === "" || cat === "*") return sendGzip(req, res, live.streamsGz, json);
      if (String(cat) === live.categoryId) return live.eventsGz ? sendGzip(req, res, live.eventsGz, json) : res.json([]);
      const body = view.categoryStreams.get(String(cat));
      return body ? sendGzip(req, res, body, json) : res.json([]);
    }
    if (action === "pool_sources") {
      const streamId = Number(req.query.stream_id ?? req.body?.stream_id);
      const tile = view.byStreamId.get(streamId) || liveFor(pool, view, user).byStreamId.get(streamId);
      if (!tile) return res.json({ sources: [] });
      const nameOf = (pid) => pool.childById.get(pid)?.poolName || pid;
      return res.json({ sources: playback.sources(user.username, streamId, tile, nameOf) });
    }
    if (action === "get_simple_data_table") {
      const streamId = Number(req.query.stream_id ?? req.body?.stream_id);
      const tile = view.byStreamId.get(streamId);
      return res.json(tile ? await dataTable(pool, streamId, tile) : { epg_listings: [] });
    }
    if (action === "get_short_epg") return res.json({ epg_listings: [] });
    return res.json([]);
  });

  router.get("/xmltv.php", async (req, res) => {
    const auth = authenticate(req);
    if (auth.locked) return lockedOut(res);
    if (!auth.user) return res.status(401).json({ error: "Invalid login" });
    let guide;
    try {
      const pool = await poolFor();
      const view = viewFor(pool, auth.user);
      guide = await guideFor(pool, view, auth.user.countries.join(","));
    } catch (e) {
      log.error(`[XTREAM] Guide failed: ${e.message}`);
      return res.status(503).json({ error: "Guide unavailable" });
    }
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    res.setHeader("ETag", guide.etag);
    res.setHeader("Last-Modified", new Date(guide.builtAt).toUTCString());
    if (req.fresh) return res.status(304).end();
    return sendGzip(req, res, guide.body, "application/xml; charset=utf-8");
  });

  router.get("/live/:u/:p/:file", async (req, res) => {
    const m = req.params.file.match(LIVE_FILE_RE);
    if (!m) return res.status(404).json({ error: "Not found" });
    const streamId = Number(m[1]);
    const ext = m[2];
    const found = await lookup(req, res, { username: req.params.u, password: req.params.p }, streamId);
    if (!found) return;
    const { user, pool, tile } = found;
    let status = await accountStatus(pool);
    if (playback.firstChoiceFull(user, streamId, tile, status)) status = await accountStatus(pool, { fresh: true });
    const pick = playback.live(user, streamId, tile, ext, status, playbackSignal(req.query));
    const url = pick && memberUrl(pick.member, ext);
    if (!url) return res.status(404).json({ error: "Not found" });
    log.log(`[XTREAM] ${user.username} live ${streamId} "${tile.name}" -> ${pick.member._pid} (${pick.reason})`);
    return redirect(res, url);
  });

  async function archive(req, res, creds, streamId, duration, start, form, ext) {
    if (!DURATION_RE.test(String(duration))) return res.status(400).json({ error: "Bad duration" });
    const found = await lookup(req, res, creds, streamId);
    if (!found) return;
    const { user, pool, tile } = found;
    const x = tile._catchup && xtreamChild(pool, tile._catchup);
    if (!x) return res.status(404).json({ error: "No archive" });
    const status = await accountStatus(pool);
    const zone = status?.get(tile._catchup._pid)?.serverTimezone || "UTC";
    const local = convertStart(start, zone);
    if (!local) return res.status(400).json({ error: "Bad start" });
    playback.archive(user, streamId, tile._catchup);
    log.log(`[XTREAM] ${user.username} archive ${streamId} "${tile.name}" -> ${tile._catchup._pid} (${form}, ${zone})`);
    if (form === "path")
      return redirect(res, `${x.base}/timeshift/${enc(x.user)}/${enc(x.pass)}/${duration}/${local}/${enc(x.src)}.${ext}`);
    return redirect(res, `${x.base}/streaming/timeshift.php?username=${enc(x.user)}&password=${enc(x.pass)}&stream=${enc(x.src)}&start=${enc(local)}&duration=${duration}`);
  }

  router.get("/timeshift/:u/:p/:dur/:start/:file", (req, res) => {
    const m = req.params.file.match(ARCHIVE_FILE_RE);
    if (!m) return res.status(404).json({ error: "Not found" });
    return archive(req, res, { username: req.params.u, password: req.params.p }, Number(m[1]), req.params.dur, req.params.start, "path", m[2]);
  });

  router.get("/streaming/timeshift.php", (req, res) => {
    const q = req.query;
    const streamId = Number(q.stream);
    if (!Number.isInteger(streamId)) return res.status(404).json({ error: "Not found" });
    return archive(req, res, { username: q.username, password: q.password }, streamId, q.duration, q.start, "php", "ts");
  });

  router.flush = () => ids.flush();
  return router;
}

module.exports = { createXtreamRouter, loadUsers, loadHome, buildView, buildGuide, tileCountry, xmltvTime, xmlEscape };
