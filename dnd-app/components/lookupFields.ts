import {
  expandSource,
  sourceKey,
  sourceLabel,
  trackPx,
} from "./sourceNames";

export { expandSource, sourceKey, sourceLabel, trackPx };

/**
 * Rows from books nobody switched off.
 *
 * Keyed by BOOK rather than by the string in the row: "PHB", "PHB
 * 2014" and "PHB 2024" are one book with three spellings, and a filter
 * matching the raw value would leave two thirds of the Player's
 * Handbook on screen after you switched it off.
 *
 * Reads the source through splitSource for the same reason the Source
 * column does — an importer that put the book in the NAME rather than
 * in the field is common enough that every other reader here allows
 * for it, and a filter that did not would silently spare those rows.
 *
 * An empty list returns the same array rather than a copy: this runs
 * over every row of the table on every keystroke in the filter bar,
 * for a setting most people never touch.
 */
export function applySourceFilter<T extends Record<string, unknown>>(
  rows: T[],
  excluded: readonly string[]
): T[] {
  if (excluded.length === 0) return rows;
  const off = new Set(excluded);
  return rows.filter(
    (r) => !off.has(sourceKey(splitSource(r.name, r.source).source))
  );
}

/**
 * How a Lookup entry reads.
 *
 * The three kinds print completely differently — an item is a subtitle
 * and prose, a spell is a grid of eight labelled cells, a monster is a
 * stat block — so there is no shared field list here, only the pieces
 * each layout needs. Pure and dependency-free, so the unit guard can
 * exercise the formatting; the numbers in this file all mean something
 * other than themselves, and getting one wrong is a thing you notice at
 * the table rather than in a test.
 */

export type LookupKind =
  | "spells"
  | "items"
  | "monsters"
  | "feats"
  | "backgrounds"
  | "classes"
  | "species";

export const LOOKUP_TITLES: Record<LookupKind, string> = {
  spells: "Spells",
  items: "Items",
  monsters: "Monsters",
  feats: "Feats",
  backgrounds: "Backgrounds",
  classes: "Classes",
  species: "Species",
};

/**
 * The tab strip's order, which is the only order these appear in.
 *
 * Derek's, not alphabetical and not the order the tables were built
 * in: the three you reach for at the table first, then the four you
 * reach for while making a character. One list, read by the strip and
 * by the guard that checks every kind is reachable.
 */
export const LOOKUP_TABS: LookupKind[] = [
  "spells",
  "items",
  "monsters",
  "species",
  "backgrounds",
  "feats",
  "classes",
];

const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
};

// ---------------------------------------------------------------------
// Numbers that mean something else
// ---------------------------------------------------------------------

/**
 * Challenge rating, the way the stat block writes it.
 *
 * Stored as a number so it sorts — "1/4" between "1/8" and "1/2" is
 * only true numerically — but 0.25 is not what anyone calls it.
 */
export function formatCr(cr: unknown): string | null {
  if (typeof cr !== "number" || !Number.isFinite(cr)) return null;
  if (cr === 0) return "0";
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

/** Cantrips are level 0 and are never called "level 0" out loud. */
export function formatSpellLevel(level: unknown): string | null {
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  if (level === 0) return "Cantrip";
  const suffix =
    level === 1 ? "st" : level === 2 ? "nd" : level === 3 ? "rd" : "th";
  return `${level}${suffix}`;
}

/**
 * A bonus, printed with its sign: 3 -> "+3".
 *
 * NOT the same calculation as an ability modifier, which is why it is
 * its own function — a proficiency bonus is already a bonus, and
 * running it through the ability formula would print +3 as +1.
 */
export function signed(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n >= 0 ? `+${n}` : String(n);
}

/** The stat block prints the score and the modifier: "21 (+5)". */
export function abilityModifier(score: unknown): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return signed(Math.floor((score - 10) / 2));
}

export const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"] as const;

export interface AbilityCell {
  key: string;
  label: string;
  score: number;
  modifier: string;
}

export function abilityCells(raw: unknown): AbilityCell[] {
  if (!raw || typeof raw !== "object") return [];
  const a = raw as Record<string, unknown>;
  return ABILITY_ORDER.flatMap((key) => {
    const score = a[key];
    if (typeof score !== "number" || !Number.isFinite(score)) return [];
    return [
      {
        key,
        label: key.toUpperCase(),
        score,
        modifier: abilityModifier(score) ?? "",
      },
    ];
  });
}

// ---------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------

const ITEM_KIND_LABELS: Record<string, string> = {
  weapon: "Weapon",
  armor: "Armor",
  wondrous: "Wondrous Item",
  ring: "Ring",
  wand: "Wand",
  rod: "Rod",
  consumable: "Consumable",
  tool: "Tool",
  container: "Container",
  gear: "Adventuring Gear",
  other: "Item",
};

// ---------------------------------------------------------------------
// Feats, backgrounds, classes and species
// ---------------------------------------------------------------------

/**
 * The italic line under the name of a build entry.
 *
 * "Origin Feat", "Background", "Fighter Subclass", "Small or Medium
 * Humanoid" — what the thing IS, in the words the book uses, before
 * any of its numbers. Returns "" rather than null when there is
 * nothing worth saying, so the caller can drop the line entirely
 * instead of printing an em dash where a subtitle should be.
 */
export function buildSubtitle(
  kind: LookupKind,
  row: Record<string, unknown>
): string {
  if (kind === "feats") {
    const category = str(row.category);
    return category ? `${category} Feat` : "Feat";
  }

  if (kind === "backgrounds") return "Background";

  if (kind === "classes") {
    // A subclass says whose it is. "Subclass" on its own is true and
    // useless — the thing you want to know about Champion is that it
    // is a Fighter subclass.
    if (row.isSubclass === true) {
      const parent = str(row.parentClass);
      return parent ? `${parent} Subclass` : "Subclass";
    }
    const casting = str(row.spellcasting);
    return casting ? `Class · ${casting} Caster` : "Class";
  }

  if (kind === "species") {
    // "Small or Medium Humanoid", with either half dropped when it is
    // missing rather than left as a gap in the middle of the phrase.
    const parts = [str(row.size), str(row.creatureType)].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : "Species";
  }

  return "";
}

/** Marks a parent the list infers from its children. See familyRows. */
export const ABSENT_PARENT_ID = "absent:";

/**
 * A list of parents, each holding its own children.
 *
 * Two kinds are read this way and for the same reason: an
 * alphabetised pile is not a list of the things you choose between.
 * 134 class rows of which a dozen are classes puts Aberrant Sorcery,
 * Abjurer and Arcane Trickster above Barbarian; a species list does
 * the same with Air Genasi, Astral Elf and Bugbear above Dwarf.
 */
export interface FamilyGrouping {
  /** What the table lists: parents, plus anything with no parent. */
  rows: Record<string, unknown>[];
  /** Each parent's children, by the parent's normalised name. */
  childrenOf: Map<string, Record<string, unknown>[]>;
}

const famKey = (v: unknown) =>
  String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The shared half: given each row's parent NAME, build the grouping.
 *
 * Grouping is by the parent's name, never by finding the parent's ROW.
 * That distinction is not hypothetical — a Foundry export can hold the
 * 2024 printing of every base class and the 2014 printing of every
 * subclass, which Derek's does, so the 5e edition rule drops the
 * parents and keeps the children. Matching on a surviving row then
 * finds nothing and the screen falls back to a flat pile, which is
 * exactly what "not grouping by the main class" looked like.
 *
 * Where nothing supplies the parent, the group still appears, headed
 * by a row marked `absent`. Fighter exists in 5e even when the only
 * write-up of it in this library is the 2024 one.
 */
function groupByParent(
  rows: Record<string, unknown>[],
  /** The parent this row belongs under, or null if it is a parent. */
  parentOf: (row: Record<string, unknown>) => string | null
): FamilyGrouping {
  /**
   * A row's name with its book suffix off, which is the name every
   * parent lookup here is against.
   *
   * It used to compare RAW names, and a library whose rows all carry a
   * suffix — "Elf (PHB)", "High Elf (PHB)" — then failed to recognise
   * that the base was present: the parent was found by the cleaned
   * name "Elf", the roll call was taken on "elf (phb)", and the table
   * grew an inferred Elf heading beside the real Elf row. Both halves
   * have to read the name the same way.
   */
  const rowName = (r: Record<string, unknown>) =>
    splitSource(r.name, r.source).name;

  const parents: Record<string, unknown>[] = [];
  const childrenOf = new Map<string, Record<string, unknown>[]>();
  /** The parent name as WRITTEN, for headings we supply ourselves. */
  const written = new Map<string, string>();
  const havePar = new Set<string>();

  for (const row of rows) {
    if (parentOf(row) === null) {
      parents.push(row);
      havePar.add(famKey(rowName(row)));
    }
  }

  /** Its own row: a child that does not say whose it is. */
  const unattached: Record<string, unknown>[] = [];

  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === null) continue;
    const key = famKey(parent);
    if (!key) {
      unattached.push(row);
      continue;
    }
    if (!written.has(key)) written.set(key, parent.trim());
    const list = childrenOf.get(key);
    if (list) list.push(row);
    else childrenOf.set(key, [row]);
  }

  // A heading for every parent named by a child but not supplied by
  // the library. Synthetic, and says so: it carries none of the
  // parent's own facts, because nothing here knows them.
  const inferred: Record<string, unknown>[] = [];
  for (const key of childrenOf.keys()) {
    if (havePar.has(key)) continue;
    inferred.push({
      _id: `${ABSENT_PARENT_ID}${key}`,
      name: written.get(key) ?? key,
      isSubclass: false,
      absent: true,
    });
  }

  // Children in name order, so a parent reads the same way whatever
  // the table happens to be sorted by.
  for (const list of childrenOf.values()) {
    list.sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? ""))
    );
  }

  return { rows: [...parents, ...inferred, ...unattached], childrenOf };
}

/**
 * Classes, each holding its subclasses.
 *
 * A subclass says which class it belongs to — dnd5e stores it as
 * `classIdentifier` and the importer writes it as `parentClass` — so
 * the parent is read rather than guessed.
 */
export function classRows(
  rows: Record<string, unknown>[]
): FamilyGrouping {
  return groupByParent(rows, (r) =>
    r.isSubclass === true ? String(r.parentClass ?? "") : null
  );
}

/**
 * How much a book is THE printing of a species.
 *
 * The Player's Handbook first. XPHB — the 2024 book — second rather
 * than equal: a 5e campaign reads the 2014 one, so where the library
 * holds both, the 2014 picture is the one the rest of the entry is
 * about. Everything else is a printing like any other, and ties among
 * those are settled by the order the list is already in.
 */
const bookRank = (source: unknown): number => {
  const book = String(source ?? "")
    .trim()
    .replace(/\s+\d{4}$/, "");
  if (book === "PHB") return 0;
  if (book === "XPHB") return 1;
  return 2;
};

/**
 * The picture a family heading wears.
 *
 * A synthetic heading has no document, so it had no artwork — which
 * left the species that have variants as the only rows in the table
 * with a blank square where a picture goes, and those are the rows
 * people look for first. It borrows one from underneath instead.
 *
 * The first printing WITH ART rather than simply the first: a leading
 * variant that happens to have no picture would leave the heading
 * blank while every row under it has one, which is exactly the gap
 * this closes.
 */
export function familyImage(list: Record<string, unknown>[]): unknown {
  let best: unknown;
  let bestRank = Infinity;

  for (const row of list) {
    const image = row.image;
    if (typeof image !== "string" || !image.trim()) continue;
    const rank = bookRank(splitSource(row.name, row.source).source);
    if (rank < bestRank) {
      best = image;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Species, each holding its variations.
 *
 * Unlike a subclass, a species carries NO field saying what it is a
 * variant of — dnd5e has no `parentRace`. High Elf and Wood Elf are
 * separate documents that happen to be named after the thing they
 * vary. So the parent is read out of the name, in the two forms
 * exports actually use:
 *
 *   "High Elf"    -> Elf     a variant NAMED after its base
 *   "Elf (High)"  -> Elf     the base, qualified
 *
 * And only when that base is a species this library actually has. That
 * condition is what stops the rule inventing families: "Yuan-ti
 * Pureblood" does not become a Pureblood variant, because there is no
 * Pureblood. A hyphen does not count as a separator either, so
 * Half-Elf stays its own species rather than becoming an Elf.
 */
export function speciesRows(
  rows: Record<string, unknown>[]
): FamilyGrouping {
  /**
   * The name with its book suffix already off.
   *
   * "Dhampir (VRGtR)" and "Hexblood (VRGtR)" both end in the same
   * parenthetical, so two rows shared it, so it became a base — and
   * the list grew an inferred species called "(VRGtR)" that crashed
   * the moment you opened it. The suffix is a SOURCE, and splitSource
   * already knows how to tell one from a qualifier: it strips the
   * book and leaves "Elf (High)" alone.
   */
  const cleanName = (row: Record<string, unknown>) =>
    splitSource(row.name, row.source).name;

  const names = new Set(rows.map((r) => famKey(cleanName(r))));

  /** The base a name would vary, by either naming form. */
  const candidates = (raw: unknown): string[] => {
    const name = String(raw ?? "").trim();
    const out: string[] = [];

    // "Elf (High)" — the base is what comes before the qualifier.
    const qualified = /^(.*\S)\s*\([^()]+\)$/.exec(name);
    if (qualified) out.push(qualified[1].trim());

    // "High Elf" — the last word, or the last two. Space-separated
    // only: Half-Elf is one word to this and stays its own species.
    const words = name.split(/\s+/);
    for (const take of [1, 2]) {
      if (words.length <= take) continue;
      out.push(words.slice(words.length - take).join(" "));
    }
    // No self-check needed: a qualified base is always shorter than the
    // name it came from, and the suffix loop skips a take that would
    // swallow the whole name.
    //
    // A candidate that is ENTIRELY a parenthetical is refused outright.
    // cleanName takes the book off first, so this only fires on a
    // suffix splitSource declined to strip — and whatever that is, a
    // species is not called "(Something)".
    return out.filter((c) => c && !/^\(.*\)$/.test(c));
  };

  /**
   * A base is a species this library HAS, or one that two or more
   * rows are named after.
   *
   * The second half is what stops the same trap classes fell into. In
   * a 5e campaign the edition rule drops the 2024 "Elf" while keeping
   * the 2014 High Elf, Wood Elf and Drow Elf — so requiring the base
   * to be present would leave them ungrouped in exactly the case where
   * grouping matters most.
   *
   * TWO, not one. One row ending in a word proves nothing: "Yuan-ti
   * Pureblood" alone would make Pureblood a species. Two rows sharing
   * a trailing name is what a family looks like, and inventing one
   * from that is a much smaller claim than inventing one from a single
   * name's last word.
   */
  const sharing = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const c of candidates(cleanName(row))) {
      const key = famKey(c);
      const seen = sharing.get(key) ?? new Set<string>();
      seen.add(String(row._id));
      sharing.set(key, seen);
    }
  }
  const isBase = (key: string) =>
    names.has(key) || (sharing.get(key)?.size ?? 0) >= 2;

  const baseOf = (raw: unknown): string | null => {
    const cs = candidates(raw).filter((c) => isBase(famKey(c)));
    if (cs.length === 0) return null;

    // MOST SPECIFIC first, with an existing species breaking a tie.
    //
    // Taking the first candidate instead put "Duthka Gith Yanki" under
    // an invented "Yanki" — both rows end in that word, so two rows
    // share it and it qualified — while the real Gith Yanki was left a
    // parent of nothing beside it. Length is what settles that, and it
    // settles the other direction too: where a library has both Elf
    // and Wood Elf, a Grey Wood Elf belongs under the Wood Elf.
    cs.sort(
      (a, b) =>
        b.length - a.length ||
        Number(names.has(famKey(b))) - Number(names.has(famKey(a)))
    );
    return cs[0];
  };

  /**
   * The family a row belongs to, and what that family is called.
   *
   * A row that anything else is NAMED AFTER heads its own family
   * rather than being folded into a grandparent: where a library has
   * Elf, Wood Elf and Grey Wood Elf, the Wood Elf is the Grey Wood
   * Elf's family and not a variant of Elf. A row never names itself —
   * `candidates` drops that — so a non-empty sharing set means
   * somebody ELSE pointed here.
   */
  const family = (row: Record<string, unknown>) => {
    const clean = cleanName(row).trim();
    const own = famKey(clean);
    if ((sharing.get(own)?.size ?? 0) > 0) return { key: own, name: clean };
    const base = baseOf(clean);
    return base ? { key: famKey(base), name: base } : { key: own, name: clean };
  };

  const members = new Map<string, Record<string, unknown>[]>();
  /** The family name as WRITTEN, for the headings we supply. */
  const written = new Map<string, string>();

  for (const row of rows) {
    const { key, name } = family(row);
    const list = members.get(key);
    if (list) list.push(row);
    else members.set(key, [row]);
    // A row whose own name IS the family gets to spell it. Otherwise
    // the heading wears whatever `baseOf` read out of a variant's name,
    // which is right when the base itself is not in the library at all.
    if (famKey(cleanName(row)) === key || !written.has(key)) {
      written.set(key, name);
    }
  }

  const out: Record<string, unknown>[] = [];
  const childrenOf = new Map<string, Record<string, unknown>[]>();

  for (const [key, list] of members) {
    // A family of one is not a family. It is a species, and a heading
    // you have to open to reach the only thing under it is a click
    // that buys nothing.
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }

    const label = written.get(key) ?? key;
    /**
     * The base printings first, then the named variants.
     *
     * "Dragonborn" and "Chromatic Dragonborn" are not the same kind of
     * thing: one is the species as printed and the others are versions
     * of it. Reading the plain printings first is how the list answers
     * "what IS a dragonborn" before it answers "which one".
     */
    list.sort((a, b) => {
      const an = famKey(cleanName(a)) === key ? 0 : 1;
      const bn = famKey(cleanName(b)) === key ? 0 : 1;
      if (an !== bn) return an - bn;
      return variantLabel(label, a).localeCompare(variantLabel(label, b));
    });
    childrenOf.set(key, list);

    /**
     * The heading carries none of the species' own facts, because it
     * IS none of them — every printing is a variant underneath it,
     * including the one that shares its name.
     *
     * That is the change Derek asked for and it is worth being plain
     * about: the head used to be one chosen row, shown in full, with
     * the others hung beneath it. Which meant three rows called
     * Changeling became three separate families, and a Dragonborn
     * showed the PHB write-up as if it were the species rather than
     * one printing of it.
     */
    out.push({
      _id: `${ABSENT_PARENT_ID}${key}`,
      name: label,
      absent: true,
      // Borrowed from underneath, because a heading with no picture in
      // a table of pictures reads as a species nobody drew.
      image: familyImage(list),
    });
  }

  return { rows: out, childrenOf };
}

/**
 * What one member of a family is called, in the list under its family.
 *
 * A variant named after its family — the plain "Dragonborn" under
 * Dragonborn — would otherwise repeat the heading it sits beneath, in a
 * list whose entire job is telling the printings apart. Its BOOK is
 * what distinguishes it, so the book is what it is called.
 */
export function variantLabel(
  family: unknown,
  row: Record<string, unknown>
): string {
  const clean = splitSource(row.name, row.source);
  if (famKey(clean.name) !== famKey(family)) return clean.name;
  // The BOOK, written out: this label is the only thing telling three
  // printings of one species apart, so it is the one place an
  // abbreviation is least use.
  const book = expandSource(clean.source);
  return book ? `${book} version` : "Base version";
}

/** The grouping for a kind, or null for the kinds that are flat. */
export function familyRows(
  kind: LookupKind,
  rows: Record<string, unknown>[]
): FamilyGrouping | null {
  if (kind === "classes") return classRows(rows);
  if (kind === "species") return speciesRows(rows);
  return null;
}

/** What a kind calls its children, where it has any. */
export const FAMILY_LABEL: Partial<Record<LookupKind, string>> = {
  classes: "Subclasses",
  species: "Variants",
};

/**
 * The labelled facts a build entry has that are not its prose.
 *
 * Each one is skipped when absent rather than printed empty: these
 * come out of a Foundry export where a field is as likely to be
 * missing as wrong, and a column of dashes reads as data loss where a
 * shorter list reads as a shorter entry.
 */
export function buildFacts(
  kind: LookupKind,
  row: Record<string, unknown>
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null) => {
    if (value) out.push({ label, value });
  };

  if (kind === "feats") {
    add("Prerequisite", str(row.prerequisite));
    if (row.repeatable === true) add("Repeatable", "Yes");
  }

  if (kind === "backgrounds") {
    add("Ability Scores", str(row.abilities));
    add("Origin Feat", str(row.feat));
    add("Skill Proficiencies", str(row.skills));
    add("Tool Proficiency", str(row.tools));
    add("Equipment", str(row.equipment));
  }

  if (kind === "classes") {
    add("Hit Die", str(row.hitDie));
    add("Primary Ability", str(row.primaryAbility));
    add("Saving Throws", str(row.saves));
    add("Spellcasting", str(row.spellcasting));
    // Only on a subclass. On a class the subtitle already said it, and
    // the column shows the class's own name to make sorting group.
    if (row.isSubclass === true) add("Class", str(row.parentClass));
  }

  if (kind === "species") {
    add("Size", str(row.size));
    add("Speed", str(row.speed));
    add("Creature Type", str(row.creatureType));
    if (typeof row.darkvision === "number" && row.darkvision > 0) {
      add("Darkvision", `${row.darkvision} ft`);
    }
  }

  return out;
}

/**
 * The italic line under an item's name:
 * "Wondrous Item, very rare (requires attunement)".
 *
 * Rarity is lower-cased here even though it is stored capitalised —
 * mid-sentence it reads as prose, not as a label.
 */
export function itemSubtitle(row: Record<string, unknown>): string {
  const kind = ITEM_KIND_LABELS[String(row.kind ?? "")] ?? "Item";
  const rarity = str(row.rarity);
  const head = rarity ? `${kind}, ${rarity.toLowerCase()}` : kind;
  return row.attunement === true ? `${head} (requires attunement)` : head;
}

/** The facts an item has that aren't its prose. */
export function itemFacts(
  row: Record<string, unknown>
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const price = str(row.price);
  if (price) out.push({ label: "Cost", value: price });
  if (typeof row.weight === "number") {
    out.push({ label: "Weight", value: `${row.weight} lb` });
  }
  return out;
}

// ---------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------

/** "150 ft (20 ft Sphere)" — range, and the shape it fills. */
export function spellRangeArea(row: Record<string, unknown>): string | null {
  const range = str(row.range);
  const area = str(row.area);
  if (range && area) return `${range} (${area})`;
  return range ?? area;
}

/** The eight labelled cells above a spell's text, in reading order. */
export function spellCells(
  row: Record<string, unknown>
): { label: string; value: string }[] {
  const level = formatSpellLevel(row.level);
  const cells: { label: string; value: string | null }[] = [
    { label: "Level", value: level },
    { label: "Casting Time", value: str(row.castingTime) },
    { label: "Range/Area", value: spellRangeArea(row) },
    { label: "Components", value: str(row.components) },
    { label: "Duration", value: spellDuration(row) },
    { label: "School", value: str(row.school) },
    { label: "Attack/Save", value: str(row.attackSave) },
    { label: "Damage/Effect", value: str(row.damageEffect) },
  ];
  // A missing cell keeps its slot rather than collapsing the grid — the
  // eight positions are how you find a value without reading the labels.
  return cells.map((c) => ({ label: c.label, value: c.value ?? "—" }));
}

/** Concentration rides on the duration, the way a spell entry prints it. */
export function spellDuration(row: Record<string, unknown>): string | null {
  const duration = str(row.duration);
  if (!duration) return row.concentration === true ? "Concentration" : null;
  return row.concentration === true
    ? `Concentration, ${duration}`
    : duration;
}

// ---------------------------------------------------------------------
// Monsters
// ---------------------------------------------------------------------

/** "Large Giant, Chaotic Neutral" — the italic line under the name. */
export function monsterSubtitle(row: Record<string, unknown>): string {
  const shape = [str(row.size), str(row.creatureType)]
    .filter(Boolean)
    .join(" ");
  const alignment = str(row.alignment);
  if (shape && alignment) return `${shape}, ${alignment}`;
  return shape || alignment || "";
}

/** Challenge, with the XP the stat block prints beside it. */
export function monsterChallenge(row: Record<string, unknown>): string | null {
  const cr = formatCr(row.cr);
  if (!cr) return null;
  return typeof row.xp === "number" && row.xp > 0
    ? `${cr} (${row.xp.toLocaleString("en-US")} XP)`
    : cr;
}

/** The lines between the ability scores and the traits. */
export function monsterTraitLines(
  row: Record<string, unknown>
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null) => {
    if (value) out.push({ label, value });
  };

  add("Skills", str(row.skills));
  add("Senses", str(row.senses));
  add("Languages", str(row.languages));
  add("Challenge", monsterChallenge(row));
  if (typeof row.proficiencyBonus === "number") {
    add("Proficiency Bonus", signed(row.proficiencyBonus));
  }
  return out;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; ordered: boolean; items: string[] };

export interface Feature {
  name: string;
  blocks: Block[];
}

/**
 * Blocks, defended against a row that predates them or arrived
 * malformed. A description is content, not structure the UI can trust:
 * one bad row must render short, never throw and take the screen down.
 */
export function blocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((b): Block[] => {
    if (!b || typeof b !== "object") return [];
    const o = b as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") {
      return o.text.trim() ? [{ type: "text" as const, text: o.text }] : [];
    }
    if (o.type === "table") {
      const rows = Array.isArray(o.rows)
        ? o.rows.filter(Array.isArray).map((r) => r.map((c) => String(c ?? "")))
        : [];
      const headers = Array.isArray(o.headers)
        ? o.headers.map((h) => String(h ?? ""))
        : [];
      return headers.length || rows.length
        ? [{ type: "table" as const, headers, rows }]
        : [];
    }
    if (o.type === "list" && Array.isArray(o.items)) {
      const items = o.items.map((i) => String(i ?? "")).filter(Boolean);
      return items.length
        ? [{ type: "list" as const, ordered: o.ordered === true, items }]
        : [];
    }
    return [];
  });
}

/** Named blocks, defended against a row that never carried any. */
export function features(raw: unknown): Feature[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const name = str((f as Record<string, unknown>).name);
    if (!name) return [];
    return [{ name, blocks: blocks((f as Record<string, unknown>).blocks) }];
  });
}

// ---------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface LookupColumn {
  key: string;
  label: string;
  /** Display text. null prints as an em dash rather than a gap. */
  get: (row: Row) => string | null;
  /**
   * What to show instead, when the column is only this wide.
   *
   * One column needs this and it is not a general feature waiting to
   * happen: a sourcebook has a name and an abbreviation, and which one
   * belongs in the cell is a question about the cell rather than about
   * the book. Absent everywhere else, where `get` is the answer at any
   * width.
   */
  fit?: (row: Row, widthPx: number | null) => string | null;
  /**
   * What this column sorts on. Absent means "sort by what it shows",
   * which is right for text and wrong for anything whose display form
   * is not its order — a CR of "1/4" sorts between "1/8" and "1/2" only
   * as a number.
   */
  sort?: (row: Row) => number | string;
  /** A CSS grid track. */
  width: string;
  /** The name column: bigger, and carries the source underneath. */
  primary?: boolean;
  align?: "center";
}

const RARITY_ORDER = [
  "Common",
  "Uncommon",
  "Rare",
  "Very Rare",
  "Legendary",
  "Artifact",
];

/** Sorts last rather than first — unknown is not the same as lowest. */
const LAST = Number.POSITIVE_INFINITY;

/**
 * A trailing "(XGtE)" on a name is a SOURCE, not part of the name.
 *
 * Foundry compendiums disambiguate by suffix — "Arcane Archer (XGtE)",
 * "Arcana Domain (SCAG)" — which reads fine in a compendium browser
 * and badly in a table that has a Source column beside it, where the
 * same four letters then appear twice on every row.
 *
 * Done HERE rather than in the importer, deliberately. The suffix is
 * genuinely part of what Foundry calls the document, so rewriting it
 * at rest would be editing the source data to suit one screen — and
 * doing it at read time means it works on the rows already imported
 * rather than only after the next re-import.
 *
 * Two cases, and nothing else is touched:
 *
 *   the parenthetical IS the row's source   -> strip it, it is said twice
 *   there is no source, and it looks like   -> strip it, and it becomes
 *   a book abbreviation                        the source
 *
 * A parenthetical that disagrees with the source is left alone. "Bag
 * of Holding (Greater)" is not a book, and guessing which is which is
 * how a name gets quietly truncated.
 */
export function splitSource(
  name: unknown,
  source: unknown
): { name: string; source: string | null } {
  const raw = typeof name === "string" ? name.trim() : "";
  const src = typeof source === "string" ? source.trim() : "";
  const fallback = { name: raw, source: src || null };

  const m = /^(.*\S)\s*\(([^()]{2,12})\)$/.exec(raw);
  if (!m) return fallback;

  const base = m[1].trim();
  const paren = m[2].trim();
  if (!base) return fallback;

  const same = (a: string, b: string) =>
    a.toLowerCase().replace(/\s+/g, " ") === b.toLowerCase().replace(/\s+/g, " ");

  if (src) {
    return same(paren, src) ? { name: base, source: src } : fallback;
  }

  // No source to compare against. A book abbreviation is short, has no
  // spaces, and carries more than one capital — which "Greater" and
  // "Cantrip" do not, and "XGtE", "SCAG" and "BGDiA" all do.
  const looksLikeBook =
    /^[A-Za-z0-9'’.:+-]{2,10}$/.test(paren) &&
    (paren.match(/[A-Z]/g) ?? []).length >= 2;

  return looksLikeBook ? { name: base, source: paren } : fallback;
}

/**
 * The Name column's default width, from what is actually in it.
 *
 * It was `minmax(11rem, 2fr)` — grow to fill — which on a wide screen
 * put half the viewport between a spell's name and its level. Reported
 * as exactly that. The declared width is now only the floor; the
 * default the table renders comes from this, measured over the list.
 *
 * The arithmetic mirrors sourceLabel's: the same estimated char width,
 * nudged up for the name cell's semibold. EXTRAS is the rest of what
 * lives in a primary cell — the 2rem artwork and its gap, the variant
 * count pill, the cell's own padding — and PAD is the "a little
 * bigger" that was asked for, so the longest name is not flush against
 * the next column.
 *
 * Capped, because one 70-character name in an import should not push
 * every other column off screen for the whole table. Past the cap the
 * one long row ellipsises, which is what long cells do everywhere else
 * here, and a dragged column still overrides all of this.
 */
const NAME_CHAR_PX = 7.7;
const NAME_EXTRAS_PX = 66;
const NAME_PAD_PX = 18;
const NAME_MIN_PX = 176; // the old 11rem floor
const NAME_MAX_PX = 480; // 30rem

export function nameTrackPx(names: readonly string[]): number {
  const longest = names.reduce((max, n) => Math.max(max, n.length), 0);
  const want = Math.round(
    longest * NAME_CHAR_PX + NAME_EXTRAS_PX + NAME_PAD_PX
  );
  return Math.max(NAME_MIN_PX, Math.min(NAME_MAX_PX, want));
}

const NAME_COLUMN: LookupColumn = {
  key: "name",
  label: "Name",
  /**
   * The FLOOR, not the default: LookupTool passes a measured width for
   * this column into columnTemplate, computed by nameTrackPx from the
   * names on the tab. This track only renders if that stops happening
   * — in which case an 11rem column that ellipsises long names is the
   * failure you can see, and grow-to-fill was the one nobody reported
   * for weeks.
   */
  width: "11rem",
  primary: true,
  get: (r) => splitSource(r.name, r.source).name,
  // Sorted on the CLEAN name, so "Arcane Archer (XGtE)" files under A
  // for Arcane rather than wherever the suffix happens to put it.
  sort: (r) => splitSource(r.name, r.source).name.toLowerCase(),
};

/**
 * Which book an entry came from, as a column of its own.
 *
 * It used to be a grey sub-line under the name, which made it
 * unsortable, unfilterable, and part of the widest column on the
 * screen. Every kind gets the same one, appended last.
 */
export const SOURCE_COLUMN: LookupColumn = {
  key: "source",
  label: "Source",
  /**
   * Much wider than it was, because it holds a book's name rather than
   * a four-letter code.
   *
   * MEASURED, and wide enough for EVERY book in the map.
   *
   * It was 16rem, then 18rem, each time chosen to fit the books that
   * had just been added — and each time a later book was added that
   * did not fit, so it went in the map, changed nothing on screen, and
   * had to be noticed by looking at the table. Adding a book should be
   * the whole job.
   *
   * So the number comes from the longest title there is: Phandelver
   * and Below: The Shattered Obelisk, 20.76rem by the width estimate.
   * A unit test recomputes that over SOURCE_NAMES and fails naming the
   * book that no longer fits, which is the only way this stays true.
   *
   * The fallback has not gone anywhere — it fires when the column is
   * dragged NARROWER, which is what it was for.
   */
  width: "21rem",
  get: (r) => expandSource(splitSource(r.name, r.source).source),
  // ...unless it has been dragged narrower than the name, in which
  // case the abbreviation is the more useful of the two.
  fit: (r, widthPx) =>
    sourceLabel(splitSource(r.name, r.source).source, widthPx),
  // Sorted on what it SHOWS, or a column of book names would come back
  // in the order of codes nobody can see. Blank last, like every other
  // mostly-empty column here.
  sort: (r) =>
    expandSource(splitSource(r.name, r.source).source).toLowerCase() || "￿",
};

/**
 * Every kind ends with SOURCE_COLUMN.
 *
 * Appended per kind rather than spliced in by the renderer, so the
 * column is reorderable and resizable like any other — it is a column,
 * not a decoration, and the layout code should not have to know that
 * one of them is special.
 */
export const LOOKUP_COLUMNS: Record<LookupKind, LookupColumn[]> = {
  monsters: [
    {
      key: "cr",
      label: "CR",
      width: "4.5rem",
      align: "center",
      get: (r) => formatCr(r.cr),
      sort: (r) => (typeof r.cr === "number" ? r.cr : LAST),
    },
    NAME_COLUMN,
    { key: "creatureType", label: "Type", width: "8rem", get: (r) => str(r.creatureType) },
    { key: "size", label: "Size", width: "7rem", get: (r) => str(r.size) },
    { key: "alignment", label: "Alignment", width: "9rem", get: (r) => str(r.alignment) },
    { key: "habitat", label: "Habitat", width: "10rem", get: (r) => str(r.habitat) },
    { key: "hp", label: "HP", width: "4.5rem", align: "center", get: (r) => str(r.hp), sort: (r) => (typeof r.hp === "number" ? r.hp : LAST) },
    { key: "ac", label: "AC", width: "4.5rem", align: "center", get: (r) => str(r.ac), sort: (r) => (typeof r.ac === "number" ? r.ac : LAST) },
    SOURCE_COLUMN,
  ],
  spells: [
    {
      key: "level",
      label: "Level",
      width: "5rem",
      align: "center",
      get: (r) => formatSpellLevel(r.level),
      sort: (r) => (typeof r.level === "number" ? r.level : LAST),
    },
    NAME_COLUMN,
    { key: "school", label: "School", width: "9rem", get: (r) => str(r.school) },
    { key: "castingTime", label: "Casting Time", width: "8rem", get: (r) => str(r.castingTime) },
    { key: "range", label: "Range/Area", width: "10rem", get: (r) => spellRangeArea(r) },
    { key: "components", label: "Components", width: "7rem", get: (r) => str(r.components) },
    { key: "duration", label: "Duration", width: "9rem", get: (r) => spellDuration(r) },
    SOURCE_COLUMN,
  ],
  items: [
    NAME_COLUMN,
    {
      key: "kind",
      label: "Category",
      width: "9rem",
      get: (r) => ITEM_KIND_LABELS[String(r.kind ?? "")] ?? str(r.kind),
    },
    {
      key: "rarity",
      label: "Rarity",
      width: "8rem",
      get: (r) => str(r.rarity),
      sort: (r) => {
        const i = RARITY_ORDER.indexOf(String(r.rarity ?? ""));
        return i === -1 ? LAST : i;
      },
    },
    {
      key: "attunement",
      label: "Attune",
      width: "5.5rem",
      align: "center",
      get: (r) => (r.attunement === true ? "Yes" : null),
      sort: (r) => (r.attunement === true ? 0 : 1),
    },
    { key: "price", label: "Cost", width: "7rem", get: (r) => str(r.price) },
    {
      key: "weight",
      label: "Weight",
      width: "6rem",
      align: "center",
      get: (r) => (typeof r.weight === "number" ? `${r.weight} lb` : null),
      sort: (r) => (typeof r.weight === "number" ? r.weight : LAST),
    },
    SOURCE_COLUMN,
  ],
  feats: [
    NAME_COLUMN,
    { key: "category", label: "Category", width: "9rem", get: (r) => str(r.category) },
    {
      key: "prerequisite",
      label: "Prerequisite",
      width: "minmax(10rem, 1.5fr)",
      get: (r) => str(r.prerequisite),
      // Blank sorts LAST rather than first. "No prerequisite" is the
      // common case, and putting two hundred blanks above the fifteen
      // rows you sorted this column to find is the opposite of what
      // the click asked for.
      sort: (r) => str(r.prerequisite) ?? "￿",
    },
    {
      key: "repeatable",
      label: "Repeat",
      width: "5.5rem",
      align: "center",
      get: (r) => (r.repeatable === true ? "Yes" : null),
      sort: (r) => (r.repeatable === true ? 0 : 1),
    },
    SOURCE_COLUMN,
  ],
  backgrounds: [
    NAME_COLUMN,
    { key: "abilities", label: "Abilities", width: "8rem", get: (r) => str(r.abilities) },
    { key: "feat", label: "Origin Feat", width: "10rem", get: (r) => str(r.feat) },
    { key: "skills", label: "Skills", width: "minmax(10rem, 1.4fr)", get: (r) => str(r.skills) },
    { key: "tools", label: "Tool", width: "9rem", get: (r) => str(r.tools) },
    SOURCE_COLUMN,
  ],
  // No "Class" column. It existed to answer "which class does this
  // belong to" back when the tab was a flat list and sorting on it was
  // the only way to get a class next to its own subclasses. The tab
  // groups structurally now — a subclass is only ever reachable by
  // opening the class it sits under — so the column repeated the
  // heading directly above it, and on a base class it repeated the
  // name in the very next cell.
  classes: [
    NAME_COLUMN,
    {
      key: "isSubclass",
      label: "Kind",
      width: "6.5rem",
      get: (r) => (r.isSubclass === true ? "Subclass" : "Class"),
      sort: (r) => (r.isSubclass === true ? 1 : 0),
    },
    { key: "hitDie", label: "Hit Die", width: "5.5rem", align: "center", get: (r) => str(r.hitDie) },
    { key: "primaryAbility", label: "Primary", width: "7rem", get: (r) => str(r.primaryAbility) },
    { key: "saves", label: "Saves", width: "7rem", get: (r) => str(r.saves) },
    {
      key: "spellcasting",
      label: "Casting",
      width: "6.5rem",
      get: (r) => str(r.spellcasting),
      sort: (r) => str(r.spellcasting) ?? "￿",
    },
    SOURCE_COLUMN,
  ],
  species: [
    NAME_COLUMN,
    { key: "size", label: "Size", width: "7rem", get: (r) => str(r.size) },
    {
      key: "speed",
      label: "Speed",
      width: "6.5rem",
      get: (r) => str(r.speed),
      // Sorted on the number in it, so 100 ft does not land between
      // 10 ft and 20 ft the way a string comparison puts it.
      sort: (r) => {
        const m = /(\d+)/.exec(String(r.speed ?? ""));
        return m ? Number(m[1]) : LAST;
      },
    },
    {
      key: "darkvision",
      label: "Darkvision",
      width: "7.5rem",
      align: "center",
      get: (r) =>
        typeof r.darkvision === "number" && r.darkvision > 0
          ? `${r.darkvision} ft`
          : null,
      sort: (r) => (typeof r.darkvision === "number" ? r.darkvision : LAST),
    },
    { key: "creatureType", label: "Type", width: "8rem", get: (r) => str(r.creatureType) },
    SOURCE_COLUMN,
  ],
};

/**
 * Narrower than this and a column is a sliver you cannot aim the mouse
 * at to widen again. Dragged past it, it stops.
 */
export const MIN_LOOKUP_COL = 56;

/**
 * The expand button's track, at the head of every row.
 *
 * 34px is NpcTable's EXPAND_COL. The two lists sit under the same
 * sidebar and now open the same way, so a different width here would
 * be a difference between them that nothing means — the integrity
 * guard holds the two numbers together.
 */
export const EXPAND_TRACK = "34px";

/**
 * Where a row's artwork is fetched from.
 *
 * `image` is a mirror-relative path — "web/foundry/icons/..." — and the
 * base is NEXT_PUBLIC_MAP_SERVER when there is one. With no map server
 * configured this returns a ROOT-RELATIVE url instead of nothing, so
 * the app can serve the same mirror out of public/ and the paths stay
 * identical either way. Standing up the map server later is then a
 * change to one environment variable rather than to the stored data.
 *
 * A file that is not there fails the same way in both cases, and the
 * <img> hides itself on error rather than showing a broken-image icon
 * on every row.
 */
export function artSrc(image: unknown, mapServer: string | undefined): string | null {
  if (typeof image !== "string" || image.trim() === "") return null;
  // A trailing slash on the env var would otherwise produce "//web/...",
  // which is a PROTOCOL-RELATIVE url — the browser reads "web" as a
  // hostname and leaves the app entirely.
  const base = (mapServer ?? "").replace(/\/+$/, "");
  return `${base}/${image.replace(/^\/+/, "")}`;
}

/**
 * The grid template a kind's header and rows both use.
 *
 * `widths` are the pixel widths someone has dragged a column to. A
 * column with no entry keeps its declared track, so the table an
 * untouched account sees is the designed one and a resize is a
 * per-column override rather than a whole layout.
 */
export function columnTemplate(
  kind: LookupKind,
  widths?: Record<string, number> | null
): string {
  const tracks = LOOKUP_COLUMNS[kind].map((c) => {
    const w = widths?.[c.key];
    return typeof w === "number" && Number.isFinite(w)
      ? `${Math.max(MIN_LOOKUP_COL, Math.round(w))}px`
      : c.width;
  });

  // The expand button LEADS the row, in the same fixed track the NPC
  // list uses, so a row opens from the place your eye already is
  // rather than from the far side of the screen.
  //
  // Which leaves the slack to a track of its own at the end. The name
  // column is normally `2fr` and soaks up whatever is left over, but
  // dragging every column to a pixel width leaves nothing that flexes,
  // and the columns would then bunch at the left of a table with a
  // band of dead space beside them. The filler is a track either way,
  // present but zero, because the header and the rows are separate
  // grids that line up only by being handed the same template — a
  // track that appears and disappears would slide every column out
  // from under its heading at the width where it changed.
  const filler = tracks.some((t) => t.includes("fr")) ? "0" : "minmax(0, 1fr)";

  return `${EXPAND_TRACK} ${tracks.join(" ")} ${filler}`;
}

/**
 * Sort by a column, ascending or descending.
 *
 * Name is always the tiebreak, so two monsters at CR 8 keep a stable,
 * meaningful order rather than whatever the table happened to return.
 */
export function sortByColumn(
  kind: LookupKind,
  rows: Row[],
  key: string,
  descending: boolean
): Row[] {
  const col = LOOKUP_COLUMNS[kind].find((c) => c.key === key);
  const name = (r: Row) => String(r.name ?? "").toLowerCase();
  const of = (r: Row) => {
    if (!col) return name(r);
    if (col.sort) return col.sort(r);
    return (col.get(r) ?? "").toLowerCase();
  };

  const dir = descending ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = of(a);
    const y = of(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return name(a).localeCompare(name(b));
  });
}
