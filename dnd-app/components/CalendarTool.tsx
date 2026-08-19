"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  CalendarDate,
  CalendarSettings,
  LIMITS,
  addMonths,
  formatDate,
  monthGrid,
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

  const [view, setView] = useState<{ year: number; month: number } | null>(
    null
  );
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const setToday = async (day: number) => {
    try {
      setError(null);
      await setCurrentDate({
        campaignId,
        year: view.year,
        month: view.month,
        day,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move the date.");
    }
  };

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

        <div className="cal-today muted">
          {today ? formatDate(settings, today) : ""}
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

      {isDm && !editing && (
        <p className="settings-note">
          Click a day to set the campaign&apos;s current date.
        </p>
      )}

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
                  return (
                    <td key={di} className={isToday ? "cal-now" : undefined}>
                      {isDm ? (
                        <button
                          type="button"
                          className="cal-day"
                          onClick={() => void setToday(day)}
                          title={formatDate(settings, cell)}
                        >
                          {day}
                        </button>
                      ) : (
                        <span className="cal-day">{day}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
