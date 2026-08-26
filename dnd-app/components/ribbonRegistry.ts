/**
 * What the ribbon's tokens point at.
 *
 * Three token prefixes, three registries, kept separate because they
 * have different lifecycles:
 *
 *   b: — a built-in CONTROL. Something with its own UI (a dropdown, a
 *        badge) or a stateful toggle. Rendered by a switch on the key.
 *   c: — a plain COMMAND. Icon, label, one action.
 *   t: — a TOOL/screen launcher, resolved against the shared nav list so
 *        a button can never point at a screen the sidebar doesn't have.
 *
 * Commands here carry no `run()`. In the app this was ported from that
 * was a closure over a global store; here the actions need the router
 * and Convex hooks, so RibbonBar switches on the id and the registry
 * stays a plain data module the guards can read.
 */

import { NAV_DESTINATIONS, NavItem } from "@/components/navItems";
import {
  RibbonRegistrySnapshot,
  isAlignSplit,
  isNakedDivider,
  isRowBreak,
  isSectionTitle,
  isTall,
  stripTall,
} from "@/components/ribbonTokens";

export interface ToolbarBuiltin {
  key: string;
  label: string;
  icon: string;
  /**
   * Can be reordered and moved, but never removed. If a saved layout is
   * missing it, normalizeRibbon puts it back — it cannot be lost.
   * Customize is permanent because losing it locks you out of the only
   * screen that could put it back.
   */
  permanent?: boolean;
  /**
   * Still renders if a saved layout has it, but is no longer OFFERED in
   * the palette. This is how a button is retired without breaking
   * anyone's toolbar. Deleting the row instead does something different
   * and also useful: normalizeRibbon discards unknown keys, so the token
   * sheds itself from every saved layout on the next load.
   */
  unlisted?: boolean;
  /** Hidden on narrow screens. */
  desktopOnly?: boolean;
}

export const TOOLBAR_BUILTINS: ToolbarBuiltin[] = [
  { key: "campaign", label: "Campaign", icon: "☾" },
  { key: "theme", label: "Theme", icon: "◐", desktopOnly: true },
  { key: "viewAsPlayer", label: "View as Player", icon: "◉" },
  { key: "customize", label: "Customize", icon: "⚙", permanent: true },
  /**
   * The DM Screen's own controls, moved into this bar so they are
   * arranged with everything else. Their RENDERING is injected by the
   * screen (RibbonBar's `extras` prop) because the menus need the
   * screen's state; the registry rows are what make them exist to the
   * palette and the normalizer.
   *
   * Add Window and Workspaces are permanent: a saved layout that lost
   * them would be a DM Screen with no way to put windows on it. The
   * format bar is removable — that is a choice someone can mean, and
   * the keyboard shortcuts still format without it.
   */
  { key: "addWindow", label: "Add Window", icon: "⊞", permanent: true },
  { key: "workspaces", label: "Workspaces", icon: "⧉", permanent: true },
  { key: "noteFormat", label: "Note Format", icon: "𝔸" },
];

export const BUILTIN_BY_KEY: Record<string, ToolbarBuiltin> =
  Object.fromEntries(TOOLBAR_BUILTINS.map((b) => [b.key, b]));

export interface ToolbarCommand {
  id: string;
  label: string;
  icon: string;
}

export const TOOLBAR_COMMANDS: ToolbarCommand[] = [
  { id: "feedback", label: "Send Feedback", icon: "✉" },
  { id: "campaigns", label: "All Campaigns", icon: "⇤" },
  { id: "signOut", label: "Sign out", icon: "⏻" },
];

export const COMMAND_BY_ID: Record<string, ToolbarCommand> =
  Object.fromEntries(TOOLBAR_COMMANDS.map((c) => [c.id, c]));

export const TOOL_BY_ID: Record<string, NavItem> = Object.fromEntries(
  NAV_DESTINATIONS.map((t) => [t.id, t])
);

/** What normalizeRibbon needs to know about what exists right now. */
export function registrySnapshot(): RibbonRegistrySnapshot {
  return {
    builtins: TOOLBAR_BUILTINS.map((b) => b.key),
    permanent: TOOLBAR_BUILTINS.filter((b) => b.permanent).map((b) => b.key),
    tools: NAV_DESTINATIONS.map((t) => t.id),
    commands: TOOLBAR_COMMANDS.map((c) => c.id),
  };
}

/**
 * The layout a new person gets.
 *
 * No section titles: a bar where nothing is titled collapses the title
 * band entirely, which avoids the titled/untitled alignment problem
 * before it starts. Titles are available from + Add for anyone who
 * wants them, and untitled sections then reserve the band so the rows
 * still line up.
 */
export const DEFAULT_RIBBON: string[] = [
  "b:campaign",
  "2!d:sec-1",
  "t:table",
  "t:npcs",
  "t:notebook",
  "r:row-1",
  "t:chat",
  "t:settings",
  "2!d:sec-2",
  "b:theme",
  "r:row-2",
  "b:viewAsPlayer",
  "2!d:sec-dm",
  "b:addWindow",
  "b:workspaces",
  "2!d:sec-note",
  "b:noteFormat",
  "a:split-1",
  "c:feedback",
  "b:customize",
];

// ---------------------------------------------------------------------
// One resolver for "what does this token look like"
// ---------------------------------------------------------------------
//
// Both the bar and the Customize list need this. Two copies of it is
// how a row ends up showing an icon the button doesn't have.

export function tokenIcon(token: string): string {
  const tok = stripTall(token);
  if (tok.startsWith("b:")) return BUILTIN_BY_KEY[tok.slice(2)]?.icon ?? "";
  if (tok.startsWith("t:")) return TOOL_BY_ID[tok.slice(2)]?.icon ?? "";
  if (tok.startsWith("c:")) return COMMAND_BY_ID[tok.slice(2)]?.icon ?? "";
  if (tok.startsWith("s:")) return "␣";
  if (isSectionTitle(tok)) return "T";
  if (isRowBreak(tok)) return "⏎";
  if (isAlignSplit(tok)) return "⇥";
  return "│";
}

export function tokenLabel(token: string): string {
  const tok = stripTall(token);
  if (tok.startsWith("b:")) return BUILTIN_BY_KEY[tok.slice(2)]?.label ?? tok;
  if (tok.startsWith("t:")) return TOOL_BY_ID[tok.slice(2)]?.label ?? tok;
  if (tok.startsWith("c:")) return COMMAND_BY_ID[tok.slice(2)]?.label ?? tok;
  if (tok.startsWith("s:")) return "Spacer";
  // The structural grammar. Falling through to "Divider" for all of
  // these is harmless while only the bar reads it — the bar draws the
  // shapes. The Customize list NAMES them, and "Divider" for a row break
  // is a wrong answer rather than a vague one.
  if (isSectionTitle(tok)) {
    return tok.slice(3) ? `Title — ${tok.slice(3)}` : "Section Title";
  }
  if (tok.startsWith("rl:")) return "Row Break (with line)";
  if (tok.startsWith("r:")) return "Row Break";
  if (isAlignSplit(tok)) return "Alignment Split";
  if (isNakedDivider(tok)) return "Section Break";
  return isTall(token) ? "Divider — two rows" : "Divider";
}

// ---------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------

export interface PaletteCategory {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * One function builds the "what can I add" list, and everything that
 * offers items reads it — otherwise the two drift.
 *
 * `placed` reports whether a token is already on the bar; placed items
 * drop out, and so do categories left empty.
 *
 * The categories mirror the sidebar's taxonomy on purpose: someone
 * looking for a button looks under the group they know it from.
 */
export function buildPalette(
  placed: (value: string) => boolean
): PaletteCategory[] {
  const tools = (ids: string[]) =>
    ids
      .filter((id) => TOOL_BY_ID[id])
      .map((id) => ({ value: `t:${id}`, label: TOOL_BY_ID[id].label }));

  return (
    [
      {
        id: "toolbar",
        label: "Toolbar",
        options: TOOLBAR_BUILTINS.filter(
          (b) => !b.permanent && !b.unlisted
        ).map((b) => ({ value: `b:${b.key}`, label: b.label })),
      },
      {
        id: "campaign",
        label: "Campaign",
        options: tools(["table", "npcs"]),
      },
      {
        id: "tools",
        label: "Tools",
        options: tools(["chat", "notebook"]),
      },
      {
        id: "actions",
        label: "Actions",
        options: TOOLBAR_COMMANDS.map((c) => ({
          value: `c:${c.id}`,
          label: c.label,
        })).concat(tools(["settings"])),
      },
    ] as PaletteCategory[]
  )
    .map((c) => ({ ...c, options: c.options.filter((o) => !placed(o.value)) }))
    .filter((c) => c.options.length > 0);
}
