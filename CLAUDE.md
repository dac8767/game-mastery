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
- **When a change needs a re-import, give the WHOLE sequence in one
  block, ending with `npm run dev`.** Never the import commands on their
  own: the point is one paste that leaves the app running, not three
  fragments to assemble. The canonical block is in "Re-importing the
  Lookup library" below.
- No `#` comments inside a command block. macOS zsh does not treat `#`
  as a comment at an interactive prompt, and an apostrophe inside one
  opens a quote that swallows every command after it — this has cost a
  round trip more than once.
- Keep costs at free-tier: Convex free tier, Vercel Hobby, Cloudflare
  free plan. Don't introduce paid services without asking.

## Re-importing the Lookup library

Anything that changes what `scripts/import-foundry.mjs` writes — a new
field, a different shape, a fix to how a description is read — needs the
converter re-run and the tables replaced. Give this whole block, adjusted
only where the change requires it:

```bash
git pull origin claude/game-mastery-db-setup-jaeuln
pkill -f "next dev"
npx convex dev --once
node scripts/import-foundry.mjs ~/Downloads/foundry-everything.json k17ezhmgzwdzfb0pr0ctahsgrx8cqn8a -o foundry-import
npx convex import --table spells foundry-import/spells.jsonl --replace --yes
npx convex import --table items foundry-import/items.jsonl --replace --yes
npx convex import --table monsters foundry-import/monsters.jsonl --replace --yes
npm run dev
```

Why each line is there:

- `pkill -f "next dev"` — a stale dev server holds port 3000 and keeps
  serving an older build with older `NEXT_PUBLIC_` values baked in. The
  new one quietly moves to 3001 and you carry on looking at the old one.
- `npx convex dev --once` pushes the schema and RETURNS. `npm run dev`
  also pushes it but then stays running, so nothing after it would ever
  execute. A schema change has to land before the import, or the import
  is validated against the old one.
- `--yes` so the whole block runs unattended. These three tables are
  derived reference data with no write path — `--replace` is what they
  are for.
- Drop the tables that did not change; keep the shape of the block.

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
  Seven guards: typecheck-app, typecheck-convex, generated-api,
  integrity, dm-visibility, unit, build. `npm run guards -- --fast` skips the slow build
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
