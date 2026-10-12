const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");
const express = require("express");
const { clientIp, isLockedOut, recordFailure, clearFailures } = require("../siteAuth");
const { XtreamIds } = require("./ids");

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

function buildView(pool, ids, countries) {
  const wanted = countries.length ? new Set(countries) : null;
  const streamIds = ids.assignStreams(pool.channels);
  const categories = [];
  const byCategory = new Map();
  const streams = [];
  for (const tile of pool.channels) {
    if (wanted && !wanted.has(tileCountry(tile._key))) continue;
    const groups = tile._groups.length ? tile._groups : ["Other"];
    const catIds = groups.map((g) => ids.categoryId(g));
    const categoryId = catIds[0];
    let list = byCategory.get(categoryId);
    if (!list) {
      byCategory.set(categoryId, (list = []));
      categories.push({ category_id: String(categoryId), category_name: groups[0], parent_id: 0 });
    }
    const epgKey = tile._epg && pool.epgData[tile._epg]?.length ? tile._epg : null;
    const stream = {
      num: streams.length + 1,
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
    streams.push({ stream, tile, epgKey });
    list.push(stream);
  }
  const gz = (value) => zlib.gzipSync(JSON.stringify(value));
  const categoryStreams = new Map();
  for (const [id, list] of byCategory) categoryStreams.set(String(id), gz(list));
  return {
    channels: pool.channels,
    builtAt: Date.now(),
    count: streams.length,
    entries: streams,
    categoriesGz: gz(categories),
    streamsGz: gz(streams.map((s) => s.stream)),
    categoryStreams,
    guide: null,
    guideBuild: null,
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

function createXtreamRouter({ usersFile, idsFile, getPool, log = console }) {
  const users = new Map(loadUsers(usersFile).map((u) => [u.username, u]));
  const ids = new XtreamIds(idsFile, { log });
  const views = new Map();

  function authenticate(req) {
    const src = { ...(req.body || {}), ...req.query };
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
          active_cons: "0",
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

    let pool;
    try {
      pool = await poolFor();
    } catch (e) {
      log.error(`[XTREAM] Pool unavailable: ${e.message}`);
      return res.status(503).json({ error: "Pool unavailable" });
    }
    const view = viewFor(pool, user);
    const json = "application/json; charset=utf-8";

    if (action === "get_live_categories") return sendGzip(req, res, view.categoriesGz, json);
    if (action === "get_live_streams") {
      const cat = req.query.category_id ?? req.body?.category_id;
      if (cat === undefined || cat === "" || cat === "*") return sendGzip(req, res, view.streamsGz, json);
      const body = view.categoryStreams.get(String(cat));
      return body ? sendGzip(req, res, body, json) : res.json([]);
    }
    if (action === "get_simple_data_table" || action === "get_short_epg") return res.json({ epg_listings: [] });
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

  router.flush = () => ids.flush();
  return router;
}

module.exports = { createXtreamRouter, loadUsers, buildView, buildGuide, tileCountry, xmltvTime, xmlEscape };
