"use client";

import { useMemo, useState } from "react";
import { Id } from "@/convex/_generated/dataModel";
import {
  TodoItem,
  TodoList,
  useTodoBoard,
} from "@/components/TodoTool";
import { addDays, todayISO } from "@/components/todoModel";

/**
 * Upcoming — everything with a day on it, grouped by the day.
 *
 * Vikunja's second screen, and the one that answers a different
 * question from the Overview. The Overview is the working list, in the
 * order you dragged it into; this is the calendar view of the same
 * tasks: what is late, what is today, and what is between here and the
 * session after next.
 *
 * Anything with no due date is absent on purpose. A screen called
 * Upcoming that also shows the undated is just the other screen again,
 * and the whole reason to have two is that they leave different things
 * out.
 */

/** How far ahead the ranges look. Vikunja's are a week and a month. */
const RANGES = [
  { id: "7", label: "Next 7 days", days: 7 },
  { id: "30", label: "Next 30 days", days: 30 },
  { id: "all", label: "Everything dated", days: 3650 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

/**
 * The day a date belongs under, as a heading.
 *
 * Built from the ISO string rather than a Date where it can be, and
 * where it cannot — the weekday name, which needs a calendar — the Date
 * is constructed in UTC and formatted in UTC. Reading "Tuesday" off a
 * local-time Date is how a heading becomes Monday for anyone west of
 * UTC, which is the same off-by-one dueState exists to avoid.
 */
export function dayHeading(iso: string, today: string): string {
  if (iso === today) return "Today";
  if (iso === addDays(today, 1)) return "Tomorrow";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function TodoUpcoming({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const board = useTodoBoard(campaignId);
  const [range, setRange] = useState<RangeId>("30");

  const today = useMemo(() => todayISO(), []);
  const horizon = useMemo(
    () => addDays(today, RANGES.find((r) => r.id === range)?.days ?? 30),
    [today, range]
  );

  /**
   * Dated, open, and inside the window — then grouped by day.
   *
   * Overdue is its own group above the days rather than a day of its
   * own, because "three weeks late" and "two days late" are the same
   * fact on a prep list and splitting them across three headings buries
   * it. Done items are left out entirely: this screen is what is coming.
   */
  const groups = useMemo(() => {
    if (!board) return [];
    const dated = board.items.filter(
      (i): i is TodoItem & { due: string } =>
        !i.done && typeof i.due === "string" && i.due !== ""
    );
    const late = dated
      .filter((i) => i.due < today)
      .sort((a, b) => a.due.localeCompare(b.due));

    const ahead = dated
      .filter((i) => i.due >= today && i.due <= horizon)
      .sort((a, b) => a.due.localeCompare(b.due));

    const byDay = new Map<string, TodoItem[]>();
    for (const item of ahead) {
      const list = byDay.get(item.due) ?? [];
      list.push(item);
      byDay.set(item.due, list);
    }

    const out: { key: string; heading: string; late?: boolean; items: TodoItem[] }[] =
      [];
    if (late.length > 0) {
      out.push({ key: "overdue", heading: "Overdue", late: true, items: late });
    }
    for (const [day, items] of byDay) {
      out.push({ key: day, heading: dayHeading(day, today), items });
    }
    return out;
  }, [board, today, horizon]);

  if (board === undefined) {
    return <p className="centered-note">Opening the list…</p>;
  }

  const dated = board.items.filter((i) => !i.done && i.due).length;

  return (
    <div className="todo">
      <div className="todo-count">
        <span className="todo-filters" role="group" aria-label="How far ahead">
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`todo-filter${range === r.id ? " on" : ""}`}
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </span>
        <span className="settings-note">
          {dated} dated {dated === 1 ? "task" : "tasks"} open
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="centered-note">
          Nothing dated in that window. Add a date by typing “tomorrow” or
          “next friday” when you write the task.
        </p>
      ) : (
        groups.map((group) => (
          <section className="todo-day" key={group.key}>
            <h2 className={`todo-day-head${group.late ? " late" : ""}`}>
              {group.heading}
              <span className="todo-day-count">{group.items.length}</span>
            </h2>
            <TodoList
              campaignId={campaignId}
              board={board}
              items={group.items}
              /* The order here is the DATE. Dragging would write a sort
                 key you cannot see the effect of, which reads as a
                 broken drag rather than a feature not offered. */
              reorderable={false}
            />
          </section>
        ))
      )}
    </div>
  );
}
