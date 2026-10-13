# ☄️ Stremio IPTV Addon (Direct M3U • Xtream Codes • XMLTV EPG • Series Support)

> A self‑hostable, token‑based, privacy‑friendly IPTV addon for **Stremio** supporting:
> - Direct M3U playlists (TV + Movie + heuristic Series detection)
> - Xtream Codes API (JSON mode + m3u_plus mode)
> - Panel XMLTV or custom EPG feeds
> - Channel Logos, Live Now info, Upcoming programme snippets
> - Timezone-aware guide times (DST handled automatically)
> - Movies & VOD catalog
> - Series catalog (Xtream native + M3U heuristic grouping)
> - Live TV only mode (drops movie & series catalogs)
> - Adult content filter (on by default, hides anything named or grouped "XXX")
> - Per-group channel catalogs with keyword filter
> - Reconfigure from Stremio's Configure button (settings pre-filled)
> - Xtream catch-up: "Start over" and recent past shows on recorded channels, plus a "Catch-up TV" catalog of every recorded channel
> - Xtream account check (status, expiry, connections in use)
> - Optional site password for the setup pages
> - Client pre‑flight validation with CORS bypass fallback
> - Config tokens, encrypted automatically when `CONFIG_SECRET` is set
> - Local LRU + Redis caching
> - Streaming XMLTV parser (fits 512 MB hosts) & logo proxy
> - Graceful degradation (EPG failures do not block usage)

---

## 🎬 Demo Flow (How Users Install)

1. Visit your hosted base URL (`https://your-host/`)
2. Pick a mode:
   - “Direct M3U / EPG” → paste playlist + optional XMLTV
   - “Xtream Codes API” → enter panel URL + credentials (or toggle m3u_plus)
3. (Optional) Provide or override EPG source
4. Pre‑flight runs:
   - Fetch + parse playlist (client; server fallback if CORS)
   - Fetch + quick-scan EPG (non-fatal)
   - Build a configuration token
5. A Stremio manifest URL appears (disabled buttons enable when ready):
   ```
   https://your-host/<TOKEN>/manifest.json
   stremio://your-host/<TOKEN>/manifest.json
   ```
6. Open in Stremio → catalogs appear:
   - IPTV Channels (tv)
   - IPTV Movies (movie) and IPTV Series (series), unless **Live TV only** is on
   - One row per channel group, if **Show each channel group as its own row** is on
7. To change settings later, click **Configure** on the addon in Stremio, then reinstall with the new link.

---

## 🧪 Quick Start (Local Dev)

```bash
git clone https://git.namillis.me/namillis/M3U-XCAPI-EPG-IPTV-Stremio.git
cd M3U-XCAPI-EPG-IPTV-Stremio
cp .env.example .env   # create your env (or export vars manually)
npm install
npm start
# Server runs on PORT (default 7000)
open http://localhost:7000/
```

Minimal `.env`:
```env
PORT=7000
CACHE_ENABLED=true
CACHE_TTL_MS=21600000
MAX_CACHE_ENTRIES=300
DEBUG_MODE=true
# Optional:
# REDIS_URL=redis://localhost:6379
# CONFIG_SECRET=super-long-random-string   (enables /encrypt)
# PREFETCH_ENABLED=true
# PREFETCH_MAX_BYTES=5000000
```

---

## 🐳 Docker (Standalone)

```bash
docker build -t stremio-iptv-addon .
docker run -d \
  -e PORT=7000 \
  -e DEBUG_MODE=false \
  -e CACHE_ENABLED=true \
  -p 7000:7000 \
  --name stremio-addon \
  stremio-iptv-addon
```

### Docker Compose (with Redis for shared cache)

```yaml
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
  addon:
    build: .
    restart: unless-stopped
    environment:
      PORT: 7000
      REDIS_URL: redis://redis:6379
      CACHE_ENABLED: "true"
      CACHE_TTL_MS: 21600000
      MAX_CACHE_ENTRIES: 400
      PREFETCH_ENABLED: "true"
      PREFETCH_MAX_BYTES: 6000000
      CONFIG_SECRET: "generate_a_long_random_string"
      DEBUG_MODE: "false"
    depends_on:
      - redis
    ports:
      - "7000:7000"
```

Then open: `http://localhost:7000/`

---

## 🏗️ Free Self-Hosting on Oracle Cloud

Oracle Cloud's Always Free tier includes an ARM VM that runs this addon around the clock at no cost. It never sleeps, so there are no cold starts and no keep-alive pings. In exchange you run the VM yourself: [Caddy](https://caddyserver.com) provides HTTPS, Redis runs next to the addon, and a small timer redeploys when you push to your fork.

### Create the VM

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). A credit card is needed for verification, but Always Free resources aren't billed. Your home region is permanent, and busy regions often run out of ARM capacity.
2. Go to **Compute** → **Instances** → **Create instance**:

   | Setting | Value |
   |---------|-------|
   | Image | Canonical Ubuntu 24.04 |
   | Shape | `VM.Standard.A1.Flex`, 1 OCPU / 4 GB (enough for this addon and a few more) |
   | Networking | New VCN with a public subnet, assign a public IPv4 address |
   | Boot volume | 100 GB (Always Free includes 200 GB in total) |
   | SSH key | Your public key |

   If you get **Out of host capacity**, try another availability domain or try again later.
3. Open ports 80 and 443 in two places:
   - **Networking** → your VCN → your subnet's **Security List** → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination port `80`, then the same for `443`.
   - On the VM itself. Oracle's Ubuntu image ships iptables rules that reject everything except SSH, so insert the new rules above its `REJECT` rule:

     ```bash
     pos=$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}')
     sudo iptables -I INPUT $pos -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo iptables -I INPUT $pos -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo netfilter-persistent save
     ```
4. Point a hostname at the VM's public IP. A free [DuckDNS](https://www.duckdns.org) subdomain works. DuckDNS fills in the IP of the network you create it from, so replace it with the VM's IP. The VM's IP only changes if you delete the VM.

### Run the addon

Install Docker and clone the repo (or your own copy of it):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # log out and back in afterwards
mkdir -p ~/stack/addons && cd ~/stack
git clone https://git.namillis.me/namillis/M3U-XCAPI-EPG-IPTV-Stremio.git addons/iptv
```

Create `~/stack/docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

  iptv:
    build: ./addons/iptv
    restart: unless-stopped
    env_file: ./iptv.env
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --save 60 1 --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data

volumes:
  caddy_data:
  caddy_config:
  redis_data:
```

Create `~/stack/Caddyfile` with your hostname:

```
yourname.duckdns.org {
    reverse_proxy iptv:7000
}
```

Create `~/stack/iptv.env` and `chmod 600` it:

```
CONFIG_SECRET=<a long random string, e.g. from openssl rand -hex 32>
SITE_PASSWORD=<optional>
CACHE_ENABLED=true
DEBUG_MODE=false
REDIS_URL=redis://redis:6379
```

- Don't set `PORT`. Caddy expects the default `7000`.
- Local Redis has no 10 MB request limit, so you can raise `REDIS_MAX_BYTES` if the guide save is skipped in the logs.

Start everything and check that Caddy gets a certificate:

```bash
cd ~/stack && docker compose up -d --build
docker compose logs -f caddy
```

Then open `https://yourname.duckdns.org/`. Only Caddy publishes ports. The addon and Redis are reachable only on Docker's internal network.

### Auto-deploy from git

The VM checks the repo every 2 minutes and rebuilds the addon when `main` moves. No secrets go into the repo, and nothing needs to reach the VM over SSH.

Create `~/stack/autodeploy.sh` and `chmod 755` it:

```bash
#!/bin/bash
set -euo pipefail
exec 9>/tmp/stack-autodeploy.lock
flock -n 9 || exit 0

STACK=/home/ubuntu/stack
REPO=$STACK/addons/iptv

git -C "$REPO" fetch -q origin main
LOCAL=$(git -C "$REPO" rev-parse HEAD)
REMOTE=$(git -C "$REPO" rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "deploying ${LOCAL:0:7} -> ${REMOTE:0:7}"
git -C "$REPO" merge -q --ff-only origin/main
cd "$STACK"
docker compose build -q iptv
docker compose up -d iptv
docker image prune -f >/dev/null

for i in $(seq 1 20); do
  if docker compose exec -T iptv wget -qO- http://localhost:7000/health >/dev/null 2>&1; then
    echo "healthy at $(git -C "$REPO" log --oneline -1)"
    exit 0
  fi
  sleep 3
done
echo "health check failed after deploy" >&2
exit 1
```

Install it as a systemd timer:

```bash
sudo tee /etc/systemd/system/stack-autodeploy.service >/dev/null <<'EOF'
[Unit]
Description=Pull and redeploy the IPTV addon when main changes
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
ExecStart=/home/ubuntu/stack/autodeploy.sh
EOF

sudo tee /etc/systemd/system/stack-autodeploy.timer >/dev/null <<'EOF'
[Unit]
Description=Check for IPTV addon updates every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now stack-autodeploy.timer
```

Logs are in `journalctl -u stack-autodeploy`. There is no automatic rollback: if a deploy breaks the addon, revert the commit on `main` and the VM deploys the revert. Make changes by pushing to the repo, not in the VM's checkout, or the fast-forward stops.

### Site password

Your addon URL is public, so anyone who finds it could use your setup pages and the server's playlist fetcher. Set `SITE_PASSWORD` in `iptv.env` and the browser asks for it (any username, this password) on:

- the home and setup pages, including Stremio's **Configure** button
- `/api/*` and `/encrypt`

The addon itself (`/<token>/manifest.json`, catalogs, streams, logos), `/health` and the CSS/JS/icon files stay open, because Stremio and uptime monitors can't send a password. Ten wrong attempts from one IP lock it out for 15 minutes.

### Oracle free tier notes

- **Idle reclamation:** Oracle can reclaim an Always Free VM when its CPU (95th percentile), network and memory use all stay under 20% for 7 days. This addon on its own sits around 17-19% memory on a 4 GB VM. Upgrade the account to Pay As You Go (still $0 within Always Free limits) or run more on the VM, and check **Instance** → **Metrics** → **Memory Utilization**.
- **ARM:** the VM is arm64. Building from source works. Prebuilt images must support `linux/arm64`.
- **Datacenter IP blocks:** some IPTV providers block cloud IPs, Oracle's included. If your playlist loads at home but not on the VM, that's the likely cause.

---

## 🧺 Provider Pool (several providers, one install)

If you pay for more than one provider, the server can load all of them and serve them as one addon. The logins stay in a file on the server instead of in the install link.

- **Duplicate channels are merged.** `US - ESPN 2 HD ◉`, `US: ESPN 2` and `US| ESPN 2 HD [BK]` become one **US - ESPN 2** tile. Opening it lists a stream from every provider that carries it, best quality first, labeled with the provider and quality (`Main · HD`, `Backup · HD backup`). Channels are matched by country prefix and name, ignoring quality tags (HD, FHD, 4K, HEVC, SD), backup markers, symbols and spacing. Local US stations are matched by call sign, so `ABC 07 NEW YORK NY (WABC)` and `ABC New York WABC TV` merge. Different countries never merge, so `US - ESPN 2` and `LAT - ESPN 2` stay apart. A channel with no prefix takes its country from its category when the category names the US or the UK (`USA | Entertainment`, `UK-Restream`, `PLUTO TV USA`), so `USA ESPN` in `USA | Sports` and `Blaze UK` in `UK-Restream` merge with `US: ESPN` and `UK: Blaze`. Numbered slots like `NHL 11` and separator rows are left out of this, so they never join another provider's slot or a real channel. Empty event slots named `NO MATCH` or `NO EVENT` are left out.
- Movies and series are not merged yet. Each provider's copy is listed separately and labeled with its provider.
- **Live Now** and **Today** are built from the merged channels, so a game is one tile and its streams cover every provider that has a matching channel, up to 15. Each channel is listed once before any provider's backup copy.
- Each provider is fetched, cached and refreshed on its own. If one is down, the others keep working and the failed one is retried every 10 minutes.

### Set it up

Create `providers.json` next to your compose file and `chmod 600` it:

```json
{
  "settings": {
    "epgTimezone": "America/New_York",
    "liveOnly": false,
    "catchup": true,
    "hideAdult": true
  },
  "providers": [
    { "id": "a", "name": "Main", "provider": "xtream", "xtreamUrl": "http://panel.example.com:80", "xtreamUsername": "user", "xtreamPassword": "pass" },
    { "id": "b", "name": "Backup", "provider": "direct", "m3uUrl": "https://example.com/playlist.m3u", "epgUrl": "https://example.com/guide.xml" }
  ]
}
```

- `id`: 1-8 lowercase letters or digits. It becomes part of every item ID, so don't change it later or Stremio loses saved items from that provider.
- `name`: shown on that provider's streams.
- `country` (optional): a 2-3 letter code, e.g. `"US"`, for providers whose channel names have no country prefix, like the iptv-org lists. A category that names the US or the UK takes priority over it. Without either, those channels only merge with other unprefixed channels.
- `settings` apply to every provider. A provider can override any of them, along with its own guide fields (`epgUrl`, `epgOffsetHours`, `epgLocalTimes`, `enableEpg`).
- Xtream providers take `xtreamUrl`, `xtreamUsername`, `xtreamPassword` and optionally `xtreamUseM3U` and `xtreamOutput`. Direct providers take `m3uUrl` and optionally `epgUrl`. The guide is on by default.

Mount the file read-only and add a key to `iptv.env`:

```yaml
  iptv:
    build: ./addons/iptv
    restart: unless-stopped
    env_file: ./iptv.env
    volumes:
      - ./providers.json:/config/providers.json:ro
```

```
POOL_KEY=<openssl rand -hex 24>
POOL_FILE=/config/providers.json
```

Restart with `docker compose up -d iptv`, then install:

```
https://yourname.duckdns.org/pool-<POOL_KEY>/manifest.json
```

### Status page

`https://yourname.duckdns.org/pool-<POOL_KEY>/report` shows a plain-text summary:

- channel counts per provider, and how many are shared or only on that provider
- an overlap table, which shows when two logins resell the same channel list
- when each provider last refreshed, or why it failed
- each Xtream account's status, expiry and connections in use, checked live and cached for 5 minutes

The page shows no logins or URLs.

The key is the only thing protecting your provider logins, so treat that link like a password. A wrong key gets a 404. The pool has its own addon ID, so it can be installed next to a regular install. It has no Configure page: edit `providers.json` and run `docker compose restart iptv` instead. `providers.json` is listed in `.gitignore` and `.dockerignore`, so it can't end up in the repo or the image.

**Memory:** a provider with about 8,000 live channels and a guide adds roughly 20-25 MB, and merging adds about 5 MB per 10,000 channels. Providers with large movie and series libraries add more.

### Xtream login for IPTV apps

The pool can also be served as one ordinary Xtream Codes account, so apps like LiveWire, TiviMate or IPTV Smarters see the merged channels and the guide. It's off until a users file exists.

Create `xtream-users.json` next to `providers.json` and `chmod 600` it. Give each TV its own login:

```json
{ "users": [
  { "username": "living-room", "password": "<openssl rand -hex 12>", "countries": ["US", "UK"] }
] }
```

- `countries` (optional) keeps only channels from those countries. Local US stations count as US, a channel with no prefix counts as the country its category names, and channels with no country either way are left out. Without it, every channel is listed.
- `maxConnections` (optional, default 1) is what the login reports to the app.
- Passwords need at least 12 characters. The pool's `POOL_KEY` is never accepted here, and 10 failed logins from one IP lock it out for 15 minutes.

Mount it read-only, plus a writable folder for the channel numbers:

```yaml
    volumes:
      - ./providers.json:/config/providers.json:ro
      - ./xtream-users.json:/config/xtream-users.json:ro
      - ./xtream-data:/data
```

```
XTREAM_USERS_FILE=/config/xtream-users.json
XTREAM_DATA_DIR=/data
```

In the app, add an Xtream provider with server `https://yourname.duckdns.org` and one of those logins.

- Channel numbers are kept in `xtream-data/xtream-ids.json`, so favourites in the app keep working when the provider lists change. A number is never reused. If a merge-rule change gives a channel a new name key, it keeps its number through the provider streams the two share. Don't delete the file.
- Categories are listed in provider order, so the first provider's groups come first.
- **Live Now** comes first when anything is on: the same live and upcoming events as Stremio's Live Now, one channel each ("Bills @ Chiefs", or "Arsenal vs Chelsea · 7:30 PM EDT" before kickoff). Playing one goes through the event's ranked channels in order, with the usual failover, keeping only channels from the login's countries. Its guide entry is the first of those channels that has a guide. Event numbers start at 1,000,000,000, so they never clash with channel numbers. They aren't saved, because events only last a day. The list is rebuilt at most once a minute.
- Movies and series come back empty.

**Playback.** The server doesn't relay video. A stream request (`/live/...`) gets a redirect to one provider's own stream URL, so the provider sees the TV's IP and the server only answers one small request per channel change. That puts the provider's login in the URL the TV receives, so only give these logins to your own devices.

- **Which provider:** providers in `providers.json` order, skipping any whose account looks full. "Full" counts this server's own streams plus the account's connections in use (checked every 5 minutes, sooner when the first choice looks full).
- **Leases:** each login holds one stream at a time. Changing channel frees the provider the old one used. A login that goes quiet keeps its lease for 4 hours, so a TV turned off mid-stream holds its provider until then.
- **Failover:** asking for the same channel again within a minute counts as a failure, and the next provider is used. That's what an app's retry does. Right after a channel change on the same provider, the first two quick retries within 10 seconds stay put, because one-connection accounts often refuse the new stream for a moment. HLS (`.m3u8`) requests always stay on the same provider.
- **Catch-up:** `get_simple_data_table` and both archive URL forms (`/timeshift/...` and `/streaming/timeshift.php`) go to the provider that has the archive. The server reports its time zone as UTC, and archive start times are converted to that provider's own zone.
- **Limits:** 60 API calls and 30 stream requests per minute per login.
- **App signals (optional):** `player_api.php?action=pool_info` returns `{"pool":1,"version":1,"features":["retry","stop","sources"]}`, so an app can tell the pool from a plain panel. An app that adds `?try=N` to live URLs (0 on open, one more on each retry, plus `&why=refused` for a 401/403/429) gets failover only when N goes up, instead of the one-minute guess. `action=pool_stop&stream_id=N` releases that stream's lease when playback stops, so the provider is free for another TV right away. `action=pool_sources&stream_id=N` lists the channel's streams in failover order (provider, channel name, quality, backup, and which one this login is on). Adding `&source=<key>` from that list to a live URL plays that stream. Retries after it fail over as usual. Apps that send neither keep the default behaviour above.

---

## 🔐 Configuration Tokens

| Type | Format | Notes |
|------|--------|-------|
| Plain Token | Base64URL JSON (no prefix) | Used by the config UI when `CONFIG_SECRET` is not set |
| Encrypted Token | `enc:<base64url ciphertext>` | Used automatically by the config UI when `CONFIG_SECRET` (16+ chars) is set |
| Manifest URL | `https://host/<TOKEN>/manifest.json` | Supply to Stremio |
| Stremio Protocol | `stremio://host/<TOKEN>/manifest.json` | Auto-open from UI |

Decryption / parsing is done server-side before addon build. Changing `CONFIG_SECRET` invalidates every encrypted install link, so set it once and leave it.

---

## 📡 HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing + mode selection |
| `/configure-direct` | GET | Direct config page (no token) |
| `/configure-xtream` | GET | Xtream config page (no token) |
| `/:token/configure-direct` | GET | Reconfigure direct (pre-filled if token decodes) |
| `/:token/configure-xtream` | GET | Reconfigure Xtream |
| `/:token/configure` | GET | Stremio's Configure button (redirects to the right mode) |
| `/:token/configure-data.json` | GET | Saved settings used to pre-fill the config page |
| `/:token/manifest.json` | GET | Stremio manifest |
| `/:token/catalog/:type/:id/:extra?.json` | GET | Catalog resource (SDK handled) |
| `/:token/stream/:type/:id.json` | GET | Stream resource |
| `/:token/meta/:type/:id.json` | GET | Meta resource |
| `/:token/logo/:tvgId.png` | GET | Logo proxy (tries multiple sources) |
| `/api/prefetch` | POST | Server-side fetch (CORS bypass, size limited) |
| `/encrypt` | POST | Returns encrypted token (requires `CONFIG_SECRET`) |
| `/health` | GET | Health probe (JSON) |
| `/api/info` | GET | Version and whether encryption, site password and Redis are on (JSON) |
| `/api/xtream/account` | POST | Xtream account status, expiry and connections (`{xtreamUrl, username, password}`) |

### Prefetch Example
```bash
curl -X POST http://localhost:7000/api/prefetch \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/playlist.m3u","purpose":"playlist"}'
```

---

## 🧬 Features Breakdown

| Feature | Direct M3U | Xtream JSON | Xtream m3u_plus | Notes |
|---------|------------|-------------|-----------------|-------|
| Live Channels Catalog | ✅ | ✅ | ✅ | Unified tv catalog |
| Movies Catalog | Heuristic (by title/year/group) | ✅ | ✅ | Filtering rules |
| Series Catalog | Heuristic (SxxEyy / Season X) | Native `get_series` + `get_series_info` | Heuristic | Per-episode videos |
| EPG | XMLTV custom or provided | Panel xmltv.php or custom | Panel xmltv.php or custom | Timezone + offset supported |
| Live TV only | ✅ | ✅ (skips VOD/series downloads) | ✅ | Removes movie & series catalogs |
| Catch-up | ❌ | ✅ (`tv_archive` channels) | ❌ | "Start over" + recent shows as extra streams, and a "Catch-up TV" catalog |
| Live Now | ✅ | ✅ | ✅ | Reads event channel names like `ESPN PLUS 12 : A @ B OCT 2 – 7:00 PM ET`, plus live games in the guide on regular networks (using XMLTV `<category>`, `<live/>` and `<previously-shown>` when present), and lists what's live or starting within an hour. One tile per event with every matching channel as a stream, so a game on ESPN+ and its network broadcast share a tile. Matchups are also checked against ESPN's public scoreboards (about 30 US and European leagues, refreshed every 15 minutes) to show the sport and game status, without scores, and to drop games that have finished. ESPN's TV listings also add the right network channels to a game (ESPN, FOX, TNT, NESN and other US networks in your playlist), rename generic guide tiles like "College Football · Fox" to the actual matchup, and add games no event channel or guide entry covers. Regional broadcasts (several games on the same network at once) are skipped, since an affiliate can't be matched to its game. Replays are left out: guide airings of a game ESPN already lists as finished earlier that day, and F1 shown outside its race weekend on ESPN's F1 calendar. So are studio shows on event channels (countdowns, highlights, wrap-up shows like "NFL Gameday Final") and anything on movie channels. A game's channels are checked against their own guide listing: a channel whose guide shows something else at game time is left out, channels whose guide shows the game come first, and only 4 affiliates of one network are kept since they carry the same broadcast. Up to 15 streams are listed. Undated slots only show when you filter by their group or search |
| Today | ✅ | ✅ | ✅ | Everything on the rest of today (ET, or your guide timezone): event channels dated today plus every ESPN game you have a channel for, sorted by start time, finished games removed |
| Sport filter | ✅ | ✅ | ✅ | Live Now and Today can be filtered by sport (Football, Basketball, Hockey, Soccer, Volleyball, Tennis, Golf, Motorsport, Fighting and more) as well as by channel group. Cards for ESPN-matched games use the home team's color |
| Sport cards | ✅ | ✅ | ✅ | Live Now and Today tiles are drawn by the server with [sharp](https://sharp.pixelplumbing.com): a photo of the sport recolored in the team's color (duotone), a sport badge, the title and the network. Photos are in `src/img/sports` with credits in [`src/img/sports/CREDITS.md`](src/img/sports/CREDITS.md); the Oswald font (SIL OFL) is in `src/fonts`. If sharp can't load, tiles fall back to plain placeholder cards |
| Live Now order | ✅ | ✅ | ✅ | Live games are sorted by how big they are, from ESPN's data: league, postseason, AP rankings, national TV, ESPN's featured games and ticket prices. Games with a [Polymarket](https://polymarket.com) market also move up while they draw heavy trading, measured over the last 15 minutes. Games starting within the hour follow, in start-time order |
| Group catalogs | ✅ (group-title) | ✅ (categories) | ✅ | Optional keyword filter, max 100 |
| Logos | tvg-logo / fallback proxy | Uses stream_icon / cover | tvg-logo where present | Multiple sources attempted |
| CORS Bypass | Yes (prefetch) | Yes (prefetch) | Yes (prefetch) | Browser first, fallback server |
| Encryption | Token-level | Token-level | Token-level | Optional |
| Caching | LRU + optional Redis | Same | Same | Cache key = hashed config |
| Series Episodes | Local heuristic grouping | On-demand per series (lazy) | Heuristic | Episode IDs = `iptv_series_ep_*` |

---

## ⛽ Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `7000` | HTTP server port |
| `REDIS_URL` | unset | Redis for the channel/guide cache, e.g. `redis://redis:6379` |
| `REDIS_TTL_MS` | `86400000` (24h) | How long a cached copy lives in Redis |
| `REDIS_MAX_BYTES` | `9961472` (9.5 MB) | Skip saving copies larger than this after gzip (managed Redis plans often limit requests to 10 MB) |
| `SITE_PASSWORD` | unset | Password for the setup pages and `/api/*` (HTTP Basic auth, any username) |
| `CACHE_ENABLED` | `true` | Master toggle for LRU + Redis |
| `CACHE_TTL_MS` | `21600000` (6h) | TTL for cached data |
| `EPG_REFRESH_MS` | `3600000` (1h) | How often the guide is re-downloaded (channels refresh hourly) |
| `MAX_CACHE_ENTRIES` | `300` | LRU entry cap |
| `CONFIG_SECRET` | unset | 16+ chars. Config UI encrypts install links with it (AES-256-GCM) |
| `POOL_KEY` | unset | 16+ letters, digits, `-` or `_`. Turns on the [provider pool](#-provider-pool-several-providers-one-install), installed at `/pool-<POOL_KEY>/manifest.json` |
| `POOL_FILE` | `./providers.json` | Path to the pool's provider list |
| `XTREAM_USERS_FILE` | unset | Turns on the [Xtream login](#xtream-login-for-iptv-apps) for IPTV apps when the file exists |
| `XTREAM_DATA_DIR` | `./xtream-data` | Writable folder for the Xtream channel numbers |
| `DEBUG_MODE` | `false` | Enables verbose diagnostic logs |
| `PREFETCH_ENABLED` | `true` | Enable server-side prefetch CORS bypass |
| `PREFETCH_MAX_BYTES` | `5000000` | Max bytes returned from `/api/prefetch` |
| `PREFETCH_EPG_MAX_BYTES` | `2000000` | Max bytes the config page downloads to sanity-check an EPG (server still loads the full guide) |
| `NODE_ENV` | (user value) | Standard Node semantics |

> Redis is optional. Without it, only in‑process LRU is used (per container), and a restart means a full re-download.

---

## 🧱 Architecture (High-Level)

```
┌───────────────────────────┐
│      Browser Client       │
│ (Direct/Xtream Config UI) │
└──────────┬────────────────┘
           │ Pre-flight (fetch playlist & optional EPG)
           ▼
┌───────────────────────────┐
│      /api/prefetch        │  ← CORS bypass, size-limited, SSRF guarded
└──────────┬────────────────┘
           │ Token JSON
           ▼
┌───────────────────────────┐
│        server.js          │
│  - decrypt (if enc:)      │
│  - cache interface        │
│  - createAddon(config)    │
└──────────┬────────────────┘
           │
           ▼
┌───────────────────────────┐
│        addon.js           │
│  - load cache             │
│  - fetch provider data    │
│  - parse M3U / EPG        │
│  - build catalogs         │
└──────────┬────────────────┘
           │ Stremio resource routes
           ▼
┌───────────────────────────┐
│      Stremio Client       │
│  Catalog / Meta / Stream  │
└───────────────────────────┘
```

---

## 🔍 Series Handling

### Xtream JSON Mode
- Fetches `get_series`
- Per-series metadata lazily enriched via `get_series_info`
- Each episode becomes a `video` in the series meta, streamable by ID

### Direct / m3u_plus / Heuristic
- Detects patterns:
  - `S01E05`, `S1E2`, `Season 2 Episode 4`, `Season 3 Ep 09`
- Groups by *base series name* (title with season/episode suffix removed)
- Builds synthetic series entities with episodes list
- Missing season or episode → defaults to `season=1`, `episode=0`

---

## 🛡️ Security Considerations

| Area | Current Defense | Recommendation |
|------|------------------|----------------|
| Prefetch SSRF | Blocks localhost & RFC1918 ranges | Optionally maintain allowlist or DNS resolve & IP classify |
| Token Leakage | Long base64url token + optional encryption | Always use `CONFIG_SECRET` for shared public hosts |
| EPG Size | Prefetch max bytes & server timeouts | Adjust `PREFETCH_MAX_BYTES` for very large XMLTV feeds |
| DoS / Abuse | Basic size limits | Add rate limiting (e.g. `express-rate-limit`) |
| Sensitive Creds | Xtream credentials stored only in token | Encourage users not to share tokens publicly |

---

## 🧭 Usage Examples

### Direct Playlist (Plain)
1. Go to `/configure-direct`
2. Paste: `https://example.com/playlist.m3u`
3. (Optional) EPG: `https://example.com/guide.xml`
4. Copy manifest URL: `https://host/<TOKEN>/manifest.json`
5. Add to Stremio

### Xtream (JSON)
- Base URL: `http://panel.example.com:8080`
- Username / Password
- Leave “Use m3u_plus” unchecked
- Enable EPG (panel or custom)
- Install via generated manifest

### Xtream (m3u_plus)
- Tick “Use m3u_plus playlist”
- Optional output format: `ts` / `hls`
- EPG source choice + offset
- Install generated manifest

---

## 🧰 Local Testing (Catalog & Stream)

After configuration:

```bash
TOKEN=<paste-token>
HOST=http://localhost:7000

curl "$HOST/$TOKEN/manifest.json" | jq '.name,.version'

# TV catalog
curl "$HOST/$TOKEN/catalog/tv/iptv_channels.json" | jq '.metas[0]'

# Movie catalog search example
curl "$HOST/$TOKEN/catalog/movie/iptv_movies.json?search=action" | jq '.metas | length'

# Series meta (example ID)
curl "$HOST/$TOKEN/meta/series/iptv_series_<id>.json" | jq '.meta.videos[0]'
```

---

## 🧾 Logging & Debugging

| Mode | How |
|------|-----|
| Enable debug globally | `DEBUG_MODE=true` |
| Per-token debug | Check “Enable Debug Logging” in UI |
| Inspect parsing | Console shows playlist size, entries, EPG programmes |
| Timeout fallback | Buttons enable after build timeout to allow manual retry |

---

## 🗄️ Caching Strategy

| Layer | Scope | Contents |
|-------|-------|----------|
| In-Memory LRU | Per process | Addon data (channels/movies/series/epg) |
| Redis (optional) | Cross replicas | Same payload (JSON) + interface build marker |
| Build Promise Cache | Prevents simultaneous duplicate warm builds |

Cache key = `md5` of normalized config subset.

---

## ✨ Roadmap Ideas

- [ ] Genre filtering optimization
- [ ] Optional transcode / proxy (HLS rewriting)
- [ ] Multi-EPG merge & channel mapping UI
- [ ] Webhook or schedule-based background refresh
- [ ] Token revocation list
- [ ] Dark theme toggle + user theme persistence
- [ ] Add channel favorites (local storage layer)

Want to help? See **Contributing** below.

---

## 🙋 FAQ

**Q: The playlist fetch fails with a CORS error.**  
A: The browser first attempt failed; server `/api/prefetch` will retry. Ensure `PREFETCH_ENABLED=true`.

**Q: EPG shows zero programmes.**  
A: The quick scan counts `<programme>` tags only. If compressed or gzipped, ensure server delivers uncompressed or extend prefetch to decompress.

**Q: Some logos missing.**  
A: The proxy tries multiple templates; contribute additional logo source patterns.

**Q: Token feels huge.**  
A: It’s a compact base64url JSON (or an encrypted blob when `CONFIG_SECRET` is set). Stremio handles it fine.

**Q: Do channels and the guide update by themselves?**  
A: Yes. The install link only holds your settings. While you use it, the server re-downloads channels about every hour and the guide every 6 hours (the guide holds 36 hours ahead), so you only reinstall after changing a setting.

**Q: Series episodes missing (M3U).**  
A: Ensure naming matches patterns (`S01E01` or `Season 1 Episode 1`). Heuristic grouping cannot infer arbitrary naming.

---

## 🧑‍💻 Contributing

1. Fork & branch: `feat/your-feature`
2. Keep changes modular (UI / provider / core)
3. Run lint/tests (add if expanding)
4. Open PR with:
   - Summary + reproduction steps
   - Performance / memory notes if heavy parsing changes
   - Screenshots (UI changes) preferred

### Code Style Guidelines
- Prefer async/await over callbacks
- Avoid blocking large buffers (stream if >10MB future tasks)
- Keep provider logic separated (`providers/`)
- Guard network operations with timeouts

---

## 🐞 Reporting Issues

Please include:
- Node version
- Hosting method (Docker / bare / serverless)
- Provider type (direct / xtream-json / xtream-m3u)
- Sample (sanitized) playlist or line count
- Logs with `DEBUG_MODE=true` (scrub credentials)

Create an issue: https://git.namillis.me/namillis/M3U-XCAPI-EPG-IPTV-Stremio/issues

---

## ⚖️ Legal Notice

This project **does not provide** IPTV content.  
You are solely responsible for ensuring that playlists and streams you load are legal in your jurisdiction.  
The authors are not liable for misuse.

---

## 📄 License

MIT License (see `LICENSE` file).  
Attribution appreciated but not required.

---

## 🧪 Serverless Note

A `serverless.js` handler is included (experimental):
- Cold starts rebuild addon interface
- You must adapt dynamic token passing (currently static)

---

## 🔍 Internal: Episode & Stream ID Patterns

| Kind | Pattern |
|------|---------|
| Live Channel | `iptv_live_<stream_id | md5>` |
| Movie | `iptv_vod_<stream_id | md5>` |
| Series | `iptv_series_<series_id | hash>` |
| Episode | `iptv_series_ep_<episode_hash | xtream_id>` |

---

## 🛠️ Example Encrypted Token Flow

The config pages do this for you when `CONFIG_SECRET` is set. To do it by hand:

```bash
# 1. Start server with CONFIG_SECRET (16+ characters)
# 2. POST JSON config you would otherwise encode

curl -X POST http://localhost:7000/encrypt \
  -H 'Content-Type: application/json' \
  -d '{
        "provider":"direct",
        "m3uUrl":"https://example.com/list.m3u",
        "enableEpg":true,
        "epgUrl":"https://example.com/epg.xml"
      }'

# Response:
# { "token": "enc:..." }
# Manifest URL: https://host/enc:.../manifest.json
```

---

## 🧵 Troubleshooting Matrix

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| Buttons never enable | Manifest build error | Check server logs (addon build), ensure playlist accessible |
| 502 on `/api/prefetch` | Remote host blocked / TLS error | Try direct browser fetch or adjust server CA bundle |
| High memory usage | Massive playlist & no Redis | Increase RAM or add Redis to share cache across restarts |
| Missing search results | Stremio partial search | Use shorter, distinctive search terms; ensure case-insensitive |
| EPG times off | Guide uses local times labelled as UTC | Turn on "Guide times are already in my timezone" and keep `EPG Offset` at 0 |
| "Ran out of memory" on a 512 MB host | Huge playlist (VOD + series) | Enable **Live TV only**, or add Redis / more RAM |
| Channel fails, then plays on retry | Account stream limit or overloaded panel | Click **Check account** to see connections in use; close other streams, retry |
| No catch-up streams | Channel not recorded, m3u_plus mode, or catch-up off | Pre-flight log says how many channels have catch-up; use JSON API mode |
| Catch-up stream won't play | Panel uses a different timeshift URL format | This addon uses `/timeshift/user/pass/minutes/YYYY-MM-DD:HH-MM/id.ts`; some panels only support `/streaming/timeshift.php` |

---

## 🧩 Extending Providers

Add new provider:
1. Create `providers/myProvider.js` exporting `fetchData(addonInstance)` and optionally `fetchSeriesInfo`.
2. Normalize items to: `{ id, name, type: tv|movie|series, url, poster/logo, attributes:{...} }`.
3. Update config UI to set `provider: 'myProvider'`.
4. Adjust `addon.js` logic if custom behavior needed.

---

## 🌈 Theming

The UI uses a "Playful Geometric" look:
- Cream paper background with a dot grid, plus confetti shapes (circles, triangles, squiggles)
- Violet `#8B5CF6` for main actions, with pink `#F472B6`, amber `#FBBF24` and mint `#34D399` as accents
- Hard offset shadows (no blur), 2px dark borders, pill buttons and sticker-style cards
- Fonts: Outfit for headings, Plus Jakarta Sans for body text (Google Fonts)
- All colours and shadows are CSS variables at the top of `src/css/styles.css`

Animations are turned off for anyone with "reduce motion" set in their OS.

---

## ✅ Final Checklist (Self-Host Launch)

| Step | Done? |
|------|-------|
| Playlist reachable via server & browser | ☐ |
| EPG XML reachable (or disabled gracefully) | ☐ |
| `CONFIG_SECRET` set (if sharing public) | ☐ |
| Reverse proxy passes through paths | ☐ |
| Optional HTTPS cert configured | ☐ |
| Redis deployed (optional scaling) | ☐ |
| Firewall restricts internal networks | ☐ |

---

**Happy streaming!**  
For ideas, feature requests, or large refactors — open a discussion first so we can align on direction.  
PRs welcome ❤️

---
