"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  CalendarDate,
  CalendarEvent,
  CalendarSettings,
  LIMITS,
  REPEATS,
  RepeatRule,
  addDays,
  addMonths,
  formatDate,
  monthGrid,
  occursOn,
  reconcile,
  sameDate,
} from "@/components/calendarModel";

/**
 * The campaign calendar.
 *
 * Everyone sees the same date, because the date is a fact about the
 * world rather than a private note. Only the DM changes it, and only
 * the DM sees the settings — a player looking at a month grid does not
 * need a form for renaming the months.
 *
 * The viewed month is local state, deliberately separate from the
 * campaign's current date: flicking forward to check when a festival
 * falls must not move the world's clock.
 */

export function CalendarTool({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const raw = useQuery(api.calendar.getCalendar, { campaignId });
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const setCurrentDate = useMutation(api.calendar.setCurrentDate);
  const events = useQuery(api.calendar.listEvents, { campaignId });

  const [view, setView] = useState<{ year: number; month: number } | null>(
    null
  );
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The day you are LOOKING at, which is not the day it is.
   *
   * These were one value, which is why clicking a date used to move the
   * world's clock. Keeping them apart is what makes "clicking a day does
   * not change the current date" true by construction rather than by
   * remembering not to.
   */
  const [selected, setSelected] = useState<CalendarDate | null>(null);
  const [composing, setComposing] = useState(false);
  const [editingEvent, setEditingEvent] = useState<string | null>(null);

  const settings = useMemo(
    () => (raw ? reconcile(raw as CalendarSettings) : null),
    [raw]
  );

  const today: CalendarDate | null = settings
    ? {
        year: settings.currentYear,
        month: settings.currentMonth,
        day: settings.currentDay,
      }
    : null;

  // Open on the campaign's current month, then leave the view alone —
  // re-centring on every server update would yank the month out from
  // under someone browsing ahead.
  useEffect(() => {
    if (view === null && today) {
      setView({ year: today.year, month: today.month });
    }
  }, [view, today]);

  if (settings === null || campaigns === undefined || view === null) {
    return <p className="centered-note">Loading the calendar…</p>;
  }

  const isDm = campaigns.find((c) => c._id === campaignId)?.isDm ?? false;
  const weeks = monthGrid(settings, view.year, view.month);
  const step = (n: number) => {
    const next = addMonths(settings, { ...view, day: 1 }, n);
    setView({ year: next.year, month: next.month });
  };

  /** Move the campaign's clock by whole days. Nothing else moves it. */
  const nudge = async (days: number) => {
    if (!today) return;
    const next = addDays(settings, today, days);
    try {
      setError(null);
      await setCurrentDate({
        campaignId,
        year: next.year,
        month: next.month,
        day: next.day,
      });
      // Follow the date if you were watching the month it left.
      setView({ year: next.year, month: next.month });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move the date.");
    }
  };

  const eventList = (events ?? []) as (CalendarEvent & { _id: string; notes?: string })[];
  const eventsOn = (date: CalendarDate) =>
    eventList.filter((e) => occursOn(settings, e, date));

  return (
    <div className="cal">
      <div className="cal-bar">
        <button type="button" className="npc-btn" onClick={() => step(-1)}>
          ‹
        </button>
        <div className="cal-title">
          {settings.monthNames[view.month]} {view.year}
        </div>
        <button type="button" className="npc-btn" onClick={() => step(1)}>
          ›
        </button>

        <button
          type="button"
          className="npc-btn"
          onClick={() => today && setView({ year: today.year, month: today.month })}
        >
          Today
        </button>

        {/* The campaign's clock. Only these two arrows move it — the grid
            below selects a day to look at and never sets one. */}
        <div className="cal-now-bar">
          {isDm && (
            <button
              type="button"
              className="npc-btn"
              onClick={() => void nudge(-1)}
              title="Back one day"
              aria-label="Back one day"
            >
              ‹
            </button>
          )}
          <span className="cal-now-date">
            {today ? formatDate(settings, today) : ""}
          </span>
          {isDm && (
            <button
              type="button"
              className="npc-btn"
              onClick={() => void nudge(1)}
              title="Forward one day"
              aria-label="Forward one day"
            >
              ›
            </button>
          )}
        </div>

        {isDm && (
          <button
            type="button"
            className="npc-btn"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Close settings" : "Settings"}
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}

      {editing && isDm ? (
        <CalendarSettingsForm
          campaignId={campaignId}
          settings={settings}
          onDone={() => setEditing(false)}
        />
      ) : (
        <table
          className="cal-grid"
          style={{ ["--cal-cols" as string]: settings.daysPerWeek }}
        >
          <thead>
            <tr>
              {settings.dayNames.map((d) => (
                <th key={d} title={d}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi}>
                {week.map((day, di) => {
                  if (day === null) {
                    return <td key={di} className="cal-blank" />;
                  }
                  const cell = { year: view.year, month: view.month, day };
                  const isToday = today ? sameDate(cell, today) : false;
                  const isPicked = selected ? sameDate(cell, selected) : false;
                  const onThisDay = eventsOn(cell);
                  return (
                    <td
                      key={di}
                      className={`${isToday ? "cal-now" : ""}${
                        isPicked ? " cal-picked" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="cal-day"
                        onClick={() => {
                          setSelected(cell);
                          setComposing(false);
                          setEditingEvent(null);
                        }}
                        title={formatDate(settings, cell)}
                      >
                        <span className="cal-daynum">{day}</span>
                        <span className="cal-day-events">
                          {onThisDay.map((e) => (
                            <span className="cal-chip" key={e._id}>
                              {e.title}
                            </span>
                          ))}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!editing && selected && (
        <DayPanel
          campaignId={campaignId}
          settings={settings}
          date={selected}
          events={eventsOn(selected)}
          isDm={isDm}
          composing={composing}
          setComposing={setComposing}
          editingEvent={editingEvent}
          setEditingEvent={setEditingEvent}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * What is on the day you clicked, and — for the DM — how to put
 * something there.
 *
 * Below the grid rather than in a dialog: the point of clicking a day is
 * usually to compare it with the days around it, and a modal covers
 * exactly what you were looking at.
 */
function DayPanel({
  campaignId,
  settings,
  date,
  events,
  isDm,
  composing,
  setComposing,
  editingEvent,
  setEditingEvent,
  onClose,
}: {
  campaignId: Id<"campaigns">;
  settings: CalendarSettings;
  date: CalendarDate;
  events: (CalendarEvent & { _id: string; notes?: string })[];
  isDm: boolean;
  composing: boolean;
  setComposing: (v: boolean) => void;
  editingEvent: string | null;
  setEditingEvent: (v: string | null) => void;
  onClose: () => void;
}) {
  const remove = useMutation(api.calendar.deleteEvent);
  const being = events.find((e) => e._id === editingEvent) ?? null;

  return (
    <section className="cal-panel">
      <header className="cal-panel-head">
        <h2>{formatDate(settings, date)}</h2>
        {isDm && !composing && !being && (
          <button
            type="button"
            className="npc-btn"
            onClick={() => setComposing(true)}
          >
            Add event
          </button>
        )}
        <button type="button" className="text-button" onClick={onClose}>
          Close
        </button>
      </header>

      {composing || being ? (
        <EventForm
          campaignId={campaignId}
          date={date}
          event={being}
          onDone={() => {
            setComposing(false);
            setEditingEvent(null);
          }}
        />
      ) : events.length === 0 ? (
        <p className="settings-note">Nothing on this day.</p>
      ) : (
        <ul className="cal-events">
          {events.map((e) => (
            <li key={e._id}>
              <div className="cal-event-text">
                <strong>{e.title}</strong>
                {e.repeat !== "once" && (
                  <span className="settings-note">
                    {" "}
                    — {REPEATS.find((r) => r.value === e.repeat)?.label}
                    {e.repeat === "everyNDays" ? ` (${e.intervalDays})` : ""}
                  </span>
                )}
                {e.notes && <p className="settings-note">{e.notes}</p>}
              </div>
              {isDm && (
                <span className="cal-event-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setEditingEvent(e._id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void remove({
                        eventId: e._id as Id<"calendarEvents">,
                      })
                    }
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Adding or changing one event. */
function EventForm({
  campaignId,
  date,
  event,
  onDone,
}: {
  campaignId: Id<"campaigns">;
  date: CalendarDate;
  event: (CalendarEvent & { _id: string; notes?: string }) | null;
  onDone: () => void;
}) {
  const save = useMutation(api.calendar.saveEvent);
  const [title, setTitle] = useState(event?.title ?? "");
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [repeat, setRepeat] = useState<RepeatRule>(event?.repeat ?? "once");
  const [interval, setInterval] = useState(String(event?.intervalDays ?? 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="cal-event-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
          await save({
            eventId: event ? (event._id as Id<"calendarEvents">) : undefined,
            campaignId,
            title: title.trim(),
            notes: notes.trim() || undefined,
            // An edited event keeps its own start date; a new one starts
            // on the day you clicked. Moving a repeating event means
            // moving where it repeats FROM, which is a different act.
            year: event ? event.year : date.year,
            month: event ? event.month : date.month,
            day: event ? event.day : date.day,
            repeat,
            intervalDays: repeat === "everyNDays" ? Number(interval) : undefined,
          });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save it");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What happens"
        aria-label="Event name"
      />
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        aria-label="Event notes"
      />
      <label className="cal-field">
        <span>Repeats</span>
        <select
          value={repeat}
          onChange={(e) => setRepeat(e.target.value as RepeatRule)}
        >
          {REPEATS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {repeat === "everyNDays" && (
        <label className="cal-field">
          <span>Every</span>
          <input
            type="number"
            min={1}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            aria-label="Days between occurrences"
          />
        </label>
      )}
      <button type="submit" className="primary" disabled={!title.trim() || busy}>
        {busy ? "Saving…" : event ? "Save" : "Add"}
      </button>
      <button type="button" className="text-button" onClick={onDone}>
        Cancel
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

/**
 * The settings Derek listed, and nothing else.
 *
 * Drafted locally and saved in one go rather than written per
 * keystroke: shrinking the week from seven to five renames days as you
 * type through "5", and doing that against the server would rewrite
 * everyone's calendar twice on the way to a number you hadn't finished
 * typing.
 */
function CalendarSettingsForm({
  campaignId,
  settings,
  onDone,
}: {
  campaignId: Id<"campaigns">;
  settings: CalendarSettings;
  onDone: () => void;
}) {
  const save = useMutation(api.calendar.saveCalendar);
  const [draft, setDraft] = useState<CalendarSettings>(settings);
  const [error, setError] = useState<string | null>(null);

  // Counts drive the name lists, so every edit goes through reconcile
  // and the two can never disagree.
  const patch = (p: Partial<CalendarSettings>) =>
    setDraft((d) => reconcile({ ...d, ...p }));

  const rename = (which: "dayNames" | "monthNames", i: number, v: string) =>
    setDraft((d) => ({
      ...d,
      [which]: d[which].map((n, j) => (j === i ? v : n)),
    }));

  const submit = async () => {
    try {
      setError(null);
      await save({ campaignId, ...reconcile(draft) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  };

  return (
    <div className="cal-settings">
      <section className="settings-block">
        <h2>The week</h2>
        <label className="cal-field">
          Days per week
          <input
            type="number"
            min={LIMITS.daysPerWeek.min}
            max={LIMITS.daysPerWeek.max}
            value={draft.daysPerWeek}
            onChange={(e) => patch({ daysPerWeek: Number(e.target.value) })}
          />
        </label>
        <div className="cal-names">
          {draft.dayNames.map((n, i) => (
            <input
              key={i}
              className="detail-input"
              value={n}
              onChange={(e) => rename("dayNames", i, e.target.value)}
              onBlur={() => setDraft((d) => reconcile(d))}
            />
          ))}
        </div>
      </section>

      <section className="settings-block">
        <h2>The year</h2>
        <label className="cal-field">
          Days per month
          <input
            type="number"
            min={LIMITS.daysPerMonth.min}
            max={LIMITS.daysPerMonth.max}
            value={draft.daysPerMonth}
            onChange={(e) => patch({ daysPerMonth: Number(e.target.value) })}
          />
        </label>
        <label className="cal-field">
          Months per year
          <input
            type="number"
            min={LIMITS.monthsPerYear.min}
            max={LIMITS.monthsPerYear.max}
            value={draft.monthsPerYear}
            onChange={(e) => patch({ monthsPerYear: Number(e.target.value) })}
          />
        </label>
        <div className="cal-names">
          {draft.monthNames.map((n, i) => (
            <input
              key={i}
              className="detail-input"
              value={n}
              onChange={(e) => rename("monthNames", i, e.target.value)}
              onBlur={() => setDraft((d) => reconcile(d))}
            />
          ))}
        </div>
      </section>

      <section className="settings-block">
        <h2>Current date</h2>
        <div className="cal-date-row">
          <label className="cal-field">
            Day
            <input
              type="number"
              min={1}
              max={draft.daysPerMonth}
              value={draft.currentDay}
              onChange={(e) => patch({ currentDay: Number(e.target.value) })}
            />
          </label>
          <label className="cal-field">
            Month
            <select
              value={draft.currentMonth}
              onChange={(e) => patch({ currentMonth: Number(e.target.value) })}
            >
              {draft.monthNames.map((m, i) => (
                <option key={i} value={i}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="cal-field">
            Year
            <input
              type="number"
              value={draft.currentYear}
              onChange={(e) => patch({ currentYear: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="settings-note">
          {formatDate(draft, {
            year: draft.currentYear,
            month: draft.currentMonth,
            day: draft.currentDay,
          })}
        </p>
      </section>

      {error && <p className="form-error">{error}</p>}

      <div className="cal-actions">
        <button type="button" className="npc-btn" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="npc-btn primary"
          onClick={() => void submit()}
        >
          Save calendar
        </button>
      </div>
    </div>
  );
}
