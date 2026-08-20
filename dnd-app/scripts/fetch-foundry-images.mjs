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
 * The output directory is shaped for the map server, not for Foundry:
 * everything lands under `web/foundry/`, which is the one thing that
 * makes these reachable — Caddy routes `/web/*` and nothing else that
 * would match. See scripts/mirror.mjs.
 *
 * The `web/` level is the ROUTE, not a directory on the PowerEdge:
 * docker-compose mounts a host directory on the media array as the
 * container's /srv/web, which Caddy serves at /web/. So it is the
 * CONTENTS of `web/` that get copied, into the host path the compose
 * file names — the closing message prints the exact command, and a
 * guard holds it to what the compose file actually mounts.
 *
 * Every stored path then resolves as
 * `${NEXT_PUBLIC_MAP_SERVER}/web/foundry/icons/...`, the same convention
 * NPC portraits and location maps already use.
 *
 * Nothing is uploaded to Convex: these are seven thousand small shared
 * icons, and the free tier's file storage is better spent on Derek's own
 * images.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { parseOrExit } from "./args.mjs";
import { FOUNDRY_MIRROR } from "./mirror.mjs";

const USAGE =
  "usage: node scripts/fetch-foundry-images.mjs <export.json> [-o dir] " +
  "[--from url] [--jobs n] [--force]\n\n" +
  "  <export.json>  the file the Foundry macro downloaded\n" +
  "  -o dir         where to write them (default: foundry-images)\n" +
  "  --from url     the running Foundry (default: http://localhost:30000)\n" +
  "  --jobs n       how many to fetch at once (default: 8)\n" +
  "  --force        re-download files that are already there\n";

const { positionals, flags } = parseOrExit(
  process.argv.slice(2),
  {
    "-o": { value: true, default: "foundry-images" },
    "--from": { value: true, default: "http://localhost:30000" },
    "--jobs": { value: true, default: "8" },
    "--force": {},
    "--help": {},
  },
  USAGE
);

const source = positionals[0];
const outDir = flags["-o"];
const from = flags["--from"].replace(/\/+$/, "");
const force = flags["--force"];

if (!source || flags["--help"]) {
  console.error(USAGE);
  process.exit(1);
}

if (positionals.length > 1) {
  console.error(
    `expected one export file, got ${positionals.length}: ` +
      `${positionals.join(", ")}\n\n${USAGE}`
  );
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`Cannot find: ${source}`);
  process.exit(1);
}

// Checked before a single request, so a typo'd --from says so once
// rather than seven thousand times. The scheme is checked too, not just
// that it parses: `new URL("localhost:30000")` does NOT throw — it reads
// "localhost:" as the scheme — and then every fetch fails for a reason
// that says nothing about the missing http://.
let fromUrl;
try {
  fromUrl = new URL(from);
} catch {
  fromUrl = null;
}
if (!fromUrl || !/^https?:$/.test(fromUrl.protocol)) {
  console.error(
    `--from must be an http:// or https:// URL, got: ${from}\n\n${USAGE}`
  );
  process.exit(1);
}

const jobs = Number(flags["--jobs"]);
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) {
  console.error(`--jobs must be a whole number from 1 to 64, got ${flags["--jobs"]}`);
  process.exit(1);
}

// ---------------------------------------------------------------------

/**
 * The route the mirror is served under, and the directory on the map
 * server that Caddy serves it FROM.
 *
 * These are different things that look alike: `web` is a URL prefix
 * Caddy strips, /srv/web is a path INSIDE the container, and the
 * constant below is the host directory docker-compose mounts there.
 * Copying to the wrong one of those three puts every file a directory
 * away from where it is served, which looks exactly like copying
 * nothing. The integrity guard reads the Caddyfile and the compose file
 * and fails if this stops matching them.
 */
const ROUTE = FOUNDRY_MIRROR.split("/")[0];
const MAP_SERVER_ROOT = "/mnt/Media/game-mastery/maps-web";

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
  // Everything written is written under outDir. A path that climbs out
  // of it is not artwork, whatever it claims to be.
  if (img.startsWith("/") || normalize(img).startsWith("..")) return;
  paths.add(img);
};

for (const doc of list) {
  collect(doc?.img);
  for (const item of doc?.items ?? []) collect(item?.img);
  collect(doc?.prototypeToken?.texture?.src);
}

console.log(`${paths.size} distinct image(s) referenced by ${list.length} document(s)`);
console.log(`fetching from ${from} (${jobs} at a time)\n`);

let fetched = 0;
let skipped = 0;
const missing = [];
let failed = 0;

/**
 * Fetched in parallel because there are thousands of them and each is a
 * few kilobytes: the whole run is round-trip latency, not bandwidth.
 *
 * A connection error is not a per-file problem — it means Foundry is not
 * running, and every remaining file will fail the same way — so the
 * first one stops the run rather than repeating itself once per file.
 */
let unreachable = null;
let sample = null;

async function fetchOne(path) {
  // Fetched from Foundry's path, written under the mirror's. The two
  // differ on purpose: Foundry serves "icons/..." from its own root, and
  // the map server serves it from under "web/". See mirror.mjs.
  const target = join(outDir, FOUNDRY_MIRROR, path);

  if (!force && existsSync(target)) {
    skipped++;
    return;
  }

  let res;
  try {
    res = await fetch(`${from}/${encodeURI(path)}`);
  } catch (e) {
    unreachable ??= e instanceof Error ? e.message : String(e);
    return;
  }

  if (!res.ok) {
    // 404 is expected and worth listing: a module that was uninstalled
    // leaves its paths behind in documents that still reference them.
    if (res.status === 404) missing.push(path);
    else failed++;
    return;
  }

  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  fetched++;
  // Kept so the closing message can name a file that is actually there
  // to curl. A hand-picked example is a path this script may have
  // skipped, which makes the one check you run answer 404.
  sample ??= path;

  if (fetched % 250 === 0) process.stdout.write(`  ${fetched} fetched…\n`);
}

const queue = [...paths];
let next = 0;

await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (next < queue.length && unreachable === null) {
      await fetchOne(queue[next++]);
    }
  })
);

if (unreachable !== null) {
  console.error(
    `\nCould not reach ${from} — is Foundry open with the world loaded?\n` +
      `(${unreachable})`
  );
  process.exit(1);
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

// Two places these can be served from, and the stored paths are the
// same for both — which one is in use is NEXT_PUBLIC_MAP_SERVER being
// set or not, never a re-import.
//
// The trailing slash on the rsync source is load-bearing: it copies the
// CONTENTS of web/ into the mount, so `foundry/` lands beside the map
// server's own directories instead of nesting a second `web/`.
console.log(
  "\nnext — serve them from one of two places:\n\n" +
    "  no map server yet? let the app serve them itself:\n" +
    `    mv ${join(outDir, ROUTE)} public/${ROUTE}\n` +
    "    (or re-run this with  -o public  to write them straight there)\n" +
    "    leave NEXT_PUBLIC_MAP_SERVER unset, and restart the dev server\n\n" +
    "  map server up? put them on it:\n" +
    `    rsync -a --info=progress2 ${join(outDir, ROUTE)}/ ` +
    `YOUR-MAP-SERVER:${MAP_SERVER_ROOT}/\n` +
    "    (YOUR-MAP-SERVER is the only part to fill in)\n" +
    (sample
      ? `\nthen this should load: /${FOUNDRY_MIRROR}/${sample}\n`
      : "")
);
