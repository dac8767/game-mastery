/**
 * How a campaign card reads its two dates.
 *
 * Import-free and pure, like the other helpers here, so the unit guard
 * can compile it on its own — see components/lookupFilters.ts for why
 * that rules out importing a sibling.
 *
 * These are REAL-WORLD dates: the day the group first sat down and the
 * day they next will. The campaign calendar is a different thing
 * entirely, with invented months and a week that is not seven days long
 * (see components/calendarModel.ts), and mixing the two would put a
 * session on the 40th of Hammer.
 */

/** Stored as "YYYY-MM-DD". Anything else is shown as typed. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "12 Sep 2026", or the raw string if it is not a date we wrote.
 *
 * Deliberately NOT `new Date(s).toLocaleDateString()`: parsing
 * "2026-09-12" that way reads it as UTC midnight, which in every
 * timezone west of Greenwich renders as the 11th. A date with no time
 * has no timezone, so it is split rather than parsed.
 */
export function formatCardDate(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const m = raw.match(ISO_DATE);
  if (!m) return raw;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return raw;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** Whole days from `from` to `value`, or null if either is unusable. */
export function daysUntil(value: unknown, from: Date): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const m = raw.match(ISO_DATE);
  if (!m) return null;

  // Both sides compared as calendar days in UTC, so a session "today"
  // stays today at 11pm rather than becoming yesterday.
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(
    from.getFullYear(),
    from.getMonth(),
    from.getDate()
  );
  if (!Number.isFinite(target)) return null;
  return Math.round((target - today) / 86_400_000);
}

export interface SessionCountdown {
  /** "tonight", "in 3 days", "3 days ago" — or "" when unknown. */
  label: string;
  /** A date that has been and gone, so the card can say so quietly. */
  overdue: boolean;
}

/**
 * How the next session reads at a glance.
 *
 * A date alone makes you count on your fingers; the point of the card
 * is answering "is it this week" without doing that.
 */
export function untilSession(
  value: unknown,
  now: Date = new Date()
): SessionCountdown {
  const days = daysUntil(value, now);
  if (days === null) return { label: "", overdue: false };

  if (days === 0) return { label: "— tonight", overdue: false };
  if (days === 1) return { label: "— tomorrow", overdue: false };
  if (days === -1) return { label: "— yesterday", overdue: true };
  if (days < 0) return { label: `— ${Math.abs(days)} days ago`, overdue: true };
  if (days < 7) return { label: `— in ${days} days`, overdue: false };
  if (days < 14) return { label: "— next week", overdue: false };
  return { label: `— in ${Math.round(days / 7)} weeks`, overdue: false };
}
