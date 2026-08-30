// Relative, not "@/": convex/todo.ts imports this module, and the
// Convex tsconfig does not carry the app's path alias.
import { safeBoxHref } from "./boxHtml";

/**
 * The GM's prep list: ordering, and what a due date means today.
 *
 * Pure arithmetic and string comparison — no React, no Convex — because
 * both halves fail quietly. A reorder that puts an item back where it
 * was looks like a missed click rather than a bug, and a due date that
 * is off by one calls tomorrow's task overdue, which trains you to stop
 * believing the colour. Neither shows up in a screenshot.
 */

/**
 * The gap left between neighbouring items.
 *
 * Items carry a sort key rather than an index, so moving one rewrites
 * ONE row instead of renumbering the list. A thousand is room for about
 * ten inserts between any two items before the midpoints get too close
 * to split, which is what `needsRenumber` is for.
 */
export const ORDER_GAP = 1000;

/**
 * How close two keys may get before splitting them again is pointless.
 *
 * Not floating-point epsilon — a practical floor. Below this the
 * midpoints are still distinct numbers but the list is one insert away
 * from two items that cannot be told apart, and a renumber now is
 * cheaper than a silent tie later.
 */
export const ORDER_FLOOR = 0.0005;

export interface Orderable {
  order: number;
}

/** The key for a new item at the top of the list. */
export function orderBefore(first: number | undefined): number {
  return first === undefined ? ORDER_GAP : first - ORDER_GAP;
}

/** The key for a new item at the bottom. */
export function orderAfter(last: number | undefined): number {
  return last === undefined ? ORDER_GAP : last + ORDER_GAP;
}

/**
 * A key between two others.
 *
 * Either side may be absent, which is what dropping at the very top or
 * the very bottom means — so this is also the general "put it here"
 * answer, not only the middle case.
 */
export function orderBetween(
  before: number | undefined,
  after: number | undefined
): number {
  if (before === undefined && after === undefined) return ORDER_GAP;
  if (before === undefined) return orderBefore(after);
  if (after === undefined) return orderAfter(before);
  return (before + after) / 2;
}

/**
 * True when the gap being split has run out of room.
 *
 * The caller renumbers the whole list when this says so. It is rare —
 * ten or so inserts into the same gap — and the alternative is two
 * items with equal keys, which sort by whatever the database felt like
 * and reorder themselves when you are not looking.
 */
export function needsRenumber(
  before: number | undefined,
  after: number | undefined
): boolean {
  if (before === undefined || after === undefined) return false;
  return Math.abs(after - before) < ORDER_FLOOR;
}

/** Evenly spaced keys for a list that has been squeezed flat. */
export function renumber<T extends Orderable>(items: readonly T[]): T[] {
  return items.map((item, i) => ({ ...item, order: (i + 1) * ORDER_GAP }));
}

/**
 * A list moved into the order a drag asked for.
 *
 * Takes the ids rather than indices, because the list the UI dragged in
 * is the SORTED one and the array the caller holds may not be. Returns
 * only the rows whose key changed — moving one item should not write
 * every row.
 */
export function reorderTo<T extends Orderable & { _id: string }>(
  items: readonly T[],
  movedId: string,
  toIndex: number
): { _id: string; order: number }[] {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const from = sorted.findIndex((i) => i._id === movedId);
  if (from === -1) return [];

  const target = Math.min(Math.max(Math.round(toIndex), 0), sorted.length - 1);
  if (target === from) return [];

  const without = sorted.filter((i) => i._id !== movedId);
  const before = without[target - 1]?.order;
  const after = without[target]?.order;

  // Out of room: rewrite the whole list once rather than create a tie.
  if (needsRenumber(before, after)) {
    const next = [...without];
    next.splice(target, 0, sorted[from]);
    return renumber(next).map((i) => ({ _id: i._id, order: i.order }));
  }
  return [{ _id: movedId, order: orderBetween(before, after) }];
}

/**
 * The list as it is read: open items in their own order, done ones
 * beneath in the order they were finished, newest first.
 *
 * Done items sink rather than vanish. A prep list you have worked
 * through is a record of what you did, and hiding it the moment it is
 * ticked makes the tool feel like it forgot.
 */
export function sortTodos<
  // `doneAt` may be null, not merely absent: the queries in this app
  // answer `?? null` for an unset optional, and a model that only
  // accepted `undefined` would force the query to break that habit for
  // one field.
  T extends Orderable & { done: boolean; doneAt?: number | null },
>(items: readonly T[]): T[] {
  const open = items.filter((i) => !i.done).sort((a, b) => a.order - b.order);
  const done = items
    .filter((i) => i.done)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return [...open, ...done];
}

export type DueState = "overdue" | "today" | "soon" | "later";

/**
 * How a due date reads against a given day.
 *
 * Both dates are "YYYY-MM-DD" and compared as STRINGS, which is the
 * whole trick: that format sorts lexicographically in date order, so
 * this needs no Date object and therefore has no timezone. Parsing
 * "2026-09-01" into a Date and comparing it to `new Date()` is how a
 * task becomes overdue an evening early for anyone west of UTC — and
 * Derek's table plays at night.
 *
 * "soon" is within a week, which is roughly one session away.
 */
export function dueState(
  due: string | undefined | null,
  today: string
): DueState | null {
  if (!due || !isDate(due) || !isDate(today)) return null;
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, 7) ? "soon" : "later";
}

/**
 * How far off a due date is, in words. Vikunja's phrasing.
 *
 * "Due in 2 days", "Due 4 days ago" — a relative reading rather than a
 * pill saying "Overdue", because the two facts a prep list needs from a
 * date are which side of today it falls and HOW FAR. "Overdue" is the
 * same word for a thing you missed yesterday and a thing you missed in
 * March, and the second one wants noticing more.
 *
 * Days apart, computed by walking the string arithmetic rather than
 * subtracting two Dates — same reason as everything else in this file.
 * Weeks and months once the day count stops being readable; nobody
 * counts "in 47 days".
 */
export function relativeDue(
  due: string | null | undefined,
  today: string
): string | null {
  if (!due || !isDate(due) || !isDate(today)) return null;
  const days = daysBetween(today, due);

  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days === -1) return "Due yesterday";

  const ahead = days > 0;
  const n = Math.abs(days);
  const span =
    n < 14
      ? `${n} days`
      : n < 60
        ? `${Math.round(n / 7)} weeks`
        : `${Math.round(n / 30)} months`;
  return ahead ? `Due in ${span}` : `Due ${span} ago`;
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier.
 *
 * Both built at UTC midnight, so the difference is an exact number of
 * 86,400,000ms with no daylight-saving hour to round wrongly — the
 * classic way a "days between" helper returns 1.958 and floors to the
 * wrong answer twice a year.
 *
 * The UTC and the ROUND are a deliberate pair, and each covers for the
 * other: UTC makes the difference exact so the rounding never matters,
 * and rounding absorbs the missing hour if the UTC ever goes. Either
 * one alone is correct, which is why a mutation removing just one of
 * them passes the tests — removing both does not, and it is the
 * timezone run that catches it. Do not "simplify" one away.
 */
export function daysBetween(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86400000);
}

/** "YYYY-MM-DD", and a real date rather than merely the right shape. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // Month lengths, leap years included — "2026-02-30" has the right
  // shape and is not a day.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * `days` after an ISO date, as an ISO date.
 *
 * Built in UTC deliberately. A local-time Date shifts the day for half
 * the world, and this is only ever used to compare one calendar day
 * against another.
 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

/** Today where the reader is sitting, as "YYYY-MM-DD". */
export function todayISO(now: Date = new Date()): string {
  // Local parts, not toISOString: at 9pm in New York the UTC date is
  // already tomorrow, and "today" on a prep list means the day the
  // person reading it is having.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The longest a task may be. Past this it is a note, not a task. */
export const MAX_TEXT = 300;
export const MAX_NOTES = 2000;

/* ---------------------------------------------------------------- */
/* Links: where an item came from                                     */
/* ---------------------------------------------------------------- */

/**
 * A link back to whatever produced this item.
 *
 * The point of the tool, eventually: highlight a line in a session's
 * notes, tag it as a to-do, and the item carries a way back to the
 * sentence that caused it. A task you cannot trace is a task you
 * rewrite from memory.
 *
 * `tool` is the nav item's id — "sessions", "npcs" — which is what
 * names the source on screen and groups links from one place. `href`
 * is where clicking goes.
 */
export interface TodoLink {
  tool: string;
  label: string;
  href: string;
}

/** Past this an item is a hub, not a task. */
export const MAX_LINKS = 8;
export const MAX_LINK_LABEL = 80;

/**
 * Links, cleaned and deduplicated.
 *
 * Every href goes through `safeHref`, which is the app's one rule for
 * an internal link — the same one the notebook's pasted HTML uses.
 * These arrive from OTHER TOOLS rather than from a person typing, so
 * the temptation is to trust them; a tool with a bug is exactly as
 * capable of writing "javascript:" into a field as a person is.
 *
 * Deduplicated by href, because tagging the same sentence twice is a
 * thing that happens and two identical chips are not information.
 */
export function normalizeLinks(
  links: readonly Partial<TodoLink>[] | undefined
): TodoLink[] {
  if (!Array.isArray(links)) return [];

  const out: TodoLink[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const href = safeHref(String(link?.href ?? ""));
    if (href === null || seen.has(href)) continue;

    const tool = String(link?.tool ?? "").trim().slice(0, 40);
    const label = String(link?.label ?? "").trim().slice(0, MAX_LINK_LABEL);
    // A chip with no words is a chip nobody can aim at.
    if (label === "") continue;

    seen.add(href);
    out.push({ tool, label, href });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * An internal link, or null.
 *
 * Kept identical to boxHtml's safeBoxHref on purpose — and imported
 * from it rather than restated, so there is ONE answer in this app to
 * "is this a link we will follow" and it cannot drift into two.
 */
export function safeHref(raw: string): string | null {
  return safeBoxHref(raw);
}

/* ---------------------------------------------------------------- */
/* Projects, labels and priority — the Vikunja shape                  */
/* ---------------------------------------------------------------- */

/**
 * The colours a project or a label may be, by NAME.
 *
 * A palette rather than a colour picker, and an id rather than a hex
 * string, for two reasons that both matter. The design one: eight
 * colours chosen against this app's dark ground stay a set, and a free
 * picker produces one label nobody can read on the third try. The other
 * one: the stored value ends up in a `style`, so it has to be something
 * the client looks UP — an arbitrary string in that position is a hole
 * with a CSS shape, and "it came from our own database" is exactly the
 * assurance that stops being true the first time a tool writes to it.
 */
export const TODO_COLORS: Record<string, string> = {
  amber: "#c9a227",
  rust: "#c2683c",
  blood: "#b1493f",
  plum: "#8f5f9e",
  ink: "#5a6fa8",
  teal: "#3f8f89",
  sage: "#6f9455",
  stone: "#8a8175",
};

export const TODO_COLOR_IDS = Object.keys(TODO_COLORS);

/** The default. First, not random: a new label should look decided. */
export const DEFAULT_COLOR = "stone";

/**
 * The hex for a palette id, or the default's.
 *
 * Never throws and never returns the id it was given. A row written
 * before a colour was removed from the palette, or by something that
 * guessed, renders in the default rather than putting an unknown
 * string into a style attribute.
 */
export function colorOf(id: string | null | undefined): string {
  // Through isColorId, NOT `TODO_COLORS[id] ?? default`. That form
  // reaches Object.prototype, so colorOf("toString") returned a
  // FUNCTION — truthy, so the ?? never fired — and React would have
  // stringified it into the style attribute. Its own unit check found
  // this; nothing else would have.
  return isColorId(id)
    ? TODO_COLORS[id as string]
    : TODO_COLORS[DEFAULT_COLOR];
}

/** True for a palette id this app actually has. */
export function isColorId(id: unknown): boolean {
  // hasOwnProperty through Object.prototype rather than Object.hasOwn:
  // the Convex tsconfig's lib is ES2021 and does not have the latter.
  // Own properties only, so "toString" is not a colour.
  return (
    typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(TODO_COLORS, id)
  );
}

/**
 * Vikunja's priority scale, and its rule about showing it.
 *
 * 1–5 with 0/absent meaning unset. Only HIGH and above is drawn on a
 * row, which is the whole point of a five-point scale you can ignore:
 * a list where every item wears a badge has told you nothing, and the
 * two that are actually urgent are the two worth marking.
 */
export const PRIORITY_LABELS: Record<number, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Urgent",
  5: "DO NOW",
};

export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 5;
/** At or above this, the row says so. Below it, the field is private. */
export const PRIORITY_SHOWN = 3;

/** A priority as stored: 1–5, or undefined for unset. */
export function cleanPriority(value: unknown): number | undefined {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) {
    return undefined;
  }
  return n;
}

/** Shown on the row? Vikunja's rule, in one place. */
export function showsPriority(priority: number | null | undefined): boolean {
  return typeof priority === "number" && priority >= PRIORITY_SHOWN;
}

/** A project or label name, trimmed to something a chip can hold. */
export const MAX_TITLE = 60;
/** More than this and the sidebar is a filing system, not a prep list. */
export const MAX_PROJECTS = 40;
export const MAX_LABELS = 60;
/** Past this a task is a category. Vikunja caps nothing; a row does. */
export const MAX_TASK_LABELS = 8;

export function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

/**
 * Matching a name the way a person means it.
 *
 * Quick-add resolves "*Combat" against a label called "combat", and a
 * second label differing only in case is not a second label. Case and
 * runs of whitespace are the two ways the same name gets typed
 * differently; nothing else is folded, because "NPCs" and "NPC" ARE
 * two labels.
 */
export function nameKey(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}
