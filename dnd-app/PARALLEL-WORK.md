# Working on Game Mastery in several chats at once

_A spec, not yet built. Written 2026-08-29 to be decided on before any
of it is implemented._

The goal: two or three Claude chats working on different tools of this
app at the same time, without their changes colliding.

---

## 1. What actually collides today

Measured over the last 60 commits of this repo, not guessed:

| File | Lines | Touched by | Why every feature touches it |
|---|---|---|---|
| `tests/guards/integrity.mjs` | 5,239 | **49 of 60 commits (82%)** | Every feature appends a section to one function |
| `app/globals.css` | 8,793 | **41 of 60 (68%)** | One stylesheet, 1,160 rules, every screen |
| `tests/guards/unit.mjs` | 7,480 | **37 of 60 (62%)** | Same — one function, 87 sections |
| `convex/schema.ts` | 1,336 | 13 of 60 (22%) | Any new table or field |
| `convex/_generated/api.d.ts` | 79 | with each new module | Generated, but committed |

Everything else is already well separated: 84 components and 18 Convex
modules, and a typical feature touches two or three of them. **The
component layer is not the problem. Three shared files are.**

Two chats working on, say, the DM Screen and the Lookup tables would
today both edit `globals.css`, both append to `integrity.mjs`, and both
append to `unit.mjs` — three guaranteed merge conflicts per feature,
in the three largest files in the repo, where a bad conflict resolution
silently deletes a guard nobody notices is gone.

That last part is the real risk. A merge conflict in a component breaks
the build and you fix it. A merge conflict resolved carelessly in
`integrity.mjs` drops a check, the suite still runs green, and the
invariant is unprotected from then on.

---

## 2. The two tools your co-worker named

Neither one addresses this, and one of them would do damage.

**Polymer — do not use.** Google's web-components library, deprecated in
2023 and superseded by Lit. It is a way of authoring custom elements; it
has nothing to do with parallel development, and introducing web
components into a React 19 / Next.js 16 app would add a second
component model to maintain alongside the first. I suspect the term got
garbled somewhere between your co-worker and here — possibly they meant
a **monorepo** tool (Nx, Turborepo), which is the right shape of idea
and is discussed in §7.

**TanStack Query — skip.** It is a genuinely excellent library for
caching server state fetched over HTTP. You are on Convex, whose
`useQuery` already gives you reactive subscriptions, caching,
deduplication and automatic invalidation — and does it better here,
because it is pushed from the server rather than polled. Adding TanStack
Query would mean maintaining two caching layers that disagree. This app
has six runtime dependencies; that leanness is an asset.

**TanStack Table — real, but a different conversation.** This one is
worth considering _on its merits_, separately from parallel work:
`NpcTable`, `SessionTable`, `GroupTable` and `LookupTool` hand-roll
column resizing, sorting, grouping and now pagination, with real
duplication between them. TanStack Table is a headless library that
would own that logic. But it is a multi-day refactor of four of the
most-used screens in the app, it would not isolate anything, and it
should be decided on its own. **Not part of this spec.** Flagging it as
the one accurate thing in the advice.

**What actually enables parallel work is not a library.** It is file
ownership: making it structurally true that two tools do not write to
the same file. That is what follows.

---

## 3. The design

### 3.1 `TOOLS.md` — the registry

One file at `dnd-app/TOOLS.md` listing every tool and the files it owns.
This is the thing a new chat reads first, and the thing that makes
"does my work overlap yours?" answerable in ten seconds.

```markdown
## dmscreen — The DM Screen
Owns:    components/DmScreen.tsx, components/dmScreenModel.ts,
         convex/dmscreen.ts, app/styles/tools/dmscreen.css,
         tests/guards/integrity/dmscreen.mjs,
         tests/guards/unit/dmscreen.mjs
Shares:  convex/schema.ts (tables dmScreens, dmWorkspaces, dmNotes)
Tables:  dmScreens, dmWorkspaces, dmNotes
Branch:  claude/tool-dmscreen
```

Roughly twelve tools: `dmscreen`, `lookup`, `npcs`, `sessions`,
`groups`, `locations`, `calendar`, `chat`, `notebook`, `ribbon`,
`shell` (sidebar, settings, themes), `feedback`.

### 3.2 CSS: one file per tool, one manifest

`app/globals.css` becomes a manifest of imports and nothing else:

```css
@import "./styles/base.css";          /* tokens, themes, reset      */
@import "./styles/shell.css";         /* sidebar, workspace, tabs   */
@import "./styles/tools/npcs.css";
@import "./styles/tools/lookup.css";
@import "./styles/tools/dmscreen.css";
/* … one line per tool … */
```

The file already carries 59 `/* ---------- Section ---------- */`
markers, so the split is mechanical rather than a judgement call about
where each rule belongs.

**Cascade order must be preserved exactly.** Several rules in this app
depend on source order at equal specificity. The migration is therefore
verified by concatenating the split files in manifest order and
diffing against the original: **byte-identical, or the split is wrong.**
That makes this a zero-risk refactor rather than a visual regression
hunt.

Two chats then touch different CSS files. The manifest is shared, but
only gains a line when a *new tool* is created — a one-line conflict,
trivially resolved, and rare.

### 3.3 Guards: split by tool, discovered by the runner

Today `integrity.mjs` is one 5,239-line function with 68 appended
sections, and `unit.mjs` is one 7,480-line function with 87. Split
them:

```
tests/guards/integrity/dmscreen.mjs     export const checks = [...]
tests/guards/integrity/lookup.mjs
tests/guards/unit/dmscreen.mjs
tests/guards/unit/pager.mjs
…
```

The runner reads the directory instead of importing a fixed list, so
**adding a tool's guards touches no shared file at all** — the strongest
form of isolation in this plan. It also unlocks a much faster inner
loop:

```bash
npm run guards -- --tool dmscreen     # that tool's checks only, seconds
npm run guards                        # everything, unchanged
```

The existing discipline carries over unchanged and must be restated in
each file's header: a guard that cannot find what it inspects **fails**
rather than passing quietly; guard files export and never self-execute.

**Migration acceptance test:** the total number of checks executed
before and after the split must be identical. A split that quietly
drops eleven checks is exactly the failure this suite exists to
prevent, so it gets its own count assertion.

### 3.4 Convex: cannot be split — needs a protocol instead

`convex/schema.ts` is one file by Convex's design, and
`_generated/api.d.ts` is generated. No structure fixes this, so:

- **Table blocks stay grouped per tool and alphabetical by tool.** Two
  chats adding tables then touch different regions of the file, and git
  merges them cleanly. Today's ordering is already close to this.
- **Never hand-merge `_generated/api.d.ts`.** On a conflict, take either
  side and re-run `npx convex dev --once`, which rewrites it. The
  `generated-api` guard already catches a stale one.
- **A chat that changes the schema says so in its final message**, so you
  know to run that chat's paste block before the other's.

One thing that genuinely does not parallelise: **your local Convex dev
deployment is one deployment.** Two paste blocks that both push a schema
must be run one after the other, not at once. Since these chats are
sandboxed and cannot reach convex.dev, only you ever push — so this is
a sequencing rule for you, not a code problem.

### 3.5 Branches: one per tool

```
claude/tool-dmscreen
claude/tool-lookup
claude/tool-sessions
```

Each chat works only on its tool's branch, runs the full guard suite
before pushing, and rebases on the shared branch before pushing rather
than merging. You merge each into the working branch when it is green.
The current single `claude/game-mastery-db-setup-jaeuln` branch becomes
the trunk they rebase onto.

### 3.6 Per-tool briefs

`docs/tools/<id>.md`, one per tool: what it is, its invariants, its
open questions, its known gotchas. Much of this already exists as
comments in the code, and the valuable half is the part that is not
obvious from reading it — the DM Screen's "the tree is untouched while
maximized" rule, the ribbon's "permanent builtins re-insert
themselves", the contentEditable caret rules.

A chat then starts with: read `CLAUDE.md`, read `TOOLS.md`, read your
tool's brief. That is a much better start than reading 8,793 lines of
CSS looking for the right section.

---

## 4. What a parallel session looks like

> **Chat A** — "work on the lookup tables, branch `claude/tool-lookup`"
> Reads `TOOLS.md`, sees it owns `LookupTool.tsx`, `lookupFields.ts`,
> `styles/tools/lookup.css`, `guards/*/lookup.mjs`. Adds a filter,
> a rule to its own CSS file, a check to its own guard file. Runs
> `npm run guards -- --tool lookup` while iterating, the full suite
> before pushing.
>
> **Chat B** — "work on the DM screen, branch `claude/tool-dmscreen`"
> Same, in six entirely different files.
>
> Neither branch touches a file the other touched. Both merge clean.

Today those two chats collide in three files.

---

## 5. Phases

| Phase | Work | Effort | Value |
|---|---|---|---|
| **0** | `TOOLS.md` + branch protocol + per-tool briefs. No code moves. | ~1 hour | Most of the benefit. Two chats can already avoid each other by knowing who owns what. |
| **1** | Split the guards; runner discovers by directory. | ~2 hours | Removes the two worst conflict files (82% and 62% of commits) and makes the inner loop fast. |
| **2** | Split the CSS behind the manifest, verified byte-identical. | ~2 hours | Removes the third (68%). |
| **3** | Schema grouping + the Convex protocol in `CLAUDE.md`. | ~30 min | Turns the remaining conflicts into trivial ones. |

Phases are independent and each is shippable on its own. **Phase 0 is
worth doing whatever you decide about the rest** — it is documentation,
it cannot break anything, and it is what makes a second chat safe to
start today.

---

## 6. What this does not fix

Worth being straight about the limits:

- **Two chats on the same tool still conflict.** This makes tools
  independent, not chats. One tool, one chat at a time.
- **Cross-cutting features still touch everything.** "Change every table
  to paginate" is not a tool-shaped task and will conflict by nature.
  Those belong in one chat, run alone.
- **The schema is still one file.** Grouping makes conflicts small and
  mechanical; it does not eliminate them.
- **You still sequence the paste blocks.** One Convex deployment.
- **More files to navigate.** 8,793 lines of CSS in one file is easy to
  grep and hard to share; twelve files are the reverse. That is a real
  trade, made deliberately.

---

## 7. The one alternative worth naming

A **monorepo tool** (Turborepo or Nx) would go further: each tool
becomes a package with its own dependencies, its own test target, and
enforced boundaries — an import across a boundary fails the build,
rather than relying on a registry file being read.

I am not recommending it here. It would mean restructuring 84
components into packages, a build-tooling layer to maintain, and
Convex's single-backend model does not split along package lines
anyway. The cost is days, the benefit over the plan above is
enforcement rather than convention, and the convention is enforceable
by a guard for a fraction of the price — a check that fails when a
tool's CSS file contains a selector belonging to another tool would get
most of the way there.

Worth revisiting if this app ever becomes several apps.

---

## 8. Decide

1. **Do phases 0–3?** Or phase 0 only, and see whether the discipline
   alone is enough before moving files?
2. **Is the tool list right?** Twelve is my read of the app's seams; you
   know where you actually work.
3. **TanStack Table for the four tables** — separate question, separate
   spec, worth its own conversation.
