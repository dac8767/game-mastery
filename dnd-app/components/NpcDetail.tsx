"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { COLUMNS, ColumnDef, portraitSrc } from "@/components/npcColumns";

/**
 * The expanded record: every field, editable in place.
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

  const fields = COLUMNS.filter((c) => isDm || !c.dmOnly);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="npc-drawer">
        <header className="drawer-header">
          <div>
            <h2>{npc.name}</h2>
            {npc.nickname && <p className="muted">“{npc.nickname}”</p>}
          </div>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </header>

        {portraitSrc(npc.portraitUrl, npc.portraitPath, mapServer) && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="drawer-portrait"
            src={portraitSrc(npc.portraitUrl, npc.portraitPath, mapServer)!}
            alt={npc.name}
          />
        )}

        {error && <p className="form-error">{error}</p>}

        {!isDm && (
          <p className="drawer-hint muted">
            You can edit Player Notes. Everything else is the DM&apos;s.
          </p>
        )}

        {fields.map((col) =>
          col.kind === "picture" ? (
            <PortraitField key={col.key} npc={npc} editable={isDm} />
          ) : (
            <DrawerField
              key={col.key}
              col={col}
              value={toInput(npc, col)}
              editable={canEdit(col)}
              dmOnly={Boolean(col.dmOnly)}
              onCommit={(text) => commit(col, text)}
            />
          ),
        )}
      </aside>
    </>
  );
}

function DrawerField({
  col,
  value,
  editable,
  dmOnly,
  onCommit,
}: {
  col: ColumnDef;
  value: string;
  editable: boolean;
  dmOnly: boolean;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Follow the live query when someone else edits the same record.
  useEffect(() => setDraft(value), [value]);

  if (!editable) {
    if (!value) return null;
    return (
      <div className={`detail-field${dmOnly ? " dm-field" : ""}`}>
        <div className="detail-label">{col.label}</div>
        <div className="detail-value">{value}</div>
      </div>
    );
  }

  const commitIfChanged = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <div className={`detail-field${dmOnly ? " dm-field" : ""}`}>
      <div className="detail-label">
        {col.label}
        {dmOnly && <span className="dm-tag">DM only</span>}
      </div>

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
          placeholder={col.kind === "chips" ? "comma, separated" : undefined}
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
 * The Picture field: a real image, uploaded.
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
    <div className="portrait-field">
      <div className="detail-label">Picture</div>

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
              className="npc-btn"
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
