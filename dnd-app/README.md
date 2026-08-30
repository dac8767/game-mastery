# D&D Campaign App — Backend (Convex)

Shared backend for two clients:
- **GM app** (desktop — Tauri recommended, Electron works): full control
  surface. Encounter prep, combat tracker, map picker, reveal/hide.
- **Player app** (Next.js web): subscribes to table state + encounter
  view. Shows the active map, initiative order, and whatever the GM has
  made visible.

Map images are served from the PowerEdge behind the Cloudflare tunnel
(`maps.yourdomain.com`); Convex stores only paths + metadata.

## Files

| File | Purpose |
|---|---|
| `convex/schema.ts` | All tables: campaigns, members, characters, maps, tableState, encounters, combatants |
| `convex/auth.ts` | Convex Auth (Password) + `requireUser` / `requireDm` / `requireMember` helpers |
| `convex/campaigns.ts` | Campaign creation, member roster (add by email), character sheets |
| `convex/maps.ts` | Map library search (title + locked-vocabulary tags), live table state (active map, grid, banner) |
| `convex/combat.ts` | The combat tracker: encounter lifecycle, initiative, turns, HP/temp HP, conditions, concentration, hidden/reveal |

## Core design decisions

**Authority is structural.** You are "the GM" of a campaign iff
`campaign.dmId === userId`. Every game-state mutation calls `requireDm`;
there is no role field to desync.

**One subscription per screen.**
- Player map screen → `maps.getTableState` (active map, grid, banner,
  active encounter pointer)
- Player/GM combat screen → `combat.getEncounterView` (shaped
  server-side: players never receive hidden combatants, masked HP values,
  or `dmNotes` — the data physically doesn't leave the server)

**Player HP masking with narrative fallback.** When `showHpToPlayers` is
false, players still get an `hpStatus` bucket
(`healthy / injured / bloodied / down`) so "how hurt is it?" has an
answer without exposing numbers.

**Damage follows RAW.** `applyHpChange` consumes temp HP before real HP;
healing caps at max. Negative amounts heal.

**Turn order** sorts by initiative desc → tiebreak desc → creation time,
and the round counter increments when the order wraps.

## Setup

```bash
npm install convex @convex-dev/auth @auth/core
npx convex dev          # push schema, generate types
npx @convex-dev/auth    # one-time auth setup
```

Set the map server base URL in each client's env:

```
NEXT_PUBLIC_MAP_SERVER=https://maps.yourdomain.com
```

Clients build image URLs as `${NEXT_PUBLIC_MAP_SERVER}/${map.webPath}`.
Players must have passed Cloudflare Access once in their browser for
`<img>` loads to succeed — send them the maps URL to log in before
session 1.

## Migrating your Airtable map tags

Your existing tagging pipeline's output maps 1:1 onto the `maps` table:

| Airtable field | Convex field |
|---|---|
| Map title | `title` |
| Locked-vocabulary tags | `tags` (string array) |
| File path/name | `originalPath` + `webPath` (derive: same relative path, `.webp` extension under `web/`) |
| Environment/category | `environment` |
| Grid metadata (if captured) | `gridSizePx`, `widthSquares`, `heightSquares` |

Export the Airtable table to CSV/JSON, then loop `maps.addMap` from a
one-off Node script using the Convex client — or ask for the migration
script and it'll be written against your actual base structure.

## Suggested build order (clients)

1. **Player web app** first — it's small: sign-in, campaign select, map
   screen (`getTableState`), combat panel (`getEncounterView`). Gets your
   players onboarded and exercises the whole reactive path.
2. **GM desktop app** — Tauri + the same React components, plus the
   control surfaces: map picker (searchMaps/listTags), encounter builder,
   combat controls. Because both clients speak to the same Convex
   deployment, everything you verify in the web app carries over.
3. Later: fog of war / token positions (add a `tokens` table keyed on
   encounterId with x/y — same reactive pattern), session notes, loot.
