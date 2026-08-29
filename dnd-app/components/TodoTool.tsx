"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import {
  MAX_TEXT,
  PRIORITY_LABELS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  colorOf,
  dueState,
  reorderTo,
  showsPriority,
  sortTodos,
  todayISO,
} from "@/components/todoModel";
import { parseQuickAdd } from "@/components/quickAdd";
import { NAV_ITEM_BY_ID } from "@/components/navItems";

/**
 * The DM's prep list, built after Vikunja.
 *
 * What was here before was one flat checklist, and it was good at the
 * twenty seconds between remembering something and forgetting it again.
 * That is still the thing this has to be good at, which is why Quick
 * Add Magic is the centre of it rather than a form: you type the task
 * and its date and its label in one breath, and setting a due date
 * never becomes a second action you decide to skip.
 *
 * What Vikunja adds on top, and what is here now: projects (which list
 * is this in), labels (what kind of thing is it), priority, and
 * favourites. What is deliberately NOT here:
 *
 *   its navigation pane   Vikunja puts Overview / Upcoming / Projects /
 *                         Labels down the left of its own screen. In
 *                         this app that would be a second navigation
 *                         column beside the one that is already there,
 *                         each unaware of the other. Those four live
 *                         under the To-Do caret in the app's sidebar
 *                         instead — see TODO_CHILDREN in navItems.ts.
 *   nested projects       Vikunja nests them arbitrarily deep. That
 *                         earns its keep for a team tracking a product
 *                         and costs a DM a tree to maintain instead of
 *                         a list to read.
 *   Gantt and Kanban      two of Vikunja's four views. A prep list is
 *                         not a schedule and not a pipeline; List and
 *                         the date-grouped Upcoming are the two a
 *                         checklist actually reads in.
 *   assignees, teams      this list has one reader.
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

/**
 * A link inside the To-Do tool, from the campaign root.
 *
 * Absolute rather than relative, because the same components render on
 * four screens at three different depths — the Overview at /todo, the
 * sub-screens one below, a project two below. A relative href resolves
 * against wherever it happens to be rendered, so it is correct on the
 * screen it was written for and quietly wrong on the other three.
 */
export function todoHref(campaignId: Id<"campaigns">, to = ""): string {
  return `/campaign/${campaignId}/todo${to ? `/${to}` : ""}`;
}

/** Everything the tool draws, from the one subscription. */
export type Board = NonNullable<
  ReturnType<typeof useQuery<typeof api.todo.listTodos>>
>;
export type TodoItem = Board["items"][number];
export type TodoProject = Board["projects"][number];
export type TodoLabel = Board["labels"][number];

/**
 * One subscription per screen, as the app's convention has it.
 *
 * Tasks, projects and labels arrive together because every screen here
 * needs all three at once — see listTodos, which explains why they are
 * one query rather than three.
 */
export function useTodoBoard(campaignId: Id<"campaigns">) {
  return useQuery(api.todo.listTodos, { campaignId });
}

/** An error box that clears itself when the next thing works. */
export function useRunner() {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "That didn't work.")
    );
  };
  return { error, run, setError };
}

/* ---------------------------------------------------------------- */
/* Quick Add                                                          */
/* ---------------------------------------------------------------- */

/**
 * The field, and a preview of what it understood.
 *
 * The preview is not a nicety. Quick Add Magic eats words out of the
 * middle of a sentence — "buy the tomorrow paper" loses one to a date —
 * and the only honest answer to a syntax that does that is to show the
 * reading before it is committed. Vikunja does the same thing for the
 * same reason.
 */
export function QuickAddField({
  campaignId,
  projectId,
  projects,
  placeholder,
}: {
  campaignId: Id<"campaigns">;
  /** The project screen this was typed on, if any. */
  projectId?: Id<"todoProjects">;
  projects: readonly TodoProject[];
  placeholder?: string;
}) {
  const quickAdd = useMutation(api.todo.quickAdd);
  const { error, run } = useRunner();
  const [draft, setDraft] = useState("");

  // Read once per render, not per keystroke: a field left open across
  // midnight would otherwise resolve "tomorrow" against yesterday.
  const today = useMemo(() => todayISO(), []);
  const parsed = useMemo(
    () => (draft.trim() ? parseQuickAdd(draft, today) : null),
    [draft, today]
  );
  const unmatchedProject =
    parsed?.project &&
    !projects.some(
      (p) => p.title.toLowerCase() === parsed.project?.toLowerCase()
    );

  return (
    <div className="todo-add-wrap">
      <form
        className="todo-add"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          // Cleared immediately rather than on success: the point of
          // this field is the next thought, and waiting on a round trip
          // to type it is how the second thing gets forgotten.
          setDraft("");
          run(() => quickAdd({ campaignId, text, today, projectId }));
        }}
      >
        <input
          className="todo-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            placeholder ?? "Task, then tomorrow *label !3 +'Project'"
          }
          maxLength={MAX_TEXT}
          aria-label="New item"
        />
        <button
          type="submit"
          className="npc-btn primary"
          disabled={!draft.trim()}
        >
          Add
        </button>
      </form>

      {parsed && parsed.matched.length > 0 && (
        <p className="todo-parse" aria-live="polite">
          <span className="todo-parse-text">{parsed.text || "…"}</span>
          {parsed.due && <span className="todo-chip due">{parsed.due}</span>}
          {parsed.priority && (
            <span className="todo-chip pri">
              {PRIORITY_LABELS[parsed.priority]}
            </span>
          )}
          {parsed.labels.map((l) => (
            <span className="todo-chip" key={l}>
              {l}
            </span>
          ))}
          {parsed.project && (
            <span className={`todo-chip proj${unmatchedProject ? " miss" : ""}`}>
              {unmatchedProject
                ? `no project “${parsed.project}”`
                : parsed.project}
            </span>
          )}
        </p>
      )}

      {error && <p className="form-error nb-error">{error}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* The list                                                           */
/* ---------------------------------------------------------------- */

/**
 * The list, with everything a row can do.
 *
 * `reorderable` is off wherever the order on screen is not the stored
 * one — Upcoming sorts by date, so dragging there would be a move whose
 * result you never see, which reads as a broken drag rather than as a
 * feature that is not offered.
 */
export function TodoList({
  campaignId,
  board,
  items,
  reorderable = true,
  emptyNote = "Nothing here yet.",
}: {
  campaignId: Id<"campaigns">;
  board: Board;
  items: readonly TodoItem[];
  reorderable?: boolean;
  emptyNote?: string;
}) {
  const setDone = useMutation(api.todo.setDone);
  const updateTodo = useMutation(api.todo.updateTodo);
  const setFavorite = useMutation(api.todo.setFavorite);
  const reorderTodos = useMutation(api.todo.reorderTodos);
  const deleteTodo = useMutation(api.todo.deleteTodo);
  const { error, run } = useRunner();

  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const today = useMemo(() => todayISO(), []);
  const projectById = useMemo(
    () => new Map(board.projects.map((p) => [String(p._id), p])),
    [board.projects]
  );
  const labelById = useMemo(
    () => new Map(board.labels.map((l) => [String(l._id), l])),
    [board.labels]
  );

  /** Drop `dragging` where `overId` currently sits. */
  function drop(overId: string) {
    if (!dragging || dragging === overId) return;
    const open = items.filter((i) => !i.done);
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

  if (items.length === 0) {
    return <p className="centered-note">{emptyNote}</p>;
  }

  return (
    <>
      {error && <p className="form-error nb-error">{error}</p>}
      <ul className="todo-list">
        {items.map((item) => {
          const state = dueState(item.due, today);
          const project = item.projectId
            ? projectById.get(String(item.projectId))
            : null;
          return (
            <li
              key={item._id}
              className={`todo-item${item.done ? " done" : ""}${
                dragging === item._id ? " dragging" : ""
              }${state ? ` due-${state}` : ""}`}
              // Only open items reorder, and only where the order on
              // screen is the stored one.
              draggable={reorderable && !item.done}
              onDragStart={() => reorderable && setDragging(item._id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                if (reorderable && dragging && !item.done) e.preventDefault();
              }}
              onDrop={() => reorderable && drop(item._id)}
            >
              <div className="todo-row">
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

                {/* Only High and above. Vikunja's rule, and the reason a
                    five-point scale is usable: a list where every row
                    wears a badge has told you nothing. */}
                {showsPriority(item.priority) && (
                  <span className={`todo-pri p${item.priority}`}>
                    {PRIORITY_LABELS[item.priority as number]}
                  </span>
                )}

                {item.labelIds.map((id) => {
                  const label = labelById.get(String(id));
                  if (!label) return null;
                  return (
                    <span
                      className="todo-label"
                      key={String(id)}
                      style={{ backgroundColor: colorOf(label.color) }}
                    >
                      {label.title}
                    </span>
                  );
                })}

                {project && (
                  <Link
                    /* Absolute, not "./project/…". This same list is
                       rendered on four screens at three different
                       depths, and a relative href resolves against
                       whichever one you are standing on — the chip
                       would work on the Overview and land on
                       /todo/upcoming/project/… from Upcoming. */
                    href={todoHref(campaignId, `project/${project._id}`)}
                    className="todo-proj"
                    style={{ borderColor: colorOf(project.color) }}
                  >
                    {project.title}
                  </Link>
                )}

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
                  className={`todo-star${item.favorite ? " on" : ""}`}
                  title={item.favorite ? "Unstar" : "Star"}
                  aria-label={item.favorite ? "Unstar" : "Star"}
                  aria-pressed={item.favorite}
                  onClick={() =>
                    run(() =>
                      setFavorite({
                        todoId: item._id as Id<"todos">,
                        favorite: !item.favorite,
                      })
                    )
                  }
                >
                  {item.favorite ? "★" : "☆"}
                </button>

                <button
                  type="button"
                  className={`todo-more${open === item._id ? " on" : ""}`}
                  title="Details"
                  aria-label="Details"
                  aria-expanded={open === item._id}
                  onClick={() =>
                    setOpen(open === item._id ? null : item._id)
                  }
                >
                  ⋯
                </button>

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
              </div>

              {open === item._id && (
                <TodoDetail
                  item={item}
                  board={board}
                  onChange={(patch) =>
                    run(() =>
                      updateTodo({ todoId: item._id as Id<"todos">, ...patch })
                    )
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * The properties, on the row that has them.
 *
 * Quick Add sets all of this on the way in; this is the way to change
 * it afterwards without retyping the line. Folded away by default,
 * because a prep list with five dropdowns on every row is a form.
 */
function TodoDetail({
  item,
  board,
  onChange,
}: {
  item: TodoItem;
  board: Board;
  onChange: (patch: {
    due?: string;
    notes?: string;
    projectId?: Id<"todoProjects"> | null;
    priority?: number | null;
    labelIds?: Id<"todoLabels">[];
  }) => void;
}) {
  const chosen = new Set(item.labelIds.map(String));

  return (
    <div className="todo-detail">
      <label className="todo-field">
        <span>Project</span>
        <select
          value={item.projectId ? String(item.projectId) : ""}
          onChange={(e) =>
            onChange({
              projectId: e.target.value
                ? (e.target.value as Id<"todoProjects">)
                : null,
            })
          }
        >
          {/* Unfiled is a real option, not a missing one. */}
          <option value="">Inbox</option>
          {board.projects
            .filter((p) => !p.archived || String(p._id) === String(item.projectId))
            .map((p) => (
              <option key={String(p._id)} value={String(p._id)}>
                {p.title}
              </option>
            ))}
        </select>
      </label>

      <label className="todo-field">
        <span>Priority</span>
        <select
          value={item.priority ?? ""}
          onChange={(e) =>
            onChange({
              priority: e.target.value ? Number(e.target.value) : null,
            })
          }
        >
          <option value="">Unset</option>
          {Array.from(
            { length: PRIORITY_MAX - PRIORITY_MIN + 1 },
            (_, i) => i + PRIORITY_MIN
          ).map((n) => (
            <option key={n} value={n}>
              {PRIORITY_LABELS[n]}
            </option>
          ))}
        </select>
      </label>

      <label className="todo-field">
        <span>Due</span>
        <input
          type="date"
          value={item.due ?? ""}
          onChange={(e) => onChange({ due: e.target.value })}
        />
      </label>

      <div className="todo-field wide">
        <span>Labels</span>
        <div className="todo-label-picker">
          {board.labels.length === 0 ? (
            <span className="settings-note">
              None yet — type *name when you add something, or make them
              on the Labels screen.
            </span>
          ) : (
            board.labels.map((l) => {
              const on = chosen.has(String(l._id));
              return (
                <button
                  type="button"
                  key={String(l._id)}
                  className={`todo-label pick${on ? " on" : ""}`}
                  aria-pressed={on}
                  style={{
                    backgroundColor: on ? colorOf(l.color) : "transparent",
                    borderColor: colorOf(l.color),
                  }}
                  onClick={() =>
                    onChange({
                      labelIds: (on
                        ? item.labelIds.filter(
                            (id) => String(id) !== String(l._id)
                          )
                        : [...item.labelIds, l._id]) as Id<"todoLabels">[],
                    })
                  }
                >
                  {l.title}
                </button>
              );
            })
          )}
        </div>
      </div>

      <label className="todo-field wide">
        <span>Notes</span>
        <textarea
          className="todo-note-edit"
          defaultValue={item.notes ?? ""}
          rows={2}
          placeholder="Anything that does not fit on one line"
          onBlur={(e) => {
            if (e.target.value !== (item.notes ?? "")) {
              onChange({ notes: e.target.value });
            }
          }}
        />
      </label>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Overview — the working list                                        */
/* ---------------------------------------------------------------- */

type Filter = "all" | "starred" | "overdue";

export function TodoTool({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const board = useTodoBoard(campaignId);
  const clearDone = useMutation(api.todo.clearDone);
  const { error, run } = useRunner();
  const [filter, setFilter] = useState<Filter>("all");

  const today = useMemo(() => todayISO(), []);

  const sorted = useMemo(
    () => (board ? sortTodos(board.items) : []),
    [board]
  );
  const shown = useMemo(() => {
    if (filter === "starred") return sorted.filter((i) => i.favorite);
    if (filter === "overdue") {
      return sorted.filter((i) => !i.done && dueState(i.due, today) === "overdue");
    }
    return sorted;
  }, [sorted, filter, today]);

  if (board === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  const openCount = sorted.filter((i) => !i.done).length;
  const doneCount = sorted.length - openCount;
  const starred = sorted.filter((i) => i.favorite).length;
  const overdue = sorted.filter(
    (i) => !i.done && dueState(i.due, today) === "overdue"
  ).length;

  return (
    <div className="todo">
      <QuickAddField campaignId={campaignId} projects={board.projects} />

      {error && <p className="form-error nb-error">{error}</p>}

      {/* The count row is hidden on an empty list. It used to say
          "Nothing outstanding." directly above "Nothing here yet.",
          which is one fact told twice in two voices. */}
      {sorted.length > 0 && (
        <div className="todo-count">
          <span className="todo-filters" role="group" aria-label="Show">
            <FilterChip on={filter} set={setFilter} value="all" label={`All ${openCount}`} />
            {starred > 0 && (
              <FilterChip on={filter} set={setFilter} value="starred" label={`★ ${starred}`} />
            )}
            {overdue > 0 && (
              <FilterChip
                on={filter}
                set={setFilter}
                value="overdue"
                label={`Overdue ${overdue}`}
              />
            )}
          </span>
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

      <TodoList
        campaignId={campaignId}
        board={board}
        items={shown}
        /* Dragging only means anything on the unfiltered list: on a
           filtered one the neighbours you drop between are not the
           neighbours the order is made of. */
        reorderable={filter === "all"}
        emptyNote={
          filter === "all"
            ? "Nothing here yet."
            : "Nothing matches that filter."
        }
      />
    </div>
  );
}

function FilterChip({
  on,
  set,
  value,
  label,
}: {
  on: Filter;
  set: (f: Filter) => void;
  value: Filter;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`todo-filter${on === value ? " on" : ""}`}
      aria-pressed={on === value}
      onClick={() => set(value)}
    >
      {label}
    </button>
  );
}
