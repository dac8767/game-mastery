/**
 * Every piece of the interface you are allowed to rename or resize.
 *
 * The catalogue is the whole design. An editor that can reach anything
 * on the page can also produce a page nothing can render — a button
 * dragged out of its row, a heading moved into a table cell — and an
 * "export" of that is a pile of absolute pixel offsets that fights the
 * layout the moment the window changes width. So the app declares what
 * is adjustable, in the terms the layout actually uses, and edit mode
 * can reach exactly that and nothing else.
 *
 * Which means: TEXT is anything written in the chrome, and LAYOUT is
 * the handful of numbers the CSS already reads — how a split divides,
 * which pane comes first. Both survive an export, because both are
 * values the code already has a place for.
 *
 * Free of React and Convex so the unit guard can compile it alone.
 */

/** A renameable string. */
export interface TextPiece {
  id: string;
  /** What ships when nobody has renamed it. */
  value: string;
  /** Where it is, for the export and the editor's list. */
  screen: string;
  /** What it is, when the words alone are ambiguous ("Sort", "×"). */
  note?: string;
}

/** A number the layout reads: a ratio, an order, a count. */
export interface LayoutPiece {
  id: string;
  value: number;
  screen: string;
  min: number;
  max: number;
  /** Smallest change a drag can make, so a ratio lands somewhere sane. */
  step: number;
  note: string;
}

export const UI_LIMITS = {
  /** Longest a renamed string may be. */
  textLength: 400,
  /** Longest an id may be, so a bad write cannot bloat a document. */
  idLength: 80,
  /** Most overrides one campaign may store. */
  entries: 500,
};

/**
 * The text of the NPC screens, which is where the work has been.
 *
 * Adding a screen is adding entries here and reading them through
 * `useUiText` in that screen's component — the editor, the export and
 * the guard all follow from the registry with nothing else to update.
 */
export const TEXT_PIECES: TextPiece[] = [
  // ---- the toolbar every record list wears ------------------------
  // Shared, under `list.*`, because these are the same words doing the
  // same job on the NPC roster and on Groups. Renaming "Filter" on one
  // screen and not the other would be a bug wearing a preference's
  // clothes. The two ids that name a screen's own contents — what "+
  // New" makes, what the search box searches — stay per screen.
  { id: "list.bar.group", value: "Group", screen: "Record lists" },
  { id: "list.bar.filter", value: "Filter", screen: "Record lists" },
  { id: "list.bar.sort", value: "Sort", screen: "Record lists" },
  // ---- and the two behind the ⋮ menu at the end of it --------------
  // Reset and Fields were on the bar beside Filter, Group and Sort.
  // Those three are what you are doing to the list right now; these two
  // are settings you touch once and then not again for a week, and six
  // buttons in a row all look equally likely.
  {
    id: "list.more.fields",
    value: "Hide/Show fields",
    screen: "Record lists",
    note: "In the ⋮ menu — which columns the grid shows",
  },
  {
    id: "list.more.reset",
    value: "Reset layout to default",
    screen: "Record lists",
    note: "In the ⋮ menu — columns, widths and order back to the defaults",
  },
  { id: "list.view.grid", value: "Grid", screen: "Record lists" },
  { id: "list.view.tiles", value: "Tiles", screen: "Record lists" },
  {
    id: "list.view.perRow",
    value: "Per row",
    screen: "Record lists",
    note: "How many tiles fit across, inside the View menu",
  },
  { id: "list.panel.groupBy", value: "Group by", screen: "Record lists" },
  { id: "list.panel.sortBy", value: "Sort by", screen: "Record lists" },
  {
    id: "list.panel.ascending",
    value: "↑ First to last",
    screen: "Record lists",
    note: "Shown when the sort runs A→Z",
  },
  {
    id: "list.panel.descending",
    value: "↓ Last to first",
    screen: "Record lists",
    note: "Shown when the sort runs Z→A",
  },

  // ---- what each list calls its own contents ----------------------
  {
    id: "npc.bar.search",
    value: "Search NPCs",
    screen: "NPC list",
    note: "The search box's placeholder and its label when collapsed",
  },
  { id: "npc.bar.new", value: "+ New NPC", screen: "NPC list" },
  {
    id: "group.bar.search",
    value: "Search groups",
    screen: "Groups list",
    note: "The search box's placeholder and its label when collapsed",
  },
  { id: "group.bar.new", value: "+ New Group", screen: "Groups list" },
  {
    id: "session.bar.search",
    value: "Search sessions",
    screen: "Sessions list",
    note: "The search box's placeholder and its label when collapsed",
  },
  { id: "session.bar.new", value: "+ New Session", screen: "Sessions list" },

  // ---- the NPC record ---------------------------------------------
  { id: "record.bar.back", value: "Back to NPC List", screen: "NPC record" },
  {
    id: "record.bar.hide",
    value: "Hide Character from Players",
    screen: "NPC record",
    note: "Shown while the NPC is visible to players",
  },
  {
    id: "record.bar.hidden",
    value: "Hidden from Players",
    screen: "NPC record",
    note: "Shown while the NPC is hidden",
  },
  { id: "record.info.title", value: "NPC Info", screen: "NPC record" },
  {
    id: "record.showEmpty",
    value: "Show empty fields",
    screen: "NPC record",
  },
  {
    id: "record.empty",
    value: "Nothing filled in on this tab.",
    screen: "NPC record",
  },
  { id: "record.notes.player.title", value: "Player Notes", screen: "NPC record" },
  {
    id: "record.notes.player.blurb",
    value: "Everyone at the table writes here and everyone reads it.",
    screen: "NPC record",
    note: "The helper line under the Player Notes title",
  },
  { id: "record.notes.dm.title", value: "DM Notes", screen: "NPC record" },
  {
    id: "record.notes.dm.blurb",
    value: "Yours. Never sent to a player.",
    screen: "NPC record",
    note: "The helper line under the DM Notes title",
  },
  {
    id: "record.notes.add",
    value: "Add note",
    screen: "NPC record",
    note: "Opens the editor under a notes pane",
  },
  {
    id: "record.notes.empty",
    value: "Nothing here yet.",
    screen: "NPC record",
    note: "Shown in a notes pane with no notes in it",
  },
  {
    id: "record.playerBlurb",
    value: "You can edit Player Notes. Everything else is the DM’s.",
    screen: "NPC record",
    note: "Shown to players only",
  },

  // ---- Settings ---------------------------------------------------
  // Registered mostly so the screen you turn edit mode ON from has
  // something to show. A bar that appears over a page with nothing
  // outlined on it reads as a feature that does not work — which is
  // exactly how this landed the first time.
  { id: "settings.tab.system", value: "System", screen: "Settings" },
  { id: "settings.tab.user", value: "User", screen: "Settings" },
  { id: "settings.tab.campaign", value: "Campaign", screen: "Settings" },
  { id: "settings.tab.sources", value: "Sources", screen: "Settings" },
  { id: "settings.tab.interface", value: "Interface", screen: "Settings" },
];

/**
 * The numbers, with the range each one may take.
 *
 * A ratio is stored as the left-hand share out of 100, because "the
 * fields column takes 52%" is a sentence and "52fr 47fr" is a CSS
 * implementation detail that would leak into the saved data.
 */
export const LAYOUT_PIECES: LayoutPiece[] = [
  {
    id: "record.split",
    value: 52,
    screen: "NPC record",
    min: 25,
    max: 75,
    step: 1,
    note: "How much of the width the NPC Info column takes, as a percentage",
  },
  {
    id: "record.notesSplit",
    value: 45,
    screen: "NPC record",
    min: 20,
    max: 80,
    step: 1,
    note: "How much of the notes column Player Notes takes, as a percentage",
  },
  {
    id: "record.dmNotesFirst",
    value: 0,
    screen: "NPC record",
    min: 0,
    max: 1,
    step: 1,
    note: "1 puts DM Notes above Player Notes",
  },
];

export const TEXT_BY_ID = new Map(TEXT_PIECES.map((p) => [p.id, p]));
export const LAYOUT_BY_ID = new Map(LAYOUT_PIECES.map((p) => [p.id, p]));

/** Every screen that has anything registered, in registry order. */
export function screens(): string[] {
  const seen: string[] = [];
  for (const p of [...TEXT_PIECES, ...LAYOUT_PIECES]) {
    if (!seen.includes(p.screen)) seen.push(p.screen);
  }
  return seen;
}

/** One saved change, as it is stored and as it comes back. */
export interface Entry<T> {
  id: string;
  value: T;
}

/**
 * What the screen should actually say, defaults included.
 *
 * Unknown ids are dropped rather than kept. A saved override for a
 * piece that no longer exists is a rename of nothing, and carrying it
 * forever would make the export list changes to parts of the app that
 * are gone.
 */
export function textFor(entries: Entry<string>[]): Map<string, string> {
  const out = new Map(TEXT_PIECES.map((p) => [p.id, p.value]));
  for (const e of entries ?? []) {
    if (!TEXT_BY_ID.has(e.id)) continue;
    const value = cleanText(e.value);
    if (value) out.set(e.id, value);
  }
  return out;
}

/** Same, for the numbers, each clamped to its own declared range. */
export function layoutFor(entries: Entry<number>[]): Map<string, number> {
  const out = new Map(LAYOUT_PIECES.map((p) => [p.id, p.value]));
  for (const e of entries ?? []) {
    const piece = LAYOUT_BY_ID.get(e.id);
    if (!piece) continue;
    out.set(e.id, clampLayout(e.id, e.value) ?? piece.value);
  }
  return out;
}

/**
 * A renamed string, or null if it is not a rename.
 *
 * Empty is null on purpose: a heading you have cleared is a heading you
 * meant to leave alone, not a heading with no words. Deleting the label
 * off a button is not something the editor should let you do by
 * accident, and there is no undo in a text field you have tabbed out of.
 */
export function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters go first, THEN whitespace collapses. The second
  // pass alone is not enough: a newline is whitespace and would be
  // caught by it, but a NUL or a DEL is not, and either one reaches the
  // file a rename is exported into and makes it binary to grep. A DEL
  // did exactly that to this file while it was being written.
  const text = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, UI_LIMITS.textLength) : null;
}

/** A number the layout can use, or null if the id is not a layout piece. */
export function clampLayout(id: string, raw: unknown): number | null {
  const piece = LAYOUT_BY_ID.get(id);
  if (!piece) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const stepped = Math.round(n / piece.step) * piece.step;
  return Math.min(piece.max, Math.max(piece.min, stepped));
}

/** Only what differs from the shipped default is worth storing. */
export function changedText(text: Map<string, string>): Entry<string>[] {
  return TEXT_PIECES.filter((p) => text.get(p.id) !== p.value).map((p) => ({
    id: p.id,
    value: text.get(p.id) ?? p.value,
  }));
}

export function changedLayout(layout: Map<string, number>): Entry<number>[] {
  return LAYOUT_PIECES.filter((p) => layout.get(p.id) !== p.value).map((p) => ({
    id: p.id,
    value: layout.get(p.id) ?? p.value,
  }));
}

/**
 * The changes, as something you can hand back to whoever maintains the
 * code.
 *
 * Deliberately NOT a diff of React or CSS. What edit mode changes are
 * values the app already reads from one place, so the honest export is
 * those values with the old one beside each — small enough to read
 * before pasting, and unambiguous about what it is asking for. An
 * export of generated JSX would be a much longer thing that still has
 * to be read line by line and can no longer be checked against
 * anything.
 */
export function exportOverrides(
  text: Map<string, string>,
  layout: Map<string, number>,
  stamp: string
): string {
  const textRows = changedText(text);
  const layoutRows = changedLayout(layout);
  const total = textRows.length + layoutRows.length;

  if (total === 0) {
    return `/* Game Mastery UI — ${stamp}\n   Nothing has been changed yet. */`;
  }

  const lines: string[] = [
    `/* Game Mastery UI — ${stamp}`,
    `   ${total} change${total === 1 ? "" : "s"}. Paste this whole block`,
    `   into the chat to make these the shipped defaults in`,
    `   components/uiRegistry.ts. */`,
  ];

  if (textRows.length > 0) {
    lines.push("", "TEXT_PIECES:");
    for (const row of textRows) {
      const was = TEXT_BY_ID.get(row.id)?.value ?? "";
      lines.push(
        `  { id: ${quote(row.id)}, value: ${quote(row.value)} },` +
          `   // was ${quote(was)}`
      );
    }
  }

  if (layoutRows.length > 0) {
    lines.push("", "LAYOUT_PIECES:");
    for (const row of layoutRows) {
      const was = LAYOUT_BY_ID.get(row.id)?.value ?? 0;
      lines.push(
        `  { id: ${quote(row.id)}, value: ${row.value} },   // was ${was}`
      );
    }
  }

  return lines.join("\n");
}

/**
 * A string literal that is safe to paste into a TypeScript file.
 *
 * JSON.stringify rather than adding quotes by hand: a renamed heading
 * containing a quote mark would otherwise close the literal early and
 * paste as code that does not parse, which is a strange way to find out
 * that somebody called a tab `The "Real" Story`.
 */
function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * Edit mode, written down so it survives leaving the screen.
 *
 * Every page in this app renders its own AppShell, so walking from
 * Settings to the NPC list UNMOUNTS the provider and mounts a fresh
 * one. React state does not survive that: edit mode switched itself
 * off the moment you navigated to the screen you wanted to edit, which
 * made the whole feature look like it did nothing.
 *
 * So the flag and the unsaved drafts are stashed and read back. Keyed
 * by campaign, because a draft rename belongs to the campaign it was
 * typed in and carrying it into another one would apply words from a
 * different table.
 */
export interface Stash {
  editing: boolean;
  text: Entry<string>[];
  layout: Entry<number>[];
}

export const EMPTY_STASH: Stash = { editing: false, text: [], layout: [] };

export function stashKey(campaignId: string): string {
  return `gm.editmode.${campaignId}`;
}

export function encodeStash(stash: Stash): string {
  return JSON.stringify({
    editing: Boolean(stash.editing),
    text: stash.text.filter((e) => TEXT_BY_ID.has(e.id)),
    layout: stash.layout.filter((e) => LAYOUT_BY_ID.has(e.id)),
  });
}

/**
 * Whatever came back out of storage, as something safe to render.
 *
 * Anything unreadable is the empty stash rather than a thrown error.
 * This is a convenience that remembers you were mid-edit; a stale or
 * hand-edited value in a browser store must never be able to stop the
 * app from rendering.
 */
export function decodeStash(raw: unknown): Stash {
  if (typeof raw !== "string" || !raw) return EMPTY_STASH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STASH;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY_STASH;

  const obj = parsed as Record<string, unknown>;
  const text = Array.isArray(obj.text) ? obj.text : [];
  const layout = Array.isArray(obj.layout) ? obj.layout : [];

  return {
    editing: obj.editing === true,
    text: text
      .filter(
        (e): e is Entry<string> =>
          Boolean(e) &&
          typeof (e as Entry<string>).id === "string" &&
          TEXT_BY_ID.has((e as Entry<string>).id) &&
          typeof (e as Entry<string>).value === "string"
      )
      .map((e) => ({ id: e.id, value: cleanText(e.value) ?? "" }))
      .filter((e) => e.value.length > 0),
    layout: layout
      .filter(
        (e): e is Entry<number> =>
          Boolean(e) &&
          typeof (e as Entry<number>).id === "string" &&
          LAYOUT_BY_ID.has((e as Entry<number>).id)
      )
      .map((e) => ({ id: e.id, value: clampLayout(e.id, e.value) ?? 0 })),
  };
}
