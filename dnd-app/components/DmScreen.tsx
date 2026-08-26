"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { RibbonBar } from "@/components/RibbonBar";
import { NotebookFormatBar } from "@/components/NotebookFormatBar";
import {
  focusScrapbookBox,
  forgetScrapbookBox,
  registerScrapbookSaver,
  trackScrapbookSelection,
} from "@/components/notebookFormat";
import {
  DIVIDER_PX,
  DM_PANEL_KINDS,
  DM_PANEL_TITLES,
  DmDropTarget,
  DmGroup,
  DmLayout,
  DmNode,
  DmPanelKind,
  DmSplit,
  DmTab,
  MIN_TILE_PX,
  addTab,
  closeTab,
  defaultLayout,
  dropPreviewRect,
  dropTargetAt,
  findGroup,
  focusGroup,
  moveGroup,
  moveTab,
  parseLayout,
  resizeSplit,
  serializeLayout,
  setActiveTab,
} from "@/components/dmScreenModel";
import { LookupTool } from "@/components/LookupTool";
import { ChatTool } from "@/components/ChatTool";
import { RulesLawyerTool } from "@/components/RulesLawyerTool";
import { CalendarTool } from "@/components/CalendarTool";
import { LocationsTool } from "@/components/LocationsTool";
import { GroupTable } from "@/components/GroupTable";
import { NpcTable } from "@/components/NpcTable";
import { SessionTable } from "@/components/SessionTable";

/**
 * The DM Screen — the physical screen you sit behind, made of windows.
 *
 * Premiere's docking, matched to four filmed scenarios: the screen is
 * ONE TILING — windows always fill the whole canvas, edge to edge,
 * never floating, never overlapping. Dragging a window over another's
 * side highlights the half it would take and splits it on release;
 * over the tab strip or the centre, it stacks in as a tab; against
 * the canvas's own edge, it docks the full length of that side. The
 * bar between two windows drags to resize both at once. The highlight
 * always shows the landing before the drop commits it.
 *
 * The arrangement autosaves per person per campaign, and the Workspaces
 * menu keeps named copies of it: save the combat setup, save the prep
 * setup, switch between them. Loading one REPLACES the live screen —
 * the live screen is itself always saved, so nothing is lost beyond
 * the arrangement you just chose to leave.
 *
 * All the arithmetic — the tree, the drop zones, the shares, parsing
 * stored layouts — lives in components/dmScreenModel.ts where the unit
 * guard can reach it. This file is pointers and rendering.
 *
 * The DM check here hides a screen; the DATA is gated in
 * convex/dmscreen.ts, where every function goes through requireDm.
 */

/** The tab strip's height — the drop zones measure with the same number. */
const HEADER_PX = 34;

const SAVE_DEBOUNCE_MS = 800;

/** Travel in px before a press reads as a drag rather than a click. */
const DRAG_START_PX = 5;

export function DmScreen({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const campaigns = useQuery(api.campaigns.myCampaigns);

  const campaign = campaigns?.find((c) => c._id === campaignId) ?? null;
  const isDm = Boolean(campaign?.isDm);

  if (campaigns === undefined) {
    return <p className="centered-note">Loading…</p>;
  }
  if (!isDm) {
    return (
      <p className="centered-note">
        The DM Screen is the DM&apos;s side of the table. Nothing to see
        from this chair.
      </p>
    );
  }
  return <DmScreenBoard campaignId={campaignId} />;
}

function DmScreenBoard({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const screen = useQuery(api.dmscreen.getScreen, { campaignId });
  const saveLayout = useMutation(api.dmscreen.saveLayout);
  const saveWorkspace = useMutation(api.dmscreen.saveWorkspace);
  const updateWorkspace = useMutation(api.dmscreen.updateWorkspace);
  const deleteWorkspace = useMutation(api.dmscreen.deleteWorkspace);
  const addNote = useMutation(api.dmscreen.addNote);
  const updateNote = useMutation(api.dmscreen.updateNote);
  const deleteNote = useMutation(api.dmscreen.deleteNote);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [layout, setLayoutRaw] = useState<DmLayout | null>(null);
  const [drop, setDrop] = useState<DmDropTarget | null>(null);
  const [menu, setMenu] = useState<
    null | { kind: "add" | "workspaces"; x: number; y: number }
  >(null);
  const [error, setError] = useState<string | null>(null);

  // The drag handlers hit-test against the layout as it stands, not as
  // it stood when the drag began — a click already refocused it.
  const layoutRef = useRef<DmLayout | null>(null);
  layoutRef.current = layout;

  /** The canvas's size, the space every share is a fraction of. */
  const viewSize = useCallback(() => {
    const el = canvasRef.current;
    return el
      ? { w: el.clientWidth, h: el.clientHeight }
      : { w: 1200, h: 700 };
  }, []);

  const notes = useMemo(() => screen?.notes ?? [], [screen]);
  const noteIds = useMemo(
    () => new Set(notes.map((n) => n._id as string)),
    [notes]
  );
  const noteById = useMemo(
    () => new Map(notes.map((n) => [n._id as string, n])),
    [notes]
  );

  // Hydrate once from the server; after that the local state leads and
  // the server follows, debounced — the same shape every layout store
  // in this app uses.
  const hydrated = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (screen === undefined || hydrated.current) return;
    hydrated.current = true;
    setLayoutRaw(parseLayout(screen?.layout, noteIds) ?? defaultLayout());
  }, [screen, noteIds]);

  /* A note deleted elsewhere leaves its tabs pointing at nothing;
     re-parsing this layout would drop them, but the cheap fix in place
     is to close them directly the moment the notes list catches up. */
  useEffect(() => {
    if (!hydrated.current) return;
    setLayoutRaw((cur) => {
      if (!cur) return cur;
      const parsed = parseLayout(serializeLayout(cur), noteIds);
      return parsed ?? cur;
    });
  }, [noteIds]);

  useEffect(() => {
    if (!layout || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      void saveLayout({ campaignId, layout: serializeLayout(layout) });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [layout, campaignId, saveLayout]);

  const setLayout = useCallback(
    (fn: (cur: DmLayout) => DmLayout) => {
      dirty.current = true;
      setLayoutRaw((cur) => (cur ? fn(cur) : cur));
    },
    []
  );

  // The format toolbar serves whichever note pane holds the caret.
  useEffect(() => {
    document.addEventListener("selectionchange", trackScrapbookSelection);
    return () =>
      document.removeEventListener("selectionchange", trackScrapbookSelection);
  }, []);
  useEffect(
    () =>
      registerScrapbookSaver((boxId, html) => {
        if (!boxId.startsWith("dmnote:")) return;
        const noteId = boxId.slice("dmnote:".length);
        void updateNote({ noteId: noteId as Id<"dmNotes">, html }).catch(
          (e) => setError(e instanceof Error ? e.message : "That didn't save.")
        );
      }),
    [updateNote]
  );

  // ---- the drags ----------------------------------------------------

  /**
   * One handler for tabs and headers. A press activates and focuses at
   * once; only travel past the threshold makes it a drag. While
   * dragging, every move re-reads the drop zone under the pointer and
   * the highlight follows — the landing is shown before it happens,
   * which is the half of Premiere's behaviour people actually feel.
   * Release commits whatever the highlight last promised, or nothing.
   */
  const beginDrag = (
    groupId: number,
    tabIndex: number | null,
    e: React.PointerEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setLayout((cur) =>
      tabIndex === null
        ? focusGroup(cur, groupId)
        : setActiveTab(cur, groupId, tabIndex)
    );

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let target: DmDropTarget | null = null;

    const onMove = (ev: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX
      ) {
        return;
      }
      dragging = true;
      const rect = canvasRef.current?.getBoundingClientRect();
      const cur = layoutRef.current;
      if (!rect || !cur) return;
      const point = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      let t = dropTargetAt(
        cur,
        point,
        { w: rect.width, h: rect.height },
        HEADER_PX
      );
      // A drop that would land the window exactly where it already is
      // gets no highlight — Premiere goes dark over "nothing would
      // change" rather than promising a move it will not make.
      const group = findGroup(cur.root, groupId);
      const whole = tabIndex === null || !group || group.tabs.length === 1;
      if (t && t.type !== "root" && t.group === groupId) {
        if (t.type === "tabs" || whole) t = null;
      }
      if (t?.type === "root" && whole && cur.root?.type === "group") t = null;
      target = t;
      setDrop(t);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrop(null);
      if (dragging && target) {
        const commit = target;
        setLayout((cur) =>
          tabIndex === null
            ? moveGroup(cur, groupId, commit)
            : moveTab(cur, groupId, tabIndex, commit)
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /**
   * The bar between two windows, dragged: the pair re-divides the span
   * they already share, from the drag's start — never incrementally —
   * so a pull past the minimum and back lands under the hand.
   */
  const beginDividerDrag = (
    split: DmSplit,
    index: number,
    e: React.PointerEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const container = (e.currentTarget as HTMLElement).parentElement;
    const base = layoutRef.current;
    if (!container || !base) return;
    const r = container.getBoundingClientRect();
    const row = split.dir === "row";
    const avail = Math.max(
      1,
      (row ? r.width : r.height) - DIVIDER_PX * (split.children.length - 1)
    );
    const start = row ? e.clientX : e.clientY;
    const minFrac = MIN_TILE_PX / avail;

    const onMove = (ev: PointerEvent) => {
      const delta = ((row ? ev.clientX : ev.clientY) - start) / avail;
      dirty.current = true;
      setLayoutRaw(() => resizeSplit(base, split.id, index, delta, minFrac));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- the menus ----------------------------------------------------

  const addKind = async (kind: DmPanelKind) => {
    setMenu(null);
    if (kind === "note") {
      try {
        const noteId = await addNote({ campaignId, title: "Note" });
        setLayout((cur) =>
          addTab(cur, { kind: "note", noteId: noteId as string })
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't work.");
      }
      return;
    }
    setLayout((cur) => addTab(cur, { kind }));
  };

  const closeTabAt = (group: DmGroup, index: number) => {
    const tab = group.tabs[index];
    setLayout((cur) => closeTab(cur, group.id, index));
    // Closing a note's window deletes the note: a note with no window
    // is unreachable, and unreachable prep is a leak, not a feature.
    if (tab?.kind === "note" && tab.noteId) {
      forgetScrapbookBox(`dmnote:${tab.noteId}`);
      void deleteNote({ noteId: tab.noteId as Id<"dmNotes"> }).catch(() => {});
    }
  };

  if (!layout) return <p className="centered-note">Loading…</p>;

  const preview = drop
    ? dropPreviewRect(layout, drop, viewSize(), HEADER_PX)
    : null;

  const tileCtx: TileCtx = {
    campaignId,
    noteById,
    focused: layout.focused,
    beginDrag,
    beginDividerDrag,
    closeTabAt,
    onFocus: (groupId) => setLayout((cur) => focusGroup(cur, groupId)),
    onRenameNote: (noteId, title) =>
      void updateNote({ noteId: noteId as Id<"dmNotes">, title }).catch(
        () => {}
      ),
  };

  /**
   * The screen's controls, handed INTO the customizable toolbar. They
   * are ribbon builtins — arranged, moved and hidden in Customize like
   * everything else — whose rendering lives here because the menus
   * read this screen's state. Asked for: "move all of the buttons into
   * the toolbar above them".
   */
  /* Render CALLBACKS, not components — RibbonBar calls these to fill
     a token's slot, and the JSX they return reconciles by its own
     element types. Named in lowercase so nothing mistakes them for
     components, including the guard that hunts nested ones. */
  const menuButton =
    (kind: "add" | "workspaces", icon: string, label: string) =>
    (big: boolean) => (
      <button
        type="button"
        className={`rib-btn${big ? " rib-btn-big" : ""}`}
        title={label}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu((m) =>
            m?.kind === kind ? null : { kind, x: r.left, y: r.bottom + 4 }
          );
        }}
      >
        <span className="rib-icon">{icon}</span>
        {big && <span className="rib-label">{label}</span>}
      </button>
    );

  const extras = {
    addWindow: menuButton("add", "⊞", "Add Window"),
    workspaces: menuButton("workspaces", "⧉", "Workspaces"),
    /* Acts on whichever note window holds the caret — the same
       one-bar-per-screen contract the session notes run on. */
    noteFormat: () => (
      <div className="rib-fmt">
        <NotebookFormatBar />
      </div>
    ),
  };

  return (
    <div className="dmscreen">
      <RibbonBar campaignId={campaignId} extras={extras} />

      {/* The dropdowns PORTAL to the body: the ribbon is a horizontal
          scroll container, and an absolutely positioned menu inside one
          is clipped at the bar's own edge. Anchored to the button that
          opened them, fixed against the viewport. */}
      {menu &&
        createPortal(
          <>
            <span className="view-scrim" onClick={() => setMenu(null)} />
            <div
              className={`dm-menu${
                menu.kind === "workspaces" ? " dm-workspaces" : ""
              }`}
              style={{
                left: Math.min(menu.x, window.innerWidth - 360),
                top: menu.y,
              }}
            >
              {menu.kind === "add" ? (
                DM_PANEL_KINDS.map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    onClick={() => void addKind(kind)}
                  >
                    {DM_PANEL_TITLES[kind]}
                    {kind === "note" && (
                      <span className="muted"> — rich text</span>
                    )}
                  </button>
                ))
              ) : (
                <WorkspacesPanel
                  workspaces={screen?.workspaces ?? []}
                  onSave={(name) =>
                    void saveWorkspace({
                      campaignId,
                      name,
                      layout: serializeLayout(layout),
                    }).catch((e) =>
                      setError(
                        e instanceof Error ? e.message : "That didn't save."
                      )
                    )
                  }
                  onLoad={(ws) => {
                    const parsed = parseLayout(ws.layout, noteIds);
                    if (!parsed) {
                      setError(
                        "That workspace's layout could not be read, so the " +
                          "screen was left as it is."
                      );
                      return;
                    }
                    setLayout(() => parsed);
                    setMenu(null);
                  }}
                  onUpdate={(ws) =>
                    void updateWorkspace({
                      workspaceId: ws._id as Id<"dmWorkspaces">,
                      layout: serializeLayout(layout),
                    }).catch((e) =>
                      setError(
                        e instanceof Error ? e.message : "That didn't save."
                      )
                    )
                  }
                  onRename={(ws, name) =>
                    void updateWorkspace({
                      workspaceId: ws._id as Id<"dmWorkspaces">,
                      name,
                    }).catch((e) =>
                      setError(
                        e instanceof Error ? e.message : "That didn't save."
                      )
                    )
                  }
                  onDelete={(ws) =>
                    void deleteWorkspace({
                      workspaceId: ws._id as Id<"dmWorkspaces">,
                    }).catch((e) =>
                      setError(
                        e instanceof Error ? e.message : "That didn't work."
                      )
                    )
                  }
                />
              )}
            </div>
          </>,
          document.body
        )}

      {error && <p className="form-error">{error}</p>}

      <div className="dm-canvas" ref={canvasRef}>
        {layout.root ? (
          <TileNode node={layout.root} ctx={tileCtx} />
        ) : (
          <p className="centered-note">
            An empty screen. Add a window from the toolbar above.
          </p>
        )}

        {preview && (
          <span
            className="dm-drop"
            style={{
              left: preview.x,
              top: preview.y,
              width: preview.w,
              height: preview.h,
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// The tiling, rendered
// ---------------------------------------------------------------------

/** Everything a tile needs from the board, passed down the tree whole. */
interface TileCtx {
  campaignId: Id<"campaigns">;
  noteById: Map<string, { _id: string; title: string; html: string }>;
  focused: number | null;
  beginDrag: (
    groupId: number,
    tabIndex: number | null,
    e: React.PointerEvent
  ) => void;
  beginDividerDrag: (
    split: DmSplit,
    index: number,
    e: React.PointerEvent
  ) => void;
  closeTabAt: (group: DmGroup, index: number) => void;
  onFocus: (groupId: number) => void;
  onRenameNote: (noteId: string, title: string) => void;
}

/**
 * One node of the tree. A split is a flex run — each child's share is
 * its flex-grow over a zero basis, so the browser's division and the
 * model's layoutRects agree — with a draggable divider between every
 * pair. A group is a window frame.
 */
function TileNode({ node, ctx }: { node: DmNode; ctx: TileCtx }) {
  if (node.type === "group") return <GroupTile group={node} ctx={ctx} />;
  return (
    <div className={`dm-split dm-split-${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <span
              className="dm-divider"
              title="Drag to resize"
              onPointerDown={(e) => ctx.beginDividerDrag(node, i - 1, e)}
            />
          )}
          <div className="dm-cell" style={{ flexGrow: node.sizes[i] }}>
            <TileNode node={child} ctx={ctx} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** One window: the tab strip over whichever tab is active. */
function GroupTile({ group, ctx }: { group: DmGroup; ctx: TileCtx }) {
  const activeTab = group.tabs[group.active] ?? group.tabs[0];
  return (
    <section
      className={`dm-panel${ctx.focused === group.id ? " focus" : ""}`}
      onPointerDown={() => ctx.onFocus(group.id)}
    >
      <header
        className="dm-panel-head"
        onPointerDown={(e) => {
          // A press on a tab or its close is the tab's own drag;
          // the bare strip moves the whole window.
          if ((e.target as HTMLElement).closest("button")) return;
          ctx.beginDrag(group.id, null, e);
        }}
      >
        {group.tabs.map((tab, i) => (
          <button
            type="button"
            key={`${tab.kind}:${tab.noteId ?? i}`}
            className={`dm-tab${i === group.active ? " on" : ""}`}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest(".dm-tab-x")) return;
              ctx.beginDrag(group.id, i, e);
            }}
          >
            {tab.kind === "note"
              ? (ctx.noteById.get(tab.noteId ?? "")?.title ?? "Note")
              : DM_PANEL_TITLES[tab.kind]}
            <span
              className="dm-tab-x"
              title="Close"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx.closeTabAt(group, i);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </header>

      <div className="dm-panel-body">
        <PanelContent
          tab={activeTab}
          campaignId={ctx.campaignId}
          note={
            activeTab?.kind === "note"
              ? (ctx.noteById.get(activeTab.noteId ?? "") ?? null)
              : null
          }
          onRenameNote={ctx.onRenameNote}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// What each window shows
// ---------------------------------------------------------------------

/**
 * The registry: every DmPanelKind renders SOMETHING here, and the
 * integrity guard counts the branches against DM_PANEL_KINDS so a kind
 * added to the menu cannot open an empty window.
 */
function PanelContent({
  tab,
  campaignId,
  note,
  onRenameNote,
}: {
  tab: DmTab | undefined;
  campaignId: Id<"campaigns">;
  note: { _id: string; title: string; html: string } | null;
  onRenameNote: (noteId: string, title: string) => void;
}) {
  if (!tab) return null;
  switch (tab.kind) {
    case "spells":
    case "items":
    case "monsters":
    case "species":
    case "backgrounds":
    case "feats":
    case "classes":
      return <LookupTool kind={tab.kind} campaignId={campaignId} />;
    case "npcs":
      return <NpcTable campaignId={campaignId} />;
    case "sessions":
      return <SessionTable campaignId={campaignId} />;
    case "locations":
      return <LocationsTool campaignId={campaignId} />;
    case "groups":
      return <GroupTable campaignId={campaignId} />;
    case "chat":
      return <ChatTool campaignId={campaignId} />;
    case "calendar":
      return <CalendarTool campaignId={campaignId} />;
    case "rules":
      return <RulesLawyerTool />;
    case "reference":
      return <ReferencePanel />;
    case "note":
      return note ? (
        <DmNotePane note={note} onRename={onRenameNote} />
      ) : (
        <p className="centered-note">This note is gone.</p>
      );
  }
}

/**
 * A note window: a title you can retitle — that is the whole of what
 * makes it a "custom info panel" — over a rich text page the shared
 * format bar acts on.
 */
function DmNotePane({
  note,
  onRename,
}: {
  note: { _id: string; title: string; html: string };
  onRename: (noteId: string, title: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const boxId = `dmnote:${note._id}`;

  // The server's HTML lands only while the caret is elsewhere, or every
  // keystroke would reset it to the start — the same rule every
  // contentEditable in this app follows.
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if (el.innerHTML !== note.html) el.innerHTML = note.html;
  }, [note.html]);
  useEffect(() => () => forgetScrapbookBox(boxId), [boxId]);

  return (
    <div className="dm-note">
      <input
        className="dm-note-title"
        defaultValue={note.title}
        key={note.title}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next && next !== note.title) onRename(note._id, next);
        }}
      />
      <div
        ref={ref}
        className="nb-page dm-note-page"
        data-nb-box={boxId}
        contentEditable
        suppressContentEditableWarning
        onFocus={() => focusScrapbookBox(ref.current, boxId)}
      />
    </div>
  );
}

/** The 5e conditions, and the one line about each you actually forget. */
const CONDITIONS: { name: string; effect: string }[] = [
  { name: "Blinded", effect: "Auto-fail sight checks. Attacks against have advantage; yours have disadvantage." },
  { name: "Charmed", effect: "Can't attack the charmer. The charmer has advantage on social checks." },
  { name: "Deafened", effect: "Auto-fail hearing checks." },
  { name: "Frightened", effect: "Disadvantage while the source is in sight. Can't willingly move closer." },
  { name: "Grappled", effect: "Speed 0. Ends if the grappler is incapacitated or you're moved away." },
  { name: "Incapacitated", effect: "No actions, no reactions." },
  { name: "Invisible", effect: "Heavily obscured. Attacks against have disadvantage; yours have advantage." },
  { name: "Paralyzed", effect: "Incapacitated, can't move or speak, auto-fail STR/DEX saves. Hits within 5 ft are crits." },
  { name: "Petrified", effect: "Turned to stone. Incapacitated, resistance to all damage, immune to poison and disease." },
  { name: "Poisoned", effect: "Disadvantage on attacks and ability checks." },
  { name: "Prone", effect: "Crawl or stand. Disadvantage on attacks; melee against has advantage, ranged disadvantage." },
  { name: "Restrained", effect: "Speed 0. Attacks against have advantage; yours have disadvantage. Disadvantage on DEX saves." },
  { name: "Stunned", effect: "Incapacitated, can't move, speaks falteringly, auto-fail STR/DEX saves." },
  { name: "Unconscious", effect: "Incapacitated, drops everything, prone. Hits within 5 ft are crits." },
  { name: "Exhaustion", effect: "1 disadv. checks · 2 speed halved · 3 disadv. attacks/saves · 4 HP max halved · 5 speed 0 · 6 death." },
];

const DEATH_SAVES =
  "DC 10. Three successes stabilise, three failures kill. A nat 20 " +
  "restores 1 HP; a nat 1 counts as two failures. Damage while down is " +
  "an automatic failure, and a crit is two.";

/** The old static DM screen, kept whole as one window. */
function ReferencePanel() {
  return (
    <div className="dm-reference">
      <h2>Conditions</h2>
      <dl className="dmscreen-ref">
        {CONDITIONS.map((c) => (
          <div key={c.name}>
            <dt>{c.name}</dt>
            <dd>{c.effect}</dd>
          </div>
        ))}
      </dl>
      <h2>Death saves</h2>
      <p className="muted">{DEATH_SAVES}</p>
    </div>
  );
}

// ---------------------------------------------------------------------
// The Workspaces menu
// ---------------------------------------------------------------------

interface WorkspaceRow {
  _id: string;
  name: string;
  layout: string;
}

/**
 * The Workspaces menu's CONTENT — the frame, the scrim and the button
 * that opens it belong to the portal in DmScreenBoard, because the
 * ribbon the button lives in is a scroll container that would clip an
 * attached panel.
 *
 * Premiere's menu: click a name to switch the whole screen to it, and
 * each row carries Update (overwrite it with the current arrangement),
 * Rename and Delete. The foot saves the current arrangement under a
 * new name.
 */
function WorkspacesPanel({
  workspaces,
  onSave,
  onLoad,
  onUpdate,
  onRename,
  onDelete,
}: {
  workspaces: WorkspaceRow[];
  onSave: (name: string) => void;
  onLoad: (ws: WorkspaceRow) => void;
  onUpdate: (ws: WorkspaceRow) => void;
  onRename: (ws: WorkspaceRow, name: string) => void;
  onDelete: (ws: WorkspaceRow) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <>
      {workspaces.length === 0 && (
        <p className="muted dm-menu-note">
          No workspaces yet. Arrange the screen, then save the
          arrangement here under a name.
        </p>
      )}
      {workspaces.map((ws) =>
        renaming === ws._id ? (
          <div className="dm-ws-row" key={ws._id}>
            <input
              autoFocus
              className="detail-input"
              defaultValue={ws.name}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = e.currentTarget.value.trim();
                  if (next) onRename(ws, next);
                  setRenaming(null);
                }
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== ws.name) onRename(ws, next);
                setRenaming(null);
              }}
            />
          </div>
        ) : (
          <div className="dm-ws-row" key={ws._id}>
            <button
              type="button"
              className="dm-ws-load"
              title="Switch to this workspace"
              onClick={() => onLoad(ws)}
            >
              {ws.name}
            </button>
            <button
              type="button"
              className="text-button"
              title="Overwrite this workspace with the current arrangement"
              onClick={() => onUpdate(ws)}
            >
              Update
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setRenaming(ws._id)}
            >
              Rename
            </button>
            <button
              type="button"
              className="text-button danger"
              onClick={() => onDelete(ws)}
            >
              Delete
            </button>
          </div>
        )
      )}

      <div className="dm-ws-foot">
        {saving ? (
          <input
            autoFocus
            className="detail-input"
            placeholder="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                onSave(name.trim());
                setName("");
                setSaving(false);
              }
              if (e.key === "Escape") setSaving(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="npc-btn"
            onClick={() => setSaving(true)}
          >
            Save current as…
          </button>
        )}
      </div>
    </>
  );
}
