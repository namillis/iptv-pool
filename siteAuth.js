const crypto = require("crypto");

const PROTECTED_PATHS = [
  /^\/(index\.html)?$/,
  /^\/html\//,
  /^\/configure-(direct|xtream)\/?$/,
  /^\/[^/]+\/configure(-direct|-xtream|-data\.json)?\/?$/,
  /^\/api\//,
  /^\/encrypt\/?$/,
];

const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map();

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) {
    const parts = String(fwd).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || "unknown";
}

function isLockedOut(ip, now) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (now - entry.first > LOCKOUT_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip, now) {
  const entry = failures.get(ip);
  if (!entry || now - entry.first > LOCKOUT_MS) {
    failures.set(ip, { first: now, count: 1 });
  } else {
    entry.count++;
  }
  if (failures.size > 5000) failures.clear();
}

function clearFailures(ip) {
  failures.delete(ip);
}

function suppliedPassword(req) {
  const header = req.headers.authorization || "";
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  return idx === -1 ? decoded : decoded.slice(idx + 1);
}

function sitePasswordEnabled() {
  return !!process.env.SITE_PASSWORD;
}

function sitePassword() {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return (req, res, next) => next();
  const expectedDigest = digest(expected);

  return (req, res, next) => {
    if (!PROTECTED_PATHS.some((re) => re.test(req.path))) return next();

    const ip = clientIp(req);
    const now = Date.now();
    if (isLockedOut(ip, now)) {
      res.setHeader("Retry-After", String(Math.ceil(LOCKOUT_MS / 1000)));
      return res.status(429).send("Too many failed attempts. Try again in 15 minutes.");
    }

    const supplied = suppliedPassword(req);
    if (supplied !== null && crypto.timingSafeEqual(digest(supplied), expectedDigest)) {
      failures.delete(ip);
      return next();
    }
    if (supplied !== null) recordFailure(ip, now);

    res.setHeader("WWW-Authenticate", 'Basic realm="IPTV Addon", charset="UTF-8"');
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).send("Password required.");
  };
}

module.exports = { sitePassword, sitePasswordEnabled, clientIp, isLockedOut, recordFailure, clearFailures };
