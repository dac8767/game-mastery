# Game Mastery — Claude Instructions

## What this repo is

Derek's personal Home-coordination app and D&D campaign app, plus the
home-server media stack that serves battle maps. **HANDOFF.md at the repo
root is the source of truth** for architecture decisions and the build
plan — read it before making structural changes.

A third app (screenwriting/OpenDraft) lives in a separate repo and is out
of scope here.

## Standing preferences

- **When updating code, always output the full updated file, never just
  the changed section.**
- **After completing an update, end the reply with the terminal commands
  to run** — exact and paste-ready, in order, including whether a running
  dev server needs restarting. Not a description of what to do.
- Keep costs at free-tier: Convex free tier, Vercel Hobby, Cloudflare
  free plan. Don't introduce paid services without asking.

## Layout

- `dnd-app/` — Next.js player web app + Convex backend (`dnd-app/convex/`).
  One Convex project. DM desktop app (Tauri, reusing these React
  components) is planned next.
- `convex-home-app/` — Convex backend scaffold for the Home app (uses the
  R2 component for attachments). Frontend not built yet. Separate Convex
  project from dnd-app — never merge the two databases.
- `map-server/` — docker-compose (cloudflared + Caddy), Caddyfile, and
  the web-res mirror script for the PowerEdge. Map revision convention:
  **rename files on revision, never overwrite** (immutable cache headers).

## dnd-app conventions

- Authority is structural: DM iff `campaign.dmId === userId` (`requireDm`).
  Every game-state mutation goes through it.
- Player-facing queries shape data **server-side**: hidden combatants,
  masked HP numbers, and `dmNotes` must never leave the server for
  non-DM callers (see `combat.getEncounterView`).
- One subscription per screen: `maps.getTableState` for the table,
  `combat.getEncounterView` for combat.
- `convex/_generated/` is committed so fresh clones typecheck; it is
  overwritten by `npx convex dev` — never hand-edit it.
- **Nothing is done until `npm run guards` is green** (in `dnd-app/`).
  Six guards: typecheck-app, typecheck-convex, generated-api, integrity,
  dm-visibility, build. `npm run guards -- --fast` skips the slow build
  guard while iterating. They also run on every push via
  `.github/workflows/guards.yml`.
- The guards exist because the expensive failures are silent ones — a
  string key that no longer resolves, a visibility rule that quietly
  stopped applying. TypeScript cannot see across those boundaries; the
  guards can. A guard that cannot find what it inspects **fails** rather
  than passing quietly.
- `npx convex dev` needs network access to convex.dev, which sandboxed
  sessions may not have — so `generated-api` catches a stale committed
  `convex/_generated/api.d.ts` instead.

## Convex free-tier cautions

- Function calls are pooled across all projects on the account; the
  combat tracker's reactive queries are the main consumer.
- Don't subscribe components to unpaginated giant lists (updating one
  item re-sends the whole list).
