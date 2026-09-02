"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useUndoableMutation } from "@/components/useUndoable";
import { useRunner, useTodoBoard } from "@/components/TodoTool";
import {
  MAX_TITLE,
  TODO_COLOR_IDS,
  colorOf,
} from "@/components/todoModel";

/**
 * Labels — the cross-cutting half of Vikunja's filing.
 *
 * A project is WHICH LIST a task is in and it has exactly one; a label
 * is WHAT KIND of thing it is and it can have several. "Session prep"
 * is a project; "buy", "print", "statblock" are labels, and they turn
 * up in every project.
 *
 * This screen exists mostly to rename and recolour. Making them happens
 * where you are already typing — `*handout` in the quick-add field
 * creates the label if the campaign has not got one, because a syntax
 * that only attaches labels you made in another screen first is a
 * syntax nobody reaches for.
 */

export function TodoLabels({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const board = useTodoBoard(campaignId);
  const addLabel = useMutation(api.todo.addLabel);
  const updateLabel = useUndoableMutation(api.todo.updateLabel);
  const deleteLabel = useMutation(api.todo.deleteLabel);
  const { error, run } = useRunner();

  const [draft, setDraft] = useState("");

  /** How many open tasks wear each label. */
  const uses = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of board?.items ?? []) {
      for (const id of item.labelIds) {
        map.set(String(id), (map.get(String(id)) ?? 0) + 1);
      }
    }
    return map;
  }, [board]);

  if (board === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  const sorted = [...board.labels].sort((a, b) =>
    a.title.localeCompare(b.title)
  );

  return (
    <div className="todo">
      <form
        className="todo-add"
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (!title) return;
          setDraft("");
          run(() => addLabel({ campaignId, title }));
        }}
      >
        <input
          className="todo-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="A new label — combat, handout, buy…"
          maxLength={MAX_TITLE}
          aria-label="New label"
        />
        <button type="submit" className="npc-btn primary" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      <p className="settings-note">
        You rarely need this screen: typing <code>*handout</code> in the
        add field makes the label as it files the task. This is where you
        rename and recolour them.
      </p>

      {error && <p className="form-error nb-error">{error}</p>}

      {sorted.length === 0 ? (
        <p className="centered-note">No labels yet.</p>
      ) : (
        <ul className="label-list">
          {sorted.map((l) => {
            const used = uses.get(String(l._id)) ?? 0;
            return (
              <li key={String(l._id)} className="label-row">
                <span
                  className="todo-label"
                  style={{ backgroundColor: colorOf(l.color) }}
                >
                  {l.title}
                </span>
                <input
                  className="proj-name-edit"
                  /* Keyed on the title so a name put back by Cmd+Z
                     redraws an uncontrolled input. */
                  key={l.title}
                  defaultValue={l.title}
                  maxLength={MAX_TITLE}
                  aria-label="Label name"
                  onBlur={(e) => {
                    const title = e.target.value.trim();
                    if (title && title !== l.title) {
                      run(() =>
                        updateLabel(
                          { labelId: l._id, title },
                          { labelId: l._id, title: l.title },
                          "Label name"
                        )
                      );
                    } else {
                      e.target.value = l.title;
                    }
                  }}
                />
                <span className="label-swatches">
                  {TODO_COLOR_IDS.map((id) => (
                    <button
                      type="button"
                      key={id}
                      className={`proj-swatch as-button${
                        id === l.color ? " on" : ""
                      }`}
                      style={{ background: colorOf(id) }}
                      title={id}
                      aria-label={`${l.title}: ${id}`}
                      onClick={() => {
                        // A palette id both ways, never a colour string.
                        const was = l.color;
                        run(() =>
                          updateLabel(
                            { labelId: l._id, color: id },
                            { labelId: l._id, color: was },
                            `Colour of ${l.title}`
                          )
                        );
                      }}
                    />
                  ))}
                </span>
                <span className="proj-counts">
                  <span className="proj-open">
                    {used} {used === 1 ? "task" : "tasks"}
                  </span>
                </span>
                <DeleteLabel
                  title={l.title}
                  used={used}
                  onDelete={() => run(() => deleteLabel({ labelId: l._id }))}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Delete, in two clicks, and it says what it will cost.
 *
 * Deleting a label takes it off everything wearing it, which is not
 * obvious from a button marked Delete — so the armed state says how
 * many tasks are about to lose it rather than asking "are you sure"
 * about a number you would have to go and count.
 */
function DeleteLabel({
  title,
  used,
  onDelete,
}: {
  title: string;
  used: number;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={`text-button proj-del${armed ? " armed" : ""}`}
      title={`Delete ${title}`}
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
      {armed
        ? used > 0
          ? `Take off ${used}?`
          : "Sure?"
        : "Delete"}
    </button>
  );
}
