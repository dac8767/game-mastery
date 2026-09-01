# Tools — who owns what

**Read this before starting work in a fresh chat.** It says which files
belong to which tool, so two chats working at the same time do not
write to the same file.

The rule is one chat per tool. If your task is inside one tool, you can
work in parallel with any other tool's chat. If your task crosses tools
— or touches anything under **Common** or **Layers** below — it runs
alone.

Derived from the app as it stands, not invented: 11 of these already
have their own `convex/<tool>.ts` module and their own route. The
boundaries were there; this file writes them down.

---

## How to start a chat

**0. Cut your branch from `origin/main`, by name, and look at what you
cut from.**

```bash
git fetch origin main
git log --oneline -1 origin/main        # read this line
git checkout -b claude/tool-<id> origin/main
```

`main` IS the app. It was not always — until 1 September 2026 the trunk
was a long-named branch and `main` was a six-week-old skeleton, which
cost one session an afternoon of work against a screen that did not
exist. The tool branches were consolidated into `main` that day and it
is now the only trunk. If you find a `claude/game-mastery-db-setup-*`
branch, it is a leftover.

**Name `origin/main` explicitly.** `git checkout -b <name>` on its own
branches from your local HEAD, which in a fresh or shallow clone can be
far behind — that has produced a whole branch built against a filename
that no longer existed, in the sibling repo, on the same day. Printing
the commit you are building on is how you notice before you start.

```bash
cd dnd-app
git fetch origin claude/game-mastery-db-setup-jaeuln
git checkout claude/game-mastery-db-setup-jaeuln
```

1. Read `CLAUDE.md` (standing preferences, guard rules).
2. Read this file. Find your tool. **Those files are yours.**
3. Work on `claude/tool-<id>`, cut from the trunk named in step 0.
4. Run `npm run guards` before pushing. Rebase, don't merge.
5. Say in your final message whether you changed `convex/schema.ts`, so
   the paste blocks get run in the right order.

Anything not listed under your tool, treat as read-only. Reading another
tool's file never conflicts; editing it does.

---

## GM, not DM

The app's word for the person running the game is **Game Master**, and
it says GM everywhere a person reads.

**The code still says `dm`, and that is deliberate.** `dmId`, `dmNotes`,
`dmOnly`, `isDm`, `requireDm`, the `dmScreens` and `dmWorkspaces`
tables, the `dm-screen` route, `convex/dmscreen.ts`, the `.dm-tag`
class, `"dm"` as a page side — none of them were renamed, for three
separate reasons:

- **Stored field and table names cannot be renamed in place.** A Convex
  object validator is strict, so a row carrying the old key stops
  matching the schema and `convex dev` refuses to push — the app does
  not start. This already happened once with a sidebar field.
- **Convex module names are the API path.** Renaming `dmscreen.ts`
  changes `api.dmscreen.*` and needs codegen, which needs network the
  sandbox may not have.
- **Nav ids are stored in saved ribbons.** `toolbarTokens` holds
  `t:dm-screen`; renaming the id silently drops that button from
  anyone's saved layout, because normalizeRibbon discards tokens it
  does not recognise.

So: **change the words, leave the names.** A label is GM; an identifier
is `dm`.

Three strings contain "DM" and are NOT this app's vocabulary. The
integrity guard pins all three, because getting them wrong is silent:

- `sourceNames.ts` — "Dungeon Master's Guide" is a book's actual title
- `lookupFilters.ts` — the same book, named in the edition note
- `scripts/import-npcs.mjs` — `col(r, "DM Notes")` is a column header in
  the Airtable export. `col()` returns `""` for a header it cannot
  find, so renaming it imports every NPC with blank notes and reports
  success

---

## Tools

Each owns its files outright. `Reads` means it consumes another tool's
backend without owning it — safe in parallel.

### calendar — World Calendar
```
Owns    components/CalendarTool.tsx, components/calendarModel.ts
        convex/calendar.ts
        app/campaign/[campaignId]/calendar/
Tables  calendars, calendarEvents
Branch  claude/tool-calendar
```

### chat — Chat
```
Owns    components/ChatTool.tsx
        convex/chat.ts
        app/campaign/[campaignId]/chat/
Tables  messages
Branch  claude/tool-chat
```

### dice — Dice Roller
```
Owns    components/DiceRoller.tsx, components/diceModel.ts
        convex/dice.ts
        app/campaign/[campaignId]/dice/
Tables  diceRolls
Branch  claude/tool-dice
```
The dice are thrown in `convex/dice.ts` and nowhere else. The client
parses the notation to say what the box MEANS and to grey out a typo;
it never produces a face. A mutation that accepted a total would be a
mutation that accepted a natural 20 every time.

A secret roll is filtered on the way OUT of `listRolls`, not hidden in
the UI — same rule as a dmOnly channel. A player must not learn that
the GM rolled at all.

`critOfDice` is the one answer to "is this a crit", used by both the
log (reading a stored row) and a fresh throw. Two implementations
would drift, and that one is on screen when people cheer.

3D dice come from dddice (`dddice-js`), and it DRAWS only — every die
is sent with its face already set. Remove the canvas and every number
on screen is unchanged, which is also the failure model: no WebGL, no
network, a refused room, a pool over the room's limit all leave the
2D log exactly as it was.

No dddice API key is stored anywhere. Each browser mints its own guest
account (`api.user.guest()`) into localStorage. The room passcode IS
stored, and reaches a browser only through `getRoom`, which checks
campaign membership first — it grants rolling dice in one room, not
account access.

A secret roll is never sent to dddice at all. Their `is_hidden` would
make privacy depend on every other client honouring a flag.

dddice has no d100 mesh: a percentile is a `d10x` plus a `d10`, and
73 is a 70 and a 3 — with 100 as 90+10 and 5 as 0+5, since the units
die has no zero face. Rooms default to a 25-dice limit and a
percentile die costs two.

### combat — Combat Tracker
```
Owns    components/CombatPanel.tsx
        convex/combat.ts
Tables  encounters, combatants
Mounted in  TableScreen (maps) — see the cross-mount note below
Branch  claude/tool-combat
Note    Player-facing shape is server-side: hidden combatants and
        masked HP must never leave the server for a non-GM caller.
        See combat.getEncounterView.
```

### dmscreen — GM Screen
```
Owns    components/DmScreen.tsx, components/dmScreenModel.ts
        convex/dmscreen.ts
        app/campaign/[campaignId]/dm-screen/
Tables  dmScreens, dmWorkspaces, dmNotes
Mounts  RibbonBar (ribbon) — the only place the ribbon is mounted
Hosts   every lookup kind, npcs, sessions, locations, groups, chat,
        calendar, rules as panels
Branch  claude/tool-dmscreen
Note    Windows are a tiling tree, never floating. Maximize is a cover
        over the tree, not a change to it — that is what makes shrink
        restore exactly. Layout persists as one JSON string column and
        parseLayout trusts none of it.
```

### feedback — Send Feedback
```
Owns    components/FeedbackForm.tsx, components/feedbackClient.ts
        components/floatWindow.ts, components/screenGrab.ts,
        components/listContinue.ts
        scripts/feedback.mjs
Backend Supabase, not Convex
Branch  claude/tool-feedback
Note    SUPABASE_SECRET_KEY never appears in the app, the repo, or a
        chat log. `npm run feedback` is the only way to read reports,
        and it filters to app=Game Mastery — never query the shared
        table directly.
```

### groups — Groups
```
Owns    components/GroupTable.tsx, components/GroupDetail.tsx,
        components/groupColumns.ts
        convex/groups.ts
        app/campaign/[campaignId]/groups/
Tables  groups
Branch  claude/tool-groups
Note    Membership is not in this table — an NPC carries groups[].
        The screen lists every name any NPC carries, described or not.
```

### locations — Locations
```
Owns    components/LocationsTool.tsx, components/locationTree.ts
        convex/locations.ts
        app/campaign/[campaignId]/locations/
Tables  locations
Branch  claude/tool-locations
```

### lookup — Lookup library
```
Owns    components/LookupTool.tsx, components/LookupScreen.tsx,
        components/LookupFilterBar.tsx, components/lookupFields.ts,
        components/lookupFilters.ts, components/useLookupLayout.ts,
        components/sourceNames.ts
        convex/lookup.ts
        app/campaign/[campaignId]/lookup/
        scripts/import-foundry.mjs, scripts/unknown-sources.mjs,
        scripts/clear-lookup.mjs
Tables  spells, items, monsters, feats, backgrounds, classes, species
Branch  claude/tool-lookup
Note    Seven derived reference tables with no write path — they are
        replaced wholesale by the import. Anything that changes what
        import-foundry.mjs writes needs the whole re-import block from
        CLAUDE.md.
```

### maps — The table screen
```
Owns    components/TableScreen.tsx
        convex/maps.ts
        app/campaign/[campaignId]/ (the campaign index route)
Tables  maps, tableState
Mounts  CombatPanel (combat)
Branch  claude/tool-maps
Note    One subscription per screen: maps.getTableState. Map files are
        renamed on revision, never overwritten — immutable cache
        headers on the map server.
```

### notebook — Notebook
```
Owns    components/NotebookTool.tsx, components/BoxCanvas.tsx,
        components/NotebookFormatBar.tsx, components/NoteThread.tsx,
        components/NoteLinkPicker.tsx, components/NoteMentions.tsx,
        components/notebookFormat.ts, components/notebookTree.ts,
        components/notePage.ts, components/noteFormat.ts,
        components/noteLinks.ts, components/boxHtml.ts
        convex/notebook.ts
        app/campaign/[campaignId]/notebook/
Tables  notebooks, notebookBoxes
Branch  claude/tool-notebook
Note    boxHtml.ts is the sanitizer for every stored HTML in the app,
        including session pages and GM notes — changing its allowlist
        affects other tools. Treat it as Common when you touch it.
        contentEditable rule: innerHTML is written only when the caret
        is elsewhere.
```

### npcs — NPC roster
```
Owns    components/NpcTable.tsx, components/NpcDetail.tsx,
        components/RecordEditing.tsx, components/npcColumns.ts,
        components/npcFilters.ts, components/npcSections.ts,
        components/npcTemplate.ts
        convex/npcs.ts
        app/campaign/[campaignId]/npcs/
Tables  npcs
Branch  claude/tool-npcs
Note    Hidden NPCs never arrive for a player; secret and dmNotes
        arrive as null. Shaped server-side in npcs.listForCampaign.
```

### recorder — Session Recorder
```
Owns    components/RecorderTool.tsx, components/recorderModel.ts,
        components/useRecorder.ts
        convex/recorder.ts
        app/campaign/[campaignId]/recorder/
        map-server/recorder/ (Dockerfile, server.py, worker.py)
        map-server/RECORDER.md
Tables  recordings, transcriptChunks
Reads   convex/sessions.ts (api.sessions) — to link a recording to a
        session in the log
Branch  claude/tool-recorder
Note    Touches the SHELL (a nav entry) and map-server/ (two compose
        services, a Caddy route, three env vars), so a chat working on
        it runs alone.
```
Record the night, transcribe it on the home server, summarize it.

**The audio never enters Convex** and that is the whole shape of the
tool. Free-tier file storage is a gigabyte and one session is about
sixty megabytes, so the seventeenth would fail during a game — and
nothing that takes four hours can run inside a Convex action anyway. It
goes to the PowerEdge, beside the battle maps, which already has the
disk and the tunnel. `audioKey` is therefore a filename on another
machine, not a storage id, and a transcript can outlive its audio.

Three trust boundaries, none of which TypeScript can see across:

- The browser is given a **ticket**, never a secret: an HMAC over one
  recording id and an expiry, minted in `startRecording`, verified by
  `map-server/recorder/server.py`. It grants uploading and deleting one
  recording, and stops working the same night.
- The home server posts the transcript back through `convex/http.ts`,
  authenticated by a **separate** shared secret. Those routes are all
  POST on purpose: the ingest secret grants writing a transcript, never
  reading one.
- The status strings are written by `convex/recorder.ts` and drawn by
  the screen from `RECORDER_STAGES`. The integrity guard fails if a
  status is written that has no label.

GM-only in the strongest sense in the app, To-Do included. A prep list
is a spoiler; a transcript is the whole evening — the aside to one
player while the others were getting food, the argument about a
ruling, everything said believing the laptop was there for the battle
map. There is no redacted version, so every function refuses a non-GM
caller and the dm-visibility guard fails on `requireMember` appearing
anywhere in `convex/recorder.ts`, or on any other module touching
either table.

Two of the three inputs come from outside this repo — WhisperX's
segments and a model's JSON — so `components/recorderModel.ts` is
written to trust none of it and is where the unit guard lives.
`speakerName` is the `colorOf` lesson repeated: the map's keys are
WhisperX's, so a tag of `"toString"` has to be a defined answer.

The summary is the only paid step and is opt-in per recording. With no
`ANTHROPIC_API_KEY` the tool still records, transcribes and reads back;
`transcribed` is a resting state, not a failure.

### ribbon — The customizable toolbar
```
Owns    components/RibbonBar.tsx, components/RibbonCustomize.tsx,
        components/ribbonRegistry.ts, components/ribbonTokens.ts,
        components/DndColumns.tsx
Stored  userSettings.toolbarTokens, userSettings.toolbarSet
Mounted in  DmScreen (dmscreen) — the only mount, enforced by a guard
Branch  claude/tool-ribbon
Note    Adding a builtin marked `permanent` is how new controls reach
        toolbars people already arranged — normalizeRibbon re-inserts
        them. Menus must portal to document.body; the bar is a
        horizontal scroll container and clips anything inside it.
```

### rules — Rules Lawyer
```
Owns    components/RulesLawyerTool.tsx, components/rulesSnippet.ts
        convex/rules.ts, convex/rulesAsk.ts
        app/campaign/[campaignId]/rules/
Tables  rulePins, ruleAnswers
Reads   convex/lookup.ts (api.lookup) — the `rules` table, its two
        search indexes, and ruleContext all live there and stay there
Branch  claude/tool-rules
Note    Two halves, and the order matters. The search half quotes the
        rules verbatim and is the reason anything here can be trusted;
        the AI half reads those passages back with inline citations and
        sits ABOVE them, never instead of them. The integrity guard
        enforces exactly that — prose is allowed only where the quoted
        sections and its citations are on screen with it.

        rulesAsk.ts is the only `"use node"` file in the app and the
        only thing in Game Mastery that costs money per use. It needs
        ANTHROPIC_API_KEY set on the deployment (`npx convex env set`),
        refuses to answer with no passages to cite, and caches every
        answer in ruleAnswers so the same question is paid for once.

        Nothing outside the `rules` table stores a rule's `_id`. The
        importer replaces that table wholesale, so pins, cached
        citations and the `?open=` in a shared link are all keyed on
        source + breadcrumb + title instead.
```

### scheduler — Scheduler
```
Owns    components/SchedulerTool.tsx, components/scheduleModel.ts
        app/campaign/[campaignId]/scheduler/
Reads   convex/calendar.ts (api.calendar)
Branch  claude/tool-scheduler
Note    No backend of its own yet. If it grows one, it becomes
        convex/scheduler.ts and this entry gains a Tables line.
```

### sessions — Sessions
```
Owns    components/SessionTable.tsx, components/SessionDetail.tsx,
        components/sessionColumns.ts, components/sessionTabs.ts
        convex/sessions.ts
        app/campaign/[campaignId]/sessions/
        scripts/import-moonbrook-sessions.mjs
Tables  sessions, sessionBoxes, sessionPages, sessionTabs
Branch  claude/tool-sessions
Note    Session NUMBERS are the GM's to change; the importer matches on
        date for exactly that reason. A session's notes are TABS — three
        built in (GM notes, GM Prep, Player notes) and up to eight
        anybody makes. A GM-only tab never leaves the server for a
        player, and neither does its TITLE: getNotes narrows on
        by_session_dmOnly rather than reading the rows and dropping
        them. See sessions.getNotes and sessions.resolveTab.
        components/notePage.ts (notebook's) was this tool's page-id
        helper and no longer has a caller — sessionTabs.ts replaced it,
        because a tab key is wider than a side.
```

### todo — To-Do
```
Owns    components/TodoTool.tsx, components/TodoUpcoming.tsx,
        components/TodoProjects.tsx, components/TodoLabels.tsx,
        components/todoModel.ts, components/quickAdd.ts
        convex/todo.ts
        app/campaign/[campaignId]/todo/
Tables  todos, todoProjects, todoLabels
Branch  claude/tool-todo
Note    The tool has FOUR screens — Overview, Upcoming, Projects,
        Labels — and they hang off the To-Do entry in the app's own
        sidebar rather than off a navigation pane of the tool's own.
        That means the todo tool's shape is expressed in
        components/navItems.ts (TODO_CHILDREN), which belongs to the
        SHELL. A chat changing which screens exist touches a shell
        file and therefore runs alone.
```
The GM's prep list, and GM-only in a stronger sense than the rest of
the app. An NPC has a player-facing shape — the same row with the
secrets stripped. This has none: "statblock for the lich" IS the
spoiler. So every function refuses a non-GM caller rather than
filtering rows, the QUERY included, and the dm-visibility guard fails
on `requireMember` appearing anywhere in `convex/todo.ts`.

The planned player-facing list is its OWN table and module, not a
`visibility` flag here. A flag would turn every function in this tool
into a question about who is asking.

Items carry a sort key, not an index: a drag rewrites one row. The
rare exhausted-gap case rewrites the list once rather than leaving two
items with the same key. Dates are compared as strings — "YYYY-MM-DD"
sorts in date order, so nothing here builds a Date and nothing here
has a timezone.

Built after **Vikunja**: projects, labels, priority, favourites, and
Quick Add Magic — `task tomorrow *label !4 +'Project'` typed in one
field. The parse is pure and lives in `components/quickAdd.ts`, where
it is unit-tested at a fixed date and again under two timezones. What
is deliberately not copied: Vikunja's own navigation pane (this app
has one), nested projects, Gantt and Kanban, assignees and teams.

Colours are stored as **palette ids**, never as colours: the value ends
up in a `style`, so what crosses has to be something the client looks
up. `colorOf()` is that lookup and cannot fail open — an unknown id is
the default, including `"toString"`, which the obvious `obj[id] ??`
form returned a function for.

### shell — App frame, settings, campaigns, auth
```
Owns    components/AppShell.tsx, components/SettingsPanel.tsx,
        components/SidebarDesigner.tsx, components/NavIcon.tsx,
        components/ThemeSync.tsx, components/SignInForm.tsx,
        components/CampaignList.tsx, components/CampaignDetails.tsx,
        components/CampaignRoster.tsx, components/InvitePanel.tsx,
        components/TransferDm.tsx, components/NameField.tsx,
        components/SourcesPanel.tsx, components/navItems.ts,
        components/settingsTabs.ts, components/sidebarLayout.ts,
        components/themes.ts, components/campaignCard.ts,
        components/inviteModel.ts
        convex/campaigns.ts, convex/settings.ts, convex/auth.ts,
        convex/auth.config.ts
        app/campaign/[campaignId]/settings/, app/join/[token]/,
        app/page.tsx, app/layout.tsx
Tables  campaigns, memberships, invites, users, profiles, userSettings
Branch  claude/tool-shell
Note    The widest tool, and the one most likely to collide with
        others — navItems.ts is how every tool appears in the sidebar,
        and userSettings holds per-tool preferences. A tool adding a
        nav entry or a setting touches shell; say so.
```

---

## Common — shared building blocks

Owned by no tool. Used by three or four each. **Changing these affects
every table in the app**, so treat a change here like a Layer: it runs
alone, and the chat says so.

```
components/TableToolbar.tsx    npcs, sessions, groups
components/FilterPanel.tsx     npcs, sessions, groups
components/recordGrid.ts       npcs, sessions, groups
components/useViewPrefs.ts     npcs, sessions, groups
components/Pager.tsx           npcs, sessions, groups, lookup
components/pagerModel.ts       npcs, sessions, groups, lookup
components/ExpandIcon.tsx      npcs, sessions, groups, lookup
components/AlignIcon.tsx       notebook, sessions
components/boxHtml.ts          notebook, sessions, dmscreen
convex/views.ts                every table's saved layout
convex/http.ts, convex/auth.ts wiring
```

---

## Layers — cross-cutting by design

Not tools. They reach into many tools on purpose, so "owning their
files" would be a half-truth.

### uieditor — The UI designer (edit mode)
```
Files   components/UiEditor.tsx, components/uiRegistry.ts
Reaches TableToolbar, NpcDetail, NpcTable, SessionTable, GroupTable,
        NoteThread, SettingsPanel, AppShell — 10 files, 6 tools
Backend settings.getUiOverrides / saveUiOverrides, uiOverrides table
```
**Rule:** a chat working on the UI designer either stays strictly
inside `UiEditor.tsx` and `uiRegistry.ts`, or runs alone. Adding
`UiText` call sites across other tools' components is the second kind.

---

## Reserved — not built yet

Entries exist so the boundary is settled before the work starts. A chat
told to build one of these already knows which files are its own.

### shops — Shops
```
Will own  components/ShopsTool.tsx
          convex/shops.ts
          app/campaign/[campaignId]/shops/
Branch    claude/tool-shops
Status    Nav entry exists. No component.
Reads     lookup (items) — a shop's stock comes from the item library
```

### vtt — Virtual tabletop
```
Will own  components/Vtt*.tsx, components/vttModel.ts
          convex/vtt.ts
          app/campaign/[campaignId]/vtt/
Branch    claude/tool-vtt
Status    Planned. Not started.
Note      The largest tool by far when it lands, and the one most
          likely to want pieces of maps and combat. Worth deciding up
          front whether it absorbs those two or reads them, because
          that answer changes who owns TableScreen and CombatPanel.
```

---

## Cross-mounts

Three places where one tool renders another's component. These are
fine, but they mean a change to the mounted component can break the
mounting tool's screen, and the guard suite is what catches it.

| Mounted | Into | Enforced by |
|---|---|---|
| `RibbonBar` (ribbon) | `DmScreen` (dmscreen) | integrity guard: exactly one mount, in DmScreen |
| `CombatPanel` (combat) | `TableScreen` (maps) | — |
| every lookup/table tool | `DmScreen` panels | integrity guard: a case per DM_PANEL_KIND, and the component rendered |

---

## Still shared, unavoidably

`convex/schema.ts` and `app/globals.css` are one file each today, and
every tool writes to them. Until the split described in
`PARALLEL-WORK.md` phases 1–2 happens:

- **schema.ts** — keep each tool's tables in one block, and add new
  ones next to your tool's existing block rather than at the end. Two
  chats then edit different regions and git merges them cleanly.
- **globals.css** — append inside your tool's `/* ---- section ---- */`
  rather than at the end of the file, for the same reason.
- **`convex/_generated/api.d.ts`** — never hand-merge. Take either side
  and re-run `npx convex dev --once`.
- **tests/guards/integrity.mjs, unit.mjs** — the worst of the four.
  Append your section at the end of the relevant function and expect a
  conflict; resolve it by keeping BOTH sections. A resolution that
  drops one is silent — the suite still runs green with fewer checks.
