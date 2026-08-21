"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { COLUMNS, COLUMN_BY_KEY, ColumnDef, portraitSrc } from "@/components/npcColumns";
import {
  HEADER_KEYS,
  SUMMARY_KEYS,
  arrange,
} from "@/components/npcSections";

/**
 * The expanded record: every field, editable in place.
 *
 * It fills the list area rather than sliding over it as a drawer. A
 * drawer is right for a glance and wrong for this: thirty-odd fields in
 * a 30rem column is a very long scroll, and the table it covered was
 * still there underneath, greyed out and useless. Taking the whole
 * space lets the fields sit in columns and lets the sections read as
 * sections.
 *
 * The toolbar above stays put, so it is clear you are still inside the
 * NPC list and one Escape from being back in it.
 *
 * Who may write what is decided on the server (updateNpc is DM-gated;
 * setPlayerNotes is the only field a player can reach). This component
 * only decides what to *offer* — rendering a field read-only is a
 * courtesy so nobody types into something the server will reject, not
 * the permission check itself.
 */

type NpcListResult = FunctionReturnType<typeof api.npcs.listForCampaign>;
type Npc = NpcListResult["npcs"][number];

function cell(npc: Npc, key: string): unknown {
  return (npc as unknown as Record<string, unknown>)[key];
}

/** Field value as the string an input should show. */
function toInput(npc: Npc, col: ColumnDef): string {
  const raw = cell(npc, col.key);
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) return (raw as string[]).join(", ");
  return String(raw);
}

/** Input string back to whatever the mutation expects. */
export function fromInput(col: ColumnDef, text: string): unknown {
  const trimmed = text.trim();
  switch (col.kind) {
    case "chips":
      return trimmed
        ? trimmed
            .split(",")
            .map((s) => s.replace(/\s+/g, " ").trim())
            .filter(Boolean)
        : [];
    case "number": {
      if (!trimmed) return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return trimmed === "true";
    default:
      // null clears an optional text field; "" is not a legal value.
      return trimmed ? text : null;
  }
}

/** Prose gets a row to itself; a name or a number does not need one. */
const isWide = (col: ColumnDef) => col.kind === "longtext";

export function NpcDetail({
  npc,
  isDm,
  onClose,
}: {
  npc: Npc;
  isDm: boolean;
  onClose: () => void;
}) {
  const updateNpc = useMutation(api.npcs.updateNpc);
  const setPlayerNotes = useMutation(api.npcs.setPlayerNotes);
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const [error, setError] = useState<string | null>(null);

  // Escape closes it. Ignored while a field has focus, where Escape
  // already means "put that value back" — losing an edit and the whole
  // record to one keystroke is not what anybody meant by it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canEdit = (col: ColumnDef) =>
    isDm ? Boolean(col.editable) : Boolean(col.playerEditable);

  async function commit(col: ColumnDef, text: string) {
    const value = fromInput(col, text);
    try {
      setError(null);
      if (col.key === "playerNotes" && !isDm) {
        await setPlayerNotes({
          npcId: npc._id,
          playerNotes: value as string | null,
        });
        return;
      }
      await updateNpc({ npcId: npc._id, [col.key]: value } as unknown as {
        npcId: typeof npc._id;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that change.");
    }
  }

  // What the server is willing to show this caller, arranged. The
  // header shows its own fields, so they are held back from the
  // sections rather than repeated in one.
  const allowed = COLUMNS.filter((c) => isDm || !c.dmOnly).map((c) => c.key);
  const sections = arrange(allowed.filter((k) => !HEADER_KEYS.includes(k)));

  // The header's own fields, minus the portrait, which has its own
  // control. An empty one is dropped only when it is also read-only —
  // a DM with no nickname set still needs somewhere to type one.
  const headerFields = HEADER_KEYS.filter((k) => k !== "portraitPath")
    .map((k) => COLUMN_BY_KEY.get(k))
    .filter((c): c is ColumnDef => Boolean(c))
    .filter((c) => (isDm || !c.dmOnly) && (canEdit(c) || toInput(npc, c)));

  const summary = SUMMARY_KEYS.map((key) => {
    const col = COLUMN_BY_KEY.get(key);
    const text = col ? toInput(npc, col) : "";
    return text ? { key, text } : null;
  }).filter((x): x is { key: string; text: string } => x !== null);

  return (
    <section className="npc-record" aria-label={`${npc.name} — full record`}>
      <header className="record-head">
        <PortraitField npc={npc} editable={isDm} />

        <div className="record-titles">
          {/* Through RecordField like everything else, not as a heading
              with the value baked in: name and nickname are editable
              columns, and rendering them as text is how a DM quietly
              loses the ability to rename an NPC from its own record. */}
          {headerFields.map((col) => (
            <RecordField
              key={col.key}
              col={col}
              value={toInput(npc, col)}
              editable={canEdit(col)}
              dmOnly={Boolean(col.dmOnly)}
              variant={col.key === "name" ? "title" : "subtitle"}
              onCommit={(text) => commit(col, text)}
            />
          ))}
          {summary.length > 0 && (
            <p className="record-summary">
              {summary.map((s) => (
                <span className="record-chip" key={s.key}>
                  {s.text}
                </span>
              ))}
            </p>
          )}
          {!isDm && (
            <p className="settings-note">
              You can edit Player Notes. Everything else is the DM&apos;s.
            </p>
          )}
        </div>

        <button type="button" className="npc-btn" onClick={onClose}>
          Back to the list
        </button>
      </header>

      {error && <p className="form-error">{error}</p>}

      <div className="record-body">
        {sections.map((section) => {
          const cols = section.keys
            .map((k) => COLUMN_BY_KEY.get(k))
            .filter((c): c is ColumnDef => Boolean(c))
            // A read-only field with nothing in it is a label and a
            // blank — noise on a record a player cannot change.
            .filter((c) => canEdit(c) || toInput(npc, c));

          if (cols.length === 0) return null;

          return (
            <section className="record-section" key={section.id}>
              <h3>{section.title}</h3>
              {section.blurb && (
                <p className="settings-note">{section.blurb}</p>
              )}
              <div className="record-fields">
                {cols.map((col) => (
                  <RecordField
                    key={col.key}
                    col={col}
                    value={toInput(npc, col)}
                    editable={canEdit(col)}
                    dmOnly={Boolean(col.dmOnly)}
                    onCommit={(text) => commit(col, text)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function RecordField({
  col,
  value,
  editable,
  dmOnly,
  variant,
  onCommit,
}: {
  col: ColumnDef;
  value: string;
  editable: boolean;
  dmOnly: boolean;
  /** Header fields are the same control, worn larger and unlabelled. */
  variant?: "title" | "subtitle";
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Follow the live query when someone else edits the same record.
  useEffect(() => setDraft(value), [value]);

  const className = `detail-field${dmOnly ? " dm-field" : ""}${
    isWide(col) && !variant ? " wide" : ""
  }${variant ? ` record-${variant}` : ""}`;

  if (!editable) {
    return (
      <div className={className}>
        {!variant && <div className="detail-label">{col.label}</div>}
        <div className="detail-value">
          {variant === "subtitle" ? `“${value}”` : value}
        </div>
      </div>
    );
  }

  const commitIfChanged = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <div className={className}>
      {!variant && (
        <div className="detail-label">
          {col.label}
          {dmOnly && <span className="dm-tag">DM only</span>}
        </div>
      )}

      {col.kind === "boolean" ? (
        <label className="detail-check">
          <input
            type="checkbox"
            checked={draft === "true"}
            onChange={(e) => {
              const next = e.target.checked ? "true" : "false";
              setDraft(next);
              onCommit(next);
            }}
          />
          <span>{draft === "true" ? "Yes" : "No"}</span>
        </label>
      ) : col.kind === "longtext" ? (
        <textarea
          className="detail-input"
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitIfChanged}
        />
      ) : (
        <input
          className="detail-input"
          type={col.kind === "number" ? "number" : "text"}
          value={draft}
          aria-label={variant ? col.label : undefined}
          placeholder={
            variant
              ? col.label
              : col.kind === "chips"
                ? "comma, separated"
                : undefined
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitIfChanged}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setDraft(value);
          }}
        />
      )}
    </div>
  );
}

/** Portraits are capped so one image can't dominate file storage. */
const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;

/**
 * The portrait, at the top of the record.
 *
 * The file goes straight to Convex storage via a short-lived URL rather
 * than through a mutation, so a large portrait can't hit the argument
 * size limit. Replacing one deletes the old file server-side.
 *
 * NPCs imported from Airtable may still carry a map-server path instead;
 * that shows here until a real image replaces it.
 */
function PortraitField({ npc, editable }: { npc: Npc; editable: boolean }) {
  const generateUrl = useMutation(api.npcs.generatePortraitUploadUrl);
  const setPortrait = useMutation(api.npcs.setPortrait);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const src = portraitSrc(npc.portraitUrl, npc.portraitPath, mapServer);

  async function upload(file: File) {
    if (file.size > MAX_PORTRAIT_BYTES) {
      setError("That image is over 8MB — shrink it first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = await generateUrl({ npcId: npc._id });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) throw new Error("The upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      await setPortrait({
        npcId: npc._id,
        storageId: storageId as Parameters<typeof setPortrait>[0]["storageId"],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="record-portrait">
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="portrait-preview" src={src} alt={npc.name} />
      ) : (
        <div className="portrait-empty">No picture yet</div>
      )}

      {editable && (
        <>
          <div className="portrait-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? "Uploading…" : src ? "Replace" : "Upload"}
            </button>
            {npc.portraitUrl && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void setPortrait({ npcId: npc._id, storageId: null })
                }
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </>
      )}

      {error && <p className="form-error">{error}</p>}

      {!npc.portraitUrl && npc.portraitPath && (
        <p className="settings-note">Imported path: {npc.portraitPath}</p>
      )}
    </div>
  );
}
