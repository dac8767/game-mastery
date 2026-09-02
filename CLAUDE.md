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
- **Every command block starts with the `cd`.** A new terminal opens in
  `~`, where `git pull` says "not a git repository" and `npx convex`
  offers to install Convex into the home directory. Assuming the shell
  is already in `dnd-app/` is assuming the last session's state, which
  a fresh window does not have.
- Keep costs at free-tier: Convex free tier, Vercel Hobby, Cloudflare
  free plan. Don't introduce paid services without asking.

## "feedback"

The word on its own is the whole instruction. It means:

1. Run `npm run feedback` for the incomplete Game Mastery reports.
2. **Download the attachments and look at them.** A report that says
   "like the attached screenshot" is unreadable without the image, and
   guessing at it wastes a round trip. They are in the
   `feedback-shots` bucket; the row's `attachments` column is the
   filename.
3. Anything filed by Derek (`dm@curiousarcana.com`) — start work
   immediately. No asking which ones, no waiting for a go-ahead.
4. When the work is done and the guards are green, close it:
   `npm run feedback -- --complete <id> <id>`.

Only close what is actually finished. `--complete` names ids
explicitly and prints each row before writing, because "close
everything in the list I just printed" is how a report nobody read
gets marked done. Status was Derek's alone until he asked for this;
reopening one in the dashboard is still his.

**Game Mastery only. Never report on ScriptCraft feedback**, or on any
other app's. `npm run feedback` already filters to `app=Game Mastery`,
so the way this goes wrong is querying the table directly and reading
rows the script deliberately left out — which is what happened, and
which put another project's bug reports into a Game Mastery session.
The table is shared; the tool is the scope. Use the tool.

When the list is empty, say so and stop. An empty queue is the answer,
not a prompt to go looking somewhere else for something to report.

## Re-importing the Lookup library

Anything that changes what `scripts/import-foundry.mjs` writes — a new
field, a different shape, a fix to how a description is read — needs the
converter re-run and the tables replaced. Give this whole block, adjusted
only where the change requires it:

```bash
cd ~/Developer/game-mastery/dnd-app && pwd
git pull origin main
pkill -f "convex dev"
pkill -f "next dev"
lsof -ti tcp:3000 | xargs -I{} kill -9 {}
npx convex dev --once
node scripts/import-foundry.mjs ~/Downloads/foundry-everything.json k17ezhmgzwdzfb0pr0ctahsgrx8cqn8a -o foundry-import
npx convex import --table spells foundry-import/spells.jsonl --replace --yes
npx convex import --table items foundry-import/items.jsonl --replace --yes
npx convex import --table monsters foundry-import/monsters.jsonl --replace --yes
npx convex import --table feats foundry-import/feats.jsonl --replace --yes
npx convex import --table backgrounds foundry-import/backgrounds.jsonl --replace --yes
npx convex import --table classes foundry-import/classes.jsonl --replace --yes
npx convex import --table species foundry-import/species.jsonl --replace --yes
npm run dev
```

Why each line is there:

- The `cd` names the repo by its full path rather than assuming the
  shell is in it. A new terminal opens in `~`, and every line after it
  then fails in a different confusing way — `git pull` claims there is
  no repository, and `npx convex` offers to install Convex into the
  home directory. It is an explicit path, not a `find`: a `find` for
  `*game-mastery*/dnd-app` once landed in `~/ClipStack`, a checkout of
  a different repo with the same folder shape, and pushed at the wrong
  remote. The `&& pwd` prints where it landed, so a wrong answer is
  visible immediately instead of three errors later.
- The three kill lines — a stale dev server holds port 3000 and keeps
  serving an older build with older `NEXT_PUBLIC_` values baked in. The
  new one quietly moves to 3001 and you carry on looking at the old one.

  It takes three lines because `pkill -f "next dev"` does not do it.
  `npm run dev` is `convex dev --start 'next dev'`, so the tree is
  convex → next dev → the server that actually listens — and Next
  renames that last one to `next-server (v16.3.1)`. The pattern matches
  the two wrappers and misses the only process holding the port. Killing
  by PORT is the line that cannot go stale: it names the symptom rather
  than a process title that changes with the next Next release. This has
  now cost a round trip in exactly the way the line was written to
  prevent.
- `npx convex dev --once` pushes the schema and RETURNS. `npm run dev`
  also pushes it but then stays running, so nothing after it would ever
  execute. A schema change has to land before the import, or the import
  is validated against the old one.
- `--yes` so the whole block runs unattended. These seven tables are
  derived reference data with no write path — `--replace` is what they
  are for.
- Drop the tables that did not change; keep the shape of the block.
- If a table's SHAPE changed rather than its contents, `npx convex dev
  --once` will be rejected by the rows already in it. `node
  scripts/clear-lookup.mjs` empties all seven first; the import puts
  them back. Adding a NEW table needs none of that — it is empty
  already.

## Layout

- `dnd-app/` — Next.js player web app + Convex backend (`dnd-app/convex/`).
  One Convex project. GM desktop app (Tauri, reusing these React
  components) is planned next.
- `convex-home-app/` — Convex backend scaffold for the Home app (uses the
  R2 component for attachments). Frontend not built yet. Separate Convex
  project from dnd-app — never merge the two databases.
- `map-server/` — docker-compose (cloudflared + Caddy), Caddyfile, and
  the web-res mirror script for the PowerEdge. Map revision convention:
  **rename files on revision, never overwrite** (immutable cache headers).

## dnd-app conventions

- Authority is structural: GM iff `campaign.dmId === userId` (`requireDm`).
  Every game-state mutation goes through it.
- Player-facing queries shape data **server-side**: hidden combatants,
  masked HP numbers, and `dmNotes` must never leave the server for
  non-GM callers (see `combat.getEncounterView`).
- One subscription per screen: `maps.getTableState` for the table,
  `combat.getEncounterView` for combat.
- `convex/_generated/` is committed so fresh clones typecheck; it is
  overwritten by `npx convex dev` — never hand-edit it.
- **Nothing is done until `npm run guards` is green** (in `dnd-app/`).
  Seven guards: typecheck-app, typecheck-convex, generated-api,
  integrity, dm-visibility, unit, build. `npm run guards -- --fast` skips the slow build
  guard while iterating, and `npm run guards -- --only unit` runs one.
  They also run on every push via `.github/workflows/guards.yml`.
- **Never run a guard file directly** — `node tests/guards/unit.mjs`
  exports a guard and executes nothing, so it exits 0 having checked
  nothing. Use `--only`.
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
