/**
 * Paging arithmetic, shared by every table.
 *
 * Asked for: every table loads a fixed number of rows at a time, with
 * standard page numbers and Previous/Next, and the amount is one
 * setting (10–50) that every table honours. The arithmetic lives here
 * — no React, no DOM — so the unit guard can hold the edges that go
 * wrong invisibly: a filter that shrinks the list under your current
 * page, a page row that hides the last page, a stored size the
 * options never offered.
 *
 * Pages are 0-based everywhere in code; the Pager adds 1 for people.
 */

export const PAGE_SIZES = [10, 20, 30, 40, 50] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 20;

/**
 * A stored size, held to the offered set. The setting travels through
 * a JSON column and an optional field — anything else becomes the
 * default rather than a table with 0 or 10000 rows per page.
 */
export function clampPageSize(n: unknown): PageSize {
  return (PAGE_SIZES as readonly unknown[]).includes(n)
    ? (n as PageSize)
    : DEFAULT_PAGE_SIZE;
}

/** Never 0: an empty table still has page 1 of 1 rather than of 0. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, size)));
}

/**
 * The page actually shown for a wanted page. Clamped, not reset: a
 * filter that shrinks the list lands you on the new LAST page, and a
 * row added while you read does not yank you back to the first.
 */
export function clampPage(page: number, count: number): number {
  const p = Number.isFinite(page) ? Math.floor(page) : 0;
  return Math.min(Math.max(0, p), count - 1);
}

/** The rows of one page, with the wanted page clamped first. */
export function pageSlice<T>(
  rows: readonly T[],
  page: number,
  size: number
): T[] {
  const p = clampPage(page, pageCount(rows.length, size));
  return rows.slice(p * size, p * size + size);
}

/**
 * The standard page row: first and last always, the current page with
 * a neighbour each side, and gaps elided — `1 … 4 5 6 … 20`. Seven or
 * fewer pages need no eliding. Near an end the window widens so the
 * row always names at least five pages, which keeps the controls from
 * shifting underfoot as you walk toward the middle.
 */
export function pageNumbers(page: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  const keep = new Set<number>([0, count - 1, page - 1, page, page + 1]);
  if (page <= 2) [1, 2, 3].forEach((i) => keep.add(i));
  if (page >= count - 3) {
    [count - 4, count - 3, count - 2].forEach((i) => keep.add(i));
  }
  const out: (number | "gap")[] = [];
  let prev = -1;
  for (let i = 0; i < count; i++) {
    if (!keep.has(i)) continue;
    if (prev !== -1 && i - prev > 1) out.push("gap");
    out.push(i);
    prev = i;
  }
  return out;
}
