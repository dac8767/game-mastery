"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  NbNode,
  NodeRow,
  buildTree,
  folderColor,
  isAncestor,
  visibleNodes,
} from "@/components/notebookTree";
import { BoxCanvas, ContextMenu } from "@/components/BoxCanvas";
import { NotebookFormatBar } from "@/components/NotebookFormatBar";
import {
  registerScrapbookSaver,
  trackScrapbookSelection,
} from "@/components/notebookFormat";

/**
 * The Notebook: a tree of pages and coloured folders on the left, and a
 * canvas of free-floating boxes on the right.
 *
 * Notebooks are private per person per campaign — being the GM grants
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
 *
 * A box is chromeless until you touch it: no border and no head bar
 * until hover or focus. That is what makes the canvas read as a page
 * rather than a form. An EMPTY box is the exception and always shows its
 * border, because it has no contents to make it visible and would
 * otherwise be an invisible trap.
 */

type PageData = FunctionReturnType<typeof api.notebook.getPage>;
type Box = NonNullable<PageData>["boxes"][number];

/**
 * The TREE's context menu only.
 *
 * A box's menu belongs to the canvas, which owns it now — and it has to,
 * because a session has two canvases and one shared menu between them
 * would open over whichever one it felt like.
 */
type MenuState = { x: number; y: number; node: NbNode } | null;

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
  const [focusedBoxId, setFocusedBoxId] = useState<string | null>(null);

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

  // The format toolbar acts on whichever box the caret is in, and the
  // caret is gone by the time a button's click would fire — so the
  // selection is tracked continuously instead.
  useEffect(() => {
    document.addEventListener("selectionchange", trackScrapbookSelection);
    return () =>
      document.removeEventListener("selectionchange", trackScrapbookSelection);
  }, []);

  // notebookFormat is a plain DOM helper and knows nothing about Convex;
  // this is the one place that hands it a way to persist. Without it a
  // format is applied on screen and lost on reload.
  useEffect(
    () =>
      registerScrapbookSaver((boxId, html) =>
        void run(() =>
          updateBox({ boxId: boxId as Id<"notebookBoxes">, html })
        )
      ),
    [run, updateBox]
  );

  /** Upload and hand the id back; the canvas places the box. */
  async function uploadImage(file: File): Promise<string | null> {
    try {
      setError(null);
      const url = await generateUploadUrl();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) throw new Error("The image upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      return storageId;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      return null;
    }
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
              onMenu={(x, y) => setMenu({ x, y, node })}
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
        <NotebookFormatBar />

        {error && <p className="form-error nb-error">{error}</p>}

        {selectedId ? (
          <BoxCanvas
            boxes={page?.boxes ?? []}
            canEdit
            onAdd={(box) =>
              void run(() =>
                addBox({
                  pageId: selectedId,
                  ...box,
                  storageId: box.storageId as Id<"_storage"> | undefined,
                })
              )
            }
            onUpdate={(boxId, patch) =>
              void run(() =>
                updateBox({ boxId: boxId as Id<"notebookBoxes">, ...patch })
              )
            }
            onDelete={(boxId) =>
              void run(() =>
                deleteBox({ boxId: boxId as Id<"notebookBoxes"> })
              )
            }
            onUploadImage={uploadImage}
          >
            <span className="nb-page-title">{page?.title ?? ""}</span>
          </BoxCanvas>
        ) : (
          <p className="centered-note">Make a page to start writing.</p>
        )}
      </section>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
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
