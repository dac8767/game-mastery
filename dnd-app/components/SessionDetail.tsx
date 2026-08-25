"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { BoxCanvas, NewBox } from "@/components/BoxCanvas";
import { ColumnDef } from "@/components/npcColumns";
import {
  SESSION_COLUMNS,
  campaignPlayers,
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
 *   DM notes       what you knew and the table did not. The DM's alone,
 *                  and withheld by the SERVER — sessions.getNotes never
 *                  queries the DM side for a non-DM caller, so there is
 *                  no version of this screen, and no devtools tab, in
 *                  which a player has that text.
 *
 * The format toolbar is mounted once, here, rather than inside each
 * canvas. notebookFormat holds one saver and one tracked selection for
 * the whole document, so two canvases each registering their own would
 * leave whichever mounted last writing both sides' edits. One bar also
 * reads correctly: it acts on whichever box the caret is in, and the
 * caret is only ever in one.
 */

export type SessionRow = {
  _id: Id<"sessions">;
  _creationTime: number;
  number: number;
  date: string | null;
  players: string[];
  xp: number | null;
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
  const players = useMemo(
    () => campaignPlayers(members, characters),
    [members, characters]
  );

  const updateSession = useMutation(api.sessions.updateSession);
  const deleteSession = useMutation(api.sessions.deleteSession);
  const addBox = useMutation(api.sessions.addBox);
  const updateBox = useMutation(api.sessions.updateBox);
  const deleteBox = useMutation(api.sessions.deleteBox);
  const generateUploadUrl = useMutation(api.sessions.generateUploadUrl);

  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  useEffect(
    () =>
      registerScrapbookSaver((boxId, html) =>
        void run(() =>
          updateBox({ boxId: boxId as Id<"sessionBoxes">, html })
        )
      ),
    [run, updateBox]
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
  });

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
          {SESSION_COLUMNS.map((col) => (
            <SessionField
              key={col.key}
              col={col}
              value={toInput(session, col.key)}
              editable={isDm}
              options={col.key === "players" ? players : undefined}
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

        {/* One bar for the whole record. See the note at the top. */}
        <NotebookFormatBar />

        {/* Two columns, DM on the LEFT. Which side each is on is a
            preference; that they are side by side is not — the notes
            from one night are one thing read together, and stacked
            they were a page of scrolling between the half you were
            writing and the half you were writing it against.

            One column when there is only one page to draw, so a
            player does not get an empty half-width canvas beside a
            gap where something they cannot see would be. */}
        <div
          className={`session-notes-split${
            notes?.dm ? "" : " single"
          }`}
        >
          {/* Rendered only when the SERVER sent a dm side. A player's
              request never queries it, so `dm` is null rather than
              empty — and an empty section would say "the DM has not
              written anything", which is a different claim from "this
              is not yours to see". */}
          {notes?.dm !== null && notes?.dm !== undefined && (
            <section className="session-notes dm-notes">
              <h3 className="group-h">
                DM notes <span className="dm-tag">DM</span>
              </h3>
              <BoxCanvas
                boxes={notes.dm}
                canEdit
                emptyNote="Yours alone. The table never sees this page."
                {...canvasProps("dm")}
              />
            </section>
          )}

          <section className="session-notes">
            <h3 className="group-h">Player notes</h3>
            {notes === undefined ? (
              <p className="centered-note">Opening the notes…</p>
            ) : notes === null ? (
              /* Deleted out from under you — by you in another tab, or
                 by nobody, but either way there is nothing to draw and
                 an empty canvas would invite you to write into it. */
              <p className="centered-note">This session is gone.</p>
            ) : (
              <BoxCanvas
                boxes={notes.player}
                canEdit
                emptyNote="Nothing written down yet. Add a text box to start."
                {...canvasProps("player")}
              />
            )}
          </section>
        </div>
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
  onCommit,
}: {
  col: ColumnDef;
  value: string;
  editable: boolean;
  /** Values to offer as one-click chips, above the free-text line. */
  options?: string[];
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Follow the live query when the row redelivers — someone else may be
  // editing the same session — but not while this box has the caret.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    if (draft === value) return;
    onCommit(draft);
  };

  return (
    <label className={`detail-field session-field sf-${col.key}`}>
      <div className="detail-label">{col.label}</div>
      {!editable ? (
        <div className="detail-value">{value || "—"}</div>
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
