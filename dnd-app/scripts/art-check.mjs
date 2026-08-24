/**
 * Why the Lookup pictures are not showing.
 *
 * The Lookup tables store a mirror-relative path — "web/foundry/icons/…"
 * — and the browser hangs it off NEXT_PUBLIC_MAP_SERVER when there is
 * one, or off the app's own origin when there is not, in which case the
 * files are served straight out of public/. Three separate things have
 * to line up, and when they do not the failure is one <img> at a time,
 * silently, seven thousand times over:
 *
 *   1. the rows carry an image path at all
 *   2. the mirror exists where the app is going to look for it
 *   3. the paths in the rows match the files in the mirror
 *
 * This checks all three without touching the network or the database,
 * because the two most likely answers — "the mirror is not there" and
 * "the last import wrote no image paths" — are both answerable from
 * disk, and asking Convex would need a deployment key to find that out.
 *
 *   node scripts/art-check.mjs
 *   node scripts/art-check.mjs ../elsewhere/foundry-import
 *
 * It reads the JSONL the importer last wrote, so it is telling you
 * about the import you last ran rather than about what is in the
 * database now. If those have diverged, re-run the import block in
 * CLAUDE.md and run this again.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FOUNDRY_MIRROR } from "./mirror.mjs";

const APP = resolve(import.meta.dirname, "..");
const importDir = resolve(APP, process.argv[2] ?? "foundry-import");
const publicMirror = join(APP, "public", FOUNDRY_MIRROR);

/** Every file under a directory, counted rather than listed. */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(path);
    else if (entry.isFile()) n += 1;
  }
  return n;
}

const lines = [];
const say = (s = "") => lines.push(s);

say();
say("Lookup artwork — three things that have to line up");
say("─".repeat(64));

// ---- 1. the mirror on disk --------------------------------------
const mirrored = countFiles(publicMirror);
say();
say(`1. the mirror   public/${FOUNDRY_MIRROR}`);
if (!existsSync(publicMirror)) {
  say(`   MISSING — the directory does not exist.`);
  say(`   Nothing the app asks for can be served, so every row shows`);
  say(`   an empty dashed square. Fetch it:`);
  say(`     node scripts/fetch-foundry-images.mjs <foundry-url> -o public`);
} else if (mirrored === 0) {
  say(`   EMPTY — the directory is there with no files in it.`);
  say(`     node scripts/fetch-foundry-images.mjs <foundry-url> -o public`);
} else {
  say(`   ${mirrored.toLocaleString()} file(s)`);
}

// ---- 2. the paths the last import wrote --------------------------
say();
say(`2. the rows     ${importDir}`);

const tables = ["spells", "items", "monsters"];
/** Every image path the import wrote, per table. */
const paths = new Map();

if (!existsSync(importDir)) {
  say(`   MISSING — no import output here.`);
  say(`   Pass the directory as an argument, or re-run the converter.`);
} else {
  for (const table of tables) {
    const file = join(importDir, `${table}.jsonl`);
    if (!existsSync(file)) {
      say(`   ${table.padEnd(9)} no ${table}.jsonl`);
      continue;
    }
    let rows = 0;
    let withArt = 0;
    const seen = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      rows += 1;
      let doc;
      try {
        doc = JSON.parse(line);
      } catch {
        continue;
      }
      const image = typeof doc.image === "string" ? doc.image.trim() : "";
      if (!image) continue;
      withArt += 1;
      seen.push(image);
    }
    paths.set(table, seen);
    const share = rows === 0 ? 0 : Math.round((withArt / rows) * 100);
    const verdict =
      withArt === 0
        ? "  <-- no image paths at all; the import lost them"
        : "";
    say(
      `   ${table.padEnd(9)} ${withArt.toLocaleString()} of ` +
        `${rows.toLocaleString()} rows carry a path (${share}%)${verdict}`
    );
  }
}

// ---- 3. do the paths point at files that exist? ------------------
// A sample, not all 7,000: this answers "are these the right paths"
// and stat-ing every row to say so twice as slowly helps nobody.
say();
say("3. the match    do those paths resolve to real files?");

const SAMPLE = 40;
let checked = 0;
let found = 0;
const misses = [];

for (const [table, seen] of paths) {
  if (seen.length === 0) continue;
  // Spread across the table rather than taking the first N, so a
  // sample cannot come back clean off one directory that happened to
  // download while the rest did not.
  const step = Math.max(1, Math.ceil(seen.length / SAMPLE));
  let taken = 0;
  for (let i = 0; i < seen.length && taken < SAMPLE; i += step) {
    const rel = seen[i].replace(/^\/+/, "");
    const onDisk = join(APP, "public", rel);
    checked += 1;
    taken += 1;
    if (existsSync(onDisk) && statSync(onDisk).isFile()) found += 1;
    else if (misses.length < 3) misses.push(`${table}: ${rel}`);
  }
}

/* Below this the mirror is too thin to draw a conclusion from. One
   stray file is not evidence that the download worked and the paths
   are wrong; it is evidence that the download did not happen. */
const MIRROR_ENOUGH = 100;

if (checked === 0) {
  say("   nothing to check — no image paths were read above.");
} else {
  say(`   ${found} of ${checked} sampled path(s) exist under public/`);
  for (const miss of misses) say(`   missing: ${miss}`);
  if (found === 0 && mirrored >= MIRROR_ENOUGH) {
    say();
    say(`   The mirror holds ${mirrored.toLocaleString()} files and none of`);
    say("   them are where the rows say. That is a PREFIX mismatch, not a");
    say("   missing download — the import and the fetch disagree about");
    say("   where art lives. Both take it from scripts/mirror.mjs");
    say(`   (${FOUNDRY_MIRROR}), so one of them is out of date.`);
  } else if (found === 0) {
    say();
    say("   Nothing resolves, and the mirror is empty or nearly so —");
    say("   the artwork has not been fetched, rather than fetched to the");
    say("   wrong place. This is the usual answer after a fresh clone.");
  }
}

// ---- and the one thing that is not on disk -----------------------
say();
say("─".repeat(64));
say("If all three are green and the pictures are still missing, the");
say("app is asking a map server for them rather than itself. Check");
say("NEXT_PUBLIC_MAP_SERVER in .env.local: set, the files must be on");
say("the map server and public/ is not consulted; unset, they are");
say("served from public/. It is read at BUILD time, so a dev server");
say("started before you changed it is still using the old value —");
say("restart it.");
say();

console.log(lines.join("\n"));
