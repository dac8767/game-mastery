"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  boxIsEmpty,
  emptyTable,
  rotatedImagePatch,
  tableDeleteCol,
  tableDeleteRow,
  tableInsertCol,
  tableInsertRow,
  tableSort,
} from "@/components/notebookTree";
import {
  focusScrapbookBox,
  forgetScrapbookBox,
} from "@/components/notebookFormat";

/**
 * A page of free-floating boxes: text, images and tables, dragged and
 * resized where you want them.
 *
 * This is the Notebook's canvas, lifted out of NotebookTool so a session
 * can have two of them — its player notes and its DM notes — with the
 * same formatting, the same tables and the same images rather than a
 * second implementation that is nearly the same. Everything the two
 * uses disagree about is a prop: where the boxes come from, who may
 * write, and what an upload does with the file.
 *
 * What did NOT come along is the format toolbar and the selection
 * tracker. Both are SCREEN-level: notebookFormat holds one saver and one
 * tracked selection for the whole document, so two canvases each
 * registering their own would leave the last one mounted writing
 * everybody's edits. The screen registers once and renders one bar,
 * which is also how it reads — the bar acts on whichever box the caret
 * is in, wherever that box is.
 *
 * Three details ported with the rest are load-bearing and easy to undo:
 *   - every drag handler calls dataTransfer.setData(), because WebKit
 *     refuses a drag without it; Chrome doesn't care, so this looks fine
 *     in a browser and is dead in a Tauri window on macOS
 *   - context menus are portalled to document.body and positioned by
 *     measured coordinates, since an absolutely-positioned child cannot
 *     escape an ancestor's overflow whatever its z-index
 *   - stacking is the `order` field alone, never a second z-index
 *
 * A box is chromeless until you touch it: no border and no head bar
 * until hover or focus. That is what makes the canvas read as a page
 * rather than a form. An EMPTY box is the exception and always shows its
 * border, because it has no contents to make it visible and would
 * otherwise be an invisible trap.
 */

/**
 * A box as the canvas needs it.
 *
 * Structural rather than tied to one table's Doc: the notebook's boxes
 * and a session's boxes are the same shape in two stores, and the
 * canvas should not have to know which it is drawing. `src` is a
 * resolved URL — the client never handles a storage id.
 */
export type CanvasBox = {
  _id: string;
  type: "text" | "image" | "table";
  x: number;
  y: number;
  w: number;
  h: number;
  order: number;
  html?: string | null;
  src?: string | null;
  rotate?: number | null;
  borderW?: number | null;
  borderColor?: string | null;
  rows?: string[][] | null;
  colWidths?: number[] | null;
  rowHeights?: number[] | null;
  align?: "left" | "center" | "right" | null;
  borderless?: boolean | null;
  shading?: string | null;
};

/** What a new box is made with. The canvas picks the position. */
export type NewBox = {
  type: "text" | "image" | "table";
  x: number;
  y: number;
  w: number;
  h: number;
  html?: string;
  storageId?: string;
  rows?: string[][];
  colWidths?: number[];
  rowHeights?: number[];
};

/**
 * The three buttons that put something new on a page.
 *
 * Its own component because it is mounted in two different places: a
 * canvas that owns its toolbar renders it above itself, and a screen
 * with two canvases renders ONE of these in the format bar and decides
 * the side. Copying the upload dance to the second site is how the two
 * end up handling a failed upload differently.
 */
export function BoxTools({
  onAdd,
  onUploadImage,
  label,
}: {
  onAdd: (box: NewBox) => void;
  onUploadImage: (file: File) => Promise<string | null>;
  /** Said out loud where a click could plausibly land on two pages. */
  label?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      {label && <span className="nb-tools-label">{label}</span>}
      <button
        type="button"
        className="npc-btn"
        onClick={() =>
          onAdd({ type: "text", x: 40, y: 40, w: 280, h: 160, html: "" })
        }
      >
        + Text
      </button>
      <button
        type="button"
        className="npc-btn"
        onClick={() => fileInput.current?.click()}
      >
        + Image
      </button>
      <button
        type="button"
        className="npc-btn"
        onClick={() => {
          const t = emptyTable(3, 3);
          onAdd({
            type: "table",
            x: 40,
            y: 40,
            w: 400,
            h: 140,
            rows: t.rows,
            colWidths: t.colWidths,
            rowHeights: t.rowHeights,
          });
        }}
      >
        + Table
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          // Cleared straight away so choosing the SAME file twice still
          // fires a change event the second time.
          e.target.value = "";
          if (!file) return;
          const storageId = await onUploadImage(file);
          if (!storageId) return;
          onAdd({ type: "image", x: 60, y: 60, w: 320, h: 240, storageId });
        }}
      />
    </>
  );
}

export function BoxCanvas({
  boxes,
  canEdit,
  tools = "own",
  onAdd,
  onUpdate,
  onDelete,
  onUploadImage,
  onFollowLink,
  emptyNote,
  children,
}: {
  boxes: CanvasBox[];
  /** A read-only canvas still draws; it just grows no controls. */
  canEdit: boolean;
  /**
   * Where the "add a box" buttons are.
   *
   * "own" is a toolbar above this canvas, which is right when the
   * canvas is the screen. "elsewhere" is for a screen holding TWO of
   * them — a session's two pages — where one set of buttons in the
   * shared format bar is both fewer buttons and an unambiguous answer
   * to which page a click adds to.
   */
  tools?: "own" | "elsewhere";
  onAdd: (box: NewBox) => void;
  onUpdate: (boxId: string, patch: Record<string, unknown>) => void;
  onDelete: (boxId: string) => void;
  /** Upload the file and return its storage id, or null if it failed. */
  onUploadImage: (file: File) => Promise<string | null>;
  /**
   * Follow a link written into a text box.
   *
   * Needed because a box is contentEditable, where a click on an
   * anchor places the caret and goes nowhere — so a link in the notes
   * looks like a link, is a link, and does nothing at all without
   * this. Delegated from the canvas rather than bound per box: the
   * boxes come and go and the canvas does not.
   */
  onFollowLink?: (href: string) => void;
  emptyNote?: string;
  /** Anything the owner wants on the toolbar, after the three buttons. */
  children?: React.ReactNode;
}) {
  const [focusedBoxId, setFocusedBoxId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; box: CanvasBox } | null>(
    null
  );

  return (
    <div className="nb-canvas-wrap">
      {canEdit && tools === "own" && (
        <div className="nb-toolbar">
          <BoxTools onAdd={onAdd} onUploadImage={onUploadImage} />
          {children}
        </div>
      )}

      <div
        className="nb-canvas"
        // Only a click on the canvas ITSELF clears the focus ring; a
        // click that landed on a box bubbles up here too, and treating
        // that as "nothing selected" would unfocus the box you just
        // clicked into.
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setFocusedBoxId(null);
        }}
        onClick={(e) => {
          if (!onFollowLink) return;
          const anchor = (e.target as HTMLElement).closest?.("a[data-gm]");
          const href = anchor?.getAttribute("href");
          // Only OUR links. Anything else in the box is text somebody
          // pasted, and hijacking a click on it would be the editor
          // deciding what a stray anchor meant.
          if (!href) return;
          e.preventDefault();
          onFollowLink(href);
        }}
      >
        {boxes.length === 0 && emptyNote && (
          <p className="centered-note">{emptyNote}</p>
        )}
        {boxes.map((box) => (
          <BoxView
            key={box._id}
            box={box}
            focused={focusedBoxId === box._id}
            onFocus={() => setFocusedBoxId(box._id)}
            onChange={(patch) => onUpdate(box._id, patch)}
            onMenu={(x, y) => (canEdit ? setMenu({ x, y, box }) : undefined)}
          />
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <BoxMenu
            box={menu.box}
            onClose={() => setMenu(null)}
            onChange={(patch) => onUpdate(menu.box._id, patch)}
            onDelete={() => onDelete(menu.box._id)}
          />
        </ContextMenu>
      )}
    </div>
  );
}

function BoxView({
  box,
  focused,
  onFocus,
  onChange,
  onMenu,
}: {
  box: CanvasBox;
  focused: boolean;
  onFocus: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onMenu: (x: number, y: number) => void;
}) {
  const [pos, setPos] = useState({ x: box.x, y: box.y, w: box.w, h: box.h });

  // Follow the server unless this box is mid-gesture.
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setPos({ x: box.x, y: box.y, w: box.w, h: box.h });
  }, [box.x, box.y, box.w, box.h]);

  const startGesture = (
    e: React.PointerEvent,
    mode: "move" | "resize"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const from = { ...pos };

    // The live position, kept in the closure. It is what `onUp` writes,
    // and keeping it here is the whole fix for the bug below.
    let latest = from;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      latest =
        mode === "move"
          ? { ...from, x: Math.max(0, from.x + dx), y: Math.max(0, from.y + dy) }
          : {
              ...from,
              w: Math.max(80, from.w + dx),
              h: Math.max(60, from.h + dy),
            };
      setPos(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragging.current = false;

      /**
       * One write at the end of the gesture, not one per pixel — and
       * called from HERE rather than from inside a setPos updater.
       *
       * `setPos((p) => { onChange(...); return p; })` reads as "give me
       * the current position", and it does. But React runs an updater
       * during the RENDER phase, so onChange — which sets error state up
       * in NotebookTool — ran while React was rendering this component:
       * "Cannot update a component while rendering a different one."
       *
       * An updater that returns its argument unchanged is only ever
       * there for its side effect, which is the tell.
       */
      onChange(
        mode === "move"
          ? { x: latest.x, y: latest.y }
          : { w: latest.w, h: latest.h }
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const empty = boxIsEmpty(box);

  return (
    <div
      className={["nb-box", focused ? "focused" : "", empty ? "empty" : ""]
        .filter(Boolean)
        .join(" ")}
      style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}
      onMouseDown={onFocus}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {/*
        The head bar FLOATS above the box rather than sitting inside it.
        Inside, it would push the content down every time it appeared on
        hover — a jump on every mouse-over.
      */}
      <div
        className="nb-box-head nb-box-head-float"
        onPointerDown={(e) => startGesture(e, "move")}
        title="Drag to move"
      >
        <span className="nb-box-dots">⋮⋮</span>
        <button
          type="button"
          title="More"
          // The head bar owns pointerdown for dragging, so this button
          // has to opt out of it or every press starts a drag.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e.clientX, e.clientY);
          }}
        >
          ⋯
        </button>
      </div>
      <div className="nb-box-body">
        {box.type === "text" && <TextBox box={box} onChange={onChange} />}
        {box.type === "image" && <ImageBox box={box} />}
        {box.type === "table" && <TableBox box={box} onChange={onChange} />}
      </div>
      <div
        className="nb-box-resize"
        onPointerDown={(e) => startGesture(e, "resize")}
        title="Drag to resize"
      />
    </div>
  );
}

function TextBox({
  box,
  onChange,
}: {
  box: CanvasBox;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Write the server's HTML in only when this box isn't being typed in.
  // Reassigning innerHTML under the caret would move it to the start on
  // every keystroke.
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const next = box.html ?? "";
    if (el.innerHTML !== next) el.innerHTML = next;
  }, [box.html]);

  // Nothing may format a box that has gone away.
  const boxId = box._id as string;
  useEffect(() => () => forgetScrapbookBox(boxId), [boxId]);

  return (
    <div
      ref={ref}
      className="nb-text"
      // BOX_ATTR — the attribute the format toolbar's tracker keys on.
      // It goes on the editable element itself, because the apply helper
      // reads innerHTML off whatever it finds and persists that as the
      // box's content.
      data-nb-box={boxId}
      contentEditable
      suppressContentEditableWarning
      // Belt and braces alongside the selectionchange listener: the very
      // first toolbar press has to work, and clicking into an empty box
      // does not necessarily fire a selection change.
      onFocus={() => focusScrapbookBox(ref.current, boxId)}
      // Commit on blur. Clicking straight from one box to another must
      // save the first — blur ordering is where contentEditable loses
      // edits.
      onBlur={() => {
        const html = ref.current?.innerHTML ?? "";
        if (html !== (box.html ?? "")) onChange({ html });
      }}
    />
  );
}

function ImageBox({ box }: { box: CanvasBox }) {
  if (!box.src) return <div className="nb-image-missing">Image missing</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="nb-image"
      src={box.src}
      alt=""
      style={{
        transform: box.rotate ? `rotate(${box.rotate}deg)` : undefined,
        border: box.borderW
          ? `${box.borderW}px solid ${box.borderColor ?? "#fff"}`
          : undefined,
      }}
      draggable={false}
    />
  );
}

function TableBox({
  box,
  onChange,
}: {
  box: CanvasBox;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const rows = box.rows ?? [[""]];

  const setCell = (r: number, c: number, value: string) => {
    const next = rows.map((row, i) =>
      i === r ? row.map((cell, j) => (j === c ? value : cell)) : row
    );
    onChange({ rows: next });
  };

  return (
    <table
      className={`nb-table${box.borderless ? " borderless" : ""}`}
      style={box.shading ? { background: box.shading } : undefined}
    >
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => (
              <td key={c} style={{ width: box.colWidths?.[c] }}>
                <input
                  value={cell}
                  style={{ textAlign: box.align ?? "left" }}
                  onChange={(e) => setCell(r, c, e.target.value)}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BoxMenu({
  box,
  onClose,
  onChange,
  onDelete,
}: {
  box: CanvasBox;
  onClose: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const table = {
    rows: box.rows ?? [[""]],
    colWidths: box.colWidths ?? [],
    rowHeights: box.rowHeights ?? [],
  };

  return (
    <>
      {box.type === "image" && (
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(rotatedImagePatch(box, 90));
            }}
          >
            Rotate right
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(rotatedImagePatch(box, -90));
            }}
          >
            Rotate left
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange({ borderW: box.borderW ? 0 : 4, borderColor: "#e8e2d9" });
            }}
          >
            {box.borderW ? "Remove border" : "Add border"}
          </button>
        </>
      )}

      {box.type === "table" && (
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(tableInsertRow(table, table.rows.length));
            }}
          >
            Add row
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(tableInsertCol(table, table.colWidths.length));
            }}
          >
            Add column
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(tableDeleteRow(table, table.rows.length - 1));
            }}
          >
            Delete last row
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(tableDeleteCol(table, table.colWidths.length - 1));
            }}
          >
            Delete last column
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange(tableSort(table, 0, true));
            }}
          >
            Sort by first column
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onChange({ borderless: !box.borderless });
            }}
          >
            {box.borderless ? "Show borders" : "Hide borders"}
          </button>
        </>
      )}

      <button
        type="button"
        className="danger"
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        Delete box
      </button>
    </>
  );
}

/**
 * Portalled to document.body and placed by measured coordinates.
 *
 * An absolutely-positioned child cannot escape an ancestor's overflow or
 * stacking context whatever its z-index, so a menu rendered in the
 * sidebar would be clipped inside it and unclickable.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const close = () => onClose();
    // Defer, or the click that opened the menu closes it immediately.
    const id = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("resize", close);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="nb-menu"
      // top/left, never bottom-only: `position: fixed` anchored by
      // `bottom` with a max-height collapses to a sliver in WebKit.
      style={{ top: Math.min(y, window.innerHeight - 240), left: x }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}
