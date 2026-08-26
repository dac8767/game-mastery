/**
 * The DM Screen's window model: a Premiere-style tiled dock.
 *
 * Premiere's behaviour, matched from four filmed scenarios: windows
 * NEVER float. The screen is one tree of splits whose leaves are tab
 * groups, so the arrangement always fills the canvas edge to edge —
 * no background showing through, no window partially covering another.
 * Dropping a window on a neighbour's side splits that neighbour's
 * space; dropping it on the tab strip (or dead centre) stacks it as a
 * tab; dropping it on the canvas's own edge docks it the full length
 * of that side; and the bar between two windows resizes both at once.
 * Overlap is not prevented — it is unrepresentable.
 *
 * Everything here is arithmetic and data — no React, no DOM, no Convex
 * — so the unit guard can exercise the parts that go wrong invisibly:
 * a drop zone that picks the wrong edge, a split whose shares stop
 * summing to one, a saved layout from last month that has to open
 * rather than crash.
 *
 * The layout PERSISTS AS JSON in one string column. Deliberate: this
 * shape will keep changing, and a Convex validator for it would turn
 * every tweak into a migration of a personal preference blob. The
 * price is that nothing checks it on the way in — so `parseLayout`
 * trusts nothing, and every node of the tree is rebuilt from whatever
 * survives inspection.
 */

// ---------------------------------------------------------------------
// What a window can hold
// ---------------------------------------------------------------------

/**
 * Every kind of window the screen offers.
 *
 * The Lookup tabs are separate kinds on purpose: "a spell lookup" is
 * what the DM adds, and one generic Lookup window whose kind lived in
 * group state would be a second copy of the tab strip to keep in step.
 */
export const DM_PANEL_KINDS = [
  "spells",
  "items",
  "monsters",
  "species",
  "backgrounds",
  "feats",
  "classes",
  "npcs",
  "sessions",
  "locations",
  "groups",
  "chat",
  "calendar",
  "rules",
  "reference",
  "note",
] as const;

export type DmPanelKind = (typeof DM_PANEL_KINDS)[number];

/** What each kind is called on a tab and in the Add menu. */
export const DM_PANEL_TITLES: Record<DmPanelKind, string> = {
  spells: "Spells",
  items: "Items",
  monsters: "Monsters",
  species: "Species",
  backgrounds: "Backgrounds",
  feats: "Feats",
  classes: "Classes",
  npcs: "NPCs",
  sessions: "Sessions",
  locations: "Locations",
  groups: "Groups",
  chat: "Chat",
  calendar: "Calendar",
  rules: "Rules Lawyer",
  reference: "Reference",
  note: "Note",
};

export interface DmTab {
  kind: DmPanelKind;
  /** Which note document a note tab shows. Only on kind "note". */
  noteId?: string;
}

// ---------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------

/** A leaf: one window frame holding a stack of tabs. */
export interface DmGroup {
  type: "group";
  id: number;
  tabs: DmTab[];
  /** Index into tabs. */
  active: number;
}

/**
 * An interior node: children laid side by side ("row") or stacked
 * ("col"), each taking `sizes[i]` of the space after dividers.
 * `sizes` sums to 1 — every operation below preserves that, and the
 * parser restores it, because a sum that drifts reads as windows
 * slowly shrinking away from the right edge.
 */
export interface DmSplit {
  type: "split";
  id: number;
  dir: "row" | "col";
  children: DmNode[];
  sizes: number[];
}

export type DmNode = DmGroup | DmSplit;

export interface DmLayout {
  /** Null only when every window has been closed. */
  root: DmNode | null;
  nextId: number;
  /** The group new windows land in — the last one touched. */
  focused: number | null;
  /**
   * The one group covering the whole canvas, or null. The TREE is
   * untouched while a window is maximized — restore is just letting
   * this go, so "back to the exact arrangement" cannot drift.
   */
  maximized: number | null;
}

/** The bar between two windows. CSS states this again; a guard pins them. */
export const DIVIDER_PX = 6;

/** No window may be squeezed thinner than this by a divider drag. */
export const MIN_TILE_PX = 120;

/** A window docked to the canvas edge takes this share of the screen. */
export const DOCK_FRAC = 0.25;

/**
 * The highlight strips. The highlight says WHERE the window will
 * attach, never how much it will take: a side drop lights a small
 * band in from the near edge, a canvas-edge drop a thin line along
 * that edge. Matched to Premiere's screenshots — a highlight covering
 * the landing area reads as "this window gets replaced".
 */
export const EDGE_HINT_PX = 72;
export const ROOT_HINT_PX = 20;

/**
 * How far inside a window its edge drop zones reach, as a fraction of
 * its size. Inside the middle box is a tab drop, Premiere-style.
 */
export const EDGE_ZONE = 0.25;

/** Within this many px of the canvas boundary, the drop is a full-edge dock. */
export const ROOT_EDGE_PX = 16;

export type DmEdge = "left" | "right" | "top" | "bottom";

/** Where a dragged window or tab would land, shown before it does. */
export type DmDropTarget =
  | { type: "tabs"; group: number }
  | { type: "edge"; group: number; edge: DmEdge }
  | { type: "root"; edge: DmEdge };

export interface DmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------

export function findGroup(node: DmNode | null, id: number): DmGroup | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? node : null;
  for (const c of node.children) {
    const hit = findGroup(c, id);
    if (hit) return hit;
  }
  return null;
}

function findSplit(node: DmNode | null, id: number): DmSplit | null {
  if (!node || node.type !== "split") return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findSplit(c, id);
    if (hit) return hit;
  }
  return null;
}

/** Every group, left-to-right, top-to-bottom — tree order is reading order. */
export function allGroups(node: DmNode | null): DmGroup[] {
  if (!node) return [];
  if (node.type === "group") return [node];
  return node.children.flatMap(allGroups);
}

const clone = (layout: DmLayout): DmLayout =>
  JSON.parse(JSON.stringify(layout)) as DmLayout;

// ---------------------------------------------------------------------
// Parsing — the only door stored JSON comes through
// ---------------------------------------------------------------------

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * `sizes` restored to a clean distribution: one positive number per
 * child, summing to 1. A stored array that is missing, short, or
 * carrying zeros and negatives is replaced with equal shares rather
 * than guessed at.
 */
function cleanSizes(raw: unknown, count: number): number[] {
  const even = () => Array.from({ length: count }, () => 1 / count);
  if (!Array.isArray(raw) || raw.length !== count) return even();
  const nums = raw.map((v) => (isNum(v) && v > 0 ? v : NaN));
  if (nums.some((v) => Number.isNaN(v))) return even();
  const sum = nums.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return even();
  // Normalise only when actually off — exact stored shares round-trip.
  if (Math.abs(sum - 1) < 0.001) return nums;
  return nums.map((v) => v / sum);
}

function parseNode(
  raw: unknown,
  validNoteIds: ReadonlySet<string>
): DmNode | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (o.type === "group") {
    const kinds = new Set<string>(DM_PANEL_KINDS);
    const tabs: DmTab[] = [];
    for (const t of Array.isArray(o.tabs) ? o.tabs : []) {
      if (!t || typeof t !== "object") continue;
      const kind = (t as Record<string, unknown>).kind;
      if (typeof kind !== "string" || !kinds.has(kind)) continue;
      if (kind === "note") {
        const noteId = (t as Record<string, unknown>).noteId;
        if (typeof noteId !== "string" || !validNoteIds.has(noteId)) continue;
        tabs.push({ kind, noteId });
      } else {
        tabs.push({ kind: kind as DmPanelKind });
      }
    }
    if (tabs.length === 0) return null;
    return {
      type: "group",
      id: isNum(o.id) ? Math.round(o.id) : 0,
      tabs,
      active: Math.min(
        Math.max(0, isNum(o.active) ? Math.round(o.active) : 0),
        tabs.length - 1
      ),
    };
  }

  if (o.type === "split") {
    const childrenIn = Array.isArray(o.children) ? o.children : [];
    const sizesIn = Array.isArray(o.sizes) ? o.sizes : [];
    const children: DmNode[] = [];
    const sizes: unknown[] = [];
    childrenIn.forEach((c, i) => {
      const node = parseNode(c, validNoteIds);
      if (node) {
        children.push(node);
        sizes.push(sizesIn[i]);
      }
    });
    if (children.length === 0) return null;
    // A split of one is not a split — the child stands where it stood,
    // at full size, rather than wrapped in a frame that divides nothing.
    if (children.length === 1) return children[0];
    return {
      type: "split",
      id: isNum(o.id) ? Math.round(o.id) : 0,
      dir: o.dir === "col" ? "col" : "row",
      children,
      sizes: cleanSizes(sizes, children.length),
    };
  }

  return null;
}

/**
 * A stored layout, rebuilt node by node.
 *
 * `validNoteIds` is the set of note documents that still exist: a note
 * tab whose document was deleted elsewhere is dropped here rather than
 * rendered as an empty pane titled "Note". A group with no surviving
 * tabs goes too — its siblings absorb the space — and a layout with
 * nothing left returns null so the caller falls back to the default
 * rather than presenting an empty screen as a choice somebody made.
 *
 * Layouts from the floating era (a `panels` array) also come back
 * null: a pile of overlapping rectangles has no faithful place in a
 * tiling, so the default steps in rather than a guessed conversion.
 */
export function parseLayout(
  raw: string | null | undefined,
  validNoteIds: ReadonlySet<string>
): DmLayout | null {
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;

  const root = parseNode(o.root, validNoteIds);
  if (!root) return null;

  // Ids must be unique — drops and closes address nodes by id, and a
  // duplicate means "some other window moves when this one is dragged".
  // Invalid and repeated ids are reassigned past the highest survivor.
  let maxId = 0;
  const seen = new Set<number>();
  const scan = (n: DmNode) => {
    if (n.id > 0 && !seen.has(n.id)) {
      seen.add(n.id);
      maxId = Math.max(maxId, n.id);
    }
    if (n.type === "split") n.children.forEach(scan);
  };
  scan(root);
  const fix = (n: DmNode) => {
    if (n.id <= 0 || !seen.has(n.id)) n.id = ++maxId;
    else seen.delete(n.id);
    if (n.type === "split") n.children.forEach(fix);
  };
  // `seen` now holds each id once; fix() spends them, so a SECOND node
  // claiming a spent id reads as unseen and gets a fresh one.
  fix(root);

  const focusedIn = isNum(o.focused) ? Math.round(o.focused) : null;
  const focused =
    focusedIn !== null && findGroup(root, focusedIn) ? focusedIn : null;

  // A maximized id pointing at nothing is let go, never fatal — the
  // arrangement underneath is fine, it just is not covered any more.
  const maxIn = isNum(o.maximized) ? Math.round(o.maximized) : null;
  const maximized = maxIn !== null && findGroup(root, maxIn) ? maxIn : null;

  return {
    root,
    nextId: Math.max(maxId + 1, isNum(o.nextId) ? Math.round(o.nextId) : 1),
    focused,
    maximized,
  };
}

export function serializeLayout(layout: DmLayout): string {
  return JSON.stringify(layout);
}

/**
 * The screen a DM sees before arranging anything: the reference panel
 * the old DM Screen WAS — conditions and death saves — beside a
 * monster-and-spell lookup stack, so the first visit shows the idea
 * rather than an empty grey field with a menu.
 */
export function defaultLayout(): DmLayout {
  return {
    root: {
      type: "split",
      id: 3,
      dir: "row",
      children: [
        { type: "group", id: 1, tabs: [{ kind: "reference" }], active: 0 },
        {
          type: "group",
          id: 2,
          tabs: [{ kind: "monsters" }, { kind: "spells" }],
          active: 0,
        },
      ],
      sizes: [0.5, 0.5],
    },
    nextId: 4,
    focused: 2,
    maximized: null,
  };
}

// ---------------------------------------------------------------------
// Geometry — where the tree puts each window
// ---------------------------------------------------------------------

/**
 * Every group's rectangle, computed from the shares. The flexbox that
 * renders the tree and this arithmetic must agree — dividers take
 * DIVIDER_PX each, children share what remains — because these rects
 * are what the drop zones are measured against.
 */
export function layoutRects(
  layout: DmLayout,
  view: { w: number; h: number },
  dividerPx = DIVIDER_PX
): Map<number, DmRect> {
  const out = new Map<number, DmRect>();
  const walk = (node: DmNode, rect: DmRect) => {
    if (node.type === "group") {
      out.set(node.id, rect);
      return;
    }
    const row = node.dir === "row";
    const total = row ? rect.w : rect.h;
    const avail = Math.max(0, total - dividerPx * (node.children.length - 1));
    let at = row ? rect.x : rect.y;
    node.children.forEach((child, i) => {
      const size = node.sizes[i] * avail;
      walk(
        child,
        row
          ? { x: at, y: rect.y, w: size, h: rect.h }
          : { x: rect.x, y: at, w: rect.w, h: size }
      );
      at += size + dividerPx;
    });
  };
  if (layout.root) walk(layout.root, { x: 0, y: 0, w: view.w, h: view.h });
  return out;
}

/**
 * Which drop the pointer is proposing, Premiere's zones exactly:
 * within reach of the canvas boundary it is a full-edge dock; over a
 * window's tab strip, or the middle box of its body, it stacks as a
 * tab; over the outer quarter on any side it splits that side. The
 * canvas edge is checked FIRST — near the boundary both readings
 * apply, and the full-length dock is the one the highlight promised.
 */
export function dropTargetAt(
  layout: DmLayout,
  point: { x: number; y: number },
  view: { w: number; h: number },
  headerPx: number
): DmDropTarget | null {
  if (!layout.root) return null;
  // While one window covers the canvas there is nothing to dock
  // against — a drop here would rearrange a tree nobody can see.
  if (layout.maximized !== null) return null;

  const toEdge: [DmEdge, number][] = [
    ["left", point.x],
    ["right", view.w - point.x],
    ["top", point.y],
    ["bottom", view.h - point.y],
  ];
  toEdge.sort((a, b) => a[1] - b[1]);
  if (toEdge[0][1] <= ROOT_EDGE_PX) {
    return { type: "root", edge: toEdge[0][0] };
  }

  for (const [id, r] of layoutRects(layout, view)) {
    if (
      point.x < r.x ||
      point.x > r.x + r.w ||
      point.y < r.y ||
      point.y > r.y + r.h
    ) {
      continue;
    }
    if (point.y <= r.y + headerPx) return { type: "tabs", group: id };
    const nx = r.w > 0 ? (point.x - r.x) / r.w : 0.5;
    const ny = r.h > 0 ? (point.y - r.y) / r.h : 0.5;
    const zones: [DmEdge, number][] = [
      ["left", nx],
      ["right", 1 - nx],
      ["top", ny],
      ["bottom", 1 - ny],
    ];
    zones.sort((a, b) => a[1] - b[1]);
    if (zones[0][1] > EDGE_ZONE) return { type: "tabs", group: id };
    return { type: "edge", group: id, edge: zones[0][0] };
  }
  return null;
}

/**
 * The highlight for a proposed drop — where the window will ATTACH,
 * drawn before it lands, and deliberately not the area it will take.
 * A tab drop lights the small strip at the top it would join; a side
 * drop lights a narrow band in from the near edge of that window; a
 * canvas-edge drop lights a thin line the full run of that side.
 * Never a whole window: a highlight that swallows one reads as "this
 * window gets replaced", which no drop here ever does.
 */
export function dropPreviewRect(
  layout: DmLayout,
  target: DmDropTarget,
  view: { w: number; h: number },
  headerPx: number
): DmRect | null {
  if (target.type === "root") {
    const t = ROOT_HINT_PX;
    switch (target.edge) {
      case "left":
        return { x: 0, y: 0, w: t, h: view.h };
      case "right":
        return { x: view.w - t, y: 0, w: t, h: view.h };
      case "top":
        return { x: 0, y: 0, w: view.w, h: t };
      case "bottom":
        return { x: 0, y: view.h - t, w: view.w, h: t };
    }
  }
  const r = layoutRects(layout, view).get(target.group);
  if (!r) return null;
  if (target.type === "tabs") return { x: r.x, y: r.y, w: r.w, h: headerPx };
  // Capped at a quarter so a narrow window still shows a BAND, not
  // its whole self.
  const bw = Math.min(EDGE_HINT_PX, r.w / 4);
  const bh = Math.min(EDGE_HINT_PX, r.h / 4);
  switch (target.edge) {
    case "left":
      return { x: r.x, y: r.y, w: bw, h: r.h };
    case "right":
      return { x: r.x + r.w - bw, y: r.y, w: bw, h: r.h };
    case "top":
      return { x: r.x, y: r.y, w: r.w, h: bh };
    case "bottom":
      return { x: r.x, y: r.y + r.h - bh, w: r.w, h: bh };
  }
}

// ---------------------------------------------------------------------
// Rearranging — every mutation keeps the tiling whole
// ---------------------------------------------------------------------

/**
 * The node removed from the tree, siblings absorbing its share.
 *
 * The invariants live here: a split never keeps a hole (the removed
 * child's share is redistributed pro rata), and a split of one child
 * collapses into that child — so the space a window leaves is always
 * immediately owned by its neighbours, never by the background.
 */
function detachNode(layout: DmLayout, id: number): DmNode | null {
  if (!layout.root) return null;
  if (layout.root.id === id) {
    const detached = layout.root;
    layout.root = null;
    return detached;
  }
  let detached: DmNode | null = null;
  const walk = (node: DmNode, parent: DmSplit | null): DmNode | null => {
    if (node.type === "group") return node;
    const at = node.children.findIndex((c) => c.id === id);
    if (at !== -1) {
      detached = node.children[at];
      node.children.splice(at, 1);
      node.sizes.splice(at, 1);
      const sum = node.sizes.reduce((a, b) => a + b, 0);
      node.sizes = node.sizes.map((s) => (sum > 0 ? s / sum : 1));
      if (node.children.length === 1) return node.children[0];
      return node;
    }
    node.children = node.children.map((c) => walk(c, node) ?? c);
    if (node.children.length === 1) return node.children[0];
    return node;
  };
  layout.root = walk(layout.root, null);
  return detached;
}

const dirOf = (edge: DmEdge): "row" | "col" =>
  edge === "left" || edge === "right" ? "row" : "col";

const firstOf = (edge: DmEdge): boolean =>
  edge === "left" || edge === "top";

/**
 * `node` docked against one side of group `groupId`, which gives up
 * half its space. Where the group already sits in a split running the
 * same way, the newcomer joins that split as a sibling — Premiere
 * extends the run rather than nesting a frame inside a frame.
 */
function insertAtGroupEdge(
  layout: DmLayout,
  groupId: number,
  node: DmNode,
  edge: DmEdge
): boolean {
  const dir = dirOf(edge);
  const before = firstOf(edge);
  if (!layout.root) return false;

  const wrap = (target: DmNode): DmSplit => ({
    type: "split",
    id: layout.nextId++,
    dir,
    children: before ? [node, target] : [target, node],
    sizes: [0.5, 0.5],
  });

  if (layout.root.type === "group" && layout.root.id === groupId) {
    layout.root = wrap(layout.root);
    return true;
  }
  let done = false;
  const walk = (split: DmSplit) => {
    if (done) return;
    const at = split.children.findIndex(
      (c) => c.type === "group" && c.id === groupId
    );
    if (at !== -1) {
      if (split.dir === dir) {
        const share = split.sizes[at] / 2;
        split.sizes[at] = share;
        split.children.splice(before ? at : at + 1, 0, node);
        split.sizes.splice(before ? at : at + 1, 0, share);
      } else {
        split.children[at] = wrap(split.children[at]);
      }
      done = true;
      return;
    }
    for (const c of split.children) {
      if (c.type === "split") walk(c);
    }
  };
  if (layout.root.type === "split") walk(layout.root);
  return done;
}

/**
 * `node` docked the full length of one canvas edge at DOCK_FRAC of the
 * screen, everything already there scaled into the rest. A root split
 * already running that way takes it as a new first or last child.
 */
function insertAtRootEdge(layout: DmLayout, node: DmNode, edge: DmEdge) {
  const dir = dirOf(edge);
  const before = firstOf(edge);
  if (!layout.root) {
    layout.root = node;
    return;
  }
  if (layout.root.type === "split" && layout.root.dir === dir) {
    const scaled = layout.root.sizes.map((s) => s * (1 - DOCK_FRAC));
    layout.root.children.splice(
      before ? 0 : layout.root.children.length,
      0,
      node
    );
    layout.root.sizes = before
      ? [DOCK_FRAC, ...scaled]
      : [...scaled, DOCK_FRAC];
    return;
  }
  layout.root = {
    type: "split",
    id: layout.nextId++,
    dir,
    children: before ? [node, layout.root] : [layout.root, node],
    sizes: before ? [DOCK_FRAC, 1 - DOCK_FRAC] : [1 - DOCK_FRAC, DOCK_FRAC],
  };
}

/** Tabs stacked into a group; the first arrival is the one on top. */
function mergeTabsInto(layout: DmLayout, groupId: number, tabs: DmTab[]) {
  const group = findGroup(layout.root, groupId);
  if (!group) return false;
  group.active = group.tabs.length;
  group.tabs = [...group.tabs, ...tabs];
  layout.focused = groupId;
  return true;
}

/**
 * One tab carried to a drop target. The tab leaves its group — which
 * closes if that was its last — and lands as a stack member or as a
 * new window splitting the target's space.
 */
export function moveTab(
  layout: DmLayout,
  fromGroup: number,
  tabIndex: number,
  target: DmDropTarget
): DmLayout {
  const source = findGroup(layout.root, fromGroup);
  const tab = source?.tabs[tabIndex];
  if (!source || !tab) return layout;
  // Back onto its own strip is where it already lives; splitting a
  // window against itself when it holds nothing else is the same.
  if (target.type !== "root" && target.group === fromGroup) {
    if (target.type === "tabs" || source.tabs.length === 1) return layout;
  }

  const l = clone(layout);
  const from = findGroup(l.root, fromGroup)!;
  from.tabs.splice(tabIndex, 1);
  from.active = Math.min(from.active, from.tabs.length - 1);
  if (from.tabs.length === 0) detachNode(l, fromGroup);

  if (target.type === "tabs") {
    if (!mergeTabsInto(l, target.group, [tab])) return layout;
    return l;
  }
  const node: DmGroup = { type: "group", id: l.nextId++, tabs: [tab], active: 0 };
  if (target.type === "edge") {
    if (!insertAtGroupEdge(l, target.group, node, target.edge)) return layout;
  } else {
    insertAtRootEdge(l, node, target.edge);
  }
  l.focused = node.id;
  return l;
}

/**
 * A whole window carried to a drop target, tabs and all — the header
 * drag. Same landings as a tab; the window keeps its identity when it
 * splits and dissolves into the stack when it docks as tabs.
 */
export function moveGroup(
  layout: DmLayout,
  groupId: number,
  target: DmDropTarget
): DmLayout {
  if (target.type !== "root" && target.group === groupId) return layout;
  if (!findGroup(layout.root, groupId)) return layout;

  const l = clone(layout);
  const detached = detachNode(l, groupId);
  if (!detached || detached.type !== "group") return layout;

  if (target.type === "tabs") {
    if (!mergeTabsInto(l, target.group, detached.tabs)) return layout;
    return l;
  }
  if (target.type === "edge") {
    if (!insertAtGroupEdge(l, target.group, detached, target.edge)) {
      return layout;
    }
  } else {
    insertAtRootEdge(l, detached, target.edge);
  }
  l.focused = groupId;
  return l;
}

/**
 * A new window for `tab`, stacked into the focused group — the one
 * last touched — or standing alone as the whole screen when nothing
 * is open. Adding never splits: where the new window should LIVE is
 * exactly what dragging is for, and a guess would put it somewhere
 * arbitrary to be moved anyway.
 */
export function addTab(layout: DmLayout, tab: DmTab): DmLayout {
  const l = clone(layout);
  if (!l.root) {
    const node: DmGroup = {
      type: "group",
      id: l.nextId++,
      tabs: [tab],
      active: 0,
    };
    l.root = node;
    l.focused = node.id;
    return l;
  }
  const groups = allGroups(l.root);
  const home =
    (l.focused !== null && groups.find((g) => g.id === l.focused)) ||
    groups[0];
  home.tabs = [...home.tabs, tab];
  home.active = home.tabs.length - 1;
  l.focused = home.id;
  return l;
}

/**
 * One tab closed. A window losing its last tab closes with it, and its
 * neighbours absorb the space — the tiling never keeps a hole open.
 */
export function closeTab(
  layout: DmLayout,
  groupId: number,
  tabIndex: number
): DmLayout {
  const l = clone(layout);
  const group = findGroup(l.root, groupId);
  if (!group || !group.tabs[tabIndex]) return layout;
  group.tabs.splice(tabIndex, 1);
  group.active = Math.min(group.active, group.tabs.length - 1);
  if (group.tabs.length === 0) detachNode(l, groupId);
  if (l.focused !== null && !findGroup(l.root, l.focused)) {
    l.focused = allGroups(l.root)[0]?.id ?? null;
  }
  // The maximized window closing its last tab lets the cover go — the
  // arrangement underneath comes back rather than an empty screen.
  if (l.maximized !== null && !findGroup(l.root, l.maximized)) {
    l.maximized = null;
  }
  return l;
}

export function setActiveTab(
  layout: DmLayout,
  groupId: number,
  tabIndex: number
): DmLayout {
  const l = clone(layout);
  const group = findGroup(l.root, groupId);
  if (!group || !group.tabs[tabIndex]) return layout;
  group.active = tabIndex;
  l.focused = groupId;
  return l;
}

export function focusGroup(layout: DmLayout, groupId: number): DmLayout {
  if (layout.focused === groupId || !findGroup(layout.root, groupId)) {
    return layout;
  }
  return { ...layout, focused: groupId };
}

/**
 * One window over the whole canvas, or back again. The tree is never
 * touched: maximize is a cover over the arrangement, and restore is
 * lifting it — which is what makes "the format it was in before"
 * exact rather than remembered.
 */
export function toggleMaximized(layout: DmLayout, groupId: number): DmLayout {
  if (layout.maximized === groupId) return { ...layout, maximized: null };
  if (!findGroup(layout.root, groupId)) return layout;
  return { ...layout, maximized: groupId, focused: groupId };
}

/**
 * The divider between children `index` and `index + 1` of a split,
 * dragged by `delta` (a fraction of the split's span): one neighbour
 * grows by exactly what the other gives up, every other child holds
 * still, and neither may pass `minFrac` — the pixel minimum, expressed
 * as a share by the caller who knows the pixels.
 */
export function resizeSplit(
  layout: DmLayout,
  splitId: number,
  index: number,
  delta: number,
  minFrac: number
): DmLayout {
  const l = clone(layout);
  const split = findSplit(l.root, splitId);
  if (!split || index < 0 || index + 1 >= split.sizes.length) return layout;
  const pair = split.sizes[index] + split.sizes[index + 1];
  const lo = Math.min(minFrac, pair / 2);
  const a = Math.min(Math.max(split.sizes[index] + delta, lo), pair - lo);
  split.sizes[index] = a;
  split.sizes[index + 1] = pair - a;
  return l;
}
