#!/usr/bin/env node
/**
 * Foundry VTT export  ->  Game Mastery.
 *
 *   node scripts/import-foundry.mjs <path> <campaignId> [-o out/] [--dry-run]
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

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, extname, basename } from "node:path";
import { parseOrExit } from "./args.mjs";
import { FOUNDRY_MIRROR } from "./mirror.mjs";

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
    if (t === "spell") return "spell";
    if (ITEM_TYPES.has(t)) return "item";
    if (t === "feat") return "feat";
    if (t === "background") return "background";
    // A subclass is filed with its class: nobody looks up "Champion"
    // without meaning the Fighter, and two buckets would be two
    // screens with the answer on whichever one you did not open.
    if (t === "class" || t === "subclass") return "class";
    // "race" is the pre-2024 name and is still what most exports
    // carry; "species" is what the 2024 books call it. Both, because
    // one library can hold documents written under either.
    if (t === "race" || t === "species") return "species";
    if (t === "npc" || t === "character" || t === "vehicle" || t === "group") {
      return "actor";
    }
    // A dnd5e Item also has `system`; actors are the ones with a token.
    if (doc.prototypeToken || doc.token) return "actor";
  }
  return null;
}

/**
 * dnd5e Item types that are things you can hold.
 *
 * feat / class / subclass / background / race are Items too, and are
 * deliberately absent HERE: they now have four tables of their own, and
 * folding them in would still put "Fighter" in the item list.
 */
const ITEM_TYPES = new Set([
  "weapon",
  "equipment",
  "consumable",
  "tool",
  "loot",
  "container",
  "backpack", // the pre-v10 name for a container
]);

// ---------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------

/** dnd5e abbreviates these everywhere; nobody says "int" out loud. */
const ABILITIES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

const SKILLS = {
  acr: "Acrobatics",
  ani: "Animal Handling",
  arc: "Arcana",
  ath: "Athletics",
  dec: "Deception",
  his: "History",
  ins: "Insight",
  inv: "Investigation",
  itm: "Intimidation",
  med: "Medicine",
  nat: "Nature",
  prc: "Perception",
  prf: "Performance",
  per: "Persuasion",
  rel: "Religion",
  slt: "Sleight of Hand",
  ste: "Stealth",
  sur: "Survival",
};

/**
 * `[[/check ability=int skill=inv dc=15]]` reads as a sentence in
 * Foundry and as key=value soup anywhere else.
 *
 * When the DC is a data path rather than a number — `@attributes.spell.dc`,
 * by far the common case — the DC is left OFF entirely rather than
 * rendered. The sentence around it almost always already says "against
 * your spell save DC", so printing it twice is worse than trusting the
 * prose.
 */
function formatCheck(kind, inner) {
  const args = {};
  for (const [, k, v] of inner.matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
    args[k] = v.replace(/^"|"$/g, "");
  }

  const ability = ABILITIES[args.ability] ?? humanize(args.ability);
  const skill = SKILLS[args.skill] ?? humanize(args.skill);
  const dcNumber = Number(args.dc);
  const dc =
    Number.isFinite(dcNumber) && !String(args.dc ?? "").includes("@")
      ? `DC ${dcNumber} `
      : "";

  if (kind === "save") {
    return ability ? `${dc}${ability} saving throw` : `${dc}saving throw`;
  }
  if (!ability) return `${dc}check`;
  return skill
    ? `${dc}${ability} (${skill}) check`
    : `${dc}${ability} check`;
}

/**
 * The formatting verb a data path may carry — `@labels.x capitalize`.
 *
 * Named explicitly rather than matched as "any following word": a path
 * is far more often followed by ordinary prose, and `(\s+\w+)?` eats
 * it. "using @item.level slots" became "using the spell's level".
 */
const VERB = "(?:\\s+(?:capitalize|format|lowercase|uppercase))?";

/** "+4" / "-1" / "+0" — a bonus is already a bonus, never a score. */
function signedNum(n) {
  return `${n < 0 ? "-" : "+"}${Math.abs(n)}`;
}

/** The modifier for one ability, from an actor's `system.abilities`. */
function abilityModOf(abilities, key) {
  const score = Number(abilities?.[String(key).toLowerCase()]?.value);
  return Number.isFinite(score) ? Math.floor((score - 10) / 2) : null;
}

/**
 * Substitute the actor's own numbers into a roll formula.
 *
 * `1d4 + @abilities.dex.mod` is what the file stores; `1d4 + 2` is what
 * it means for THIS monster. Foundry does this against a prepared actor
 * at display time, which is why the file has neither the number nor the
 * total.
 */
function resolveFormula(formula, ctx) {
  return String(formula).replace(
    /@abilities\.(\w+)\.mod/g,
    (whole, ability) => {
      const mod = abilityModOf(ctx?.abilities, ability);
      return mod === null ? whole : String(mod);
    }
  );
}

/**
 * The average of a resolved formula, the way a stat block prints it.
 *
 * NdF averages to N(F+1)/2 and the total is rounded DOWN — 1d4 + 2 is
 * 4.5, printed as 4, which is what the books and D&D Beyond both show.
 * Returns null for anything not purely dice and numbers, so an
 * unevaluable formula prints without an average rather than with a
 * wrong one.
 */
function averageOf(resolved) {
  const terms = String(resolved).replace(/\s+/g, "").match(/[+-]?[^+-]+/g);
  if (!terms) return null;

  let total = 0;
  for (const term of terms) {
    const sign = term.startsWith("-") ? -1 : 1;
    const body = term.replace(/^[+-]/, "");

    const dice = body.match(/^(\d*)d(\d+)$/i);
    if (dice) {
      const count = Number(dice[1] || 1);
      const faces = Number(dice[2]);
      if (!Number.isFinite(count) || !Number.isFinite(faces)) return null;
      total += (sign * count * (faces + 1)) / 2;
      continue;
    }
    if (/^\d+$/.test(body)) {
      total += sign * Number(body);
      continue;
    }
    return null;
  }
  return Math.floor(total);
}

/**
 * `[[/damage 1d4 + @abilities.dex.mod type=slashing average=true]]`
 * -> `4 (1d4 + 2) Slashing`
 *
 * The trailing word "damage" is already in the prose around it, which is
 * why it is not added here.
 */
function damageText(inner, ctx) {
  const switches = {};
  const formula = String(inner)
    .replace(/\s*(\w+)=("[^"]*"|\S+)/g, (_, key, value) => {
      switches[key] = value.replace(/^"|"$/g, "");
      return "";
    })
    .trim();

  const resolved = resolveFormula(formula, ctx).replace(/\s+/g, " ").trim();
  const type = switches.type ? humanize(switches.type) : "";
  const wantsAverage = switches.average !== "false";
  const average = wantsAverage ? averageOf(resolved) : null;

  const dice = average === null ? resolved : `${average} (${resolved})`;
  return [dice, type].filter(Boolean).join(" ");
}

/**
 * `[[/attack extended]]` -> `Melee Attack Roll: +4, reach 5 ft.`
 *
 * None of that is in the file. Foundry composes it from the activity's
 * attack config and the actor: ability modifier plus proficiency, and a
 * melee attack's reach defaults to 5 feet. Without this the enricher
 * strips down to the bare switch word — which is how "Talons. extended."
 * reached the screen.
 */
function attackLine(ctx) {
  const activity = Object.values(ctx?.activities ?? {}).find(
    (a) => clean(a?.type).toLowerCase() === "attack"
  );
  if (!activity) return null;

  const atk = activity.attack ?? {};
  const ranged = clean(atk.type?.value).toLowerCase() === "ranged";
  const extra = Number(atk.bonus);

  let bonus;
  if (atk.flat === true) {
    if (!Number.isFinite(extra)) return null;
    bonus = extra;
  } else {
    const mod = abilityModOf(ctx?.abilities, atk.ability);
    if (mod === null) return null;
    bonus =
      mod +
      (Number.isFinite(ctx?.proficiencyBonus) ? ctx.proficiencyBonus : 0) +
      (Number.isFinite(extra) ? extra : 0);
  }

  const range = activity.range ?? {};
  const reach = Number(range.reach);
  const near = Number(range.value);
  const far = Number(range.long);

  const reaches = [];
  if (!ranged) {
    reaches.push(`reach ${Number.isFinite(reach) && reach > 0 ? reach : 5} ft.`);
  }
  if (Number.isFinite(near) && near > 0) {
    reaches.push(
      `range ${near}${Number.isFinite(far) && far > 0 ? `/${far}` : ""} ft.`
    );
  }

  // A melee attack that also has a range is a thrown weapon, and the
  // book writes both halves into one line.
  const label = ranged
    ? "Ranged Attack Roll"
    : reaches.length > 1
      ? "Melee or Ranged Attack Roll"
      : "Melee Attack Roll";

  return `${label}: ${signedNum(bonus)}${
    reaches.length ? `, ${reaches.join(" or ")}` : ""
  }`;
}

/**
 * Foundry biographies are HTML. The NPC table's fields are plain text.
 *
 * `ctx` carries the actor a monster's feature belongs to — its ability
 * scores, its proficiency bonus, and that feature's activities. With it,
 * the attack and damage enrichers become the numbers a stat block
 * prints; without it they are stripped to their contents, which is right
 * for a spell or an item, where there is no actor to compute against.
 */
function stripHtml(html, ctx) {
  if (typeof html !== "string" || !html) return undefined;

  const text = html
    // Structural tags become whitespace before the rest are dropped, or
    // paragraphs run together into one block.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")

    // Entities BEFORE enrichers, and that order is the whole point.
    // Foundry writes `&Reference[Grappled]` into HTML, where the
    // ampersand is escaped — so it arrives as `&amp;Reference[...]`,
    // and an enricher pass run first sees `&amp` followed by a
    // semicolon, matches nothing, and leaves 122 of them intact in
    // Derek's export. Decode, then strip.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

    // Foundry ENRICHERS. Real descriptions are full of them:
    //   @UUID[Compendium.dnd5e...]{Gameplay Toolbox}  ->  Gameplay Toolbox
    //   &Reference[Grappled]                          ->  Grappled
    //   [[/r 1d6]]                                    ->  1d6
    // Left alone they read as a wall of compendium ids. The labelled
    // form has to be handled first, or the label is thrown away along
    // with the brackets.
    .replace(/[@&]\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")
    // An unlabelled @UUID is a document ID, not words, and @Embed pulls
    // in another document's whole body. Outside Foundry there is nothing
    // to resolve or embed, and keeping the inner text leaves
    // "Compendium.dnd5e.spells24.Item.phbsplGoodberry0" sitting in the
    // description as if it were prose. Both are dropped.
    .replace(/@(?:UUID|Embed)\[[^\]]*\]/g, "")
    // Every other unlabelled form keeps its content, minus the
    // switches: `&Reference[Charmed apply=false]` is the word
    // "Charmed", and `apply=false` is an instruction to Foundry rather
    // than part of the rule.
    .replace(/[@&]\w+\[([^\]]*)\]/g, (_, inner) =>
      inner.replace(/\s*\w+=("[^"]*"|\S+)/g, "").trim()
    )
    .replace(/\[\[\/(check|save|conc)\s+([^\]]*)\]\]/g, (_, kind, inner) =>
      formatCheck(kind === "save" || kind === "conc" ? "save" : "check", inner)
    )
    // The two that are COMPUTED rather than written. Both must run
    // before the generic bracket fallback below, which would otherwise
    // reduce them to their switch words.
    // An attack line is meaningless without someone making the attack —
    // a longsword's bonus depends on who is holding it — so with no
    // actor it is dropped rather than reduced to its switch word.
    .replace(/\[\[\/attack\b[^\]]*\]\]/g, () => attackLine(ctx) ?? "")
    .replace(/\[\[\/damage\s+([^\]]*)\]\]/g, (_, inner) =>
      damageText(inner, ctx)
    )
    // Anything else inline — `[[/r 1d6]]`, `[[/damage 8d6 fire average=false]]`
    // — keeps its content with the key=value switches dropped.
    .replace(/\[\[\/?[a-z]*\s*([^\]]*)\]\]/g, (_, inner) =>
      inner.replace(/\s*\w+=("[^"]*"|\S+)/g, "").trim()
    )

    // Foundry DATA PATHS — `@attributes.spell.dc`, `@item.level`. These
    // are interpolated against the caster at render time, and outside
    // Foundry there is nothing to interpolate against. The three common
    // ones say something exact in English, so they are translated rather
    // than dropped; a data path IS its English reading, so this is not
    // inventing rules text. Anything else dotted goes, along with a
    // trailing formatting verb ("capitalize").
    // An ability modifier in loose prose, with an actor to read it off.
    .replace(/@abilities\.(\w+)\.mod/g, (whole, ability) => {
      const mod = abilityModOf(ctx?.abilities, ability);
      return mod === null ? whole : signedNum(mod);
    })
    .replace(new RegExp(`@attributes\\.spell\\.dc${VERB}`, "g"), "your spell save DC")
    .replace(new RegExp(`@item\\.level${VERB}`, "g"), "the spell's level")
    .replace(new RegExp(`@details\\.level${VERB}`, "g"), "your level")
    .replace(
      /@[A-Za-z][\w.]*(\s+(?:capitalize|format|lowercase|uppercase))?/g,
      ""
    )

    // Tidy what removal and reconstruction left behind. The doubling is
    // real: the prose around `[[/check ...]]` often already ends in the
    // word "check", which the enricher supplies too.
    .replace(/\b(check|saving throw|save)\s+\1\b/gi, "$1")
    // A computed line ends in "ft." and the prose after the enricher
    // starts with its own full stop. Exactly two, never three: an
    // ellipsis is punctuation, not a mistake.
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    // A dropped enricher can leave the sentence starting on its own
    // punctuation.
    .replace(/(^|\n)[ \t]*[.,;:]\s*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.length > 0 ? text : undefined;
}

/**
 * A description as ORDERED BLOCKS rather than one flattened string.
 *
 * Foundry writes real tables and lists into descriptions — 111 tables
 * and 66 lists in Derek's export — and flattening them runs a d100
 * table's cells together into an unreadable sentence. Splitting keeps
 * each one a table, in its place in the prose, and keeps the app free
 * of raw HTML: nothing here is ever rendered as markup, only as data.
 *
 * Cell and item text goes through exactly the same pipeline as the
 * prose around it, so an enricher inside a table cell is handled the
 * same way as one in a paragraph.
 */
function toBlocks(html, ctx) {
  if (typeof html !== "string" || !html) return undefined;

  const blocks = [];
  // Split on tables and lists, KEEPING them: a captured group in the
  // separator is what puts the delimiters back into the result, which
  // is how the ordering survives.
  const parts = html.split(
    /(<table[\s\S]*?<\/table>|<[uo]l[\s\S]*?<\/[uo]l>)/i
  );

  for (const part of parts) {
    if (!part) continue;

    if (/^<table/i.test(part)) {
      const table = parseTable(part, ctx);
      if (table) blocks.push(table);
      continue;
    }
    if (/^<[uo]l/i.test(part)) {
      const list = parseList(part, ctx);
      if (list) blocks.push(list);
      continue;
    }

    const text = stripHtml(part, ctx);
    if (text) blocks.push({ type: "text", text });
  }

  return blocks.length > 0 ? blocks : undefined;
}

function parseTable(html, ctx) {
  const rowsOf = (chunk) =>
    [...chunk.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
        (c) => stripHtml(c[1], ctx) ?? ""
      )
    );

  // A <thead> names the header explicitly. Without one, the first row
  // is NOT promoted: a headerless table is a real thing, and guessing
  // would silently eat its first row of data.
  const head = html.match(/<thead[\s\S]*?<\/thead>/i);
  const body = html.replace(/<thead[\s\S]*?<\/thead>/i, "");
  const headers = head ? (rowsOf(head[0])[0] ?? []) : [];
  const rows = rowsOf(body).filter((r) => r.length > 0);

  if (headers.length === 0 && rows.length === 0) return null;
  return { type: "table", headers, rows };
}

function parseList(html, ctx) {
  const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => stripHtml(m[1], ctx) ?? "")
    .filter(Boolean);
  if (items.length === 0) return null;
  return { type: "list", ordered: /^<ol/i.test(html), items };
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
  if (isPlaceholderImage(img)) return undefined;
  // `icons/` and `systems/` were dropped here too, which was right for
  // an NPC portrait and wrong for everything else: for a spell or an
  // item those paths ARE the artwork, and dropping them is why nothing
  // had a picture.
  //
  // The mirror prefix is what makes the path REACHABLE. Foundry's own
  // paths start at roots the map server does not route; see mirror.mjs.
  return `${FOUNDRY_MIRROR}/${img}`;
}

/**
 * Foundry's generic silhouettes.
 *
 * `icons/svg/mystery-man.svg` is what every un-illustrated actor has,
 * so writing it would give hundreds of NPCs the same portrait. The rest
 * of `icons/svg/` is the same kind of thing — item-bag, aura, direction
 * — placeholders rather than art.
 */
function isPlaceholderImage(img) {
  return img.startsWith("icons/svg/");
}

/**
 * The library's artwork, kept as the Foundry-relative path.
 *
 * Same convention as map-server portraits: the path is stored and the
 * file is served from NEXT_PUBLIC_MAP_SERVER. scripts/fetch-foundry-images.mjs
 * pulls the files out of a running Foundry so they can be put there.
 */
function libraryImage(doc) {
  return relativeImage(doc.img);
}

// ---------------------------------------------------------------------
// Item -> an items row  (the Lookup library)
// ---------------------------------------------------------------------

/**
 * Foundry's item vocabulary is two fields: the document `type`
 * ("equipment") and a subtype ("wondrous", "shield"). Neither alone is
 * what a player would call the thing — "equipment" covers both plate
 * armour and a ring of invisibility — so they are folded into one small
 * bucket that is actually worth filtering by.
 */
/** dnd5e's property slugs, spelled out. */
const ITEM_PROPERTIES = {
  mgc: "Magical",
  ada: "Adamantine",
  foc: "Focus",
  stealthDisadvantage: "Stealth Disadvantage",
  amm: "Ammunition",
  fin: "Finesse",
  hvy: "Heavy",
  lgt: "Light",
  lod: "Loading",
  rch: "Reach",
  rel: "Reload",
  ret: "Returning",
  spc: "Special",
  thr: "Thrown",
  two: "Two-Handed",
  ver: "Versatile",
  sil: "Silvered",
  ver2: "Versatile",
};

const EQUIPMENT_KINDS = {
  light: "armor",
  medium: "armor",
  heavy: "armor",
  shield: "armor",
  wondrous: "wondrous",
  ring: "ring",
  wand: "wand",
  rod: "rod",
};

function itemKind(doc) {
  const t = (doc.type ?? "").toLowerCase();
  const sub = clean(sys(doc).type?.value).toLowerCase();

  if (t === "equipment") return EQUIPMENT_KINDS[sub] ?? "gear";
  if (t === "loot") return "gear";
  if (t === "backpack") return "container";
  if (["weapon", "consumable", "tool", "container"].includes(t)) return t;
  return "other";
}

/** "veryRare" -> "Very Rare". The dnd5e values are camelCase keys. */
function humanize(s) {
  const t = clean(s);
  if (!t) return undefined;
  return t
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** `{ value: 5, denomination: "sp" }` -> "5 sp". */
function formatPrice(price) {
  if (!price || typeof price !== "object") return undefined;
  const value = Number(price.value);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const denom = clean(price.denomination) || "gp";
  return `${value} ${denom}`;
}

/**
 * Where a row came from, so a re-import can be told from what was
 * already there. dnd5e stores this as an object, not a string.
 */
function formatSource(source) {
  if (!source || typeof source !== "object") return clean(source) || undefined;
  const custom = clean(source.custom);
  if (custom) return custom;
  const book = clean(source.book);
  if (book) return book;
  const rules = clean(source.rules);
  return rules ? `SRD ${rules}` : undefined;
}

function itemToRow(doc) {
  const s = sys(doc);
  // A weight of 0 means "nobody filled this in" far more often than it
  // means weightless — the Berserker Axe in Derek's export is 0 lb.
  const weight = Number(s.weight?.value ?? s.weight);

  const row = {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    kind: itemKind(doc),
    rarity: humanize(s.rarity),
    price: formatPrice(s.price),
    weight: Number.isFinite(weight) && weight > 0 ? weight : undefined,
    // `attunement` is "" / "required" / "optional"; `attuned` is a
    // different field meaning "is it attuned right now", which is a
    // property of one character's copy, not of the item.
    attunement: clean(s.attunement).toLowerCase() === "required",
    // The Details tab's own facts. `type.value` is the real subtype
    // ("trinket", "wondrous"), which the kind bucket flattens away, and
    // `properties` is where Magical / Adamantine / Focus live.
    subtype: humanize(s.type?.value),
    properties: (() => {
      const list = (s.properties ?? [])
        .map((p) => ITEM_PROPERTIES[p] ?? humanize(p))
        .filter(Boolean);
      return list.length > 0 ? list.join(", ") : undefined;
    })(),
    blocks: toBlocks(s.description?.value),
    source: formatSource(s.source),
  };
  return row;
}

// ---------------------------------------------------------------------
// Feats, backgrounds, classes, species -> the build tables
// ---------------------------------------------------------------------
//
// These four read the same export at four different levels of
// certainty, so they are written to the same rule: TRY the places the
// value has lived across dnd5e versions, and leave the field OFF when
// none of them has it. Never write "" or 0 as a stand-in.
//
// That matters more here than it did for spells and items. Those two
// have had stable shapes for years; a class's spellcasting progression
// has moved twice, backgrounds were rebuilt wholesale for 2024, and
// "race" became "species". A converter that guessed and wrote a
// placeholder would fill a column with plausible wrong answers, which
// is the one outcome worse than an empty one — the report at the end
// counts how many rows got each field precisely so a field that is
// quietly never being found is visible before the import runs.

/**
 * Every advancement of a given type on a build item.
 *
 * dnd5e hangs a class's hit die, a background's skills and a species'
 * size off `system.advancement`, a heterogeneous list where the `type`
 * discriminates. Absent on older documents, so this always returns an
 * array.
 */
function advancementsOf(s, type) {
  const list = Array.isArray(s.advancement) ? s.advancement : [];
  return list.filter(
    (a) => a && String(a.type ?? "").toLowerCase() === type.toLowerCase()
  );
}

/** "Str", "Dex" — how a class entry abbreviates an ability. */
function abilityAbbrev(key) {
  const k = clean(key).toLowerCase().slice(0, 3);
  return ABILITIES[k] ? ABILITIES[k].slice(0, 3) : undefined;
}

/** A list of ability keys as "Str, Dex", or undefined if there are none. */
function abilityList(raw) {
  const keys = Array.isArray(raw)
    ? raw
    : raw instanceof Set
      ? [...raw]
      : typeof raw === "string" && raw
        ? raw.split(/[,\s]+/)
        : [];
  const out = keys.map(abilityAbbrev).filter(Boolean);
  return out.length > 0 ? [...new Set(out)].join(", ") : undefined;
}

/**
 * Proficiency grants, spelled out.
 *
 * dnd5e writes them as compound slugs — "skills:ath", "tool:thief",
 * "saves:dex" — in a Trait advancement's `configuration.grants`, which
 * may be an array or a Set depending on how the document was loaded.
 * `wanted` is the prefix to keep, so skills and tools come out of the
 * same list as two different fields.
 */
function traitGrants(s, wanted) {
  const out = [];
  for (const adv of advancementsOf(s, "Trait")) {
    const grants = adv.configuration?.grants ?? adv.configuration?.choices ?? [];
    const list = Array.isArray(grants)
      ? grants
      : grants && typeof grants === "object"
        ? Object.values(grants).flatMap((c) =>
            Array.isArray(c?.pool) ? c.pool : []
          )
        : [];
    for (const raw of list) {
      const slug = clean(raw);
      if (!slug.startsWith(`${wanted}:`)) continue;
      const key = slug.slice(wanted.length + 1);
      // Skills have a name; tools are an identifier we can only tidy.
      const label = SKILLS[key] ?? ABILITIES[key] ?? humanize(key);
      if (label) out.push(label);
    }
  }
  return out.length > 0 ? [...new Set(out)].join(", ") : undefined;
}

/**
 * A feat's grouping.
 *
 * 2024 puts it in `system.type.subtype` as a camelCase slug; 2014 feats
 * have no grouping at all, and get none rather than being called
 * "General" — which is a 2024 word for a 2024 idea.
 */
function featCategory(s) {
  const subtype = clean(s.type?.subtype ?? s.type?.value);
  if (!subtype || subtype.toLowerCase() === "feat") return undefined;
  return humanize(subtype);
}

/**
 * A feat's prerequisite, as a sentence.
 *
 * 2024 stores it structurally (`system.prerequisites.level`), older
 * documents put it in prose only. The structural half is used when it
 * is there and nothing is invented when it is not — a feat that
 * genuinely has no prerequisite and one whose export forgot to say are
 * both better left blank than guessed at.
 */
function featPrerequisite(s) {
  const parts = [];
  const level = Number(s.prerequisites?.level);
  if (Number.isFinite(level) && level > 1) parts.push(`Level ${level}`);

  const repeat = clean(s.prerequisites?.repeat);
  if (repeat) parts.push(repeat);

  return parts.length > 0 ? parts.join(", ") : undefined;
}

function featToRow(doc) {
  const s = sys(doc);
  return {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    category: featCategory(s),
    prerequisite: featPrerequisite(s),
    // `properties` is a list in 2024 and absent before it.
    repeatable: Array.isArray(s.properties)
      ? s.properties.includes("repeatable")
      : undefined,
    blocks: toBlocks(s.description?.value),
    source: formatSource(s.source),
  };
}

function backgroundToRow(doc) {
  const s = sys(doc);

  // The three abilities a 2024 background raises. They live in an
  // AbilityScoreImprovement advancement rather than a field.
  const asi = advancementsOf(s, "AbilityScoreImprovement")[0];
  const abilities = abilityList(
    asi?.configuration?.locked ?? asi?.configuration?.choices ?? []
  );

  // The origin feat, as an ItemGrant advancement pointing at a feat.
  // The UUID's last segment is the feat's id, not its name, so the
  // name is only usable when the export carried a label alongside it.
  const grant = advancementsOf(s, "ItemGrant")[0];
  const featLabel =
    clean(grant?.title) ||
    clean(grant?.configuration?.label) ||
    undefined;

  return {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    abilities,
    feat: featLabel,
    skills: traitGrants(s, "skills"),
    tools: traitGrants(s, "tool"),
    equipment: startingEquipment(s),
    blocks: toBlocks(s.description?.value),
    source: formatSource(s.source),
  };
}

/**
 * Starting equipment, as a short phrase.
 *
 * `system.startingEquipment` is a tree of grouped choices with UUID
 * references in it; reconstructing "a scholar's pack, a bottle of ink"
 * from that reliably is not something this can promise. What it CAN
 * report honestly is how many entries there are, and the entry's own
 * prose already lists them — so this reads the labels when they exist
 * and gives up cleanly when they do not.
 */
function startingEquipment(s) {
  const list = Array.isArray(s.startingEquipment) ? s.startingEquipment : [];
  const labels = list
    .map((e) => clean(e?.label) || clean(e?.name))
    .filter(Boolean);
  return labels.length > 0 ? labels.join(", ") : undefined;
}

/** "full" -> "Full". The four progressions dnd5e knows. */
const CASTER_PROGRESSION = {
  full: "Full",
  half: "Half",
  third: "Third",
  pact: "Pact",
};

function classToRow(doc) {
  const s = sys(doc);
  const isSubclass = clean(doc.type).toLowerCase() === "subclass";

  // The hit die moved: `system.hitDice` was "d10", then it became
  // `system.hd.denomination`. Both, oldest last.
  const die =
    clean(s.hd?.denomination) || clean(s.hitDice) || clean(s.hitDie);

  const progression = clean(s.spellcasting?.progression).toLowerCase();

  // A class's identifier is what a subclass points at, so a subclass's
  // parent is its `classIdentifier`. Humanised, because the identifier
  // is a slug ("fighter") and the column shows a name.
  const parent = isSubclass
    ? humanize(clean(s.classIdentifier) || clean(s.class))
    : undefined;

  return {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    isSubclass,
    parentClass: parent,
    // `d10` and `10` are both in the wild; the column says "Hit Die",
    // so it is written the way it is spoken.
    hitDie: die ? (die.startsWith("d") ? die : `d${die}`) : undefined,
    primaryAbility: abilityList(
      s.primaryAbility?.value ?? s.primaryAbility ?? []
    ),
    saves: abilityList(s.saves ?? []),
    spellcasting:
      progression && progression !== "none"
        ? (CASTER_PROGRESSION[progression] ?? humanize(progression))
        : undefined,
    blocks: toBlocks(s.description?.value),
    source: formatSource(s.source),
  };
}

function speciesToRow(doc) {
  const s = sys(doc);

  // Size is a Size advancement's list of allowed sizes — "Small or
  // Medium" is a real answer, not a data error, so both are kept.
  const sizeAdv = advancementsOf(s, "Size")[0];
  const rawSizes = sizeAdv?.configuration?.sizes ?? s.size ?? [];
  const sizes = (
    Array.isArray(rawSizes)
      ? rawSizes
      : rawSizes instanceof Set
        ? [...rawSizes]
        : [rawSizes]
  )
    .map((x) => SIZES[clean(x).toLowerCase()] ?? humanize(x))
    .filter(Boolean);

  const walk = Number(s.movement?.walk);
  const dark = Number(s.senses?.darkvision);

  return {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    size: sizes.length > 0 ? [...new Set(sizes)].join(" or ") : undefined,
    speed: Number.isFinite(walk) && walk > 0 ? `${walk} ft` : undefined,
    creatureType:
      humanize(clean(s.type?.value)) || humanize(clean(s.creatureType)),
    darkvision: Number.isFinite(dark) && dark > 0 ? dark : undefined,
    blocks: toBlocks(s.description?.value),
    source: formatSource(s.source),
  };
}

// ---------------------------------------------------------------------
// Spell -> a spells row
// ---------------------------------------------------------------------

const SCHOOLS = {
  abj: "Abjuration",
  con: "Conjuration",
  div: "Divination",
  enc: "Enchantment",
  evo: "Evocation",
  ill: "Illusion",
  nec: "Necromancy",
  trs: "Transmutation",
};

/**
 * dnd5e moved ritual/concentration/V-S-M out of a `components` object
 * and into a flat `properties` array. Both shapes are read, because an
 * export can contain documents written by either.
 */
function spellProps(s) {
  const list = Array.isArray(s.properties) ? s.properties : [];
  const legacy = s.components ?? {};
  const has = (key) => list.includes(key) || legacy[key] === true;

  return {
    ritual: has("ritual"),
    concentration: has("concentration"),
    vocal: has("vocal"),
    somatic: has("somatic"),
    material: has("material"),
  };
}

/**
 * dnd5e's unit slugs, spelled the way a spell entry reads.
 *
 * "inst" is the one that matters: it is the most common duration in the
 * game, and "Inst" is not a word.
 */
const UNITS = {
  inst: "Instantaneous",
  perm: "Permanent",
  spec: "Special",
  disp: "Until dispelled",
  dstr: "Until dispelled or triggered",
  touch: "Touch",
  self: "Self",
  any: "Any",
  turn: "turn",
  round: "round",
  minute: "minute",
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
  year: "year",
  ft: "ft",
  mi: "mile",
};

/** Time words take an s; "ft" does not. */
const PLURALISES = new Set([
  "mi",
  "turn",
  "round",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

/**
 * `{ value: 10, units: "minute" }` -> "10 minutes";
 * `{ units: "inst" }`              -> "Instantaneous".
 */
function unitised(obj, fallbackUnits) {
  if (!obj || typeof obj !== "object") return undefined;
  const rawUnits = clean(obj.units ?? fallbackUnits);
  const units = UNITS[rawUnits] ?? humanize(rawUnits);
  const value = obj.value;

  if (value === null || value === undefined || value === "") {
    // No number: the units ARE the answer ("Touch", "Instantaneous").
    return units || undefined;
  }

  // A level-scaling duration is a Foundry roll formula — "@item.level *
  // 48 - 72" hours. There is no caster here to evaluate it against, and
  // printing the formula is worse than saying it varies.
  if (typeof value === "string" && value.includes("@")) {
    const word = PLURALISES.has(rawUnits) ? `${units}s` : units;
    return word ? `Varies (${word})` : "Varies";
  }

  if (!units) return String(value);

  const n = Number(value);
  const plural =
    PLURALISES.has(rawUnits) && Number.isFinite(n) && n !== 1 ? "s" : "";
  return `${value} ${units}${plural}`;
}

/**
 * What it costs to cast, in the game's own words.
 *
 * A null `value` is the common case and means "one of these" — the 2024
 * rules write that as "Action" and "Bonus Action", not "1 action".
 */
const ACTIVATIONS = {
  action: "Action",
  bonus: "Bonus Action",
  reaction: "Reaction",
  legendary: "Legendary Action",
  lair: "Lair Action",
  special: "Special",
};

function formatActivation(activation) {
  if (!activation || typeof activation !== "object") return undefined;
  const type = clean(activation.type);
  if (!type) return undefined;

  const n = Number(activation.value);
  // `value: 1` and `value: null` mean the same thing for an Action, and
  // an export contains both — so "1 Action" and "Action" would sit next
  // to each other in the same list.
  if (!Number.isFinite(n) || n <= 0 || (n === 1 && ACTIVATIONS[type])) {
    return ACTIVATIONS[type] ?? humanize(type);
  }
  const word = UNITS[type] ?? humanize(type);
  const plural = PLURALISES.has(type) && n !== 1 ? "s" : "";
  return `${n} ${word}${plural}`;
}

/**
 * The two 2024-rules labels a spell description interpolates: who it
 * affects, and the shape it fills. Both are already in `system.target`,
 * so they are rebuilt rather than deleted — Fireball's description is
 * "@labels.description.affects capitalize in a @labels.description.template
 * centered on that point", and removing them leaves "in a centered on
 * that point".
 */
function targetLabels(target) {
  const affects = target?.affects ?? {};
  const template = target?.template ?? {};

  const who = clean(affects.type);
  const count = Number(affects.count);
  const affectsText = who
    ? Number.isFinite(count) && count > 1
      ? `${count} ${who}s`
      : `each ${who}`
    : "";

  const shape = clean(template.type);
  const size = clean(template.size);
  const units = clean(template.units) === "ft" ? "foot" : clean(template.units);
  const templateText = shape
    ? size
      ? `${size}-${units} ${humanize(shape)}`
      : humanize(shape)
    : "";

  return { affectsText, templateText };
}

const ABBREV = {
  str: "STR",
  dex: "DEX",
  con: "CON",
  int: "INT",
  wis: "WIS",
  cha: "CHA",
};

/**
 * The two cells a spell entry has that are not plain fields: what you
 * roll against it, and what it does.
 *
 * Both live in `system.activities`, which is a keyed object rather than
 * an array — dnd5e v4 moved them out of the spell's own fields, so a
 * spell's save ability is two levels deeper than it looks.
 */
function spellActivity(s) {
  const activities = Object.values(s.activities ?? {});
  if (activities.length === 0) return {};

  // The first activity is the spell's main effect; later ones are
  // riders (a summon's extra attack, a scaling variant).
  const a = activities[0];
  const type = clean(a.type);

  let attackSave;
  if (type === "save") {
    const abilities = (a.save?.ability ?? [])
      .map((k) => ABBREV[k] ?? humanize(k))
      .filter(Boolean);
    attackSave = abilities.length ? `${abilities.join("/")} Save` : "Save";
  } else if (type === "attack") {
    const melee = clean(a.attack?.type?.value) === "melee";
    attackSave = melee ? "Melee" : "Ranged";
  }

  const damageTypes = new Set();
  for (const part of a.damage?.parts ?? []) {
    for (const t of part.types ?? []) damageTypes.add(humanize(t));
  }
  if (type === "heal" && a.healing) damageTypes.add("Healing");

  const damageEffect =
    damageTypes.size > 0
      ? [...damageTypes].join(", ")
      : type && type !== "save" && type !== "attack"
        ? humanize(type)
        : undefined;

  return { attackSave, damageEffect };
}

/** "150 ft." plus the shape it fills, when it fills one. */
function spellArea(s) {
  const t = s.target?.template ?? {};
  const shape = clean(t.type);
  const size = clean(t.size);
  if (!shape || !size) return undefined;
  const units = clean(t.units) || "ft";
  // Level-scaling areas are roll formulas, same as level-scaling
  // durations — there is no caster here to evaluate them against.
  if (size.includes("@")) return `Varies (${humanize(shape)})`;
  return `${size} ${units} ${humanize(shape)}`;
}

function spellToRow(doc) {
  const s = sys(doc);
  const p = spellProps(s);
  const labels = targetLabels(s.target);

  // Substituted BEFORE the HTML pass, so the reconstructed words go
  // through the same tidying as the rest of the prose.
  const rawDescription = (s.description?.value ?? "")
    .replace(/@labels\.description\.affects(\s+capitalize)?/g, (_, cap) =>
      cap
        ? labels.affectsText.replace(/^./, (c) => c.toUpperCase())
        : labels.affectsText
    )
    .replace(/@labels\.description\.template/g, labels.templateText);

  const components = [p.vocal && "V", p.somatic && "S", p.material && "M"]
    .filter(Boolean)
    .join(", ");

  const row = {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    level: Number.isFinite(Number(s.level)) ? Number(s.level) : 0,
    school: SCHOOLS[clean(s.school)] ?? humanize(s.school),
    castingTime: formatActivation(s.activation),
    range: unitised(s.range),
    components: components || undefined,
    materials: clean(s.materials?.value) || undefined,
    duration: unitised(s.duration),
    area: spellArea(s),
    attackSave: spellActivity(s).attackSave,
    damageEffect: spellActivity(s).damageEffect,
    ritual: p.ritual,
    concentration: p.concentration,
    blocks: toBlocks(rawDescription),
    source: formatSource(s.source),
  };
  return row;
}

// ---------------------------------------------------------------------
// Actor -> a monsters row  (the same actor also yields an npcs row)
// ---------------------------------------------------------------------

function formatSpeed(movement) {
  if (!movement || typeof movement !== "object") return undefined;
  const units = clean(movement.units) || "ft";
  const parts = ["walk", "fly", "swim", "climb", "burrow"]
    .map((mode) => {
      const n = Number(movement[mode]);
      if (!Number.isFinite(n) || n <= 0) return null;
      return mode === "walk" ? `${n} ${units}` : `${mode} ${n} ${units}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function abilityScores(abilities) {
  if (!abilities || typeof abilities !== "object") return undefined;
  const out = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
    const n = Number(abilities[key]?.value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A monster's traits and actions are EMBEDDED ITEMS on the actor, not
 * fields — Foundry models "Fire Breath" as a feature the ettin owns.
 *
 * The split between the two is whether it has an activation: a trait is
 * always true ("Two Heads"), an action is something taken on a turn
 * ("Multiattack"). Legendary actions declare themselves.
 */
function monsterFeatures(doc, actor) {
  const traits = [];
  const actions = [];
  const legendary = [];

  for (const item of doc.items ?? []) {
    const type = (item.type ?? "").toLowerCase();
    // A stat block's Traits and Actions come from FEATURES and the
    // weapons they attack with. The rest of an actor's items are
    // inventory: a bugbear's chain shirt is why its AC is 15, not a
    // trait called "Chain Shirt".
    if (type !== "feat" && type !== "weapon") continue;

    const is = sys(item);
    const name = clean(item.name);
    if (!name) continue;

    // The actor's own numbers, plus THIS feature's activities. Both are
    // needed to turn `[[/attack extended]]` and `[[/damage 1d4 +
    // @abilities.dex.mod ...]]` into the line a stat block prints.
    const entry = {
      name,
      blocks:
        toBlocks(is.description?.value, {
          ...actor,
          activities: is.activities,
        }) ?? [],
    };

    // Legendary actions declare themselves through their ACTIVATION
    // cost rather than a subtype — Derek's export has no "legendary"
    // feat subtype at all, and 82 features with a legendary activation.
    const activations = [
      clean(is.activation?.type),
      ...Object.values(is.activities ?? {}).map((a) =>
        clean(a.activation?.type)
      ),
    ];
    const kind = clean(is.type?.value).toLowerCase();
    if (
      kind === "legendary" ||
      kind === "lair" ||
      activations.some((t) => t === "legendary" || t === "lair")
    ) {
      legendary.push(entry);
      continue;
    }
    // A weapon is always an attack; a feat is an action only if it has
    // an activation cost.
    const activated =
      (item.type ?? "").toLowerCase() === "weapon" ||
      activations.some(Boolean);

    (activated ? actions : traits).push(entry);
  }

  return { traits, actions, legendary };
}

/** dnd5e stores skill ranks per skill; only the trained ones read out. */
function monsterSkills(skills) {
  if (!skills || typeof skills !== "object") return undefined;
  const parts = [];
  for (const [key, val] of Object.entries(skills)) {
    const rank = Number(val?.value);
    if (!Number.isFinite(rank) || rank <= 0) continue;
    parts.push(SKILLS[key] ?? humanize(key));
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function monsterSenses(senses) {
  if (!senses || typeof senses !== "object") return undefined;
  // dnd5e nests the distances under `.ranges`; reading them off the
  // senses object directly finds nothing, which is how 393 monsters
  // arrived with no senses at all.
  const ranges = senses.ranges ?? senses;
  const units = clean(senses.units) || "ft";
  const parts = ["darkvision", "blindsight", "tremorsense", "truesight"]
    .map((k) => {
      const n = Number(ranges[k]);
      return Number.isFinite(n) && n > 0 ? `${humanize(k)} ${n} ${units}` : null;
    })
    .filter(Boolean);
  const special = clean(senses.special);
  if (special) parts.push(special);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Proficiency bonus and XP are DERIVED from CR, not stored.
 *
 * Foundry computes both when it prepares an actor, so `toObject()` —
 * which is source data — has neither. The 5e tables are fixed, so they
 * are computed here rather than left blank.
 */
function proficiencyFor(cr) {
  if (!Number.isFinite(cr)) return undefined;
  if (cr < 1) return 2;
  return Math.max(2, Math.ceil(cr / 4) + 1);
}

/** The XP-by-CR table, verbatim. */
const XP_BY_CR = {
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100,
  1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900,
  9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000,
  16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000,
  22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000,
  28: 120000, 29: 135000, 30: 155000,
};

function xpFor(cr) {
  return Number.isFinite(cr) ? XP_BY_CR[cr] : undefined;
}

/** "Forest, Grassland" — a D&D Beyond column Foundry does carry. */
function monsterHabitat(habitat) {
  if (!habitat || typeof habitat !== "object") return undefined;
  const parts = [
    ...(habitat.value ?? []).map((h) =>
      humanize(typeof h === "string" ? h : h?.type)
    ),
    clean(habitat.custom),
  ].filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)].join(", ") : undefined;
}

/**
 * Armor Class, which Foundry stores three different ways.
 *
 * `calc: "natural"` and `calc: "flat"` put the real number in `flat`.
 * `calc: "default"` puts nothing anywhere — Foundry derives it when it
 * prepares the actor, and source data has only the ingredients. Of
 * Derek's 385 monsters, 211 are natural, 136 are default, and reading
 * `flat` alone leaves those 136 with no AC at all.
 *
 * The default calculation is the ordinary unarmoured one: 10 + DEX,
 * plus a worn armour item's rating if there is one. Computing it is not
 * inventing a number — it is the same arithmetic Foundry does.
 */
function monsterAc(doc, s) {
  const flat = Number(s.attributes?.ac?.flat);
  if (Number.isFinite(flat) && flat > 0) return flat;

  const dex = Number(s.abilities?.dex?.value);
  const dexMod = Number.isFinite(dex) ? Math.floor((dex - 10) / 2) : 0;

  let base = null;
  let shield = 0;
  for (const item of doc.items ?? []) {
    const armor = sys(item).armor;
    const value = Number(armor?.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (clean(sys(item).type?.value).toLowerCase() === "shield") {
      shield += value;
    } else if (base === null || value > base) {
      base = value;
      // Medium and heavy armour cap how much DEX applies.
      const cap = Number(armor?.dex);
      if (Number.isFinite(cap)) base += Math.min(dexMod, cap) - dexMod;
    }
  }

  const total = (base ?? 10) + dexMod + shield;
  return total > 0 ? total : undefined;
}

function actorToMonster(doc) {
  const s = sys(doc);
  const details = s.details ?? {};
  const attrs = s.attributes ?? {};
  const typeField = details.type;

  const ac = monsterAc(doc, s);
  const hp = Number(attrs.hp?.max ?? attrs.hp?.value);
  const cr = Number(details.cr);

  // dnd5e moved creature type from a string to an object; the subtype
  // ("goblinoid") is more useful than the type ("humanoid") when both
  // are there.
  const creatureType =
    humanize(typeField?.subtype) ||
    humanize(typeField?.value ?? typeField) ||
    undefined;

  const row = {
    name: clean(doc.name) || "Unnamed",
    image: libraryImage(doc),
    size: SIZES[s.traits?.size] ?? humanize(s.traits?.size),
    creatureType,
    alignment: clean(details.alignment) || undefined,
    cr: Number.isFinite(cr) ? cr : undefined,
    ac: ac,
    hp: Number.isFinite(hp) ? hp : undefined,
    speed: formatSpeed(attrs.movement),
    abilities: abilityScores(s.abilities),
    skills: monsterSkills(s.skills),
    senses: monsterSenses(attrs.senses ?? s.senses),
    languages: (() => {
      const langs = s.traits?.languages;
      const list = [
        ...(langs?.value ?? []).map((l) => humanize(l)),
        clean(langs?.custom),
      ].filter(Boolean);
      return list.length > 0 ? list.join(", ") : undefined;
    })(),
    habitat: monsterHabitat(details.habitat),
    proficiencyBonus: Number.isFinite(Number(attrs.prof))
      ? Number(attrs.prof)
      : proficiencyFor(cr),
    xp: Number.isFinite(Number(details.xp?.value))
      ? Number(details.xp.value)
      : xpFor(cr),
    ...(() => {
      const f = monsterFeatures(doc, {
        abilities: s.abilities,
        proficiencyBonus: Number.isFinite(Number(attrs.prof))
          ? Number(attrs.prof)
          : proficiencyFor(cr),
      });
      return {
        traits: f.traits.length ? f.traits : undefined,
        actions: f.actions.length ? f.actions : undefined,
        legendaryActions: f.legendary.length ? f.legendary : undefined,
      };
    })(),
    blocks:
      toBlocks(details.biography?.public) ??
      toBlocks(details.biography?.value),
    source: formatSource(details.source ?? s.source),
  };
  return row;
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

const USAGE =
  "usage: node scripts/import-foundry.mjs <path> <campaignId> [-o out/] [--dry-run]\n\n" +
  "  <path>        a Foundry export .json, a NeDB .db, or a directory\n" +
  "  <campaignId>  the Convex id of the campaign to import into\n" +
  "  -o out/       where to write the JSONL (default: foundry-import)\n" +
  "  --dry-run     report what is in the file and write nothing\n";

const { positionals, flags } = parseOrExit(
  process.argv.slice(2),
  {
    "-o": { value: true, default: "foundry-import" },
    "--dry-run": {},
    "--help": {},
  },
  USAGE
);

const [path, campaignId] = positionals;

if (!path || !campaignId || flags["--help"]) {
  console.error(USAGE);
  process.exit(1);
}

const outDir = flags["-o"];

// A wrong path is the most likely thing to go wrong here, and Node's
// answer to it is an ENOENT stack trace that buries the one fact that
// matters. Say it plainly instead.
if (!existsSync(path)) {
  console.error(
    `Cannot find: ${path}\n\n` +
      "Point this at the file the Foundry macro downloaded. To find it:\n" +
      "  ls -lhS ~/Downloads/*.json | head\n\n" +
      "and use the full path, in quotes if it contains spaces."
  );
  process.exit(1);
}

/**
 * A big export is worth looking at before converting it.
 *
 * `--dry-run` reads and classifies but writes nothing, so a 130 MB file
 * can be inspected — and its counts reported — without producing four
 * JSONL files and an import you may not want.
 */
const dryRun = flags["--dry-run"];

const documents = readDocuments(path);
const journalsById = new Map();
const skipped = { unrecognised: 0, characters: 0, vehicles: 0 };

// Journals first: a scene's notes reference them by id.
for (const doc of documents) {
  if (classify(doc) === "journal") journalsById.set(doc._id, doc);
}

const npcs = [];
const monsters = [];
const spells = [];
const itemRows = [];
const feats = [];
const backgrounds = [];
const classRows = [];
const speciesRows = [];
const locations = [];

for (const doc of documents) {
  const kind = classify(doc);

  if (kind === "item") {
    itemRows.push(itemToRow(doc));
    continue;
  }

  if (kind === "spell") {
    spells.push(spellToRow(doc));
    continue;
  }

  if (kind === "feat") {
    feats.push(featToRow(doc));
    continue;
  }

  if (kind === "background") {
    backgrounds.push(backgroundToRow(doc));
    continue;
  }

  if (kind === "class") {
    classRows.push(classToRow(doc));
    continue;
  }

  if (kind === "species") {
    speciesRows.push(speciesToRow(doc));
    continue;
  }

  if (kind === "actor") {
    const type = (doc.type ?? "").toLowerCase();
    // Player characters belong to players, not to the NPC roster.
    if (type === "character") {
      skipped.characters++;
      continue;
    }
    // A vehicle is not a monster and not a person. Its "creature type"
    // is a propulsion category ("Air"), which would sit in the monster
    // list looking like a species.
    if (type === "vehicle" || type === "group") {
      skipped.vehicles++;
      continue;
    }
    // The SAME actor is written both ways, because only Derek knows
    // which it is: a named person in Moonbrook belongs in the NPC
    // roster, and an SRD stat block belongs in the Lookup library.
    // Writing both files and letting him import one costs nothing;
    // guessing wrong mixes 300 monsters into a 197-person roster with
    // no clean way back.
    npcs.push(actorToNpc(doc, campaignId));
    monsters.push(actorToMonster(doc));
    continue;
  }

  if (kind === "scene") {
    locations.push(...sceneToLocations(doc, journalsById));
    continue;
  }

  if (kind !== "journal") skipped.unrecognised++;
}

if (!dryRun) mkdirSync(outDir, { recursive: true });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const npcPath = join(outDir, "npcs.jsonl");
const monsterPath = join(outDir, "monsters.jsonl");
const spellPath = join(outDir, "spells.jsonl");
const itemPath = join(outDir, "items.jsonl");
const featPath = join(outDir, "feats.jsonl");
const backgroundPath = join(outDir, "backgrounds.jsonl");
const classPath = join(outDir, "classes.jsonl");
const speciesPath = join(outDir, "species.jsonl");

if (!dryRun) {
  writeFileSync(npcPath, jsonl(npcs));
  writeFileSync(monsterPath, jsonl(monsters));
  writeFileSync(spellPath, jsonl(spells));
  writeFileSync(itemPath, jsonl(itemRows));
  writeFileSync(featPath, jsonl(feats));
  writeFileSync(backgroundPath, jsonl(backgrounds));
  writeFileSync(classPath, jsonl(classRows));
  writeFileSync(speciesPath, jsonl(speciesRows));
}

const locPath = join(outDir, "locations.json");
if (!dryRun) {
  writeFileSync(
    locPath,
    JSON.stringify({ campaignId, locations }, null, 2) + "\n"
  );
}

// A short report, so a silently-empty import is visible before it runs.
const scenes = locations.filter((l) => !l.parentKey);
const pinned = locations.filter((l) => l.x !== undefined).length;
const unpinned = locations.filter(
  (l) => l.parentKey && l.x === undefined
).length;

// In a dry run nothing was written, so naming files that do not exist
// would be a lie told in the report meant to prevent one.
const to = (p) => (dryRun ? "" : ` -> ${p}`);

console.log(`read ${documents.length} document(s) from ${basename(path)}`);
console.log(`  ${spells.length} spell(s)${to(spellPath)}`);
console.log(`  ${itemRows.length} item(s)${to(itemPath)}`);
console.log(`  ${monsters.length} monster(s)${to(monsterPath)}`);
console.log(`  ${feats.length} feat(s)${to(featPath)}`);
console.log(`  ${backgrounds.length} background(s)${to(backgroundPath)}`);
console.log(`  ${classRows.length} class(es) and subclass(es)${to(classPath)}`);
console.log(`  ${speciesRows.length} species${to(speciesPath)}`);
console.log(
  `  ${npcs.length} of those also available as NPCs${to(npcPath)}`
);
console.log(
  `  ${scenes.length} scene(s) and ${locations.length - scenes.length} pin(s)${to(locPath)}`
);
console.log(`  ${journalsById.size} journal(s) read for descriptions`);
console.log(`  ${pinned} pin(s) placed, ${unpinned} without coordinates`);
if (skipped.characters > 0) {
  console.log(`  ${skipped.characters} player character(s) skipped`);
}
if (skipped.vehicles > 0) {
  console.log(`  ${skipped.vehicles} vehicle(s) skipped`);
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

/**
 * How often each build field was actually found.
 *
 * The four build converters read fields that have moved between dnd5e
 * versions, so the failure mode is not a crash — it is a column that
 * is empty on every row, in a table that otherwise imported fine, and
 * which nobody notices until they sort by it. A field found on 0% of
 * rows is called out here, before the import runs, where it is one
 * question rather than an afternoon.
 *
 * Rows with a field on SOME of them are reported as a percentage and
 * left alone: a prerequisite is genuinely absent on most feats, and a
 * parent class is absent on every class that is not a subclass.
 */
const FILL_REPORT = [
  ["feat", feats, ["category", "prerequisite", "repeatable"]],
  [
    "background",
    backgrounds,
    ["abilities", "feat", "skills", "tools", "equipment"],
  ],
  ["class", classRows, ["hitDie", "primaryAbility", "saves", "spellcasting"]],
  // parentClass is checked against the SUBCLASSES only. Every class
  // that is not a subclass has none, so measuring it across the whole
  // table reports a library with no subclasses in it as a converter
  // fault — a warning that cries wolf is one you stop reading.
  ["class", classRows.filter((r) => r.isSubclass), ["parentClass"]],
  ["species", speciesRows, ["size", "speed", "creatureType", "darkvision"]],
];

const missing = [];
for (const [label, rows, fields] of FILL_REPORT) {
  if (rows.length === 0) continue;
  for (const field of fields) {
    const filled = rows.filter((r) => r[field] !== undefined).length;
    if (filled === 0) missing.push(`${label}.${field}`);
  }
}

if (missing.length > 0) {
  console.log(
    `\nnote: these build fields came back empty on EVERY row —\n` +
      `  ${missing.join(", ")}\n` +
      "  The column will import and be blank. Either this export does not\n" +
      "  carry them, or dnd5e has moved them again and the converter is\n" +
      "  reading the wrong place. Worth checking before you import."
  );
}

if (dryRun) {
  console.log("\n--dry-run: nothing was written. Drop the flag to convert.");
  process.exit(0);
}

const lines = ["\nnext — run only the ones with rows in them:\n"];
if (spells.length) lines.push(`  npx convex import --table spells ${spellPath} --append`);
if (itemRows.length) lines.push(`  npx convex import --table items ${itemPath} --append`);
if (feats.length) lines.push(`  npx convex import --table feats ${featPath} --append`);
if (backgrounds.length) {
  lines.push(
    `  npx convex import --table backgrounds ${backgroundPath} --append`
  );
}
if (classRows.length) lines.push(`  npx convex import --table classes ${classPath} --append`);
if (speciesRows.length) lines.push(`  npx convex import --table species ${speciesPath} --append`);
if (monsters.length) {
  lines.push(`  npx convex import --table monsters ${monsterPath} --append`);
  lines.push(
    `  # ...OR, if these are your own campaign NPCs rather than stat blocks:`
  );
  lines.push(`  npx convex import --table npcs ${npcPath} --append`);
}
if (locations.length) {
  lines.push(
    `  npx convex run locations:importLocations "$(cat ${locPath})" \\`
  );
  lines.push(`    --identity '{"subject":"YOUR_USER_ID|seed"}'`);
}
console.log(lines.join("\n") + "\n");

if (monsters.length > 0) {
  console.log(
    "The actors were written to BOTH monsters.jsonl and npcs.jsonl. Import\n" +
      "one: SRD stat blocks belong in the Lookup library, named people in\n" +
      "Moonbrook belong in the NPC roster. Importing both mixes them.\n"
  );
}
if (locations.length > 0) {
  console.log(
    "The locations import runs a DM-gated mutation, so it needs to run as\n" +
      "you — see SETUP-CONVEX.md for where YOUR_USER_ID comes from.\n"
  );
}
