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

import { read, exists, blockAfter, topLevelKeys, stringProps } from "./lib.mjs";

/** Convex adds these to every document. */
const SYSTEM_FIELDS = ["_id", "_creationTime"];

/** Grid column keys that aren't NPC fields. */
const SYNTHETIC_COLUMNS = ["__dm"];

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
    const tableSrc = read("components", "NpcTable.tsx");
    const addressed = new Set([
      ...stringProps(tableSrc, "key", "NpcTable COLUMNS/FACETS/EXTRA_SORTS"),
      ...topLevelKeys(
        blockAfter(
          tableSrc,
          /const DEFAULT_WIDTHS[^=]*=/,
          "DEFAULT_WIDTHS in NpcTable.tsx"
        ),
        "DEFAULT_WIDTHS"
      ),
    ]);

    const available = new Set([...returned, ...SYNTHETIC_COLUMNS]);
    for (const key of addressed) {
      if (key.startsWith("[")) continue; // computed key, e.g. [DM_COL]
      if (!available.has(key)) {
        problems.push(
          `NpcTable addresses \`${key}\`, which npcs.listForCampaign never returns`
        );
      }
    }

    // Widths must exist for every rendered column, or it collapses.
    const widthKeys = new Set(
      topLevelKeys(
        blockAfter(tableSrc, /const DEFAULT_WIDTHS[^=]*=/, "DEFAULT_WIDTHS"),
        "DEFAULT_WIDTHS"
      )
    );
    const columnBlock = tableSrc.slice(
      tableSrc.indexOf("const COLUMNS"),
      tableSrc.indexOf("const DM_COL")
    );
    for (const [, key] of columnBlock.matchAll(/key:\s*"([^"]+)"/g)) {
      if (!widthKeys.has(key)) {
        problems.push(`column \`${key}\` has no entry in DEFAULT_WIDTHS`);
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
