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

    // ---- sidebar slugs must have pages behind them -----------------
    const shellSrc = read("components", "AppShell.tsx");
    for (const slug of stringProps(shellSrc, "slug", "AppShell nav items")) {
      if (!exists("app", "campaign", "[campaignId]", slug, "page.tsx")) {
        problems.push(
          `sidebar links to "${slug}" but app/campaign/[campaignId]/${slug}/page.tsx does not exist`
        );
      }
    }

    // ---- the importer writes fields the schema must accept ---------
    const importerSrc = read("scripts", "import-npcs.mjs");
    const written = topLevelKeys(
      blockAfter(importerSrc, /const doc\s*=/, "the doc literal in import-npcs.mjs"),
      "importer doc"
    );
    for (const f of written) {
      if (!schemaFields.includes(f)) {
        problems.push(
          `import-npcs.mjs writes \`${f}\`, which the npcs schema does not accept — the import would fail validation`
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
    const panel = read("components", "SettingsPanel.tsx");
    const css = read("app", "globals.css");

    for (const theme of themes) {
      if (!layout.includes(`'${theme}'`)) {
        problems.push(
          `theme "${theme}" is missing from the bootstrap allowlist in ` +
            "layout.tsx — it would flash the default on every load"
        );
      }
      if (!panel.includes(`"${theme}"`)) {
        problems.push(`theme "${theme}" is not offered in Settings`);
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
