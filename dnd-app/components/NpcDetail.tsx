"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { COLUMNS, ColumnDef } from "@/components/npcColumns";

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

        {npc.portraitPath && mapServer && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="drawer-portrait"
            src={`${mapServer}/${npc.portraitPath}`}
            alt={npc.name}
          />
        )}

        {error && <p className="form-error">{error}</p>}

        {!isDm && (
          <p className="drawer-hint muted">
            You can edit Player Notes. Everything else is the DM&apos;s.
          </p>
        )}

        {fields.map((col) => (
          <DrawerField
            key={col.key}
            col={col}
            value={toInput(npc, col)}
            editable={canEdit(col)}
            dmOnly={Boolean(col.dmOnly)}
            onCommit={(text) => commit(col, text)}
          />
        ))}
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
