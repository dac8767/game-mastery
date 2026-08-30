"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  QuickAddField,
  TodoList,
  todoHref,
  useRunner,
  useTodoBoard,
} from "@/components/TodoTool";
import {
  MAX_TITLE,
  TODO_COLOR_IDS,
  colorOf,
  dueState,
  reorderTo,
  sortTodos,
  todayISO,
} from "@/components/todoModel";

/**
 * Projects — Vikunja's lists, as one screen instead of a sidebar tree.
 *
 * Vikunja nests projects in its own navigation pane, arbitrarily deep.
 * Two things are different here. The pane is gone, because this app has
 * one already and two navigation columns is one too many; and the
 * nesting is gone, because a tree is a thing you maintain and a GM
 * wants a list to read.
 *
 * What a project is NOT is a folder you are afraid of: deleting one
 * moves its tasks to the Inbox rather than deleting them, which is what
 * makes reorganising this safe to do at eleven at night.
 */

export function TodoProjects({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const board = useTodoBoard(campaignId);
  const addProject = useMutation(api.todo.addProject);
  const updateProject = useMutation(api.todo.updateProject);
  const deleteProject = useMutation(api.todo.deleteProject);
  const reorderProjects = useMutation(api.todo.reorderProjects);
  const { error, run } = useRunner();

  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const today = useMemo(() => todayISO(), []);

  /** Open, overdue and total, per project — plus the Inbox's. */
  const counts = useMemo(() => {
    const map = new Map<string, { open: number; overdue: number }>();
    for (const item of board?.items ?? []) {
      if (item.done) continue;
      const key = item.projectId ? String(item.projectId) : "";
      const at = map.get(key) ?? { open: 0, overdue: 0 };
      at.open++;
      if (dueState(item.due, today) === "overdue") at.overdue++;
      map.set(key, at);
    }
    return map;
  }, [board, today]);

  if (board === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  const ordered = [...board.projects].sort((a, b) => a.order - b.order);
  const live = ordered.filter((p) => !p.archived);
  const archived = ordered.filter((p) => p.archived);
  const inbox = counts.get("") ?? { open: 0, overdue: 0 };

  /** Drop `dragging` where `overId` sits, among the live projects. */
  function drop(overId: string) {
    if (!dragging || dragging === overId) return;
    const to = live.findIndex((p) => String(p._id) === overId);
    setDragging(null);
    if (to === -1) return;
    const moves = reorderTo(
      live.map((p) => ({ _id: String(p._id), order: p.order })),
      dragging,
      to
    );
    if (moves.length === 0) return;
    run(() =>
      reorderProjects({
        campaignId,
        moves: moves.map((m) => ({
          projectId: m._id as Id<"todoProjects">,
          order: m.order,
        })),
      })
    );
  }

  return (
    <div className="todo">
      <form
        className="todo-add"
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (!title) return;
          setDraft("");
          run(() => addProject({ campaignId, title }));
        }}
      >
        <input
          className="todo-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="A new project — Session prep, Worldbuilding…"
          maxLength={MAX_TITLE}
          aria-label="New project"
        />
        <button type="submit" className="npc-btn primary" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      {error && <p className="form-error nb-error">{error}</p>}

      <ul className="proj-list">
        {/* The Inbox is first and is not a row you can edit. Vikunja
            makes it a real project you are not allowed to delete; here
            it is simply the tasks with no projectId, which cannot get
            out of step with itself the way a magic row can. */}
        <li className="proj-row inbox">
          <span className="proj-swatch" style={{ background: colorOf(null) }} />
          <Link href={todoHref(campaignId)} className="proj-name">
            Inbox
          </Link>
          <ProjCounts counts={inbox} />
          <span className="settings-note">everything unfiled</span>
        </li>

        {live.map((p) => (
          <li
            key={String(p._id)}
            className={`proj-row${dragging === String(p._id) ? " dragging" : ""}`}
            draggable
            onDragStart={() => setDragging(String(p._id))}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => dragging && e.preventDefault()}
            onDrop={() => drop(String(p._id))}
          >
            <ColorPicker
              value={p.color}
              onPick={(color) =>
                run(() => updateProject({ projectId: p._id, color }))
              }
            />
            <input
              className="proj-name-edit"
              defaultValue={p.title}
              maxLength={MAX_TITLE}
              aria-label="Project name"
              onBlur={(e) => {
                const title = e.target.value.trim();
                if (title && title !== p.title) {
                  run(() => updateProject({ projectId: p._id, title }));
                } else {
                  e.target.value = p.title;
                }
              }}
            />
            <ProjCounts counts={counts.get(String(p._id)) ?? { open: 0, overdue: 0 }} />
            <Link
              href={todoHref(campaignId, `project/${p._id}`)}
              className="text-button"
            >
              Open
            </Link>
            <button
              type="button"
              className="text-button"
              title="Keep it, out of the way"
              onClick={() =>
                run(() => updateProject({ projectId: p._id, archived: true }))
              }
            >
              Archive
            </button>
            <DeleteProject
              title={p.title}
              onDelete={() => run(() => deleteProject({ projectId: p._id }))}
            />
          </li>
        ))}
      </ul>

      {live.length === 0 && (
        <p className="centered-note">
          No projects yet. Everything lives in the Inbox until there is a
          reason to split it up.
        </p>
      )}

      {archived.length > 0 && (
        <div className="proj-archived">
          <button
            type="button"
            className="text-button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? "▾" : "▸"} Archived ({archived.length})
          </button>
          {showArchived && (
            <ul className="proj-list">
              {archived.map((p) => (
                <li key={String(p._id)} className="proj-row archived">
                  <span
                    className="proj-swatch"
                    style={{ background: colorOf(p.color) }}
                  />
                  <span className="proj-name">{p.title}</span>
                  <ProjCounts
                    counts={counts.get(String(p._id)) ?? { open: 0, overdue: 0 }}
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      run(() =>
                        updateProject({ projectId: p._id, archived: false })
                      )
                    }
                  >
                    Bring back
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ProjCounts({ counts }: { counts: { open: number; overdue: number } }) {
  return (
    <span className="proj-counts">
      <span className="proj-open">{counts.open} open</span>
      {counts.overdue > 0 && (
        <span className="proj-overdue">{counts.overdue} overdue</span>
      )}
    </span>
  );
}

/**
 * The palette, as eight buttons rather than a colour input.
 *
 * What is stored is a palette ID, never a colour — see TODO_COLORS in
 * todoModel. A native colour input would produce a hex string, which is
 * the one thing that must not end up in this field: the value goes into
 * a `style`, so it has to be something the client looks up.
 */
function ColorPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="proj-color">
      <button
        type="button"
        className="proj-swatch as-button"
        style={{ background: colorOf(value) }}
        title="Colour"
        aria-label="Colour"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <span className="proj-palette">
          {TODO_COLOR_IDS.map((id) => (
            <button
              type="button"
              key={id}
              className={`proj-swatch as-button${id === value ? " on" : ""}`}
              style={{ background: colorOf(id) }}
              title={id}
              aria-label={id}
              onClick={() => {
                onPick(id);
                setOpen(false);
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * Delete, in two clicks.
 *
 * The tasks survive — they go to the Inbox — so this is not the
 * dangerous button it looks like. It is still two clicks, because
 * "which of the eight rows was I aiming at" is a question you ask
 * afterwards.
 */
function DeleteProject({
  title,
  onDelete,
}: {
  title: string;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={`text-button proj-del${armed ? " armed" : ""}`}
      title={
        armed
          ? `Delete ${title}. Its tasks move to the Inbox.`
          : `Delete ${title}`
      }
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onDelete();
      }}
    >
      {armed ? "Sure?" : "Delete"}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* One project                                                        */
/* ---------------------------------------------------------------- */

/**
 * A single project's list — Vikunja's List view, scoped.
 *
 * The same rows and the same quick-add as the Overview, with the
 * project already chosen: anything typed here lands in this project
 * without the `+name`, which is the point of being on its screen.
 */
export function TodoProjectView({
  campaignId,
  projectId,
}: {
  campaignId: Id<"campaigns">;
  projectId: Id<"todoProjects">;
}) {
  const board = useTodoBoard(campaignId);

  const items = useMemo(() => {
    if (!board) return [];
    return sortTodos(
      board.items.filter((i) => String(i.projectId) === String(projectId))
    );
  }, [board, projectId]);

  if (board === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  const project = board.projects.find((p) => String(p._id) === String(projectId));
  if (!project) {
    return (
      <p className="centered-note">
        That project is gone. Its tasks are in the{" "}
        <Link href={todoHref(campaignId)}>Inbox</Link>.
      </p>
    );
  }

  return (
    <div className="todo">
      <h2 className="proj-title">
        <span
          className="proj-swatch"
          style={{ background: colorOf(project.color) }}
        />
        {project.title}
        {project.archived && <span className="badge">Archived</span>}
      </h2>

      <QuickAddField
        campaignId={campaignId}
        projectId={projectId}
        projects={board.projects}
        placeholder={`Task for ${project.title}, then tomorrow *label !3`}
      />

      <TodoList
        campaignId={campaignId}
        board={board}
        items={items}
        emptyNote="Nothing in this project yet."
      />
    </div>
  );
}
