/**
 * Which sourcebooks the Lookup table cannot write out.
 *
 * `components/sourceNames.ts` turns "MotM" into "Monsters of the
 * Multiverse". A book that is not in that map keeps its abbreviation,
 * which is deliberate — never worse than what was there before — but it
 * means the map's gaps are invisible until you scroll past one.
 *
 * This reads the Foundry export and reports them: every source string
 * in the library that comes out the other side unchanged, most common
 * first, with a few of the rows carrying it so you can tell a book
 * worth naming from one entry nobody will look at.
 *
 * Two lists, because they need different answers:
 *
 *   ABBREVIATIONS   a code the map could learn. These are the ones to
 *                   send back, and adding them is one line each.
 *   FREE TEXT       whatever somebody typed into dnd5e's `source.custom`
 *                   field. Often already a full title, sometimes a note
 *                   to themselves. Nothing to expand — the map is not
 *                   the place to fix these, the export is.
 *
 *   node scripts/unknown-sources.mjs ~/Downloads/foundry-everything.json
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.error(
    "Which export?\n\n" +
      "  node scripts/unknown-sources.mjs ~/Downloads/foundry-everything.json\n\n" +
      "To find it:  ls -lhS ~/Downloads/*.json | head"
  );
  process.exit(1);
}

/**
 * The books the app can name, read out of the module rather than
 * repeated here.
 *
 * As TEXT, and not by importing it: the module is TypeScript and this
 * is a plain script. Reading it means this cannot report a book as
 * missing that the map actually holds — which is the one way a tool
 * like this wastes somebody's afternoon.
 */
function knownBooks() {
  const src = readFileSync(join(APP_ROOT, "components", "sourceNames.ts"), "utf8");
  const body = src.slice(
    src.indexOf("SOURCE_NAMES: Record<string, string> = {"),
    src.indexOf("\n};", src.indexOf("SOURCE_NAMES"))
  );
  const keys = [...body.matchAll(/^\s*([A-Za-z][\w]*)\s*:\s*"/gm)].map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error(
      "read no book codes out of components/sourceNames.ts — has SOURCE_NAMES " +
        "been renamed or reshaped? Reporting every book as missing would be " +
        "worse than failing here."
    );
  }
  return new Set(keys);
}

/**
 * Every document in the export.
 *
 * The same three shapes import-foundry.mjs sniffs for, kept here rather
 * than imported from it: that script CONVERTS at module scope, so
 * importing it would run the whole import as a side effect of asking a
 * question about it.
 */
function readDocuments(at) {
  if (statSync(at).isDirectory()) {
    return readdirSync(at)
      .filter((f) => [".json", ".db"].includes(extname(f).toLowerCase()))
      .flatMap((f) => readDocuments(join(at, f)));
  }

  const text = readFileSync(at, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [arr];
  }
  try {
    const one = JSON.parse(text);
    if (Array.isArray(one.entries)) return one.entries;
    if (Array.isArray(one.documents)) return one.documents;
    return [one];
  } catch {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((d) => d && !d.$$deleted);
  }
}

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/** What the importer writes into the `source` column. Same three rules. */
function formatSource(source) {
  if (!source || typeof source !== "object") return clean(source);
  return (
    clean(source.custom) ||
    clean(source.book) ||
    (clean(source.rules) ? `SRD ${clean(source.rules)}` : "")
  );
}

/**
 * The book part, with any printing taken off — what the map keys on.
 *
 * PRINTING_RE has to be the same rule expandSource uses, or this
 * reports books as missing that the app writes out perfectly well. It
 * did exactly that within a minute of being written: the app learned to
 * take "5.1" off the end of "SRD 5.1" and this still only knew about
 * years, so it filed the commonest source in the library under "nothing
 * to expand". The integrity guard pins the two together.
 */
const PRINTING_RE = /^(.*\S)\s+(\d+(?:\.\d+)*)$/;

function bookOf(raw) {
  const m = PRINTING_RE.exec(raw);
  // Only when what is left is a book we know. Otherwise "Derek's own
  // notes, session 12" reports itself as "Derek's own notes, session",
  // which is the report inventing a source nobody wrote — and the app
  // does no such thing: a base it cannot find leaves the whole string
  // alone.
  return m && known.has(m[1]) ? m[1] : raw;
}

const known = knownBooks();
const docs = readDocuments(path);

const seen = new Map(); // book -> { count, names[] }
let withSource = 0;

for (const doc of docs) {
  const sys = doc.system ?? doc.data ?? {};
  const raw = formatSource(sys.details?.source ?? sys.source);
  if (!raw) continue;
  withSource++;

  const book = bookOf(raw);
  if (known.has(book)) continue;

  const row = seen.get(book) ?? { count: 0, names: [] };
  row.count++;
  if (row.names.length < 3 && clean(doc.name)) row.names.push(doc.name);
  seen.set(book, row);
}

// A code is something you could put in the map. Anything with a space
// in it is prose somebody typed, and no map will help.
const isCode = (s) => !/\s/.test(s) && s.length <= 12;

const rows = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
const codes = rows.filter(([b]) => isCode(b));
const prose = rows.filter(([b]) => !isCode(b));

const n = (x) => x.toLocaleString();
const unknownRows = rows.reduce((sum, [, r]) => sum + r.count, 0);

console.log(
  `\n${n(docs.length)} documents, ${n(withSource)} carrying a source.\n` +
    `${n(withSource - unknownRows)} rows are written out; ` +
    `${n(unknownRows)} keep their abbreviation.\n`
);

const table = (label, list) => {
  if (list.length === 0) return;
  console.log(`${label} — ${list.length}\n`);
  const wide = Math.max(...list.map(([b]) => b.length));
  for (const [book, r] of list) {
    console.log(
      `  ${book.padEnd(wide)}  ${String(r.count).padStart(5)}   ${r.names.join(", ")}`
    );
  }
  console.log("");
};

table("ABBREVIATIONS the map could learn", codes);
table("FREE TEXT, nothing to expand", prose);

if (rows.length === 0) console.log("Every book in the library has a name.\n");
