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

### Convex is not installed on a machine you own

Convex is a **hosted cloud service**. `npx convex dev` is a developer CLI
that pushes your schema and functions up to Convex's infrastructure; the
database itself lives there. There is no Convex daemon, container, or
service to keep running on your own hardware, and nothing to back up
locally.

Practical consequences:

- The D&D database does **not** depend on the PowerEdge being up. If that
  box dies, map *images* stop serving; campaigns, characters, and combat
  state are unaffected.
- You can run this setup from any machine — laptop, desktop, or the
  PowerEdge. It's the same cloud deployment either way.
- Running it **from the PowerEdge is a good choice for Step 9**, because
  the map library is already on that filesystem, so you can generate the
  import file from the real directory tree without copying anything.

The PowerEdge's actual job in this architecture is unrelated: Docker
running `cloudflared` + Caddy to serve map images. That's `map-server/`,
a separate setup with its own guide.

---

## Step 0 — Starting from a bare machine

Skip this if you already have the repo and Node 20.9+.

Any desktop OS works and reaches the same cloud deployment. Both macOS
and desktop Linux have a browser, so the Convex login in Step 2 opens
automatically and needs no special handling.

**Node.js 20.9 or newer is the hard requirement** — that's Next.js 16's
floor. Everything else below is just how you get there.

### macOS

macOS ships no Node at all, and any Node you installed years ago is
likely too old. Install Homebrew if you don't have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

On Apple Silicon, Homebrew installs to `/opt/homebrew` and the installer
prints a line to add it to your PATH — run it, or `brew` won't be found
in new shells:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Then:

```bash
brew install node git
node --version      # must print v20.9.0 or higher
```

`git` may already be present via Xcode Command Line Tools; if `git
--version` prompts you to install them, either accept the prompt or run
`xcode-select --install`.

**If the Homebrew installer ends with `Failed during: brew update`,
Homebrew still installed correctly.** That final step refreshes every
configured tap, and it aborts if any *third-party* tap can't be fetched —
commonly a corporate tap on a work machine whose credentials have
expired (e.g. an Azure DevOps–hosted tap returning "Authentication
failed"). As long as the output says `Updated 2 taps (homebrew/core and
homebrew/cask)`, the tap that Node comes from is current. Verify with
`brew --version` and carry on with `brew install node`.

To stop the error recurring, drop the unreachable tap with `brew untap
<tap-name>` — but only if you don't rely on the tooling it provides.

**Homebrew-free alternative:** nothing else in this project needs
Homebrew. If it's more trouble than it's worth on a managed machine,
install Node from the official macOS `.pkg` at <https://nodejs.org>
(take LTS) and use the Xcode Command Line Tools `git`.

### Pop!_OS / Ubuntu / Debian

The `nodejs` package in the default apt repos is far older than 20.9
(often Node 12 or 18), so installing it will fail later with a confusing
build error. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version      # must print v20.9.0 or higher
```

(`nvm` works on either OS if you'd rather not install Node system-wide —
follow the install line in the nvm README, then `nvm install 22`.)

### Clone the repo (both platforms)

```bash
git clone https://github.com/dac8767/game-mastery.git
cd game-mastery
git checkout claude/game-mastery-db-setup-jaeuln
```

That branch is where this guide lives; it hasn't been merged to `main`
yet.

## Step 1 — Install dependencies

```bash
cd dnd-app
npm install
```

**If npm ends with an `allow-scripts` warning**, approve the two install
scripts before continuing:

```
npm warn allow-scripts   esbuild@0.27.0 (postinstall: node install.js)
npm warn allow-scripts   sharp@0.34.5 (install: node install/check.js || npm run build)
```

Recent npm versions block package install scripts by default. Both of
these exist to put a native binary in place, and **esbuild is not
optional here** — it's a direct dependency of `convex`, which uses it to
bundle your `convex/` functions before every push. If its binary isn't
set up, `npx convex dev` fails with an esbuild binary error rather than
anything that points at Convex. `sharp` is Next.js's image processor.

```bash
npm approve-scripts esbuild
npm approve-scripts sharp
npm install                # re-run so the approved scripts execute
```

Approve one package per invocation. `npm approve-scripts
--allow-scripts-pending` only *lists* what's pending — it reviews rather
than approves, and leaves the warning in place.

Confirm it took: the `allow-scripts` warning should be gone from the tail
of `npm install`.

## Step 2 — Create the Convex project and push the schema

```bash
npx convex dev
```

This is the command that actually creates your database. It will:

1. Open a browser to log in (GitHub or Google) if this machine isn't
   already authenticated. **There's no separate signup step** — if you
   don't have a Convex account yet, you create one in that browser flow
   and the CLI picks the token up automatically. No credit card for the
   free tier.
   > Check *which* identity the browser offers before approving. That
   > account owns the project, free-tier resources are pooled per
   > account, and the Home app is meant to live under the same one — so
   > on a machine that's signed into a work GitHub account, make sure the
   > OAuth flow isn't silently using it. Moving a project between
   > accounts later is a hassle.
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

**If you only want a one-shot push** (no watcher — useful on a machine
where you aren't editing backend code), use:

```bash
npx convex dev --once
```

**On a headless machine with no browser**, log in first with the paste
flow, then run `convex dev` normally:

```bash
npx convex login --no-open --login-flow paste --device-name poweredge
npx convex login status      # confirms the token and lists your teams
```

It prints a URL to open on another machine; you paste the resulting token
back into the terminal. Not needed on a desktop Linux install.

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
npx convex env list --names-only
```

You should see `JWKS`, `JWT_PRIVATE_KEY`, and `SITE_URL`.

**Use `--names-only`.** Plain `npx convex env list` prints every value in
full, including the RSA private key that signs your auth tokens — which
then lives in your terminal scrollback, and in the transcript of any
screen share or AI session you paste it into. Anyone with that key can
mint valid sessions for your deployment and impersonate any user,
including the DM.

If it does get exposed, rotate immediately — it's free before players
have accounts, and signs everyone out after:

```bash
npx convex env remove JWT_PRIVATE_KEY
npx convex env remove JWKS
npx @convex-dev/auth --web-server-url http://localhost:3000   # regenerates both
```

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

## Step 9b — Import the NPC roster

Same reasoning as the maps: bulk import writes straight to the table, so
a 200-row (or 20,000-row) load costs no function calls.

**Push the schema first.** The `npcs` table has to exist in the deployed
schema before an import will validate against it, so make sure
`npx convex dev` has run since the table was added.

```bash
# 1. Airtable CSV -> JSONL (campaignId comes from `npx convex data campaigns`)
node scripts/import-npcs.mjs ~/Downloads/NPCs-Master_List.csv <campaignId> -o npcs.jsonl

# 2. Load it
npx convex import --table npcs npcs.jsonl --append
```

The converter prints a summary (how many rows carry secrets, portraits,
descriptions) so a column that silently exported blank is visible before
you import rather than after.

Re-importing the same file with `--append` **duplicates** every row. To
replace the roster instead, use `--replace`.

Portraits: Airtable attachment URLs are signed and expire, so the
converter keeps only a derived path — `web/portraits/npcs/<npc-name>.<ext>`.
Download the images out of Airtable before those links die, rename them
to match, and drop them on the map server; the drawer picks them up with
no further changes.

## Step 9c — Import from Foundry VTT

If your content is already in Foundry — including anything MrPrimate's
**ddb-importer** pulled in from D&D Beyond — this reads Foundry's export
format directly. The pipeline is:

```
D&D Beyond --(ddb-importer)--> Foundry --(import-foundry.mjs)--> Game Mastery
```

This is **not** a port of ddb-importer, and could not be: that module's
D&D Beyond half is an authenticated proxy service rather than a file, and
its shipped code is a bundled `dist/main.mjs`. What it leaves behind in
Foundry, though, is a documented JSON shape, and that is what this reads.

### Getting the data out of Foundry

- **One document:** right-click it → *Export Data* → a `.json` file.
- **A folder or compendium:** right-click → *Export*. On Foundry v11+
  compendium packs are LevelDB (binary) on disk, so export to JSON from
  inside Foundry rather than copying the pack directory.
- **A whole v10-or-earlier world:** the `.db` files under
  `Data/worlds/<world>/data/` are JSON-per-line and can be read as-is.

#### The whole world, from the console

Faster than right-clicking four sidebars. Open Foundry with the world
loaded, press F12, and paste:

```js
const docs = [
  ...game.actors.contents,
  ...game.items.contents,
  ...game.journal.contents,
  ...game.scenes.contents,
].map((d) => d.toObject());

ui.notifications.info(
  `actors ${game.actors.size} · items ${game.items.size} · ` +
  `journals ${game.journal.size} · scenes ${game.scenes.size}`
);

const a = document.createElement("a");
a.href = URL.createObjectURL(
  new Blob([JSON.stringify(docs)], { type: "application/json" })
);
a.download = "foundry-everything.json";
a.click();
```

#### One Journal folder, and nothing else

For when the whole world is more than you want — a `Rules` folder, say,
without every scene and stat block alongside it. Change `FOLDER_NAME`
for any other folder.

It differs from the snippet above in three ways that matter: it walks
**subfolders**, so `Rules / Combat / Grappling` comes too; it counts
**pages** as well as entries, because a v10+ JournalEntry keeps its text
in pages and three entries can be three hundred pages or three empty
shells; and it **refuses to download an empty file**, saying which
folders it did find instead. An export that silently produces `[]` is
one you discover two steps later.

```js
(() => {
  const FOLDER_NAME = "Rules";

  // A folder or an id, depending on the Foundry version. Normalised
  // once here so nothing below has to care which it got.
  const asFolder = (x) =>
    !x ? null : typeof x === "string" ? (game.folders.get(x) ?? null) : x;

  // Journal folders only — an Actor folder called "Rules" is not this.
  // `type` is the document type in v10+; older worlds kept it on `data`.
  const journalFolders = game.folders.filter(
    (f) => (f.type ?? f.data?.type) === "JournalEntry"
  );

  const wanted = FOLDER_NAME.trim().toLowerCase();
  const roots = journalFolders.filter(
    (f) => (f.name ?? "").trim().toLowerCase() === wanted
  );

  if (roots.length === 0) {
    ui.notifications.error(
      `No Journal folder called "${FOLDER_NAME}". Journal folders here: ` +
        (journalFolders.map((f) => f.name).join(", ") || "none")
    );
    return;
  }

  const rootIds = new Set(roots.map((f) => f.id));

  // Subfolders count: "Rules / Combat / Grappling" is still Rules.
  // A depth cap rather than a visited set — the only way a parent
  // chain loops is corruption, and fifty levels of journal folders is
  // already not a thing anyone has.
  const underRules = (folder) => {
    let f = asFolder(folder);
    for (let depth = 0; f && depth < 50; depth++) {
      if (rootIds.has(f.id)) return true;
      f = asFolder(f.folder);
    }
    return false;
  };

  const docs = game.journal
    .filter((e) => underRules(e.folder))
    .map((e) => e.toObject());

  const pages = docs.reduce((n, d) => n + (d.pages?.length ?? 0), 0);

  if (docs.length === 0) {
    ui.notifications.warn(
      `"${FOLDER_NAME}" exists but holds no journal entries — nothing ` +
        "was downloaded."
    );
    return;
  }

  ui.notifications.info(
    `${docs.length} journal(s) · ${pages} page(s) from "${FOLDER_NAME}"` +
      (roots.length > 1 ? ` — ${roots.length} folders of that name` : "")
  );

  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(docs)], { type: "application/json" })
  );
  a.download = "foundry-rules.json";
  a.click();
})();
```

Both are wrapped so they can be pasted twice into one console session —
a bare `const` at the top level fails the second time with "already
been declared", which reads as the snippet being broken.

**Note on what reads it.** `import-foundry.mjs` uses journals only as
descriptions for the scene notes that reference them; it has no path
that turns a journal into a **Rules Lawyer** entry. That table is fed by
`import-srd.mjs`, which wants **markdown**. So `foundry-rules.json` is
an export with no importer behind it yet — worth knowing before you go
looking for where it landed.

Point the script at a file or a directory of them:

```bash
# campaignId comes from `npx convex data campaigns`
node scripts/import-foundry.mjs ~/foundry-export <campaignId> -o foundry-import
```

It prints what it found before anything is written, so an export that
turned out to hold nothing you wanted is visible immediately.

### Loading it

NPCs go through the bulk path, same as the Airtable roster:

```bash
npx convex import --table npcs foundry-import/npcs.jsonl --append
```

Locations cannot: a pin has to reference the map it sits on, and those
ids do not exist until the rows are created. So they go through one
DM-gated mutation, which needs to run **as you**:

```bash
npx convex run locations:importLocations "$(cat foundry-import/locations.json)" \
  --identity '{"subject":"YOUR_USER_ID|seed"}'
```

(`YOUR_USER_ID` is the same id used in Step 7 — `npx convex data users`.)

### What maps to what

| Foundry | Game Mastery |
|---|---|
| Actor, type `npc` | an NPC row |
| Actor, type `character` | skipped — a PC belongs to its player |
| Scene | a location, with the scene image as its map |
| Scene note | a child location, pinned where the note was |
| JournalEntry | the description of the location its note names |

A scene's notes are already pins at coordinates on a map, which is
exactly the shape the Locations tool wants. Foundry stores those
coordinates as absolute pixels within the scene; they are divided by the
scene's dimensions on the way in, because Game Mastery stores pins
normalized 0–1 so they survive the map being re-scanned at a different
size.

**Images are not copied.** Foundry paths like
`worlds/moonbrook/scenes/coast.webp` are written through as
`mapPath` / `portraitPath` — put the files on the map server under those
paths and they resolve, or ignore them and upload through the app.
Foundry's own placeholder icons (`icons/svg/mystery-man.svg` and friends)
are deliberately skipped, or every un-illustrated NPC would share one
portrait that then 404s.

Re-running `--append` **duplicates** NPC rows, and re-running the
locations mutation creates a second copy of the tree. Both are additive
by design; delete before re-importing rather than after.

## Step 10 — Deploy to a real URL

**GitHub hosts the code; it does not run the app.** GitHub Pages serves
static files only — no server rendering, no build-time environment
variables, no rewrites — so it's the wrong target for a Next.js app.
Vercel is the host in the architecture plan, it's free on Hobby, and it
builds straight from the GitHub repo, so a `git push` becomes a deploy.

### One-time setup

1. Push the branch and merge it to `main` (or point Vercel at the branch).
2. vercel.com → **New Project** → import `dac8767/game-mastery`.
3. **Root Directory:** `dnd-app` — the repo root is not the app.
4. **Build Command:** `npx convex deploy --cmd 'npm run build'`
   This pushes the Convex schema and functions to **production**, then
   builds Next.js with `NEXT_PUBLIC_CONVEX_URL` already pointed at the
   prod deployment. You do not set that variable by hand.
5. **Environment variables** in Vercel:
   - `CONVEX_DEPLOY_KEY` — generate in the Convex dashboard under
     Settings → Deploy Keys → Production. This is what lets the build
     deploy on your behalf; treat it as a secret.
   - `NEXT_PUBLIC_MAP_SERVER` — `https://maps.<yourdomain>`
6. Deploy, then point Convex Auth at the live origin:

```bash
npx @convex-dev/auth --prod --web-server-url https://<your-app>.vercel.app
```

7. **Prod is a separate database.** Steps 6–9 repeat against it: create
   your account on the live URL, seed the campaign with
   `npx convex run ... --prod`, and re-run the NPC import with
   `npx convex import --prod`.

After that, shipping is `git push`. Vercel rebuilds, Convex takes the
schema and function changes in the same step, and there is no terminal
to babysit.

### Local development in one terminal

`npm run dev` now runs both halves together — the Convex watcher and the
Next dev server share one terminal:

```json
"dev": "convex dev --start 'next dev'"
```

`npm run dev:web` and `npm run dev:convex` still run them separately if
you ever want to isolate one.

## Backups

Convex holds the data in the cloud, so a dead laptop costs you nothing.
What it does not protect against is a bad import or a schema change that
drops a field — `--replace` and `--replace-all` on `convex import` are
the realistic ways to lose a roster.

Take a snapshot before any bulk data operation:

```bash
npx convex export --path "backups/$(date +%F)-dev.zip"           # dev
npx convex export --prod --path "backups/$(date +%F)-prod.zip"   # production
```

Add `--include-file-storage` if files are ever stored in Convex (map
images live on the PowerEdge, so today they aren't).

Restore by importing the snapshot back:

```bash
npx convex import backups/2026-08-18-prod.zip --prod
```

Keep the `backups/` directory out of git — snapshots contain the full
database, DM notes and secrets included.

---

## Working from more than one computer

Yes — the project is designed for this. The code lives in git and the
database lives in Convex's cloud, so any machine with the repo and a
login reaches the same deployment. What does *not* travel is `.env.local`
(it's gitignored), so each machine needs a one-time link.

On the second machine, do Step 0 and Step 1 as written, then:

```bash
npx convex dev --configure existing
```

**Use `--configure existing`, not a bare `npx convex dev`.** A bare run
prompts you to create a new project or use an existing one, and choosing
"new" silently gives you a *second, empty* database — your campaigns and
maps will appear to have vanished when in fact you're pointed at a
different deployment. The flag makes the choice explicit. You can skip
the prompts entirely with `--team <team-slug> --project <project-slug>`.

Then re-add the map server line to the freshly written `.env.local`:

```
NEXT_PUBLIC_MAP_SERVER=https://maps.yourdomain.com
```

**Do not re-run `npx @convex-dev/auth` on the second machine.**
`JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL` are set on the *deployment*,
not on your computer, so they're already in place. Regenerating the keys
would sign out every existing session.

### Two rules for multi-machine work

1. **Only one `npx convex dev` watcher at a time.** Each watcher pushes
   its own local copy of `convex/` to the shared dev deployment. If a
   machine with older code has a watcher running, it will overwrite a
   newer push from the other machine. When you just need a push rather
   than a live watch, use `npx convex dev --once`.
2. **`git pull` before you start, and commit `convex/_generated/`.** That
   directory is committed so fresh clones typecheck, but `convex dev`
   rewrites it — so it can show up as a diff on both machines. If it
   ever conflicts, take either side and re-run `npx convex dev` to
   regenerate it cleanly.

Data itself never needs syncing: it's in the cloud, so a campaign you
create from the PowerEdge is instantly visible from the laptop.

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
