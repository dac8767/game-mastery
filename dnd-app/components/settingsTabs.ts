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
 *   Campaign     this campaign as a thing: its name, its picture, its
 *                rules edition, and who is at the table
 *   Interface    how the app looks and reads, yours alone
 *
 * That is why the theme and the date format are together and away from
 * the rules edition, which looks like a display preference and is not:
 * it changes what everybody at the table sees.
 *
 * There was a Templates tab here, holding a miniature of the NPC record
 * you dragged fields around on. Edit mode does that on the record
 * itself now, so the miniature was a second, smaller, worse copy of a
 * screen you could just go and stand on — and one that had to be kept
 * in step with the real one to avoid lying about the layout. The
 * arranging did not move here from there; it moved OUT of settings
 * entirely.
 *
 * A Players tab went the other way, and is the opposite case: it held
 * the roster and the invite panel, both of which answer the same
 * question Campaign does — what IS this campaign — so it was a second
 * tab you had to know to look in for half the answer. Those panels
 * moved INTO Campaign rather than being removed.
 */

export type SettingsTab =
  | "system"
  | "user"
  | "campaign"
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
    blurb:
      "This campaign, as everyone else sees it — its name, its rules edition, and who is at the table. Campaign-wide.",
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
