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
 *   System       how the app behaves for you, everywhere in it
 *   User         you: your name, your access, and the DM controls if
 *                you run this game — they belong to a person, not to a
 *                separate tab that only ever had one occupant
 *   Campaign     this campaign, as a thing with a name and a picture
 *   Players      who is at the table and what they play
 *   Templates    how a record is laid out, campaign-wide
 *   Interface    how the app looks and reads, yours alone
 *
 * That is why the theme and the date format are together and away from
 * the rules edition, which looks like a display preference and is not:
 * it changes what everybody at the table sees.
 */

export type SettingsTab =
  | "system"
  | "user"
  | "campaign"
  | "players"
  | "templates"
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
    id: "system",
    label: "System",
    blurb: "How the app behaves for you, everywhere in it.",
  },
  {
    id: "user",
    label: "User",
    blurb:
      "You: your name, what you can reach, and — if you run this game — the DM controls.",
  },
  {
    id: "campaign",
    label: "Campaign",
    blurb: "This campaign, as everyone else sees it. Campaign-wide.",
    dmOnly: true,
  },
  {
    id: "players",
    label: "Players",
    blurb: "Who is at the table and what they play. Campaign-wide.",
    dmOnly: true,
  },
  {
    id: "templates",
    label: "Templates",
    blurb:
      "How the campaign’s records are laid out. Campaign-wide — everyone opens an NPC to the same arrangement.",
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
