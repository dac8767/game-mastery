/**
 * One description of every Sessions column, in the shape the NPC roster
 * and the Groups screen use — so the column picker, the filter panel,
 * the sort menu and the grid are the same code over a third list.
 *
 * The primary column is a NUMBER here, which is the one thing that
 * makes this list different from the other two. Everything downstream
 * that assumed a primary called "name" takes its default from
 * SESSION_DEFAULT_SORT instead.
 *
 * The `integrity` guard checks every `key` below against what
 * sessions.listForCampaign returns, so a renamed field cannot silently
 * become a column of blanks.
 */

import { ColumnDef } from "@/components/npcColumns";
// Relative, not "@/", because this one survives compilation. The line
// above is a TYPE import and tsc erases it; these are values, and the
// unit guard imports the emitted JavaScript, where "@/" is not a thing
// Node can resolve.
import { isActive, retiredPlayerIds, type Rostered } from "./rosterModel";

export const SESSION_COLUMNS: ColumnDef[] = [
  {
    key: "number",
    label: "Session #",
    kind: "number",
    // Stored as a number so it sorts as one — 10 after 9, not between
    // 1 and 2 — and READ as "Session 7", because a column of bare
    // digits under a heading is a column of row numbers.
    format: (raw) => `Session ${String(raw)}`,
    defaultWidth: 130,
    defaultVisible: true,
    /**
     * NOT editable in the list, alone among these columns — clicking
     * "Session 40" opens the session, because the label is the way in
     * everywhere else a list has a name. Renumbering happens inside
     * the record, where the same definition is rendered editable by
     * the facts row (SessionDetail passes isDm, not this flag).
     */
    editable: false,
  },
  {
    // Stored as "YYYY-MM-DD" text rather than a timestamp: it is the
    // day you played, which has no time and no timezone, and in that
    // format it sorts correctly as a string.
    key: "date",
    label: "Date",
    kind: "text",
    defaultWidth: 130,
    defaultVisible: true,
    editable: true,
  },
  {
    // Free text, and chips rather than one string: attendance is who
    // was in the room, which is not the campaign's membership rows. A
    // friend who dropped in for one night was never a member, and a
    // member who missed three sessions is still one.
    key: "players",
    label: "Players",
    kind: "chips",
    defaultWidth: 240,
    defaultVisible: true,
    editable: true,
  },
  {
    key: "xp",
    label: "XP Awarded",
    kind: "number",
    defaultWidth: 120,
    defaultVisible: true,
    editable: true,
  },
  {
    /**
     * The milestone campaign's answer to XP Awarded: the level the
     * party reached this session, or nothing for a night nobody
     * leveled. Declared here beside every other column, but only ever
     * OFFERED by sessionColumnsFor — a table shows this or xp, never
     * both, because the campaign levels one way or the other.
     *
     * Not list-editable: the value is picked from a dropdown whose
     * options depend on every OTHER session, and the record's facts
     * row is where that context lives.
     */
    key: "milestone",
    label: "Leveled Up To",
    kind: "level",
    format: (raw) => `Level ${String(raw)}`,
    defaultWidth: 140,
    defaultVisible: true,
    editable: false,
  },
  {
    key: "description",
    // Stored as `description`, called Summary. The word is what a
    // session has — a line about the night — and the field name is
    // what the row has been called since the table was made; renaming
    // the field would be a migration for a caption.
    label: "Summary",
    kind: "longtext",
    defaultWidth: 360,
    defaultVisible: true,
    editable: true,
  },
];

export const SESSION_COLUMN_BY_KEY = new Map(
  SESSION_COLUMNS.map((c) => [c.key, c])
);

/** How a campaign levels. Mirrors campaigns.leveling; absent is xp. */
export type Leveling = "xp" | "milestone";

/** What each mode is called where the GM has to choose one. */
export const LEVELING_MODES: { value: Leveling; label: string; note: string }[] =
  [
    {
      value: "xp",
      label: "XP",
      note: "Sessions carry an XP Awarded field.",
    },
    {
      value: "milestone",
      label: "Milestone",
      note: "Sessions carry a \u201cLeveled up to\u201d field instead.",
    },
  ];

/**
 * The columns a campaign's session list actually shows: everything,
 * minus whichever leveling field this campaign does not use. One
 * function rather than two lists, so a column added later cannot be
 * added to one mode and forgotten in the other.
 */
export function sessionColumnsFor(leveling: Leveling): ColumnDef[] {
  const drop = leveling === "milestone" ? "xp" : "milestone";
  return SESSION_COLUMNS.filter((c) => c.key !== drop);
}

/**
 * The levels this session may claim: 2 through 20, minus what the
 * campaign has already reached.
 *
 * Two subtractions, and they are different rules:
 *
 *   - a level any OTHER session records is taken. Two sessions cannot
 *     both be the night the party hit 7.
 *   - a level at or below the highest that an EARLIER session records
 *     is gone too — Derek's example: session 5 reached level 5, so
 *     every later session offers 6 through 20. Levels only go up.
 *
 * The session's OWN current value is always offered, or opening the
 * dropdown would hide the very thing it is set to.
 */
export function milestoneOptions(
  sessions: { number: number; milestone?: number | null }[],
  forNumber: number,
  current?: number | null
): number[] {
  const used = new Set<number>();
  let floor = 1;
  for (const s of sessions) {
    const m = s.milestone;
    if (typeof m !== "number") continue;
    if (s.number === forNumber) continue;
    used.add(m);
    if (s.number < forNumber) floor = Math.max(floor, m);
  }

  const out: number[] = [];
  for (let level = 2; level <= 20; level++) {
    if (level === current) {
      out.push(level);
      continue;
    }
    if (used.has(level) || level <= floor) continue;
    out.push(level);
  }
  return out;
}

/**
 * Fields offered as filters and as "group by" options.
 *
 * Players and nothing else. Grouping by session number would make every
 * section one row long, and by date very nearly so; "which sessions was
 * Ana at" is the question this list can actually answer by grouping,
 * and it works because a row appears under every value it holds.
 */
export const SESSION_FACET_KEYS = ["players"];

/** Sort keys that aren't columns. */
export const SESSION_EXTRA_SORTS = [
  { key: "_creationTime", label: "Date added" },
];

/** The one column that can't be hidden. */
export const SESSION_PRIMARY_COLUMN = "number";

/**
 * Newest first.
 *
 * The other two lists sort A→Z by name, which is the right default when
 * the list is a reference. A session log is a diary: the one you are
 * about to write up is the last one you played, and it should not be at
 * the bottom of a scroll.
 */
export const SESSION_DEFAULT_SORT = { key: "number", asc: false };

/**
 * What a typed cell becomes, on the way to updateSession.
 *
 * Here rather than in the screen because it is where the one genuinely
 * fiddly rule lives: `Number("")` is 0 and `Number("seven")` is NaN,
 * and either stored is worse than the edit not landing. A blank clears
 * an optional number; anything that is not a number at all patches
 * NOTHING, so the cell goes back to what it was rather than reading
 * "NaN" forever and sorting unpredictably.
 *
 * The session NUMBER is the exception to the clearing rule: it is not
 * optional, so a blank leaves it alone instead of removing the field
 * the row is identified by.
 */
export function sessionPatch(
  key: string,
  text: string
): Record<string, unknown> {
  const value = text.trim();

  if (key === "players") {
    return {
      players: value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    };
  }

  if (key === "number" || key === "xp" || key === "milestone") {
    if (value === "") return key === "number" ? {} : { [key]: null };
    const n = Number(value);
    if (!Number.isFinite(n)) return {};
    return { [key]: n };
  }

  return { [key]: value === "" ? null : value };
}

/**
 * Everyone the app knows plays in this campaign, for the attendance
 * field to offer.
 *
 * Two sources, because neither alone is the answer. `members` are the
 * accounts in the campaign, which misses the friend who has a character
 * and never signed up; `characters` carry a `playerName` typed by the
 * GM, which misses the member who has not made one yet. The union is
 * the table.
 *
 * Free text stays free: this is a list of OPTIONS, not a set of allowed
 * values. A guest who played one night is still attendance, and a field
 * that refused them would be worse than the one that made you type
 * everybody.
 *
 * Anybody the GM has marked inactive is left out of both sources. That
 * is what the flag is for — the person who left at session 30 should
 * not be the first suggestion when you write up session 60 — and it is
 * only the SUGGESTIONS that lose them. A name already typed on a past
 * session stays typed, because the field is free text and this list
 * never validated it.
 */
export function campaignPlayers(
  members: { userId?: string | null; displayName?: string | null }[] | null | undefined,
  characters: Rostered[] | null | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  const retired = retiredPlayerIds(characters);
  for (const m of members ?? []) {
    if (m.userId && retired.has(m.userId)) continue;
    add(m.displayName);
  }
  for (const c of characters ?? []) {
    if (!isActive(c)) continue;
    add(c.playerName);
  }

  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * A chips field's value as a list, and back again.
 *
 * The stored shape is an array; the input's shape is a comma-separated
 * line. Toggling one name off a line of five is where the two have to
 * agree exactly, so both directions live here rather than being written
 * out at the call site.
 */
export function chipsFromInput(text: string): string[] {
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Add a name to a chips line, or take it off if it is already there. */
export function toggleChip(text: string, name: string): string {
  const list = chipsFromInput(text);
  const key = name.trim().toLowerCase();
  const without = list.filter((v) => v.toLowerCase() !== key);
  // Removing is the whole change when it was there; otherwise append,
  // so the order somebody typed is not reshuffled by a click.
  return (without.length === list.length ? [...list, name.trim()] : without)
    .join(", ");
}
