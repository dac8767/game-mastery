/**
 * Guard 4 — the dangling-reference sweep.
 *
 * This is the guard that exists because of how silent losses actually
 * happen: not a syntax error, but a reference to something that no
 * longer exists, in a place the compiler can't see.
 *
 * TypeScript does not cover any of these, because each one crosses a
 * boundary where a field name is a *string*:
 *   - the grid addresses NPC fields by string key, through a
 *     Record<string, unknown> cast, so a typo silently renders blanks
 *   - the sidebar addresses routes by slug, so a renamed folder becomes
 *     a dead link rather than a compile error
 *   - the importer writes field names that only the deployed schema
 *     validates, i.e. at import time, on real data
 *   - the query hands back fields the schema may no longer have
 */

import { readdirSync, readFileSync } from "node:fs";
import {
  read,
  exists,
  appPath,
  blockAfter,
  topLevelKeys,
  stringProps,
  constArrayStrings,
  stripComments,
  sourceFiles,
} from "./lib.mjs";

/** Convex adds these to every document. */
const SYSTEM_FIELDS = ["_id", "_creationTime"];

/**
 * The reference library: shared across campaigns, read-only in the app,
 * and the only tables whose contents can be thrown away and re-imported.
 * Several checks below turn on exactly that property.
 */
const LOOKUP_TABLES = ["spells", "items", "monsters"];

/**
 * Fields the query COMPUTES rather than reads from the table.
 *
 * Listed explicitly rather than letting the check wave through anything
 * unrecognised: adding a derived field should be a deliberate line here,
 * so a typo'd real field still fails loudly.
 *
 *   portraitUrl — resolved from the portraitId storage id, since the
 *                 client must never handle storage ids directly.
 */
const DERIVED_FIELDS = ["portraitUrl"];

export const integrity = {
  name: "integrity",
  description: "no dangling references across schema, query, grid, and routes",
  run() {
    const problems = [];

    // ---- what the schema actually defines -------------------------
    const schemaSrc = read("convex", "schema.ts");
    const npcsBlockSrc = blockAfter(
      schemaSrc,
      /npcs:\s*defineTable\(/,
      "npcs table in schema.ts"
    );
    const schemaFields = topLevelKeys(npcsBlockSrc, "npcs schema");

    // ---- what the query actually returns ---------------------------
    const npcsSrc = read("convex", "npcs.ts");
    const returned = topLevelKeys(
      blockAfter(npcsSrc, /\.map\((?:async )?\(n\)\s*=>\s*\(/, "the row shaper in npcs.ts"),
      "listForCampaign row"
    );

    for (const f of returned) {
      if (SYSTEM_FIELDS.includes(f) || DERIVED_FIELDS.includes(f)) continue;
      if (!schemaFields.includes(f)) {
        problems.push(
          `npcs.listForCampaign returns \`${f}\`, which is not a field on the npcs table`
        );
      }
    }

    // ---- what the grid addresses by string key ---------------------
    // Column definitions live in npcColumns.ts and address NPC fields by
    // string; nothing type-checks that a key still exists.
    const colsSrc = read("components", "npcColumns.ts");
    const columnsBlock = colsSrc.slice(
      colsSrc.indexOf("export const COLUMNS"),
      colsSrc.indexOf("export const COLUMN_BY_KEY")
    );
    const columnKeys = stringProps(columnsBlock, "key", "npcColumns COLUMNS");

    const available = new Set([...returned, ...DERIVED_FIELDS]);
    for (const key of columnKeys) {
      if (!available.has(key)) {
        problems.push(
          `npcColumns defines a \`${key}\` column, which npcs.listForCampaign never returns`
        );
      }
    }

    // Every column needs a default width and visibility, or the layout
    // reconciler produces a column that cannot be sized or shown.
    for (const entry of columnsBlock.split(/\},\s*\n/)) {
      const m = entry.match(/key:\s*"([^"]+)"/);
      if (!m) continue;
      if (!/defaultWidth:/.test(entry)) {
        problems.push(`column \`${m[1]}\` has no defaultWidth`);
      }
      if (!/defaultVisible:/.test(entry)) {
        problems.push(`column \`${m[1]}\` has no defaultVisible`);
      }
    }

    // A column's `kind` must match how the field is actually stored.
    // Getting this wrong is invisible until someone edits: the editor
    // parses by kind, so a scalar declared `chips` sends ["Grung"] into
    // a v.string() field and the mutation rejects it.
    for (const entry of columnsBlock.split(/\},\s*\n/)) {
      const keyMatch = entry.match(/key:\s*"([^"]+)"/);
      const kindMatch = entry.match(/kind:\s*"([^"]+)"/);
      if (!keyMatch || !kindMatch) continue;
      const [key, kind] = [keyMatch[1], kindMatch[1]];

      const decl = npcsBlockSrc.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
      if (!decl) continue; // covered by the dangling-key check above
      const storage = decl[1];
      const isArray = storage.includes("v.array(");

      if (kind === "chips" && !isArray) {
        problems.push(
          `column \`${key}\` is kind "chips" but the schema stores a scalar — ` +
            "editing it would send an array into a string field"
        );
      }
      if (kind !== "chips" && isArray) {
        problems.push(
          `column \`${key}\` is kind "${kind}" but the schema stores an array`
        );
      }
      if (kind === "number" && !storage.includes("v.number(")) {
        problems.push(`column \`${key}\` is kind "number" but the schema is not`);
      }
      if (kind === "boolean" && !storage.includes("v.boolean(")) {
        problems.push(`column \`${key}\` is kind "boolean" but the schema is not`);
      }
    }

    // Facets and quick filters must name real columns.
    const columnKeySet = new Set(columnKeys);
    for (const key of constArrayStrings(colsSrc, "FACET_KEYS", "npcColumns")) {
      if (!columnKeySet.has(key)) {
        problems.push(`FACET_KEYS names \`${key}\`, which is not a column`);
      }
    }
    for (const key of constArrayStrings(
      colsSrc,
      "QUICK_FILTER_KEYS",
      "npcColumns"
    )) {
      if (!columnKeySet.has(key)) {
        problems.push(
          `QUICK_FILTER_KEYS names \`${key}\`, which is not a column`
        );
      }
    }

    // Extra sorts address fields directly rather than columns.
    const extraBlock = colsSrc.slice(colsSrc.indexOf("export const EXTRA_SORTS"));
    for (const key of stringProps(
      extraBlock.slice(0, extraBlock.indexOf("];")),
      "key",
      "EXTRA_SORTS"
    )) {
      if (!available.has(key) && !SYSTEM_FIELDS.includes(key)) {
        problems.push(
          `EXTRA_SORTS sorts on \`${key}\`, which npcs.listForCampaign never returns`
        );
      }
    }

    // ---- nav slugs must have pages behind them ---------------------
    // The sidebar renders these and the ribbon's `t:` tokens address the
    // same list by id, so a renamed folder is a dead link in two places
    // rather than a compile error in either.
    const navSrc = read("components", "navItems.ts");
    for (const slug of stringProps(navSrc, "slug", "navItems destinations")) {
      if (!exists("app", "campaign", "[campaignId]", slug, "page.tsx")) {
        problems.push(
          `nav links to "${slug}" but app/campaign/[campaignId]/${slug}/page.tsx does not exist`
        );
      }
    }
    // TABLE_ITEM's slug is "" — the campaign's own page. An empty string
    // is invisible to the sweep above, so it is checked by name.
    if (!exists("app", "campaign", "[campaignId]", "page.tsx")) {
      problems.push(
        "navItems has a destination for the campaign itself but " +
          "app/campaign/[campaignId]/page.tsx does not exist"
      );
    }

    // ---- the ribbon's three registries -----------------------------
    // Every ribbon token is a string pointing at a control, and a token
    // whose control has gone is the exact failure normalizeRibbon exists
    // to absorb — silently, by design. That silence is right at runtime
    // and wrong at build time, so the shipped default layout and the
    // renderers are checked here instead.
    const ribbonSrc = read("components", "ribbonRegistry.ts");
    const barSrc = read("components", "RibbonBar.tsx");

    const between = (src, from, to, label) => {
      const a = src.indexOf(from);
      if (a === -1) throw new Error(`could not find ${label}`);
      const b = to ? src.indexOf(to, a) : -1;
      return src.slice(a, b === -1 ? src.length : b);
    };

    const builtinKeys = stringProps(
      between(ribbonSrc, "TOOLBAR_BUILTINS: ToolbarBuiltin[]", "];", "TOOLBAR_BUILTINS"),
      "key",
      "TOOLBAR_BUILTINS"
    );
    const commandIds = stringProps(
      between(ribbonSrc, "TOOLBAR_COMMANDS: ToolbarCommand[]", "];", "TOOLBAR_COMMANDS"),
      "id",
      "TOOLBAR_COMMANDS"
    );
    // Only ids that HAVE a slug: NAV_DESTINATIONS filters the rest out,
    // so a `t:` token naming an unbuilt screen is dropped silently by
    // normalizeRibbon. Checking against every id in the file would wave
    // exactly that through.
    const navIds = [];
    for (const [, body] of navSrc.matchAll(/\{([^{}]*)\}/g)) {
      const id = body.match(/\bid:\s*"([^"]+)"/);
      if (id && /\bslug:\s*"/.test(body)) navIds.push(id[1]);
    }
    if (navIds.length === 0) {
      throw new Error("found no slugged nav ids — parser out of date?");
    }

    // Every nav GROUP must be rendered, or adding one to navItems.ts and
    // forgetting the sidebar leaves a section that exists in the data and
    // nowhere on screen.
    const shellSrc = read("components", "AppShell.tsx");
    for (const [, group] of navSrc.matchAll(
      /export const (\w+): NavItem\[\]/g
    )) {
      if (group === "NAV_DESTINATIONS") continue; // the ribbon's registry
      if (!shellSrc.includes(group)) {
        problems.push(
          `navItems exports the ${group} group but AppShell never renders it`
        );
      }
    }

    // A builtin is drawn by a switch arm keyed on its string. Add one to
    // the registry and forget the arm and the palette offers a button
    // that renders nothing.
    const renderArms = [
      ...between(barSrc, "const renderBuiltin", "if (!tokens)", "renderBuiltin")
        .matchAll(/case "([^"]+)":/g),
    ].map((m) => m[1]);
    for (const key of builtinKeys) {
      if (!renderArms.includes(key)) {
        problems.push(
          `builtin \`${key}\` has no arm in RibbonBar's renderBuiltin — it ` +
            "would render nothing"
        );
      }
    }
    for (const key of renderArms) {
      if (!builtinKeys.includes(key)) {
        problems.push(
          `RibbonBar renders a \`${key}\` builtin that TOOLBAR_BUILTINS does ` +
            "not define, so no token can ever reach it"
        );
      }
    }

    // Same for commands, whose arm is an `if` on the id.
    const runBody = between(barSrc, "const run = useCallback", "const setTheme", "run()");
    for (const id of commandIds) {
      if (!runBody.includes(`"${id}"`)) {
        problems.push(
          `command \`${id}\` has no arm in RibbonBar's run() — the button ` +
            "would do nothing"
        );
      }
    }

    // The default layout has to be made of tokens that resolve today.
    const defaults = [
      ...between(ribbonSrc, "DEFAULT_RIBBON", "];", "DEFAULT_RIBBON").matchAll(
        /"([^"]+)"/g
      ),
    ].map((m) => m[1]);
    if (defaults.length === 0) {
      throw new Error("DEFAULT_RIBBON is empty — parser out of date?");
    }
    const known = { "b:": builtinKeys, "c:": commandIds, "t:": navIds };
    for (const raw of defaults) {
      const tok = raw.startsWith("2!") ? raw.slice(2) : raw;
      const list = known[tok.slice(0, 2)];
      if (list && !list.includes(tok.slice(2))) {
        problems.push(
          `DEFAULT_RIBBON contains "${raw}", which no registry defines — ` +
            "normalizeRibbon would silently drop it from every new toolbar"
        );
      }
    }

    // The ribbon belongs to the DM Screen and nowhere else — that is
    // what the feedback asked for, and it is an ABSENCE, which is the
    // one shape you cannot check by reading the files you thought of.
    const mounts = sourceFiles("components", "app")
      .filter(([rel]) => !rel.endsWith("/RibbonBar.tsx"))
      .filter(([, src]) => /<RibbonBar\b/.test(stripComments(src)))
      .map(([rel]) => rel);
    if (mounts.length !== 1 || !mounts[0].endsWith("/DmScreen.tsx")) {
      problems.push(
        `RibbonBar is rendered in ${mounts.length ? mounts.join(", ") : "nowhere"} — ` +
          "it belongs on the DM Screen and nowhere else"
      );
    }

    // WebKit refuses to START a drag without data on the transfer, so
    // the Customize window looks perfect in a browser and is stone dead
    // in a packaged desktop window on macOS.
    const dnd = stripComments(read("components", "DndColumns.tsx"));
    if (!/dataTransfer\.setData\(/.test(dnd)) {
      problems.push(
        "DndColumns never calls dataTransfer.setData() — dragging would " +
          "not start at all in WebKit"
      );
    }

    // ---- the importers write fields the schema must accept ---------
    // Two of them now — the Airtable CSV and the Foundry export — and
    // both write field names that only the deployed schema validates,
    // i.e. at import time, on real data.
    const foundrySrc = read("scripts", "import-foundry.mjs");

    // Each row builder writes into a different table, and every one of
    // them writes field names that only the deployed schema validates —
    // i.e. at import time, on real data, after the conversion has run.
    const IMPORTERS = [
      { file: "import-npcs.mjs", fn: "const doc", table: "npcs" },
      { file: "import-foundry.mjs", fn: "function actorToNpc", table: "npcs" },
      { file: "import-foundry.mjs", fn: "function itemToRow", table: "items" },
      { file: "import-foundry.mjs", fn: "function spellToRow", table: "spells" },
      {
        file: "import-foundry.mjs",
        fn: "function actorToMonster",
        table: "monsters",
      },
    ];

    let written = [];
    for (const { file, fn, table } of IMPORTERS) {
      const src = file === "import-foundry.mjs" ? foundrySrc : read("scripts", file);
      // Sliced to the builder first: blockAfter takes the next `{` after
      // its match, so anchoring on the whole file would find whichever
      // row literal came first.
      const sliced = src.slice(src.indexOf(fn));
      const fields = topLevelKeys(
        blockAfter(sliced, /const (?:doc|row)\s*=/, `the row literal in ${fn}`),
        `${fn} row`
      );

      const tableFields =
        table === "npcs"
          ? schemaFields
          : topLevelKeys(
              blockAfter(
                schemaSrc,
                new RegExp(`\\b${table}:\\s*defineTable\\(`),
                `${table} table`
              ),
              `${table} schema`
            );

      for (const f of fields) {
        if (f === "campaignId") continue; // supplied by the caller
        if (!tableFields.includes(f)) {
          problems.push(
            `${fn} in ${file} writes \`${f}\`, which the ${table} schema does not accept — the import would fail validation`
          );
        }
      }
      // Required fields are checked against the bulk CSV importer only;
      // it is the one that has to produce a complete NPC row.
      if (fn === "const doc") written = fields;
    }

    // The Lookup tables are the only content in the app that is NOT
    // scoped to a campaign, and that is deliberate — a fireball is a
    // fireball in both groups. A campaignId appearing on one would make
    // it per-campaign again without anything else noticing.
    // The declaration AND its trailing .index()/.searchIndex() chain.
    // blockAfter stops at the object literal's closing brace, so the
    // indexes — which are what these checks are about — sit outside it.
    const tableRegion = (table) => {
      const start = schemaSrc.search(
        new RegExp(`\\b${table}:\\s*defineTable\\(`)
      );
      if (start === -1) throw new Error(`no ${table} table in schema.ts`);
      const next = schemaSrc.slice(start + 1).search(/\n  \w+: defineTable\(/);
      return next === -1
        ? schemaSrc.slice(start)
        : schemaSrc.slice(start, start + 1 + next);
    };

    for (const table of LOOKUP_TABLES) {
      const block = tableRegion(table);
      if (/campaignId/.test(block)) {
        problems.push(
          `the ${table} table has a campaignId — the reference library is ` +
            "shared across campaigns on purpose"
        );
      }
      if (!/searchIndex\(/.test(block)) {
        problems.push(
          `the ${table} table has no search index — Lookup would have to ` +
            "scan, and these are the only tables big enough for that to matter"
        );
      }
    }

    // Nothing writes the library from inside the app; it is loaded by
    // `npx convex import`. A mutation appearing here is a write path
    // that was never designed to be secured.
    const lookupSrc = read("convex", "lookup.ts");
    if (/\bmutation\(/.test(stripComments(lookupSrc))) {
      problems.push(
        "convex/lookup.ts defines a mutation — the reference library is " +
          "read-only in the app and loaded by `npx convex import`"
      );
    }

    // Changing the shape of a Lookup table means emptying it first —
    // Convex validates the rows already stored against the new schema
    // and rejects the push over a single leftover. clear-lookup.mjs is
    // what does the emptying, from a hand-written list, so a fourth
    // Lookup table would otherwise be added to the schema and quietly
    // left out of the one script that can unblock it.
    const cleared = constArrayStrings(
      read("scripts", "clear-lookup.mjs"),
      "TABLES",
      "clear-lookup.mjs"
    );
    for (const table of LOOKUP_TABLES) {
      if (!cleared.includes(table)) {
        problems.push(
          `clear-lookup.mjs does not empty ${table} — a change to its ` +
            "shape would be unpushable with no way to clear it"
        );
      }
    }
    for (const table of cleared) {
      // The inverse matters more: this script DELETES, and a name that
      // is no longer a Lookup table is a name that belongs to something
      // Derek typed by hand.
      if (!LOOKUP_TABLES.includes(table)) {
        problems.push(
          `clear-lookup.mjs empties \`${table}\`, which is not one of the ` +
            "Lookup tables — it deletes data, so it must only ever name " +
            "tables that can be re-imported"
        );
      }
    }

    // ---- deleting a campaign must reach everything in it ------------
    // The one failure here is invisible by construction: a table left
    // out of the purge keeps its rows forever, and nothing ever reads
    // them, so there is no screen where the leak shows up. The schema is
    // the authority on what a campaign owns, so the list is derived from
    // it rather than written down twice.
    const campaignsSrc = read("convex", "campaigns.ts");
    const purge = campaignsSrc.slice(
      campaignsSrc.indexOf("export const purgeCampaign")
    );
    if (!purge.startsWith("export const purgeCampaign")) {
      throw new Error("no purgeCampaign in convex/campaigns.ts");
    }

    const ownedTables = [
      ...schemaSrc.matchAll(/\n  (\w+): defineTable\(\{([\s\S]*?)\n  \}\)/g),
    ]
      .filter(([, , body]) => /campaignId: v\.id\("campaigns"\)/.test(body))
      .map(([, table]) => table);

    if (ownedTables.length === 0) {
      throw new Error("found no campaign-scoped tables in schema.ts");
    }
    for (const table of ownedTables) {
      if (!new RegExp(`query\\("${table}"\\)`).test(purge)) {
        problems.push(
          `purgeCampaign never queries \`${table}\`, which carries a ` +
            "campaignId — deleting a campaign would strand its rows with " +
            "nothing left that can find them"
        );
      }
    }

    // The two tables a campaign owns only through a parent. Named here
    // because the schema cannot say it: they carry an encounterId and a
    // pageId, so the rule above cannot see them.
    for (const [table, via] of [
      ["combatants", "encounters"],
      ["notebookBoxes", "notebookNodes"],
    ]) {
      if (!new RegExp(`query\\("${table}"\\)`).test(purge)) {
        problems.push(
          `purgeCampaign never queries \`${table}\` — it belongs to a ` +
            `campaign through ${via}, so nothing else will ever delete it`
        );
      }
    }

    // Deleting has to be harder than clicking. The typed name is the
    // entire safeguard, and it lives in the mutation rather than the
    // dialog so a direct call cannot skip it.
    const deleteFn = campaignsSrc.slice(
      campaignsSrc.indexOf("export const deleteCampaign"),
      campaignsSrc.indexOf("export const purgeCampaign")
    );
    if (!/confirmName/.test(deleteFn) || !/campaign\.name/.test(deleteFn)) {
      problems.push(
        "campaigns.deleteCampaign does not check a typed name against the " +
          "campaign's own — the confirmation would be advisory, and a " +
          "misfired call would delete a campaign outright"
      );
    }
    if (!/requireDm\(/.test(deleteFn)) {
      problems.push("campaigns.deleteCampaign does not go through requireDm");
    }

    // ---- the rules edition is a literal union in three places -------
    // The schema validates it, the mutation re-declares it, and
    // lookupFilters offers it as buttons. Add a third edition to one and
    // the others accept a value they cannot store, or offer one nobody
    // can pick — neither of which TypeScript sees, because the schema
    // and the component never meet.
    // A bounded window rather than a lazy match: `v.union(v.literal("a"),
    // v.literal("b"))` has a `)` after the first literal, and anything
    // non-greedy stops there and reports one edition where there are two.
    const editionLiterals = (src, label) => {
      // Anchored on the DECLARATION — `rulesVersion: v.…` — not on the
      // name. It is also read and re-emitted elsewhere in these files,
      // and the first mention is not always the one that defines it.
      const at = src.search(/rulesVersion:\s*v\./);
      if (at === -1) throw new Error(`no rulesVersion declared in ${label}`);
      const window = src.slice(at, at + 200);
      if (!/v\.union\(/.test(window)) {
        throw new Error(`rulesVersion in ${label} is not a union of literals`);
      }
      const found = [...window.matchAll(/v\.literal\("([^"]+)"\)/g)].map(
        (x) => x[1]
      );
      if (found.length === 0) {
        throw new Error(`extracted no literals from ${label}`);
      }
      return found.sort();
    };

    const schemaEditions = editionLiterals(schemaSrc, "schema.ts");
    const mutationEditions = editionLiterals(
      read("convex", "campaigns.ts"),
      "campaigns.ts"
    );
    // Bounded to the array's own literal. Every filter's options use
    // `value: "..."` too, so reading to the end of the file collects the
    // whole vocabulary of the screen instead of the two editions.
    const filtersFile = read("components", "lookupFilters.ts");
    const listAt = filtersFile.indexOf("RULES_VERSIONS");
    if (listAt === -1) throw new Error("no RULES_VERSIONS in lookupFilters.ts");
    const listEnd = filtersFile.indexOf("];", listAt);
    if (listEnd === -1) throw new Error("RULES_VERSIONS is not a closed array");
    const offered = [
      ...filtersFile.slice(listAt, listEnd).matchAll(/value:\s*"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();

    if (offered.length === 0) {
      throw new Error("RULES_VERSIONS offers no editions");
    }
    for (const [label, list] of [
      ["convex/campaigns.ts", mutationEditions],
      ["RULES_VERSIONS", offered],
    ]) {
      if (list.join() !== schemaEditions.join()) {
        problems.push(
          `rules editions disagree: schema has [${schemaEditions}], ` +
            `${label} has [${list}]`
        );
      }
    }

    // Setting it is a change to the whole table's game, so it belongs to
    // the DM by the same structural rule as every other game-state
    // mutation — not to whoever has the Settings page open.
    if (!/setRulesVersion[\s\S]{0,400}?requireDm\(/.test(read("convex", "campaigns.ts"))) {
      problems.push(
        "campaigns.setRulesVersion does not go through requireDm — the " +
          "edition is campaign-wide, so a player could change what the " +
          "whole table sees"
      );
    }

    // ---- the header and the rows must share one grid template -------
    // They are two separate grids that line up only because both are
    // handed the same value. Nothing in CSS or TypeScript connects them:
    // give the header the resized template and the rows the declared
    // one and every column sits under the wrong heading, with no error
    // anywhere and a table that simply reads wrong.
    const lookupToolSrc = read("components", "LookupTool.tsx");
    const cols = [
      ...lookupToolSrc.matchAll(
        /\["--lk-cols" as string\]:\s*([A-Za-z_$][\w$]*)/g
      ),
    ].map((m) => m[1]);
    if (cols.length < 2) {
      throw new Error(
        `expected --lk-cols to be set for both the header and the rows, ` +
          `found ${cols.length} in LookupTool.tsx`
      );
    }
    if (new Set(cols).size !== 1) {
      problems.push(
        `LookupTool sets --lk-cols from [${[...new Set(cols)].join(", ")}] — ` +
          "the header and the rows are separate grids and must be given " +
          "the same template or the columns drift out from under their " +
          "headings"
      );
    }

    // ---- the artwork mirror must be a path the map server serves ----
    // This is the failure it exists for: the importer stored Foundry's
    // own "icons/..." paths, the fetcher wrote files in Foundry's own
    // shape, and the Caddyfile routes /web/* and /originals/* and
    // nothing else. Each file was reasonable alone. Together they gave
    // 7,361 images a URL that answers 200 with the words "Map server
    // up." — which an <img> cannot decode, so onError hid every one and
    // nothing anywhere reported a problem.
    const mirrorSrc = read("scripts", "mirror.mjs");
    const mirrorMatch = mirrorSrc.match(
      /export const FOUNDRY_MIRROR\s*=\s*"([^"]+)"/
    );
    if (!mirrorMatch) {
      throw new Error("no FOUNDRY_MIRROR in scripts/mirror.mjs");
    }
    const mirror = mirrorMatch[1];

    // The route is on the other side of a boundary nothing else crosses:
    // a Caddy config, in another directory, deployed to another machine.
    const caddyfile = readFileSync(
      appPath("..", "map-server", "Caddyfile"),
      "utf8"
    );
    const routes = [...caddyfile.matchAll(/handle_path\s+\/([^/\s*]+)\/\*/g)].map(
      (m) => m[1]
    );
    if (routes.length === 0) {
      throw new Error("found no handle_path routes in map-server/Caddyfile");
    }
    const firstSegment = mirror.split("/")[0];
    if (!routes.includes(firstSegment)) {
      problems.push(
        `artwork is stored under "${mirror}/", but map-server/Caddyfile ` +
          `routes only [${routes.join(", ")}] — every image would answer ` +
          "with the landing page instead of a file"
      );
    } else {
      // Where to PUT the files is a third fact, in a third file, and it
      // only looks like the other two. `web` is a URL prefix Caddy
      // strips; /srv/web is a path inside the container; and the host
      // directory is whatever docker-compose mounts there. Copying to
      // the wrong one of those lands every file one directory away from
      // where it is served — which looks exactly like copying nothing.
      const rootMatch = caddyfile
        .slice(caddyfile.indexOf(`handle_path /${firstSegment}/*`))
        .match(/root\s+\*\s+(\S+)/);
      if (!rootMatch) {
        throw new Error(`no root for the /${firstSegment}/* route in Caddyfile`);
      }
      const compose = readFileSync(
        appPath("..", "map-server", "docker-compose.yml"),
        "utf8"
      );
      const mount = compose.match(
        new RegExp(`-\\s+(\\S+):${rootMatch[1]}(?::\\w+)?\\s*$`, "m")
      );
      if (!mount) {
        problems.push(
          `map-server/docker-compose.yml mounts nothing at ${rootMatch[1]}, ` +
            `which is what Caddy serves /${firstSegment}/* from`
        );
      } else if (
        // Comments stripped first: the header explains this mount, and
        // matching the explanation instead of the code would let the
        // printed command drift while the guard stayed green.
        !stripComments(read("scripts", "fetch-foundry-images.mjs")).includes(
          mount[1]
        )
      ) {
        problems.push(
          "fetch-foundry-images.mjs prints a copy command that does not " +
            `name ${mount[1]} — the directory docker-compose actually ` +
            `mounts as ${rootMatch[1]}`
        );
      }
    }

    // Both scripts must take the prefix from mirror.mjs. A second copy
    // spelled out by hand is how the two halves drift apart: files
    // written under one path, rows pointing at another.
    for (const file of ["import-foundry.mjs", "fetch-foundry-images.mjs"]) {
      const src = read("scripts", file);
      if (!/import \{ FOUNDRY_MIRROR \} from "\.\/mirror\.mjs"/.test(src)) {
        problems.push(
          `scripts/${file} does not import FOUNDRY_MIRROR from mirror.mjs`
        );
      }
      // The whole prefix, not a string that merely starts with it —
      // "foundry-import" is the importer's default output directory and
      // has nothing to do with the mirror.
      if (new RegExp(`"${mirror}(/|")`).test(stripComments(src))) {
        problems.push(
          `scripts/${file} spells out "${mirror}" instead of using ` +
            "FOUNDRY_MIRROR — the two copies can drift"
        );
      }
    }

    // ---- flags must not be read by position ------------------------
    // `args[args.indexOf("--from") + 1]` reads args[0] when the flag is
    // ABSENT, because indexOf returns -1 — and the `?? default` beside
    // it never fires, because args[0] is a string. That shipped, and
    // sent seven thousand requests to a URL built out of the export's
    // own filename. scripts/args.mjs is the replacement.
    for (const file of readdirSync(appPath("scripts"))) {
      if (!file.endsWith(".mjs") || file === "args.mjs") continue;
      const src = stripComments(read("scripts", file));
      if (/indexOf\([^)]*\)\s*\+\s*1\s*\]/.test(src)) {
        problems.push(
          `scripts/${file} reads a flag as \`indexOf(...) + 1\`, which ` +
            "resolves to the first positional argument when the flag is " +
            "absent — use parseArgs from scripts/args.mjs"
        );
      }
    }

    // Required (non-optional) schema fields must always be written, or
    // every row fails validation at import time.
    for (const field of schemaFields) {
      const decl = npcsBlockSrc.match(
        new RegExp(`^\\s*${field}:\\s*(.+)$`, "m")
      );
      if (!decl) continue;
      const optional = decl[1].includes("v.optional(");
      if (!optional && !written.includes(field)) {
        problems.push(
          `npcs.${field} is required but import-npcs.mjs never writes it`
        );
      }
    }

    // ---- themes must agree in four places --------------------------
    // The schema defines them, a bootstrap script in layout.tsx applies
    // one before first paint, globals.css defines the palettes, and
    // Settings offers the choice. Add a theme and forget the bootstrap
    // allowlist and it silently flashes the default on every load —
    // annoying, and invisible to anyone who never picked that theme.
    const themeBlock = blockAfter(
      schemaSrc,
      /userSettings:\s*defineTable\(/,
      "userSettings in schema.ts"
    );
    const themes = [
      ...themeBlock.matchAll(/v\.literal\("([^"]+)"\)/g),
    ].map((m) => m[1]);

    if (themes.length === 0) {
      problems.push("could not read the theme list from the schema");
    }

    const layout = read("app", "layout.tsx");
    const themeList = read("components", "themes.ts");
    const css = read("app", "globals.css");

    for (const theme of themes) {
      if (!layout.includes(`'${theme}'`)) {
        problems.push(
          `theme "${theme}" is missing from the bootstrap allowlist in ` +
            "layout.tsx — it would flash the default on every load"
        );
      }
      if (!themeList.includes(`"${theme}"`)) {
        problems.push(`theme "${theme}" is not offered in components/themes.ts`);
      }
    }

    // Two places offer the choice, and both must read the shared list —
    // a theme in one and not the other is a palette some people can
    // never reach.
    for (const file of ["SettingsPanel.tsx", "RibbonBar.tsx"]) {
      if (!/THEMES/.test(read("components", file))) {
        problems.push(
          `${file} offers a theme choice without reading the shared THEMES list`
        );
      }
    }

    // And nothing in the CSS may claim a theme the schema doesn't have.
    for (const [, named] of css.matchAll(/\[data-theme="([^"]+)"\]/g)) {
      if (!themes.includes(named)) {
        problems.push(
          `globals.css styles [data-theme="${named}"], which is not a theme ` +
            "the schema allows"
        );
      }
    }

    // ---- the calendar ----------------------------------------------
    // Three places describe the same settings: the schema, the mutation
    // that writes them, and the shared model that reconciles them. A
    // setting added to one and not the others is silently dropped on
    // save — the form edits it, the mutation never sends it.
    const calSrc = read("convex", "calendar.ts");

    if (!/from "\.\.\/components\/calendarModel"/.test(calSrc)) {
      problems.push(
        "convex/calendar.ts no longer imports the shared calendar model — " +
          "a second copy of the reconciliation rules is how a five-day " +
          "week ends up with seven day names"
      );
    }

    const calFields = topLevelKeys(
      blockAfter(schemaSrc, /calendars:\s*defineTable\(/, "calendars table"),
      "calendars schema"
    ).filter((f) => f !== "campaignId");

    // Sliced first: blockAfter takes the next `{` after its match, and
    // matching on the whole declaration would hand it mutation's own
    // object rather than the args literal inside it.
    const saveArgs = topLevelKeys(
      blockAfter(
        calSrc.slice(calSrc.indexOf("export const saveCalendar")),
        /args:/,
        "saveCalendar args"
      ),
      "saveCalendar args"
    ).filter((f) => f !== "campaignId");

    for (const f of calFields) {
      if (!saveArgs.includes(f)) {
        problems.push(
          `the calendars table stores \`${f}\` but saveCalendar never takes it — ` +
            "editing it would silently do nothing"
        );
      }
    }
    for (const f of saveArgs) {
      if (!calFields.includes(f)) {
        problems.push(
          `saveCalendar takes \`${f}\`, which the calendars table has no column for`
        );
      }
    }

    // ---- Lookup: the kind union is stated twice --------------------
    // lookupFilters.ts cannot import it: the unit guard compiles pure
    // modules in isolation and TypeScript's path mapping is
    // compile-time only, so an imported sibling would leave an
    // unresolvable specifier in the emitted JS. Two copies, checked.
    const kinds = (file) => {
      const src = read("components", file);
      const m = src.match(/type LookupKind =([^;]+);/);
      if (!m) throw new Error(`no LookupKind in ${file}`);
      return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    };
    const fieldKinds = kinds("lookupFields.ts");
    const filterKinds = kinds("lookupFilters.ts");
    if (fieldKinds.join() !== filterKinds.join()) {
      problems.push(
        `LookupKind disagrees: lookupFields has [${fieldKinds}], ` +
          `lookupFilters has [${filterKinds}]`
      );
    }
    // Every kind must have a filter set and a column set behind it, or
    // its screen renders a bar and a table with nothing in them.
    const filtersSrc = read("components", "lookupFilters.ts");
    const fieldsSrc = read("components", "lookupFields.ts");
    for (const kind of fieldKinds) {
      if (!new RegExp(`\\b${kind}:\\s*\\w*FILTERS`).test(filtersSrc)) {
        problems.push(`LookupKind "${kind}" has no entry in FILTERS`);
      }
      if (
        !new RegExp(`\\b${kind}:\\s*\\[`).test(
          fieldsSrc.slice(fieldsSrc.indexOf("LOOKUP_COLUMNS"))
        )
      ) {
        problems.push(`LookupKind "${kind}" has no entry in LOOKUP_COLUMNS`);
      }
    }

    // A filter chip that matches nothing is invisible: it renders, it
    // is clickable, and it silently returns an empty list. The values
    // the importer produces and the values the filters offer are two
    // vocabularies written in two files, so they are compared here.
    const valuesOf = (src, name) => {
      const i = src.indexOf(`export const ${name}`);
      if (i === -1) throw new Error(`no ${name} in lookupFilters.ts`);
      const seg = src.slice(i, src.indexOf(";", i));
      return new Set([
        ...[...seg.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]),
        ...[...seg.matchAll(/^\s*"([^"]+)",?$/gm)].map((m) => m[1]),
      ]);
    };

    // Schools: the importer expands the dnd5e abbreviations, and the
    // filter offers the expansions.
    const importerSchools = new Set(
      [
        ...foundrySrc
          .slice(foundrySrc.indexOf("const SCHOOLS"))
          .slice(0, 400)
          .matchAll(/:\s*"([^"]+)"/g),
      ].map((m) => m[1])
    );
    for (const school of valuesOf(filtersSrc, "SCHOOLS")) {
      if (!importerSchools.has(school)) {
        problems.push(
          `the School filter offers "${school}", which import-foundry.mjs ` +
            "never produces — the chip would match nothing"
        );
      }
    }

    // Item kinds: the importer's bucket vocabulary is the union of the
    // equipment map's values and the literals itemKind returns.
    const kindFn = foundrySrc.slice(
      foundrySrc.indexOf("const EQUIPMENT_KINDS"),
      foundrySrc.indexOf("function humanize")
    );
    const importerKinds = new Set(
      [...kindFn.matchAll(/"([a-z]+)"/g)].map((m) => m[1])
    );
    for (const kind of valuesOf(filtersSrc, "ITEM_KINDS")) {
      if (!importerKinds.has(kind)) {
        problems.push(
          `the Category filter offers item kind "${kind}", which ` +
            "import-foundry.mjs never produces"
        );
      }
    }

    // ---- the notebook's format toolbar -----------------------------
    // Two failures here are invisible to TypeScript and both present as
    // "the toolbar does nothing", which reads as a broken browser rather
    // than a broken handler:
    //
    //   - onClick instead of onMouseDown+preventDefault. The click blurs
    //     the contentEditable and collapses its selection BEFORE the
    //     handler runs, so the command applies to nothing.
    //   - calling document.execCommand directly. That changes what is on
    //     screen and nothing else; the helper is what writes the box's
    //     new HTML back through the mutation, so a direct call looks
    //     applied and is gone on reload.
    // Code only: this file documents both traps in prose, and failing on
    // the explanation would punish it for warning the next reader.
    const fmtBar = stripComments(read("components", "NotebookFormatBar.tsx"));

    if (/onClick=/.test(fmtBar)) {
      problems.push(
        "NotebookFormatBar uses onClick — a click collapses the box's " +
          "selection before the handler runs; every control must be " +
          "onMouseDown with preventDefault()"
      );
    }
    const mouseDowns = [...fmtBar.matchAll(/onMouseDown=\{\(e\) => \{/g)];
    if (mouseDowns.length === 0) {
      problems.push("NotebookFormatBar has no onMouseDown handlers at all");
    }
    const preventDefaults = [...fmtBar.matchAll(/e\.preventDefault\(\)/g)];
    if (preventDefaults.length < mouseDowns.length) {
      problems.push(
        `NotebookFormatBar has ${mouseDowns.length} onMouseDown handlers but ` +
          `only ${preventDefaults.length} preventDefault() calls — one of ` +
          "them will silently format nothing"
      );
    }
    if (/document\.execCommand/.test(fmtBar)) {
      problems.push(
        "NotebookFormatBar calls document.execCommand directly — route it " +
          "through applyScrapbookTextFormat, which also persists the result"
      );
    }
    if (!/applyScrapbookTextFormat/.test(fmtBar)) {
      problems.push("NotebookFormatBar never calls applyScrapbookTextFormat");
    }

    // A <select> must NOT preventDefault on mousedown or it cannot open;
    // it is safe because the remembered range, not the live selection, is
    // what the apply helper restores. So the toolbar has to mount the
    // tracker that remembers it.
    const nbTool = stripComments(read("components", "NotebookTool.tsx"));
    if (!/addEventListener\("selectionchange", trackScrapbookSelection\)/.test(nbTool)) {
      problems.push(
        "NotebookTool does not mount the selectionchange tracker — the " +
          "format toolbar would act on whatever the last click left behind"
      );
    }
    if (!/registerScrapbookSaver/.test(nbTool)) {
      problems.push(
        "NotebookTool never registers a saver, so formatting would be lost " +
          "on reload"
      );
    }

    // ---- the shared feedback table's contract ----------------------
    // Three apps write to one Supabase table. Getting `app` wrong files
    // bugs under the wrong product and nobody notices for weeks, and a
    // stray `status` would let the form mark its own triage state.
    const feedback = read("components", "feedbackClient.ts");

    if (!/FEEDBACK_APP = "Game Mastery"/.test(feedback)) {
      problems.push(
        'feedbackClient must submit app = "Game Mastery" exactly — the ' +
          "table's CHECK constraint allows only the three known apps"
      );
    }
    const insertBody = feedback.slice(
      feedback.indexOf("async function insertRow"),
      feedback.indexOf("// ---- the local retry queue")
    );
    if (/\bstatus\b\s*:/.test(insertBody)) {
      problems.push(
        "feedbackClient sends `status` — that is Derek's triage state and " +
          "must never be written by an app"
      );
    }
    for (const c of ["Bug Report", "Suggestion", "Other"]) {
      if (!feedback.includes(`"${c}"`)) {
        problems.push(`feedback category "${c}" is missing from CATEGORIES`);
      }
    }
    if (/\bBug\b(?!\s+Report)/.test(feedback.match(/CATEGORIES = \[[^\]]*\]/)?.[0] ?? "")) {
      problems.push(
        'CATEGORIES contains a bare "Bug" — the shared table already ' +
          'drifted into holding both "Bug" and "Bug Report"'
      );
    }

    return problems;
  },
};
