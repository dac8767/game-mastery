"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { COLUMN_BY_KEY } from "@/components/npcColumns";
import { BODY_KEYS, resolveTemplate } from "@/components/NpcDetail";
import {
  MAX_ROWS,
  MAX_SPAN,
  MIN_ROWS,
  MIN_SPAN,
  NpcTemplate,
  TEMPLATE_LIMITS,
  addTab,
  moveField,
  removeTab,
  renameTab,
  setRows,
  setSpan,
  shiftTab,
  templateKeys,
} from "@/components/npcTemplate";

/**
 * The NPC record layout, edited as the record.
 *
 * Not a list of field names with dropdowns beside them — that told you
 * what the layout contained and never what it looked like, so you
 * arranged it, saved, opened an NPC, and came back to move two things.
 * This IS the record: the same header, the same tab strip, the same
 * four-column grid, the same field controls, at the same sizes. Drag a
 * field to move it, drag its right edge to make it wider, drop it on a
 * tab to send it there.
 *
 * The fields are real controls rendered inert. A preview drawn out of
 * plain boxes would drift from the record the first time the record
 * changed, and the whole point is that what you arrange is what you
 * get.
 *
 * Drafted and saved in one go. Arranging is a dozen small decisions on
 * the way to one result, and a write per drag would be a dozen writes
 * and a dozen re-renders under the pointer.
 */

/** The record grid is four columns; a span is meaningless without it. */
const COLUMNS = 4;

export function NpcTemplateDesigner({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const stored = useQuery(api.npcs.getTemplate, { campaignId });
  const save = useMutation(api.npcs.saveTemplate);
  const reset = useMutation(api.npcs.resetTemplate);

  const [draft, setDraft] = useState<NpcTemplate | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTab, setNewTab] = useState("");

  /** The field being dragged, and where the pointer last suggested. */
  const dragging = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<{ tab: string; index: number } | null>(
    null
  );

  /** Live resize: which field, and what span the pointer is asking for. */
  const resizing = useRef<{
    key: string;
    axis: "x" | "y" | "both";
    startX: number;
    startY: number;
    startSpan: number;
    startRows: number;
    columnWidth: number;
    rowHeight: number;
  } | null>(null);
  const [resizeTo, setResizeTo] = useState<{
    key: string;
    span: number;
    rows: number;
  } | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);

  if (stored === undefined) {
    return (
      <section className="settings-block">
        <p className="settings-note">Loading the layout…</p>
      </section>
    );
  }

  const template = draft ?? resolveTemplate(stored ?? null);
  const dirty = draft !== null;
  const openTab =
    template.tabs.find((t) => t.id === tabId) ?? template.tabs[0] ?? null;

  const edit = (next: NpcTemplate) => {
    setDraft(next);
    setError(null);
  };

  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setError(null);
      await save({ campaignId, tabs: draft.tabs });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the layout.");
    } finally {
      setBusy(false);
    }
  };

  // ---- resizing ----------------------------------------------------

  const beginResize = (
    e: React.PointerEvent,
    key: string,
    axis: "x" | "y" | "both",
    span: number,
    rows: number
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;

    // Measured rather than assumed, on both axes: the grid is fluid, so
    // a step read off a guessed column width jumps by two where it
    // should jump by one. The row height is a fixed track — that is what
    // makes "two rows" mean the same height everywhere and lets a
    // two-row field line up with two one-row fields beside it.
    const style = getComputedStyle(grid);
    const colGap = parseFloat(style.columnGap || "0") || 0;
    const rowGap = parseFloat(style.rowGap || "0") || 0;
    const columnWidth = (grid.clientWidth - colGap * (COLUMNS - 1)) / COLUMNS;
    const rowHeight =
      (parseFloat(style.gridAutoRows || "0") || 0) + rowGap;

    resizing.current = {
      key,
      axis,
      startX: e.clientX,
      startY: e.clientY,
      startSpan: span,
      startRows: rows,
      columnWidth,
      rowHeight,
    };
    setResizeTo({ key, span, rows });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const moveResize = (e: React.PointerEvent) => {
    const r = resizing.current;
    if (!r) return;

    const span =
      r.axis === "y" || r.columnWidth <= 0
        ? r.startSpan
        : Math.min(
            MAX_SPAN,
            Math.max(
              MIN_SPAN,
              r.startSpan + Math.round((e.clientX - r.startX) / r.columnWidth)
            )
          );
    const rows =
      r.axis === "x" || r.rowHeight <= 0
        ? r.startRows
        : Math.min(
            MAX_ROWS,
            Math.max(
              MIN_ROWS,
              r.startRows + Math.round((e.clientY - r.startY) / r.rowHeight)
            )
          );

    setResizeTo({ key: r.key, span, rows });
  };

  const endResize = () => {
    const r = resizing.current;
    const asked = resizeTo;
    resizing.current = null;
    setResizeTo(null);
    if (!r || !asked) return;

    let next = template;
    if (asked.span !== r.startSpan) next = setSpan(next, r.key, asked.span);
    if (asked.rows !== r.startRows) next = setRows(next, r.key, asked.rows);
    if (next !== template) edit(next);
  };

  // ---- dragging ----------------------------------------------------

  const dropField = (toTabId: string, index: number) => {
    const key = dragging.current;
    dragging.current = null;
    setDropAt(null);
    if (!key) return;
    edit(moveField(template, key, toTabId, index));
  };

  const placed = templateKeys(template);

  return (
    <section className="settings-block">
      <h2>NPC record layout</h2>
      <p className="settings-note">
        This is the record itself. Drag a field to move it, drag its right
        edge to widen it, its bottom edge to make it taller, or the corner
        for both. Drop it on a tab to send it there. Everyone in this
        campaign opens an NPC to whatever you arrange here — which fields
        a player actually receives is still decided on the server, so a
        DM-only field on a shared tab stays hidden from them. The notes
        rail and the hide switch are fixed and are not arranged here.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="tpl-wys" onPointerMove={moveResize} onPointerUp={endResize}>
        <div className="record-split">
        <div className="record-left">
          {/* The record's header, drawn as the record draws it, and in
              the same column — the notes run the full height beside it
              rather than starting underneath. Not arrangeable: the
              portrait and the name are what tell you whose record you
              are looking at. */}
          <div className="record-head tpl-head">
            <div className="record-portrait">
              <div className="portrait-empty">Portrait</div>
            </div>
            <div className="record-titles">
              <div className="detail-field record-title">
                <div className="detail-value">Name</div>
              </div>
              <div className="detail-field record-subtitle">
                <div className="detail-value">“Nickname”</div>
              </div>
              <p className="record-summary">
                <span className="record-chip">Job</span>
                <span className="record-chip">Species</span>
                <span className="record-chip">Place</span>
              </p>
            </div>
            <div className="record-head-right">
              <label className="record-hide">
                <input type="checkbox" disabled />
                <span>Hide NPC from players</span>
              </label>
              <span className="settings-note tpl-head-note">
                Fixed — every record opens on its portrait and name.
              </span>
            </div>
          </div>

        <div className="record-tabbar">
          <div className="record-tabs" role="tablist">
            {template.tabs.map((tab, ti) => (
              <div
                key={tab.id}
                className={`tpl-tabchip${
                  tab.id === openTab?.id ? " on" : ""
                }${dropAt?.tab === tab.id && dropAt.index < 0 ? " over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropAt({ tab: tab.id, index: -1 });
                }}
                onDragLeave={() => setDropAt(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  dropField(tab.id, Number.MAX_SAFE_INTEGER);
                }}
              >
                <input
                  className="tpl-tabchip-name"
                  value={tab.title}
                  maxLength={TEMPLATE_LIMITS.titleLength}
                  aria-label={`Name of tab ${ti + 1}`}
                  size={Math.max(4, tab.title.length)}
                  onFocus={() => setTabId(tab.id)}
                  onChange={(e) =>
                    edit(renameTab(template, tab.id, e.target.value))
                  }
                />
                <button
                  type="button"
                  className="tpl-tabchip-btn"
                  title="Move this tab left"
                  disabled={ti === 0}
                  onClick={() => edit(shiftTab(template, tab.id, -1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="tpl-tabchip-btn"
                  title="Move this tab right"
                  disabled={ti === template.tabs.length - 1}
                  onClick={() => edit(shiftTab(template, tab.id, 1))}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="tpl-tabchip-btn"
                  title="Remove this tab — its fields move to the one beside it"
                  disabled={template.tabs.length <= 1}
                  onClick={() => edit(removeTab(template, tab.id))}
                >
                  ×
                </button>
              </div>
            ))}

            <span className="tpl-newtab">
              <input
                className="tpl-tabchip-name"
                value={newTab}
                placeholder="New tab"
                size={8}
                maxLength={TEMPLATE_LIMITS.titleLength}
                aria-label="New tab name"
                onChange={(e) => setNewTab(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !newTab.trim()) return;
                  e.preventDefault();
                  edit(addTab(template, newTab));
                  setNewTab("");
                }}
              />
              <button
                type="button"
                className="tpl-tabchip-btn"
                title="Add this tab"
                disabled={
                  !newTab.trim() ||
                  template.tabs.length >= TEMPLATE_LIMITS.tabs
                }
                onClick={() => {
                  edit(addTab(template, newTab));
                  setNewTab("");
                }}
              >
                +
              </button>
            </span>
          </div>

          <span className="settings-note">
            {placed.length} of {BODY_KEYS.length} fields placed
          </span>
        </div>

        {/* The grid, at the record's own proportions. */}
        <div
          className="record-fields tpl-grid"
          ref={gridRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (openTab) dropField(openTab.id, Number.MAX_SAFE_INTEGER);
          }}
        >
          {openTab?.fields.map((f, fi) => {
            const col = COLUMN_BY_KEY.get(f.key);
            if (!col) return null;
            const live = resizeTo?.key === f.key ? resizeTo : null;
            const span = live ? live.span : f.span;
            const rows = live ? live.rows : f.rows;
            const isDropTarget =
              dropAt?.tab === openTab.id && dropAt.index === fi;

            return (
              <div
                key={f.key}
                className={`detail-field tpl-field sp-${span}${
                  rows > 1 ? ` rw-${rows}` : ""
                }${col.dmOnly ? " dm-field" : ""}${
                  isDropTarget ? " over" : ""
                }`}
                draggable
                onDragStart={(e) => {
                  dragging.current = f.key;
                  e.dataTransfer.effectAllowed = "move";
                  // Firefox will not start a drag without payload.
                  e.dataTransfer.setData("text/plain", f.key);
                }}
                onDragEnd={() => {
                  dragging.current = null;
                  setDropAt(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropAt({ tab: openTab.id, index: fi });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dropField(openTab.id, fi);
                }}
              >
                <div className="detail-label">
                  <span className="tpl-grip" aria-hidden="true">
                    ⠿
                  </span>
                  {col.label}
                  {col.dmOnly && <span className="dm-tag">DM only</span>}
                </div>

                {/* Inert copies of the record's own controls, so the
                    shape and height of a field here is the shape and
                    height it will have. */}
                {col.kind === "longtext" ? (
                  <textarea className="detail-input" rows={4} disabled />
                ) : col.kind === "boolean" ? (
                  <label className="detail-check">
                    <input type="checkbox" disabled />
                    <span>No</span>
                  </label>
                ) : (
                  <input
                    className="detail-input"
                    disabled
                    placeholder={
                      col.kind === "chips" ? "comma, separated" : ""
                    }
                  />
                )}

                {/* Three handles, because width and height are
                    different decisions: the right edge widens, the
                    bottom edge makes it taller, the corner does both. */}
                <span
                  className="tpl-resize tpl-resize-x"
                  title="Drag to set how wide this field is"
                  onPointerDown={(e) =>
                    beginResize(e, f.key, "x", f.span, f.rows)
                  }
                />
                <span
                  className="tpl-resize tpl-resize-y"
                  title="Drag to set how many rows this field takes"
                  onPointerDown={(e) =>
                    beginResize(e, f.key, "y", f.span, f.rows)
                  }
                />
                <span
                  className="tpl-resize tpl-resize-xy"
                  title="Drag to set width and height"
                  onPointerDown={(e) =>
                    beginResize(e, f.key, "both", f.span, f.rows)
                  }
                />
                <span className="tpl-span">
                  {span}×{rows}
                </span>
              </div>
            );
          })}

          {openTab?.fields.length === 0 && (
            <p className="settings-note tpl-empty">
              Empty. Drag a field onto this tab’s name to move it here.
            </p>
          )}
        </div>
        </div>

        {/* Drawn because it is half the record, and leaving it out
            would make the tabs look twice as wide here as they are. */}
        <aside className="record-notes tpl-notes">
          <div className="detail-field">
            <div className="detail-label">Player Notes</div>
            <textarea className="detail-input" rows={5} disabled />
          </div>
          <div className="detail-field dm-field">
            <div className="detail-label">
              DM Notes<span className="dm-tag">DM only</span>
            </div>
            <textarea className="detail-input" rows={5} disabled />
          </div>
          <p className="settings-note">
            Fixed — the notes are read beside every tab.
          </p>
        </aside>
      </div>
      </div>

      <div className="cal-actions">
        <button
          type="button"
          className="npc-btn"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(null);
            setError(null);
          }}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="npc-btn"
          disabled={busy}
          title="Go back to the layout the app ships with"
          onClick={async () => {
            setBusy(true);
            try {
              setError(null);
              await reset({ campaignId });
              setDraft(null);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not reset the layout."
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Reset to default
        </button>
        <button
          type="button"
          className="npc-btn primary"
          disabled={!dirty || busy}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Save layout"}
        </button>
      </div>
    </section>
  );
}
