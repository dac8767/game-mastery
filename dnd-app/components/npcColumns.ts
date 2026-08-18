/**
 * One description of every NPC column, used by the grid, the column
 * picker, and the record editor.
 *
 * Keeping it in a single list is what makes "show any column, in any
 * order, at any width" cheap: the table renders whatever the person's
 * saved layout says, and anything not in their layout falls back to the
 * defaults here. The `integrity` guard checks every `key` below against
 * what npcs.listForCampaign actually returns, so a renamed field can't
 * silently become a column of blanks.
 */

export type FieldKind =
  | "text" // short free text
  | "longtext" // prose — edited in a textarea
  | "number"
  | "chips" // string array, entered comma-separated
  | "boolean"
  | "picture";

export type ColumnDef = {
  key: string;
  label: string;
  /**
   * How the value is STORED — this drives editing and filtering.
   * `chips` means a real string array; a scalar that merely *renders*
   * as a pill is `text` with `chip: true`. Conflating the two sends an
   * array into a string field and the mutation rejects it.
   */
  kind: FieldKind;
  /** Render as a pill even though the value is a scalar. */
  chip?: boolean;
  defaultWidth: number;
  defaultVisible: boolean;
  /** Never offered to players; the server sends null for these. */
  dmOnly?: boolean;
  /** Not a real field — nothing to sort or edit. */
  sortable?: boolean;
  editable?: boolean;
  /** The one field any campaign member may write. */
  playerEditable?: boolean;
};

export const COLUMNS: ColumnDef[] = [
  {
    key: "portraitPath",
    label: "Picture",
    kind: "picture",
    defaultWidth: 76,
    defaultVisible: true,
    sortable: false,
    editable: true,
  },
  { key: "name", label: "Name", kind: "text", defaultWidth: 180, defaultVisible: true, editable: true },
  { key: "job", label: "Job", kind: "text", chip: true, defaultWidth: 140, defaultVisible: true, editable: true },
  { key: "age", label: "Age", kind: "number", defaultWidth: 70, defaultVisible: true, editable: true },
  { key: "gender", label: "Gender", kind: "text", chip: true, defaultWidth: 110, defaultVisible: true, editable: true },
  { key: "species", label: "Species", kind: "text", chip: true, defaultWidth: 120, defaultVisible: true, editable: true },
  { key: "lineage", label: "Lineage", kind: "text", defaultWidth: 100, defaultVisible: true, editable: true },
  { key: "sexuality", label: "Sexuality", kind: "text", defaultWidth: 110, defaultVisible: true, editable: true },
  {
    key: "familyMembers",
    label: "Family Members",
    kind: "chips",
    defaultWidth: 200,
    defaultVisible: true,
    editable: true,
  },
  { key: "groups", label: "Groups", kind: "chips", defaultWidth: 170, defaultVisible: true, editable: true },
  { key: "place", label: "Place", kind: "chips", defaultWidth: 150, defaultVisible: true, editable: true },
  { key: "status", label: "Status", kind: "chips", defaultWidth: 140, defaultVisible: true, editable: true },
  {
    key: "playerNotes",
    label: "Player Notes",
    kind: "longtext",
    defaultWidth: 220,
    defaultVisible: true,
    editable: true,
    playerEditable: true,
  },

  // Available but off by default — pick them in the Columns panel.
  { key: "nickname", label: "Nickname", kind: "text", defaultWidth: 140, defaultVisible: false, editable: true },
  { key: "prefix", label: "Prefix", kind: "text", defaultWidth: 90, defaultVisible: false, editable: true },
  { key: "first", label: "First", kind: "text", defaultWidth: 120, defaultVisible: false, editable: true },
  { key: "middle", label: "Middle", kind: "text", defaultWidth: 120, defaultVisible: false, editable: true },
  { key: "family", label: "Family", kind: "text", defaultWidth: 130, defaultVisible: false, editable: true },
  { key: "suffix", label: "Suffix", kind: "text", defaultWidth: 90, defaultVisible: false, editable: true },
  { key: "maturity", label: "Maturity", kind: "text", defaultWidth: 120, defaultVisible: false, editable: true },
  { key: "startingAge", label: "Starting Age", kind: "number", defaultWidth: 110, defaultVisible: false, editable: true },
  { key: "maxAge", label: "Max Age", kind: "number", defaultWidth: 100, defaultVisible: false, editable: true },
  {
    key: "familyMemberCount",
    label: "Family Size",
    kind: "number",
    defaultWidth: 100,
    defaultVisible: false,
    editable: true,
  },
  { key: "region", label: "Region", kind: "text", defaultWidth: 130, defaultVisible: false, editable: true },
  { key: "kingdom", label: "Kingdom", kind: "text", defaultWidth: 130, defaultVisible: false, editable: true },
  { key: "alignment", label: "Alignment", kind: "text", defaultWidth: 120, defaultVisible: false, editable: true },
  { key: "voice", label: "Voice", kind: "text", defaultWidth: 140, defaultVisible: false, editable: true },
  {
    key: "description",
    label: "Description",
    kind: "longtext",
    defaultWidth: 260,
    defaultVisible: false,
    editable: true,
  },
  { key: "quirkMental", label: "Quirk — Mental", kind: "longtext", defaultWidth: 200, defaultVisible: false, editable: true },
  {
    key: "quirkPhysical",
    label: "Quirk — Physical",
    kind: "longtext",
    defaultWidth: 200,
    defaultVisible: false,
    editable: true,
  },
  { key: "politics", label: "Politics", kind: "longtext", defaultWidth: 190, defaultVisible: false, editable: true },
  { key: "abilities", label: "Abilities", kind: "longtext", defaultWidth: 190, defaultVisible: false, editable: true },
  { key: "wantsNeeds", label: "Wants & Needs", kind: "longtext", defaultWidth: 190, defaultVisible: false, editable: true },
  { key: "noLastName", label: "No Last Name", kind: "boolean", defaultWidth: 110, defaultVisible: false, editable: true },

  // DM-only. Never offered to a player, and the server sends null for
  // them regardless of what a player's saved layout asks for.
  { key: "hidden", label: "Hidden", kind: "boolean", defaultWidth: 90, defaultVisible: false, dmOnly: true, editable: true },
  { key: "secret", label: "Secret", kind: "longtext", defaultWidth: 200, defaultVisible: false, dmOnly: true, editable: true },
  { key: "dmNotes", label: "DM Notes", kind: "longtext", defaultWidth: 200, defaultVisible: false, dmOnly: true, editable: true },
];

export const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** Fields offered as filters and as "group by" options. */
export const FACET_KEYS = [
  "status",
  "species",
  "groups",
  "place",
  "job",
  "maturity",
  "gender",
  "lineage",
  "region",
  "kingdom",
  "alignment",
  "sexuality",
];

/** The three facets promoted to always-visible dropdowns. */
export const QUICK_FILTER_KEYS = ["status", "species", "gender"];

/** Sort keys that aren't columns. */
export const EXTRA_SORTS = [
  { key: "_creationTime", label: "Date added" },
];

/** Life stages sort in narrative order, not alphabetically. */
export const MATURITY_ORDER = ["Child", "Young Adult", "Adult", "Senior"];

export type ColumnState = { key: string; width: number; visible: boolean };

/** The layout someone sees before they've customized anything. */
export function defaultColumnState(isDm: boolean): ColumnState[] {
  return COLUMNS.filter((c) => isDm || !c.dmOnly).map((c) => ({
    key: c.key,
    width: c.defaultWidth,
    visible: c.defaultVisible,
  }));
}

/**
 * Reconcile a saved layout against the current column set: drop entries
 * for columns that no longer exist, append ones added since, and strip
 * DM-only columns for players even if their saved layout names them.
 */
export function reconcileColumns(
  saved: ColumnState[] | null,
  isDm: boolean
): ColumnState[] {
  const allowed = COLUMNS.filter((c) => isDm || !c.dmOnly);
  if (!saved || saved.length === 0) return defaultColumnState(isDm);

  const savedByKey = new Map(saved.map((c) => [c.key, c]));
  const out: ColumnState[] = [];

  // Saved order first, skipping anything stale or not permitted.
  for (const s of saved) {
    const def = COLUMN_BY_KEY.get(s.key);
    if (!def) continue;
    if (def.dmOnly && !isDm) continue;
    out.push({
      key: s.key,
      width: Math.max(48, s.width),
      visible: s.visible,
    });
  }

  // Then anything the app has gained since this layout was saved.
  for (const def of allowed) {
    if (!savedByKey.has(def.key)) {
      out.push({
        key: def.key,
        width: def.defaultWidth,
        visible: def.defaultVisible,
      });
    }
  }

  return out;
}

/**
 * Which image to show for an NPC.
 *
 * An uploaded portrait wins; the imported map-server path is the
 * fallback for NPCs whose picture came across from Airtable as a
 * filename. One function so the grid, the tiles, and the record drawer
 * can never disagree about which one is current.
 */
export function portraitSrc(
  portraitUrl: string | null | undefined,
  portraitPath: string | null | undefined,
  mapServer: string
): string | null {
  if (portraitUrl) return portraitUrl;
  if (portraitPath && mapServer) return `${mapServer}/${portraitPath}`;
  return null;
}
