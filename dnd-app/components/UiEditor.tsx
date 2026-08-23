"use client";

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  EMPTY_STASH,
  Entry,
  LAYOUT_BY_ID,
  LAYOUT_PIECES,
  TEXT_BY_ID,
  TEXT_PIECES,
  UI_LIMITS,
  changedLayout,
  changedText,
  clampLayout,
  cleanText,
  decodeStash,
  encodeStash,
  exportOverrides,
  layoutFor,
  screens,
  stashKey,
  textFor,
} from "@/components/uiRegistry";

/**
 * Edit mode: change the interface from inside the interface.
 *
 * Every registered label reads through `useUiText`, so with edit mode
 * off this costs one context read and renders exactly what it always
 * rendered. With it on, each of those labels grows a dotted outline you
 * can click to rename in place, and the layout numbers grow handles you
 * can drag.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is let you drag a button to an
 * arbitrary spot on the page. The screens are flex and grid; a button
 * dragged 40px right is not a fact the layout can hold, and exporting
 * it would mean emitting absolute positions that break the first time
 * the window is a different width. So the editor moves what the layout
 * actually has knobs for — how a split divides, which pane is on top —
 * and every one of those survives the export as a number the code
 * already reads.
 *
 * Drafted locally and saved on the way out. Arranging is a dozen small
 * decisions on the way to one result, and a mutation per keystroke
 * would be a mutation per keystroke.
 */

interface UiState {
  /** Effective text: defaults with this campaign's renames applied. */
  text: Map<string, string>;
  /** Effective layout numbers. */
  layout: Map<string, number>;
  editing: boolean;
  /** Null for anyone who may not edit — a player, or a DM previewing. */
  setEditing: ((on: boolean) => void) | null;
  rename: (id: string, value: string) => void;
  setLayout: (id: string, value: number) => void;
  dirty: boolean;
  /** Registered pieces mounted on the screen right now. */
  onScreen: string[];
  /** Called by each piece as it mounts and unmounts. */
  present: (id: string, mounted: boolean) => void;
  /**
   * How a screen contributes its OWN editable structure.
   *
   * Renames and split ratios live in the registry, but a screen with a
   * real layout model — the NPC record has tabs, fields, spans and row
   * heights, all already stored per campaign — should not have that
   * model copied into the registry. It registers a saver instead, and
   * the one Save button and the one Export pick it up. Returns the
   * function that unregisters it.
   */
  registerSaver: (id: string, saver: Saver) => () => void;
}

/** A screen's own draft, plugged into the edit bar. */
export interface Saver {
  dirty: boolean;
  /** How many changes to count in the bar. */
  changes: number;
  save: () => Promise<void>;
  discard: () => void;
  /** The change, for the export. Empty string when there is none. */
  describe: () => string;
}

const UiContext = createContext<UiState | null>(null);

/** The shipped values, for anywhere outside a campaign. */
const SHIPPED: UiState = {
  text: textFor([]),
  layout: layoutFor([]),
  editing: false,
  setEditing: null,
  rename: () => {},
  setLayout: () => {},
  dirty: false,
  onScreen: [],
  present: () => {},
  registerSaver: () => () => {},
};

export function UiProvider({
  campaignId,
  canEdit,
  children,
}: {
  campaignId: Id<"campaigns">;
  /** The DM, and not previewing as a player. */
  canEdit: boolean;
  children: ReactNode;
}) {
  const stored = useQuery(api.settings.getUiOverrides, { campaignId });
  const save = useMutation(api.settings.saveUiOverrides);

  const [draftText, setDraftText] = useState<Entry<string>[] | null>(null);
  const [draftLayout, setDraftLayout] = useState<Entry<number>[] | null>(null);
  const [editing, setEditingRaw] = useState(false);

  /**
   * Which registered pieces are on the screen right now.
   *
   * Every UiText and UiSplitHandle checks in while it is mounted, so
   * the bar can say "12 labels on this screen" — or say there are none
   * and point you somewhere there are. Without it, turning edit mode on
   * from Settings shows a bar and no outlines anywhere, which reads as
   * a feature that does not work.
   */
  const [onScreen, setOnScreen] = useState<string[]>([]);
  const [savers, setSavers] = useState<{ id: string; saver: Saver }[]>([]);

  const registerSaver = useCallback((id: string, saver: Saver) => {
    setSavers((cur) => [...cur.filter((s) => s.id !== id), { id, saver }]);
    return () => setSavers((cur) => cur.filter((s) => s.id !== id));
  }, []);
  const present = useCallback((id: string, mounted: boolean) => {
    setOnScreen((cur) => {
      if (mounted) return cur.includes(id) ? cur : [...cur, id];
      return cur.filter((x) => x !== id);
    });
  }, []);

  /**
   * Edit mode outlives the screen it was switched on from.
   *
   * Every page renders its own AppShell, so navigating unmounts this
   * provider and mounts a fresh one — React state does not cross that,
   * and edit mode switched itself off exactly when you walked to the
   * screen you wanted to edit. The flag and the unsaved drafts go
   * through sessionStorage, which does.
   */
  const hydrated = useRef(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(stashKey(campaignId));
    } catch {
      // A browser set to refuse site data. Edit mode still works; it
      // just forgets itself when you change screens, which is the
      // behaviour before this existed rather than a broken one.
      setRestored(true);
      return;
    }
    const stash = decodeStash(raw);
    if (stash !== EMPTY_STASH) {
      if (stash.editing) setEditingRaw(true);
      if (stash.text.length > 0) setDraftText(stash.text);
      if (stash.layout.length > 0) setDraftLayout(stash.layout);
    }
    // Set LAST and in the same batch as the restore, so the write
    // effect below never runs with the pre-restore values — it would
    // write `editing: false` over the flag it is in the middle of
    // reading back.
    setRestored(true);
  }, [campaignId]);

  const textEntries = draftText ?? stored?.text ?? [];
  const layoutEntries = draftLayout ?? stored?.layout ?? [];

  const text = useMemo(() => textFor(textEntries), [textEntries]);
  const layout = useMemo(() => layoutFor(layoutEntries), [layoutEntries]);
  const dirty = draftText !== null || draftLayout !== null;

  const rename = useCallback(
    (id: string, value: string) => {
      if (!TEXT_BY_ID.has(id)) return;
      const clean = cleanText(value);
      setDraftText((cur) => {
        const base = cur ?? stored?.text ?? [];
        const rest = base.filter((e) => e.id !== id);
        // Back to the shipped wording is a REMOVAL, not an override
        // that happens to match. Otherwise "put it back" leaves a row
        // behind that shows up in the export as a change to nothing.
        if (!clean || clean === TEXT_BY_ID.get(id)?.value) return rest;
        return [...rest, { id, value: clean }];
      });
    },
    [stored]
  );

  const setLayoutValue = useCallback(
    (id: string, value: number) => {
      const clamped = clampLayout(id, value);
      if (clamped === null) return;
      setDraftLayout((cur) => {
        const base = cur ?? stored?.layout ?? [];
        const rest = base.filter((e) => e.id !== id);
        if (clamped === LAYOUT_BY_ID.get(id)?.value) return rest;
        return [...rest, { id, value: clamped }];
      });
    },
    [stored]
  );

  const setEditing = useCallback((on: boolean) => setEditingRaw(on), []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(
        stashKey(campaignId),
        encodeStash({
          editing,
          text: draftText ?? [],
          layout: draftLayout ?? [],
        })
      );
    } catch {
      // Refused storage is not a reason to stop editing.
    }
  }, [campaignId, restored, editing, draftText, draftLayout]);

  const value: UiState = {
    text,
    layout,
    editing: editing && canEdit,
    setEditing: canEdit ? setEditing : null,
    rename,
    setLayout: setLayoutValue,
    dirty,
    onScreen,
    present,
    registerSaver,
  };

  return (
    <UiContext.Provider value={value}>
      {children}
      {editing && canEdit && (
        <EditBar
          text={text}
          layout={layout}
          savers={savers.map((s) => s.saver)}
          onScreen={onScreen.length}
          dirty={dirty || savers.some((s) => s.saver.dirty)}
          onDiscard={() => {
            setDraftText(null);
            setDraftLayout(null);
            for (const s of savers) s.saver.discard();
          }}
          onSave={async () => {
            // The registry first, then each screen's own draft. One
            // button, because "Save" meaning "save some of what you
            // changed" is how half a layout gets written.
            await save({
              campaignId,
              text: changedText(text),
              layout: changedLayout(layout),
            });
            for (const s of savers) await s.saver.save();
            setDraftText(null);
            setDraftLayout(null);
          }}
          onClose={() => setEditingRaw(false)}
        />
      )}
    </UiContext.Provider>
  );
}

export function useUi(): UiState {
  return useContext(UiContext) ?? SHIPPED;
}

/** The current wording of one registered label. */
export function useUiText(id: string): string {
  const ui = useUi();
  return ui.text.get(id) ?? TEXT_BY_ID.get(id)?.value ?? id;
}

/** The current value of one registered layout number. */
export function useUiLayout(id: string): number {
  const ui = useUi();
  return ui.layout.get(id) ?? LAYOUT_BY_ID.get(id)?.value ?? 0;
}

/**
 * A registered label, on the page.
 *
 * Renders bare text with edit mode off — no wrapper element, so it
 * cannot change how anything lays out when nobody is editing. With edit
 * mode on it becomes a button you click to rename in place.
 */
export function UiText({ id }: { id: string }) {
  const ui = useUi();
  const value = ui.text.get(id) ?? TEXT_BY_ID.get(id)?.value ?? id;
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<DOMRect | null>(null);

  // Check in while on screen, so the bar can say how much of this
  // screen is editable — and say plainly when the answer is none.
  const { present } = ui;
  useEffect(() => {
    present(id, true);
    return () => present(id, false);
  }, [id, present]);

  if (!ui.editing) return <>{value}</>;

  const piece = TEXT_BY_ID.get(id);

  /**
   * A SPAN, never a button, and the editor opens in a portal.
   *
   * Almost every registered label sits inside something clickable — a
   * tab, a toolbar button, a checkbox label. A <button> inside a
   * <button> makes the HTML parser close the outer one, which React
   * then reports as a hydration error and the page renders wrong. An
   * <input> in there is invalid for the same reason. role="button" on a
   * span is interactive to a screen reader and inert to the parser,
   * and the rename field renders at the end of <body> where it is
   * inside nothing at all.
   */
  return (
    <>
      <span
        className="ui-edit-hit"
        role="button"
        tabIndex={0}
        title={`Rename — ${piece?.note ?? piece?.screen ?? id}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setAt(e.currentTarget.getBoundingClientRect());
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          setAt(e.currentTarget.getBoundingClientRect());
          setOpen(true);
        }}
      >
        {value}
      </span>

      {open && at && (
        <RenamePopover
          id={id}
          value={value}
          at={at}
          onDone={(next) => {
            ui.rename(id, next);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Declared at module level, not inside UiText.
 *
 * A component defined during render is a new component type every
 * render, so React remounts it and the field loses focus after one
 * keystroke. That is the exact bug this editor exists to let you avoid
 * hitting by hand, and it would be a poor showing to ship it inside
 * the editor itself. The integrity guard fails on it now.
 */
function RenamePopover({
  id,
  value,
  at,
  onDone,
  onCancel,
}: {
  id: string;
  value: string;
  /** Where the label is, so the field opens over it. */
  at: DOMRect;
  onDone: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const piece = TEXT_BY_ID.get(id);

  // Kept on screen: a label near the right edge would otherwise open a
  // field that runs off it.
  const width = Math.min(360, Math.max(200, value.length * 9 + 40));
  const left = Math.max(
    8,
    Math.min(at.left, window.innerWidth - width - 8)
  );
  const top = Math.min(at.bottom + 6, window.innerHeight - 90);

  return createPortal(
    <div
      className="ui-rename"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <label className="settings-note">
        {piece?.note ?? `Rename “${piece?.value ?? id}”`}
      </label>
      <input
        className="ui-edit-field"
        value={draft}
        autoFocus
        maxLength={UI_LIMITS.textLength}
        aria-label={`Rename ${piece?.value ?? id}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onDone(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="ui-rename-actions">
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="npc-btn primary"
          onClick={() => onDone(draft)}
        >
          Rename
        </button>
      </div>
    </div>,
    document.body
  );
}

/**
 * A draggable divider between two panes.
 *
 * Renders nothing at all with edit mode off: a handle you can nudge by
 * accident while reading a record is a layout that drifts without
 * anybody deciding anything.
 */
export function UiSplitHandle({
  id,
  axis,
}: {
  id: string;
  /** "x" for a column split, "y" for a stacked one. */
  axis: "x" | "y";
}) {
  const ui = useUi();
  const holder = useRef<HTMLSpanElement>(null);
  const start = useRef<{ at: number; from: number; size: number } | null>(null);

  const { present } = ui;
  useEffect(() => {
    present(id, true);
    return () => present(id, false);
  }, [id, present]);

  if (!ui.editing || !LAYOUT_BY_ID.has(id)) return null;
  const current = ui.layout.get(id) ?? 0;

  return (
    <span
      ref={holder}
      className={`ui-split ui-split-${axis}`}
      role="separator"
      aria-label={LAYOUT_BY_ID.get(id)?.note ?? id}
      aria-valuenow={current}
      title={`${LAYOUT_BY_ID.get(id)?.note ?? id} — now ${current}%`}
      onPointerDown={(e) => {
        // Measured off the containing grid, not guessed: the columns are
        // fluid, so a percentage read from an assumed width moves twice
        // as far as the pointer did.
        const box = holder.current?.parentElement?.getBoundingClientRect();
        if (!box) return;
        start.current = {
          at: axis === "x" ? e.clientX : e.clientY,
          from: current,
          size: axis === "x" ? box.width : box.height,
        };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.size <= 0) return;
        const moved = (axis === "x" ? e.clientX : e.clientY) - s.at;
        ui.setLayout(id, s.from + (moved / s.size) * 100);
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    />
  );
}

/** The bar along the bottom while edit mode is on. */
function EditBar({
  text,
  layout,
  savers,
  onScreen,
  dirty,
  onDiscard,
  onSave,
  onClose,
}: {
  text: Map<string, string>;
  layout: Map<string, number>;
  /** Each screen's own draft, contributing to the count and the export. */
  savers: Saver[];
  /** How many registered pieces this screen is showing. */
  onScreen: number;
  dirty: boolean;
  onDiscard: () => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);

  const changes =
    changedText(text).length +
    changedLayout(layout).length +
    savers.reduce((n, s) => n + s.changes, 0);

  return (
    <>
      <div className="ui-editbar" role="region" aria-label="Edit mode">
        <strong>Edit mode</strong>
        {/* The count is the whole difference between "this is broken"
            and "you are on the wrong screen". Settings has nothing
            registered, so switching edit mode on there used to show a
            bar and not one outline anywhere. */}
        <span className="settings-note">
          {onScreen === 0
            ? `Nothing on this screen can be edited yet. Try ${screens().join(
                " or "
              )}.`
            : `${onScreen} thing${onScreen === 1 ? "" : "s"} on this screen. ` +
              "Click an outlined label to rename it; drag a divider to move a split."}
        </span>
        <span className="ui-editbar-count">
          {changes} change{changes === 1 ? "" : "s"}
        </span>

        <button
          type="button"
          className="npc-btn"
          disabled={changes === 0}
          onClick={() => setShowExport(true)}
        >
          Export
        </button>
        <button
          type="button"
          className="npc-btn"
          disabled={!dirty || busy}
          onClick={onDiscard}
        >
          Discard
        </button>
        <button
          type="button"
          className="npc-btn primary"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            try {
              setError(null);
              await onSave();
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not save the changes."
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="npc-btn" onClick={onClose}>
          Done
        </button>
        {error && <span className="form-error">{error}</span>}
      </div>

      {showExport && (
        <ExportDialog
          text={text}
          layout={layout}
          savers={savers}
          onClose={() => setShowExport(false)}
        />
      )}
    </>
  );
}

function ExportDialog({
  text,
  layout,
  savers,
  onClose,
}: {
  text: Map<string, string>;
  layout: Map<string, number>;
  savers: Saver[];
  onClose: () => void;
}) {
  // Stamped once, when the dialog opens: a clock read on every render
  // would make the text change under the cursor while it is selected.
  const [stamp] = useState(() => new Date().toISOString().slice(0, 10));
  const own = savers.map((s) => s.describe()).filter(Boolean);
  const code = [exportOverrides(text, layout, stamp), ...own].join("\n\n");
  const [copied, setCopied] = useState(false);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="rib-modal ui-export" role="dialog" aria-label="Export">
        <header className="rib-modal-head">
          <h2>Export these changes</h2>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="settings-note">
          Every change you have made, as the values the app reads them
          from. Paste the whole block into the chat and they become the
          shipped defaults for everyone, not just this campaign.
        </p>

        <textarea className="ui-export-code" readOnly rows={16} value={code} />

        <footer className="rib-modal-foot">
          <button
            type="button"
            className="npc-btn primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                // Clipboard access can be refused outright. The text is
                // in a textarea on the screen either way, so say so
                // rather than pretending it worked.
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </footer>
      </div>
    </>
  );
}

/**
 * The switch, for Settings.
 *
 * Separate from the bar because Settings is where you turn it on and
 * the bar is what you use once it is on — and the bar has to be
 * mounted by the provider so it survives navigating to another screen
 * to edit that one.
 */
export function EditModeSwitch() {
  const ui = useUi();

  if (!ui.setEditing) {
    return (
      <p className="settings-note">
        Edit mode is the DM&apos;s. Turn off &ldquo;View as player&rdquo; to
        use it.
      </p>
    );
  }

  const changes =
    changedText(ui.text).length + changedLayout(ui.layout).length;

  return (
    <div className="ui-editswitch">
      <button
        type="button"
        className={`npc-btn${ui.editing ? " primary" : ""}`}
        aria-pressed={ui.editing}
        onClick={() => ui.setEditing?.(!ui.editing)}
      >
        {ui.editing ? "Editing — click to stop" : "Turn on edit mode"}
      </button>
      <span className="settings-note">
        {changes === 0
          ? `${TEXT_PIECES.length} labels and ${LAYOUT_PIECES.length} layout settings can be changed.`
          : `${changes} change${changes === 1 ? "" : "s"} so far.`}
      </span>
    </div>
  );
}
