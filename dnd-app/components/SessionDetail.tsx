"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { BoxCanvas, NewBox } from "@/components/BoxCanvas";
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
  isDm,
  onClose,
}: {
  session: SessionRow;
  isDm: boolean;
  onClose: () => void;
}) {
  const notes = useQuery(api.sessions.getNotes, { sessionId: session._id });

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
            <p className="record-summary">
              {session.date && <span className="record-chip">{session.date}</span>}
              <span className="record-chip">
                {session.players.length} player
                {session.players.length === 1 ? "" : "s"}
              </span>
              {session.xp !== null && (
                <span className="record-chip">{session.xp} XP</span>
              )}
            </p>
            {session.description && (
              <p className="group-prose">{session.description}</p>
            )}
            {isDm && (
              <p className="settings-note">
                The night&apos;s facts are edited in the list — click a cell.
              </p>
            )}
          </div>
        </header>

        {/* One bar for the whole record. See the note at the top. */}
        <NotebookFormatBar />

        <section className="session-notes">
          <h3 className="group-h">Player notes</h3>
          {notes === undefined ? (
            <p className="centered-note">Opening the notes…</p>
          ) : (
            <BoxCanvas
              boxes={notes?.player ?? []}
              canEdit
              emptyNote="Nothing written down yet. Add a text box to start."
              {...canvasProps("player")}
            />
          )}
        </section>

        {/* Rendered only when the SERVER sent a dm side. A player's
            request never queries it, so `dm` is null rather than empty
            — and an empty section would say "the DM has not written
            anything", which is a different claim from "this is not
            yours to see". */}
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
      </div>
    </section>
  );
}
