/**
 * One description of every Groups column, in the same shape the NPC
 * roster's columns use — so the column picker, the filter panel, the
 * sort menu and the grid are all literally the same code over a
 * different list.
 *
 * Three of these five fields are DERIVED, not stored: `members`,
 * `memberCount` and `attachments` are computed by
 * groups.listForCampaign out of the roster and out of storage. They are
 * marked `editable: false` for that reason and it is not a formality —
 * an editable derived column would let you type into a cell, save
 * nothing anywhere, and watch your edit disappear on the next
 * subscription update. Membership is changed on the NPC, which is where
 * the field actually is.
 *
 * The `integrity` guard checks every `key` below against what
 * groups.listForCampaign returns, so a renamed field cannot silently
 * become a column of blanks.
 */

import { ColumnDef } from "@/components/npcColumns";

export const GROUP_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name", kind: "text", defaultWidth: 200, defaultVisible: true, editable: true },
  {
    key: "description",
    label: "Description",
    kind: "longtext",
    defaultWidth: 320,
    defaultVisible: true,
    editable: true,
  },
  {
    key: "members",
    label: "NPCs",
    kind: "chips",
    defaultWidth: 300,
    defaultVisible: true,
    // Read out of the roster, so this is where each name goes back to.
    linksTo: "npc",
    namesNpcs: true,
  },
  {
    key: "memberCount",
    label: "NPC Count",
    kind: "number",
    defaultWidth: 110,
    defaultVisible: true,
  },
  {
    key: "attachments",
    label: "Attachments",
    kind: "picture",
    defaultWidth: 140,
    defaultVisible: true,
    sortable: false,
  },
];

export const GROUP_COLUMN_BY_KEY = new Map(
  GROUP_COLUMNS.map((c) => [c.key, c])
);

/**
 * Fields offered as filters and as "group by" options.
 *
 * `members` and not `name`: grouping a list of groups BY group name
 * would put every row in a section of its own. Grouping by NPC is the
 * question worth asking — "which groups is Kelja in" — and it works
 * because a row appears under every value it holds.
 */
export const GROUP_FACET_KEYS = ["members"];

/**
 * No extra sort keys.
 *
 * The roster offers "Date added", which it can because every NPC is a
 * document with a creation time. Half the rows here are not documents
 * at all — a group nobody has written up exists only as a name on some
 * NPCs — so "Date added" would sort the described ones and leave the
 * rest in an arbitrary heap below them.
 */
export const GROUP_EXTRA_SORTS: { key: string; label: string }[] = [];

/** Every column's key: what the search box reads. */
export const GROUP_SEARCHED_KEYS = GROUP_COLUMNS.map((c) => c.key);

/** The one column that can't be hidden. */
export const GROUP_PRIMARY_COLUMN = "name";
