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

export type LookupKind = "spells" | "items" | "monsters";

export const LOOKUP_TITLES: Record<LookupKind, string> = {
  spells: "Spells",
  items: "Items",
  monsters: "Monsters",
};

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

export interface Feature {
  name: string;
  text: string;
}

/** Named blocks, defended against a row that never carried any. */
export function features(raw: unknown): Feature[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const name = str((f as Record<string, unknown>).name);
    if (!name) return [];
    return [{ name, text: str((f as Record<string, unknown>).text) ?? "" }];
  });
}

// ---------------------------------------------------------------------
// The results list
// ---------------------------------------------------------------------

/** The one line under a name in the results list. */
export function lookupSubtitle(
  kind: LookupKind,
  row: Record<string, unknown>
): string {
  if (kind === "spells") {
    const level = formatSpellLevel(row.level);
    return [level === "Cantrip" ? level : level && `Level ${level}`, str(row.school)]
      .filter(Boolean)
      .join(" · ");
  }
  if (kind === "items") return itemSubtitle(row);

  const cr = formatCr(row.cr);
  return [monsterSubtitle(row) || null, cr && `CR ${cr}`]
    .filter(Boolean)
    .join(" · ");
}
