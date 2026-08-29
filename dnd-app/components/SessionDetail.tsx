"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { BoxCanvas, BoxTools, NewBox } from "@/components/BoxCanvas";
import { NoteLinkPicker } from "@/components/NoteLinkPicker";
import { NoteMentions } from "@/components/NoteMentions";
import { linkTargets } from "@/components/noteLinks";
import { NoteSide, pageBoxId, pageSide } from "@/components/notePage";
import { ColumnDef } from "@/components/npcColumns";
import {
  Leveling,
  campaignPlayers,
  milestoneOptions,
  sessionColumnsFor,
  sessionPatch,
  toggleChip,
} from "@/components/sessionColumns";
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
 * Two sides, and they are not the same kind of thing:
 *
 *   Player notes   the shared account of the night, which any member
 *                  may write. The same rule the NPC record's player
 *                  notes run on.
 *   GM notes       what you knew and the table did not. The GM's alone,
 *                  and withheld by the SERVER — sessions.getNotes never
 *                  queries the GM side for a non-GM caller, so there is
 *                  no version of this screen, and no devtools tab, in
 *                  which a player has that text.
 *
 * They are TABS rather than two panes side by side. A GM reads one at
 * a time — you are either writing what happened or writing what you
 * are not telling them — and the split made both halves narrow to show
 * a second page that was usually not the one being looked at. It also
 * answers the question one shared toolbar could not: which page a new
 * box lands on is the page you are looking at.
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
  const columns = useMemo(() => sessionColumnsFor(leveling), [leveling]);

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

  const updateSession = useMutation(api.sessions.updateSession);
  const deleteSession = useMutation(api.sessions.deleteSession);
  const addBox = useMutation(api.sessions.addBox);
  const updateBox = useMutation(api.sessions.updateBox);
  const deleteBox = useMutation(api.sessions.deleteBox);
  const setBody = useMutation(api.sessions.setBody);
  const generateUploadUrl = useMutation(api.sessions.generateUploadUrl);

  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* Which page is open. The GM's own first — it is the one they are
     writing during a session, and the player page is the one they read
     back afterwards. A player never sees the tabs at all. */
  const [tab, setTab] = useState<NoteSide>("dm");

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  }, []);

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
        const side = pageSide(boxId);
        void run(() =>
          side
            ? setBody({ sessionId: session._id, side, html })
            : updateBox({ boxId: boxId as Id<"sessionBoxes">, html })
        );
      }),
    [run, updateBox, setBody, session._id]
  );

  const uploadImage = async (
    side: "player" | "dm",
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

  const canvasProps = (side: "player" | "dm") => ({
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
      void run(() =>
        updateBox({ boxId: boxId as Id<"sessionBoxes">, ...patch })
      ),
    onDelete: (boxId: string) =>
      void run(() => deleteBox({ boxId: boxId as Id<"sessionBoxes"> })),
    onUploadImage: (file: File) => uploadImage(side, file),
    onFollowLink: (href: string) => router.push(href),
  });

  /* Whether there IS a GM page to show. Rendered only when the SERVER
     sent one: a player's request never queries the GM side, so `dm`
     comes back null rather than empty — and an empty page would say
     "the GM has not written anything", which is a different claim from
     "this is not yours to see". */
  const hasDm = notes?.dm !== null && notes?.dm !== undefined;

  /**
   * Which page you are on — and so which page a new box lands on.
   *
   * The visible tab, which is the only answer that needs no explaining.
   * It was "whichever side you are" before, which meant a GM had no way
   * to put a picture on the player page at all.
   */
  const side: NoteSide = hasDm && tab === "dm" ? "dm" : "player";

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
                Delete this session and both sets of notes?
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
                void run(() =>
                  updateSession({ sessionId: session._id, ...patch })
                );
              }}
            />
          ))}
        </section>

        <section
          className={`session-notes${side === "dm" ? " dm-notes" : ""}`}
        >
          {/* The tabs ARE the heading — two names, one of them current
              — so there is no separate title above them repeating
              whichever is open. A player gets the plain heading, since
              a tab strip of one is a label wearing a border. */}
          {hasDm ? (
            <div className="session-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "dm"}
                className={`session-tab${tab === "dm" ? " on" : ""}`}
                onClick={() => setTab("dm")}
              >
                GM notes <span className="dm-tag">GM</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "player"}
                className={`session-tab${tab === "player" ? " on" : ""}`}
                onClick={() => setTab("player")}
              >
                Player notes
              </button>
            </div>
          ) : (
            <h3 className="group-h">Player notes</h3>
          )}

          {/* Under the tabs rather than above them: it acts on the page
              below it, and a toolbar floating above the thing that
              names the page reads as belonging to the record.

              And not before the notes have ARRIVED. `side` is read from
              the open tab, and the DM tab does not exist until the
              server has said there is a DM side — so in the window
              between opening a session and getNotes answering, a DM's
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
              boxes={(side === "dm" ? notes.dm : notes.player) ?? []}
              canEdit
              tools="elsewhere"
              page={{
                id: pageBoxId(side),
                html:
                  (side === "dm" ? notes.dmBody : notes.playerBody) ?? "",
                onChange: (html) =>
                  void run(() =>
                    setBody({ sessionId: session._id, side, html })
                  ),
              }}
              {...canvasProps(side)}
            />
          )}
        </section>
      </div>
    </section>
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
  /** Values to offer as one-click chips, above the free-text line. */
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
      ) : (
        <>
          {/* One click each, above the line rather than instead of it.
              The line stays because attendance is not a closed set —
              a guest who played one night was there, and a field that
              only offered the campaign's members would have no way to
              say so. */}
          {options && options.length > 0 && (
            <div className="field-options">
              {options.map((name) => {
                const on = draft
                  .split(",")
                  .some((v) => v.trim().toLowerCase() === name.toLowerCase());
                return (
                  <button
                    type="button"
                    key={name}
                    className={`chip chip-pick${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      const next = toggleChip(draft, name);
                      setDraft(next);
                      onCommit(next);
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}
        <input
          className="detail-input"
          type={col.kind === "number" ? "number" : "text"}
          value={draft}
          placeholder={col.kind === "chips" ? "Comma separated" : undefined}
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
        </>
      )}
    </label>
  );
}
