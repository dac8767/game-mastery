"use client";

import React, { useState } from "react";

/**
 * Two (or more) drag-and-drop columns: Shown on the left, Hidden on the
 * right.
 *
 * Shared on purpose. Every customization screen in the app should use
 * the same shape, so learning one teaches you all of them: the adder
 * goes in the Shown column's header, Hide All goes in the Hidden
 * column's header, and never in a bar at the bottom — an adder belongs
 * on the list it adds to.
 *
 * Two details are load-bearing and easy to undo:
 *
 *   - dataTransfer.setData() on every drag start. WebKit refuses to
 *     START a drag without it and Chrome doesn't care, so omitting it
 *     looks perfect in a browser and is stone dead in a packaged desktop
 *     window on macOS.
 *   - this component is declared at MODULE scope. A component defined
 *     inside another is a new type on every render, which remounts it
 *     mid-drag and the drag dies.
 */

export interface DndRow {
  key: string;
  content: React.ReactNode;
  /** Can be neither dragged nor dropped onto. */
  locked?: boolean;
}

export interface DndColumnSpec {
  id: string;
  title: string;
  headerExtra?: React.ReactNode;
  /** Shown uses one unlabelled section; Hidden uses one per category. */
  sections: Array<{ label?: string; rows: DndRow[] }>;
  /** Hidden semantics: a drop stashes the item, position ignored. */
  isHidden?: boolean;
}

export function DndColumns({
  columns,
  onDrop,
}: {
  columns: DndColumnSpec[];
  onDrop: (
    src: { col: string; key: string },
    dst: { col: string; idx: number }
  ) => void;
}) {
  const [drag, setDrag] = useState<{ col: string; key: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const rowProps = (col: DndColumnSpec, row: DndRow, flatIdx: number) => ({
    draggable: !row.locked,
    onDragStart: (e: React.DragEvent) => {
      // WebKit refuses to start a drag without data on the transfer.
      e.dataTransfer.setData("text/plain", row.key);
      e.dataTransfer.effectAllowed = "move";
      setDrag({ col: col.id, key: row.key });
    },
    onDragOver: (e: React.DragEvent) => {
      if (drag) {
        e.preventDefault();
        setOver(col.id);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation(); // don't also fire the column's drop
      if (drag && !(drag.col === col.id && drag.key === row.key)) {
        onDrop(drag, { col: col.id, idx: flatIdx });
      }
      setDrag(null);
      setOver(null);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
  });

  return (
    <div className="dnd-cols">
      {columns.map((col) => {
        const flatCount = col.sections.reduce((n, s) => n + s.rows.length, 0);
        let flatIdx = -1;
        return (
          <div
            key={col.id}
            className={[
              "dnd-col",
              over === col.id && drag ? "drop-target" : "",
              col.isHidden ? "dnd-hiddencol" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onDragOver={(e) => {
              if (drag) {
                e.preventDefault();
                setOver(col.id);
              }
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setOver(null);
            }}
            // Dropping on the column's empty space appends.
            onDrop={(e) => {
              e.preventDefault();
              if (drag) onDrop(drag, { col: col.id, idx: flatCount });
              setDrag(null);
              setOver(null);
            }}
          >
            <div className="dnd-col-head">
              <span>{col.title}</span>
              {/* Wrapped: the head is space-between, so an unwrapped
                  second child gets stranded in the middle of the row
                  instead of joining the first. */}
              {col.headerExtra && (
                <span className="dnd-col-head-actions">{col.headerExtra}</span>
              )}
            </div>

            <div className="dnd-col-body">
              {col.sections.map((sec, si) => (
                <React.Fragment key={sec.label ?? si}>
                  {sec.label && sec.rows.length > 0 && (
                    <div className="dnd-cat">{sec.label}</div>
                  )}
                  {sec.rows.map((row) => {
                    flatIdx += 1;
                    return (
                      <div
                        key={row.key}
                        className={[
                          "dnd-row",
                          drag?.key === row.key && drag.col === col.id
                            ? "dragging"
                            : "",
                          row.locked ? "locked" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        {...rowProps(col, row, flatIdx)}
                      >
                        {!row.locked && (
                          <span className="dnd-grip" title="Drag to move">
                            ⋮⋮
                          </span>
                        )}
                        {row.content}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
              {flatCount === 0 && (
                <div className="dnd-empty">Drop items here</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
