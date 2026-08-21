/**
 * The settings page's tabs.
 *
 * Declared rather than hand-wired, for the same reason the Lookup
 * filters are: the tab strip and the panels below it read one list, so
 * a tab cannot exist without a panel or a panel without a way to reach
 * it. Both of those failures are silent — a tab that renders nothing,
 * or a setting nobody can find.
 *
 * Import-free, so the unit guard can compile it on its own.
 *
 * The division is by WHOSE setting it is, not by subject:
 *
 *   General      you and your account, everywhere in the app
 *   Campaign     this campaign, as a thing with a name and a picture
 *   Game Master  the authority itself — previewing it, handing it over
 *   Players      who is at the table and what they play
 *   Interface    how the app looks and reads, yours alone
 *
 * That is why the theme and the date format are together and away from
 * the rules edition, which looks like a display preference and is not:
 * it changes what everybody at the table sees.
 */

export type SettingsTab =
  | "general"
  | "campaign"
  | "gm"
  | "players"
  | "interface";

export interface SettingsTabDef {
  id: SettingsTab;
  label: string;
  /** One line under the heading, saying whose settings these are. */
  blurb: string;
  /** Only the DM has anything to change here. */
  dmOnly?: boolean;
}

export const SETTINGS_TABS: SettingsTabDef[] = [
  {
    id: "general",
    label: "General",
    blurb:
      "You and your account — your name, how dates read, and the campaigns you are in.",
  },
  {
    id: "campaign",
    label: "Campaign",
    blurb: "This campaign, as everyone else sees it. Campaign-wide.",
    dmOnly: true,
  },
  {
    id: "gm",
    label: "Game Master",
    blurb: "Running the game: checking what players see, and handing it on.",
    dmOnly: true,
  },
  {
    id: "players",
    label: "Players",
    blurb: "Who is at the table and what they play. Campaign-wide.",
    dmOnly: true,
  },
  {
    id: "interface",
    label: "Interface",
    blurb: "How the app looks. Yours alone.",
  },
];

/** The tabs this person can actually do something on. */
export function visibleTabs(isDm: boolean): SettingsTabDef[] {
  return SETTINGS_TABS.filter((t) => isDm || !t.dmOnly);
}

/**
 * The tab to show, given what was selected.
 *
 * A DM-only tab stays selected only while you are the DM. Handing the
 * campaign over on the Game Master tab removes that tab from under you,
 * and without this the page would go blank with the strip still showing
 * a tab that is no longer there.
 */
export function resolveTab(selected: string, isDm: boolean): SettingsTab {
  const available = visibleTabs(isDm);
  const found = available.find((t) => t.id === selected);
  return found ? found.id : available[0].id;
}
