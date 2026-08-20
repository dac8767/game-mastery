/**
 * What each kind of Lookup entry shows, and how it reads.
 *
 * Pure and dependency-free so the unit guard can exercise the
 * formatting: challenge ratings and spell levels are both small
 * integers that mean something other than themselves, and getting
 * either wrong is the sort of thing you only notice at the table.
 */

export type LookupKind = "spells" | "items" | "monsters";

export interface LookupField {
  label: string;
  /** Absent from the panel when this returns null. */
  get: (row: Record<string, unknown>) => string | null;
}

const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
};

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
  return `${level}${suffix} level`;
}

/** "STR 18 · DEX 12 · …", skipping any the import didn't carry. */
export function formatAbilities(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const parts = (["str", "dex", "con", "int", "wis", "cha"] as const)
    .map((k) => (typeof a[k] === "number" ? `${k.toUpperCase()} ${a[k]}` : null))
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const LOOKUP_FIELDS: Record<LookupKind, LookupField[]> = {
  spells: [
    { label: "Level", get: (r) => formatSpellLevel(r.level) },
    { label: "School", get: (r) => str(r.school) },
    { label: "Casting time", get: (r) => str(r.castingTime) },
    { label: "Range", get: (r) => str(r.range) },
    { label: "Components", get: (r) => str(r.components) },
    { label: "Materials", get: (r) => str(r.materials) },
    { label: "Duration", get: (r) => str(r.duration) },
    { label: "Ritual", get: (r) => (r.ritual === true ? "Yes" : null) },
    {
      label: "Concentration",
      get: (r) => (r.concentration === true ? "Yes" : null),
    },
    { label: "Source", get: (r) => str(r.source) },
  ],
  items: [
    { label: "Kind", get: (r) => str(r.kind) },
    { label: "Rarity", get: (r) => str(r.rarity) },
    { label: "Price", get: (r) => str(r.price) },
    {
      label: "Weight",
      get: (r) => (typeof r.weight === "number" ? `${r.weight} lb` : null),
    },
    {
      label: "Attunement",
      get: (r) => (r.attunement === true ? "Required" : null),
    },
    { label: "Source", get: (r) => str(r.source) },
  ],
  monsters: [
    { label: "Size", get: (r) => str(r.size) },
    { label: "Type", get: (r) => str(r.creatureType) },
    { label: "Alignment", get: (r) => str(r.alignment) },
    { label: "CR", get: (r) => formatCr(r.cr) },
    { label: "AC", get: (r) => str(r.ac) },
    { label: "HP", get: (r) => str(r.hp) },
    { label: "Speed", get: (r) => str(r.speed) },
    { label: "Abilities", get: (r) => formatAbilities(r.abilities) },
    { label: "Source", get: (r) => str(r.source) },
  ],
};

/** The one line under a name in the results list. */
export function lookupSubtitle(
  kind: LookupKind,
  row: Record<string, unknown>
): string {
  if (kind === "spells") {
    return [formatSpellLevel(row.level), str(row.school)]
      .filter(Boolean)
      .join(" · ");
  }
  if (kind === "items") {
    return [str(row.kind), str(row.rarity)].filter(Boolean).join(" · ");
  }
  return [str(row.size), str(row.creatureType), formatCr(row.cr) && `CR ${formatCr(row.cr)}`]
    .filter(Boolean)
    .join(" · ");
}

export const LOOKUP_TITLES: Record<LookupKind, string> = {
  spells: "Spells",
  items: "Items",
  monsters: "Monsters",
};
