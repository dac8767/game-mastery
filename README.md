# Game Mastery

Two personal apps sharing one architecture, plus the media infrastructure
that serves them. Full background and decision log: [HANDOFF.md](HANDOFF.md).

| Directory | What it is | Status |
|---|---|---|
| `dnd-app/` | D&D campaign app — Convex backend + Next.js player web app (live map, combat tracker) | Backend + player app built; GM desktop app (Tauri) is next |
| `convex-home-app/` | Home coordination app — Convex backend (tasks, notes, lists, comments, R2 attachments) | Backend scaffold; frontend not yet built |
| `map-server/` | PowerEdge media stack — Cloudflare Tunnel + Access + Caddy serving ~1TB of battle maps | Config ready to deploy |

## Architecture (see HANDOFF.md for the full decision log)

- **Convex** (free tier — realtime, auth, functions) — two separate projects,
  one per app; shared auth patterns, never shared databases
- **Media** on the home PowerEdge behind a Cloudflare Tunnel, gated by
  Cloudflare Access (email allowlist), served by Caddy
- **Frontends** on Vercel Hobby (Next.js); GM desktop client later via Tauri
- Total running cost: ~$10/yr (the domain)

## D&D player app — quick start

```bash
cd dnd-app
npm install
npx convex dev        # creates/attaches the Convex deployment, pushes schema
cp .env.local.example .env.local   # fill in NEXT_PUBLIC_CONVEX_URL + NEXT_PUBLIC_MAP_SERVER
npm run dev
```

Players sign in (email + password via Convex Auth), pick a campaign, and get
a live view of whatever the GM puts on the table: active map with optional
grid overlay, broadcast banner, and the combat tracker (initiative order,
HP bars or narrative status buckets, conditions, concentration). Everything
is a Convex subscription — no refresh, no polling.

Map images load from `NEXT_PUBLIC_MAP_SERVER` (the tunnel domain); each
player must pass Cloudflare Access once in their browser before images
will render.
