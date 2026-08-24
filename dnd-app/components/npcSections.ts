/**
 * How an NPC's thirty-odd fields are arranged when you open one.
 *
 * The grid shows whatever columns you picked, in whatever order you
 * dragged them into. The record is the opposite: a fixed arrangement
 * that reads the same for every NPC, so "where does it say their age"
 * has one answer rather than one per saved layout.
 *
 * Grouping is editorial, not derived. Nothing in the field definitions
 * says that `region` and `kingdom` belong beside `place` — they belong
 * there because that is how a person thinks about where someone is. So
 * the arrangement is written down, and the integrity guard holds it
 * against the column list rather than the other way round.
 *
 * Free of React and Convex, and of sibling imports, so the unit guard
 * can compile it alone: `@/` path mapping is compile-time only, and an
 * imported sibling would leave an unresolvable specifier in the emitted
 * JS. The cost is that the keys are stated here and in npcColumns.ts;
 * the guard is what makes two copies safe.
 */

export interface NpcSection {
  id: string;
  title: string;
  /** Why these belong together, when it isn't obvious from the title. */
  blurb?: string;
  keys: string[];
}

/**
 * Shown in the record's header rather than in a section: these are how
 * you know WHO you are looking at, and repeating them in a field list
 * below their own heading would be saying it twice.
 */
export const HEADER_KEYS = ["portraitPath", "name", "nickname"];

/**
 * Fields the record renders in a fixed place, outside the tabs.
 *
 * Notes are the reason the record is split in two: you read the fields
 * and write in the notes, usually at the same time, and putting the
 * notes behind a tab means losing your place to check somebody's age.
 * They get a rail of their own that every tab is read beside.
 *
 * `hidden` is not a fact about the NPC the way the other fields are —
 * it is a switch about who may see them at all — so it belongs with
 * the name rather than in a list of attributes.
 */
/**
 * The notes rail's own fields, pinned out of the arrangeable tabs.
 *
 * `dmNotes` used to be here too, and that is what put two DM Notes on
 * the record: this pinned FIELD, and the DM notes THREAD beside it.
 * The thread won — it says who wrote what and when, where the field
 * was one box everybody overwrote — so the field is no longer placed
 * anywhere, and npcs.migrateDmNotes moves what was in it.
 */
export const NOTES_KEYS = ["playerNotes"];
export const PINNED_KEYS = ["hidden", ...NOTES_KEYS];

/**
 * Read under the name as a one-line summary — the three facts you would
 * say out loud introducing them. Rendered as chips, skipped when empty.
 */
export const SUMMARY_KEYS = ["job", "species", "place"];

/**
 * Where an unplaced field goes.
 *
 * A column added to npcColumns.ts and not named below still appears,
 * at the end, under this heading. The guard will tell you to place it
 * properly; until you do it is visible and editable rather than
 * silently missing from every record in the campaign.
 */
export const MORE_SECTION: NpcSection = {
  id: "more",
  title: "More",
  blurb: "Fields that have not been given a home yet.",
  keys: [],
};

export const NPC_SECTIONS: NpcSection[] = [
  {
    id: "identity",
    title: "Name",
    blurb: "The parts their full name is built from.",
    keys: ["prefix", "first", "middle", "family", "suffix", "noLastName"],
  },
  {
    id: "person",
    title: "Person",
    keys: ["species", "lineage", "gender", "sexuality", "alignment", "voice"],
  },
  {
    id: "age",
    title: "Age",
    blurb:
      "Starting and maximum age are the species' range, not this person's.",
    keys: ["age", "maturity", "startingAge", "maxAge"],
  },
  {
    id: "description",
    title: "Description",
    blurb: "What the table sees, hears, and remembers them for.",
    keys: ["description", "quirkPhysical", "quirkMental", "abilities"],
  },
  {
    id: "ties",
    title: "Ties",
    keys: ["familyMembers", "familyMemberCount", "groups"],
  },
  {
    id: "where",
    title: "Where they are",
    keys: ["place", "region", "kingdom"],
  },
  {
    id: "standing",
    title: "Standing",
    blurb: "What they do, how they are doing, and what they are after.",
    keys: ["job", "status", "politics", "wantsNeeds"],
  },
  {
    id: "dm",
    title: "DM only",
    blurb: "Never sent to a player — the server withholds these entirely.",
    keys: ["secret"],
  },
];

/** Every key the arrangement names, header and summary included. */
export function placedKeys(): string[] {
  return [
    ...HEADER_KEYS,
    ...PINNED_KEYS,
    ...NPC_SECTIONS.flatMap((s) => s.keys),
  ];
}

/**
 * The sections to render, given the keys this viewer may see.
 *
 * Takes the permitted keys rather than deciding permission itself: who
 * may see `dmNotes` is settled on the server, and a second opinion here
 * could only ever disagree with it.
 *
 * Empty sections are dropped — a player has no DM-only fields, and an
 * empty "DM only" heading would advertise exactly what it is hiding.
 */
export function arrange(allowed: string[]): NpcSection[] {
  const permitted = new Set(allowed);
  const out: NpcSection[] = [];

  for (const section of NPC_SECTIONS) {
    const keys = section.keys.filter((k) => permitted.has(k));
    if (keys.length > 0) out.push({ ...section, keys });
  }

  // Anything the arrangement does not name, in the order it was given,
  // minus what the header already shows.
  const named = new Set(placedKeys());
  const leftover = allowed.filter((k) => !named.has(k));
  if (leftover.length > 0) out.push({ ...MORE_SECTION, keys: leftover });

  return out;
}
