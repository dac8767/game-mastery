"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  DM_PANEL_KINDS,
  DM_PANEL_TITLES,
  DmLayout,
  DmPanel,
  DmPanelKind,
  DmTab,
  MIN_PANEL_H,
  MIN_PANEL_W,
  addPanel,
  bringToFront,
  closeTab,
  defaultLayout,
  mergePanels,
  panelHeaderAt,
  parseLayout,
  patchPanel,
  serializeLayout,
  snapBox,
  tearOffTab,
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
 * Premiere's model, asked for by name: floating panels the DM arranges,
 * each hosting one of this app's tools, a rich-text note, or the rules
 * reference the old static screen was. Windows drag by their header,
 * resize by their corner, SNAP to each other's edges while dragging
 * (which is what "align them" means in practice), and stack into one
 * another as tabs — drop a window on another's header and they share a
 * frame; drag a tab out and it is a window again.
 *
 * The arrangement autosaves per person per campaign, and the Workspaces
 * menu keeps named copies of it: save the combat setup, save the prep
 * setup, switch between them. Loading one REPLACES the live screen —
 * the live screen is itself always saved, so nothing is lost beyond
 * the arrangement you just chose to leave.
 *
 * All the arithmetic — snapping, merging, tearing off, parsing stored
 * layouts — lives in components/dmScreenModel.ts where the unit guard can
 * reach it. This file is pointers and rendering.
 *
 * The DM check here hides a screen; the DATA is gated in
 * convex/dmscreen.ts, where every function goes through requireDm.
 */

/** The tab strip's height — panelHeaderAt needs the same number. */
const HEADER_PX = 34;

const SAVE_DEBOUNCE_MS = 800;

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
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({
    v: [],
    h: [],
  });
  const [menu, setMenu] = useState<null | "add" | "workspaces">(null);
  const [error, setError] = useState<string | null>(null);

  /** The canvas's size, for placement and clamping. */
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
    setLayoutRaw(
      parseLayout(screen?.layout, noteIds) ?? defaultLayout(viewSize())
    );
  }, [screen, noteIds, viewSize]);

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
   * One handler for both gestures. Everything is computed from where
   * the drag STARTED plus total travel, never incrementally — the same
   * rule the feedback window follows, so a drag into an edge and back
   * lands under the hand.
   */
  const beginPanelDrag = (
    panel: DmPanel,
    e: React.PointerEvent,
    mode: "move" | "size"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setLayout((cur) => bringToFront(cur, panel.id));
    const startX = e.clientX;
    const startY = e.clientY;
    const from = { x: panel.x, y: panel.y, w: panel.w, h: panel.h };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const view = viewSize();
      if (mode === "move") {
        setLayoutRaw((cur) => {
          if (!cur) return cur;
          dirty.current = true;
          const others = cur.panels.filter((p) => p.id !== panel.id);
          const snapped = snapBox(
            { ...from, x: from.x + dx, y: from.y + dy },
            others,
            view
          );
          setGuides({ v: snapped.vGuides, h: snapped.hGuides });
          return patchPanel(cur, panel.id, {
            x: Math.max(0, Math.min(view.w - 48, snapped.x)),
            y: Math.max(0, Math.min(view.h - HEADER_PX, snapped.y)),
          });
        });
      } else {
        setLayout((cur) =>
          patchPanel(cur, panel.id, {
            w: Math.max(MIN_PANEL_W, Math.min(from.w + dx, view.w - from.x)),
            h: Math.max(MIN_PANEL_H, Math.min(from.h + dy, view.h - from.y)),
          })
        );
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setGuides({ v: [], h: [] });

      if (mode === "move") {
        // Dropped on another panel's header: stack into it as tabs.
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const point = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
          setLayout((cur) => {
            const target = panelHeaderAt(cur, point, HEADER_PX, panel.id);
            return target === null
              ? cur
              : mergePanels(cur, panel.id, target);
          });
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /**
   * Dragging a TAB: within its strip it just activates; carried off
   * the strip it tears out into its own window; dropped on another
   * header it stacks there. Decided at release, from geometry alone.
   */
  const beginTabDrag = (
    panel: DmPanel,
    tabIndex: number,
    e: React.PointerEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setLayout((cur) =>
      bringToFront(patchPanel(cur, panel.id, { active: tabIndex }), panel.id)
    );

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointerup", onUp);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };

      setLayout((cur) => {
        const here = cur.panels.find((p) => p.id === panel.id);
        if (!here) return cur;
        const inOwnHeader =
          point.x >= here.x &&
          point.x <= here.x + here.w &&
          point.y >= here.y &&
          point.y <= here.y + HEADER_PX;
        if (inOwnHeader) return cur;

        const target = panelHeaderAt(cur, point, HEADER_PX, panel.id);
        if (target !== null && here.tabs.length >= 2) {
          const torn = tearOffTab(cur, panel.id, tabIndex, point);
          return mergePanels(torn, torn.nextId - 1, target);
        }
        if (target !== null) return mergePanels(cur, panel.id, target);
        return tearOffTab(cur, panel.id, tabIndex, {
          x: Math.max(0, point.x - 40),
          y: Math.max(0, point.y - HEADER_PX / 2),
        });
      });
    };
    window.addEventListener("pointerup", onUp);
  };

  // ---- the menus ----------------------------------------------------

  const addKind = async (kind: DmPanelKind) => {
    setMenu(null);
    if (kind === "note") {
      try {
        const noteId = await addNote({ campaignId, title: "Note" });
        setLayout((cur) =>
          addPanel(cur, { kind: "note", noteId: noteId as string }, viewSize())
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't work.");
      }
      return;
    }
    setLayout((cur) => addPanel(cur, { kind }, viewSize()));
  };

  const closeTabAt = (panel: DmPanel, index: number) => {
    const tab = panel.tabs[index];
    setLayout((cur) => closeTab(cur, panel.id, index));
    // Closing a note's window deletes the note: a note with no window
    // is unreachable, and unreachable prep is a leak, not a feature.
    if (tab?.kind === "note" && tab.noteId) {
      forgetScrapbookBox(`dmnote:${tab.noteId}`);
      void deleteNote({ noteId: tab.noteId as Id<"dmNotes"> }).catch(() => {});
    }
  };

  if (!layout) return <p className="centered-note">Loading…</p>;

  return (
    <div className="dmscreen">
      <RibbonBar campaignId={campaignId} />

      <div className="dm-toolbar">
        <div className="dm-menu-host">
          <button
            type="button"
            className="npc-btn"
            onClick={() => setMenu((m) => (m === "add" ? null : "add"))}
          >
            + Add window
          </button>
          {menu === "add" && (
            <>
              <span className="view-scrim" onClick={() => setMenu(null)} />
              <div className="dm-menu">
                {DM_PANEL_KINDS.map((kind) => (
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
                ))}
              </div>
            </>
          )}
        </div>

        <WorkspacesMenu
          open={menu === "workspaces"}
          onToggle={() =>
            setMenu((m) => (m === "workspaces" ? null : "workspaces"))
          }
          onClose={() => setMenu(null)}
          workspaces={screen?.workspaces ?? []}
          onSave={(name) =>
            void saveWorkspace({
              campaignId,
              name,
              layout: serializeLayout(layout),
            }).catch((e) =>
              setError(e instanceof Error ? e.message : "That didn't save.")
            )
          }
          onLoad={(ws) => {
            const parsed = parseLayout(ws.layout, noteIds);
            if (!parsed) {
              setError(
                "That workspace's layout could not be read, so the screen " +
                  "was left as it is."
              );
              return;
            }
            setLayout(() => parsed);
          }}
          onUpdate={(ws) =>
            void updateWorkspace({
              workspaceId: ws._id as Id<"dmWorkspaces">,
              layout: serializeLayout(layout),
            }).catch((e) =>
              setError(e instanceof Error ? e.message : "That didn't save.")
            )
          }
          onRename={(ws, name) =>
            void updateWorkspace({
              workspaceId: ws._id as Id<"dmWorkspaces">,
              name,
            }).catch((e) =>
              setError(e instanceof Error ? e.message : "That didn't save.")
            )
          }
          onDelete={(ws) =>
            void deleteWorkspace({
              workspaceId: ws._id as Id<"dmWorkspaces">,
            }).catch((e) =>
              setError(e instanceof Error ? e.message : "That didn't work.")
            )
          }
        />

        {/* Acts on whichever note window holds the caret — the same
            one-bar-per-screen contract the session notes run on. */}
        <div className="dm-fmt">
          <NotebookFormatBar />
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="dm-canvas" ref={canvasRef}>
        {layout.panels.map((panel) => (
          <section
            key={panel.id}
            className="dm-panel"
            style={{
              left: panel.x,
              top: panel.y,
              width: panel.w,
              height: panel.h,
            }}
            onPointerDown={() => setLayout((cur) => bringToFront(cur, panel.id))}
          >
            <header
              className="dm-panel-head"
              onPointerDown={(e) => {
                // A press on a tab or its close is the tab's own drag;
                // the bare strip moves the whole window.
                if ((e.target as HTMLElement).closest("button")) return;
                beginPanelDrag(panel, e, "move");
              }}
            >
              {panel.tabs.map((tab, i) => (
                <button
                  type="button"
                  key={`${tab.kind}:${tab.noteId ?? i}`}
                  className={`dm-tab${i === panel.active ? " on" : ""}`}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest(".dm-tab-x")) return;
                    beginTabDrag(panel, i, e);
                  }}
                >
                  {tab.kind === "note"
                    ? (noteById.get(tab.noteId ?? "")?.title ?? "Note")
                    : DM_PANEL_TITLES[tab.kind]}
                  <span
                    className="dm-tab-x"
                    title="Close"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      closeTabAt(panel, i);
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </header>

            <div className="dm-panel-body">
              <PanelContent
                tab={panel.tabs[panel.active] ?? panel.tabs[0]}
                campaignId={campaignId}
                note={
                  panel.tabs[panel.active]?.kind === "note"
                    ? (noteById.get(panel.tabs[panel.active]?.noteId ?? "") ??
                      null)
                    : null
                }
                onRenameNote={(noteId, title) =>
                  void updateNote({
                    noteId: noteId as Id<"dmNotes">,
                    title,
                  }).catch(() => {})
                }
              />
            </div>

            <span
              className="dm-panel-resize"
              title="Drag to resize"
              onPointerDown={(e) => beginPanelDrag(panel, e, "size")}
            />
          </section>
        ))}

        {guides.v.map((x) => (
          <span key={`v${x}`} className="dm-guide-v" style={{ left: x }} />
        ))}
        {guides.h.map((y) => (
          <span key={`h${y}`} className="dm-guide-h" style={{ top: y }} />
        ))}

        {layout.panels.length === 0 && (
          <p className="centered-note">
            An empty screen. Add a window from the toolbar above.
          </p>
        )}
      </div>
    </div>
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
 * Premiere's Workspaces menu: click a name to switch the whole screen
 * to it. Each row also carries Update (overwrite it with the current
 * arrangement), Rename and Delete, and the foot of the menu saves the
 * current arrangement under a new name.
 */
function WorkspacesMenu({
  open,
  onToggle,
  onClose,
  workspaces,
  onSave,
  onLoad,
  onUpdate,
  onRename,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
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
    <div className="dm-menu-host">
      <button type="button" className="npc-btn" onClick={onToggle}>
        Workspaces
      </button>
      {open && (
        <>
          <span className="view-scrim" onClick={onClose} />
          <div className="dm-menu dm-workspaces">
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
                    onClick={() => {
                      onLoad(ws);
                      onClose();
                    }}
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
          </div>
        </>
      )}
    </div>
  );
}
