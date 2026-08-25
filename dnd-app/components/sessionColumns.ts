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
    editable: true,
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
    key: "description",
    label: "Description",
    kind: "longtext",
    defaultWidth: 360,
    defaultVisible: true,
    editable: true,
  },
];

export const SESSION_COLUMN_BY_KEY = new Map(
  SESSION_COLUMNS.map((c) => [c.key, c])
);

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

  if (key === "number" || key === "xp") {
    if (value === "") return key === "number" ? {} : { xp: null };
    const n = Number(value);
    if (!Number.isFinite(n)) return {};
    return { [key]: n };
  }

  return { [key]: value === "" ? null : value };
}
