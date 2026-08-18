/**
 * Pure helpers for the Notebook: tree assembly and table edits.
 *
 * Deliberately free of React and Convex so they can be tested directly —
 * the handoff is explicit that the tree operations are where the bugs
 * live and the cheapest thing to cover. tests/guards/unit.mjs exercises
 * every function here.
 */

export type NodeKind = "page" | "section";

/** A row as stored, flat. */
export type NodeRow = {
  _id: string;
  kind: NodeKind;
  title: string;
  parentId?: string | null;
  order: number;
  color?: string | null;
  collapsed?: boolean | null;
};

/** The same node with its children attached. */
export type NbNode = NodeRow & { children: NbNode[] };

/**
 * Flat rows to a tree, repairing anything that disagrees.
 *
 * A node whose parent is missing, or which sits in a parent cycle, is
 * PROMOTED to the top level rather than dropped. Losing a page is worse
 * than showing it in the wrong place: an unreachable page is a page
 * somebody wrote and can no longer find. This is the equivalent of the
 * handoff's reconcileTree(), whose whole job is that a damaged tree
 * comes up usable instead of throwing.
 */
export function buildTree(rows: NodeRow[]): NbNode[] {
  const byId = new Map<string, NbNode>();
  for (const row of rows) byId.set(row._id, { ...row, children: [] });

  /** Would attaching this node to its parent create a loop? */
  const inCycle = (start: NbNode): boolean => {
    const seen = new Set<string>([start._id]);
    let cur = start.parentId ? byId.get(start.parentId) : undefined;
    while (cur) {
      if (seen.has(cur._id)) return true;
      seen.add(cur._id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };

  const roots: NbNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // A page can never hold children, whatever a stale row claims.
    const usable = parent && parent.kind === "section" && !inCycle(node);
    if (usable) parent!.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: NbNode[]) => {
    list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  return roots;
}

/**
 * Is `maybeAncestorId` at or above `nodeId` in the tree?
 *
 * Used to refuse dropping a folder into its own descendant, which would
 * detach that whole branch from the root.
 */
export function isAncestor(
  rows: NodeRow[],
  maybeAncestorId: string,
  nodeId: string
): boolean {
  if (maybeAncestorId === nodeId) return true;
  const byId = new Map(rows.map((r) => [r._id, r]));
  const seen = new Set<string>();

  let cur = byId.get(nodeId);
  while (cur?.parentId) {
    if (seen.has(cur._id)) return false; // damaged data: stop, don't hang
    seen.add(cur._id);
    if (cur.parentId === maybeAncestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** Depth-first list of nodes, skipping the contents of collapsed folders. */
export function visibleNodes(
  tree: NbNode[],
  depth = 0
): { node: NbNode; depth: number }[] {
  const out: { node: NbNode; depth: number }[] = [];
  for (const node of tree) {
    out.push({ node, depth });
    if (node.kind === "section" && !node.collapsed) {
      out.push(...visibleNodes(node.children, depth + 1));
    }
  }
  return out;
}

/**
 * First page in tree order, for picking a selection after a delete.
 *
 * Collapse is a display state and is deliberately ignored: a page inside
 * a shut folder is still a page, and skipping it would sometimes return
 * null for a notebook that plainly has pages in it.
 */
export function firstPageId(tree: NbNode[]): string | null {
  for (const node of tree) {
    if (node.kind === "page") return node._id;
    const found = firstPageId(node.children);
    if (found) return found;
  }
  return null;
}

/** A stable tint for a folder with no colour of its own. */
export function folderColor(name: string): string {
  const palette = [
    "#c9a227",
    "#4f9fd9",
    "#4caf6e",
    "#d95f3b",
    "#a97ad9",
    "#d9b13b",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

// ---------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------

export type TableData = {
  rows: string[][];
  colWidths: number[];
  rowHeights: number[];
};

const DEFAULT_COL = 120;
const DEFAULT_ROW = 32;

export function emptyTable(rows: number, cols: number): TableData {
  return {
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => "")),
    colWidths: Array.from({ length: cols }, () => DEFAULT_COL),
    rowHeights: Array.from({ length: rows }, () => DEFAULT_ROW),
  };
}

export function tableInsertRow(t: TableData, at: number): TableData {
  const cols = t.rows[0]?.length ?? t.colWidths.length ?? 1;
  const i = Math.max(0, Math.min(at, t.rows.length));
  const rows = [...t.rows];
  rows.splice(i, 0, Array.from({ length: cols }, () => ""));
  const rowHeights = [...t.rowHeights];
  rowHeights.splice(i, 0, t.rowHeights[i] ?? DEFAULT_ROW);
  return { ...t, rows, rowHeights };
}

export function tableDeleteRow(t: TableData, at: number): TableData {
  // Never delete the last row — an empty grid has nothing to click back.
  if (t.rows.length <= 1 || at < 0 || at >= t.rows.length) return t;
  const rows = [...t.rows];
  rows.splice(at, 1);
  const rowHeights = [...t.rowHeights];
  rowHeights.splice(at, 1);
  return { ...t, rows, rowHeights };
}

export function tableInsertCol(t: TableData, at: number): TableData {
  const width = t.rows[0]?.length ?? t.colWidths.length;
  const i = Math.max(0, Math.min(at, width));
  const rows = t.rows.map((r) => {
    const next = [...r];
    next.splice(i, 0, "");
    return next;
  });
  const colWidths = [...t.colWidths];
  colWidths.splice(i, 0, t.colWidths[i] ?? DEFAULT_COL);
  return { ...t, rows, colWidths };
}

export function tableDeleteCol(t: TableData, at: number): TableData {
  const width = t.rows[0]?.length ?? t.colWidths.length;
  if (width <= 1 || at < 0 || at >= width) return t;
  const rows = t.rows.map((r) => {
    const next = [...r];
    next.splice(at, 1);
    return next;
  });
  const colWidths = [...t.colWidths];
  colWidths.splice(at, 1);
  return { ...t, rows, colWidths };
}

/**
 * Sort by a column, keeping row heights with their rows.
 *
 * Row 0 is treated as a header and stays put — sorting a table with
 * headings and silently burying them mid-list is the kind of thing you
 * only notice after saving.
 */
export function tableSort(
  t: TableData,
  col: number,
  asc = true,
  hasHeader = true
): TableData {
  const start = hasHeader ? 1 : 0;
  if (t.rows.length <= start + 1) return t;

  const head = t.rows.slice(0, start);
  const headHeights = t.rowHeights.slice(0, start);

  const paired = t.rows
    .slice(start)
    .map((row, i) => ({ row, height: t.rowHeights[start + i] ?? DEFAULT_ROW }));

  paired.sort((a, b) => {
    const av = a.row[col] ?? "";
    const bv = b.row[col] ?? "";
    const an = Number(av);
    const bn = Number(bv);
    const numeric =
      av.trim() !== "" && bv.trim() !== "" &&
      Number.isFinite(an) && Number.isFinite(bn);
    const cmp = numeric
      ? an - bn
      : av.localeCompare(bv, undefined, { sensitivity: "base" });
    return asc ? cmp : -cmp;
  });

  return {
    ...t,
    rows: [...head, ...paired.map((p) => p.row)],
    rowHeights: [...headHeights, ...paired.map((p) => p.height)],
  };
}

export function tableIsEmpty(t: TableData): boolean {
  return t.rows.every((r) => r.every((c) => c.trim() === ""));
}

// ---------------------------------------------------------------------
// Emptiness — what decides whether a box has to announce itself
// ---------------------------------------------------------------------

/**
 * Does this HTML render as nothing?
 *
 * contentEditable never leaves a field truly empty: type a character and
 * delete it and you are left with `<br>`, and a pasted blank line is
 * `&nbsp;`. Testing `html === ""` therefore reports "has content" for a
 * box that plainly looks blank, which is exactly the box that most needs
 * its border.
 */
export function htmlIsBlank(html?: string | null): boolean {
  if (!html) return true;
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, "");
  return text.length === 0;
}

/**
 * A box with nothing in it is drawn with a visible border always, not
 * only on hover.
 *
 * That looks like an inconsistency and isn't: a filled box carries its
 * own visibility — you can see the text — while an empty chromeless box
 * is an invisible trap you can click into and never find again.
 */
export function boxIsEmpty(box: {
  type: string;
  html?: string | null;
  src?: string | null;
  rows?: string[][] | null;
}): boolean {
  if (box.type === "image") return !box.src;
  if (box.type === "table") {
    const rows = box.rows ?? [[""]];
    return rows.every((r) => r.every((c) => c.trim() === ""));
  }
  return htmlIsBlank(box.html);
}

/**
 * Rotating an image swaps its bounding box at each quarter turn, so the
 * box has to be resized with it or the picture crops itself.
 */
export function rotatedImagePatch(
  box: { w: number; h: number; rotate?: number | null },
  delta: number
): { rotate: number; w: number; h: number } {
  const rotate = (((box.rotate ?? 0) + delta) % 360 + 360) % 360;
  const quarterTurned = Math.abs(delta / 90) % 2 === 1;
  return quarterTurned
    ? { rotate, w: box.h, h: box.w }
    : { rotate, w: box.w, h: box.h };
}
