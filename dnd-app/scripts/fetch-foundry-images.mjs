#!/usr/bin/env node
/**
 * Pull a Foundry export's artwork out of a running Foundry.
 *
 *   node scripts/fetch-foundry-images.mjs <export.json> -o images/
 *   node scripts/fetch-foundry-images.mjs <export.json> -o images/ --from http://localhost:30000
 *
 * ---------------------------------------------------------------------
 * Why fetch rather than copy
 *
 * The paths in an export — "icons/magic/symbols/fleur-de-lis.webp",
 * "systems/dnd5e/tokens/thumbs/aberration/Aboleth.webp" — are relative
 * to Foundry, and the two roots do not live in the same place. `icons/`
 * ships inside the application bundle; `systems/` lives in the user
 * data directory, whose location differs per platform and per install.
 * Finding both on disk means guessing at two paths that are allowed to
 * move.
 *
 * A running Foundry serves both over HTTP from one origin, so this asks
 * it. Foundry has to be open, with the world loaded, which it already
 * is whenever you have just exported from it.
 *
 * ---------------------------------------------------------------------
 * What to do with the result
 *
 * The output directory mirrors Foundry's structure, so copying it onto
 * the map server's web root makes every path resolve as
 * `${NEXT_PUBLIC_MAP_SERVER}/icons/...`, the same convention NPC
 * portraits and location maps already use. Nothing is uploaded to
 * Convex: these are a thousand small shared icons, and the free tier's
 * file storage is better spent on Derek's own images.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("-"));
const outDir = args[args.indexOf("-o") + 1] ?? "foundry-images";
const from = (args[args.indexOf("--from") + 1] ?? "http://localhost:30000").replace(
  /\/+$/,
  ""
);
const force = args.includes("--force");

if (!source || args.includes("--help")) {
  console.error(
    "usage: node scripts/fetch-foundry-images.mjs <export.json> [-o dir] [--from url] [--force]\n\n" +
      "  <export.json>  the file the Foundry macro downloaded\n" +
      "  -o dir         where to write them (default: foundry-images)\n" +
      "  --from url     the running Foundry (default: http://localhost:30000)\n" +
      "  --force        re-download files that are already there\n"
  );
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`Cannot find: ${source}`);
  process.exit(1);
}

// ---------------------------------------------------------------------

const documents = JSON.parse(readFileSync(source, "utf8"));
const list = Array.isArray(documents) ? documents : [documents];

/**
 * Every distinct image path, from documents AND their embedded items —
 * a monster's artwork is on the actor, but its features carry their own.
 */
const paths = new Set();
const collect = (img) => {
  if (typeof img !== "string" || !img) return;
  if (/^https?:\/\//i.test(img)) return; // already hosted somewhere
  if (img.startsWith("icons/svg/")) return; // Foundry's placeholders
  paths.add(img);
};

for (const doc of list) {
  collect(doc?.img);
  for (const item of doc?.items ?? []) collect(item?.img);
  for (const token of [doc?.prototypeToken?.texture?.src]) collect(token);
}

console.log(`${paths.size} distinct image(s) referenced by ${list.length} document(s)`);
console.log(`fetching from ${from}\n`);

let fetched = 0;
let skipped = 0;
const missing = [];
let failed = 0;

for (const path of paths) {
  const target = join(outDir, path);

  if (!force && existsSync(target)) {
    skipped++;
    continue;
  }

  let res;
  try {
    res = await fetch(`${from}/${encodeURI(path)}`);
  } catch (e) {
    // A connection error is not a per-file problem — it means Foundry
    // is not running, and every remaining file will fail the same way.
    console.error(
      `\nCould not reach ${from} — is Foundry open with the world loaded?\n` +
        `(${e instanceof Error ? e.message : e})`
    );
    process.exit(1);
  }

  if (!res.ok) {
    // 404 is expected and worth listing: a module that was uninstalled
    // leaves its paths behind in documents that still reference them.
    if (res.status === 404) missing.push(path);
    else failed++;
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  fetched++;

  if (fetched % 100 === 0) process.stdout.write(`  ${fetched} fetched…\n`);
}

console.log(`\n  ${fetched} fetched into ${outDir}/`);
if (skipped > 0) console.log(`  ${skipped} already there (--force to redo)`);
if (missing.length > 0) {
  console.log(
    `  ${missing.length} not found in Foundry — probably from a module that ` +
      "was removed:"
  );
  for (const m of missing.slice(0, 5)) console.log(`      ${m}`);
  if (missing.length > 5) console.log(`      …and ${missing.length - 5} more`);
}
if (failed > 0) console.log(`  ${failed} failed for other reasons`);

console.log(
  `\nnext: copy ${outDir}/ onto the map server's web root, keeping the\n` +
    "structure, so the paths resolve as ${NEXT_PUBLIC_MAP_SERVER}/icons/...\n"
);
