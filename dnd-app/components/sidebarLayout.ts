/**
 * The sidebar, as its owner arranged it.
 *
 * navItems.ts says what exists and where each thing points. This says
 * what YOU see and in what order: items hidden, sections renamed, your
 * own sections made, everything reordered. Per person, not per
 * campaign — it is a view of the app, not a fact about the game.
 *
 * Free of React, Convex, and sibling imports so the unit guard can
 * compile it alone. The nav groups are passed IN when a starting layout
 * is built, which keeps this module with no opinion of its own about
 * whether the Calendar belongs under Campaign or Tools.
 */

export interface SidebarItem {
  /** A NavItem id from navItems.ts. */
  id: string;
  hidden: boolean;
  /**
   * Open, showing the item's own sub-screens beneath it.
   *
   * Only meaningful on an item that HAS children; on any other it is a
   * flag nothing reads. Saved rather than held in component state for
   * the same reason a section's fold is: walking from one screen to
   * another remounts the whole shell, so a useState would snap shut on
   * every click of the thing it just opened.
   *
   * Optional and absent-means-shut, because it is the rarer state and
   * because a validator that demanded it would reject every sidebar
   * saved before sub-items existed.
   */
  expanded?: boolean;
}

export interface SidebarSection {
  id: string;
  title: string;
  /**
   * Shown only while you are the DM of the campaign you are looking at.
   *
   * A preference, not a permission — this is YOUR sidebar and nobody
   * else has one built from it. What a player may actually reach is
   * decided on the server and by NavItem.dmOnly, and neither of them
   * reads this. What it is for is the other direction: a DM who keeps
   * their prep in one section and wants it gone while previewing as a
   * player, without hiding six things one at a time and putting them
   * all back after.
   */
  dmOnly?: boolean;
  /**
   * Folded up in the sidebar, its heading still showing.
   *
   * Only a section with a heading may be — folding an untitled one
   * would leave nothing on screen to click to get it back.
   */
  collapsed?: boolean;
  items: SidebarItem[];
}

export interface SidebarLayout {
  sections: SidebarSection[];
}

export const SIDEBAR_LIMITS = {
  sections: 12,
  titleLength: 30,
};

/**
 * Nothing here needs pinning any more.
 *
 * Settings used to, because it was an arrangeable item and hiding it
 * would have removed the only way back to the screen that un-hides
 * things. It now lives in the footer, outside the designer entirely,
 * which solves the same problem by not creating it. The list stays so
 * the mechanism is here if another item ever needs it.
 */
export const ALWAYS_VISIBLE: string[] = [];

export function sectionId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "section"}-${index}`;
}

/** The app's own grouping, as an editable layout. */
export function defaultSidebar(
  groups: { id: string; title: string; itemIds: string[] }[]
): SidebarLayout {
  return {
    sections: groups.map((g, i) => ({
      id: g.id || sectionId(g.title, i),
      title: g.title,
      items: g.itemIds.map((id) => ({ id, hidden: false })),
    })),
  };
}

/**
 * A layout made safe to render against what the app actually has. IDEMPOTENT.
 *
 * The important half is the same as everywhere else in this app: an
 * item the layout has never heard of is APPENDED, not ignored. A tool
 * shipped after someone last touched their sidebar would otherwise be
 * unreachable for them — not hidden, absent — and the only hint would
 * be that a feature everyone else is talking about does not exist.
 *
 * Newly appended items arrive visible. A person who has never hidden
 * anything should not have to go looking for what they just gained.
 */
export function reconcileSidebar(
  layout: SidebarLayout | null | undefined,
  validIds: string[]
): SidebarLayout {
  const valid = new Set(validIds);
  const seen = new Set<string>();
  const sections: SidebarSection[] = [];

  for (const [i, section] of (layout?.sections ?? []).entries()) {
    const items: SidebarItem[] = [];
    for (const it of section?.items ?? []) {
      const id = String(it?.id ?? "");
      if (!valid.has(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        hidden: ALWAYS_VISIBLE.includes(id) ? false : Boolean(it?.hidden),
      });
    }
    const title = String(section?.title ?? "")
      .trim()
      .slice(0, SIDEBAR_LIMITS.titleLength);
    const next: SidebarSection = {
      id: String(section?.id ?? "") || sectionId(title, i),
      title,
      items,
    };
    // Written only when true, so a layout that never used either flag
    // reconciles to the same object it went in as.
    if (section?.dmOnly) next.dmOnly = true;
    // A collapsed section with no heading is a section with nothing on
    // screen to click. Renaming one to nothing while it was folded is
    // how that happens, and it happens after the fact — so the rule is
    // enforced here rather than only at the moment of folding.
    if (section?.collapsed && title) next.collapsed = true;
    sections.push(next);
    if (sections.length >= SIDEBAR_LIMITS.sections) break;
  }

  const usedIds = new Set<string>();
  for (const [i, section] of sections.entries()) {
    let id = section.id;
    let n = i;
    while (usedIds.has(id)) id = sectionId(section.title, ++n);
    usedIds.add(id);
    section.id = id;
  }

  if (sections.length === 0) {
    sections.push({ id: "section-0", title: "", items: [] });
  }

  const missing = validIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    sections[sections.length - 1].items.push(
      ...missing.map((id) => ({ id, hidden: false }))
    );
  }

  return { sections };
}

/** Every item id the layout places, in order. */
export function sidebarIds(layout: SidebarLayout): string[] {
  return layout.sections.flatMap((s) => s.items.map((i) => i.id));
}

/**
 * What the sidebar renders: visible items only, empty sections dropped.
 *
 * `allowed` is what this person may see at all — the DM-only screens
 * are not in it for a player. Hiding and not-being-allowed are
 * different things that happen to look the same here, and only one of
 * them is a preference.
 *
 * `isDm` is the third of those, and it is the preference again: a
 * section marked DM-only goes when you are not the DM here, including
 * while previewing as a player. It is deliberately a required argument
 * rather than one defaulting to true — a call site that forgot it
 * would leave a DM's prep section on screen in the preview that exists
 * to show what the prep looks like from outside.
 */
export function visibleSidebar(
  layout: SidebarLayout,
  allowed: string[],
  isDm: boolean
): SidebarSection[] {
  const permitted = new Set(allowed);
  return layout.sections
    .filter((s) => isDm || !s.dmOnly)
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => !i.hidden && permitted.has(i.id)),
    }))
    .filter((s) => s.items.length > 0);
}

/** Mark a section as the DM's, or stop. */
export function setSectionDmOnly(
  layout: SidebarLayout,
  id: string,
  dmOnly: boolean
): SidebarLayout {
  return {
    sections: layout.sections.map((s) => {
      if (s.id !== id) return s;
      const next: SidebarSection = { ...s };
      if (dmOnly) next.dmOnly = true;
      else delete next.dmOnly;
      return next;
    }),
  };
}

/**
 * Fold a section up, or open it again.
 *
 * Refuses to fold one with no heading. The heading is the whole of a
 * collapsed section — take it away and there is nothing left on screen
 * to click, and the items inside are gone with no hint they exist.
 */
export function setSectionCollapsed(
  layout: SidebarLayout,
  id: string,
  collapsed: boolean
): SidebarLayout {
  return {
    sections: layout.sections.map((s) => {
      if (s.id !== id) return s;
      const next: SidebarSection = { ...s };
      if (collapsed && s.title) next.collapsed = true;
      else delete next.collapsed;
      return next;
    }),
  };
}

export function toggleSectionCollapsed(
  layout: SidebarLayout,
  id: string
): SidebarLayout {
  const section = layout.sections.find((s) => s.id === id);
  return setSectionCollapsed(layout, id, !section?.collapsed);
}

/**
 * Open or shut one item's sub-screens.
 *
 * `expanded` is deleted rather than set to false, so a shut item is
 * byte-identical to one nobody has ever opened. Two spellings of the
 * same state is how a "did they change anything" comparison starts
 * answering yes for no reason.
 */
export function setItemExpanded(
  layout: SidebarLayout,
  id: string,
  expanded: boolean
): SidebarLayout {
  return {
    sections: layout.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => {
        if (i.id !== id) return i;
        const next: SidebarItem = { ...i };
        if (expanded) next.expanded = true;
        else delete next.expanded;
        return next;
      }),
    })),
  };
}

export function toggleItemExpanded(
  layout: SidebarLayout,
  id: string
): SidebarLayout {
  const item = layout.sections
    .flatMap((s) => s.items)
    .find((i) => i.id === id);
  return setItemExpanded(layout, id, !item?.expanded);
}

export function toggleHidden(
  layout: SidebarLayout,
  id: string
): SidebarLayout {
  if (ALWAYS_VISIBLE.includes(id)) return layout;
  return {
    sections: layout.sections.map((s) => ({
      ...s,
      items: s.items.map((i) =>
        i.id === id ? { ...i, hidden: !i.hidden } : i
      ),
    })),
  };
}

/**
 * Hide or show an item outright, rather than flipping it.
 *
 * What dragging needs: a drop into the Hidden column means hidden,
 * whatever it was before, and a drop back into a section means shown.
 * A toggle would make a drag into Hidden un-hide something already
 * hidden, which is the opposite of what the gesture said.
 */
export function setHidden(
  layout: SidebarLayout,
  id: string,
  hidden: boolean
): SidebarLayout {
  if (hidden && ALWAYS_VISIBLE.includes(id)) return layout;
  return {
    sections: layout.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === id ? { ...i, hidden } : i)),
    })),
  };
}

export function moveItem(
  layout: SidebarLayout,
  id: string,
  toSectionId: string,
  toIndex: number
): SidebarLayout {
  const moved =
    layout.sections.flatMap((s) => s.items).find((i) => i.id === id) ?? {
      id,
      hidden: false,
    };

  return {
    sections: layout.sections.map((s) => {
      const without = s.items.filter((i) => i.id !== id);
      if (s.id !== toSectionId) return { ...s, items: without };
      const at = Math.min(Math.max(0, Math.round(toIndex)), without.length);
      return {
        ...s,
        items: [...without.slice(0, at), moved, ...without.slice(at)],
      };
    }),
  };
}

/**
 * Move an item one place among its VISIBLE siblings.
 *
 * Hidden items stay in the section they belong to, so that showing one
 * again puts it back where it was rather than at the end. But they are
 * not on screen, so stepping over one would look like the arrow did
 * nothing — press it twice and the item finally jumps two places. The
 * hop is measured in what you can see.
 */
export function shiftItem(
  layout: SidebarLayout,
  id: string,
  delta: number
): SidebarLayout {
  const step = Math.sign(Math.round(delta));
  if (step === 0) return layout;

  return {
    sections: layout.sections.map((s) => {
      const at = s.items.findIndex((i) => i.id === id);
      if (at === -1 || s.items[at].hidden) return s;

      let to = at + step;
      while (to >= 0 && to < s.items.length && s.items[to].hidden) to += step;
      if (to < 0 || to >= s.items.length) return s;

      const items = s.items.slice();
      const [item] = items.splice(at, 1);
      items.splice(to, 0, item);
      return { ...s, items };
    }),
  };
}

/** A section's items that are actually on screen, in order. */
export function shownItems(section: SidebarSection): SidebarItem[] {
  return section.items.filter((i) => !i.hidden);
}

/**
 * Everything hidden, across every section — the Hidden column.
 *
 * Flat, because "which section is this hidden thing filed under" is not
 * a question anyone has: it is off, and the only thing you want to do
 * with it is put it back.
 */
export function hiddenItems(layout: SidebarLayout): SidebarItem[] {
  return layout.sections.flatMap((s) => s.items.filter((i) => i.hidden));
}

/** Hide everything that can be hidden. */
export function hideAll(layout: SidebarLayout): SidebarLayout {
  return {
    sections: layout.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => ({
        ...i,
        hidden: !ALWAYS_VISIBLE.includes(i.id),
      })),
    })),
  };
}

/** Show everything again. */
export function showAll(layout: SidebarLayout): SidebarLayout {
  return {
    sections: layout.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => ({ ...i, hidden: false })),
    })),
  };
}

export function addSection(
  layout: SidebarLayout,
  title: string
): SidebarLayout {
  if (layout.sections.length >= SIDEBAR_LIMITS.sections) return layout;
  const clean =
    title.trim().slice(0, SIDEBAR_LIMITS.titleLength) ||
    `Section ${layout.sections.length + 1}`;
  const used = new Set(layout.sections.map((s) => s.id));
  let id = sectionId(clean, layout.sections.length);
  let n = layout.sections.length;
  while (used.has(id)) id = sectionId(clean, ++n);
  return {
    sections: [...layout.sections, { id, title: clean, items: [] }],
  };
}

export function renameSection(
  layout: SidebarLayout,
  id: string,
  title: string
): SidebarLayout {
  return {
    sections: layout.sections.map((s) => {
      if (s.id !== id) return s;
      const next: SidebarSection = {
        ...s,
        title: title.slice(0, SIDEBAR_LIMITS.titleLength),
      };
      // Clearing the heading of a folded section unfolds it. The
      // heading was the only thing still on screen; keeping it folded
      // would hide the section and the way back to it in one edit.
      if (!next.title) delete next.collapsed;
      return next;
    }),
  };
}

/**
 * Remove a section, keeping its items.
 *
 * They move to the section beside it rather than going with it. Same
 * reason as the NPC record's tabs: deleting a section is a statement
 * about the section, and taking six links out of the sidebar with it
 * is not what anybody meant — least of all when one of them might be
 * the only way to reach a screen.
 */
export function removeSection(
  layout: SidebarLayout,
  id: string
): SidebarLayout {
  if (layout.sections.length <= 1) return layout;
  const at = layout.sections.findIndex((s) => s.id === id);
  if (at === -1) return layout;

  const orphans = layout.sections[at].items;
  const into = at === 0 ? 1 : at - 1;
  return {
    sections: layout.sections
      .map((s, i) =>
        i === into ? { ...s, items: [...s.items, ...orphans] } : s
      )
      .filter((_, i) => i !== at),
  };
}

export function shiftSection(
  layout: SidebarLayout,
  id: string,
  delta: number
): SidebarLayout {
  const at = layout.sections.findIndex((s) => s.id === id);
  if (at === -1) return layout;
  const to = at + Math.round(delta);
  if (to < 0 || to >= layout.sections.length) return layout;
  const sections = layout.sections.slice();
  const [s] = sections.splice(at, 1);
  sections.splice(to, 0, s);
  return { sections };
}
