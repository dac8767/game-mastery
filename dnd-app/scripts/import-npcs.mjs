#!/usr/bin/env node
/**
 * Airtable "NPCs Master List" CSV  ->  JSONL for `npx convex import`.
 *
 *   node scripts/import-npcs.mjs <csv-path> <campaignId> [-o npcs.jsonl]
 *   npx convex import --table npcs npcs.jsonl --append
 *
 * Why JSONL + `convex import` instead of looping a mutation: the import
 * path writes straight to the table, so a 200-row (or 20,000-row) load
 * costs zero function calls out of the free tier's pooled monthly budget,
 * and it validates against the schema so a malformed row fails the batch
 * instead of half-writing the roster.
 *
 * Airtable shapes this handles:
 *   - Multi-selects come out comma-separated  -> string arrays
 *   - Checkboxes come out as the word "checked" -> booleans
 *   - Attachments come out as `filename (https://…signed-url)`. Those
 *     URLs are signed and EXPIRE, so only the filename survives here.
 *     Download the images from Airtable before the links die, drop them
 *     on the map server under web/portraits/npcs/, and the derived
 *     portraitPath will resolve.
 *   - Empty cells are omitted entirely rather than written as "", so
 *     optional fields stay undefined and the UI's facets stay clean.
 */

import { readFileSync, writeFileSync } from "node:fs";

/** Minimal RFC 4180 parser — fields may contain commas, quotes, newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // handled by the \n branch
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();

/** Optional free text: undefined when empty, newlines preserved. */
function text(s) {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/** Airtable multi-select -> deduped array of trimmed values. */
function multi(s) {
  const raw = (s ?? "").trim();
  if (!raw) return [];
  const seen = new Set();
  for (const part of raw.split(",")) {
    const p = clean(part);
    if (p) seen.add(p);
  }
  return Array.from(seen);
}

/** Airtable checkbox -> boolean. */
const checked = (s) => (s ?? "").trim().toLowerCase() === "checked";

/** Numeric cell -> number, or undefined when blank/unparseable. */
function num(s) {
  const t = (s ?? "").trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `image.png (https://…)` -> "web/portraits/npcs/<npc-name-slug>.png"
 *
 * Named off the NPC rather than the attachment: several Airtable
 * attachments are literally called "image.png", so keeping the original
 * filename would collide. The extension is preserved so the file you
 * download from Airtable only needs renaming, not converting.
 */
function portrait(s, npcName) {
  const t = (s ?? "").trim();
  if (!t) return undefined;
  const filename = clean(t.split("(")[0]);
  if (!filename) return undefined;

  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "png").toLowerCase();
  const slug = npcName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return undefined;

  return `web/portraits/npcs/${slug}.${ext}`;
}

// ---------------------------------------------------------------------

const [csvPath, campaignId] = process.argv.slice(2);
const outFlag = process.argv.indexOf("-o");
const outPath =
  outFlag !== -1 ? process.argv[outFlag + 1] : "npcs.jsonl";

if (!csvPath || !campaignId) {
  console.error(
    "usage: node scripts/import-npcs.mjs <csv-path> <campaignId> [-o npcs.jsonl]"
  );
  process.exit(1);
}

const raw = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
const rows = parseCsv(raw);
const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
const body = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));

const col = (r, name) => {
  const i = header.indexOf(name);
  return i === -1 ? "" : (r[i] ?? "");
};

const docs = body.map((r) => {
  // `Name` is an Airtable formula column joining the name parts, which
  // leaves double spaces wherever a middle name is blank.
  const name =
    clean(col(r, "Name")) || clean(col(r, "First")) || "(unnamed)";

  const doc = {
    campaignId,

    name,
    prefix: text(col(r, "Prefix")),
    first: text(col(r, "First")),
    middle: text(col(r, "Middle")),
    family: text(col(r, "Family")),
    suffix: text(col(r, "Suffix")),
    nickname: text(col(r, "Nickname")),
    noLastName: checked(col(r, "No Last Name")),

    status: multi(col(r, "Status")),
    gender: text(col(r, "Gender")),
    species: text(col(r, "Species")),
    lineage: text(col(r, "Lineage")),
    sexuality: text(col(r, "Sexuality")),
    alignment: text(col(r, "Alignment")),

    startingAge: num(col(r, "Starting Age")),
    age: num(col(r, "Age")),
    maxAge: num(col(r, "Max Age")),
    maturity: text(col(r, "Maturity")),

    groups: multi(col(r, "Groups")),
    job: text(col(r, "Job")),
    familyMembers: multi(col(r, "Family Members")),
    familyMemberCount: num(col(r, "Family Member Count")),

    place: multi(col(r, "Place")),
    region: text(col(r, "Region")),
    kingdom: text(col(r, "Kingdom")),

    description: text(col(r, "Description")),
    quirkMental: text(col(r, "Quirk - Mental")),
    quirkPhysical: text(col(r, "Quirk - Physical")),
    politics: text(col(r, "Politics")),
    abilities: text(col(r, "Abilities")),
    wantsNeeds: text(col(r, "Wants & Needs")),
    voice: text(col(r, "Voice")),
    playerNotes: text(col(r, "Player Notes")),

    portraitPath: portrait(col(r, "Picture"), name),

    // DM-only
    hidden: checked(col(r, "Hide")),
    dmNotes: text(col(r, "DM Notes")),
    secret: text(col(r, "Secret")),
  };

  // Drop undefined keys so optional fields stay unset in Convex.
  for (const k of Object.keys(doc)) {
    if (doc[k] === undefined) delete doc[k];
  }
  return doc;
});

writeFileSync(outPath, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");

// A short report, so a silently-empty column is visible before import.
const counted = (pred) => docs.filter(pred).length;
console.error(`${docs.length} NPCs -> ${outPath}`);
console.error(`  hidden (DM-only):   ${counted((d) => d.hidden)}`);
console.error(`  with secret:        ${counted((d) => d.secret)}`);
console.error(`  with dmNotes:       ${counted((d) => d.dmNotes)}`);
console.error(`  with description:   ${counted((d) => d.description)}`);
console.error(`  with portrait:      ${counted((d) => d.portraitPath)}`);
console.error(
  `  distinct species:   ${new Set(docs.map((d) => d.species).filter(Boolean)).size}`
);
console.error(
  `  distinct groups:    ${new Set(docs.flatMap((d) => d.groups)).size}`
);
console.error(
  `  distinct places:    ${new Set(docs.flatMap((d) => d.place)).size}`
);
