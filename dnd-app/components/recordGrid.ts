/**
 * What a record list does to a row before drawing it.
 *
 * Every function here addresses fields by STRING KEY through a
 * Record<string, unknown>, which is exactly why they are worth having
 * in one place: TypeScript cannot see across a string key, so a bug in
 * any of them is a screen full of blanks rather than a compile error,
 * and one copy per screen would be one bug per screen.
 *
 * None of them know what an NPC is. That is the point — the Groups
 * screen is the same table over different fields, and it gets the same
 * blanks-sort-last, chips-and-scalars, search-every-column behaviour by
 * calling the same functions rather than by having them reimplemented
 * faithfully enough.
 *
 * Free of React and Convex so the unit guard can compile it alone.
 */

/** Bucket label for rows with no value in a faceted field. */
export const EMPTY = "—";

/** Placeholder shown in a blank grid cell. */
export const BLANK = "–";

export type Row = Record<string, unknown>;

export function cell(row: Row, key: string): unknown {
  return row[key];
}

/**
 * A field's values as a list, for faceting and grouping.
 *
 * A row with nothing in the field is not dropped — it lands in the
 * EMPTY bucket, so "group by Species" still accounts for everybody
 * rather than quietly shortening the list.
 */
export function facetValues(row: Row, key: string): string[] {
  const raw = cell(row, key);
  if (Array.isArray(raw)) {
    const vals = (raw as string[]).filter((v) => v && v.trim());
    return vals.length > 0 ? vals : [EMPTY];
  }
  if (typeof raw === "string" && raw.trim()) return [raw];
  return [EMPTY];
}

/** The same, minus the placeholder — what a cell draws as pills. */
export function chipValues(row: Row, key: string): string[] {
  return facetValues(row, key).filter((v) => v !== EMPTY);
}

export function display(
  row: Row,
  key: string,
  format?: (raw: unknown) => string
): string {
  const raw = cell(row, key);
  if (Array.isArray(raw)) return (raw as string[]).join(", ");
  if (raw === null || raw === undefined || raw === "") return "";
  // AFTER the blank test, so a column that formats does not put a word
  // in front of nothing — "Session " on a row with no number reads as
  // data rather than as the gap it is.
  if (format) return format(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  return String(raw);
}

/**
 * Everything on a row, lower-cased, for the search box.
 *
 * Built from the column list rather than from the row's own keys, so a
 * field the table does not show is not silently searchable — searching
 * for a word and landing on a row that does not contain it anywhere you
 * can see is worse than not finding it.
 */
export function searchText(
  row: Row,
  columns: { key: string; format?: (raw: unknown) => string }[]
): string {
  const parts: string[] = [];
  for (const col of columns) {
    const raw = cell(row, col.key);
    if (Array.isArray(raw)) parts.push(...(raw as string[]));
    else if (typeof raw === "string") parts.push(raw);
    else if (typeof raw === "number") parts.push(String(raw));
    // A formatted column is searchable BOTH ways: the stored value is
    // already in, and the words the cell actually shows go in beside
    // it. Searching for what is on screen and not finding it is the
    // failure worth avoiding here.
    if (col.format && raw !== null && raw !== undefined && raw !== "") {
      parts.push(col.format(raw));
    }
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** Whether a field is empty for the purposes of sorting. */
function isBlank(row: Row, key: string): boolean {
  const v = cell(row, key);
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/**
 * Compare two rows on one field, ASCENDING, blanks last.
 *
 * Note what this alone cannot promise. Reversing a sort by negating a
 * comparator reverses everything in it, blanks included — which is
 * exactly what both grids used to do, and why sorting Age descending
 * put every NPC with no age on top of the oldest ones. The emptiness
 * test has to sit OUTSIDE the negation, so `sortRows` is what screens
 * call and this is the piece it uses in the middle.
 *
 * `ranks` maps a key to an ordering that is not alphabetical — life
 * stages run Child → Senior, not Adult → Young Adult.
 */
export function compare(
  a: Row,
  b: Row,
  key: string,
  ranks?: Record<string, string[]>
): number {
  const order = ranks?.[key];
  if (order) {
    const rank = (row: Row) => {
      const i = order.indexOf(String(cell(row, key) ?? ""));
      return i === -1 ? order.length : i;
    };
    return rank(a) - rank(b);
  }

  const av = cell(a, key);
  const bv = cell(b, key);

  const aEmpty = isBlank(a, key);
  const bEmpty = isBlank(b, key);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof av === "number" && typeof bv === "number") return av - bv;

  const as = Array.isArray(av) ? (av as string[]).join(", ") : String(av);
  const bs = Array.isArray(bv) ? (bv as string[]).join(", ") : String(bv);
  return as.localeCompare(bs, undefined, { sensitivity: "base" });
}

/**
 * The rows in order, blanks last WHICHEVER WAY the sort runs.
 *
 * Sorting a mostly-empty column means "show me the ones that have
 * something", in both directions — clicking the heading a second time
 * is asking for the other end of the answer, not for the two hundred
 * rows that had no answer at all.
 *
 * A named rank counts as having a value only if the value is IN the
 * rank: a maturity nobody recognises is as blank as no maturity, and
 * it sinks with the rest rather than bobbing to the top on the way
 * back.
 */
export function sortRows<T extends Row>(
  rows: T[],
  key: string,
  asc: boolean,
  ranks?: Record<string, string[]>
): T[] {
  const order = ranks?.[key];
  const blank = (row: T) =>
    order
      ? order.indexOf(String(cell(row, key) ?? "")) === -1
      : isBlank(row, key);

  return [...rows].sort((a, b) => {
    const ab = blank(a);
    const bb = blank(b);
    if (ab && bb) return 0;
    if (ab) return 1;
    if (bb) return -1;
    const c = compare(a, b, key, ranks);
    return asc ? c : -c;
  });
}

/**
 * Group the rows for the grid's collapsible sections.
 *
 * A row in two groups appears under both — a member of the Guild and
 * the Council is in both lists, and showing them once under whichever
 * came first would make one of the two counts wrong.
 *
 * Order is by size, then by name, with the no-value bucket last: the
 * biggest group is the one you are most likely to have grouped FOR,
 * and "—" is not an answer to the question you asked.
 */
export function groupRows<T extends Row>(
  rows: T[],
  key: string
): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    for (const value of facetValues(row, key)) {
      if (!map.has(value)) map.set(value, []);
      map.get(value)!.push(row);
    }
  }
  return Array.from(map.entries()).sort((a, b) => {
    if (a[0] === EMPTY) return 1;
    if (b[0] === EMPTY) return -1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
}

/**
 * Which values a field actually holds, for the facet counts.
 *
 * Two passes on purpose: the OPTIONS come from the rows the search left
 * standing, and the COUNTS from the rows that also survived the
 * filters. So an option you have filtered out still appears, at zero,
 * rather than vanishing from the panel the moment you use it — which
 * would make it impossible to widen the filter you just narrowed.
 */
export function facetCounts(
  searched: Row[],
  filtered: Row[],
  key: string
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of searched) {
    for (const v of facetValues(row, key)) counts.set(v, 0);
  }
  for (const row of filtered) {
    for (const v of facetValues(row, key)) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  counts.delete(EMPTY);
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
