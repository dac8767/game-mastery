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
  /** Path segment under /campaign/[id]. "" is the campaign itself. */
  slug?: string;
  /**
   * Only shown to the campaign's DM.
   *
   * This hides a link; it does not protect anything. Nothing behind a
   * dmOnly screen may rely on it — authority in this app is structural
   * (campaign.dmId === userId) and is enforced server-side, per screen.
   */
  dmOnly?: boolean;
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
  { id: "sessions", label: "Sessions", icon: "✦" },
  { id: "npcs", label: "NPCs", icon: "☾", slug: "npcs" },
  { id: "shops", label: "Shops", icon: "⌂" },
  { id: "locations", label: "Locations", icon: "⌖", slug: "locations" },
  { id: "calendar", label: "Calendar", icon: "◷", slug: "calendar" },
];

export const TOOL_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "◌", slug: "chat" },
  { id: "dice", label: "Dice Roller", icon: "⚄" },
  { id: "combat", label: "Combat Tracker", icon: "⚔" },
  { id: "notebook", label: "Notebook", icon: "✎", slug: "notebook" },
  {
    id: "dm-screen",
    label: "DM Screen",
    icon: "▤",
    slug: "dm-screen",
    dmOnly: true,
  },
  { id: "scheduler", label: "Scheduler", icon: "⏱", slug: "scheduler" },
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
  { id: "spells", label: "Spells", icon: "✧", slug: "spells" },
  { id: "items", label: "Items", icon: "⚱", slug: "items" },
  { id: "monsters", label: "Monsters", icon: "☠", slug: "monsters" },
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

/** Everything that exists today — the ribbon's `t:` registry. */
export const NAV_DESTINATIONS: NavItem[] = [
  TABLE_ITEM,
  ...CAMPAIGN_ITEMS,
  ...TOOL_ITEMS,
  ...LOOKUP_ITEMS,
  ...ASSET_ITEMS,
  SETTINGS_ITEM,
].filter((i) => i.slug !== undefined);

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

export const NAV_ITEM_BY_ID = new Map(ALL_NAV_ITEMS.map((i) => [i.id, i]));
