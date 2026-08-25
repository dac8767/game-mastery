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
