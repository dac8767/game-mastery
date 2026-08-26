"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { UiText } from "@/components/UiEditor";
import { Id } from "@/convex/_generated/dataModel";
import {
  NOTE_EXEC,
  NOTE_LIMITS,
  NOTE_TOOLS,
  isEmptyNote,
  noteExecValue,
  whenText,
} from "@/components/noteFormat";

/**
 * A thread of notes on one NPC.
 *
 * Two of these on a DM's screen — the table's pad and the DM's own —
 * and one on a player's, filling the column.
 *
 * The body is HTML, written in a contentEditable and rendered back with
 * dangerouslySetInnerHTML. That is only safe because the server rebuilds
 * every body from an allowlist before storing it: what comes back has
 * already been through sanitizeNoteHtml, so the markup here is markup
 * this app emitted. Sanitising in the editor as well would be belt and
 * braces; sanitising ONLY there would be a hole, because a hand-made
 * mutation call never opens an editor.
 *
 * Deliberately not the notebook's rich-text helper. That one keeps a
 * module-level record of which box has focus, because its toolbar sits
 * far from the box it acts on. Two threads on a screen would fight over
 * that single slot. Here the toolbar is attached to its own editor and
 * acts on it directly.
 */

export type Note = {
  _id: string;
  _creationTime: number;
  channel: "player" | "dm";
  body: string;
  editedAt: number | null;
  authorId: string;
  authorName: string;
  images: { id: string; url: string | null }[];
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function NoteThread({
  npcId,
  channel,
  titleId,
  blurbId,
  notes,
  youId,
  canWrite,
}: {
  npcId: Id<"npcs">;
  channel: "player" | "dm";
  /** Registry ids, so edit mode can rename the pane in place. */
  titleId: string;
  /**
   * Optional since the player pane dropped its line. Two of these
   * sentences were reported for removal one after the other —
   * "Everyone at the table writes here…" and "You can edit Player
   * Notes…" — and the shape of both was a pane explaining itself to
   * the people who use it every week. The DM pane keeps its blurb
   * because "never sent to a player" is a promise, not an explanation.
   */
  blurbId?: string;
  notes: Note[];
  youId: string | null;
  canWrite: boolean;
}) {
  const addNote = useMutation(api.npcs.addNote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Recomputed per render rather than stored: "5 minutes ago" is a fact
  // about now, and a timestamp captured once would freeze.
  const now = Date.now();

  const mine = notes.filter((n) => n.channel === channel);

  const submit = async (body: string, imageIds: Id<"_storage">[]) => {
    setBusy(true);
    try {
      setError(null);
      await addNote({ npcId, channel, body, imageIds });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that note.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`note-thread note-${channel}`}>
      <header className="note-thread-head">
        <h3>
          <UiText id={titleId} />
        </h3>
        {channel === "dm" && <span className="dm-tag">DM only</span>}
      </header>
      {/* One padded box for everything below the title band, so the
          blurb, the notes and the composer share a left edge. They used
          to be three siblings with three margin rules, which put the
          blurb fourteen pixels left of the notes under it — visible the
          moment edit mode outlined the blurb and not the list. */}
      <div className="note-thread-body">
      {blurbId && (
        <p className="settings-note">
          <UiText id={blurbId} />
        </p>
      )}

      {error && <p className="form-error">{error}</p>}

      <ul className="note-list">
        {mine.length === 0 && (
          <li className="note-empty settings-note">
            <UiText id="record.notes.empty" />
          </li>
        )}
        {mine.map((note) => (
          <NoteCard
            key={note._id}
            note={note}
            npcId={npcId}
            now={now}
            isMine={note.authorId === youId}
            editing={editingId === note._id}
            onEdit={() => setEditingId(note._id)}
            onDone={() => setEditingId(null)}
          />
        ))}
      </ul>

      {canWrite &&
        (composing ? (
          <NoteComposer
            npcId={npcId}
            busy={busy}
            onSubmit={async (body, images) => {
              const ok = await submit(body, images);
              // Closed only on success: a note that failed to send is
              // still in the box, which is where you want it.
              if (ok) setComposing(false);
              return ok;
            }}
            onCancel={() => setComposing(false)}
          />
        ) : (
          /* A toolbar and an empty box sat under every thread whether
             or not anybody was writing, which on the DM's split column
             is two editors taking half the height of both panes for
             nothing. */
          <button
            type="button"
            className="npc-btn note-add"
            onClick={() => setComposing(true)}
          >
            <UiText id="record.notes.add" />
          </button>
        ))}
      </div>
    </section>
  );
}

/** One note, read or being rewritten. */
function NoteCard({
  note,
  npcId,
  now,
  isMine,
  editing,
  onEdit,
  onDone,
}: {
  note: Note;
  npcId: Id<"npcs">;
  now: number;
  isMine: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const editNote = useMutation(api.npcs.editNote);
  const removeNote = useMutation(api.npcs.deleteNote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <li className="note-card">
        {error && <p className="form-error">{error}</p>}
        <NoteComposer
          npcId={npcId}
          busy={busy}
          initialBody={note.body}
          initialImages={note.images}
          submitLabel="Save"
          onCancel={onDone}
          onSubmit={async (body, imageIds) => {
            setBusy(true);
            try {
              setError(null);
              await editNote({
                noteId: note._id as Id<"npcNotes">,
                body,
                imageIds,
              });
              onDone();
              return true;
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not save that note."
              );
              return false;
            } finally {
              setBusy(false);
            }
          }}
        />
      </li>
    );
  }

  return (
    <li className="note-card">
      <header className="note-card-head">
        <span className="note-author">{note.authorName}</span>
        <span className="note-when">
          {whenText(note._creationTime, now)}
          {note.editedAt && " · edited"}
        </span>
        {isMine && !confirming && (
          <span className="note-actions">
            <button type="button" className="text-button" onClick={onEdit}>
              Edit
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          </span>
        )}
        {isMine && confirming && (
          <span className="note-actions">
            <span className="settings-note">Delete this note?</span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await removeNote({ noteId: note._id as Id<"npcNotes"> });
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Could not delete it."
                  );
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              Yes
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirming(false)}
            >
              No
            </button>
          </span>
        )}
      </header>

      {error && <p className="form-error">{error}</p>}

      {/* Safe because the server rebuilt this from an allowlist before
          storing it — see convex/npcs.ts addNote. */}
      <div
        className="note-body"
        dangerouslySetInnerHTML={{ __html: note.body }}
      />

      {note.images.length > 0 && (
        <div className="note-images">
          {note.images.map((img) =>
            img.url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img key={img.id} src={img.url} alt="" loading="lazy" />
            ) : null
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Writing one note.
 *
 * The editor is uncontrolled — React sets its HTML once and then leaves
 * it alone. Rewriting a contentEditable's innerHTML on every keystroke
 * puts the caret back at the start of the box, which makes typing
 * anything longer than a word impossible.
 */
function NoteComposer({
  npcId,
  busy,
  initialBody = "",
  initialImages = [],
  submitLabel = "Add",
  onCancel,
  onSubmit,
}: {
  npcId: Id<"npcs">;
  busy: boolean;
  initialBody?: string;
  initialImages?: { id: string; url: string | null }[];
  submitLabel?: string;
  onCancel?: () => void;
  onSubmit: (body: string, imageIds: Id<"_storage">[]) => Promise<boolean>;
}) {
  const generateUrl = useMutation(api.npcs.generateNoteImageUploadUrl);
  const editor = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState(initialImages);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(isEmptyNote(initialBody));

  useEffect(() => {
    if (editor.current) editor.current.innerHTML = initialBody;
    // Once, on mount. Following `initialBody` would overwrite what is
    // being typed the moment the note re-renders from the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (key: string) => {
    const el = editor.current;
    if (!el || typeof document.execCommand !== "function") return;
    el.focus();
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(NOTE_EXEC[key] ?? key, false, noteExecValue(key));
    setEmpty(isEmptyNote(el.innerHTML));
  };

  const upload = async (chosen: File) => {
    if (chosen.size > MAX_IMAGE_BYTES) {
      setError("That image is over 8MB — shrink it first.");
      return;
    }
    if (images.length >= NOTE_LIMITS.images) {
      setError(`${NOTE_LIMITS.images} images is the limit for one note.`);
      return;
    }
    setUploading(true);
    try {
      setError(null);
      const url = await generateUrl({ npcId });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": chosen.type || "image/png" },
        body: chosen,
      });
      if (!res.ok) throw new Error("The upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      setImages((prev) => [...prev, { id: storageId, url: null }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const canSubmit = (!empty || images.length > 0) && !busy && !uploading;

  return (
    <div className="note-composer">
      <div className="note-toolbar">
        {NOTE_TOOLS.map((t) => (
          <button
            type="button"
            key={t.key}
            className="note-tool"
            title={t.title}
            aria-label={t.title}
            // A click blurs the editor and collapses the selection
            // before the handler runs, so the press is intercepted
            // before that happens.
            onMouseDown={(e) => {
              e.preventDefault();
              run(t.key);
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="note-tool"
          title="Attach an image"
          aria-label="Attach an image"
          disabled={uploading || images.length >= NOTE_LIMITS.images}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => file.current?.click()}
        >
          {uploading ? "…" : "🖼"}
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (chosen) void upload(chosen);
          }}
        />
      </div>

      <div
        ref={editor}
        className="note-input"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Write a note"
        data-placeholder="Write a note…"
        suppressContentEditableWarning
        onInput={(e) => setEmpty(isEmptyNote(e.currentTarget.innerHTML))}
      />

      {images.length > 0 && (
        <div className="note-images note-images-draft">
          {images.map((img) => (
            <span className="note-thumb" key={img.id}>
              {img.url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={img.url} alt="" />
              ) : (
                <span className="note-thumb-new">Attached</span>
              )}
              <button
                type="button"
                className="text-button"
                title="Remove this image"
                onClick={() =>
                  setImages((prev) => prev.filter((x) => x.id !== img.id))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="note-composer-actions">
        {onCancel && (
          <button type="button" className="text-button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="npc-btn primary"
          disabled={!canSubmit}
          onClick={async () => {
            const el = editor.current;
            if (!el) return;
            const ok = await onSubmit(
              el.innerHTML,
              images.map((i) => i.id as Id<"_storage">)
            );
            if (!ok) return;
            // Only cleared on success, so a failed save does not throw
            // away what was written.
            if (!onCancel) {
              el.innerHTML = "";
              setImages([]);
              setEmpty(true);
            }
          }}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
