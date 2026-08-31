/**
 * Which tabs a session's notes are kept on, and what a tab key means.
 *
 * A session used to have two pages, "player" and "dm", and the word for
 * which one you were on was `side`. It now has as many as anybody
 * makes. This module is the whole of what that means away from the
 * database:
 *
 *   - the three tabs every session has, in the order they appear
 *   - what a tab KEY is, so the client and the server agree
 *   - the id the page body wears on the canvas, and how to read it back
 *
 * Free of React and Convex, so the parts that are easy to get quietly
 * wrong — the order of the built-ins, a title that is only spaces, a
 * page id that is really a box id — are testable without either. The
 * unit guard holds them.
 *
 * Sessions' own, deliberately. components/notePage.ts does the last of
 * these three jobs for the two-sided world and belongs to the notebook;
 * a tab key is a wider thing than a side, and widening another tool's
 * file to say so is how two chats end up editing one file.
 */

/**
 * A tab key: "player", "dm", "prep", or a sessionTabs document id.
 *
 * A plain string rather than a union, because the set is open. What
 * keeps a made-up key out is the server resolving it against this
 * session's tabs, which is a stronger check than a literal ever was —
 * it answers with the tab's visibility rather than only its spelling.
 */
export type TabKey = string;

export type TabDef = {
  key: TabKey;
  title: string;
  /** Withheld from players — see sessions.getNotes. */
  dmOnly: boolean;
  /** On every session, and cannot be renamed or deleted. */
  builtin: boolean;
};

/**
 * The three every session has, in the order they are shown.
 *
 * DM first, which is the way round it was asked for: the DM is writing
 * during the session and reading the player page back afterwards. Prep
 * sits beside DM notes rather than after Player notes because the two
 * DM-only tabs are the same kind of thing — what the table does not
 * know — and a player sees neither, so for them the strip is unchanged.
 *
 * "prep" is a built-in rather than a tab somebody has to make: it was
 * asked for as a thing sessions HAVE. A row per session for a tab that
 * is always there and always the same would be 53 rows saying so for
 * Moonbrook alone.
 */
export const BUILTIN_TABS: TabDef[] = [
  { key: "dm", title: "DM notes", dmOnly: true, builtin: true },
  { key: "prep", title: "DM Prep", dmOnly: true, builtin: true },
  { key: "player", title: "Player notes", dmOnly: false, builtin: true },
];

/** The tab a session opens on for somebody who can see the DM's. */
export const DEFAULT_TAB: TabKey = "dm";

/** And for somebody who cannot — the only one they have. */
export const PLAYER_TAB: TabKey = "player";

/** How many tabs one session may carry past the built-ins. */
export const MAX_CUSTOM_TABS = 8;

/** Longest a tab's name may be. A tab strip is not a paragraph. */
export const MAX_TAB_TITLE = 40;

export function builtinTab(key: unknown): TabDef | null {
  return BUILTIN_TABS.find((t) => t.key === key) ?? null;
}

export function isBuiltinKey(key: unknown): boolean {
  return builtinTab(key) !== null;
}

/**
 * A typed tab name, as it will be stored.
 *
 * Collapsed and trimmed, because a name is one line: "  Session   two "
 * and "Session two" are the same tab, and only one of them lines up in
 * a strip of buttons. Cut to length rather than refused — somebody
 * pasting a sentence in wants a tab, not an error.
 */
export function tabTitle(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TAB_TITLE);
}

/**
 * Whether that leaves anything.
 *
 * An empty name is the one refusal: a nameless tab is a button you
 * cannot describe, cannot tell from the next nameless one, and cannot
 * ask anybody about.
 */
export function isValidTitle(raw: unknown): boolean {
  return tabTitle(raw).length > 0;
}

/**
 * The strip, in order: the built-ins this person may see, then the
 * custom tabs by `order`.
 *
 * Ties on `order` break by creation time — two tabs made in the same
 * second by two people would otherwise sit in whatever order the
 * database returned them, which is not the same order for both of them.
 */
export function orderTabs(
  isDm: boolean,
  custom: {
    _id: string;
    _creationTime: number;
    title: string;
    dmOnly: boolean;
    order: number;
  }[]
): TabDef[] {
  const builtins = BUILTIN_TABS.filter((t) => isDm || !t.dmOnly);
  const rest = [...custom]
    .sort((a, b) => a.order - b.order || a._creationTime - b._creationTime)
    .map((t) => ({
      key: t._id,
      title: t.title,
      dmOnly: t.dmOnly,
      builtin: false,
    }));
  return [...builtins, ...rest];
}

/**
 * The tab to show, given the one that was open.
 *
 * A tab deleted out from under you — by you in another window, or by
 * the DM — leaves the strip pointing at nothing, and a canvas keyed to
 * a tab that is gone writes into a page nobody can read. So the choice
 * falls back rather than being held: the first tab on offer, which is
 * the DM's own for a DM and the player page for everybody else.
 */
export function activeTabKey(tabs: TabDef[], wanted: TabKey | null): TabKey {
  if (tabs.length === 0) return PLAYER_TAB;
  if (wanted && tabs.some((t) => t.key === wanted)) return wanted;
  return tabs[0].key;
}

const PAGE_PREFIX = "page:";

/**
 * The id the page body wears on the canvas.
 *
 * The format toolbar knows one kind of thing: an editable region with
 * an id, which it writes back through whatever saver the screen
 * registered. A tab has two of those — the boxes, which are rows in
 * sessionBoxes, and the PAGE, which is a row in sessionPages and
 * reached by a different mutation. So the id carries which.
 *
 * A prefix rather than a second registry: the saver gets an id and
 * nothing else, and a lookup table it would have to be kept in step
 * with is a lookup table that will one day be out of step — at which
 * point a page edit is sent to updateBox with an id that is not a
 * document id, and Convex rejects it as an argument validation error
 * rather than as anything a person could read.
 */
export function pageBoxId(key: TabKey): string {
  return `${PAGE_PREFIX}${key}`;
}

/**
 * Which tab's page this id is, or null for anything else.
 *
 * Null for a real box id, which is the discrimination the saver needs.
 * A prefixed id naming a tab that does not exist comes back as that
 * key and is refused by the server, which is where a tab key is
 * checked — this function's job is to tell a page from a box, not to
 * decide who may write on it.
 */
export function pageTabKey(boxId: unknown): TabKey | null {
  const id = String(boxId ?? "");
  if (!id.startsWith(PAGE_PREFIX)) return null;
  const key = id.slice(PAGE_PREFIX.length);
  return key === "" ? null : key;
}
