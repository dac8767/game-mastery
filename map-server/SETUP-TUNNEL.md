# Battle Map Server — Cloudflare Tunnel + Access Setup

Serves your ~1TB map library from the PowerEdge at `maps.yourdomain.com`,
free, with login required. No ports opened on your router; the tunnel is an
outbound connection from the server to Cloudflare, so your Deco mesh and
Reolink setup are untouched.

## Architecture

```
Players' browsers
      │  HTTPS (login enforced by Cloudflare Access)
      ▼
Cloudflare edge  ── caches hot map images after first pull
      │  outbound tunnel (no inbound ports)
      ▼
PowerEdge: cloudflared ──► Caddy ──► /srv/maps  (your library)
                                     /srv/maps-web (compressed copies)
```

## Prerequisites

- Domain with DNS on Cloudflare (move nameservers if not already — free)
- Docker + Docker Compose on the PowerEdge
- Your map library at a known path (adjust volume paths in compose file)

## 1. Create the tunnel (dashboard-managed)

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel**
2. Choose **Cloudflared**, name it `poweredge-maps`
3. Copy the token from the install command (the long string after
   `--token`) — that goes in your `.env` file as `TUNNEL_TOKEN`
4. Under **Public Hostnames**, add:
   - Subdomain: `maps` / Domain: `yourdomain.com`
   - Service: `HTTP` → `caddy:80`  (container name, since both run on the
     same Docker network)

Dashboard-managed tunnels mean the routing config lives in Cloudflare and
survives container rebuilds; the server only needs the token.

## 2. Lock it down with Cloudflare Access

1. Zero Trust → Access → Applications → **Add an application** → Self-hosted
2. Application domain: `maps.yourdomain.com`
3. Identity providers: leave **One-time PIN** enabled (zero setup — players
   get an emailed code; free plan covers up to 50 users)
4. Create a policy:
   - Action: **Allow**
   - Include → Emails: your email, your wife's, and your 11 players'
5. Session duration: set to something long like 1 month so players aren't
   re-authenticating every session night

Now nothing behind `maps.yourdomain.com` is reachable without passing that
email check — the library is not crawlable or publicly enumerable.

## 3. Deploy

```bash
mkdir -p ~/map-server && cd ~/map-server
# copy docker-compose.yml, Caddyfile, .env (with TUNNEL_TOKEN=...) here
docker compose up -d
```

Visit `https://maps.yourdomain.com/` — you should hit the Access login,
then Caddy's file browser.

## 4. Generate web-resolution copies (strongly recommended)

Your upload bandwidth is the bottleneck, not cost. Full-res map files are
often 50–200MB; a 2560px-wide WebP at q80 is typically 3–10MB and looks
identical on a TV or monitor. Run `make-webres.sh` to mirror your library
into compressed display copies:

```bash
sudo apt install webp imagemagick
./make-webres.sh /srv/maps /srv/maps-web
```

It's incremental — re-run it after adding new maps and it only converts
what's new. Serve `/web/...` URLs to players; keep `/originals/...` for
yourself when you need print quality.

## 5. Wiring into the D&D app (Convex)

Add a `maps` table storing the path, not the image:

- `title`, `tags`, `gridSize`, etc. — searchable metadata in Convex
- `path`: e.g. `web/dungeons/sunken-crypt-40x30.webp`
- The client renders `https://maps.yourdomain.com/${path}`

Players are already Access-authenticated in their browser (cookie), so
`<img>` tags load directly. Your existing Make + LLM vision tagging
pipeline output can be migrated into this table so the map picker is
searchable by the same locked vocabulary.

## Caching notes

Cloudflare Access runs before the cache, so auth is enforced on every
request while still letting the edge serve cached copies — the first
player pulls a map through your ISP upstream; subsequent pulls that
session usually come from Cloudflare's edge. The Caddyfile sets long
`Cache-Control` headers on image responses to encourage this. If you
update a map in place, change the filename (content-hash or version
suffix) rather than fighting cache invalidation.

## Costs

| Item | Cost |
|---|---|
| Cloudflare Tunnel | $0 |
| Cloudflare Access (≤50 users) | $0 |
| Bandwidth (any amount) | $0 |
| Domain | ~$10/yr |
| Storage | your existing disk |

## Caveats

- Home upload speed is the real limit; the web-res copies are what make
  this feel fast.
- Cloudflare's free-plan terms tolerate personal-scale media serving;
  don't build a public/commercial map host on this.
- The PowerEdge is now infrastructure: put the map array on something
  with redundancy or a backup job — the tunnel doesn't protect the data.
