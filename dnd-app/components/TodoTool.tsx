"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useUndoableMutation } from "@/components/useUndoable";
import Link from "next/link";
import {
  MAX_TEXT,
  PRIORITY_LABELS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  colorOf,
  dueState,
  relativeDue,
  reorderTo,
  showsPriority,
  sortTodos,
  todayISO,
} from "@/components/todoModel";
import { parseQuickAdd } from "@/components/quickAdd";
import { NAV_ITEM_BY_ID } from "@/components/navItems";

/**
 * The GM's prep list, built after Vikunja.
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
 *                         and costs a GM a tree to maintain instead of
 *                         a list to read.
 *   Gantt and Kanban      two of Vikunja's four views. A prep list is
 *                         not a schedule and not a pipeline; List and
 *                         the date-grouped Upcoming are the two a
 *                         checklist actually reads in.
 *   assignees, teams      this list has one reader.
 *
 * The whole tool is GM-only, and convex/todo.ts refuses a non-GM caller
 * outright rather than returning an empty list. Nothing here re-derives
 * that; a player who reaches this screen sees the error the server
 * gave, which is the honest thing for a screen that is not theirs.
 */

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
  const [helpOpen, setHelpOpen] = useState(false);

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
        {/* Plain words, not the syntax. The syntax used to BE the
            placeholder, which meant the one thing on an empty screen
            was a line of punctuation — it read as something you had to
            learn before you could type anything at all. It is behind
            the ? now, where Vikunja keeps it. */}
        <span className="todo-input-wrap">
          <span className="todo-input-icon" aria-hidden="true">
            ☑
          </span>
          <input
            className="todo-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder ?? "Add a task…"}
            maxLength={MAX_TEXT}
            aria-label="New item"
          />
          <button
            type="button"
            className="todo-help-btn"
            aria-expanded={helpOpen}
            aria-label="What can I type here?"
            title="What can I type here?"
            onClick={() => setHelpOpen(!helpOpen)}
          >
            ?
          </button>
        </span>
        <button
          type="submit"
          className="npc-btn primary todo-add-btn"
          disabled={!draft.trim()}
        >
          + Add
        </button>
      </form>

      {helpOpen && <QuickAddHelp />}

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

/**
 * What the field understands, spelled out.
 *
 * Behind a ? rather than in the placeholder, because a screen whose
 * only content is a syntax reference reads as homework. Anyone can type
 * a sentence into this field and get a task; everything here is a
 * shortcut for people who want one.
 */
function QuickAddHelp() {
  return (
    <div className="todo-help">
      <p className="todo-help-lead">
        Type the task. Anything below can go in the same line, in any
        order, and comes back out as a property.
      </p>
      <dl className="todo-help-grid">
        <dt>
          <code>tomorrow</code>
        </dt>
        <dd>
          a due date, in words — also <code>next friday</code>,{" "}
          <code>in 2 weeks</code>, <code>sep 3</code>,{" "}
          <code>end of month</code>, <code>2026-09-01</code>
        </dd>
        <dt>
          <code>*combat</code>
        </dt>
        <dd>
          a label, made if you have not got one. <code>*&apos;two words&apos;</code>{" "}
          for a name with a space in it
        </dd>
        <dt>
          <code>+&apos;Session prep&apos;</code>
        </dt>
        <dd>the project to file it under, matched against ones you have</dd>
        <dt>
          <code>!4</code>
        </dt>
        <dd>priority, 1 to 5 — only 3 and up show on the row</dd>
      </dl>
      <p className="settings-note">
        Whatever it understood appears under the field before you press
        Add, so nothing is taken out of your sentence without saying so.
      </p>
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
  const setDone = useUndoableMutation(api.todo.setDone);
  const updateTodo = useUndoableMutation(api.todo.updateTodo);
  const setFavorite = useUndoableMutation(api.todo.setFavorite);
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
                      setDone(
                        { todoId: item._id as Id<"todos">, done: e.target.checked },
                        { todoId: item._id as Id<"todos">, done: item.done },
                        `Done: ${item.text}`
                      )
                    )
                  }
                />

                <div className="todo-body">
                  {/* The project, as a quiet prefix rather than a chip
                      at the far end. It is context for the title, so it
                      reads BEFORE it — "Session prep · statblock for
                      the lich" — and at the end of the row it was a
                      label you had to go looking for. */}
                  {project && (
                    <Link
                      /* Absolute, not "./project/…". This list renders
                         on four screens at three different depths, and
                         a relative href resolves against whichever one
                         you are standing on — right from the Overview
                         and a 404 from Upcoming. */
                      href={todoHref(campaignId, `project/${project._id}`)}
                      className="todo-proj"
                      style={{ color: colorOf(project.color) }}
                    >
                      {project.title}
                    </Link>
                  )}

                  {/* Only High and above. Vikunja's rule, and what makes
                      a five-point scale usable: a list where every row
                      wears a badge has told you nothing. Before the
                      title, where it changes how you read it. */}
                  {showsPriority(item.priority) && (
                    <span className={`todo-pri p${item.priority}`}>
                      <span className="todo-pri-mark" aria-hidden="true">!</span>
                      {PRIORITY_LABELS[item.priority as number]}
                    </span>
                  )}

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
                            updateTodo(
                              { todoId: item._id as Id<"todos">, text },
                              { todoId: item._id as Id<"todos">, text: item.text },
                              "Text of a to-do"
                            )
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

                </div>

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
                  <span
                    className={`todo-due${state === "overdue" ? " overdue" : ""}`}
                    title={item.due}
                  >
                    {relativeDue(item.due, today)}
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
                      setFavorite(
                        { todoId: item._id as Id<"todos">, favorite: !item.favorite },
                        { todoId: item._id as Id<"todos">, favorite: item.favorite },
                        `Star: ${item.text}`
                      )
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

              {item.notes && <p className="todo-notes">{item.notes}</p>}

              {open === item._id && (
                <TodoDetail
                  item={item}
                  board={board}
                  onChange={(patch) =>
                    run(() =>
                      updateTodo(
                        { todoId: item._id as Id<"todos">, ...patch },
                        { todoId: item._id as Id<"todos">, ...todoBefore(item, patch) },
                        todoPatchLabel(patch)
                      )
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

type TodoPatch = {
  due?: string;
  notes?: string;
  projectId?: Id<"todoProjects"> | null;
  priority?: number | null;
  labelIds?: Id<"todoLabels">[];
};

/**
 * The same keys a patch changes, carrying what the row has now — the
 * way back for Cmd+Z. Absent values go as the same "clear" each field
 * sends from its own control: "" for the dates and notes, null for the
 * project and priority, so undoing a set clears and undoing a clear
 * sets.
 */
function todoBefore(item: TodoItem, patch: TodoPatch): TodoPatch {
  const before: TodoPatch = {};
  if (patch.due !== undefined) before.due = item.due ?? "";
  if (patch.notes !== undefined) before.notes = item.notes ?? "";
  if (patch.projectId !== undefined) before.projectId = item.projectId ?? null;
  if (patch.priority !== undefined) before.priority = item.priority ?? null;
  if (patch.labelIds !== undefined) before.labelIds = item.labelIds;
  return before;
}

function todoPatchLabel(patch: TodoPatch): string {
  if (patch.due !== undefined) return "Due date of a to-do";
  if (patch.notes !== undefined) return "Notes of a to-do";
  if (patch.projectId !== undefined) return "Project of a to-do";
  if (patch.priority !== undefined) return "Priority of a to-do";
  if (patch.labelIds !== undefined) return "Labels of a to-do";
  return "A to-do";
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
          key={item.notes ?? ""}
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
  const me = useQuery(api.settings.me);
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

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of board?.items ?? []) {
      if (item.done) continue;
      const key = item.projectId ? String(item.projectId) : "";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [board]);

  if (board === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  const openCount = sorted.filter((i) => !i.done).length;
  const doneCount = sorted.length - openCount;
  const starred = sorted.filter((i) => i.favorite).length;
  const overdue = sorted.filter(
    (i) => !i.done && dueState(i.due, today) === "overdue"
  ).length;

  /* Vikunja's greeting, which is the one piece of its Overview that is
     pure warmth: the screen opens by naming the person rather than by
     naming itself. The name comes from the profile; without one it is
     the line on its own, which still reads. */
  const greeting = me?.name ? `Let's focus, ${me.name}` : "Let's focus";

  const live = [...board.projects]
    .filter((p) => !p.archived)
    .sort((a, b) => a.order - b.order)
    .slice(0, PROJECT_CARDS);

  return (
    <div className="todo">
      <h1 className="todo-greeting">{greeting}</h1>

      <QuickAddField campaignId={campaignId} projects={board.projects} />

      {error && <p className="form-error nb-error">{error}</p>}

      {/* The projects, as somewhere to go rather than a list to read.
          Vikunja calls this row "Last viewed" and fills it from a views
          table; this app has not got one, and the projects themselves
          are the same jump with nothing extra to store. */}
      <section className="todo-section">
        <h2 className="todo-section-head">Projects</h2>
        <div className="proj-cards">
          <Link href={todoHref(campaignId, "projects")} className="proj-card inbox">
            <span className="proj-card-name">Inbox</span>
            <span className="proj-card-count">
              {counts.get("") ?? 0} open
            </span>
          </Link>
          {live.map((p) => (
            <Link
              key={String(p._id)}
              href={todoHref(campaignId, `project/${p._id}`)}
              className="proj-card"
              style={{ borderTopColor: colorOf(p.color) }}
            >
              <span className="proj-card-name">{p.title}</span>
              <span className="proj-card-count">
                {counts.get(String(p._id)) ?? 0} open
              </span>
            </Link>
          ))}
          <Link href={todoHref(campaignId, "projects")} className="proj-card new">
            <span className="proj-card-name">
              {live.length === 0 ? "Make a project" : "All projects"}
            </span>
            <span className="proj-card-count">
              {live.length === 0 ? "when one list is not enough" : "manage them"}
            </span>
          </Link>
        </div>
      </section>

      <section className="todo-section">
        <div className="todo-section-bar">
          <h2 className="todo-section-head">Current Tasks</h2>
          {sorted.length > 0 && (
            <span className="todo-count">
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
            </span>
          )}
        </div>

        {/* One panel around the whole list, as Vikunja has it. Rows
            inside a single surface read as a list; rows that are each
            their own card read as a stack of unrelated things. */}
        <div className="todo-panel">
          {sorted.length === 0 ? (
            <EmptyList campaignId={campaignId} />
          ) : (
            <TodoList
              campaignId={campaignId}
              board={board}
              items={shown}
              /* Dragging only means anything on the unfiltered list: on
                 a filtered one the neighbours you drop between are not
                 the neighbours the order is made of. */
              reorderable={filter === "all"}
              emptyNote="Nothing matches that filter."
            />
          )}
        </div>
      </section>
    </div>
  );
}

/** How many project cards the Overview shows before "All projects". */
const PROJECT_CARDS = 5;

/**
 * The empty list, which is the screen most people see first.
 *
 * "Nothing here yet." on its own was the whole of it, and a to-do tool
 * whose first screen is one sentence and a text box does not tell you
 * what it is for. These are real GM prep tasks, and clicking one adds
 * it — which teaches the syntax by showing what it produces rather
 * than by explaining it.
 */
function EmptyList({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const quickAdd = useMutation(api.todo.quickAdd);
  const { error, run } = useRunner();
  const today = useMemo(() => todayISO(), []);

  return (
    <div className="todo-empty">
      <p className="todo-empty-lead">Nothing on the list.</p>
      <p className="settings-note">
        Type above, or start with one of these:
      </p>
      <div className="todo-seeds">
        {STARTERS.map((text) => (
          <button
            type="button"
            key={text}
            className="todo-seed"
            onClick={() => run(() => quickAdd({ campaignId, text, today }))}
          >
            <span className="todo-seed-plus" aria-hidden="true">
              +
            </span>
            {text}
          </button>
        ))}
      </div>
      {error && <p className="form-error nb-error">{error}</p>}
    </div>
  );
}

/**
 * The starter tasks. Written in the syntax on purpose.
 *
 * Each one adds a real task AND demonstrates one piece of the field —
 * a label, a date, a priority — so the first list somebody has is
 * already labelled and dated rather than four bare lines.
 */
const STARTERS = [
  "Statblock for the next boss *combat !4",
  "Print the handouts *handout next friday",
  "Write up last session's recap tomorrow",
  "Order minis for the new character *buy",
];

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
