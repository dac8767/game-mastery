/**
 * The DM Screen's window model: panels, tabs, snapping, workspaces.
 *
 * Premiere's idea, not its implementation: the screen is a set of
 * WINDOWS the DM arranges — each one hosting a tool of this app, a
 * rich-text note, or the rules reference — and windows stack into one
 * another as TABS. What Premiere calls a workspace is a named copy of
 * the whole arrangement you can switch back to.
 *
 * Everything here is arithmetic and data — no React, no DOM, no Convex
 * — so the unit guard can exercise the parts that go wrong invisibly:
 * a snap that lands one pixel off reads as "the align is mushy", a
 * merge that drops a tab reads as "my window vanished", and a saved
 * layout from last month has to open rather than crash.
 *
 * The layout PERSISTS AS JSON in one string column. Deliberate: this
 * shape will keep changing, and a Convex validator for it would turn
 * every tweak into a migration of a personal preference blob. The
 * price is that nothing checks it on the way in — so `parseLayout`
 * trusts nothing, and every field of every panel is rebuilt from
 * whatever survives inspection.
 */

// ---------------------------------------------------------------------
// What a panel can hold
// ---------------------------------------------------------------------

/**
 * Every kind of window the screen offers.
 *
 * The Lookup tabs are separate kinds on purpose: "a spell lookup" is
 * what the DM adds, and one generic Lookup window whose kind lived in
 * panel state would be a second copy of the tab strip to keep in step.
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

export interface DmPanel {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  tabs: DmTab[];
  /** Index into tabs. */
  active: number;
}

export interface DmLayout {
  /** Back-to-front: the last panel draws on top. */
  panels: DmPanel[];
  nextId: number;
}

export const MIN_PANEL_W = 260;
export const MIN_PANEL_H = 180;

/** How close an edge has to be before it snaps, in px. */
export const SNAP_PX = 8;

// ---------------------------------------------------------------------
// Parsing — the only door stored JSON comes through
// ---------------------------------------------------------------------

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;

/**
 * A stored layout, rebuilt field by field.
 *
 * `validNoteIds` is the set of note documents that still exist: a note
 * tab whose document was deleted elsewhere is dropped here rather than
 * rendered as an empty pane titled "Note". A panel with no surviving
 * tabs goes too, and a layout with no surviving panels returns null so
 * the caller falls back to the default rather than presenting an empty
 * screen as a choice somebody made.
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

  const panelsIn = (data as { panels?: unknown }).panels;
  if (!Array.isArray(panelsIn)) return null;

  const kinds = new Set<string>(DM_PANEL_KINDS);
  const panels: DmPanel[] = [];
  let maxId = 0;

  for (const p of panelsIn) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;

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
    if (tabs.length === 0) continue;

    const id = num(o.id, 0);
    if (id <= 0) continue;
    maxId = Math.max(maxId, id);

    panels.push({
      id,
      x: num(o.x, 0),
      y: num(o.y, 0),
      w: Math.max(MIN_PANEL_W, num(o.w, MIN_PANEL_W)),
      h: Math.max(MIN_PANEL_H, num(o.h, MIN_PANEL_H)),
      tabs,
      active: Math.min(Math.max(0, num(o.active, 0)), tabs.length - 1),
    });
  }

  if (panels.length === 0) return null;
  return { panels, nextId: Math.max(maxId + 1, num((data as Record<string, unknown>).nextId, 1)) };
}

export function serializeLayout(layout: DmLayout): string {
  return JSON.stringify(layout);
}

/**
 * The screen a DM sees before arranging anything: the reference panel
 * the old DM Screen WAS — conditions and death saves — plus a monster
 * lookup beside it, so the first visit shows the idea rather than an
 * empty grey field with a menu.
 */
export function defaultLayout(view: { w: number; h: number }): DmLayout {
  const gap = 16;
  const half = Math.max(MIN_PANEL_W, Math.round((view.w - gap * 3) / 2));
  const height = Math.max(MIN_PANEL_H, view.h - gap * 2);
  return {
    panels: [
      {
        id: 1,
        x: gap,
        y: gap,
        w: half,
        h: height,
        tabs: [{ kind: "reference" }],
        active: 0,
      },
      {
        id: 2,
        x: gap * 2 + half,
        y: gap,
        w: half,
        h: height,
        tabs: [{ kind: "monsters" }, { kind: "spells" }],
        active: 0,
      },
    ],
    nextId: 3,
  };
}

// ---------------------------------------------------------------------
// Arranging
// ---------------------------------------------------------------------

/** The panel, brought to the front. Order IS the z-order. */
export function bringToFront(layout: DmLayout, panelId: number): DmLayout {
  const at = layout.panels.findIndex((p) => p.id === panelId);
  if (at === -1 || at === layout.panels.length - 1) return layout;
  const panels = [...layout.panels];
  const [p] = panels.splice(at, 1);
  panels.push(p);
  return { ...layout, panels };
}

export function patchPanel(
  layout: DmLayout,
  panelId: number,
  patch: Partial<DmPanel>
): DmLayout {
  return {
    ...layout,
    panels: layout.panels.map((p) =>
      p.id === panelId ? { ...p, ...patch } : p
    ),
  };
}

/**
 * A new window for `kind`, cascaded from the top-left.
 *
 * Cascade rather than centre: three panels added in a row must not
 * land in one pile where only the last is visible and the other two
 * read as "the menu did nothing".
 */
export function addPanel(
  layout: DmLayout,
  tab: DmTab,
  view: { w: number; h: number }
): DmLayout {
  const step = 32;
  const n = layout.panels.length;
  const w = Math.min(480, Math.max(MIN_PANEL_W, Math.round(view.w * 0.38)));
  const h = Math.min(560, Math.max(MIN_PANEL_H, Math.round(view.h * 0.6)));
  const x = Math.min(24 + (n % 8) * step, Math.max(0, view.w - w));
  const y = Math.min(24 + (n % 8) * step, Math.max(0, view.h - h));

  return {
    panels: [
      ...layout.panels,
      { id: layout.nextId, x, y, w, h, tabs: [tab], active: 0 },
    ],
    nextId: layout.nextId + 1,
  };
}

/**
 * One tab closed. A panel losing its last tab closes with it — an
 * empty window has nothing left to say and no reason to hold its
 * ground on the screen.
 */
export function closeTab(
  layout: DmLayout,
  panelId: number,
  tabIndex: number
): DmLayout {
  const panels = layout.panels.flatMap((p) => {
    if (p.id !== panelId) return [p];
    const tabs = p.tabs.filter((_, i) => i !== tabIndex);
    if (tabs.length === 0) return [];
    return [{ ...p, tabs, active: Math.min(p.active, tabs.length - 1) }];
  });
  return { ...layout, panels };
}

/**
 * Every tab of `sourceId` stacked into `targetId` — dropping a window
 * onto another's header. The moved tabs land at the end and the first
 * of them becomes active, because the thing you just dropped is the
 * thing you mean to be looking at.
 */
export function mergePanels(
  layout: DmLayout,
  sourceId: number,
  targetId: number
): DmLayout {
  if (sourceId === targetId) return layout;
  const source = layout.panels.find((p) => p.id === sourceId);
  const target = layout.panels.find((p) => p.id === targetId);
  if (!source || !target) return layout;

  const panels = layout.panels
    .filter((p) => p.id !== sourceId)
    .map((p) =>
      p.id === targetId
        ? { ...p, tabs: [...p.tabs, ...source.tabs], active: p.tabs.length }
        : p
    );
  return bringToFront({ ...layout, panels }, targetId);
}

/**
 * One tab torn out of a stack into its own window at `at`.
 *
 * The new window keeps the old one's SIZE: a tab dragged out of a big
 * reference stack is probably going to be read at the size it was
 * being read at, and a hardcoded default would make every tear-off a
 * resize chore. No-op on a single-tab panel — that is a move, and the
 * caller handles moves.
 */
export function tearOffTab(
  layout: DmLayout,
  panelId: number,
  tabIndex: number,
  at: { x: number; y: number }
): DmLayout {
  const panel = layout.panels.find((p) => p.id === panelId);
  if (!panel || panel.tabs.length < 2) return layout;
  const tab = panel.tabs[tabIndex];
  if (!tab) return layout;

  const remaining = {
    ...panel,
    tabs: panel.tabs.filter((_, i) => i !== tabIndex),
    active: 0,
  };
  return {
    panels: [
      ...layout.panels.map((p) => (p.id === panelId ? remaining : p)),
      {
        id: layout.nextId,
        x: Math.round(at.x),
        y: Math.round(at.y),
        w: panel.w,
        h: panel.h,
        tabs: [tab],
        active: 0,
      },
    ],
    nextId: layout.nextId + 1,
  };
}

// ---------------------------------------------------------------------
// Snapping — what "align them" means while dragging
// ---------------------------------------------------------------------

export interface SnapResult {
  x: number;
  y: number;
  /** Vertical guide lines to draw, as x positions. */
  vGuides: number[];
  /** Horizontal guide lines, as y positions. */
  hGuides: number[];
}

/**
 * The dragged box, pulled onto nearby edges.
 *
 * Both edges of the box are candidates against both edges of every
 * other panel and the canvas itself, which is what makes windows butt
 * up flush instead of hovering a few pixels apart. Nearest candidate
 * wins per axis; a tie keeps the earlier (left/top) edge, so the
 * result is deterministic rather than dependent on panel order.
 */
export function snapBox(
  box: { x: number; y: number; w: number; h: number },
  others: readonly { x: number; y: number; w: number; h: number }[],
  view: { w: number; h: number },
  threshold = SNAP_PX
): SnapResult {
  const vTargets = [0, view.w];
  const hTargets = [0, view.h];
  for (const o of others) {
    vTargets.push(o.x, o.x + o.w);
    hTargets.push(o.y, o.y + o.h);
  }

  let x = box.x;
  let bestV = threshold + 1;
  const vGuides: number[] = [];
  for (const t of vTargets) {
    for (const edge of [box.x, box.x + box.w]) {
      const d = Math.abs(edge - t);
      if (d < bestV) {
        bestV = d;
        x = box.x + (t - edge);
        vGuides.length = 0;
        vGuides.push(t);
      }
    }
  }

  let y = box.y;
  let bestH = threshold + 1;
  const hGuides: number[] = [];
  for (const t of hTargets) {
    for (const edge of [box.y, box.y + box.h]) {
      const d = Math.abs(edge - t);
      if (d < bestH) {
        bestH = d;
        y = box.y + (t - edge);
        hGuides.length = 0;
        hGuides.push(t);
      }
    }
  }

  return { x: Math.round(x), y: Math.round(y), vGuides, hGuides };
}

/**
 * Which panel's HEADER the pointer is over, for drop-to-merge.
 *
 * Front-most wins where headers overlap, which is why the panels are
 * walked back to front — the one you can see is the one you drop into.
 */
export function panelHeaderAt(
  layout: DmLayout,
  point: { x: number; y: number },
  headerHeight: number,
  ignoreId?: number
): number | null {
  for (let i = layout.panels.length - 1; i >= 0; i--) {
    const p = layout.panels[i];
    if (p.id === ignoreId) continue;
    if (
      point.x >= p.x &&
      point.x <= p.x + p.w &&
      point.y >= p.y &&
      point.y <= p.y + headerHeight
    ) {
      return p.id;
    }
  }
  return null;
}
