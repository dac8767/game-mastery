"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  ScheduleWindow,
  addIsoDays,
  addIsoMonths,
  applyDrag,
  blocks,
  dayLabel,
  dragRect,
  formatTime,
  isHourStart,
  missing,
  monthTitle,
  reconcileWindow,
  realMonthGrid,
  slotKey,
  slotsOf,
  tally,
  toggleDay,
  isoParts,
  toIso,
  WEEKDAY_NAMES,
  SCHEDULE_LIMITS,
} from "@/components/scheduleModel";

/**
 * Finding a night everyone can play.
 *
 * Two halves, because they answer different questions. The grid is
 * yours: the cells you paint are your own availability and nobody
 * else's. The summary below is the group's: what everyone said, which
 * times survive, and — the half a scheduling tool usually forgets —
 * who has not answered yet.
 *
 * Your marks are drafted locally and saved on release. A mutation per
 * cell would be sixteen writes for one drag across an afternoon, and
 * every one of them would re-render the grid under the pointer that
 * was still drawing on it.
 */

export function SchedulerTool({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const data = useQuery(api.calendar.getSchedule, { campaignId });
  const setAvailability = useMutation(api.calendar.setAvailability);
  const setWindow = useMutation(api.calendar.setWindow);

  const [draft, setDraft] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  /**
   * The drag in progress.
   *
   * A ref rather than state: it is read by pointer handlers that fire
   * many times a second, and re-rendering the whole grid to record
   * which cell the pointer is over would make the drag stutter. What
   * the grid paints comes from `preview`, which is state.
   */
  const drag = useRef<
    | {
        from: { day: string; minute: number };
        mode: "add" | "remove";
        base: string[];
      }
    | null
  >(null);
  const [preview, setPreview] = useState<string[] | null>(null);

  const window_: ScheduleWindow | null = useMemo(
    () =>
      data
        ? reconcileWindow({
            days: data.days,
            startMinute: data.startMinute,
            endMinute: data.endMinute,
            slotMinutes: data.slotMinutes,
          })
        : null,
    [data]
  );

  const mine = useMemo(
    () => data?.respondents.find((r) => r.userId === data.youId)?.slots ?? [],
    [data]
  );

  // A drag can end anywhere — off the grid, off the window — and a
  // pointerup the grid never sees would leave it painting forever.
  useEffect(() => {
    const stop = () => {
      if (!drag.current) return;
      drag.current = null;
      setPreview((p) => {
        if (p) setDraft(p);
        return null;
      });
    };
    globalThis.addEventListener("pointerup", stop);
    globalThis.addEventListener("pointercancel", stop);
    return () => {
      globalThis.removeEventListener("pointerup", stop);
      globalThis.removeEventListener("pointercancel", stop);
    };
  }, []);

  if (data === undefined || window_ === null) {
    return <p className="centered-note">Loading the scheduler…</p>;
  }

  const slots = slotsOf(window_);
  const selected = preview ?? draft ?? mine;
  const dirty = draft !== null && draft.slice().sort().join() !== mine.slice().sort().join();

  const counts = tally(
    data.respondents.map((r) => ({
      userId: r.userId,
      name: r.name,
      // Your own unsaved marks are what YOU should see reflected in the
      // agreement counts; everyone else's come from the server.
      slots: r.userId === data.youId ? selected : r.slots,
    }))
  );

  const answered = data.respondents.filter((r) => r.answered);
  const waiting = data.respondents.filter((r) => !r.answered);
  const best = blocks(
    window_,
    data.respondents.map((r) => ({
      userId: r.userId,
      name: r.name,
      slots: r.userId === data.youId ? selected : r.slots,
    })),
    Math.max(1, answered.length)
  );

  const save = async () => {
    if (draft === null) return;
    try {
      setError(null);
      await setAvailability({ campaignId, slots: draft });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your times.");
    }
  };

  const beginDrag = (day: string, minute: number) => {
    const key = slotKey(day, minute);
    const base = selected;
    const mode = base.includes(key) ? "remove" : "add";
    drag.current = { from: { day, minute }, mode, base };
    setPreview(applyDrag(base, [key], mode));
  };

  const extendDrag = (day: string, minute: number) => {
    const d = drag.current;
    if (!d) return;
    setPreview(
      applyDrag(d.base, dragRect(window_, d.from, { day, minute }), d.mode)
    );
  };

  return (
    <div className="sched">
      <div className="sched-bar">
        <h1 className="sched-title">Scheduler</h1>
        {data.isDm && (
          <button
            type="button"
            className="npc-btn"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Close" : "Choose days & hours"}
          </button>
        )}
        {dirty && (
          <>
            <button
              type="button"
              className="npc-btn"
              onClick={() => setDraft(null)}
            >
              Discard
            </button>
            <button
              type="button"
              className="npc-btn primary"
              onClick={() => void save()}
            >
              Save my times
            </button>
          </>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}

      {editing && data.isDm && (
        <WindowForm
          campaignId={campaignId}
          window={window_}
          onDone={() => setEditing(false)}
          onSave={setWindow}
        />
      )}

      {window_.days.length === 0 ? (
        <p className="centered-note">
          {data.isDm
            ? "No days offered yet — choose some days and hours to get started."
            : "The GM hasn’t offered any days yet."}
        </p>
      ) : (
        <>
          <p className="settings-note sched-hint">
            Click, or click and drag, to mark the times you are free.
            Starting on a marked cell clears instead.
          </p>

          {/* touch-action is what makes a drag draw rather than scroll
              the page on a tablet. */}
          <div className="sched-grid-wrap">
            <table className="sched-grid">
              <thead>
                <tr>
                  <th className="sched-time-col" />
                  {window_.days.map((day) => {
                    const l = dayLabel(day);
                    return (
                      <th key={day}>
                        <span className="sched-day-date">{l.date}</span>
                        <span className="sched-day-weekday">{l.weekday}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {slots.map((minute) => (
                  <tr
                    key={minute}
                    className={isHourStart(minute) ? "sched-hour" : ""}
                  >
                    <th className="sched-time-col">
                      {isHourStart(minute) ? formatTime(minute) : ""}
                    </th>
                    {window_.days.map((day) => {
                      const key = slotKey(day, minute);
                      const row = counts.get(key);
                      const free = row?.count ?? 0;
                      const everyone =
                        answered.length > 0 && free >= answered.length;
                      return (
                        <td
                          key={day}
                          className={`sched-cell${
                            selected.includes(key) ? " mine" : ""
                          }${everyone ? " all" : ""}`}
                          style={
                            free > 0
                              ? {
                                  ["--free" as string]:
                                    free / Math.max(1, answered.length),
                                }
                              : undefined
                          }
                          title={`${formatTime(minute)} — ${
                            row?.free.join(", ") || "nobody yet"
                          }`}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            beginDrag(day, minute);
                          }}
                          onPointerEnter={() => extendDrag(day, minute)}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sched-summary">
            <section className="settings-block">
              <h2>Times everyone agreed on</h2>
              {answered.length === 0 ? (
                <p className="settings-note">Nobody has answered yet.</p>
              ) : best.length === 0 ? (
                <p className="settings-note">
                  No time works for all {answered.length} who have answered
                  yet.
                </p>
              ) : (
                <ul className="sched-blocks">
                  {best.slice(0, 12).map((b) => {
                    const l = dayLabel(b.day);
                    return (
                      <li key={`${b.day}-${b.startMinute}`}>
                        <strong>
                          {l.weekday} {l.date}
                        </strong>{" "}
                        {formatTime(b.startMinute)} – {formatTime(b.endMinute)}
                        <span className="settings-note">
                          {" "}
                          — {b.count} of {answered.length}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {waiting.length > 0 && answered.length > 0 && (
                <p className="settings-note">
                  Still counting only the {answered.length} who have answered.
                </p>
              )}
            </section>

            <section className="settings-block">
              <h2>Who has answered</h2>
              <ul className="sched-people">
                {data.respondents.map((r) => (
                  <li key={r.userId}>
                    <span
                      className={`sched-dot${r.answered ? " in" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="sched-person">
                      {r.name}
                      {r.isDm && <span className="badge">GM</span>}
                      {r.userId === data.youId && (
                        <span className="settings-note"> (you)</span>
                      )}
                    </span>
                    <span className="settings-note">
                      {r.answered
                        ? r.slots.length === 0
                          ? "none of these work"
                          : `${r.slots.length} slot${
                              r.slots.length === 1 ? "" : "s"
                            }`
                        : "hasn’t answered"}
                    </span>
                  </li>
                ))}
              </ul>
              {missing(
                data.respondents.filter((r) => r.answered)
              ).length > 0 && (
                <p className="settings-note">
                  Someone answered with no times at all — that is a real
                  answer, not a missing one.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** The GM's half: which days, and between what hours. */
function WindowForm({
  campaignId,
  window: w,
  onDone,
  onSave,
}: {
  campaignId: Id<"campaigns">;
  window: ScheduleWindow;
  onDone: () => void;
  onSave: ReturnType<typeof useMutation<typeof api.calendar.setWindow>>;
}) {
  const [days, setDays] = useState<string[]>(w.days);
  const [startMinute, setStart] = useState(w.startMinute);
  const [endMinute, setEnd] = useState(w.endMinute);
  const [slotMinutes, setSlot] = useState(w.slotMinutes);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="settings-block">
      <h2>Days on offer</h2>
      <p className="settings-note">
        Real dates, not campaign ones — this is which evening everyone is
        free, not what day it is in the world.
      </p>

      {error && <p className="form-error">{error}</p>}

      {/* A month you click days off, rather than a date field you
          type into one at a time. Picking four Saturdays was four
          separate typed dates before, and nothing showed you they
          were Saturdays until afterwards. */}
      <DayPicker days={days} onToggle={(d) => setDays(toggleDay(days, d))} />

      <div className="sched-daylist">
        {days.map((d) => {
          const l = dayLabel(d);
          return (
            <span className="sched-daychip" key={d}>
              {l.weekday} {l.date}
              <button
                type="button"
                className="text-button"
                aria-label={`Remove ${d}`}
                onClick={() => setDays(days.filter((x) => x !== d))}
              >
                ×
              </button>
            </span>
          );
        })}
        {days.length === 0 && (
          <span className="settings-note">No days yet.</span>
        )}
      </div>

      <div className="cal-date-row">
        <label className="cal-field">
          From
          <input
            type="time"
            className="detail-input"
            value={toTimeInput(startMinute)}
            onChange={(e) => setStart(fromTimeInput(e.target.value))}
          />
        </label>
        <label className="cal-field">
          To
          <input
            type="time"
            className="detail-input"
            value={toTimeInput(endMinute)}
            onChange={(e) => setEnd(fromTimeInput(e.target.value))}
          />
        </label>
        <label className="cal-field">
          Cell size
          <select
            value={slotMinutes}
            onChange={(e) => setSlot(Number(e.target.value))}
          >
            {[15, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} minutes
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="cal-actions">
        <button type="button" className="npc-btn" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="npc-btn primary"
          onClick={async () => {
            try {
              setError(null);
              await onSave({
                campaignId,
                days,
                startMinute,
                endMinute,
                slotMinutes,
              });
              onDone();
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not save the days."
              );
            }
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** 540 → "09:00", which is the only format <input type="time"> takes. */
function toTimeInput(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fromTimeInput(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/** Exported for the nav page; keeps addIsoDays reachable for tests. */
export { addIsoDays };

/**
 * A month you click days off.
 *
 * A bare date field meant typing four separate dates to offer four
 * Saturdays, and nothing told you they were Saturdays until you had
 * finished. A month shows the shape of what you are offering while you
 * are choosing it: the weekend column, the gap, the week after.
 *
 * The viewed month is local state and starts on the first day already
 * offered, so reopening the form lands where the answer is rather than
 * on today.
 */
function DayPicker({
  days,
  onToggle,
}: {
  days: string[];
  onToggle: (iso: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    if (days.length > 0) return days[0];
    const now = new Date();
    return toIso(now.getFullYear(), now.getMonth(), 1);
  });

  const { year, month } = isoParts(cursor);
  const weeks = realMonthGrid(year, month);
  const chosen = new Set(days);
  const full = days.length >= SCHEDULE_LIMITS.days;

  return (
    <div className="daypick">
      <div className="daypick-bar">
        <button
          type="button"
          className="npc-btn cal-step"
          aria-label="Previous month"
          onClick={() => setCursor(addIsoMonths(cursor, -1))}
        >
          ‹
        </button>
        <div className="daypick-title">{monthTitle(cursor)}</div>
        <button
          type="button"
          className="npc-btn cal-step"
          aria-label="Next month"
          onClick={() => setCursor(addIsoMonths(cursor, 1))}
        >
          ›
        </button>
      </div>

      <table className="daypick-grid">
        <thead>
          <tr>
            {WEEKDAY_NAMES.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((iso, di) =>
                iso === null ? (
                  <td key={di} className="daypick-blank" />
                ) : (
                  <td key={di}>
                    <button
                      type="button"
                      className={`daypick-day${
                        chosen.has(iso) ? " on" : ""
                      }`}
                      // A full list must not silently ignore a click;
                      // the button says why it cannot take another.
                      disabled={full && !chosen.has(iso)}
                      title={
                        full && !chosen.has(iso)
                          ? `${SCHEDULE_LIMITS.days} days is the limit`
                          : iso
                      }
                      onClick={() => onToggle(iso)}
                    >
                      {isoParts(iso).day}
                    </button>
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="settings-note">
        {days.length} day{days.length === 1 ? "" : "s"} offered
        {full ? ` — ${SCHEDULE_LIMITS.days} is the limit` : ""}
      </p>
    </div>
  );
}
