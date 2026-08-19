/**
 * The Locations tree: pure helpers, no React and no Convex.
 *
 * Locations nest — a region holds cities, a city holds districts, a
 * district holds a building — and each one can carry a map of its own.
 * A child is drawn as a pin ON its parent's map, at a normalized (x, y)
 * so the pin stays put when the image is displayed at any size.
 *
 * The rules that matter here are all about not losing anything:
 *
 *   - a location whose parent is missing surfaces at the ROOT rather
 *     than vanishing, the same instinct as the Notebook's tree. A
 *     player who cannot see the hidden city its district sits in must
 *     still be able to reach the district.
 *   - a parent cycle terminates instead of hanging.
 *   - deleting a location PROMOTES its children rather than taking the
 *     branch with it.
 */

export interface LocRow {
  _id: string;
  parentId: string | null;
  name: string;
  order: number;
  /** Normalized 0..1 position on the PARENT's map, if it is pinned. */
  x?: number | null;
  y?: number | null;
  /** Resolved server-side from mapId, or the map-server path. */
  mapUrl?: string | null;
  mapPath?: string | null;
}

/** Does this location have a map you can descend into? */
export function hasMap(loc: {
  mapUrl?: string | null;
  mapPath?: string | null;
}): boolean {
  return Boolean(loc.mapUrl || loc.mapPath);
}

/**
 * The image to draw for a location's map.
 *
 * An uploaded file wins over the imported map-server path, the same
 * rule NPC portraits use — one place decides, so the grid, the pin
 * layer and the detail panel cannot disagree.
 */
export function mapSrc(
  mapUrl: string | null | undefined,
  mapPath: string | null | undefined,
  mapServer: string
): string | null {
  if (mapUrl) return mapUrl;
  if (mapPath && mapServer) return `${mapServer}/${mapPath}`;
  return null;
}

/** Pins live in 0..1 so they survive any display size. */
export function clampPin(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const byId = (rows: LocRow[]) => new Map(rows.map((r) => [r._id, r]));

/**
 * Children of a parent, in order.
 *
 * `parentId === null` means the roots — and a row pointing at a parent
 * that isn't in `rows` counts as a root too, because the alternative is
 * a location nobody can navigate to. That happens routinely rather than
 * exceptionally: a player's list has the hidden locations filtered out
 * of it, so their children legitimately have no parent to sit under.
 */
export function childrenOf(rows: LocRow[], parentId: string | null): LocRow[] {
  const index = byId(rows);
  return rows
    .filter((r) => {
      if (r.parentId === null || r.parentId === undefined) {
        return parentId === null;
      }
      if (!index.has(r.parentId)) return parentId === null; // promoted orphan
      return r.parentId === parentId;
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * The chain from the root down to `id`, inclusive — the breadcrumb.
 *
 * Walks upward and stops on a repeat, so a parent cycle written by a
 * bad patch produces a short trail rather than an infinite one.
 */
export function ancestorsOf(rows: LocRow[], id: string): LocRow[] {
  const index = byId(rows);
  const chain: LocRow[] = [];
  const seen = new Set<string>();

  let cur = index.get(id) ?? null;
  while (cur && !seen.has(cur._id)) {
    seen.add(cur._id);
    chain.unshift(cur);
    cur = cur.parentId ? (index.get(cur.parentId) ?? null) : null;
  }
  return chain;
}

/**
 * Would making `childId` a child of `parentId` create a cycle?
 *
 * Reparenting a region under one of its own districts is the move that
 * makes a branch unreachable, and nothing about the shape of the data
 * prevents it.
 */
export function wouldCycle(
  rows: LocRow[],
  childId: string,
  parentId: string | null
): boolean {
  if (parentId === null) return false;
  if (childId === parentId) return true;
  const index = byId(rows);
  const seen = new Set<string>();

  let cur = index.get(parentId) ?? null;
  while (cur && !seen.has(cur._id)) {
    if (cur._id === childId) return true;
    seen.add(cur._id);
    cur = cur.parentId ? (index.get(cur.parentId) ?? null) : null;
  }
  return false;
}

/**
 * Deleting `id` promotes its children to `id`'s parent.
 *
 * Returns the reparenting each child needs. Deleting a city should not
 * silently take every district in it — the DM asked to remove one
 * location, and a cascade is a different, much larger request.
 */
export function reparentOnDelete(
  rows: LocRow[],
  id: string
): { _id: string; parentId: string | null }[] {
  const target = rows.find((r) => r._id === id);
  if (!target) return [];
  const grandparent = target.parentId ?? null;

  // childrenOf rather than a raw filter, so the patches come back in
  // sibling order like everything else here — storage order is whatever
  // the query happened to return, which makes this the one function in
  // the module whose output you cannot predict.
  return childrenOf(rows, id).map((r) => ({
    _id: r._id,
    parentId: grandparent,
  }));
}

/** Depth-first order, for a flat picker that still reads as a tree. */
export function flatten(
  rows: LocRow[],
  parentId: string | null = null,
  depth = 0,
  seen: Set<string> = new Set()
): { row: LocRow; depth: number }[] {
  const out: { row: LocRow; depth: number }[] = [];
  for (const row of childrenOf(rows, parentId)) {
    if (seen.has(row._id)) continue; // a cycle must not recurse forever
    seen.add(row._id);
    out.push({ row, depth });
    out.push(...flatten(rows, row._id, depth + 1, seen));
  }
  return out;
}
