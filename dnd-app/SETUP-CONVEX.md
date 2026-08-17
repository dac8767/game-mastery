# Convex Database Setup — D&D App (Table View)

Step-by-step to take `dnd-app/` from a fresh clone to a live, populated
Convex database. Run these on your own machine — `npx convex dev` needs a
browser login and network access to convex.dev.

Verified against the versions actually installed here: `convex@1.42.3`,
`@convex-dev/auth@0.0.94`, `@auth/core@0.41.2`, `next@16.2.10`.

**Nothing needs to be rebuilt.** The schema and all backend functions are
already written and typecheck clean. This is wiring, not authoring.

---

## What you're setting up

| Piece | Where it lives | Cost |
|---|---|---|
| Database + functions + realtime + auth | Convex free tier (one project, separate from the Home app) | $0 |
| Map/portrait images | PowerEdge behind the Cloudflare tunnel — **not** in Convex | $0 |
| Player web frontend | Next.js (local now, Vercel Hobby later) | $0 |

Convex free tier: 1M function calls/mo, **0.5 GB database storage**, 20
projects, **no idle pausing**. Your rows are small metadata records — map
paths, tags, HP numbers — so thousands of them is on the order of tens of
megabytes. Storage is not your constraint; function calls are.

---

## Step 1 — Install dependencies

```bash
cd dnd-app
npm install
```

## Step 2 — Create the Convex project and push the schema

```bash
npx convex dev
```

This is the command that actually creates your database. It will:

1. Open a browser to log in (GitHub or Google) if this machine isn't
   already authenticated.
2. Ask whether to create a new project or use an existing one. Choose
   **create a new project** and name it something like `dnd-app`.
   > **Do not reuse the Home app's project.** Two separate Convex
   > projects is a standing architecture decision — shared auth
   > *patterns*, never shared databases. The free tier allows 20
   > projects, so there is no reason to merge them.
3. Write `.env.local` for you, containing `CONVEX_DEPLOYMENT` and
   `NEXT_PUBLIC_CONVEX_URL`.
4. Read `convex/schema.ts` and **create every table and index** on the
   deployment — this is the "building the database" step. It also pushes
   `auth.ts`, `campaigns.ts`, `maps.ts`, `combat.ts`, `http.ts`.
5. Regenerate `convex/_generated/`. That directory is committed so fresh
   clones typecheck; `convex dev` overwrites it. Never hand-edit it, and
   commit the regenerated version if it changes.

`convex dev` then **stays running and watches for changes** — every save
to a file in `convex/` re-pushes automatically. Leave it in its own
terminal and open a second one for the remaining steps.

Expected on success: a list of the tables it created, then
`Convex functions ready!`.

## Step 3 — One-time auth setup

```bash
npx @convex-dev/auth --web-server-url http://localhost:3000
```

This generates the signing keys the Password provider needs and sets them
as environment variables **on the deployment** (not in your local env):
`JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL`.

Skipping this is the single most common way to get a working database but
a sign-in screen that fails — without the keys, Convex Auth can't mint or
verify tokens, and `convex/auth.config.ts` has nothing to validate
against.

Verify:

```bash
npx convex env list
```

You should see `JWKS`, `JWT_PRIVATE_KEY`, and `SITE_URL`.

## Step 4 — Add the map server URL

`npx convex dev` already created `.env.local` in Step 2, so **do not**
`cp .env.local.example .env.local` over it — that would wipe your
deployment URL. Instead open `.env.local` and add one line:

```
NEXT_PUBLIC_MAP_SERVER=https://maps.yourdomain.com
```

Final `.env.local` should have three entries:

```
CONVEX_DEPLOYMENT=dev:your-deployment-name      # written by convex dev
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
NEXT_PUBLIC_MAP_SERVER=https://maps.yourdomain.com
```

`.env.local` is gitignored — it never gets committed.

## Step 5 — Confirm the database exists

```bash
npx convex data
```

Lists the tables on the deployment. You should see the auth tables
(`users`, `authAccounts`, `authSessions`, …) alongside `campaigns`,
`campaignMembers`, `characters`, `maps`, `tableState`, `encounters`,
`combatants`.

To view it in the browser (data browser, logs, function runner, usage
meter):

```bash
npx convex dashboard
```

## Step 6 — Create your account

```bash
npm run dev          # second terminal; convex dev keeps running in the first
```

Open http://localhost:3000, click **"First time? Create an account"**, and
sign up with your email and a password.

Verify the row landed:

```bash
npx convex data users
```

Copy your `_id` — you need it in the next step.

## Step 7 — Create your first campaign

After signing up you'll land on *"You're not in a campaign yet."* That's
expected, and it's a real gap rather than a bug: `createCampaign` is a DM
action, and **the DM app isn't built yet**, so no UI calls it. The player
web app only ever *lists* campaigns.

Seed it from the CLI instead. Every game-state function calls
`requireUser`/`requireDm`, so a plain `npx convex run` would fail with
"Not signed in" — you have to run *as yourself* with `--identity`:

```bash
npx convex run campaigns:createCampaign \
  '{"name":"Episode X — Valenar"}' \
  --identity '{"subject":"YOUR_USER_ID|seed"}'
```

Replace `YOUR_USER_ID` with the `_id` from Step 6. The `|seed` suffix
matters: Convex Auth stores the subject as `userId|sessionId` and splits
on `|`, taking the first half as the user ID. Anything after the pipe is
ignored by `getAuthUserId`.

This creates the campaign **and** its `tableState` document (the single
doc every player screen subscribes to) in one mutation. Because
`createCampaign` sets `dmId` to the calling user, you become the DM
structurally — there's no role field to set.

Run it a second time for your other group.

Refresh http://localhost:3000 and both campaigns should appear with a
**DM** badge, live, without a reload.

> On Windows PowerShell, single-quoted JSON won't parse — use
> `--% ` or escape the double quotes.

## Step 8 — Add your players

Players sign up themselves first (same "Create an account" button), then
you add them by the email they used:

```bash
npx convex run campaigns:addMemberByEmail \
  '{"campaignId":"CAMPAIGN_ID","email":"player@example.com"}' \
  --identity '{"subject":"YOUR_USER_ID|seed"}'
```

It throws a clear error if that email hasn't registered yet, so ordering
is enforced for you.

## Step 9 — Import the map library

**Do not loop `maps.addMap` for a bulk import.** It works for a handful of
maps, but thousands of calls burn thousands of function calls out of the
1M/mo budget that is *pooled across every Convex project on your account*,
and each one needs an authenticated identity. Use the bulk importer, which
writes to the table directly:

```bash
npx convex import --table maps maps.jsonl --append
```

Format is one JSON object per line, with fields matching `schema.ts`
exactly. Omit `_id` and `_creationTime` — Convex assigns those:

```jsonl
{"title":"Sunken Crypt","originalPath":"originals/dungeons/sunken-crypt.png","webPath":"web/dungeons/sunken-crypt.webp","tags":["dungeon","water","undead"],"environment":"dungeon","gridSizePx":70,"widthSquares":30,"heightSquares":22}
```

Field mapping from your existing Airtable base (`appfUI6smIcPr66MM`):

| Airtable field | Convex field |
|---|---|
| Map title | `title` |
| Locked-vocabulary tags | `tags` (array of strings) |
| File path/name | `originalPath` + `webPath` (same relative path; `.webp` under `web/`) |
| Environment/category | `environment` |
| Grid metadata | `gridSizePx`, `widthSquares`, `heightSquares` |

Import validates against the schema, so a malformed row fails the batch
rather than silently corrupting the table. Test with a 5-line file first,
check `npx convex data maps`, then run the full import.

## Step 10 — Production (when you're ready to deploy)

```bash
npx convex deploy                                    # creates the prod deployment
npx @convex-dev/auth --prod --web-server-url https://your-app.vercel.app
```

Then set `NEXT_PUBLIC_CONVEX_URL` (the **prod** URL) and
`NEXT_PUBLIC_MAP_SERVER` in Vercel's environment variables. Dev and prod
are separate deployments with separate data — seeding dev does not seed
prod, so Steps 6–9 get repeated against prod.

---

## Gotchas

- **`convex dev` must be running** for backend edits to take effect. A
  stale deployment silently serves old function code.
- **`convex/_generated/` is committed and overwritten.** If `convex dev`
  changes it, commit the result; never hand-edit.
- **Two projects, never merged.** The Home app is a separate Convex
  project. Nothing in this repo should ever point at both.
- **Function calls are the metered resource, not storage.** The combat
  tracker's reactive subscriptions are the main consumer. Avoid
  subscribing a component to a large unpaginated list — updating one item
  re-sends the whole list, which is the known Convex bandwidth footgun.
- **Players must pass Cloudflare Access once** in their browser before
  `<img>` loads from the map server will work. Send them the maps URL
  before session one.
- **Map revisions get a new filename, never an overwrite** — `/web` is
  served with immutable cache headers.

## Verifying the whole thing still compiles

```bash
npm run typecheck && npx tsc --noEmit -p convex && npm run build
```

`npm run build` requires `NEXT_PUBLIC_CONVEX_URL` to be set — without a
deployment it fails at prerender with "No address provided to
ConvexReactClient", which is a missing env var, not a code error.
