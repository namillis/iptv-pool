// Server for IPTV Stremio Addon (with debug + prefetch proxy to bypass browser CORS for pre-flight)
// Updated: Fixed prefetch stream handling (node-fetch readable stream -> chunk accumulation, no getReader()).
require("dotenv").config();

const { getRouter } = require("stremio-addon-sdk");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch");
const createAddon = require("./addon");
const { redisStatus } = createAddon;
const {
  encryptConfig,
  encryptionEnabled,
  tryParseConfigToken,
} = require("./cryptoConfig");
const { version: APP_VERSION } = require("./package.json");
const { sitePassword, sitePasswordEnabled } = require("./siteAuth");
const { fetchAccountInfo } = require("./src/js/providers/xtreamProvider");
const { createPoolAddon } = require("./providerPool");
const { createXtreamRouter } = require("./xtream/api");
const fs = require("fs");
const LRUCache = require("./lruCache");

const DEBUG = (process.env.DEBUG_MODE || "").toLowerCase() === "true";
function dlog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

const INTERFACE_TTL_MS = parseInt(
  process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(),
  10,
);
const interfaceCache = new LRUCache({
  max: parseInt(process.env.MAX_CACHE_ENTRIES || "100", 10),
  ttl: INTERFACE_TTL_MS,
});
const CACHE_ENABLED =
  (process.env.CACHE_ENABLED || "true").toLowerCase() !== "false";

const PREFETCH_EPG_MAX_BYTES = parseInt(
  process.env.PREFETCH_EPG_MAX_BYTES || "2000000",
  10,
);
const PREFETCH_MAX_BYTES = parseInt(
  process.env.PREFETCH_MAX_BYTES || "150000000",
  10,
);
const PREFETCH_ENABLED =
  (process.env.PREFETCH_ENABLED || "true").toLowerCase() !== "false";

const POOL_KEY = process.env.POOL_KEY || "";
const POOL_FILE = process.env.POOL_FILE || path.join(__dirname, "providers.json");
const POOL_ENABLED = /^[A-Za-z0-9_-]{16,}$/.test(POOL_KEY);
if (POOL_KEY && !POOL_ENABLED)
  console.warn("[POOL] Disabled: POOL_KEY must be at least 16 letters, digits, - or _");

let poolPromise = null;
function poolInterface() {
  if (!poolPromise) {
    poolPromise = createPoolAddon(POOL_FILE).catch((e) => {
      poolPromise = null;
      throw e;
    });
  }
  return poolPromise;
}

function isPoolToken(token) {
  return token.startsWith("pool-");
}

function poolKeyMatches(token) {
  if (!POOL_ENABLED) return false;
  const given = crypto.createHash("sha256").update(token.slice(5)).digest();
  const expected = crypto.createHash("sha256").update(POOL_KEY).digest();
  return crypto.timingSafeEqual(given, expected);
}

function setPublicBase(req, iface, token) {
  if (typeof iface.setPublicBase !== "function") return;
  const proto = (req.get("x-forwarded-proto") || req.protocol).split(",")[0];
  iface.setPublicBase(`${proto}://${req.get("host")}/${token}`);
}

const app = express();
const staticDir = path.join(__dirname, "src");
app.use(sitePassword());
app.use(express.static(staticDir));
app.use(express.json({ limit: "512kb" }));

app.use((req, res, next) => {
  res.setHeader("X-App", "IPTV-Stremio-Addon");
  next();
});

// Encryption endpoint
function isBlockedHost(host) {
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^\[?(::1?|f[cd][0-9a-f]{2}:|fe80:)/i.test(host)
  );
}

app.post("/api/xtream/account", async (req, res) => {
  const { xtreamUrl, username, password } = req.body || {};
  if (![xtreamUrl, username, password].every((v) => typeof v === "string" && v))
    return res.status(400).json({ error: "Panel URL, username and password are required" });
  let parsed;
  try {
    parsed = new URL(xtreamUrl);
  } catch {
    return res.status(400).json({ error: "Invalid panel URL" });
  }
  if (!/^https?:$/.test(parsed.protocol) || isBlockedHost(parsed.hostname))
    return res.status(400).json({ error: "Blocked host" });
  try {
    const info = await fetchAccountInfo(xtreamUrl.replace(/\/+$/, ""), username, password);
    res.setHeader("Cache-Control", "no-store");
    res.json(info);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "Account check failed" });
  }
});
app.post("/encrypt", (req, res) => {
  if (!process.env.CONFIG_SECRET) {
    return res
      .status(400)
      .json({
        error: "Encryption not enabled on server (CONFIG_SECRET missing)",
      });
  }
  try {
    const jsonStr = JSON.stringify(req.body || {});
    const token = encryptConfig(jsonStr);
    if (!token) return res.status(500).json({ error: "Encrypt failed" });
    res.json({ token });
  } catch {
    res.status(400).json({ error: "Invalid config payload" });
  }
});

/**
 * Prefetch endpoint: server-side fetch to bypass browser CORS for playlist / EPG pre-flight.
 * SECURITY: Basic SSRF protections included (blocks local/private networks).
 * NOTE: For production, consider a stricter allowlist or DNS/IP resolution checks.
 */
app.post("/api/prefetch", async (req, res) => {
  if (!PREFETCH_ENABLED)
    return res.status(403).json({ error: "Prefetch disabled by server" });

  const { url, purpose } = req.body || {};
  if (!url || typeof url !== "string")
    return res.status(400).json({ error: "Missing url" });
  if (!/^https?:\/\//i.test(url))
    return res.status(400).json({ error: "Only http(s) URLs allowed" });

  try {
    const u = new URL(url);
    if (isBlockedHost(u.hostname)) {
      return res.status(400).json({ error: "Blocked host" });
    }

    dlog("Prefetch start", { url, purpose });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    let fetched;
    try {
      fetched = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "IPTV-Stremio-Addon Prefetch/1.1" },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!fetched.ok) {
      dlog("Prefetch non-OK", fetched.status, url);
      return res
        .status(502)
        .json({ error: `Fetch failed (${fetched.status})` });
    }

    const maxBytes =
      purpose === "epg" ? PREFETCH_EPG_MAX_BYTES : PREFETCH_MAX_BYTES;
    const reader = fetched.body;
    const chunks = [];
    let received = 0;
    let truncated = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      reader.on("data", (chunk) => {
        if (settled) return;
        const room = maxBytes - received;
        if (chunk.length <= room) {
          chunks.push(chunk);
          received += chunk.length;
          return;
        }
        if (room > 0) chunks.push(chunk.subarray(0, room));
        received = maxBytes;
        truncated = true;
        finish();
        reader.removeAllListeners("data");
        controller.abort();
        reader.on("error", () => {});
        reader.destroy();
      });
      reader.on("end", () => finish());
      reader.on("close", () => finish());
      reader.on("error", (e) => finish(e));
    });

    let content = Buffer.concat(chunks).toString("utf8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip BOM

    dlog("Prefetch done", {
      bytes: received,
      truncated,
      returnedBytes: Buffer.byteLength(content),
    });

    res.json({
      ok: true,
      bytes: received,
      truncated,
      purpose: purpose || null,
      content,
    });
  } catch (e) {
    dlog("Prefetch error", e.message);
    res.status(500).json({
      error: "Prefetch error",
      detail: DEBUG ? e.message : undefined,
    });
  }
});

// Root & configuration pages
app.get("/", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.get("/health", (req, res) =>
  res.json({ status: "OK", timestamp: new Date().toISOString() }),
);
app.get("/api/info", (req, res) =>
  res.json({
    version: APP_VERSION,
    encryption: encryptionEnabled(),
    sitePassword: sitePasswordEnabled(),
    redis: redisStatus(),
  }),
);
app.get("/favicon.ico", (req, res) =>
  res.sendFile(path.join(staticDir, "img", "icon.png")),
);

app.get("/configure-direct", (req, res) => {
  const fileRoot = path.join(__dirname, "direct-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "direct-config.html"));
  });
});
app.get("/configure-xtream", (req, res) => {
  const fileRoot = path.join(__dirname, "xtream-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "xtream-config.html"));
  });
});

function maybeDecryptConfig(token) {
  return tryParseConfigToken(token);
}
function isConfigToken(token) {
  if (!token) return false;
  if (token.startsWith("enc:")) return true;
  if (token.length < 4) return false;
  return true;
}

// Legacy redirect
app.get("/:token/configure", (req, res) => {
  const { token } = req.params;
  if (!isConfigToken(token))
    return res.status(400).json({ error: "Invalid configuration" });
  let cfg;
  try {
    cfg = maybeDecryptConfig(token);
  } catch {
    return res.redirect(`/${encodeURIComponent(token)}/configure-direct`);
  }
  const provider = cfg.provider || (cfg.useXtream ? "xtream" : "direct");
  return res.redirect(`/${encodeURIComponent(token)}/configure-${provider}`);
});

app.get("/:token/configure-data.json", (req, res) => {
  const { token } = req.params;
  if (!isConfigToken(token))
    return res.status(400).json({ error: "Invalid configuration" });
  let cfg;
  try {
    cfg = maybeDecryptConfig(token);
  } catch {
    return res.status(400).json({ error: "Invalid configuration" });
  }
  if (!cfg || typeof cfg !== "object")
    return res.status(400).json({ error: "Invalid configuration" });
  const { prescan, instanceId, ...editable } = cfg;
  res.setHeader("Cache-Control", "no-store");
  res.json(editable);
});

app.get("/:token/configure-direct", (req, res) => {
  if (!isConfigToken(req.params.token))
    return res.status(400).json({ error: "Invalid token" });
  const fileRoot = path.join(__dirname, "direct-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "direct-config.html"));
  });
});
app.get("/:token/configure-xtream", (req, res) => {
  if (!isConfigToken(req.params.token))
    return res.status(400).json({ error: "Invalid token" });
  const fileRoot = path.join(__dirname, "xtream-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "xtream-config.html"));
  });
});

const XTREAM_USERS_FILE = process.env.XTREAM_USERS_FILE || "";
let xtreamEnabled = false;
if (XTREAM_USERS_FILE && fs.existsSync(XTREAM_USERS_FILE)) {
  try {
    const dataDir = process.env.XTREAM_DATA_DIR || path.join(__dirname, "xtream-data");
    const router = createXtreamRouter({
      usersFile: XTREAM_USERS_FILE,
      idsFile: path.join(dataDir, "xtream-ids.json"),
      archiveFile: path.join(dataDir, "xtream-archive.json"),
      getPool: poolInterface,
    });
    app.use(router);
    xtreamEnabled = true;
    const flush = () => router.flush();
    process.once("SIGTERM", () => { flush(); process.exit(0); });
    process.once("SIGINT", () => { flush(); process.exit(0); });
    console.log("[XTREAM] Routes enabled");
  } catch (e) {
    console.error(`[XTREAM] Disabled: ${e.message}`);
  }
}

// Token interface middleware
app.use("/:token", async (req, res, next) => {
  const { token } = req.params;
  if (isPoolToken(token)) {
    if (!poolKeyMatches(token)) return res.status(404).json({ error: "Not found" });
    try {
      req.addonInterface = await poolInterface();
    } catch (e) {
      console.error("[POOL] Build failed:", e.message);
      return res.status(500).json({ error: "Pool build error" });
    }
    req.configToken = token;
    setPublicBase(req, req.addonInterface, token);
    return next();
  }
  if (!isConfigToken(token)) return next("route");
  if (req.path.startsWith("/configure")) return next();

  let config;
  try {
    config = maybeDecryptConfig(token);
  } catch (e) {
    dlog("Config parse failed", token, e.message);
    return res.status(400).json({ error: "Invalid configuration token" });
  }
  if (!config.provider)
    config.provider = config.useXtream ? "xtream" : "direct";
  if (DEBUG && config.debug !== false) config.debug = true;

  const ifaceKey =
    "iface:" + crypto.createHash("md5").update(token).digest("hex");

  let iface = CACHE_ENABLED ? interfaceCache.get(ifaceKey) : null;
  if (!iface) {
    try {
      dlog("Building addon interface (cache miss)", ifaceKey);
      iface = await createAddon(config);
      if (CACHE_ENABLED) interfaceCache.set(ifaceKey, iface);
    } catch (e) {
      console.error("[SERVER] Addon build failed:", e);
      return res.status(500).json({ error: "Addon build error" });
    }
  } else {
    dlog("Interface cache hit", ifaceKey);
  }

  req.addonInterface = iface;
  req.configToken = token;
  setPublicBase(req, iface, token);
  dlog("Request", req.method, req.originalUrl);
  next();
});

// Logo proxy
app.get("/:token/logo/:tvgId.png", async (req, res) => {
  if (!req.addonInterface) {
    return res.redirect(
      `https://placehold.co/480x270/333333/FFFFFF/png?text=${encodeURIComponent(req.params.tvgId)}`,
    );
  }
  const sources = req.addonInterface._logoSources || [];
  if (!sources.length) {
    return res.redirect(
      `https://placehold.co/480x270/333333/FFFFFF/png?text=${encodeURIComponent(req.params.tvgId)}`,
    );
  }
  const { tvgId } = req.params;
  const rawId = tvgId;
  const noCountry = rawId.replace(/\.[a-z]{2,3}$/, "");
  const hyphenated = noCountry.replace(/[^a-zA-Z0-9]+/g, "-");
  const underscored = noCountry.replace(/[^a-zA-Z0-9]+/g, "_");
  const candidates = [...new Set([rawId, noCountry, hyphenated, underscored])];
  for (const cand of candidates) {
    for (const template of sources) {
      const url = template.replace("{id}", cand);
      try {
        let head = await fetch(url, { method: "HEAD", timeout: 7000 });
        if (!head.ok)
          head = await fetch(url, { method: "GET", timeout: 10000 });
        if (head.ok) {
          const buf = await head.buffer();
          if (buf.length > 50) {
            const ct = head.headers.get("content-type") || "image/png";
            res.setHeader("Content-Type", ct);
            res.setHeader("Cache-Control", "public, max-age=21600");
            return res.end(buf);
          }
        }
      } catch {
        /* continue */
      }
    }
  }
  res.redirect(
    `https://placehold.co/480x270/333333/FFFFFF/png?text=${encodeURIComponent(noCountry.toUpperCase().slice(0, 12))}`,
  );
});

// Live Now / Today event cards
app.get("/:token/card/:id.jpg", async (req, res) => {
  const iface = req.addonInterface;
  const fallback = () => {
    const url = iface && typeof iface.eventCardFallback === "function" ? iface.eventCardFallback(req.params.id) : null;
    return url ? res.redirect(url) : res.status(404).end();
  };
  try {
    const buf = iface && typeof iface.renderEventCard === "function"
      ? await iface.renderEventCard(req.params.id)
      : null;
    if (!buf) return fallback();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(buf);
  } catch (e) {
    console.warn("[CARDS] Render failed:", e.message);
    return fallback();
  }
});

// Serve manifest directly (bypasses SDK's 8KB-limited frozen manifest)
// This ensures Stremio always gets the full manifest with up-to-date genres.
app.get("/:token/manifest.json", (req, res) => {
  const iface = req.addonInterface;
  if (!iface) return res.status(500).json({ error: "Interface not ready" });

  // Build a full manifest from the interface's manifest (which has genres populated)
  const manifest = JSON.parse(JSON.stringify(iface.manifest));
  // Remove configurable/configurationRequired for installed addons
  const proto = (req.get("x-forwarded-proto") || req.protocol).split(",")[0];
  manifest.logo = `${proto}://${req.get("host")}/img/icon.png`;
  if (manifest.behaviorHints) {
    delete manifest.behaviorHints.configurationRequired;
    manifest.behaviorHints.configurable = !iface.isPool;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(manifest));
});

// Provider pool status page
app.get("/:token/report", async (req, res) => {
  const iface = req.addonInterface;
  if (!iface || !iface.isPool) return res.status(404).json({ error: "Not found" });
  try {
    const text = await iface.poolReport();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
  } catch (e) {
    console.error("[POOL] Report failed:", e.message);
    res.status(500).json({ error: "Report failed" });
  }
});

// Stremio router (handles catalog, stream, meta)
app.use("/:token", (req, res) => {
  const iface = req.addonInterface;
  if (!iface) return res.status(500).json({ error: "Interface not ready" });

  const router = getRouter(iface);
  router(req, res, (err) => {
    if (err) {
      console.error("[SERVER] Router error:", err);
      res.status(500).json({ error: "Addon error" });
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });
});

app.use("*", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((error, req, res, next) => {
  console.error("[SERVER] Unhandled error:", error);
  if (!res.headersSent)
    res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(
    `🚀 Server running on port ${port} (debug=${DEBUG}, prefetch=${PREFETCH_ENABLED})`,
  );
  if (POOL_ENABLED || xtreamEnabled)
    poolInterface().catch((e) => console.error("[POOL] Build failed:", e.message));
});
