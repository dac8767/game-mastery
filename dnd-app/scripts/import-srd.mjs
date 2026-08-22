#!/usr/bin/env node
/**
 * A rules document  ->  the `rules` table.
 *
 *   node scripts/import-srd.mjs <file-or-dir> [--source "SRD 5.2"] [-o out/]
 *   npx convex import --table rules out/rules.jsonl --replace --yes
 *
 * ---------------------------------------------------------------------
 * Where the document comes from
 *
 * The System Reference Document. Wizards publishes it under Creative
 * Commons — SRD 5.2 for the 2024 rules, SRD 5.1 for 2014 — which is
 * what makes it the right corpus for this: free to use, free to quote,
 * and covering the great majority of what anyone actually asks at a
 * table. Conditions, combat, resting, spellcasting, the skills.
 *
 * It wants MARKDOWN, not PDF. Wizards ship a PDF; community
 * conversions to markdown exist under the same licence. Point this at
 * a .md file or at a directory of them.
 *
 * The full PHB and DMG prose is NOT under that licence. This script
 * will happily chunk whatever you give it, and where that content may
 * live is a question about your books, not about this code.
 *
 * ---------------------------------------------------------------------
 * Why a script and not an upload
 *
 * Same reason as the Foundry importer: the source is tens of megabytes
 * of text that belongs on Derek's disk rather than in the repository,
 * and the conversion is deterministic — the same file in gives the
 * same rows out, so re-running it is always safe.
 *
 * `--replace` is what the table is for. There is no write path to
 * `rules` from the app, so nothing can be lost by replacing it.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { parseOrExit } from "./args.mjs";
import { chunkMarkdown, searchTextOf } from "./srdChunks.mjs";

const USAGE = `Usage: node scripts/import-srd.mjs <file-or-dir> [options]

  --source <name>   what to label these rules ("SRD 5.2" by default)
  -o <dir>          where to write the .jsonl (default: srd-import)
  --dry-run         report what it would write, write nothing

Then:
  npx convex import --table rules <dir>/rules.jsonl --replace --yes`;

const { positionals, flags } = parseOrExit(
  process.argv.slice(2),
  {
    "--source": { value: true, default: "SRD 5.2" },
    "-o": { value: true, default: "srd-import" },
    "--dry-run": {},
  },
  USAGE
);

const input = positionals[0];
if (!input) {
  console.error(`No input file.\n\n${USAGE}`);
  process.exit(1);
}

/** Every .md under a path, or the path itself if it is one. */
function markdownFiles(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];

  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/^\.(md|markdown|txt)$/i.test(extname(entry.name))) out.push(child);
    }
  };
  walk(path);
  // Sorted, so the same directory always imports in the same order and
  // `order` means the same thing between runs.
  return out.sort();
}

let files;
try {
  files = markdownFiles(input);
} catch (err) {
  console.error(`Could not read ${input}: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No .md files under ${input}`);
  process.exit(1);
}

const rows = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const chunks = chunkMarkdown(text, flags["--source"]);
  for (const chunk of chunks) {
    rows.push({
      source: chunk.source,
      title: chunk.title,
      breadcrumb: chunk.breadcrumb,
      text: chunk.text,
      search: searchTextOf(chunk),
      // Continuous across files, so book order survives a directory.
      order: rows.length,
    });
  }
  console.log(
    `${basename(file).padEnd(34)} ${String(chunks.length).padStart(5)} sections`
  );
}

const biggest = rows.reduce((a, r) => Math.max(a, r.text.length), 0);
console.log(
  `\n${rows.length} sections from ${files.length} file${
    files.length === 1 ? "" : "s"
  }, longest ${biggest} characters`
);

if (flags["--dry-run"]) {
  console.log("\n--dry-run: nothing written.");
  console.log("First three:");
  for (const r of rows.slice(0, 3)) {
    console.log(`  ${r.breadcrumb ? r.breadcrumb + " > " : ""}${r.title}`);
  }
  process.exit(0);
}

mkdirSync(flags["-o"], { recursive: true });
const out = join(flags["-o"], "rules.jsonl");
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log(`\nWrote ${out}`);
console.log(
  `\nnpx convex import --table rules ${out} --replace --yes`
);
