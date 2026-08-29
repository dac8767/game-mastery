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

**0. `git checkout claude/game-mastery-db-setup-jaeuln` — first, before
anything else.**

This is the trunk. Every branch below is cut from it, and it is where
the app actually lives.

`main` is NOT the app. It is the initial import from 17 July 2026 and
is over 150 commits behind — no DM Screen, no Lookup, no pagination,
and no copy of this file. A fresh session clones the default branch, so
a chat that skips this step is reading a six-week-old skeleton and will
correctly report that the thing it was asked to work on does not exist.
That has already happened once.

If this file is missing, you are on the wrong branch. That is the
symptom, and step 0 is the fix.

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

### combat — Combat Tracker
```
Owns    components/CombatPanel.tsx
        convex/combat.ts
Tables  encounters, combatants
Mounted in  TableScreen (maps) — see the cross-mount note below
Branch  claude/tool-combat
Note    Player-facing shape is server-side: hidden combatants and
        masked HP must never leave the server for a non-DM caller.
        See combat.getEncounterView.
```

### dmscreen — DM Screen
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
        including session pages and DM notes — changing its allowlist
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
        app/campaign/[campaignId]/rules/
Reads   convex/lookup.ts (api.lookup)
Branch  claude/tool-rules
Status  Thin — a stub with a route and a DM Screen panel. Building it
        out is a tool-shaped job that conflicts with nothing.
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
        components/sessionColumns.ts
        convex/sessions.ts
        app/campaign/[campaignId]/sessions/
        scripts/import-moonbrook-sessions.mjs
Tables  sessions, sessionBoxes, sessionPages
Branch  claude/tool-sessions
Note    Session NUMBERS are the DM's to change; the importer matches on
        date for exactly that reason. DM-side pages never leave the
        server for a player — see sessions.getNotes.
```

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

### dice — Dice Roller
```
Will own  components/DiceRoller.tsx, components/diceModel.ts
          convex/dice.ts (if it needs one)
          app/campaign/[campaignId]/dice/
Branch    claude/tool-dice
Status    Nav entry exists, marked SOON. No component.
```

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
