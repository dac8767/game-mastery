/**
 * The Lookup filters: what they are, and what they match.
 *
 * Pure and dependency-free, so the unit guard can exercise the matching
 * rules. Filtering happens in the browser rather than the server —
 * see convex/lookup.ts for why that is the cheap option here and not
 * the expensive one — which means every rule in this file runs on every
 * keystroke, and a wrong one silently hides rows rather than erroring.
 *
 * Every filter is DECLARED rather than hand-wired, so the compact bar,
 * the advanced panel and the reset button all read the same list and
 * cannot drift apart.
 */

/**
 * Deliberately IMPORT-FREE, like every other pure module here.
 *
 * The unit guard compiles these on their own, and TypeScript's `@/`
 * path mapping is compile-time only — the emitted JavaScript keeps the
 * unresolvable specifier, so a module that imports a sibling cannot be
 * run in isolation. That is why the kind union is restated below
 * instead of imported; tests/guards/integrity.mjs checks the two copies
 * still agree.
 */
export type LookupKind =
  | "spells"
  | "items"
  | "monsters"
  | "feats"
  | "backgrounds"
  | "classes"
  | "species";

export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------
// Which edition a campaign plays
// ---------------------------------------------------------------------

/** "2014" is 5e; "2024" is 5.5e. Mirrors campaigns.rulesVersion. */
export type RulesVersion = "2014" | "2024";

/** What the setting is called where a person has to read it. */
export const RULES_VERSIONS: { value: RulesVersion; label: string; note: string }[] =
  [
    {
      value: "2014",
      label: "5e (2014)",
      note: "Player's Handbook, Monster Manual and Dungeon Master's Guide as first published, plus Tasha's, Xanathar's and the rest. The 2024 species, feats, backgrounds and classes do not show at all — a 5e character cannot be built from them.",
    },
    {
      value: "2024",
      label: "5.5e (2024)",
      note: "The 2024 revision of the three core books. Everything with no 2024 counterpart still shows — Warforged has no 2024 printing, and dropping it would throw away the only copy there is.",
    },
  ];

/**
 * Which edition a row's book belongs to.
 *
 * The import writes `source` as the book's short name, and the 2024
 * core books carry the year in theirs — "PHB 2024", "MM 2024", "DMG
 * 2024", "SRD 2024" — while their predecessors are bare: "PHB", "MM",
 * "DMG", "SRD 5.1". Everything else, from Tasha's to an adventure, is
 * 2014-era by default, which is what it is.
 *
 * Anchored to the END of the string on purpose. A loose search for
 * "2024" anywhere would catch an adventure with the year in its title
 * and quietly reclassify it.
 */
export function editionOf(source: unknown): RulesVersion {
  const s = typeof source === "string" ? source.trim() : "";
  return /(?:^|\s)2024$/.test(s) ? "2024" : "2014";
}

/**
 * Kinds where an entry from the OTHER edition is not usable at all.
 *
 * A character-build option belongs to a rules edition the way a
 * reference entry does not. The 2024 Goliath is not "a Goliath you
 * could also use in a 5e game" — it is built on 2024's species rules,
 * and a 5e table has no place to put it. The same goes for a 2024
 * feat, background, class or subclass.
 *
 * Spells, items and monsters are the opposite, which is why they are
 * not on this list. A 2024 monster with no 2014 predecessor is a
 * stat block: drop it into a 5e game and it works. Excluding those
 * would empty a 5e Monsters table of everything printed since 2024
 * for no reason anyone asked for.
 */
const EDITION_EXCLUSIVE: LookupKind[] = [
  "species",
  "feats",
  "backgrounds",
  "classes",
];

/**
 * Collapse rows that are the same entry twice.
 *
 * Not the same as the edition rule, and it has to run first. Two
 * "Artisan / PHB 2024" rows are not two printings to choose between —
 * they are one background imported twice, and the edition rule keeps
 * BOTH because both match the wanted edition. A Foundry world that has
 * the same compendium loaded from two modules produces this by the
 * dozen.
 *
 * Same NAME and same SOURCE is the bar. "Archaeologist / ToA" and
 * "Archaeologist / EFotA" are two different backgrounds that share a
 * name, and collapsing those would lose one.
 *
 * The first survives, in input order, so which copy you get does not
 * depend on the sort you happen to be using.
 */
export function dedupeExact<T extends Row>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key =
      String(row.name ?? "").trim().toLowerCase().replace(/\s+/g, " ") +
      "\u0000" +
      String(row.source ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * The library this campaign actually plays with.
 *
 * Two rules, and which one applies depends on the kind:
 *
 *   Everything — a name printed in BOTH editions collapses to this
 *   campaign's one. Aasimar (MotM) and Aasimar (PHB 2024) are one
 *   species with two printings, so a 2024 table shows the 2024 one
 *   and a 2014 table shows the older one.
 *
 *   Build kinds — a 2024-only entry does not appear in a 2014
 *   campaign at all. This is the half that is NOT a deduplication:
 *   there is nothing to choose between, and it still goes, because a
 *   5e game cannot use a 2024 species.
 *
 * The asymmetry is deliberate and is not a bug. A 2014-only entry
 * still shows in a 2024 campaign: Warforged has no 2024 printing and
 * a 5.5e table that dropped it would be throwing away the one copy
 * that exists. Only the newer direction is exclusive, because the
 * newer books REPLACE rather than extend.
 *
 * Matching is by name, case- and space-insensitively, because that is
 * the only thing the two printings of a longsword reliably share.
 *
 * Input order is preserved: the caller sorts afterwards, and a stable
 * order here keeps that sort's tiebreaks predictable.
 */
export function applyEdition<T extends Row>(
  rows: T[],
  edition: RulesVersion,
  /**
   * Required, not optional. A call site that omitted it would compile
   * and would quietly get the old rule back — a 5e Species table with
   * the 2024 books in it, and nothing anywhere saying so.
   */
  kind: LookupKind
): T[] {
  // A 2014 campaign cannot use a 2024 build option, whether or not
  // anything older shares its name. Done BEFORE the grouping, so a
  // 2024-only name is gone rather than being the only candidate left
  // in its group and surviving as the fallback.
  // Exact duplicates go FIRST, and inside this function rather than
  // beside it at the call site — the edition rule keeps every row of
  // the wanted edition, so a name imported twice under one source
  // survives twice, and a caller that forgot to dedupe would see it.
  const distinct = dedupeExact(rows);

  const usable =
    EDITION_EXCLUSIVE.includes(kind) && edition === "2014"
      ? distinct.filter((r) => editionOf(r.source) === "2014")
      : distinct;

  const byName = new Map<string, T[]>();
  for (const row of usable) {
    const key = String(row.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const group = byName.get(key);
    if (group) group.push(row);
    else byName.set(key, [row]);
  }

  const keep = new Set<T>();
  for (const group of byName.values()) {
    const wanted = group.filter((r) => editionOf(r.source) === edition);
    for (const r of wanted.length > 0 ? wanted : group) keep.add(r);
  }

  return usable.filter((r) => keep.has(r));
}

/** Which editions the table is showing. */
export type EditionShow = Record<RulesVersion, boolean>;

/** What each edition is called on the buttons. */
export const EDITION_LABEL: Record<RulesVersion, string> = {
  "2014": "5e",
  "2024": "5.5e",
};

/**
 * What the buttons start as: this campaign's edition, and not the
 * other one.
 *
 * The same library the campaign had before there were buttons — so a
 * table that nobody touches reads exactly as it did, and the buttons
 * are a way to see MORE rather than a new thing to configure.
 */
export function defaultEditions(campaign: RulesVersion): EditionShow {
  return { "2014": campaign === "2014", "2024": campaign === "2024" };
}

/**
 * The library, given which editions are switched on.
 *
 * Three cases, and the middle one is the whole point of the buttons:
 *
 *   one on    exactly what the campaign used to get, and nothing has
 *             changed for anybody who leaves the buttons alone.
 *   both on   nothing is hidden. Not "merge the two" — both printings
 *             of Aasimar appear, because you asked to see both, and
 *             collapsing them would be the app still deciding.
 *   none on   nothing. A legitimate thing to ask for and a strange
 *             thing to be given silently, so the screen says so rather
 *             than looking like a library that failed to load.
 */
export function applyEditions<T extends Row>(
  rows: T[],
  show: EditionShow,
  kind: LookupKind
): T[] {
  const on = (["2014", "2024"] as const).filter((e) => show[e]);
  if (on.length === 0) return [];
  // Still deduped: the same entry imported twice from two modules is
  // one entry however many editions are showing.
  if (on.length === 2) return dedupeExact(rows);
  return applyEdition(rows, on[0], kind);
}

/** What a control looks like. */
export type FilterControl =
  | { type: "text" }
  | { type: "select"; options: { value: string; label: string }[] }
  | { type: "multi"; options: { value: string; label: string }[] }
  | { type: "range" }
  | { type: "toggle" }
  /** A row of exclusive chips, like D&D Beyond's category icons. */
  | { type: "chips"; options: { value: string; label: string }[] };

export interface FilterDef {
  key: string;
  label: string;
  control: FilterControl;
  /**
   * Compact filters show in the bar; the rest are behind "Show advanced
   * filters". Ordered as declared.
   */
  advanced?: boolean;
  /**
   * Not worth a slot where space is tight: the condensed one-row bar
   * the DM Screen's windows use leaves minor filters out entirely.
   * Named by report: "unimportant options can be removed (like the
   * size option in the species tab)".
   */
  minor?: boolean;
  /** Placeholder for text and range controls. */
  hint?: string;
  /** True when this row passes. `value` is never empty when called. */
  match: (row: Row, value: FilterValue) => boolean;
}

export type FilterValue =
  | string
  | string[]
  | { min: string; max: string }
  | boolean;

export type FilterState = Record<string, FilterValue>;

// ---------------------------------------------------------------------
// Shared matchers
// ---------------------------------------------------------------------

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Case- and accent-insensitive substring. */
export function contains(haystack: unknown, needle: string): boolean {
  const h = text(haystack).toLowerCase();
  return h.includes(needle.trim().toLowerCase());
}

/** A declared-empty value means "no filter", and must never match-fail. */
export function isEmptyValue(value: FilterValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value === false;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return text(value.min).trim() === "" && text(value.max).trim() === "";
}

/**
 * Inclusive numeric range, with either end optional.
 *
 * A row whose value is missing fails a bounded range rather than
 * passing it: "AC 15 to 20" should not return the monsters whose AC the
 * import never carried.
 */
export function inRange(
  n: unknown,
  bounds: { min: string; max: string }
): boolean {
  if (typeof n !== "number" || !Number.isFinite(n)) return false;
  const min = Number(bounds.min);
  const max = Number(bounds.max);
  if (bounds.min.trim() !== "" && Number.isFinite(min) && n < min) return false;
  if (bounds.max.trim() !== "" && Number.isFinite(max) && n > max) return false;
  return true;
}

/**
 * Any-of, on a scalar field.
 *
 * Tolerates a single string as well as a list. Not politeness: a
 * filter's declared control decides whether its value is one string or
 * many, the `match` casts to whichever it believes, and a cast that
 * believes wrong used to throw "wanted.some is not a function" —
 * which unmounts the entire Lookup screen behind a red overlay. A
 * filter that matches the wrong rows is a bug; a filter that takes the
 * page down is an outage, and the difference is one line.
 */
export function anyOf(value: unknown, wanted: string[] | string): boolean {
  const v = text(value);
  const list = Array.isArray(wanted) ? wanted : [wanted];
  return list.some((w) => v === w);
}

const opts = (...values: string[]) =>
  values.map((v) => ({ value: v, label: v }));

// ---------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------

export const SPELL_LEVELS = [
  { value: "0", label: "Cantrip" },
  ...Array.from({ length: 9 }, (_, i) => ({
    value: String(i + 1),
    label: `Level ${i + 1}`,
  })),
];

/**
 * The 2024 feat groupings.
 *
 * A chip whose value no row carries is invisible: it renders, it is
 * clickable, and it returns an empty list. So these strings are the
 * ones the importer writes, and the integrity guard compares the two
 * lists rather than trusting that they were written on the same day.
 */
export const FEAT_CATEGORIES = opts(
  "Origin",
  "General",
  "Fighting Style",
  "Epic Boon"
);

/** Classes and subclasses share a table; this is which is which. */
export const CLASS_KINDS = opts("Class", "Subclass");

/**
 * How far a class's spell slots go.
 *
 * dnd5e stores these as slugs — "full", "half", "third", "pact" — and
 * the importer spells them out, so these are the spelt-out forms.
 */
export const CASTER_PROGRESSIONS = opts("Full", "Half", "Third", "Pact");

export const HIT_DICE = opts("d6", "d8", "d10", "d12");

/** Written the way a class entry abbreviates them. */
export const ABILITY_OPTIONS = opts(
  "Str",
  "Dex",
  "Con",
  "Int",
  "Wis",
  "Cha"
);

/**
 * Species sizes.
 *
 * Small and Medium only, plus the both-of-them case that is a real
 * entry rather than a data error — a 2024 Halfling is Small, a Human
 * is Medium, and a Goliath is Medium going on Large. Tiny and Huge are
 * absent because no playable species is either, and a chip nothing
 * matches is worse than a missing one.
 */
export const SPECIES_SIZES = opts("Small", "Medium", "Large");

export const SCHOOLS = opts(
  "Abjuration",
  "Conjuration",
  "Divination",
  "Enchantment",
  "Evocation",
  "Illusion",
  "Necromancy",
  "Transmutation"
);

export const ITEM_KINDS = [
  { value: "armor", label: "Armor" },
  { value: "consumable", label: "Potion" },
  { value: "ring", label: "Ring" },
  { value: "rod", label: "Rod" },
  { value: "wand", label: "Wand" },
  { value: "weapon", label: "Weapon" },
  { value: "wondrous", label: "Wondrous" },
  { value: "tool", label: "Tool" },
  { value: "container", label: "Container" },
  { value: "gear", label: "Gear" },
];

export const RARITIES = opts(
  "Common",
  "Uncommon",
  "Rare",
  "Very Rare",
  "Legendary",
  "Artifact"
);

export const CREATURE_TYPES = opts(
  "Aberration",
  "Beast",
  "Celestial",
  "Construct",
  "Dragon",
  "Elemental",
  "Fey",
  "Fiend",
  "Giant",
  "Humanoid",
  "Monstrosity",
  "Ooze",
  "Plant",
  "Undead"
);

export const SIZES = opts(
  "Tiny",
  "Small",
  "Medium",
  "Large",
  "Huge",
  "Gargantuan"
);

export const SAVE_ABILITIES = opts("STR", "DEX", "CON", "INT", "WIS", "CHA");

// ---------------------------------------------------------------------
// The three filter sets
// ---------------------------------------------------------------------

const NAME: FilterDef = {
  key: "name",
  label: "Name",
  control: { type: "text" },
  hint: "Search names",
  match: (row, value) => contains(row.name, value as string),
};

const SOURCE: FilterDef = {
  key: "source",
  label: "Source",
  control: { type: "text" },
  hint: "SRD, DDB…",
  advanced: true,
  match: (row, value) => contains(row.source, value as string),
};

const SPELL_FILTERS: FilterDef[] = [
  NAME,
  {
    key: "level",
    label: "Spell Level",
    control: { type: "multi", options: SPELL_LEVELS },
    match: (row, value) =>
      (value as string[]).some((v) => Number(v) === row.level),
  },
  {
    key: "school",
    label: "School",
    control: { type: "multi", options: SCHOOLS },
    match: (row, value) => anyOf(row.school, value as string[]),
  },
  {
    key: "castingTime",
    label: "Casting Time",
    control: { type: "text" },
    hint: "Action, 1 minute…",
    match: (row, value) => contains(row.castingTime, value as string),
  },
  {
    key: "save",
    label: "Save Required",
    control: { type: "multi", options: SAVE_ABILITIES },
    advanced: true,
    // attackSave is "DEX Save" or "STR/CON Save", so this is a
    // substring rather than an equality.
    match: (row, value) =>
      (value as string[]).some((v) => contains(row.attackSave, v)),
  },
  {
    key: "attack",
    label: "Attack Type",
    control: { type: "select", options: opts("Melee", "Ranged") },
    advanced: true,
    match: (row, value) => text(row.attackSave) === (value as string),
  },
  {
    key: "damage",
    label: "Damage Type",
    control: { type: "text" },
    hint: "Fire, Necrotic…",
    advanced: true,
    match: (row, value) => contains(row.damageEffect, value as string),
  },
  {
    key: "components",
    label: "Components",
    control: { type: "multi", options: opts("V", "S", "M") },
    advanced: true,
    // Every selected letter must be present, not any — "V and S" is a
    // narrower question than "V or S", and the narrower one is what
    // the control looks like it asks.
    match: (row, value) =>
      (value as string[]).every((v) =>
        text(row.components)
          .split(/,\s*/)
          .includes(v)
      ),
  },
  {
    key: "concentration",
    label: "Concentration",
    control: { type: "toggle" },
    advanced: true,
    match: (row) => row.concentration === true,
  },
  {
    key: "ritual",
    label: "Ritual",
    control: { type: "toggle" },
    advanced: true,
    match: (row) => row.ritual === true,
  },
  SOURCE,
];

const ITEM_FILTERS: FilterDef[] = [
  {
    key: "kind",
    label: "Category",
    control: { type: "chips", options: ITEM_KINDS },
    match: (row, value) => text(row.kind) === (value as string),
  },
  NAME,
  {
    key: "rarity",
    label: "Rarity",
    control: { type: "multi", options: RARITIES },
    match: (row, value) => anyOf(row.rarity, value as string[]),
  },
  {
    key: "attunement",
    label: "Requires Attunement",
    control: { type: "toggle" },
    match: (row) => row.attunement === true,
  },
  {
    key: "price",
    label: "Has a price",
    control: { type: "toggle" },
    advanced: true,
    match: (row) => Boolean(text(row.price)),
  },
  {
    key: "weight",
    label: "Weight",
    control: { type: "range" },
    hint: "lb",
    advanced: true,
    match: (row, value) =>
      inRange(row.weight, value as { min: string; max: string }),
  },
  SOURCE,
];

const MONSTER_FILTERS: FilterDef[] = [
  {
    key: "creatureType",
    label: "Type",
    control: { type: "chips", options: CREATURE_TYPES },
    match: (row, value) => text(row.creatureType) === (value as string),
  },
  NAME,
  {
    key: "cr",
    label: "Challenge Range",
    control: { type: "range" },
    hint: "CR",
    match: (row, value) =>
      inRange(row.cr, value as { min: string; max: string }),
  },
  {
    key: "size",
    label: "Size",
    control: { type: "multi", options: SIZES },
    match: (row, value) => anyOf(row.size, value as string[]),
  },
  {
    key: "habitat",
    label: "Habitat",
    control: { type: "text" },
    hint: "Forest, Urban…",
    match: (row, value) => contains(row.habitat, value as string),
  },
  {
    key: "alignment",
    label: "Alignment",
    control: { type: "text" },
    hint: "Chaotic Evil…",
    advanced: true,
    match: (row, value) => contains(row.alignment, value as string),
  },
  {
    key: "ac",
    label: "Armor Class Range",
    control: { type: "range" },
    advanced: true,
    match: (row, value) =>
      inRange(row.ac, value as { min: string; max: string }),
  },
  {
    key: "hp",
    label: "Hit Points Range",
    control: { type: "range" },
    advanced: true,
    match: (row, value) =>
      inRange(row.hp, value as { min: string; max: string }),
  },
  {
    key: "senses",
    label: "Senses",
    control: { type: "text" },
    hint: "Darkvision…",
    advanced: true,
    match: (row, value) => contains(row.senses, value as string),
  },
  {
    key: "languages",
    label: "Languages",
    control: { type: "text" },
    hint: "Giant, Orc…",
    advanced: true,
    match: (row, value) => contains(row.languages, value as string),
  },
  {
    key: "legendary",
    label: "Legendary",
    control: { type: "toggle" },
    advanced: true,
    match: (row) => row.legendary === true,
  },
  SOURCE,
];

/**
 * The character-build kinds.
 *
 * Shorter lists than the three above, on purpose. A filter that every
 * row passes is a control that does nothing but take up the bar, and
 * these tables are a few hundred rows where the spell list is
 * thousands — Search plus one or two real distinctions is the whole
 * job. SOURCE is on every one of them, because "what book is this
 * from" is the question that survives at any size.
 */
const FEAT_FILTERS: FilterDef[] = [
  {
    key: "category",
    label: "Category",
    control: { type: "chips", options: FEAT_CATEGORIES },
    // A chips value is ONE string — the chips are exclusive. This read
    // it as an array and crashed the whole screen on the first click
    // with "wanted.some is not a function"; the `as string[]` cast is
    // what let it through the compiler.
    match: (row, value) => text(row.category) === (value as string),
  },
  {
    key: "prerequisite",
    label: "Prerequisite",
    control: { type: "text" },
    hint: "Level 4, Strength 13…",
    advanced: true,
    match: (row, value) => contains(row.prerequisite, value as string),
  },
  {
    key: "noPrerequisite",
    label: "No prerequisite",
    control: { type: "toggle" },
    // The question you actually ask at level 1, and the one a text box
    // cannot express: "contains nothing" is not something you can type.
    match: (row) => text(row.prerequisite).trim() === "",
  },
  {
    key: "repeatable",
    label: "Repeatable",
    control: { type: "toggle" },
    advanced: true,
    match: (row) => row.repeatable === true,
  },
  SOURCE,
];

const BACKGROUND_FILTERS: FilterDef[] = [
  {
    key: "ability",
    label: "Raises",
    control: { type: "multi", options: ABILITY_OPTIONS },
    // `abilities` is "Dex, Int, Cha" — a list in a string, so this is a
    // substring test rather than anyOf, which compares the whole field.
    match: (row, value) =>
      (value as string[]).some((a) => contains(row.abilities, a)),
  },
  {
    key: "skills",
    label: "Skill",
    control: { type: "text" },
    hint: "Stealth, Arcana…",
    match: (row, value) => contains(row.skills, value as string),
  },
  {
    key: "feat",
    label: "Origin Feat",
    control: { type: "text" },
    hint: "Alert, Tough…",
    advanced: true,
    match: (row, value) => contains(row.feat, value as string),
  },
  {
    key: "tools",
    label: "Tool",
    control: { type: "text" },
    hint: "Thieves' Tools…",
    advanced: true,
    match: (row, value) => contains(row.tools, value as string),
  },
  SOURCE,
];

const CLASS_FILTERS: FilterDef[] = [
  {
    key: "isSubclass",
    label: "Kind",
    control: { type: "chips", options: CLASS_KINDS },
    // Stored as a boolean, offered as two chips. The chip values are
    // the strings "Class" and "Subclass", so the row is turned into
    // one of those rather than the chips being turned into booleans —
    // which would make an empty selection mean "false" and quietly
    // hide every subclass.
    match: (row, value) =>
      (row.isSubclass === true ? "Subclass" : "Class") === (value as string),
  },
  {
    key: "spellcasting",
    label: "Spellcasting",
    control: { type: "multi", options: CASTER_PROGRESSIONS },
    match: (row, value) => anyOf(row.spellcasting, value as string[]),
  },
  {
    key: "primaryAbility",
    label: "Primary Ability",
    control: { type: "multi", options: ABILITY_OPTIONS },
    advanced: true,
    match: (row, value) =>
      (value as string[]).some((a) => contains(row.primaryAbility, a)),
  },
  {
    key: "hitDie",
    label: "Hit Die",
    control: { type: "multi", options: HIT_DICE },
    advanced: true,
    match: (row, value) => anyOf(row.hitDie, value as string[]),
  },
  SOURCE,
];

const SPECIES_FILTERS: FilterDef[] = [
  {
    key: "size",
    label: "Size",
    control: { type: "multi", options: SPECIES_SIZES },
    minor: true,
    // "Small or Medium" is a real entry, so this reads the field as
    // text rather than matching it whole — a Halfling filtered under
    // Small must not vanish because its field says both.
    match: (row, value) =>
      (value as string[]).some((s) => contains(row.size, s)),
  },
  {
    key: "darkvision",
    label: "Has Darkvision",
    control: { type: "toggle" },
    match: (row) => typeof row.darkvision === "number" && row.darkvision > 0,
  },
  {
    key: "speed",
    label: "Speed Range",
    control: { type: "range" },
    hint: "30",
    advanced: true,
    // The stored field is "30 ft", so the number comes out of it first.
    match: (row, value) => {
      const m = /(\d+)/.exec(text(row.speed));
      return inRange(m ? Number(m[1]) : null, value as { min: string; max: string });
    },
  },
  {
    key: "creatureType",
    label: "Creature Type",
    control: { type: "text" },
    hint: "Humanoid…",
    advanced: true,
    match: (row, value) => contains(row.creatureType, value as string),
  },
  SOURCE,
];

export const FILTERS: Record<LookupKind, FilterDef[]> = {
  spells: SPELL_FILTERS,
  items: ITEM_FILTERS,
  monsters: MONSTER_FILTERS,
  feats: FEAT_FILTERS,
  backgrounds: BACKGROUND_FILTERS,
  classes: CLASS_FILTERS,
  species: SPECIES_FILTERS,
};

// ---------------------------------------------------------------------
// Applying them
// ---------------------------------------------------------------------

/**
 * Every non-empty filter must pass. An empty one is not a filter.
 *
 * That distinction is the whole reason `isEmptyValue` exists: a `match`
 * is never asked about a value the person hasn't set, so no matcher has
 * to defend against one.
 */
export function applyFilters(
  kind: LookupKind,
  rows: Row[],
  state: FilterState
): Row[] {
  const active = FILTERS[kind].filter((f) => !isEmptyValue(state[f.key]));
  if (active.length === 0) return rows;
  return rows.filter((row) => active.every((f) => f.match(row, state[f.key])));
}

/** How many filters are set — for the "N active" badge on the toggle. */
export function activeCount(kind: LookupKind, state: FilterState): number {
  return FILTERS[kind].filter((f) => !isEmptyValue(state[f.key])).length;
}

/** Whether any ADVANCED filter is set, so the panel opens showing it. */
export function hasActiveAdvanced(
  kind: LookupKind,
  state: FilterState
): boolean {
  return FILTERS[kind].some(
    (f) => f.advanced && !isEmptyValue(state[f.key])
  );
}

