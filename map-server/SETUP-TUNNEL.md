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
PowerEdge: cloudflared ──► Caddy ──► /mnt/Media/game-mastery/maps
                                       (your library, full resolution)
                                     /mnt/Media/game-mastery/maps-web
                                       (compressed copies + foundry/)
```

## Prerequisites

- Domain with DNS on Cloudflare (move nameservers if not already — free)
- Docker + Docker Compose on the PowerEdge
- Your map library at a known path (adjust volume paths in compose file)

### Installing Docker, if it isn't there yet

The official script covers Debian, Ubuntu, RHEL, Fedora and SLES, so it
saves picking the right package repo by hand:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # then log out and back in
docker compose version            # confirms the v2 plugin came with it
```

The group change is what lets you run `docker` without `sudo`, and it
only takes effect on a new login session — `newgrp docker` works for the
current shell if you would rather not log out.

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
6. **Additional settings → Cookie settings → Same Site Attribute → `None`.**
   Not optional — see below.

Now nothing behind `maps.yourdomain.com` is reachable without passing that
email check — the library is not crawlable or publicly enumerable.

### Same Site Attribute: None, or no images load

Access issues its session as a cookie on `maps.yourdomain.com`. Typing
that address into the bar is a top-level navigation, so the browser sends
the cookie and everything looks perfect. An `<img>` in the app is a
CROSS-SITE SUBRESOURCE — the page is on `localhost:3000` or on Vercel, the
image is on `maps.yourdomain.com` — and browsers withhold a `SameSite=Lax`
cookie on those. Access sees an unauthenticated request and redirects it
to the login page.

The failure has no error anywhere and does not look like auth. In the
Network tab it reads:

    maps.yourdomain.com?kid=782f00…%2Ficons%2Fweapons%2F…   302  text/html
    (everything else)                            (failed) net::ERR_BLOCKED_BY_ORB

The `?kid=` URL with the path encoded into a query parameter is Access's
login redirect. `ERR_BLOCKED_BY_ORB` is Chrome refusing to hand an `<img>`
a response that came back as HTML. On screen it is a picture that flashes
for an instant and vanishes — which is the app's own onError hiding a
broken image, not a rendering bug.

Setting Same Site Attribute to `None` lets the cookie ride on those
requests. **Then log out and back in** — the attribute is stamped on the
cookie when it is issued, so an existing session keeps the old behaviour
and the change appears to have done nothing:

    https://maps.yourdomain.com/cdn-cgi/access/logout

If a browser blocks third-party cookies outright and `None` is not enough,
the better answer for the Foundry artwork specifically is to stop
requiring a login for it: a second Access application scoped to the path
`/web/foundry/` with a **Bypass** policy leaves the map library protected
while letting generic system icons load for anyone. They are Foundry's
shipped art, not your maps.

## 3. Deploy

```bash
sudo mkdir -p /mnt/Media/game-mastery/maps /mnt/Media/game-mastery/maps-web
sudo chown -R "$USER":"$USER" /mnt/Media/game-mastery
mkdir -p ~/map-server && cd ~/map-server
# copy docker-compose.yml, Caddyfile, .env (with TUNNEL_TOKEN=...) here
docker compose up -d
docker compose logs -f cloudflared     # look for "Registered tunnel connection"
```

Create the two directories first, and own them. Docker will happily
invent a missing bind-mount source as an empty root-owned directory,
which then serves nothing and looks like a Caddy problem rather than a
missing folder — and a root-owned one refuses the rsync later.

They live on the media array rather than on `/srv`, because the system
disk is a few GB and the map library is the part of this that grows
without limit. The container-side paths never change, so moving to
another disk is two lines in the compose file and a `docker compose up
-d`.

Visit `https://maps.yourdomain.com/` — you should hit the Access login,
then Caddy's file browser.

## 4. Generate web-resolution copies (strongly recommended)

Your upload bandwidth is the bottleneck, not cost. Full-res map files are
often 50–200MB; a 2560px-wide WebP at q80 is typically 3–10MB and looks
identical on a TV or monitor. Run `make-webres.sh` to mirror your library
into compressed display copies:

```bash
sudo apt install webp imagemagick
./make-webres.sh /mnt/Media/game-mastery/maps /mnt/Media/game-mastery/maps-web
```

It's incremental — re-run it after adding new maps and it only converts
what's new. Serve `/web/...` URLs to players; keep `/originals/...` for
yourself when you need print quality.

## 4b. The Foundry artwork mirror

Separate from your maps, and it goes in the same tree. Lookup's spell,
item and monster artwork is thousands of small icons pulled out of a
running Foundry by `dnd-app/scripts/fetch-foundry-images.mjs`, which
writes them already shaped for this server:

```bash
# on the Mac, with Foundry open and the world loaded
node scripts/fetch-foundry-images.mjs ~/Downloads/foundry-everything.json -o foundry-images
rsync -a foundry-images/web/ poweredge:/mnt/Media/game-mastery/maps-web/
```

The trailing slash on the source is load-bearing: it copies the
*contents* of `web/` into the mount, so `foundry/` lands beside your own
map directories rather than nesting a second `web/`.

That destination is the host directory `docker-compose.yml` mounts as
the container's `/srv/web`, which Caddy serves at `/web/`. Three names
for one place, and copying to the wrong one puts every file a directory
away from where it is served — which looks exactly like copying nothing.
A guard in `dnd-app/tests/guards/integrity.mjs` reads the Caddyfile and
the compose file and fails if these stop agreeing.

SSH has to be reachable for that rsync, and Pop!_OS ships `ufw` active
with only its existing services allowed — so the copy times out rather
than being refused, which reads like a network fault:

```bash
sudo apt-get install -y openssh-server
sudo systemctl enable --now ssh
sudo ufw allow from 192.168.68.0/24 to any port 22 proto tcp
```

Do **not** run `make-webres.sh` over these. They are already small WebP
icons; re-encoding them gains nothing and the script's long-edge cap is
meant for 200MB battle maps.

## 5. Wiring into the D&D app (Convex)

Add a `maps` table storing the path, not the image:

- `title`, `tags`, `gridSize`, etc. — searchable metadata in Convex
- `path`: e.g. `web/dungeons/sunken-crypt-40x30.webp`
- The client renders `https://maps.yourdomain.com/${path}`

Players are already Access-authenticated in their browser (cookie), so
`<img>` tags load directly. Your existing Make + LLM vision tagging
pipeline output can be migrated into this table so the map picker is
searchable by the same locked vocabulary.

Point the app at it by setting one variable in `dnd-app/.env.local`:

```
NEXT_PUBLIC_MAP_SERVER=https://maps.yourdomain.com
```

No trailing slash — `NEXT_PUBLIC_` variables are baked in at build time,
so restart the dev server after editing it. Left unset, the app serves
the same mirror out of its own `public/` directory instead; the stored
paths are identical either way, so switching between them is this one
variable and never a re-import.

**That Access cookie is also the first thing to suspect if images do not
load.** A browser that has never passed the one-time PIN gets a redirect
to the login page instead of the file, and an `<img>` cannot follow it —
so the picture is simply absent, with no error. `curl` will show the
same thing, since curl has no cookie either. Load
`https://maps.yourdomain.com/` in the browser once, sign in, and then
check the app.

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
