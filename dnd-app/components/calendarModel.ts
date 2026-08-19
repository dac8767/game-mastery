/**
 * A campaign's calendar, which is not the Gregorian one.
 *
 * Every setting Derek asked for is here — days per week, days per
 * month, day names, months per year, month names, the current date —
 * and two of those pairs describe the same thing twice: a week is
 * `daysPerWeek` long AND has `dayNames` in it. Keeping both is what was
 * asked for, so the count is the authority and `reconcile` resizes the
 * names to match. Otherwise a five-day week with seven day names is a
 * grid whose header doesn't line up with its columns, and nothing in
 * the type system objects.
 *
 * Free of React and Convex so the unit guard can compile it alone: the
 * date arithmetic is where the bugs in a custom calendar live, and it
 * is the cheapest thing in the app to cover.
 */

export interface CalendarSettings {
  daysPerWeek: number;
  dayNames: string[];
  daysPerMonth: number;
  monthsPerYear: number;
  monthNames: string[];
  currentYear: number;
  /** 0-based, so it indexes monthNames directly. */
  currentMonth: number;
  /** 1-based, the way a person says a date. */
  currentDay: number;
}

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Ceilings, not preferences.
 *
 * A calendar is rendered as a grid of weeks, so a thousand-day week is
 * a thousand DOM columns. These bound the damage a typo in a number
 * field can do; nothing here is a judgement about what a fantasy year
 * should look like.
 */
export const LIMITS = {
  daysPerWeek: { min: 1, max: 20 },
  daysPerMonth: { min: 1, max: 100 },
  monthsPerYear: { min: 1, max: 36 },
};

export const DEFAULT_CALENDAR: CalendarSettings = {
  daysPerWeek: 7,
  dayNames: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
  daysPerMonth: 30,
  monthsPerYear: 12,
  monthNames: [
    "Hammer",
    "Alturiak",
    "Ches",
    "Tarsakh",
    "Mirtul",
    "Kythorn",
    "Flamerule",
    "Eleasis",
    "Eleint",
    "Marpenoth",
    "Uktar",
    "Nightal",
  ],
  currentYear: 1491,
  currentMonth: 0,
  currentDay: 1,
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));

/**
 * Grow or shrink a name list to `count`, keeping what was typed.
 *
 * Renaming the sixth day and then widening the week to eight must not
 * lose the sixth name, so this pads rather than regenerating.
 */
export function resizeNames(
  names: string[],
  count: number,
  prefix: string
): string[] {
  const out = names.slice(0, count);
  for (let i = out.length; i < count; i++) out.push(`${prefix} ${i + 1}`);
  return out.map((n, i) => (n.trim() ? n : `${prefix} ${i + 1}`));
}

/**
 * The settings, made self-consistent. IDEMPOTENT.
 *
 * Runs on every load and every save, because a calendar can arrive from
 * a hand-edited row or from a save that shrank the week: the current
 * date has to survive into the smaller month, and the name lists have
 * to match their counts.
 */
export function reconcile(s: CalendarSettings): CalendarSettings {
  const daysPerWeek = clamp(
    s.daysPerWeek,
    LIMITS.daysPerWeek.min,
    LIMITS.daysPerWeek.max
  );
  const daysPerMonth = clamp(
    s.daysPerMonth,
    LIMITS.daysPerMonth.min,
    LIMITS.daysPerMonth.max
  );
  const monthsPerYear = clamp(
    s.monthsPerYear,
    LIMITS.monthsPerYear.min,
    LIMITS.monthsPerYear.max
  );

  return {
    daysPerWeek,
    daysPerMonth,
    monthsPerYear,
    dayNames: resizeNames(s.dayNames ?? [], daysPerWeek, "Day"),
    monthNames: resizeNames(s.monthNames ?? [], monthsPerYear, "Month"),
    currentYear: Math.round(
      Number.isFinite(s.currentYear) ? s.currentYear : 1
    ),
    currentMonth: clamp(s.currentMonth, 0, monthsPerYear - 1),
    currentDay: clamp(s.currentDay, 1, daysPerMonth),
  };
}

/**
 * Days elapsed since year 1, month 1, day 1 — which is index 0.
 *
 * Every year is the same length here, because `daysPerMonth` is one
 * number: a calendar with months of differing lengths is a different
 * data model, and nothing asked for one.
 */
export function dayIndex(s: CalendarSettings, d: CalendarDate): number {
  const daysPerYear = s.monthsPerYear * s.daysPerMonth;
  return (
    (d.year - 1) * daysPerYear + d.month * s.daysPerMonth + (d.day - 1)
  );
}

/** The inverse of dayIndex. Handles negative indices (years before 1). */
export function fromDayIndex(s: CalendarSettings, index: number): CalendarDate {
  const daysPerYear = s.monthsPerYear * s.daysPerMonth;
  const year = Math.floor(index / daysPerYear) + 1;
  const within = index - (year - 1) * daysPerYear;
  return {
    year,
    month: Math.floor(within / s.daysPerMonth),
    day: (within % s.daysPerMonth) + 1,
  };
}

/**
 * Which day of the week a date falls on, 0-based.
 *
 * The modulo is written the long way because JavaScript's `%` keeps the
 * sign of its left operand: a date before year 1 would otherwise land
 * on weekday -3, and the grid would silently drop it.
 */
export function weekdayOf(s: CalendarSettings, d: CalendarDate): number {
  const i = dayIndex(s, d);
  return ((i % s.daysPerWeek) + s.daysPerWeek) % s.daysPerWeek;
}

export function addDays(
  s: CalendarSettings,
  d: CalendarDate,
  n: number
): CalendarDate {
  return fromDayIndex(s, dayIndex(s, d) + Math.round(n));
}

/** Step a month, rolling the year over in either direction. */
export function addMonths(
  s: CalendarSettings,
  d: CalendarDate,
  n: number
): CalendarDate {
  const total = d.year * s.monthsPerYear + d.month + Math.round(n);
  const year = Math.floor(total / s.monthsPerYear);
  const month = ((total % s.monthsPerYear) + s.monthsPerYear) % s.monthsPerYear;
  return { year, month, day: Math.min(d.day, s.daysPerMonth) };
}

/**
 * A month as rows of weeks: day numbers, with nulls padding the first
 * week so day 1 sits under its own weekday.
 */
export function monthGrid(
  s: CalendarSettings,
  year: number,
  month: number
): (number | null)[][] {
  const lead = weekdayOf(s, { year, month, day: 1 });
  const cells: (number | null)[] = Array(lead).fill(null);
  for (let day = 1; day <= s.daysPerMonth; day++) cells.push(day);
  while (cells.length % s.daysPerWeek !== 0) cells.push(null);

  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += s.daysPerWeek) {
    weeks.push(cells.slice(i, i + s.daysPerWeek));
  }
  return weeks;
}

export function sameDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** "12 Hammer, 1491 (Sunday)" — the way it reads at the table. */
export function formatDate(s: CalendarSettings, d: CalendarDate): string {
  const month = s.monthNames[d.month] ?? `Month ${d.month + 1}`;
  const weekday = s.dayNames[weekdayOf(s, d)] ?? "";
  return `${d.day} ${month}, ${d.year}${weekday ? ` (${weekday})` : ""}`;
}
