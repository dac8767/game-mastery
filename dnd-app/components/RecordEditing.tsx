"use client";

import { useRef, useState } from "react";
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
} from "@/components/npcTemplate";

/**
 * Arranging the NPC record: dragging, resizing, and the tab strip.
 *
 * ONE implementation, mounted twice — by the designer in Settings and
 * by the record itself in edit mode. The integrity guard already
 * demands those two draw the same layout; sharing the interaction is
 * what stops them drifting on the half a guard cannot see, which is how
 * a "what you see is what you get" editor stops being either.
 *
 * The snapping is the grid the record already has: four columns across
 * and a fixed row track down, both measured off the live grid rather
 * than assumed. A step read from a guessed column width jumps two
 * columns where the pointer asked for one, and the record grid is
 * fluid, so it has to be measured every time a drag starts.
 */

/** The record grid is four columns; a span is meaningless without it. */
export const COLUMNS = 4;

export interface TemplateEditing {
  gridRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the grid: it owns the pointer for a resize in flight. */
  gridProps: {
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
  };
  /** The span/rows to render right now, live during a drag. */
  liveSpan: (key: string, span: number) => number;
  liveRows: (key: string, rows: number) => number;
  beginResize: (
    e: React.PointerEvent,
    key: string,
    axis: "x" | "y" | "both",
    span: number,
    rows: number
  ) => void;
  dragProps: (key: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  /** Where the pointer last suggested a field would land. */
  dropAt: { tab: string; index: number } | null;
  setDropAt: (at: { tab: string; index: number } | null) => void;
  dropField: (toTabId: string, index: number) => void;
}

export function useTemplateEditing(
  template: NpcTemplate,
  onChange: (next: NpcTemplate) => void
): TemplateEditing {
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<{ tab: string; index: number } | null>(
    null
  );

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

  const beginResize: TemplateEditing["beginResize"] = (
    e,
    key,
    axis,
    span,
    rows
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;

    // Measured, not assumed, on both axes. The row height is a fixed
    // track — that is what makes "two rows" mean the same height
    // everywhere and lets a two-row field line up with two one-row
    // fields beside it.
    const style = getComputedStyle(grid);
    const colGap = parseFloat(style.columnGap || "0") || 0;
    const rowGap = parseFloat(style.rowGap || "0") || 0;
    const columnWidth = (grid.clientWidth - colGap * (COLUMNS - 1)) / COLUMNS;
    const rowHeight = (parseFloat(style.gridAutoRows || "0") || 0) + rowGap;

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

  const onPointerMove = (e: React.PointerEvent) => {
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

  const onPointerUp = () => {
    const r = resizing.current;
    const asked = resizeTo;
    resizing.current = null;
    setResizeTo(null);
    if (!r || !asked) return;

    let next = template;
    if (asked.span !== r.startSpan) next = setSpan(next, r.key, asked.span);
    if (asked.rows !== r.startRows) next = setRows(next, r.key, asked.rows);
    if (next !== template) onChange(next);
  };

  const dropField = (toTabId: string, index: number) => {
    const key = dragging.current;
    dragging.current = null;
    setDropAt(null);
    if (!key) return;
    onChange(moveField(template, key, toTabId, index));
  };

  return {
    gridRef,
    gridProps: { onPointerMove, onPointerUp },
    liveSpan: (key, span) =>
      resizeTo?.key === key ? resizeTo.span : span,
    liveRows: (key, rows) => (resizeTo?.key === key ? resizeTo.rows : rows),
    beginResize,
    dragProps: (key) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragging.current = key;
        e.dataTransfer.effectAllowed = "move";
        // Firefox will not start a drag without payload.
        e.dataTransfer.setData("text/plain", key);
      },
      onDragEnd: () => {
        dragging.current = null;
        setDropAt(null);
      },
    }),
    dropAt,
    setDropAt,
    dropField,
  };
}

/**
 * Three handles, because width and height are different decisions: the
 * right edge widens, the bottom edge makes it taller, the corner does
 * both.
 */
export function ResizeHandles({
  editing,
  fieldKey,
  span,
  rows,
}: {
  editing: TemplateEditing;
  fieldKey: string;
  span: number;
  rows: number;
}) {
  return (
    <>
      <span
        className="tpl-resize tpl-resize-x"
        title="Drag to set how wide this field is"
        onPointerDown={(e) =>
          editing.beginResize(e, fieldKey, "x", span, rows)
        }
      />
      <span
        className="tpl-resize tpl-resize-y"
        title="Drag to set how many rows this field takes"
        onPointerDown={(e) =>
          editing.beginResize(e, fieldKey, "y", span, rows)
        }
      />
      <span
        className="tpl-resize tpl-resize-xy"
        title="Drag to set width and height"
        onPointerDown={(e) =>
          editing.beginResize(e, fieldKey, "both", span, rows)
        }
      />
    </>
  );
}

/**
 * The tab strip, while it is being arranged.
 *
 * Each tab is a text field rather than a label, so renaming it is
 * typing in it. The arrows move it, the × removes it and hands its
 * fields to the tab beside it — a tab that took its fields with it
 * would be a way to lose a field with no way to get it back.
 */
export function TabStripEditor({
  template,
  editing,
  openTabId,
  onChange,
  onOpen,
}: {
  template: NpcTemplate;
  editing: TemplateEditing;
  openTabId: string | null;
  onChange: (next: NpcTemplate) => void;
  onOpen: (id: string) => void;
}) {
  const [newTab, setNewTab] = useState("");

  return (
    <div className="record-tabs tpl-tabstrip" role="tablist">
      {template.tabs.map((tab, ti) => (
        <div
          key={tab.id}
          className={`tpl-tabchip${tab.id === openTabId ? " on" : ""}${
            editing.dropAt?.tab === tab.id && editing.dropAt.index < 0
              ? " over"
              : ""
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            editing.setDropAt({ tab: tab.id, index: -1 });
          }}
          onDragLeave={() => editing.setDropAt(null)}
          onDrop={(e) => {
            e.preventDefault();
            editing.dropField(tab.id, Number.MAX_SAFE_INTEGER);
          }}
        >
          <input
            className="tpl-tabchip-name"
            value={tab.title}
            maxLength={TEMPLATE_LIMITS.titleLength}
            aria-label={`Name of tab ${ti + 1}`}
            size={Math.max(4, tab.title.length)}
            onFocus={() => onOpen(tab.id)}
            onChange={(e) => onChange(renameTab(template, tab.id, e.target.value))}
          />
          <button
            type="button"
            className="tpl-tabchip-btn"
            title="Move this tab left"
            disabled={ti === 0}
            onClick={() => onChange(shiftTab(template, tab.id, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            className="tpl-tabchip-btn"
            title="Move this tab right"
            disabled={ti === template.tabs.length - 1}
            onClick={() => onChange(shiftTab(template, tab.id, 1))}
          >
            ›
          </button>
          <button
            type="button"
            className="tpl-tabchip-btn"
            title="Remove this tab — its fields move to the one beside it"
            disabled={template.tabs.length <= 1}
            onClick={() => onChange(removeTab(template, tab.id))}
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
            onChange(addTab(template, newTab));
            setNewTab("");
          }}
        />
        <button
          type="button"
          className="tpl-tabchip-btn"
          title="Add this tab"
          disabled={
            !newTab.trim() || template.tabs.length >= TEMPLATE_LIMITS.tabs
          }
          onClick={() => {
            onChange(addTab(template, newTab));
            setNewTab("");
          }}
        >
          +
        </button>
      </span>
    </div>
  );
}
