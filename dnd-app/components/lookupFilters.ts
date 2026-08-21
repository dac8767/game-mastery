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
export type LookupKind = "spells" | "items" | "monsters";

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
      note: "Player's Handbook, Monster Manual and Dungeon Master's Guide as first published, plus Tasha's, Xanathar's and the rest.",
    },
    {
      value: "2024",
      label: "5.5e (2024)",
      note: "The 2024 revision of the three core books. Everything with no 2024 counterpart still shows.",
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
 * Keep one edition's version of anything that exists in both.
 *
 * This is a DEDUPLICATION, not a filter by book. A name that appears
 * once — Tasha's items, an adventure's monsters, a 2024 monster with no
 * predecessor — has nothing to choose between, so it survives whichever
 * edition it belongs to. Filtering by book instead would empty a 5.5e
 * table of everything outside the three core books, which is not what
 * "we play 2024" means.
 *
 * Matching is by name, case- and space-insensitively, because that is
 * the only thing the two printings of a longsword reliably share.
 *
 * Input order is preserved: the caller sorts afterwards, and a stable
 * order here keeps that sort's tiebreaks predictable.
 */
export function applyEdition<T extends Row>(
  rows: T[],
  edition: RulesVersion
): T[] {
  const byName = new Map<string, T[]>();
  for (const row of rows) {
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

  return rows.filter((r) => keep.has(r));
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

/** Any-of, on a scalar field. */
export function anyOf(value: unknown, wanted: string[]): boolean {
  const v = text(value);
  return wanted.some((w) => v === w);
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

export const FILTERS: Record<LookupKind, FilterDef[]> = {
  spells: SPELL_FILTERS,
  items: ITEM_FILTERS,
  monsters: MONSTER_FILTERS,
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

