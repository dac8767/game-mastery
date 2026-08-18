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
  { id: "locations", label: "Locations", icon: "⌖" },
  { id: "calendar", label: "Calendar", icon: "◷" },
];

export const TOOL_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "◌", slug: "chat" },
  { id: "dice", label: "Dice Roller", icon: "⚄" },
  { id: "combat", label: "Combat Tracker", icon: "⚔" },
  { id: "notebook", label: "Notebook", icon: "✎", slug: "notebook" },
  { id: "scheduler", label: "Scheduler", icon: "⏱" },
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
  ...ASSET_ITEMS,
  SETTINGS_ITEM,
].filter((i) => i.slug !== undefined);

/** Where an item points, given the campaign's base path. */
export function navHref(item: NavItem, base: string): string {
  return item.slug ? `${base}/${item.slug}` : base;
}
