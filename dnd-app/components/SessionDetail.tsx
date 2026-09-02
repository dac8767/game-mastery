"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { FunctionArgs } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  BoxCanvas,
  BoxTools,
  NewBox,
  boxPatchInverse,
  boxPatchLabel,
  releaseBox,
} from "@/components/BoxCanvas";
import { useUndoableMutation } from "@/components/useUndoable";
import { record } from "@/components/undoHistory";
import { NoteLinkPicker } from "@/components/NoteLinkPicker";
import { NoteMentions } from "@/components/NoteMentions";
import { linkTargets } from "@/components/noteLinks";
import {
  DEFAULT_TAB,
  MAX_TAB_TITLE,
  TabKey,
  activeTabKey,
  moveKey,
  pageBoxId,
  pageTabKey,
} from "@/components/sessionTabs";
import { ColumnDef } from "@/components/npcColumns";
import {
  Leveling,
  addPlayer,
  campaignPlayers,
  chipsFromInput,
  milestoneOptions,
  playerKey,
  removePlayer,
  sessionColumnsFor,
  sessionPatch,
  withDateFormat,
} from "@/components/sessionColumns";
import { DateFormat } from "@/components/campaignCard";
import { NotebookFormatBar } from "@/components/NotebookFormatBar";
import {
  registerScrapbookSaver,
  trackScrapbookSelection,
} from "@/components/notebookFormat";

/**
 * One session, opened out of the list: the night's facts, then the
 * notes from it.
 *
 * The notes are two notebook pages rather than two text fields —
 * formatted text, images and tables, dragged where you want them. Same
 * canvas the Notebook tool draws, because it IS that canvas: BoxCanvas
 * was lifted out of NotebookTool for exactly this.
 *
 * The notes are on TABS, three of them built in and as many more as
 * anybody makes:
 *
 *   Notes          what you knew and the table did not. GM-only, and
 *                  tagged so on the strip rather than in its name.
 *   Prep           what you mean to run. Also the GM's, and separate
 *                  because prep is written before the night and notes
 *                  during it.
 *   Player Notes   the shared account of the night, which any member
 *                  may write. The same rule the NPC record's player
 *                  notes run on.
 *
 * The GM-only ones are withheld by the SERVER — sessions.getNotes never
 * queries them for a non-GM caller, not even for their titles, so there
 * is no version of this screen, and no devtools tab, in which a player
 * has that text. This component draws the tabs it was SENT; it has no
 * list of its own to filter, which is why there is no `isDm &&` on the
 * strip below.
 *
 * Tabs rather than panes side by side. A GM reads one at a time — you
 * are either writing what happened or writing what you are not telling
 * them — and the split made both halves narrow to show a second page
 * that was usually not the one being looked at. It also answers the
 * question one shared toolbar could not: which page a new box lands on
 * is the page you are looking at.
 *
 * The format toolbar is mounted once, here, rather than inside each
 * canvas. notebookFormat holds one saver and one tracked selection for
 * the whole document, so two canvases each registering their own would
 * leave whichever mounted last writing both sides' edits. It sits under
 * the tabs, at the top of the page it acts on.
 */

export type SessionRow = {
  _id: Id<"sessions">;
  _creationTime: number;
  number: number;
  date: string | null;
  players: string[];
  xp: number | null;
  milestone: number | null;
  description: string | null;
};

export function SessionDetail({
  session,
  campaignId,
  isDm,
  onClose,
}: {
  session: SessionRow;
  campaignId: Id<"campaigns">;
  isDm: boolean;
  onClose: () => void;
}) {
  const notes = useQuery(api.sessions.getNotes, { sessionId: session._id });

  /* Who the attendance field offers. Two queries because neither alone
     is the table: members are the accounts, characters carry the name
     of a player who never made one. Both are small and only mounted
     while a session is open. */
  const members = useQuery(api.campaigns.listMembers, { campaignId });
  const characters = useQuery(api.campaigns.listCharacters, { campaignId });

  /* What the notes can link to. The same three lists their own screens
     subscribe to, so a name here is a name the destination will find. */
  const npcs = useQuery(api.npcs.listForCampaign, { campaignId });
  const locations = useQuery(api.locations.listForCampaign, { campaignId });
  const groups = useQuery(api.groups.listForCampaign, { campaignId });
  const targets = useMemo(
    () =>
      linkTargets({
        npcs: npcs?.npcs,
        locations: locations?.locations,
        groups: groups?.groups,
      }),
    [npcs, locations, groups]
  );
  const router = useRouter();
  const players = useMemo(
    () => campaignPlayers(members, characters),
    [members, characters]
  );

  /* Which leveling field the facts row shows — XP Awarded, or the
     milestone dropdown. myCampaigns is AppShell's subscription. */
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const leveling: Leveling =
    campaigns?.find((c) => c._id === campaignId)?.leveling ?? "xp";
  /* How the date reads to somebody who cannot edit it — the same
     Settings choice the list honours. AppShell's subscription. */
  const settings = useQuery(api.settings.mySettings);
  const dateFormat: DateFormat = settings?.dateFormat ?? "dmy";
  const columns = useMemo(
    () => withDateFormat(sessionColumnsFor(leveling), dateFormat),
    [leveling, dateFormat]
  );

  /* Every session, for the milestone dropdown's options: a level one
     night reached is not on offer to another. The same query the list
     screen holds, so this is not a second subscription in practice. */
  const allSessions = useQuery(api.sessions.listForCampaign, { campaignId });
  const levelOptions = useMemo(
    () =>
      milestoneOptions(
        allSessions?.sessions ?? [],
        session.number,
        session.milestone
      ),
    [allSessions, session.number, session.milestone]
  );

  const updateSession = useUndoableMutation(api.sessions.updateSession);
  const deleteSession = useMutation(api.sessions.deleteSession);
  const addBox = useMutation(api.sessions.addBox);
  const updateBox = useMutation(api.sessions.updateBox);
  const deleteBox = useMutation(api.sessions.deleteBox);
  const setBody = useMutation(api.sessions.setBody);
  const generateUploadUrl = useMutation(api.sessions.generateUploadUrl);
  const createTab = useMutation(api.sessions.createTab);
  const renameTab = useUndoableMutation(api.sessions.renameTab);
  const deleteTab = useMutation(api.sessions.deleteTab);
  const reorderTabs = useMutation(api.sessions.reorderTabs);

  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* Which tab is open — as a WANT, not as an answer. What is actually
     shown is settled against the tabs the server sent, so a tab deleted
     out from under you falls back to the first rather than leaving the
     canvas keyed to a page nobody can read.

     The GM's own is the want to start with: it is the one they are
     writing during a session, and the player page is the one they read
     back afterwards. A player is not sent it and lands on their own. */
  const [tab, setTab] = useState<TabKey>(DEFAULT_TAB);

  /* The quick way to make a tab — the + on the strip — and the editor,
     which is every other thing that can be done to the strip. Two
     states rather than one, because they are two doors: the + is the
     one people reach for, and the editor is where the rest live so
     the strip itself stays a row of names. */
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDmOnly, setNewDmOnly] = useState(false);
  const [editing, setEditing] = useState(false);

  /* True on success, so a form in the editor knows whether to close.
     The message itself goes to the record's error line, which is above
     the tabs where every other error on this screen lands. */
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      return false;
    }
  }, []);

  /**
   * One door for every change to a box or a page body, so every one of
   * them can be taken back. The way back is what the tab holds NOW,
   * read at the moment of the change — through a ref, because the
   * format toolbar's saver is registered once and would otherwise see
   * the tabs as they were when it mounted.
   */
  const tabsRef = useRef<NonNullable<typeof notes>["tabs"]>([]);
  tabsRef.current = notes?.tabs ?? [];
  const sessionName = `Session ${session.number}`;

  const patchBox = useCallback(
    async (boxId: string, patch: Record<string, unknown>) => {
      type Args = FunctionArgs<typeof api.sessions.updateBox>;
      const id = boxId as Id<"sessionBoxes">;
      const home = tabsRef.current.find((t) =>
        t.boxes.some((b) => b._id === boxId)
      );
      const box = home?.boxes.find((b) => b._id === boxId);
      const next = { boxId: id, ...patch } as Args;
      const prev = {
        boxId: id,
        ...(box ? boxPatchInverse(box, patch) : {}),
      } as Args;
      await updateBox(next);
      const label = `${boxPatchLabel(patch, box?.type ?? "text")} on ${
        home?.title ?? "a tab"
      } of ${sessionName}`;
      // A box you are standing in refuses the server's text; step out
      // of it first, so what comes back is seen.
      record({
        label,
        undo: () => {
          releaseBox(boxId);
          return updateBox(prev);
        },
        redo: () => {
          releaseBox(boxId);
          return updateBox(next);
        },
      });
    },
    [updateBox, sessionName]
  );

  const saveBody = useCallback(
    async (side: TabKey, html: string) => {
      const tab = tabsRef.current.find((t) => t.key === side);
      const next = { sessionId: session._id, side, html };
      const prev = { sessionId: session._id, side, html: tab?.body ?? "" };
      await setBody(next);
      const label = `Notes on ${tab?.title ?? "a tab"} of ${sessionName}`;
      const id = pageBoxId(side);
      record({
        label,
        undo: () => {
          releaseBox(id);
          return setBody(prev);
        },
        redo: () => {
          releaseBox(id);
          return setBody(next);
        },
      });
    },
    [setBody, session._id, sessionName]
  );

  // The format toolbar acts on whichever box the caret is in, and the
  // caret is gone by the time a button's click would fire — so the
  // selection is tracked continuously instead.
  useEffect(() => {
    document.addEventListener("selectionchange", trackScrapbookSelection);
    return () =>
      document.removeEventListener("selectionchange", trackScrapbookSelection);
  }, []);

  // notebookFormat is a plain DOM helper and knows nothing about Convex;
  // this is the one place on this screen that hands it a way to persist.
  // Without it a format is applied on screen and lost on reload.
  //
  // The toolbar knows only that it edited a region with an id. Two
  // kinds of region answer to that now — the boxes, and the page they
  // sit on — so the id says which, and this is where it is read. See
  // components/notePage.ts.
  useEffect(
    () =>
      registerScrapbookSaver((boxId, html) => {
        const side = pageTabKey(boxId);
        void run(() =>
          side ? saveBody(side, html) : patchBox(boxId, { html })
        );
      }),
    [run, patchBox, saveBody]
  );

  const uploadImage = async (
    side: TabKey,
    file: File
  ): Promise<string | null> => {
    try {
      setError(null);
      const url = await generateUploadUrl({ sessionId: session._id, side });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) throw new Error("The image upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      return storageId;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      return null;
    }
  };

  const canvasProps = (side: TabKey) => ({
    onAdd: (box: NewBox) =>
      void run(() =>
        addBox({
          sessionId: session._id,
          side,
          ...box,
          storageId: box.storageId as Id<"_storage"> | undefined,
        })
      ),
    onUpdate: (boxId: string, patch: Record<string, unknown>) =>
      void run(() => patchBox(boxId, patch)),
    onDelete: (boxId: string) =>
      void run(() => deleteBox({ boxId: boxId as Id<"sessionBoxes"> })),
    onUploadImage: (file: File) => uploadImage(side, file),
    onFollowLink: (href: string) => router.push(href),
  });

  /**
   * Which page you are on — and so which page a new box lands on.
   *
   * The visible tab, which is the only answer that needs no explaining.
   * It was "whichever side you are" before, which meant a GM had no way
   * to put a picture on the player page at all.
   *
   * Settled against the tabs the SERVER sent, so the want above cannot
   * outlive the tab it names. A player is sent no GM tab and cannot
   * land on one by any state this component holds.
   */
  const tabs = notes?.tabs ?? [];
  const side: TabKey = activeTabKey(tabs, tab);
  const current = tabs.find((t) => t.key === side) ?? null;

  /**
   * Rearranging: the strip's keys, and one call that saves a new order.
   *
   * Every way of moving a tab in the editor — a drop, Move up, Move
   * down — is moveKey over these keys, and moveKey hands back the same
   * array when there is nothing to do, so a drop onto the tab's own
   * place or a Move up at the top is no round trip rather than a write
   * of what is already there. The server settles the order against the
   * strip it SENT, so a list built from `tabs` is the only list it
   * will accept.
   */
  const keys = tabs.map((t) => t.key);
  const arrange = (next: TabKey[]) => {
    if (next === keys) return;
    void run(() => reorderTabs({ sessionId: session._id, order: next }));
  };

  const title = `Session ${session.number}`;

  return (
    <section className="npc-record" aria-label={`${title} — full notes`}>
      <div className="record-bar">
        <button
          type="button"
          className="npc-btn primary record-back"
          onClick={onClose}
        >
          Back to Sessions
        </button>

        {isDm &&
          (confirmDelete ? (
            <span className="record-confirm">
              <span className="settings-note">
                Delete this session and every tab of its notes?
              </span>
              <button
                type="button"
                className="npc-btn"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </button>
              <button
                type="button"
                className="npc-btn danger"
                onClick={() =>
                  void run(async () => {
                    await deleteSession({ sessionId: session._id });
                    onClose();
                  })
                }
              >
                Delete
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="npc-btn"
              onClick={() => setConfirmDelete(true)}
            >
              Delete session
            </button>
          ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="record-body session-record">
        <header className="record-head">
          <div className="record-titles">
            <div className="detail-field record-title">
              <div className="detail-value">{title}</div>
            </div>
          </div>
        </header>

        {/* Every field the list shows, here as well and editable here
            too. It used to be three chips and a line saying the facts
            were edited in the list — which is a screen telling you to
            go and use a different screen. The definitions come from
            SESSION_COLUMNS, so the two places cannot end up offering
            different fields. */}
        <section className="session-facts">
          {columns.map((col) => (
            <SessionField
              key={col.key}
              col={col}
              value={toInput(session, col.key)}
              editable={isDm}
              options={col.key === "players" ? players : undefined}
              levels={col.kind === "level" ? levelOptions : undefined}
              onCommit={(text) => {
                const patch = sessionPatch(col.key, text);
                // Nothing to write is a normal outcome — a blank
                // session number, or a word where a number goes.
                if (Object.keys(patch).length === 0) return;
                // The way back is the field's old text through the
                // same conversion, so a blank clears in both directions.
                const before = sessionPatch(col.key, toInput(session, col.key));
                void run(() =>
                  updateSession(
                    { sessionId: session._id, ...patch },
                    { sessionId: session._id, ...before },
                    `${col.label} of ${sessionName}`
                  )
                );
              }}
            />
          ))}
        </section>

        <section
          /* The red edge follows the TAB's visibility, not its name:
             Prep and a hidden tab somebody made are as much "not for
             the table" as Notes, and a page that looks identical to
             the shared one is a page you will paste the wrong thing
             into. */
          className={`session-notes${current?.dmOnly ? " dm-notes" : ""}`}
        >
          {/* The tabs ARE the heading — the names, one of them current
              — so there is no separate title above them repeating
              whichever is open.

              Drawn from what the server sent and nothing else. A tab
              this person may not see is not in the list, so there is no
              `dmOnly &&` here to get wrong, and the GM tag on the ones
              that are hidden is a reminder to the GM rather than a
              gate. */}
          {notes && tabs.length > 0 && (
            <div className="session-tabs">
              {/* The tablist holds tabs and nothing else — the add
                  button and the pencil are not pages you can switch
                  to. `display: contents` keeps it out of the layout,
                  so the strip is still one flex row and the open tab
                  still breaks the rule underneath it.

                  The strip is a row of NAMES, and only that. What can
                  be done to them — moved, renamed, deleted — is behind
                  the pencil, so a tab does not carry a toolbar and the
                  line does not change length depending on which one is
                  open. Reported: the actions beside the tabs read as
                  part of the page. */}
              <div className="session-tab-strip" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={t.key === side}
                    className={`session-tab${t.key === side ? " on" : ""}`}
                    onClick={() => setTab(t.key)}
                  >
                    {t.title}
                    {t.dmOnly && <span className="dm-tag">GM</span>}
                  </button>
                ))}
              </div>

              {/* Where a new tab goes is where the last one is, which
                  is the one place people already look for it. Kept on
                  the strip, apart from the editor, because making a
                  tab is the thing people do most and should not need
                  a menu opened first. */}
              <button
                type="button"
                className="session-tab-add"
                title="Add a Tab"
                aria-label="Add a Tab"
                onClick={() => {
                  setAdding(true);
                  setNewTitle("");
                  setNewDmOnly(false);
                  setEditing(false);
                }}
              >
                +
              </button>

              {/* Discreet: a dim pencil at the end of the row, which
                  opens the editor. Everything else the strip can have
                  done to it is in there. */}
              <button
                type="button"
                className={`session-tab-edit${editing ? " open" : ""}`}
                title="Edit Tabs"
                aria-label="Edit Tabs"
                aria-expanded={editing}
                onClick={() => {
                  setEditing((v) => !v);
                  setAdding(false);
                }}
              >
                ✎
              </button>

              {editing && (
                <>
                  {/* Closes on a click anywhere else, which is the
                      gesture everybody already tries. */}
                  <span className="view-scrim" onClick={() => setEditing(false)} />
                  <TabEditor
                    tabs={tabs}
                    canHide={notes.isDm}
                    onArrange={arrange}
                    onRename={(key, title) =>
                      run(() => {
                        const tabId = key as Id<"sessionTabs">;
                        const was =
                          tabs.find((t) => t.key === key)?.title ?? title;
                        return renameTab(
                          { tabId, title },
                          { tabId, title: was },
                          `Name of tab ${was}`
                        );
                      })
                    }
                    onDelete={(key) =>
                      run(async () => {
                        await deleteTab({ tabId: key as Id<"sessionTabs"> });
                        // Back to the first tab, which activeTabKey
                        // would do anyway — said here too so the want
                        // does not sit pointing at a tab that is gone.
                        if (key === side) setTab(DEFAULT_TAB);
                      })
                    }
                    onAdd={(title, dmOnly) =>
                      run(async () => {
                        const key = await createTab({
                          sessionId: session._id,
                          title,
                          dmOnly,
                        });
                        // Onto the tab you just made, because you
                        // made it to write on it.
                        setTab(key);
                      })
                    }
                    onClose={() => setEditing(false)}
                  />
                </>
              )}
            </div>
          )}

          {adding && (
            <TabNameForm
              label="Name This Tab"
              value={newTitle}
              onChange={setNewTitle}
              secret={notes?.isDm ? newDmOnly : null}
              onSecret={setNewDmOnly}
              submitLabel="Add Tab"
              onCancel={() => setAdding(false)}
              onSubmit={() =>
                void run(async () => {
                  const key = await createTab({
                    sessionId: session._id,
                    title: newTitle,
                    dmOnly: newDmOnly,
                  });
                  setAdding(false);
                  // Onto the tab you just made, because you made it to
                  // write on it.
                  setTab(key);
                })
              }
            />
          )}

          {/* Under the tabs rather than above them: it acts on the page
              below it, and a toolbar floating above the thing that
              names the page reads as belonging to the record.

              And not before the notes have ARRIVED. `side` is read from
              the open tab, and the GM tab does not exist until the
              server has said there is a GM side — so in the window
              between opening a session and getNotes answering, a GM's
              toolbar points at the PLAYER page. It rendered there, so
              "add a text box" in that second put the box, and then
              whatever was typed into it, on the page the table can
              read. There is nothing to write to yet anyway. */}
          {notes && (
            <>
              <NotebookFormatBar
                trailing={
                  <>
                    <NoteLinkPicker campaignId={campaignId} targets={targets} />
                    <BoxTools
                      onAdd={canvasProps(side).onAdd}
                      onUploadImage={(file) => uploadImage(side, file)}
                    />
                  </>
                }
              />

              {/* Renders nothing until somebody types `#`, and then a
                  list at the caret. Mounted here, beside the toolbar,
                  because both read the same tracked caret. */}
              <NoteMentions campaignId={campaignId} targets={targets} />
            </>
          )}

          {notes === undefined ? (
            <p className="centered-note">Opening the notes…</p>
          ) : notes === null ? (
            /* Deleted out from under you — by you in another tab, or by
               nobody, but either way there is nothing to draw and an
               empty canvas would invite you to write into it. */
            <p className="centered-note">This session is gone.</p>
          ) : (
            /* Keyed by side, so switching tabs builds a fresh canvas
               rather than re-pointing the live one. The page is a
               contentEditable holding its own DOM, and handing it a
               different document to be is how the wrong side's text
               gets saved over the right one. */
            <BoxCanvas
              key={side}
              boxes={current?.boxes ?? []}
              canEdit
              tools="elsewhere"
              inlineImages
              page={{
                id: pageBoxId(side),
                html: current?.body ?? "",
                onChange: (html) => void run(() => saveBody(side, html)),
              }}
              {...canvasProps(side)}
            />
          )}
        </section>
      </div>
    </section>
  );
}

/** One tab as the server sent it, as far as the editor needs to know. */
type EditableTab = {
  key: TabKey;
  title: string;
  dmOnly: boolean;
  builtin: boolean;
  canManage: boolean;
};

/**
 * The tab editor: every tab as a row, and everything that can be done
 * to the strip.
 *
 * Move by dragging a row, or by the up and down arrows — the arrows
 * are the keyboard's and a touchscreen's way of doing what the drag
 * does. Rename and delete are on the rows that are somebody's to
 * change; a built-in shows why it is not. And a new tab, at the
 * bottom, because "add" belongs on the list it adds to.
 *
 * Declared at MODULE scope, which the drag needs: a component defined
 * inside SessionDetail would be a new type on every render, and the
 * parent re-renders on every server echo mid-drag — see DndColumns.
 * setData on dragstart is what lets WebKit start the drag at all.
 *
 * The rows are the tabs the server SENT, in the order it sent them —
 * the editor holds no list of its own and moves nothing locally. A
 * move is a round trip, and the rows reorder when the strip does, so
 * what the editor shows and what the strip shows cannot disagree.
 *
 * The callbacks answer true on success. That is how a rename knows to
 * close its field and a confirm knows to go away, without the editor
 * seeing the error, which the record shows above the tabs.
 */
function TabEditor({
  tabs,
  canHide,
  onArrange,
  onRename,
  onDelete,
  onAdd,
  onClose,
}: {
  tabs: EditableTab[];
  /** Whether "Only I Can See This" is on offer — the GM's, not a player's. */
  canHide: boolean;
  onArrange: (next: TabKey[]) => void;
  onRename: (key: TabKey, title: string) => Promise<boolean>;
  onDelete: (key: TabKey) => Promise<boolean>;
  onAdd: (title: string, dmOnly: boolean) => Promise<boolean>;
  onClose: () => void;
}) {
  const keys = tabs.map((t) => t.key);

  /* A row in the air, and the row it is over. Both gone when the drag
     ends however it ends — a drop outside the list fires dragend and
     nothing else, and a row left marked "over" is a stripe that never
     goes away. */
  const [dragKey, setDragKey] = useState<TabKey | null>(null);
  const [overKey, setOverKey] = useState<TabKey | null>(null);

  /* Renaming one, the confirm before deleting one, and the add form.
     Three narrow states rather than one mode enum: they are mutually
     exclusive on screen but not in meaning. */
  const [renaming, setRenaming] = useState<TabKey | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmKey, setConfirmKey] = useState<TabKey | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDmOnly, setNewDmOnly] = useState(false);

  const only = (what: "rename" | "confirm" | "add" | null, key?: TabKey) => {
    setRenaming(what === "rename" ? (key ?? null) : null);
    setConfirmKey(what === "confirm" ? (key ?? null) : null);
    setAdding(what === "add");
  };

  return (
    <div className="session-tab-editor" role="dialog" aria-label="Edit Tabs">
      <div className="session-tab-editor-head">
        <span>Tabs</span>
        <button type="button" className="text-button" onClick={onClose}>
          Done
        </button>
      </div>

      {tabs.map((t, idx) => (
        <div key={t.key}>
          {renaming === t.key ? (
            <TabNameForm
              label="Rename This Tab"
              value={renameText}
              onChange={setRenameText}
              secret={null}
              submitLabel="Rename"
              onCancel={() => only(null)}
              onSubmit={() =>
                void onRename(t.key, renameText).then((ok) => {
                  if (ok) only(null);
                })
              }
            />
          ) : (
            <div
              className={`dnd-row session-tab-row${
                t.key === dragKey ? " dragging" : ""
              }${t.key === overKey && t.key !== dragKey ? " over" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", t.key);
                e.dataTransfer.effectAllowed = "move";
                setDragKey(t.key);
              }}
              onDragOver={(e) => {
                if (dragKey === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overKey !== t.key) setOverKey(t.key);
              }}
              onDragLeave={() => {
                if (overKey === t.key) setOverKey(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragKey !== null) onArrange(moveKey(keys, dragKey, idx));
                setDragKey(null);
                setOverKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setOverKey(null);
              }}
            >
              <span className="dnd-grip" title="Drag to Move">
                ⋮⋮
              </span>
              <span className="session-tab-row-title">{t.title}</span>
              {t.dmOnly && <span className="dm-tag">GM</span>}
              {t.builtin && <span className="dnd-structural">Built In</span>}

              <span className="session-tab-row-btns">
                <button
                  type="button"
                  className="dnd-rowbtn"
                  title="Move Up"
                  aria-label="Move Up"
                  disabled={idx === 0}
                  onClick={() => onArrange(moveKey(keys, t.key, idx - 1))}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="dnd-rowbtn"
                  title="Move Down"
                  aria-label="Move Down"
                  disabled={idx === keys.length - 1}
                  onClick={() => onArrange(moveKey(keys, t.key, idx + 1))}
                >
                  ▼
                </button>
                {/* Only on a tab that is somebody's to change: the
                    built-ins are nobody's, and a tab a player made is
                    theirs and the GM's. The server decides which, and
                    sends the answer with the tab. */}
                {t.canManage && (
                  <>
                    <button
                      type="button"
                      className="dnd-rowbtn"
                      title="Rename"
                      aria-label={`Rename ${t.title}`}
                      onClick={() => {
                        setRenameText(t.title);
                        only("rename", t.key);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="dnd-rowbtn"
                      title="Delete Tab"
                      aria-label={`Delete ${t.title}`}
                      onClick={() => only("confirm", t.key)}
                    >
                      ×
                    </button>
                  </>
                )}
              </span>
            </div>
          )}

          {confirmKey === t.key && (
            <p className="record-confirm session-tab-confirm">
              <span className="settings-note">
                Delete “{t.title}” and everything written on it?
              </span>
              <button
                type="button"
                className="npc-btn"
                onClick={() => only(null)}
              >
                Keep
              </button>
              <button
                type="button"
                className="npc-btn danger"
                onClick={() =>
                  void onDelete(t.key).then((ok) => {
                    if (ok) only(null);
                  })
                }
              >
                Delete
              </button>
            </p>
          )}
        </div>
      ))}

      {adding ? (
        <TabNameForm
          label="Name This Tab"
          value={newTitle}
          onChange={setNewTitle}
          secret={canHide ? newDmOnly : null}
          onSecret={setNewDmOnly}
          submitLabel="Add Tab"
          onCancel={() => only(null)}
          onSubmit={() =>
            void onAdd(newTitle, newDmOnly).then((ok) => {
              if (ok) only(null);
            })
          }
        />
      ) : (
        <button
          type="button"
          className="dnd-row session-tab-row session-tab-row-add"
          onClick={() => {
            setNewTitle("");
            setNewDmOnly(false);
            only("add");
          }}
        >
          + Add a Tab
        </button>
      )}
    </div>
  );
}

/**
 * Naming a tab — the one form, used to add and to rename.
 *
 * Two call sites and one component, because they are the same three
 * controls with different words on them, and the interesting behaviour
 * is behaviour neither would get by being written out twice: Enter
 * submits, Escape backs out, and the field takes focus so a click on
 * "Add a Tab" is followed by typing rather than by another click.
 *
 * `secret` is null where the choice does not exist — renaming never
 * changes who can see a tab, and a player is not offered a hidden one
 * at all (the server refuses it, and an option that is always refused
 * is not an option).
 */
function TabNameForm({
  label,
  value,
  onChange,
  secret,
  onSecret,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret: boolean | null;
  onSecret?: (v: boolean) => void;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="session-tab-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() === "") return;
        onSubmit();
      }}
    >
      <input
        autoFocus
        className="detail-input"
        value={value}
        placeholder={label}
        aria-label={label}
        maxLength={MAX_TAB_TITLE}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />

      {secret !== null && (
        <label className="session-tab-secret">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => onSecret?.(e.target.checked)}
          />
          Only I Can See This
        </label>
      )}

      <button
        type="submit"
        className="npc-btn primary"
        disabled={value.trim() === ""}
      >
        {submitLabel}
      </button>
      <button type="button" className="npc-btn" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/**
 * A session's field as text, for the input to start from.
 *
 * The inverse of sessionPatch, and the two have to agree: attendance
 * goes in comma-separated because that is how it comes back out.
 */
function toInput(session: SessionRow, key: string): string {
  const raw = (session as unknown as Record<string, unknown>)[key];
  if (Array.isArray(raw)) return (raw as string[]).join(", ");
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

/**
 * One of the night's facts, labelled, and edited in place.
 *
 * Committed on blur rather than per keystroke: every one of these is a
 * mutation on a shared document, and a write per character would be a
 * write per character. Escape puts back what was there, which is the
 * only way out of a half-typed edit that does not save it.
 */
function SessionField({
  col,
  value,
  editable,
  options,
  levels,
  onCommit,
}: {
  col: ColumnDef;
  value: string;
  editable: boolean;
  /** For the attendance field: the roster, as PlayerPicker offers it. */
  options?: string[];
  /** For a `level` field: the levels still available to pick. */
  levels?: number[];
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Follow the live query when the row redelivers — someone else may be
  // editing the same session — but not while this box has the caret.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  /**
   * Escape, on its way out through blur.
   *
   * Escape puts the old text back and leaves the field, and leaving the
   * field is what saves — so the two ran in that order and Escape SAVED
   * the edit it was pressed to abandon. setDraft is queued, blur() is
   * not: by the time onBlur reads `draft` it is still the half-typed
   * text, which does not equal `value`, which is a write.
   *
   * A ref rather than a state flag, for the same reason: it is set and
   * read inside one event, before React has re-rendered anything.
   */
  const cancelled = useRef(false);

  const commit = () => {
    setFocused(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    if (draft === value) return;
    onCommit(draft);
  };

  return (
    <label className={`detail-field session-field sf-${col.key}`}>
      <div className="detail-label">{col.label}</div>
      {!editable ? (
        <div className="detail-value">
          {value ? (col.format ? col.format(value) : value) : "—"}
        </div>
      ) : col.kind === "level" ? (
        /* A dropdown, not a number box: the milestone is one of the
           levels the campaign has not reached yet, and the empty row
           is a real answer — most sessions level nobody. Committed on
           change; there is no draft to hold, a select IS its value. */
        <select
          className="detail-input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onCommit(e.target.value);
          }}
        >
          <option value="">—</option>
          {(levels ?? []).map((l) => (
            <option key={l} value={l}>
              Level {l}
            </option>
          ))}
        </select>
      ) : col.kind === "longtext" ? (
        <textarea
          className="detail-input"
          rows={2}
          value={draft}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : col.kind === "chips" ? (
        /* Attendance is picked, not typed: the roster from Settings is
           the list, and each pick is a commit of its own — there is no
           half-typed line to hold, so no draft. The value is the live
           row, and what comes back from the server is what shows. */
        <PlayerPicker
          value={chipsFromInput(value)}
          options={options ?? []}
          onChange={(next) => onCommit(next.join(", "))}
        />
      ) : col.key === "date" ? (
        /* The browser's own picker, which only ever yields an ISO day
           — the one shape the column sorts on and the date style in
           Settings can read. A blank clears it. Committed on change
           rather than on blur: a picker is done when it has picked. */
        <input
          className="detail-input"
          type="date"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onCommit(e.target.value);
          }}
        />
      ) : (
        <input
          className="detail-input"
          type={col.kind === "number" ? "number" : "text"}
          value={draft}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              setDraft(value);
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </label>
  );
}

/**
 * Who was at the table, picked from the roster.
 *
 * The names already on the session are chips, each with its own ×.
 * Click into the line and the roster from Settings drops down — every
 * active player not yet on the list — and a click on a name adds it.
 * Typing narrows the list; Enter takes the first match. The options
 * are the live roster (see campaignPlayers), so a name added or
 * retired in Settings is added to or gone from this list without
 * anything here knowing.
 *
 * A guest is still possible, because attendance is who was in the
 * room: type a name the roster does not have and the menu offers to
 * add it as typed. That is a second gesture rather than the first, so
 * a typo in a regular's name lands on the roster's spelling rather
 * than beside it.
 *
 * Options are taken on MOUSEDOWN with the default prevented, the same
 * rule NoteMentions runs on: a click would blur the input first, the
 * blur would close the menu, and the click would land on nothing.
 */
function PlayerPicker({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const has = (name: string) =>
    value.some((v) => playerKey(v) === playerKey(name));
  const q = playerKey(text);
  const offered = options.filter(
    (o) => !has(o) && (!q || playerKey(o).includes(q))
  );
  // A typed name that is on the roster is offered above; only a name
  // the roster does not know needs the guest line.
  const guest =
    q && !options.some((o) => playerKey(o) === q) && !has(text)
      ? text.replace(/\s+/g, " ").trim()
      : null;

  const add = (name: string) => {
    const next = addPlayer(value, name, options);
    if (next !== value) onChange(next);
    setText("");
  };

  return (
    <div className={`player-picker${open ? " open" : ""}`}>
      <div
        className="player-line"
        onClick={() => input.current?.focus()}
      >
        {value.map((name) => (
          <span className="chip player-chip" key={name}>
            {name}
            <button
              type="button"
              className="chip-x"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(removePlayer(value, name));
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="player-input"
          type="text"
          value={text}
          placeholder={value.length === 0 ? "Who was there?" : "Add…"}
          aria-label="Add a player"
          aria-expanded={open}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setText("");
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (offered.length > 0) add(offered[0]);
              else if (guest) add(guest);
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            } else if (e.key === "Backspace" && text === "" && value.length) {
              // Backspace at an empty line takes the last chip off, the
              // way every tag field people have used does.
              onChange(value.slice(0, -1));
            }
          }}
        />
      </div>

      {open && (
        <ul className="player-menu" role="listbox" aria-label="Players">
          {offered.map((name) => (
            <li key={name} role="option" aria-selected={false}>
              <button
                type="button"
                className="player-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(name);
                }}
              >
                {name}
              </button>
            </li>
          ))}
          {guest && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                className="player-option player-guest"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(guest);
                }}
              >
                Add “{guest}” as a guest
              </button>
            </li>
          )}
          {offered.length === 0 && !guest && (
            <li className="player-menu-note">
              {options.length === 0
                ? "Nobody on the roster yet — add players under Settings."
                : q
                  ? "Nobody on the roster by that name."
                  : "Everyone on the roster is already here."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
