/**
 * Every place in a campaign you can navigate to, in one list.
 *
 * The sidebar renders these, and the ribbon's `t:` tokens address them
 * by id. Two lists would drift, and the failure is quiet: a ribbon
 * button that points at a screen the sidebar no longer has renders as a
 * dead item rather than an error.
 *
 * A section with no `slug` isn't built yet. The sidebar shows it greyed
 * so the shape of the app is visible without dead routes that 404, and
 * the ribbon leaves it out of its registry entirely — an item whose
 * screen doesn't exist must be filtered out, not rendered empty.
 */

export type NavItem = {
  /** Stable id. Also the `t:` token's suffix, so don't rename casually. */
  id: string;
  label: string;
  icon: string;
  /**
   * A DRAWN icon instead of the character, by name.
   *
   * Names a drawing in components/NavIcon.tsx, which is where the JSX
   * has to live — this module is plain .ts and is read by things that
   * do not compile React. `icon` stays required and is what anything
   * without a renderer falls back to.
   *
   * A name with no drawing behind it fails the integrity guard rather
   * than falling back quietly, because falling back quietly means the
   * icon is simply the old one and the change looks like it did not
   * take.
   */
  art?: string;
  /** Path segment under /campaign/[id]. "" is the campaign itself. */
  slug?: string;
  /**
   * Only shown to the campaign's GM.
   *
   * This hides a link; it does not protect anything. Nothing behind a
   * dmOnly screen may rely on it — authority in this app is structural
   * (campaign.dmId === userId) and is enforced server-side, per screen.
   */
  dmOnly?: boolean;
  /**
   * The screens INSIDE this one, shown under a caret in the sidebar.
   *
   * For a tool big enough to have sections of its own. The alternative
   * is what every such tool does by default — a second navigation pane
   * down the left of its own screen — which means two navigation
   * columns on screen at once, each unaware of the other, and the app's
   * own one reduced to a bookmark you click before the real navigating
   * starts.
   *
   * A child is an ordinary destination: it has a slug, the ribbon can
   * address it by id, and the same "no slug means not built" rule
   * applies. What it is NOT is separately arrangeable — children move
   * and hide with their parent, which is why ALL_NAV_ITEMS (what the
   * sidebar designer arranges) stays flat and only NAV_ITEM_BY_ID and
   * NAV_DESTINATIONS see through to them.
   */
  children?: NavItem[];
};

/** The campaign's own page — the live table. */
export const TABLE_ITEM: NavItem = {
  id: "table",
  label: "Live Table",
  icon: "☾",
  slug: "",
};

/** Content scoped to the campaign. Titled with the campaign's name. */
export const CAMPAIGN_ITEMS: NavItem[] = [
  { id: "sessions", label: "Sessions", icon: "✦", slug: "sessions" },
  // A drawn group of people rather than the moon it used to share with
  // the campaign block above it — two different things in one sidebar
  // wearing the same symbol.
  { id: "npcs", label: "NPCs", icon: "☾", art: "people", slug: "npcs" },
  // Beside NPCs because it is the roster read the other way round:
  // the same people, filed by who they belong to.
  { id: "groups", label: "Groups", icon: "⚑", slug: "groups" },
  { id: "shops", label: "Shops", icon: "⌂" },
  { id: "locations", label: "Locations", icon: "⌖", slug: "locations" },
  { id: "calendar", label: "World Calendar", icon: "◷", art: "calendar", slug: "calendar" },
];

/**
 * The To-Do tool's own sections, under its caret in the sidebar.
 *
 * Modelled on Vikunja, which is the tool this one is built after: its
 * left pane is Overview, Upcoming, Projects and Labels, and those are
 * the four places a task list actually has. What is deliberately NOT
 * copied is the pane itself — Vikunja's would be a second navigation
 * column beside this app's own, so its contents live here instead.
 *
 * The parent To-Do link IS the Overview, which is why there is no
 * fifth entry for it. Vikunja has a separate Home row because its
 * "Vikunja" wordmark is not a link; ours is.
 *
 * Not `export`ed, and that is load-bearing rather than tidiness: the
 * integrity guard requires every exported `NavItem[]` to be a sidebar
 * SECTION named in SIDEBAR_GROUPS. These are the inside of one item,
 * not a section, and exporting them would either fail that check or
 * force an exception into it.
 */
const TODO_CHILDREN: NavItem[] = [
  // Everything with a date on it, grouped by when. Vikunja's second row.
  { id: "todo-upcoming", label: "Upcoming", icon: "◷", slug: "todo/upcoming", dmOnly: true },
  // The projects themselves. Vikunja lists each one in the sidebar and
  // nests them; this is one screen that lists them, because the
  // sidebar's contents are a static module here — read by the ribbon
  // and by the guards, neither of which runs React or can call a query.
  { id: "todo-projects", label: "Projects", icon: "▦", slug: "todo/projects", dmOnly: true },
  { id: "todo-labels", label: "Labels", icon: "◆", slug: "todo/labels", dmOnly: true },
];

export const TOOL_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "◌", art: "speech", slug: "chat" },
  { id: "dice", label: "Dice Roller", icon: "⚄", art: "d20", slug: "dice" },
  { id: "combat", label: "Combat Tracker", icon: "⚔" },
  { id: "notebook", label: "Notebook", icon: "✎", art: "notepad", slug: "notebook" },
  {
    id: "dm-screen",
    label: "GM Screen",
    icon: "▤",
    art: "trifold",
    slug: "dm-screen",
    dmOnly: true,
  },
  { id: "scheduler", label: "Scheduler", icon: "⏱", slug: "scheduler" },
  // dmOnly because the whole tool is: convex/todo.ts refuses a non-GM
  // caller rather than shaping the rows, since a prep list has no
  // player-facing version. The flag hides the link; the server is what
  // enforces it.
  { id: "todo", label: "To-Do", icon: "☑", slug: "todo", dmOnly: true, children: TODO_CHILDREN },
];

/**
 * Reference material rather than campaign content.
 *
 * Separate from Tools on purpose: a tool does something to your
 * campaign, and these three only tell you what a rule says. Nothing
 * here is campaign-scoped either — a fireball is a fireball in both of
 * Derek's groups — so whatever backs these will not carry a campaignId
 * the way npcs and locations do.
 */
export const LOOKUP_ITEMS: NavItem[] = [
  // ONE entry, not seven.
  //
  // Spells, Items, Monsters, Species, Backgrounds, Feats and Classes
  // were seven sidebar entries, which put the whole rulebook down the
  // left-hand side of every screen and made "look something up" a
  // decision about which list before it was a search. They are tabs on
  // one page now; the order is LOOKUP_TABS in lookupFields.ts.
  { id: "lookup", label: "Lookup", icon: "✧", art: "search", slug: "lookup" },
  // Rules Lawyer is deliberately NOT a tab. It searches rules PROSE
  // out of a different table with a different shape — no columns, no
  // filters, no rows — so a tab strip that included it would promise a
  // table it cannot draw.
  { id: "rules", label: "Rules Lawyer", icon: "§", slug: "rules" },
];

export const ASSET_ITEMS: NavItem[] = [
  { id: "dynamic-maps", label: "Dynamic Maps", icon: "▦" },
  { id: "static-maps", label: "Static Maps", icon: "▤" },
  { id: "miniatures", label: "Miniatures", icon: "♟" },
];

export const SETTINGS_ITEM: NavItem = {
  id: "settings",
  label: "Settings",
  icon: "⚙",
  slug: "settings",
};

/** An item and everything nested inside it, depth first. */
function withChildren(item: NavItem): NavItem[] {
  return [item, ...(item.children ?? []).flatMap(withChildren)];
}

/**
 * Everything that exists today — the ribbon's `t:` registry.
 *
 * Children included: a sub-screen is a real destination, so a ribbon
 * button may point at one. It is only the sidebar DESIGNER that treats
 * a parent as indivisible.
 */
export const NAV_DESTINATIONS: NavItem[] = [
  TABLE_ITEM,
  ...CAMPAIGN_ITEMS,
  ...TOOL_ITEMS,
  ...LOOKUP_ITEMS,
  ...ASSET_ITEMS,
  SETTINGS_ITEM,
]
  .flatMap(withChildren)
  .filter((i) => i.slug !== undefined);

/** Where an item points, given the campaign's base path. */
export function navHref(item: NavItem, base: string): string {
  return item.slug ? `${base}/${item.slug}` : base;
}

/**
 * The shipped grouping, as the sidebar designer's starting point.
 *
 * Every navigable item appears exactly once, so a layout built from
 * this can never be missing one. Settings is included because it is
 * an item of the sidebar like any other — it simply cannot be hidden,
 * which components/sidebarLayout.ts enforces rather than this.
 */
export const SIDEBAR_GROUPS = [
  {
    /**
     * Titled, like every other group.
     *
     * It shipped untitled because the campaign name sat directly above
     * it and was treated as its heading. That made the campaign name
     * do two jobs — the name of the game, and the label of a group of
     * screens — and made this the one section whose heading could not
     * be edited or seen. The campaign name is now its own block above,
     * and this is an ordinary section that says what it is.
     */
    id: "campaign",
    title: "Campaign",
    itemIds: CAMPAIGN_ITEMS.map((i) => i.id),
  },
  { id: "tools", title: "Tools", itemIds: TOOL_ITEMS.map((i) => i.id) },
  { id: "lookup", title: "Lookup", itemIds: LOOKUP_ITEMS.map((i) => i.id) },
  {
    id: "assets",
    title: "Asset Library",
    itemIds: ASSET_ITEMS.map((i) => i.id),
  },
];

/** Every item the sidebar can place, by id. */
/**
 * Every item the sidebar ARRANGES. Settings is not one of them: it
 * lives in the footer with the account actions, because it is the way
 * back to the screen that arranges everything else and a sidebar you
 * can hide it from is a door that locks from the inside.
 */
export const ALL_NAV_ITEMS: NavItem[] = [
  ...CAMPAIGN_ITEMS,
  ...TOOL_ITEMS,
  ...LOOKUP_ITEMS,
  ...ASSET_ITEMS,
];

/**
 * Every item by id, children included.
 *
 * Flattened, unlike ALL_NAV_ITEMS above: this is the lookup table, and
 * anything that resolves an id — a To-Do item's source chip, a ribbon
 * token — has to find a sub-screen as readily as a top-level one. The
 * list the sidebar ARRANGES stays flat, because a child is not
 * separately arrangeable.
 */
export const NAV_ITEM_BY_ID = new Map(
  ALL_NAV_ITEMS.flatMap(withChildren).map((i) => [i.id, i])
);
