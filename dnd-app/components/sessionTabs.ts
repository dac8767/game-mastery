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
 * GM first, which is the way round it was asked for: the GM is writing
 * during the session and reading the player page back afterwards. Prep
 * sits beside Notes rather than after Player Notes because the two
 * GM-only tabs are the same kind of thing — what the table does not
 * know — and a player sees neither, so for them the strip is unchanged.
 *
 * The GM's two are "Notes" and "Prep", not "GM notes" and "GM Prep":
 * the strip already puts the GM tag beside every hidden tab, and a
 * name that says GM next to a tag that says GM said it twice. Title
 * case throughout, because the editor lists them as menu items.
 *
 * "prep" is a built-in rather than a tab somebody has to make: it was
 * asked for as a thing sessions HAVE. A row per session for a tab that
 * is always there and always the same would be 53 rows saying so for
 * Moonbrook alone.
 */
export const BUILTIN_TABS: TabDef[] = [
  { key: "dm", title: "Notes", dmOnly: true, builtin: true },
  { key: "prep", title: "Prep", dmOnly: true, builtin: true },
  { key: "player", title: "Player Notes", dmOnly: false, builtin: true },
];

/** The tab a session opens on for somebody who can see the GM's. */
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
 * custom tabs by `order` — and over both of those, the order somebody
 * dragged the strip into, if anybody has.
 *
 * Ties on `order` break by creation time — two tabs made in the same
 * second by two people would otherwise sit in whatever order the
 * database returned them, which is not the same order for both of them.
 *
 * `arranged` is sessions.tabOrder: the keys as the strip was last
 * arranged, or nothing for a session nobody has rearranged. A key in it
 * that no longer names a tab is skipped, so deleting a tab does not
 * have to keep the list in step; a tab NOT in it goes after everything
 * that is, in the default order — which is where a new tab lands
 * anyway, and is the whole reason the default order is still computed
 * first rather than replaced.
 */
export function orderTabs(
  isDm: boolean,
  custom: {
    _id: string;
    _creationTime: number;
    title: string;
    dmOnly: boolean;
    order: number;
  }[],
  arranged?: string[] | null
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
  return arrange([...builtins, ...rest], arranged ?? []);
}

/**
 * Tabs by their place in `arranged`, the unplaced after them in the
 * order they came. A stable sort: two tabs the list does not name keep
 * their relative order, which is the default one.
 */
function arrange(tabs: TabDef[], arranged: string[]): TabDef[] {
  const rank = new Map(arranged.map((k, i) => [k, i] as const));
  return tabs
    .map((t, i) => ({ t, i, r: rank.get(t.key) ?? Infinity }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
    .map((x) => x.t);
}

/**
 * `keys` with `key` moved to position `to`, the rest keeping their
 * order. The one operation both ways of rearranging reduce to: a drop
 * is "move to where I let go", and the Move left / Move right buttons
 * are "move to one before / one after where it is".
 *
 * Clamped rather than refused — "left" of the first tab is the first
 * tab. A key that is not in the list, or is already where it was
 * asked to go, gives the list back unchanged, and the caller can tell
 * by identity that there is nothing to save.
 */
export function moveKey(keys: string[], key: string, to: number): string[] {
  const from = keys.indexOf(key);
  if (from === -1) return keys;
  const at = Math.max(0, Math.min(keys.length - 1, to));
  if (at === from) return keys;
  const next = keys.filter((k) => k !== key);
  next.splice(at, 0, key);
  return next;
}

/**
 * Whether `b` is `a` in some order — the same keys, each exactly once.
 *
 * What sessions.reorderTabs checks before believing an order it was
 * sent: a list that drops a tab, doubles one, or names one from
 * another session is not a rearrangement of this strip.
 */
export function samePermutation(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  if (seen.size !== a.length || new Set(b).size !== b.length) return false;
  return b.every((k) => seen.has(k));
}

/**
 * A rearrangement of the tabs one person can SEE, applied to the whole
 * strip.
 *
 * A player is sent the shared tabs and nothing else, so the order they
 * send back names only those — and the hidden ones must not be
 * disturbed by it, or a GM who put Prep first would find it moved by
 * a player who never saw it. So the slots the visible keys occupy in
 * `full` are refilled with `wanted`, in order, and every other slot is
 * left exactly where it was. For the GM, who sees everything, this is
 * `wanted` itself.
 *
 * Precondition: `wanted` is a permutation of `visible`. The server
 * checks with samePermutation before calling.
 */
export function mergeOrder(
  full: string[],
  visible: string[],
  wanted: string[]
): string[] {
  const vis = new Set(visible);
  const queue = [...wanted];
  return full.map((k) => (vis.has(k) ? (queue.shift() ?? k) : k));
}

/**
 * The tab to show, given the one that was open.
 *
 * A tab deleted out from under you — by you in another window, or by
 * the GM — leaves the strip pointing at nothing, and a canvas keyed to
 * a tab that is gone writes into a page nobody can read. So the choice
 * falls back rather than being held: the first tab on offer, which is
 * the GM's own for a GM and the player page for everybody else.
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
