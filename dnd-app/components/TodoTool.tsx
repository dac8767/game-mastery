"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import {
  MAX_TEXT,
  dueState,
  isDate,
  reorderTo,
  sortTodos,
  todayISO,
} from "@/components/todoModel";
import { NAV_ITEM_BY_ID } from "@/components/navItems";

/**
 * The DM's prep list.
 *
 * A checklist, not a project tracker. The thing it has to be good at is
 * the twenty seconds between remembering something and forgetting it
 * again: one field, type, Enter, gone. Everything else — the date, the
 * note, the order — is available and none of it is in the way.
 *
 * The whole tool is DM-only, and convex/todo.ts refuses a non-DM caller
 * outright rather than returning an empty list. Nothing here re-derives
 * that; a player who reaches this screen sees the error the server
 * gave, which is the honest thing for a screen that is not theirs.
 */

const DUE_LABEL: Record<string, string> = {
  overdue: "Overdue",
  today: "Today",
  soon: "This week",
};

export function TodoTool({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const items = useQuery(api.todo.listTodos, { campaignId });
  const addTodo = useMutation(api.todo.addTodo);
  const setDone = useMutation(api.todo.setDone);
  const updateTodo = useMutation(api.todo.updateTodo);
  const reorderTodos = useMutation(api.todo.reorderTodos);
  const deleteTodo = useMutation(api.todo.deleteTodo);
  const clearDone = useMutation(api.todo.clearDone);

  const [draft, setDraft] = useState("");
  const [draftDue, setDraftDue] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // Read once per render rather than per item: a list that straddled
  // midnight would otherwise colour its first half against yesterday.
  const today = useMemo(() => todayISO(), []);
  const sorted = useMemo(() => (items ? sortTodos(items) : []), [items]);
  const openCount = sorted.filter((i) => !i.done).length;
  const doneCount = sorted.length - openCount;

  function run(fn: () => Promise<unknown>) {
    setError(null);
    void fn().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "That didn't work.")
    );
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    // Cleared immediately rather than on success: the point of this
    // field is the next thought, and waiting on a round trip to type
    // it is how the second thing gets forgotten.
    setDraft("");
    const due = draftDue.trim();
    run(() =>
      addTodo({
        campaignId,
        text,
        due: due && isDate(due) ? due : undefined,
      })
    );
  }

  /** Drop `dragging` where `overId` currently sits. */
  function drop(overId: string) {
    if (!dragging || dragging === overId || !items) return;
    const open = sortTodos(items).filter((i) => !i.done);
    const to = open.findIndex((i) => i._id === overId);
    setDragging(null);
    if (to === -1) return;

    const moves = reorderTo(open, dragging, to);
    if (moves.length === 0) return;
    run(() =>
      reorderTodos({
        campaignId,
        moves: moves.map((m) => ({
          todoId: m._id as Id<"todos">,
          order: m.order,
        })),
      })
    );
  }

  if (items === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  return (
    <div className="todo">
      <form className="todo-add" onSubmit={add}>
        <input
          className="todo-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What needs doing before next session?"
          maxLength={MAX_TEXT}
          aria-label="New item"
        />
        <input
          className="todo-date"
          type="date"
          value={draftDue}
          onChange={(e) => setDraftDue(e.target.value)}
          aria-label="Due date"
        />
        <button type="submit" className="npc-btn primary" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      {error && <p className="form-error nb-error">{error}</p>}

      {/* The count row is hidden on an empty list. It used to say
          "Nothing outstanding." directly above "Nothing here yet.",
          which is one fact told twice in two voices. */}
      {sorted.length > 0 && (
      <div className="todo-count">
        {openCount === 0 ? (
          <span>All done — {doneCount} finished.</span>
        ) : (
          <span>
            {openCount} to do{doneCount > 0 && `, ${doneCount} done`}
          </span>
        )}
        {doneCount > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (window.confirm(`Delete ${doneCount} finished item(s)?`)) {
                run(() => clearDone({ campaignId }));
              }
            }}
          >
            Clear finished
          </button>
        )}
      </div>
      )}

      <ul className="todo-list">
        {sorted.map((item) => {
          const state = dueState(item.due, today);
          return (
            <li
              key={item._id}
              className={`todo-item${item.done ? " done" : ""}${
                dragging === item._id ? " dragging" : ""
              }${state ? ` due-${state}` : ""}`}
              // Only open items reorder. A finished item's place is
              // decided by when it was finished, so dragging one would
              // be a move that silently undoes itself.
              draggable={!item.done}
              onDragStart={() => setDragging(item._id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                if (dragging && !item.done) e.preventDefault();
              }}
              onDrop={() => drop(item._id)}
            >
              <input
                type="checkbox"
                className="todo-check"
                checked={item.done}
                aria-label={item.done ? "Not done after all" : "Done"}
                onChange={(e) =>
                  run(() =>
                    setDone({
                      todoId: item._id as Id<"todos">,
                      done: e.target.checked,
                    })
                  )
                }
              />

              <div className="todo-body">
                {editing === item._id ? (
                  <input
                    className="todo-edit"
                    autoFocus
                    defaultValue={item.text}
                    maxLength={MAX_TEXT}
                    aria-label="Edit item"
                    onBlur={(e) => {
                      const text = e.target.value.trim();
                      setEditing(null);
                      if (text && text !== item.text) {
                        run(() =>
                          updateTodo({ todoId: item._id as Id<"todos">, text })
                        );
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      // Escape abandons the edit, so a mistyped line
                      // is not committed by looking away from it.
                      if (e.key === "Escape") {
                        e.currentTarget.value = item.text;
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="todo-text"
                    onClick={() => setEditing(item._id)}
                  >
                    {item.text}
                  </button>
                )}

                {item.notes && <p className="todo-notes">{item.notes}</p>}
              </div>

              {/* Where this came from. Eventually most of these are
                  written by other tools — tag a line in a session's
                  notes and the item arrives carrying a way back to
                  it — so the chip names the TOOL and the thing, and
                  clicking goes there. */}
              {item.links.length > 0 && (
                <span className="todo-links">
                  {item.links.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="todo-link"
                      title={`${NAV_ITEM_BY_ID.get(link.tool)?.label ?? "Link"}: ${link.label}`}
                    >
                      <span className="todo-link-icon" aria-hidden="true">
                        {NAV_ITEM_BY_ID.get(link.tool)?.icon ?? "↗"}
                      </span>
                      {link.label}
                    </Link>
                  ))}
                </span>
              )}

              {item.due && (
                <span className={`todo-due${state ? ` ${state}` : ""}`}>
                  {DUE_LABEL[state ?? ""] ?? item.due}
                </span>
              )}

              <button
                type="button"
                className="todo-del"
                title="Delete"
                aria-label="Delete item"
                onClick={() =>
                  run(() => deleteTodo({ todoId: item._id as Id<"todos"> }))
                }
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      {sorted.length === 0 && (
        <p className="centered-note">Nothing here yet.</p>
      )}
    </div>
  );
}
