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

const NAME_COLUMN: LookupColumn = {
  key: "name",
  label: "Name",
  width: "minmax(11rem, 2fr)",
  primary: true,
  get: (r) => str(r.name),
};

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
  ],
};

/**
 * Narrower than this and a column is a sliver you cannot aim the mouse
 * at to widen again. Dragged past it, it stops.
 */
export const MIN_LOOKUP_COL = 56;

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

  // The trailing track is the expand/collapse button. It absorbs the
  // slack once nothing else can: the name column is normally `2fr` and
  // soaks up the leftover width, but pinning it to pixels leaves every
  // track fixed, and the row would then stop short of the table's right
  // edge with the button stranded in the middle of it. The button is
  // `justify-self: end`, so widening its track keeps it against the
  // edge where it belongs.
  const button = tracks.some((t) => t.includes("fr"))
    ? "2.25rem"
    : "minmax(2.25rem, 1fr)";

  return `${tracks.join(" ")} ${button}`;
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
