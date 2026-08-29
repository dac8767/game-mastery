// Relative, not "@/": convex/todo.ts imports this module, and the
// Convex tsconfig does not carry the app's path alias.
import {
  MAX_TASK_LABELS,
  MAX_TEXT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  addDays,
  cleanTitle,
  isDate,
} from "./todoModel";

/**
 * Quick Add Magic — Vikunja's one genuinely great idea, ported.
 *
 * You type the task and its properties in the same breath:
 *
 *   statblock for the lich tomorrow *combat !4 +'Session prep'
 *
 * and get a task called "statblock for the lich", due tomorrow,
 * labelled combat, priority Urgent, filed under Session prep.
 *
 * The quotes round the project are not decoration: a bare token ends at
 * the first space, so `+Session prep` files it under "Session" and
 * leaves "prep" in the task. Vikunja works the same way, and the field
 * shows you what it understood before you commit — which is the only
 * honest answer to a syntax that eats words. The value
 * is not the keystrokes saved; it is that setting a due date never
 * becomes a second action you decide to skip, so the dates on this list
 * are actually there.
 *
 * ── the syntax ───────────────────────────────────────────────────────
 *   *label        a label. Repeatable. *'two words' for a name with a
 *                 space in it.
 *   +project      the project to file it under. +'Session prep'.
 *   !1 .. !5      priority, Vikunja's scale.
 *   a date        in plain words — see DATE PATTERNS below.
 *
 * ── what is deliberately not here ────────────────────────────────────
 *   @assignee     Vikunja assigns tasks to people. This list has one
 *                 reader.
 *   17/02/2021    numeric day/month dates are AMBIGUOUS — 3/9 is the
 *                 third of September to half the world and the ninth of
 *                 March to the other half, and Vikunja resolves it by
 *                 guessing from your locale. A prep task silently due
 *                 six months late is exactly the quiet wrong this app
 *                 spends its guard suite avoiding, so the only numeric
 *                 form accepted is the unambiguous one, 2026-09-01.
 *                 "sep 3" and "3 sep" cover the rest.
 *
 * ── purity ───────────────────────────────────────────────────────────
 * Every function here takes `today` as an ISO string and does string
 * arithmetic on it. No `new Date()` anywhere in the parsing path, so
 * the whole module is testable at any date and cannot be off by one for
 * anyone west of UTC — which the sandbox these tests run in could never
 * have caught, since it is UTC itself.
 */

export interface QuickAdd {
  /** The task, with every token and the date taken out of it. */
  text: string;
  /** "YYYY-MM-DD", or null when nothing in the line named a day. */
  due: string | null;
  priority: number | null;
  /** Label NAMES, in the order typed, deduplicated case-insensitively. */
  labels: string[];
  /** Project NAME. The last one typed wins — a task is in one list. */
  project: string | null;
  /**
   * What was eaten, so the field can show it.
   *
   * The cost of magic is that "buy the tomorrow paper" loses a word to
   * a date, and Vikunja's answer — the only honest one — is to show
   * what it understood before you commit. This is what that reads from.
   */
  matched: QuickMatch[];
}

export interface QuickMatch {
  kind: "due" | "priority" | "label" | "project";
  /** The literal text that was consumed. */
  token: string;
  /** How it was read: the date, the number, the name. */
  value: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/* ---------------------------------------------------------------- */
/* Date arithmetic, all of it on "YYYY-MM-DD" strings                 */
/* ---------------------------------------------------------------- */

/** 0 = Sunday, matching WEEKDAYS. Built in UTC, so it cannot shift. */
export function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The next `weekday` strictly after `today`.
 *
 * Strictly: asking for "monday" on a Monday means the one coming, not
 * the one you are standing in. A task you are typing on Monday morning
 * that is due "monday" is due today, and you would have typed "today".
 */
export function nextWeekday(today: string, weekday: number): string {
  const ahead = (weekday - dayOfWeek(today) + 7) % 7;
  return addDays(today, ahead === 0 ? 7 : ahead);
}

/**
 * `months` after an ISO date, with the day clamped to the target month.
 *
 * "next month" on the 31st of January is the 28th of February, not the
 * 3rd of March — which is what the obvious implementation gives you,
 * because a Date rolls over rather than clamping.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const day = Math.min(d, last);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The last day of the month `iso` falls in. */
export function endOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/**
 * A day and a month, in whichever year makes it the NEXT one.
 *
 * "sep 3" typed in October means next September. Typed in August it
 * means this one. Rolling forward is the only reading that is ever
 * useful on a to-do list — nobody schedules prep for a date that has
 * already gone.
 */
export function monthDay(today: string, month: number, day: number): string | null {
  const from = Number(today.slice(0, 4));
  // Forward only, and over several years rather than one. Several,
  // because of the 29th of February: typed in 2027 it means 2028, and
  // a one-year-lookahead returns nothing at all for the one date in
  // the calendar that needs the search. Four is enough — leap years
  // are never further apart than that.
  for (let y = from; y <= from + 4; y++) {
    const at = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // A real day, and one that has not gone. "sep 3" in October is
    // next September; nobody schedules prep for a date already past.
    if (isDate(at) && at >= today) return at;
  }
  return null;
}

/**
 * The alternation for a month name: the whole word, or any prefix of it
 * three letters or longer, longest first.
 *
 * Three-and-four both, because "sept" is how people write September and
 * a three-letter-only list matched its first three and then choked on
 * the "t". Longest first matters in a regex alternation: with "sep"
 * ahead of "sept", the engine takes the short one and leaves a stray
 * letter behind.
 */
const MONTH_ALT = MONTHS.flatMap((m) => {
  const forms = [m, m.slice(0, 4), m.slice(0, 3)];
  return [...new Set(forms)];
})
  .sort((a, b) => b.length - a.length)
  .join("|");

/* ---------------------------------------------------------------- */
/* The parse                                                          */
/* ---------------------------------------------------------------- */

/**
 * DATE PATTERNS, in the order they are tried.
 *
 * Order matters where one phrase contains another: "next week" has to
 * be tried before the bare weekday rule could take "week" for nothing,
 * and "in 2 weeks" before "next week" so the longer phrase wins its own
 * words. Each entry is matched with word boundaries against the line
 * that is LEFT after the *, + and ! tokens have been taken out, so a
 * label called *tomorrow cannot become a due date.
 */
interface DatePattern {
  re: RegExp;
  read: (m: RegExpMatchArray, today: string) => string | null;
}

const DATE_PATTERNS: DatePattern[] = [
  // The explicit form, and the only numeric one. See the header.
  {
    re: /\b(\d{4}-\d{2}-\d{2})\b/i,
    read: (m) => (isDate(m[1]) ? m[1] : null),
  },
  { re: /\b(today|tonight)\b/i, read: (_m, today) => today },
  { re: /\btomorrow\b/i, read: (_m, today) => addDays(today, 1) },
  {
    re: /\bin (\d{1,3}) (day|days|week|weeks|month|months)\b/i,
    read: (m, today) => {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (unit.startsWith("day")) return addDays(today, n);
      if (unit.startsWith("week")) return addDays(today, n * 7);
      return addMonths(today, n);
    },
  },
  { re: /\bend of (?:the )?month\b/i, read: (_m, today) => endOfMonth(today) },
  { re: /\bnext week\b/i, read: (_m, today) => addDays(today, 7) },
  { re: /\bnext month\b/i, read: (_m, today) => addMonths(today, 1) },
  // The weekend is Saturday. "This weekend" on a Saturday is today.
  {
    re: /\b(?:this )?weekend\b/i,
    read: (_m, today) => (dayOfWeek(today) === 6 ? today : nextWeekday(today, 6)),
  },
  // A weekday, with or without "next" — they mean the same thing, which
  // is what nextWeekday's strictly-after rule is for.
  {
    re: new RegExp(
      `\\b(?:next |on )?(${WEEKDAYS.map((d) => `${d}|${d.slice(0, 3)}`).join("|")})\\b`,
      "i"
    ),
    read: (m, today) => {
      const word = m[1].toLowerCase();
      const idx = WEEKDAYS.findIndex((d) => d === word || d.slice(0, 3) === word);
      return idx === -1 ? null : nextWeekday(today, idx);
    },
  },
  // "sep 3" and "3 sep", either way round, month names or abbreviations.
  {
    re: new RegExp(
      `\\b(${MONTH_ALT})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`,
      "i"
    ),
    read: (m, today) => {
      const idx = monthIndex(m[1]);
      return idx === -1 ? null : monthDay(today, idx + 1, Number(m[2]));
    },
  },
  {
    re: new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_ALT})\\b`,
      "i"
    ),
    read: (m, today) => {
      const idx = monthIndex(m[2]);
      return idx === -1 ? null : monthDay(today, idx + 1, Number(m[1]));
    },
  },
];

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
}

/**
 * A `*label`, `+project` or `!3` token.
 *
 * The quoted form takes everything to the closing quote, which is how a
 * name with a space in it survives; the bare form stops at whitespace.
 * Both are anchored on a boundary before the sigil, so an asterisk in
 * the middle of a word — "5*d6" — is not a label.
 */
const TOKEN =
  /(^|\s)([*+!])(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/g;

/**
 * The line, read.
 *
 * `today` is passed in rather than read from the clock: every date this
 * returns is relative to it, and a caller that forgets is a caller
 * whose tests could not have been written.
 */
export function parseQuickAdd(raw: string, today: string): QuickAdd {
  const matched: QuickMatch[] = [];
  const labels: string[] = [];
  const seenLabel = new Set<string>();
  let priority: number | null = null;
  let project: string | null = null;

  // Tokens first. What is left is prose, and only prose is searched
  // for a date — so a label called *friday stays a label.
  const withoutTokens = raw.replace(
    TOKEN,
    (whole, lead: string, sigil: string, q1, q2, bare) => {
      const value = String(q1 ?? q2 ?? bare ?? "");
      const token = whole.slice(lead.length);

      if (sigil === "!") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) {
          // Not a priority — "!!" or "!soon". Left in the text rather
          // than swallowed, because eating something you did not
          // understand is how a task loses a word with no trace.
          return whole;
        }
        priority = n;
        matched.push({ kind: "priority", token, value: String(n) });
        return lead;
      }

      const name = cleanTitle(value);
      if (name === "") return whole;

      if (sigil === "+") {
        project = name;
        matched.push({ kind: "project", token, value: name });
        return lead;
      }

      const key = name.toLowerCase();
      if (!seenLabel.has(key) && labels.length < MAX_TASK_LABELS) {
        seenLabel.add(key);
        labels.push(name);
        matched.push({ kind: "label", token, value: name });
      }
      return lead;
    }
  );

  // The date: the FIRST pattern that both matches and reads as a real
  // day. A line naming two is a line whose second date is prose.
  let text = withoutTokens;
  let due: string | null = null;
  for (const pattern of DATE_PATTERNS) {
    const m = text.match(pattern.re);
    if (!m) continue;
    const value = pattern.read(m, today);
    // The isDate half is the BACKSTOP, and it is deliberately doubled
    // up with monthDay's own check: either one alone keeps "feb 30" out
    // of the due field, so a mutation removing just one of them passes
    // the tests. Removing BOTH does not — which is the shape this
    // wants, because the pattern added here next is the one that
    // forgets, and a task quietly due on a day that does not exist is
    // worse than a task with no date.
    if (!value || !isDate(value)) continue;
    due = value;
    matched.push({ kind: "due", token: m[0].trim(), value });
    text = text.slice(0, m.index) + " " + text.slice((m.index ?? 0) + m[0].length);
    break;
  }

  return {
    text: text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT),
    due,
    priority,
    labels,
    project,
    matched,
  };
}
