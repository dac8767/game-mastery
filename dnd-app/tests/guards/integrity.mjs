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

import {
  read,
  exists,
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
    const IMPORTERS = [
      { file: "import-npcs.mjs", anchor: /const doc\s*=/ },
      { file: "import-foundry.mjs", anchor: /const row\s*=/ },
    ];

    let written = [];
    for (const { file, anchor } of IMPORTERS) {
      const fields = topLevelKeys(
        blockAfter(read("scripts", file), anchor, `the row literal in ${file}`),
        `${file} row`
      );
      for (const f of fields) {
        if (!schemaFields.includes(f)) {
          problems.push(
            `${file} writes \`${f}\`, which the npcs schema does not accept — the import would fail validation`
          );
        }
      }
      // Only the bulk CSV importer is expected to write every required
      // field; the Foundry one is checked against it below.
      if (file === "import-npcs.mjs") written = fields;
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
