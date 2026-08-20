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
    if (t === "spell") return "spell";
    if (ITEM_TYPES.has(t)) return "item";
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
 * deliberately absent: they are character-build machinery, not the
 * reference library, and folding them in would put "Fighter" in the
 * item list.
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

/** Foundry biographies are HTML. The NPC table's fields are plain text. */
function stripHtml(html) {
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
    // The unlabelled form keeps its content, minus the switches:
    // `&Reference[Charmed apply=false]` is the word "Charmed", and
    // `apply=false` is an instruction to Foundry, not part of the rule.
    .replace(/[@&]\w+\[([^\]]*)\]/g, (_, inner) =>
      inner.replace(/\s*\w+=("[^"]*"|\S+)/g, "").trim()
    )
    .replace(/\[\[\/(check|save|conc)\s+([^\]]*)\]\]/g, (_, kind, inner) =>
      formatCheck(kind === "save" || kind === "conc" ? "save" : "check", inner)
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
    .replace(/@attributes\.spell\.dc(\s+\w+)?/g, "your spell save DC")
    .replace(/@item\.level(\s+\w+)?/g, "the spell's level")
    .replace(/@details\.level(\s+\w+)?/g, "your level")
    .replace(
      /@[A-Za-z][\w.]*(\s+(?:capitalize|format|lowercase|uppercase))?/g,
      ""
    )

    // Tidy what removal and reconstruction left behind. The doubling is
    // real: the prose around `[[/check ...]]` often already ends in the
    // word "check", which the enricher supplies too.
    .replace(/\b(check|saving throw|save)\s+\1\b/gi, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
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
// Item -> an items row  (the Lookup library)
// ---------------------------------------------------------------------

/**
 * Foundry's item vocabulary is two fields: the document `type`
 * ("equipment") and a subtype ("wondrous", "shield"). Neither alone is
 * what a player would call the thing — "equipment" covers both plate
 * armour and a ring of invisibility — so they are folded into one small
 * bucket that is actually worth filtering by.
 */
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
    kind: itemKind(doc),
    rarity: humanize(s.rarity),
    price: formatPrice(s.price),
    weight: Number.isFinite(weight) && weight > 0 ? weight : undefined,
    // `attunement` is "" / "required" / "optional"; `attuned` is a
    // different field meaning "is it attuned right now", which is a
    // property of one character's copy, not of the item.
    attunement: clean(s.attunement).toLowerCase() === "required",
    description: stripHtml(s.description?.value),
    source: formatSource(s.source),
  };
  return row;
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
    level: Number.isFinite(Number(s.level)) ? Number(s.level) : 0,
    school: SCHOOLS[clean(s.school)] ?? humanize(s.school),
    castingTime: formatActivation(s.activation),
    range: unitised(s.range),
    components: components || undefined,
    materials: clean(s.materials?.value) || undefined,
    duration: unitised(s.duration),
    ritual: p.ritual,
    concentration: p.concentration,
    description: stripHtml(rawDescription),
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

function actorToMonster(doc) {
  const s = sys(doc);
  const details = s.details ?? {};
  const attrs = s.attributes ?? {};
  const typeField = details.type;

  const ac = Number(attrs.ac?.value ?? attrs.ac?.flat ?? attrs.ac);
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
    size: SIZES[s.traits?.size] ?? humanize(s.traits?.size),
    creatureType,
    alignment: clean(details.alignment) || undefined,
    cr: Number.isFinite(cr) ? cr : undefined,
    ac: Number.isFinite(ac) ? ac : undefined,
    hp: Number.isFinite(hp) ? hp : undefined,
    speed: formatSpeed(attrs.movement),
    abilities: abilityScores(s.abilities),
    description:
      stripHtml(details.biography?.public) ??
      stripHtml(details.biography?.value),
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
const monsters = [];
const spells = [];
const itemRows = [];
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

  if (kind === "actor") {
    const type = (doc.type ?? "").toLowerCase();
    // Player characters belong to players, not to the NPC roster.
    if (type === "character") {
      skipped.characters++;
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

mkdirSync(outDir, { recursive: true });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const npcPath = join(outDir, "npcs.jsonl");
const monsterPath = join(outDir, "monsters.jsonl");
const spellPath = join(outDir, "spells.jsonl");
const itemPath = join(outDir, "items.jsonl");

writeFileSync(npcPath, jsonl(npcs));
writeFileSync(monsterPath, jsonl(monsters));
writeFileSync(spellPath, jsonl(spells));
writeFileSync(itemPath, jsonl(itemRows));

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
console.log(`  ${spells.length} spell(s) -> ${spellPath}`);
console.log(`  ${itemRows.length} item(s) -> ${itemPath}`);
console.log(`  ${monsters.length} monster(s) -> ${monsterPath}`);
console.log(`  ${npcs.length} of those also written as NPCs -> ${npcPath}`);
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

const lines = ["\nnext — run only the ones with rows in them:\n"];
if (spells.length) lines.push(`  npx convex import --table spells ${spellPath} --append`);
if (itemRows.length) lines.push(`  npx convex import --table items ${itemPath} --append`);
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
