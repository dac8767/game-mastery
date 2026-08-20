#!/usr/bin/env node
/**
 * Empty the three Lookup tables, so a change to their shape can be
 * pushed.
 *
 *   node scripts/clear-lookup.mjs
 *
 * ---------------------------------------------------------------------
 * Why this is needed at all
 *
 * Convex validates the documents ALREADY IN the database against a new
 * schema before it accepts a push. So renaming a field is not one step
 * but two: every existing row has to stop carrying the old name before
 * the schema is allowed to stop describing it. Skip that and the push is
 * rejected by a single leftover row —
 *
 *   Document with ID "n5700..." in table "items" does not match the
 *   schema: Object contains extra field 'description' that is not in the
 *   validator.
 *
 * — and, because the push was rejected, the import that would have
 * replaced that row hits the OLD validators and fails too. Nothing moves
 * until the tables are empty.
 *
 * ---------------------------------------------------------------------
 * Why EMPTYING is the right migration here, and nowhere else
 *
 * These three tables are the only ones in the app that can be thrown
 * away without losing anything. They are derived: every row comes from
 * `npx convex import` off a Foundry export, nothing in the app writes
 * them (convex/lookup.ts has queries only, and a guard enforces that),
 * and the import that follows replaces all of them anyway.
 *
 * Campaigns, NPCs, notebooks and locations are the opposite — they are
 * typed by hand and exist nowhere else — so they need a real backfill
 * migration, never this. Nothing here touches them: the table names are
 * a fixed list, checked against the schema by the integrity guard.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseOrExit } from "./args.mjs";

/**
 * The Lookup family. Kept as a literal list rather than read out of the
 * schema: this deletes data, and what it deletes should be legible here
 * rather than computed. The integrity guard checks the list still
 * matches the schema's Lookup tables, so adding a fourth cannot leave
 * this one silently behind.
 */
const TABLES = ["spells", "items", "monsters"];

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: node scripts/clear-lookup.mjs [--yes]\n\n" +
  `  Empties ${TABLES.join(", ")} on your DEV deployment so a change to\n` +
  "  their shape can be pushed. They are reference data with no write\n" +
  "  path; `npx convex import` puts them back.\n\n" +
  "  --yes   skip the confirmation prompt\n";

const { flags } = parseOrExit(
  process.argv.slice(2),
  { "--yes": {}, "--help": {} },
  USAGE
);

if (flags["--help"]) {
  console.log(USAGE);
  process.exit(0);
}

const convex = (args) =>
  spawnSync("npx", ["convex", ...args], {
    cwd: APP_ROOT,
    encoding: "utf8",
  });

// ---------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------

console.log(`About to empty these tables on your dev deployment:\n`);
for (const table of TABLES) {
  const r = convex(["data", table, "--limit", "1"]);
  const known = r.status === 0;
  const empty = known && /no documents in this table/i.test(r.stdout ?? "");
  console.log(
    `  ${table.padEnd(10)} ${
      !known ? "(could not read — is convex configured here?)" : empty ? "already empty" : "has rows"
    }`
  );
}
console.log(
  "\nThey hold imported reference data only. Nothing else is touched.\n"
);

if (!flags["--yes"]) {
  if (!process.stdin.isTTY) {
    console.error("Not a terminal — re-run with --yes to confirm.");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Empty them? [y/N] ");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Nothing was changed.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------

// An empty JSON ARRAY rather than a zero-byte file: `[]` is
// unambiguously a document list with nothing in it, where an empty file
// is only ambiguously anything. `--replace` then means "make the table
// contain exactly these documents", i.e. none.
const scratch = mkdtempSync(join(tmpdir(), "gm-clear-"));
const emptyFile = join(scratch, "empty.json");
writeFileSync(emptyFile, "[]");

let stuck = [];

for (const table of TABLES) {
  process.stdout.write(`  ${table.padEnd(10)} `);

  const r = convex([
    "import",
    "--table",
    table,
    "--replace",
    "--yes",
    emptyFile,
  ]);

  if (r.status !== 0) {
    console.log("failed");
    console.log(
      (r.stdout ?? "").trim().split("\n").map((l) => `      ${l}`).join("\n")
    );
    console.error(
      (r.stderr ?? "").trim().split("\n").map((l) => `      ${l}`).join("\n")
    );
    stuck.push(table);
    continue;
  }

  // Verified rather than assumed. A clear that reports success and left
  // the rows in place would send you back to the same rejected push
  // with no idea why.
  const after = convex(["data", table, "--limit", "1"]);
  if (after.status === 0 && /no documents in this table/i.test(after.stdout ?? "")) {
    console.log("empty");
  } else {
    console.log("still has rows");
    stuck.push(table);
  }
}

if (stuck.length > 0) {
  console.error(
    `\nCould not empty: ${stuck.join(", ")}\n\n` +
      "Clear them by hand instead — it is one button:\n" +
      "  npx convex dashboard\n" +
      "  Data -> pick the table -> the ⋯ menu above the rows -> Clear table\n\n" +
      "Then carry on with `npx convex dev --once`."
  );
  process.exit(1);
}

console.log(
  "\nDone. Next:\n" +
    "  npx convex dev --once      # the new schema will push now\n" +
    "  npx convex import ...      # put the data back\n"
);
