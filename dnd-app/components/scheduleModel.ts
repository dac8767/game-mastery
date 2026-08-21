/**
 * Finding a night everyone can play.
 *
 * The DM offers some days; everyone paints the times they are free on
 * them; the tool says which times survive. That is the whole of it, and
 * all the interesting parts are arithmetic:
 *
 *   - a day is a real calendar date, not a campaign one. Nobody
 *     schedules a session for the 10th of Autumn.
 *   - a time is MINUTES FROM MIDNIGHT, not a string. "9:00 AM" sorts
 *     before "10:00 AM" only by accident, and "12:30 PM" is 750 rather
 *     than anything you would get from parsing it.
 *   - dates are handled as their own three numbers and never through
 *     the local Date constructor. `new Date("2026-08-25")` is UTC
 *     midnight, which in Derek's timezone is the 24th — a scheduler
 *     that shows the wrong weekday is worse than no scheduler.
 *
 * Free of React and Convex so the unit guard can compile it alone.
 */

export interface ScheduleWindow {
  /** ISO "YYYY-MM-DD", the days the DM offered. */
  days: string[];
  /** Minutes from midnight. 540 is 9:00 AM. */
  startMinute: number;
  endMinute: number;
  /** Length of one cell. 30 gives the half-hour rows in the mockup. */
  slotMinutes: number;
}

export const DEFAULT_WINDOW: ScheduleWindow = {
  days: [],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  slotMinutes: 30,
};

/**
 * Ceilings, because the grid is days × slots cells of real DOM.
 *
 * A year of days at five-minute resolution is a hundred thousand
 * cells and a dead tab. Nothing here is a judgement about how far
 * ahead a group should plan.
 */
export const SCHEDULE_LIMITS = {
  days: 31,
  slotMinutes: { min: 5, max: 240 },
  maxSlotsPerDay: 288,
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));

// ---------------------------------------------------------------------
// Dates, done by hand
// ---------------------------------------------------------------------

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Round-tripped through UTC so 2026-02-30 is rejected rather than
  // silently becoming the 2nd of March.
  const at = new Date(Date.UTC(y, m - 1, d));
  return (
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === m - 1 &&
    at.getUTCDate() === d
  );
}

/**
 * "Aug 25" and "Tue", the two lines of a column heading.
 *
 * UTC throughout: the input is a calendar date with no time in it, and
 * the only thing local time could do here is move it a day.
 */
export function dayLabel(iso: string): { date: string; weekday: string } {
  if (!isIsoDate(iso)) return { date: iso, weekday: "" };
  const [y, m, d] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return {
    date: `${MONTHS[m - 1]} ${d}`,
    weekday: WEEKDAYS[at.getUTCDay()],
  };
}

/** Days after an ISO date, as an ISO date. */
export function addIsoDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + Math.round(n)));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(
    at.getUTCDate()
  )}`;
}

// ---------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------

/** 540 → "9:00 AM". 750 → "12:30 PM". 0 → "12:00 AM". */
export function formatTime(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h24 < 12 ? "AM" : "PM";
  // 0 and 12 are both "12" on a clock face — the one place where
  // modular arithmetic and how people read a clock disagree.
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${suffix}`;
}

/** The window, made renderable. IDEMPOTENT. */
export function reconcileWindow(w: ScheduleWindow): ScheduleWindow {
  const slotMinutes = clamp(
    w.slotMinutes,
    SCHEDULE_LIMITS.slotMinutes.min,
    SCHEDULE_LIMITS.slotMinutes.max
  );
  const startMinute = clamp(w.startMinute, 0, 1440 - slotMinutes);
  // An end at or before the start is a grid with no rows; pushing it
  // out by one slot is the smallest thing that still renders.
  const endMinute = clamp(w.endMinute, startMinute + slotMinutes, 1440);

  const days: string[] = [];
  for (const d of w.days ?? []) {
    if (isIsoDate(d) && !days.includes(d)) days.push(d);
    if (days.length >= SCHEDULE_LIMITS.days) break;
  }
  days.sort();

  return { days, startMinute, endMinute, slotMinutes };
}

/** Every slot's start minute, top to bottom. */
export function slotsOf(w: ScheduleWindow): number[] {
  const out: number[] = [];
  for (
    let m = w.startMinute;
    m + w.slotMinutes <= w.endMinute && out.length < SCHEDULE_LIMITS.maxSlotsPerDay;
    m += w.slotMinutes
  ) {
    out.push(m);
  }
  return out;
}

/**
 * Which rows get a label, and which get a line.
 *
 * The mockup labels the hour and rules a dotted line at the half. Read
 * off the clock rather than off the row index, so a 20-minute grid puts
 * its solid lines on the hours too instead of every third row
 * regardless of what time it is.
 */
export function isHourStart(minute: number): boolean {
  return minute % 60 === 0;
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------

/** "2026-08-25T540" — one cell, addressable as a string. */
export function slotKey(day: string, minute: number): string {
  return `${day}T${Math.round(minute)}`;
}

export function parseSlotKey(
  key: string
): { day: string; minute: number } | null {
  const at = key.lastIndexOf("T");
  if (at === -1) return null;
  const day = key.slice(0, at);
  const minute = Number(key.slice(at + 1));
  if (!isIsoDate(day) || !Number.isFinite(minute)) return null;
  return { day, minute };
}

export interface Respondent {
  userId: string;
  name: string;
  /** Slot keys this person marked. */
  slots: string[];
}

export interface SlotTally {
  key: string;
  /** Names, in the order the respondents were given. */
  free: string[];
  count: number;
}

/**
 * Who is free in each cell.
 *
 * Built once for the whole grid rather than asked per cell: the grid
 * asks this question for every cell it paints, and a scan of every
 * respondent's list per cell is the difference between a grid that
 * drags smoothly and one that does not.
 */
export function tally(respondents: Respondent[]): Map<string, SlotTally> {
  const out = new Map<string, SlotTally>();
  for (const r of respondents) {
    for (const key of r.slots) {
      const row = out.get(key) ?? { key, free: [], count: 0 };
      // A duplicate slot in one person's list must not count twice, or
      // "everyone is free" can be reached by one person alone.
      if (row.free.includes(r.name)) continue;
      row.free.push(r.name);
      row.count++;
      out.set(key, row);
    }
  }
  return out;
}

/** Who has not marked anything yet. */
export function missing(respondents: Respondent[]): string[] {
  return respondents.filter((r) => r.slots.length === 0).map((r) => r.name);
}

export interface Consensus {
  key: string;
  day: string;
  minute: number;
  count: number;
  free: string[];
}

/**
 * The times that work, best first.
 *
 * "Best" is how many people are free, and only people who have
 * ANSWERED are counted — a group of five where two have not replied
 * has a best case of three, and calling that "everyone" would be a
 * scheduling tool lying about the one thing it is for. Which is why
 * the caller is also given `missing`.
 *
 * Ties break by time, so two equally good slots read in the order they
 * happen rather than in whatever order the map was built.
 */
export function consensus(
  w: ScheduleWindow,
  respondents: Respondent[],
  minimum = 1
): Consensus[] {
  const counts = tally(respondents);
  const out: Consensus[] = [];

  for (const day of w.days) {
    for (const minute of slotsOf(w)) {
      const key = slotKey(day, minute);
      const row = counts.get(key);
      if (!row || row.count < minimum) continue;
      out.push({ key, day, minute, count: row.count, free: row.free });
    }
  }

  return out.sort(
    (a, b) =>
      b.count - a.count ||
      a.day.localeCompare(b.day) ||
      a.minute - b.minute
  );
}

/**
 * Consecutive slots merged into blocks — "Tue 6:00 PM – 9:00 PM".
 *
 * A three-hour window at half-hour resolution is six rows saying the
 * same thing, and a list of six is harder to read than one line. Only
 * runs with the SAME people are merged: two adjacent slots where
 * different halves of the group are free is not a time everyone can
 * play, and printing it as one block would say it was.
 */
export interface ConsensusBlock {
  day: string;
  startMinute: number;
  endMinute: number;
  count: number;
  free: string[];
}

export function blocks(
  w: ScheduleWindow,
  respondents: Respondent[],
  minimum = 1
): ConsensusBlock[] {
  const counts = tally(respondents);
  const out: ConsensusBlock[] = [];

  for (const day of w.days) {
    let run: ConsensusBlock | null = null;

    for (const minute of slotsOf(w)) {
      const row = counts.get(slotKey(day, minute));
      const ok = row && row.count >= minimum;
      const who = ok ? row.free.slice().sort().join(" ") : null;

      if (
        run &&
        ok &&
        run.endMinute === minute &&
        run.free.slice().sort().join(" ") === who
      ) {
        run.endMinute = minute + w.slotMinutes;
        continue;
      }
      if (run) out.push(run);
      run = ok
        ? {
            day,
            startMinute: minute,
            endMinute: minute + w.slotMinutes,
            count: row.count,
            free: row.free,
          }
        : null;
    }
    if (run) out.push(run);
  }

  return out.sort(
    (a, b) =>
      b.count - a.count ||
      b.endMinute - b.startMinute - (a.endMinute - a.startMinute) ||
      a.day.localeCompare(b.day) ||
      a.startMinute - b.startMinute
  );
}

/**
 * The cells a drag covers — a rectangle, not a ribbon.
 *
 * Dragging from Tuesday 6pm to Thursday 8pm means those hours on those
 * three days, which is what a person painting a grid means and what
 * every scheduler they have used does. Following the reading order
 * instead would select the whole of Tuesday evening, all of Wednesday,
 * and Thursday up to 8 — nobody means that.
 */
export function dragRect(
  w: ScheduleWindow,
  from: { day: string; minute: number },
  to: { day: string; minute: number }
): string[] {
  const di = w.days.indexOf(from.day);
  const dj = w.days.indexOf(to.day);
  if (di === -1 || dj === -1) return [];

  const [d0, d1] = di <= dj ? [di, dj] : [dj, di];
  const [m0, m1] =
    from.minute <= to.minute
      ? [from.minute, to.minute]
      : [to.minute, from.minute];

  const out: string[] = [];
  for (const day of w.days.slice(d0, d1 + 1)) {
    for (const minute of slotsOf(w)) {
      if (minute >= m0 && minute <= m1) out.push(slotKey(day, minute));
    }
  }
  return out;
}

/**
 * A selection with a drag applied, without committing it.
 *
 * The mode is decided by the cell the drag STARTED on: begin on a
 * marked cell and the drag clears, begin on an empty one and it fills.
 * That is what every grid of this shape does, and the alternative —
 * toggling each cell as you cross it — makes a drag across mixed cells
 * produce a checkerboard.
 */
export function applyDrag(
  selected: string[],
  covered: string[],
  mode: "add" | "remove"
): string[] {
  const set = new Set(selected);
  for (const key of covered) {
    if (mode === "add") set.add(key);
    else set.delete(key);
  }
  return [...set];
}
