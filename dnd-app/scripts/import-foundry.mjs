#!/usr/bin/env node
/**
 * Foundry VTT export  ->  Game Mastery.
 *
 *   node scripts/import-foundry.mjs <path> <campaignId> [-o out/]
 *
 *   npx convex import --table npcs out/npcs.jsonl --append
 *   npx convex run locations:importLocations "$(cat out/locations.json)" \
 *     --identity '{"subject":"YOUR_USER_ID|seed"}'
 *
 * ---------------------------------------------------------------------
 * What this is, and what it is not
 *
 * This is NOT a port of MrPrimate's ddb-importer. That module's job is
 * to talk to D&D Beyond through an authenticated proxy service and
 * write dnd5e documents into Foundry; its shipped code is a bundled
 * dist/main.mjs, and the D&D Beyond half is a service, not a file. None
 * of that is portable here.
 *
 * What IS portable is the far end of it: once ddb-importer has run, the
 * content is sitting in Foundry in a documented, stable JSON shape.
 * This reads that shape. So the pipeline is
 *
 *     D&D Beyond --(ddb-importer)--> Foundry --(this)--> Game Mastery
 *
 * ---------------------------------------------------------------------
 * What it accepts
 *
 *   - a single "Export Data" JSON file (one Actor / Scene / Journal)
 *   - a JSON array of those
 *   - a NeDB .db file (one JSON document per line — world data and
 *     compendium packs from Foundry v10 and earlier)
 *   - a directory containing any mix of the above
 *
 * Foundry v11+ stores packs in LevelDB, which is a binary format this
 * cannot read. Export those to JSON from inside Foundry first (right
 * click the compendium -> Export, or the Foundry CLI's `package unpack`).
 *
 * ---------------------------------------------------------------------
 * What it maps
 *
 *   Actor (type "npc")  -> an npcs row
 *   Scene               -> a location, with the scene's image as its map
 *   Scene note          -> a child location, pinned at the note's spot
 *   JournalEntry        -> the description of the location its note names
 *
 * The scene mapping is the one worth having: a Foundry scene's notes
 * are already pins at coordinates on a map, which is exactly the shape
 * the Locations tool wants. Note coordinates are absolute pixels within
 * the scene, so they are divided by the scene's dimensions here —
 * Game Mastery stores pins normalized 0..1 so they survive the map
 * being re-scanned at a different size.
 *
 * Images are NOT copied. Foundry paths like
 * "worlds/moonbrook/scenes/region.webp" are written through as
 * mapPath/portraitPath, the same convention scripts/import-npcs.mjs
 * uses: put the files on the map server under those paths and they
 * resolve, or ignore them and upload through the app instead.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, extname, basename } from "node:path";

// ---------------------------------------------------------------------
// Reading whatever Foundry gave us
// ---------------------------------------------------------------------

/** Every JSON document under `path`, whatever container it arrived in. */
function readDocuments(path) {
  const stat = statSync(path);

  if (stat.isDirectory()) {
    return readdirSync(path)
      .filter((f) => [".json", ".db"].includes(extname(f).toLowerCase()))
      .flatMap((f) => readDocuments(join(path, f)));
  }

  const text = readFileSync(path, "utf8");

  // A .db file is JSONL — and so is a .json file someone concatenated,
  // so the shape is sniffed rather than trusted to the extension.
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    throw new Error(`${path}: not JSON`);
  }

  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [arr];
  }

  // One object, or one per line.
  try {
    const one = JSON.parse(text);
    // A folder export wraps its contents; unwrap the common shapes.
    if (Array.isArray(one.entries)) return one.entries;
    if (Array.isArray(one.documents)) return one.documents;
    return [one];
  } catch {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new Error(`${path}: line ${i + 1} is not valid JSON`);
        }
      })
      // NeDB tombstones mark deletions; they are not documents.
      .filter((d) => d && !d.$$deleted);
  }
}

/**
 * What kind of Foundry document is this?
 *
 * Exports do not reliably carry a discriminator — "Export Data" writes
 * one, a raw .db line does not — so the shape decides. Order matters:
 * a Scene has a `name` like everything else, so it is identified by the
 * fields only a Scene has.
 */
function classify(doc) {
  if (!doc || typeof doc !== "object" || !doc.name) return null;

  const declared = (doc.documentName ?? doc.type ?? "").toString();
  if (declared === "Scene") return "scene";
  if (declared === "JournalEntry") return "journal";

  if (doc.grid !== undefined && (doc.width !== undefined || doc.background)) {
    return "scene";
  }
  if (Array.isArray(doc.pages) || typeof doc.content === "string") {
    return "journal";
  }
  if (doc.system || doc.data) {
    const t = declared.toLowerCase();
    if (t === "npc" || t === "character" || t === "vehicle" || t === "group") {
      return "actor";
    }
    // A dnd5e Item also has `system`; actors are the ones with a token.
    if (doc.prototypeToken || doc.token) return "actor";
  }
  return null;
}

// ---------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------

/** Foundry biographies are HTML. The NPC table's fields are plain text. */
function stripHtml(html) {
  if (typeof html !== "string" || !html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/** `system` in v10+, `data` before that. */
const sys = (doc) => doc.system ?? doc.data ?? {};

/** Title Case a dnd5e slug: "humanoid" -> "Humanoid". */
function titleCase(s) {
  const t = clean(s);
  return t ? t[0].toUpperCase() + t.slice(1) : undefined;
}

// ---------------------------------------------------------------------
// Actor -> npcs row
// ---------------------------------------------------------------------

const SIZES = {
  tiny: "Tiny",
  sm: "Small",
  med: "Medium",
  lg: "Large",
  huge: "Huge",
  grg: "Gargantuan",
};

function actorToNpc(doc, campaignId) {
  const s = sys(doc);
  const details = s.details ?? {};
  const traits = s.traits ?? {};

  // dnd5e moved creature type from a string to an object; both shapes
  // still turn up in the wild, and in the same export.
  const typeField = details.type;
  const species =
    clean(details.race?.name ?? details.race) ||
    titleCase(typeField?.subtype) ||
    titleCase(typeField?.value ?? typeField) ||
    undefined;

  const bio =
    stripHtml(details.biography?.public) ??
    stripHtml(details.biography?.value) ??
    undefined;

  const size = SIZES[traits.size] ?? titleCase(traits.size);
  const cr = details.cr;
  const facts = [
    size && `${size}`,
    cr !== undefined && cr !== null && `CR ${cr}`,
    details.environment && clean(details.environment),
  ].filter(Boolean);

  // Named `doc` and returned separately so tests/guards/integrity.mjs
  // can read the written field names the same way it reads the CSV
  // importer's — both write into a schema only the deployment
  // validates, i.e. at import time, on real data.
  const row = {
    campaignId,
    name: clean(doc.name) || "Unnamed",
    noLastName: true, // Foundry actors carry one name, not a family one
    status: ["Alive"],
    groups: [],
    familyMembers: [],
    place: [],
    hidden: false,

    species,
    alignment: clean(details.alignment) || undefined,
    description: bio,
    // The stat-block facts Foundry has and the NPC table has no column
    // for. Better in a field a DM reads than dropped.
    abilities: facts.length > 0 ? facts.join(" · ") : undefined,
    // A Foundry image path, not a URL. See the header.
    portraitPath: relativeImage(doc.img),
  };
  return row;
}

/**
 * Keep a Foundry-relative image path; drop absolute URLs and the
 * built-in icon set.
 *
 * A path into Foundry's own icons ("icons/svg/mystery-man.svg") is the
 * placeholder every un-illustrated actor has, and writing it would give
 * hundreds of NPCs the same portrait that then 404s on the map server.
 */
function relativeImage(img) {
  if (typeof img !== "string" || !img) return undefined;
  if (/^https?:\/\//i.test(img)) return undefined;
  if (img.startsWith("icons/")) return undefined;
  if (img.startsWith("systems/")) return undefined;
  return img;
}

// ---------------------------------------------------------------------
// Scene -> a location with pins
// ---------------------------------------------------------------------

function sceneImage(doc) {
  return relativeImage(doc.background?.src ?? doc.img);
}

/** Keys only have to be unique inside one payload. */
let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

/**
 * A scene and its notes, FLAT, with parentage carried by key.
 *
 * Not nested: the Convex ids do not exist until the import mutation
 * runs, so a nested payload could not reference itself, and a recursive
 * validator buys nothing when the resolution has to happen server-side
 * anyway.
 */
function sceneToLocations(doc, journalsById) {
  // v10+ nests dimensions; older exports have them at the top level.
  const width = Number(doc.width ?? doc.background?.width ?? 0);
  const height = Number(doc.height ?? doc.background?.height ?? 0);

  const key = nextKey();
  const children = [];
  for (const note of doc.notes ?? []) {
    const journal = journalsById.get(note.entryId) ?? null;
    const name =
      clean(note.text) || clean(journal?.name) || "Unnamed place";

    // Absolute pixels within the scene -> normalized 0..1. Without the
    // dimensions there is nothing to divide by, so the child is kept
    // without a pin rather than dropped: it still belongs here.
    const pinned = width > 0 && height > 0;
    children.push({
      key: nextKey(),
      parentKey: key,
      name,
      description: journal ? journalText(journal) : undefined,
      x: pinned ? clamp01(Number(note.x) / width) : undefined,
      y: pinned ? clamp01(Number(note.y) / height) : undefined,
    });
  }

  return [
    {
      key,
      name: clean(doc.navName) || clean(doc.name) || "Unnamed scene",
      mapPath: sceneImage(doc),
    },
    ...children,
  ];
}

/** v10+ journals are a list of pages; before that, one content string. */
function journalText(journal) {
  if (Array.isArray(journal.pages)) {
    const parts = journal.pages
      .map((p) => stripHtml(p.text?.content ?? p.text?.markdown))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return stripHtml(journal.content);
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, Math.round(n * 10000) / 10000));
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

const [, , path, campaignId, ...rest] = process.argv;

if (!path || !campaignId) {
  console.error(
    "usage: node scripts/import-foundry.mjs <path> <campaignId> [-o out/]\n\n" +
      "  <path>        a Foundry export .json, a NeDB .db, or a directory\n" +
      "  <campaignId>  the Convex id of the campaign to import into\n"
  );
  process.exit(1);
}

const outDir = rest[rest.indexOf("-o") + 1] ?? "foundry-import";
if (rest.includes("-o") && !outDir) {
  console.error("-o needs a directory");
  process.exit(1);
}

const documents = readDocuments(path);
const journalsById = new Map();
const skipped = { unrecognised: 0, characters: 0 };

// Journals first: a scene's notes reference them by id.
for (const doc of documents) {
  if (classify(doc) === "journal") journalsById.set(doc._id, doc);
}

const npcs = [];
const locations = [];

for (const doc of documents) {
  const kind = classify(doc);

  if (kind === "actor") {
    const type = (doc.type ?? "").toLowerCase();
    // Player characters belong to players, not to the NPC roster.
    if (type === "character") {
      skipped.characters++;
      continue;
    }
    npcs.push(actorToNpc(doc, campaignId));
    continue;
  }

  if (kind === "scene") {
    locations.push(...sceneToLocations(doc, journalsById));
    continue;
  }

  if (kind !== "journal") skipped.unrecognised++;
}

mkdirSync(outDir, { recursive: true });

const npcPath = join(outDir, "npcs.jsonl");
writeFileSync(npcPath, npcs.map((n) => JSON.stringify(n)).join("\n") + "\n");

const locPath = join(outDir, "locations.json");
writeFileSync(
  locPath,
  JSON.stringify({ campaignId, locations }, null, 2) + "\n"
);

// A short report, so a silently-empty import is visible before it runs.
const scenes = locations.filter((l) => !l.parentKey);
const pinned = locations.filter((l) => l.x !== undefined).length;
const unpinned = locations.filter(
  (l) => l.parentKey && l.x === undefined
).length;

console.log(`read ${documents.length} document(s) from ${basename(path)}`);
console.log(`  ${npcs.length} NPC(s) -> ${npcPath}`);
console.log(
  `  ${scenes.length} scene(s) and ${locations.length - scenes.length} pin(s) -> ${locPath}`
);
console.log(`  ${journalsById.size} journal(s) read for descriptions`);
console.log(`  ${pinned} pin(s) placed, ${unpinned} without coordinates`);
if (skipped.characters > 0) {
  console.log(`  ${skipped.characters} player character(s) skipped`);
}
if (skipped.unrecognised > 0) {
  console.log(`  ${skipped.unrecognised} document(s) of other kinds skipped`);
}

const withoutPortrait = npcs.filter((n) => !n.portraitPath).length;
if (withoutPortrait > 0) {
  console.log(
    `\nnote: ${withoutPortrait} NPC(s) have no usable image path — Foundry's ` +
      "built-in placeholder icons are deliberately not imported."
  );
}

console.log(
  `\nnext:\n` +
    `  npx convex import --table npcs ${npcPath} --append\n` +
    `  npx convex run locations:importLocations "$(cat ${locPath})" \\\n` +
    `    --identity '{"subject":"YOUR_USER_ID|seed"}'\n\n` +
    `The locations import runs a DM-gated mutation, so it needs to run ` +
    `as you — see SETUP-CONVEX.md for where YOUR_USER_ID comes from.\n`
);
