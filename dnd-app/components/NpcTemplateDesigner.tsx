"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { COLUMN_BY_KEY } from "@/components/npcColumns";
import { BODY_KEYS, resolveTemplate } from "@/components/NpcDetail";
import {
  MAX_SPAN,
  MIN_SPAN,
  NpcTemplate,
  TEMPLATE_LIMITS,
  addTab,
  moveField,
  removeTab,
  renameTab,
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
    startX: number;
    startSpan: number;
    columnWidth: number;
  } | null>(null);
  const [resizeSpan, setResizeSpan] = useState<{
    key: string;
    span: number;
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

  const beginResize = (e: React.PointerEvent, key: string, span: number) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    // Measured rather than assumed: the grid is fluid, and a span read
    // off a guessed column width jumps by two where it should jump by
    // one.
    const style = getComputedStyle(grid);
    const gap = parseFloat(style.columnGap || "0") || 0;
    const columnWidth = (grid.clientWidth - gap * (COLUMNS - 1)) / COLUMNS;

    resizing.current = { key, startX: e.clientX, startSpan: span, columnWidth };
    setResizeSpan({ key, span });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const moveResize = (e: React.PointerEvent) => {
    const r = resizing.current;
    if (!r || r.columnWidth <= 0) return;
    const delta = Math.round((e.clientX - r.startX) / r.columnWidth);
    const span = Math.min(
      MAX_SPAN,
      Math.max(MIN_SPAN, r.startSpan + delta)
    );
    setResizeSpan({ key: r.key, span });
  };

  const endResize = () => {
    const r = resizing.current;
    const asked = resizeSpan;
    resizing.current = null;
    setResizeSpan(null);
    if (r && asked && asked.span !== r.startSpan) {
      edit(setSpan(template, r.key, asked.span));
    }
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
        edge to make it wider, or drop it on a tab to send it there.
        Everyone in this campaign opens an NPC to whatever you arrange
        here — which fields a player actually receives is still decided on
        the server, so a DM-only field on a shared tab stays hidden from
        them.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="tpl-wys" onPointerMove={moveResize} onPointerUp={endResize}>
        {/* The record's header, drawn as the record draws it. Not
            arrangeable: the portrait and the name are what tell you
            whose record you are looking at. */}
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
          <span className="settings-note tpl-head-note">
            Fixed — every record opens on its portrait and name.
          </span>
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
            const span =
              resizeSpan?.key === f.key ? resizeSpan.span : f.span;
            const isDropTarget =
              dropAt?.tab === openTab.id && dropAt.index === fi;

            return (
              <div
                key={f.key}
                className={`detail-field tpl-field sp-${span}${
                  col.dmOnly ? " dm-field" : ""
                }${isDropTarget ? " over" : ""}`}
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

                <span
                  className="tpl-resize"
                  title="Drag to set how wide this field is"
                  onPointerDown={(e) => beginResize(e, f.key, f.span)}
                />
                <span className="tpl-span">{span}/4</span>
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
