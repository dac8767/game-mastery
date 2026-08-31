# Project Handoff Brief — Home & D&D Apps
_Compiled from planning conversation, July 15, 2026. Drop this file (and the
included scaffolds) into the repo root so Claude Code has full context._

## Who / context

- Derek. Two apps to build here: **Personal/Home coordination** and **D&D
  campaign app**. A third app (screenwriting, desktop, fully local — SQLite +
  Tiptap on disk, no Convex) is being built in a separate Claude Code session
  and is **out of scope for this repo**.
- Standing preference: **when updating code, always output the full updated
  file, never just the changed section.**

## Final architecture (decided)

| Layer | Choice | Cost |
|---|---|---|
| Backend (data, realtime, auth, functions) | **Convex free tier** | $0 |
| Media (battle maps ~1TB, portraits, attachments) | **PowerEdge home server** behind **Cloudflare Tunnel**, fronted by **Cloudflare Access** (email allowlist), served by **Caddy** | $0 |
| Player/home web frontends | **Next.js on Vercel Hobby** | $0 |
| GM desktop client (later) | **Tauri** (preferred over Electron), same React components as web | $0 |
| Domain | DNS on Cloudflare (required for Tunnel) | ~$10/yr |

**Total: ~$10/yr.**

### Why these choices (decision log)

1. **Convex over Supabase/Airtable/Firebase/Appwrite/PocketBase.**
   - Hard requirement: no free-tier idle pausing → eliminated Supabase free
     (pauses after ~7 days); Derek declined to pay $25/mo.
   - Realtime is the core need (combat tracker). Convex makes every query a
     live subscription by default — no channels/polling/cache invalidation.
     Prior Airtable-based combat tracker suffered write→refetch latency;
     Convex removes that structurally.
   - Appwrite eliminated: no transactions/atomic updates (bad for turn
     state). Firebase eliminated: NoSQL + usage-billing footguns.
   - Convex free: 1M function calls/mo, 0.5 GB **database** storage (fine —
     files don't live there), 20 projects, no pausing. Overage path =
     Starter pay-as-you-go (~$2/M extra calls), not a forced $25 jump.
2. **Media on the home server, not R2.** Derek has **gigabit fiber with
   ~600 Mbps upload**, so home-serving 1TB of maps is viable; Cloudflare
   Tunnel + Access are free with **no bandwidth metering**. R2 was
   considered (would be ~$15/mo for 1TB) and rejected as unnecessary. R2
   remains the fallback only if home-uptime independence is ever needed.
3. **Two separate Convex projects** — one for Home, one for D&D. Shared
   auth *patterns*, never shared databases.
4. **Auth**: Convex Auth, Password provider, no public signup page in the
   UI; optionally an email allowlist in the provider. Cloudflare Access
   (One-time PIN, free ≤50 users) independently gates the map server —
   players must pass it once in their browser before `<img>` loads work.

## Repo contents (scaffolds already written)

### `map-server/` — PowerEdge media stack
- `SETUP-TUNNEL.md` — full walkthrough: dashboard-managed tunnel creation,
  Access application + email-allowlist policy (Derek + wife + 11 players),
  deploy, caching notes, costs, caveats.
- `docker-compose.yml` — two containers: `cloudflared` (token via `.env`
  `TUNNEL_TOKEN`) + `caddy`. Volumes to adjust: `/srv/maps` (originals),
  `/srv/maps-web` (web copies).
- `Caddyfile` — serves `/originals/*` and `/web/*`; `/web` gets
  `Cache-Control: immutable` (convention: **rename files on revision**,
  never overwrite). `/healthz` endpoint for uptime monitoring (suggested:
  Home Assistant ping check so failures surface before game night).
- `make-webres.sh` — incremental mirror of the library into 2560px q80
  WebP under `/srv/maps-web`; passes `.dd2vtt`/`.uvtt` etc. through
  untouched. With 600 Mbps upload this is an optimization (client render
  speed, players' downstream), not a requirement — but run it once anyway.
- `recorder/` + `RECORDER.md` — the Session Recorder's server half: two
  more compose services from one image (`recorder-api` receives session
  audio in thirty-second slices, `recorder-worker` transcribes it with
  WhisperX and posts the transcript to Convex). Audio lands in
  `/mnt/Media/game-mastery/sessions/`, beside the maps and for the same
  reason. **The audio is deliberately never stored in Convex** — the
  free tier is 1 GB of file storage and one session is ~60 MB, and no
  Convex action can run for the four hours a transcription takes. The
  Caddyfile proxies `/recorder/*` to it, so nothing new is exposed;
  it rides the tunnel that already serves the maps.

### `convex-home-app/` — Home coordination app backend
- `SETUP.md` — install order, Convex Auth setup, R2 config, deploy.
  **NOTE:** this scaffold predates the "no R2" decision; it uses
  Convex's R2 component for attachments. Two options for Claude Code:
  (a) keep R2 free tier (10 GB) for home-app attachments — zero cost,
  works as written; or (b) swap `files.ts` to store map-server paths like
  the D&D app does. Either is fine; (a) is less work, (b) is more
  consistent. Derek hasn't expressed a preference — ask or default to (a).
- `convex/schema.ts` — `authTables` + `profiles` (displayName,
  accentColor, avatar), `tasks`, `notes`, `lists`/`listItems`, polymorphic
  `comments`, `attachments`. **Visibility pattern used everywhere:**
  optional `visibleTo` — `undefined` = shared between Derek and wife;
  set to a userId = private to that person. Filter in every listing query.
- `convex/auth.ts` — Convex Auth Password provider.
- `convex/files.ts` — R2 upload flow (generateUploadUrl → PUT → 
  syncMetadata → registerAttachment) + signed-URL serving + delete.
- `convex/comments.ts` — reactive comment threads with author join
  (`authorName`, `authorColor`, `isMine`), author-only delete.
- `convex/convex.config.ts` — registers the R2 component (remove if
  option (b) above is chosen).
- **Not yet built:** the Next.js frontend (sign-in, tasks, notes, lists,
  comments UI, upload component).

### `dnd-app/` — D&D campaign app backend
- `README.md` — architecture, per-file map, setup, Airtable migration
  table, suggested client build order.
- `convex/schema.ts` — `profiles`, `campaigns` (Derek runs **two
  groups**; `dmId` is the authority), `campaignMembers`, `characters`
  (player-owned or GM NPC sheets; `notes` = GM-only), `maps` (metadata
  only: `originalPath`/`webPath` on the map server, `tags` = locked
  vocabulary from Derek's existing Make+LLM Airtable tagging pipeline,
  grid metadata; search index on title with tag/environment filters),
  `tableState` (one doc per campaign — activeMapId, activeEncounterId,
  showGrid, banner; the players' single subscription target),
  `encounters` (prep/active/ended, round, activeCombatantId),
  `combatants` (initiative+tiebreak, HP/tempHp, conditions,
  concentration, `hidden`, `showHpToPlayers`, `dmNotes`).
- `convex/auth.ts` — Password provider + helpers: `requireUser`,
  `requireDm` (structural: GM iff `campaign.dmId === userId`),
  `requireMember` (returns `isDm` for output shaping).
- `convex/maps.ts` — `searchMaps` (text + tag), `listTags`, `addMap`,
  `getTableState` (joined with active map), GM-only `setActiveMap`,
  `setShowGrid`, `setBanner`.
- `convex/combat.ts` — the reactive combat tracker. Lifecycle
  (create/start/end; starting points tableState at the encounter + its
  map), `addCombatant` (monsters default hidden, PCs default HP-visible),
  `setInitiative`, `applyHpChange` (**damage consumes tempHp first per
  RAW; negative = healing, capped at max**), `setTempHp`,
  `toggleCondition`, `setConcentration`, `revealCombatant`,
  `removeCombatant` (advances turn first if it's theirs), `nextTurn`
  (round++ on wrap; order = initiative desc → tiebreak desc →
  _creationTime). `getEncounterView` shapes per caller: **players never
  receive hidden combatants, masked HP numbers, or dmNotes — stripped
  server-side**; masked HP still returns `hpStatus` bucket
  (healthy/injured/bloodied/down; bloodied = ≤ half).
- `convex/campaigns.ts` — `createCampaign` (auto-creates tableState),
  `myCampaigns`, `addMemberByEmail` (GM adds players after they sign up;
  note: does a `users` table scan — fine at 13 users), `listMembers`
  (with profile join), `upsertCharacter` (players edit only their own;
  players can never write GM `notes`), `listCharacters` (notes stripped
  for players).
- `convex/settings.ts` — per-person settings: theme, `viewAsPlayer`,
  the break-glass admin override, and the ribbon toolbar's token array
  (`toolbarTokens` + a separate `toolbarSet` flag, so an emptied toolbar
  is not mistaken for one nobody has arranged).
- `convex/npcs.ts`, `convex/views.ts`, `convex/notebook.ts`,
  `convex/chat.ts` — the NPC table (with per-person column layouts) and
  the Notebook and Chat tools.
- **Built since:** the player web app (Next.js, `dnd-app/`). The GM
  desktop app (Tauri) is still to come.

#### Client subsystems worth knowing about
- **The guard suite** (`npm run guards`, seven guards) — nothing is done
  until it is green. It exists because the expensive failures are silent
  ones: a string key that no longer resolves, a visibility rule that
  quietly stopped applying. A guard that cannot find what it inspects
  **fails** rather than passing quietly.
- **The ribbon toolbar** (`components/ribbonTokens.ts` and friends) — a
  Word-style customizable bar whose entire layout is one flat array of
  short strings, persisted per person. `ribbonTokens.ts` imports nothing
  so the unit guard can fuzz the grammar in isolation. Structure is
  punctuation inside the sequence, never nesting — resist making it a
  tree.
- **The Notebook** (`components/NotebookTool.tsx`,
  `notebookFormat.ts`) — a canvas of free-floating boxes with a
  contentEditable format toolbar. Two rules there are load-bearing:
  format buttons are `onMouseDown` + `preventDefault` (never `onClick`,
  which collapses the selection first), and every command routes through
  `applyScrapbookTextFormat`, which persists the result — `execCommand`
  alone changes the screen and loses the edit on reload.

## Client build plan (D&D — the agreed next work)

1. **Player web app first** (Next.js): sign-in → campaign select → map
   screen (subscribe `maps.getTableState`, render
   `${NEXT_PUBLIC_MAP_SERVER}/${activeMap.webPath}` with optional grid
   overlay from `gridSizePx`/`widthSquares`/`heightSquares`, banner) →
   combat panel (subscribe `combat.getEncounterView`; initiative list,
   active-turn highlight, HP bars or status buckets, condition chips).
   Env: `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_MAP_SERVER=https://maps.<domain>`.
2. **GM desktop app** (Tauri, reusing the React components): map picker
   (`searchMaps`/`listTags`), encounter builder, combat control surface
   (damage/heal input, next turn, reveal, conditions), table controls
   (setActiveMap/grid/banner), roster + `addMemberByEmail`.
3. **Later:** token positions / fog of war (add a `tokens` table keyed on
   encounterId with x/y — same reactive pattern), session notes, loot;
   Airtable→Convex migration script for the existing map-tag data
   (export CSV/JSON, loop `maps.addMap` via a Node script with the Convex
   client — field mapping table is in dnd-app/README.md; Derek's D&D
   Airtable base ID is `appfUI6smIcPr66MM`).

## Known caveats / things Claude Code should verify

- `@convex-dev/auth` and Convex search-index syntax
  (`withSearchIndex` + `.eq("tags", tag)` array-filter behavior) were
  written from general knowledge; expect minor compile adjustments against
  installed versions. Architecture should not change.
- Home app only: `@convex-dev/r2` component API evolves — check its README
  if callback signatures don't compile (or drop R2 per option (b) above).
- Convex free-tier resources (1M function calls/mo) are **pooled across
  all projects on the account**; combat tracker reactive queries are the
  main consumer. Watch the dashboard; avoid subscribing components to
  unpaginated giant lists (known Convex bandwidth footgun: updating one
  item in a subscribed list re-sends the list).
- Cloudflare free-plan ToS tolerates personal-scale media serving; don't
  turn the map server into a public/commercial host.
- The PowerEdge is now game-night infrastructure: map storage should be on
  redundant disks or have a backup job; add an uptime check on
  `https://maps.<domain>/healthz`.
- Map revision convention: new filename, never overwrite (immutable cache
  headers).
- Players must visit the maps domain once to pass Cloudflare Access before
  map images will load inside the app.

## Immediate next task for Claude Code

The player web app is built and deployed. Next up, in rough order:

1. **The GM desktop app** (Tauri, reusing these React components) — see
   step 2 of the client build plan above.
2. **AI portrait generation** for NPCs. The upload half is done
   (`npcs.setPortrait`, direct-to-storage). Generation needs an image
   provider, which is the first paid service the project would take on,
   so **ask Derek before picking one**.
3. **The unbuilt nav sections** — Sessions, Shops, Locations, Calendar,
   Dice Roller, Combat Tracker (client), Scheduler, and the Asset
   Library. They render greyed in the sidebar today; to bring one
   online, add its page under `app/campaign/[campaignId]/<slug>/` and
   give it a `slug` in `components/navItems.ts`.
