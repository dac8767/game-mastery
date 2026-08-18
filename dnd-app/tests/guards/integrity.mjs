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
} from "./lib.mjs";

/** Convex adds these to every document. */
const SYSTEM_FIELDS = ["_id", "_creationTime"];

export const integrity = {
  name: "integrity",
  description: "no dangling references across schema, query, grid, and routes",
  run() {
    const problems = [];

    // ---- what the schema actually defines -------------------------
    const schemaSrc = read("convex", "schema.ts");
    const schemaFields = topLevelKeys(
      blockAfter(schemaSrc, /npcs:\s*defineTable\(/, "npcs table in schema.ts"),
      "npcs schema"
    );

    // ---- what the query actually returns ---------------------------
    const npcsSrc = read("convex", "npcs.ts");
    const returned = topLevelKeys(
      blockAfter(npcsSrc, /\.map\(\(n\)\s*=>\s*\(/, "the row shaper in npcs.ts"),
      "listForCampaign row"
    );

    for (const f of returned) {
      if (SYSTEM_FIELDS.includes(f)) continue;
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

    const available = new Set(returned);
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
    const npcsBlock = blockAfter(
      schemaSrc,
      /npcs:\s*defineTable\(/,
      "npcs table"
    );
    for (const field of schemaFields) {
      const decl = npcsBlock.match(
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

    return problems;
  },
};
