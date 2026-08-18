"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  NbNode,
  NodeRow,
  buildTree,
  emptyTable,
  folderColor,
  isAncestor,
  rotatedImagePatch,
  tableDeleteCol,
  tableDeleteRow,
  tableInsertCol,
  tableInsertRow,
  tableSort,
  visibleNodes,
} from "@/components/notebookTree";

/**
 * The Notebook: a tree of pages and coloured folders on the left, and a
 * canvas of free-floating boxes on the right.
 *
 * Notebooks are private per person per campaign — being the DM grants
 * nothing over a player's notes. Session notes are where you write the
 * things you haven't decided to share yet.
 *
 * Three details from the source this was ported from are load-bearing
 * and easy to undo by accident:
 *   - every drag handler calls dataTransfer.setData(), because WebKit
 *     refuses a drag without it; Chrome doesn't care, so this looks fine
 *     in a browser and is dead in a Tauri window on macOS
 *   - context menus are portalled to document.body and positioned by
 *     measured coordinates, since an absolutely-positioned child cannot
 *     escape an ancestor's overflow whatever its z-index
 *   - stacking is the `order` field alone, never a second z-index
 */

type PageData = FunctionReturnType<typeof api.notebook.getPage>;
type Box = NonNullable<PageData>["boxes"][number];

type MenuState =
  | { kind: "node"; x: number; y: number; node: NbNode }
  | { kind: "box"; x: number; y: number; box: Box }
  | null;

const FOLDER_COLORS = [
  "#c9a227",
  "#4f9fd9",
  "#4caf6e",
  "#d95f3b",
  "#a97ad9",
  null,
];

export function NotebookTool({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const rows = useQuery(api.notebook.getTree, { campaignId });
  const [selectedId, setSelectedId] = useState<Id<"notebookNodes"> | null>(
    null
  );
  const page = useQuery(
    api.notebook.getPage,
    selectedId ? { pageId: selectedId } : "skip"
  );

  const addNode = useMutation(api.notebook.addNode);
  const renameNode = useMutation(api.notebook.renameNode);
  const setNodeColor = useMutation(api.notebook.setNodeColor);
  const setCollapsed = useMutation(api.notebook.setCollapsed);
  const moveNode = useMutation(api.notebook.moveNode);
  const deleteNode = useMutation(api.notebook.deleteNode);
  const addBox = useMutation(api.notebook.addBox);
  const updateBox = useMutation(api.notebook.updateBox);
  const deleteBox = useMutation(api.notebook.deleteBox);
  const generateUploadUrl = useMutation(api.notebook.generateUploadUrl);

  const [menu, setMenu] = useState<MenuState>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const nodeRows: NodeRow[] = useMemo(() => rows ?? [], [rows]);
  const tree = useMemo(() => buildTree(nodeRows), [nodeRows]);
  const visible = useMemo(() => visibleNodes(tree), [tree]);

  // Select the first page once the tree arrives, and recover if the
  // selected page is deleted — a dangling selection renders nothing and
  // looks like data loss.
  useEffect(() => {
    if (!rows) return;
    const stillThere =
      selectedId && nodeRows.some((n) => n._id === selectedId);
    if (stillThere) return;
    const first = nodeRows.find((n) => n.kind === "page");
    setSelectedId((first?._id as Id<"notebookNodes">) ?? null);
  }, [rows, nodeRows, selectedId]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  }, []);

  async function uploadImage(file: File) {
    if (!selectedId) return;
    await run(async () => {
      const url = await generateUploadUrl();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) throw new Error("The image upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      await addBox({
        pageId: selectedId,
        type: "image",
        x: 60,
        y: 60,
        w: 320,
        h: 240,
        storageId: storageId as Id<"_storage">,
      });
    });
  }

  if (rows === undefined) {
    return <p className="centered-note">Opening the notebook…</p>;
  }

  return (
    <div className="nb">
      <aside className="nb-sidebar">
        <div className="nb-sidebar-actions">
          <button
            type="button"
            className="npc-btn"
            onClick={() =>
              void run(() =>
                addNode({ campaignId, kind: "page", title: "New page" })
              )
            }
          >
            + Page
          </button>
          <button
            type="button"
            className="npc-btn"
            onClick={() =>
              void run(() =>
                addNode({ campaignId, kind: "section", title: "Folder" })
              )
            }
          >
            + Folder
          </button>
        </div>

        <ul className="nb-tree">
          {visible.map(({ node, depth }) => (
            <TreeRow
              key={node._id}
              node={node}
              depth={depth}
              selected={node._id === selectedId}
              onSelect={() => {
                if (node.kind === "page") {
                  setSelectedId(node._id as Id<"notebookNodes">);
                } else {
                  void run(() =>
                    setCollapsed({
                      nodeId: node._id as Id<"notebookNodes">,
                      collapsed: !node.collapsed,
                    })
                  );
                }
              }}
              onMenu={(x, y) => setMenu({ kind: "node", x, y, node })}
              onDrop={(draggedId) => {
                if (isAncestor(nodeRows, draggedId, node._id)) {
                  setError("A folder can't go inside itself.");
                  return;
                }
                const parentId =
                  node.kind === "section"
                    ? (node._id as Id<"notebookNodes">)
                    : ((node.parentId ?? undefined) as
                        | Id<"notebookNodes">
                        | undefined);
                void run(() =>
                  moveNode({
                    nodeId: draggedId as Id<"notebookNodes">,
                    parentId,
                    order: node.order + 0.5,
                  })
                );
              }}
            />
          ))}
          {visible.length === 0 && (
            <li className="nb-empty">No pages yet.</li>
          )}
        </ul>
      </aside>

      <section className="nb-main">
        <div className="nb-toolbar">
          <button
            type="button"
            className="npc-btn"
            disabled={!selectedId}
            onClick={() =>
              void run(() =>
                addBox({
                  pageId: selectedId!,
                  type: "text",
                  x: 40,
                  y: 40,
                  w: 280,
                  h: 160,
                  html: "",
                })
              )
            }
          >
            + Text
          </button>
          <button
            type="button"
            className="npc-btn"
            disabled={!selectedId}
            onClick={() => fileInput.current?.click()}
          >
            + Image
          </button>
          <button
            type="button"
            className="npc-btn"
            disabled={!selectedId}
            onClick={() => {
              const t = emptyTable(3, 3);
              void run(() =>
                addBox({
                  pageId: selectedId!,
                  type: "table",
                  x: 40,
                  y: 40,
                  w: 400,
                  h: 140,
                  rows: t.rows,
                  colWidths: t.colWidths,
                  rowHeights: t.rowHeights,
                })
              );
            }}
          >
            + Table
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadImage(file);
            }}
          />
          <span className="nb-page-title">{page?.title ?? ""}</span>
        </div>

        {error && <p className="form-error nb-error">{error}</p>}

        <div className="nb-canvas">
          {!selectedId && (
            <p className="centered-note">
              Make a page to start writing.
            </p>
          )}
          {page?.boxes.map((box) => (
            <BoxView
              key={box._id}
              box={box}
              onChange={(patch) =>
                void run(() => updateBox({ boxId: box._id, ...patch }))
              }
              onMenu={(x, y) => setMenu({ kind: "box", x, y, box })}
            />
          ))}
        </div>
      </section>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.kind === "node" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const title = window.prompt("Name", menu.node.title);
                  setMenu(null);
                  if (title !== null) {
                    void run(() =>
                      renameNode({
                        nodeId: menu.node._id as Id<"notebookNodes">,
                        title,
                      })
                    );
                  }
                }}
              >
                Rename
              </button>

              {menu.node.kind === "section" && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      void run(() =>
                        addNode({
                          campaignId,
                          kind: "page",
                          title: "New page",
                          parentId: menu.node._id as Id<"notebookNodes">,
                        })
                      );
                    }}
                  >
                    New page inside
                  </button>
                  <div className="nb-swatches">
                    {FOLDER_COLORS.map((c) => (
                      <button
                        type="button"
                        key={c ?? "none"}
                        className="nb-swatch"
                        style={{ background: c ?? "transparent" }}
                        title={c ?? "No colour"}
                        onClick={() => {
                          setMenu(null);
                          void run(() =>
                            setNodeColor({
                              nodeId: menu.node._id as Id<"notebookNodes">,
                              color: c,
                            })
                          );
                        }}
                      >
                        {c ? "" : "×"}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <button
                type="button"
                className="danger"
                onClick={() => {
                  setMenu(null);
                  const what =
                    menu.node.kind === "section"
                      ? `"${menu.node.title}" and everything inside it`
                      : `"${menu.node.title}"`;
                  if (window.confirm(`Delete ${what}? This can't be undone.`)) {
                    void run(() =>
                      deleteNode({
                        nodeId: menu.node._id as Id<"notebookNodes">,
                      })
                    );
                  }
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <BoxMenu
              box={menu.box}
              onClose={() => setMenu(null)}
              onChange={(patch) =>
                void run(() => updateBox({ boxId: menu.box._id, ...patch }))
              }
              onDelete={() => void run(() => deleteBox({ boxId: menu.box._id }))}
            />
          )}
        </ContextMenu>
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  onMenu,
  onDrop,
}: {
  node: NbNode;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
  onDrop: (draggedId: string) => void;
}) {
  const [over, setOver] = useState(false);
  const tint = node.color ?? (node.kind === "section" ? folderColor(node.title) : null);

  return (
    <li
      className={[
        "nb-row",
        node.kind === "section" ? "is-folder" : "is-page",
        selected ? "selected" : "",
        over ? "drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
      draggable
      onDragStart={(e) => {
        // WebKit refuses the drag entirely without this call.
        e.dataTransfer.setData("text/plain", node._id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dragged = e.dataTransfer.getData("text/plain");
        if (dragged && dragged !== node._id) onDrop(dragged);
      }}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className="nb-row-icon" style={tint ? { color: tint } : undefined}>
        {node.kind === "section" ? (node.collapsed ? "▸" : "▾") : "▪"}
      </span>
      <span className="nb-row-title">{node.title}</span>
    </li>
  );
}

/** Drag, resize, and the box's own content. */
function BoxView({
  box,
  onChange,
  onMenu,
}: {
  box: Box;
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

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setPos(
        mode === "move"
          ? { ...from, x: Math.max(0, from.x + dx), y: Math.max(0, from.y + dy) }
          : {
              ...from,
              w: Math.max(80, from.w + dx),
              h: Math.max(60, from.h + dy),
            }
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragging.current = false;
      // One write at the end of the gesture, not one per pixel.
      setPos((p) => {
        onChange(
          mode === "move" ? { x: p.x, y: p.y } : { w: p.w, h: p.h }
        );
        return p;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="nb-box"
      style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div
        className="nb-box-grip"
        onPointerDown={(e) => startGesture(e, "move")}
        title="Drag to move"
      />
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
  box: Box;
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

  return (
    <div
      ref={ref}
      className="nb-text"
      contentEditable
      suppressContentEditableWarning
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

function ImageBox({ box }: { box: Box }) {
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
  box: Box;
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
  box: Box;
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
function ContextMenu({
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
