/**
 * Links from a session's notes to the things the campaign is about.
 *
 * A note that says "Bruno took the deal" and a roster that says who
 * Bruno is are two screens with nothing between them. These are the
 * something: a name in the notes that goes to the record.
 *
 * The link is an app ROUTE, not an id. Every screen this points at
 * already takes `?open=<name>` — the NPC list, Locations, Groups, the
 * Lookup tabs — because those parameters were built for chips in the
 * NPC grid, which are free text somebody typed into Airtable. So a link
 * to a renamed NPC lands on the roster rather than on an error, which
 * is the same forgiving behaviour every other link in the app has.
 *
 * Free of React and Convex so the unit guard can compile it alone, and
 * so the sanitiser's idea of a valid route and this one's cannot drift.
 */

/** What a note can point at. */
export type LinkKind = "npc" | "location" | "group" | "species";

export interface LinkTarget {
  kind: LinkKind;
  name: string;
}

/** What each kind is called where somebody has to choose between them. */
export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  npc: "NPC",
  location: "Location",
  group: "Group",
  species: "Species",
};

/**
 * The route a link of each kind goes to.
 *
 * Named per kind rather than reached by a ternary's else-branch — the
 * same mistake the NPC grid's openLink made once, where every kind it
 * did not name went somewhere plausible and wrong.
 */
export function linkHref(
  campaignId: string,
  kind: LinkKind,
  name: string
): string | null {
  const value = name.replace(/\s+/g, " ").trim();
  if (!campaignId || !value) return null;
  const open = encodeURIComponent(value);

  const path =
    kind === "npc"
      ? `npcs?open=${open}`
      : kind === "location"
        ? `locations?open=${open}`
        : kind === "group"
          ? `groups?open=${open}`
          : kind === "species"
            ? `lookup?tab=species&open=${open}`
            : null;

  return path === null ? null : `/campaign/${campaignId}/${path}`;
}

const escapeText = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * The anchor a picked target becomes.
 *
 * Escaped here as well as sanitised on the way in. Not belt and
 * braces: this string is handed to `insertHTML`, so an unescaped `<`
 * in an NPC's name would become a tag in the box the moment it was
 * inserted — before any mutation had a chance to rebuild it.
 */
export function linkHtml(
  campaignId: string,
  target: LinkTarget
): string | null {
  const href = linkHref(campaignId, target.kind, target.name);
  if (href === null) return null;
  const label = escapeText(target.name.replace(/\s+/g, " ").trim());
  return `<a href="${href}" data-gm="${target.kind}">${label}</a>`;
}

/**
 * Which targets match what has been typed.
 *
 * Substring, case-insensitive, and capped: the picker is a list you
 * scan, and two hundred NPCs in it is a scrollbar rather than a choice.
 * Ordered by where the match falls, so typing "bru" puts Bruno above
 * Ambruster.
 */
export function matchTargets(
  targets: LinkTarget[],
  query: string,
  limit = 12
): LinkTarget[] {
  const q = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (!q) return targets.slice(0, limit);

  return targets
    .map((t) => ({ t, at: t.name.toLowerCase().indexOf(q) }))
    .filter((m) => m.at !== -1)
    .sort((a, b) => a.at - b.at || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((m) => m.t);
}

/** The character that starts a link while you are typing. */
export const LINK_TRIGGER = "#";

/**
 * How long a `#…` run may get before it is plainly not a name.
 *
 * There has to be a ceiling, because a `#` typed for any other reason
 * is a `#` this would otherwise track to the end of the paragraph.
 */
const MAX_QUERY = 60;

export interface HashSpot {
  /** Where the `#` sits, as an offset into the text it was found in. */
  at: number;
  /** Everything typed after it, spaces and all. */
  query: string;
}

/**
 * What is being typed after a `#`, if anything.
 *
 * The query deliberately RUNS THROUGH SPACES. Most names here have one
 * — Kelja Ironfist, the Mining Guild — and a picker that stopped at the
 * first space would ask people to type names that are not the names.
 * Which is why the link is made by CHOOSING (or by an exact match, see
 * `exactTarget`) rather than by the query ending: nothing about the
 * text itself says where a name stops.
 *
 * A `#` mid-word is not a trigger. "C#", "item#3" and a colour written
 * `#c9a227` are all things somebody may type into notes, and none of
 * them is a request for a picker.
 */
export function readHashQuery(text: string, caret: number): HashSpot | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf(LINK_TRIGGER);
  if (at === -1) return null;

  const prev = at > 0 ? before[at - 1] : "";
  // \u00a0 as well as \s: a contentEditable is full of non-breaking
  // spaces, and one of them before the `#` is still a space.
  if (prev && !/[\s\u00a0]/.test(prev)) return null;

  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY) return null;
  // A name does not span paragraphs, and the `#` three lines up is not
  // what is being typed now.
  if (/[\n\r]/.test(query)) return null;

  return { at, query };
}

const nameKey = (raw: string) =>
  raw.replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();

/**
 * The one target this query has finished naming, if it has.
 *
 * What makes "#Kelja Ironfist" become a link without pressing anything.
 * Two conditions, and the second is the one that is easy to miss:
 *
 *   - exactly ONE target has this name. Two things called the same
 *     thing is a choice, not an answer.
 *   - nothing LONGER starts with it. Auto-linking "Kelja" the moment it
 *     matched would make "Kelja Ironfist" unreachable by typing: the
 *     link would land before the space was pressed. Where a longer name
 *     exists you finish it, or press Enter to take the highlighted one.
 */
export function exactTarget(
  targets: LinkTarget[],
  query: string
): LinkTarget | null {
  const want = nameKey(query);
  if (!want) return null;

  const hits = targets.filter((t) => nameKey(t.name) === want);
  if (hits.length !== 1) return null;

  const longer = targets.some((t) => {
    const key = nameKey(t.name);
    return key !== want && key.startsWith(want);
  });
  return longer ? null : hits[0];
}

/**
 * The campaign's linkable things, from the lists the screen already
 * has.
 *
 * Blank names are dropped rather than offered: a nameless NPC is a row
 * somebody just created, and a link to "" goes to the roster with an
 * empty search — which looks like the link is broken.
 */
export function linkTargets(sources: {
  npcs?: { name?: string | null }[] | null;
  locations?: { name?: string | null }[] | null;
  groups?: { name?: string | null }[] | null;
}): LinkTarget[] {
  const out: LinkTarget[] = [];
  const seen = new Set<string>();

  const add = (kind: LinkKind, raw: unknown) => {
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!name) return;
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name });
  };

  for (const n of sources.npcs ?? []) add("npc", n.name);
  for (const l of sources.locations ?? []) add("location", l.name);
  for (const g of sources.groups ?? []) add("group", g.name);

  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
  );
}
