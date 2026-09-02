"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { BackIcon, NavIcon } from "@/components/NavIcon";
import { ThemeSync } from "@/components/ThemeSync";
import { FeedbackForm } from "@/components/FeedbackForm";
import { UiProvider } from "@/components/UiEditor";
import { Id } from "@/convex/_generated/dataModel";
import {
  ALL_NAV_ITEMS,
  NAV_ITEM_BY_ID,
  NavItem,
  SIDEBAR_GROUPS,
  navHref,
} from "@/components/navItems";
import {
  SidebarLayout,
  defaultSidebar,
  reconcileSidebar,
  toggleItemCollapsed,
  toggleSectionCollapsed,
  visibleSidebar,
} from "@/components/sidebarLayout";
import { clearHistory } from "@/components/undoHistory";

/**
 * The application frame: navigation on the left, the selected thing on
 * the right.
 *
 * The customizable ribbon deliberately does NOT live here. It belongs to
 * the GM Screen and nowhere else, so every other screen keeps its full
 * height for the thing it is actually showing.
 *
 * The nav list itself lives in components/navItems.ts, because the
 * ribbon's tool buttons address the same destinations by id and two
 * lists would drift. A section with no `slug` isn't built yet and
 * renders as a disabled item rather than a link, so the shape of the app
 * is visible without dead routes that 404. To bring one online, add its
 * page under app/campaign/[campaignId]/<slug>/ and give it a `slug`
 * there.
 */

function NavList({
  items,
  base,
  pathname,
  isDm,
  folded,
  onToggleFold,
}: {
  items: NavItem[];
  base: string;
  pathname: string;
  isDm: boolean;
  /**
   * Which parents the reader has folded away, by id. Absent for a
   * child list — a sub-screen with sub-screens of its own is a menu,
   * not a sidebar.
   */
  folded?: Set<string>;
  onToggleFold?: (id: string) => void;
}) {
  return (
    <ul className="nav-list">
      {items.filter((item) => isDm || !item.dmOnly).map((item) => {
        if (item.slug === undefined) {
          return (
            <li key={item.id}>
              <span className="nav-item disabled" title={item.label}>
                <NavIcon icon={item.icon} art={item.art} />
                <span className="nav-label">{item.label}</span>
                <span className="soon">soon</span>
              </span>
            </li>
          );
        }
        const href = navHref(item, base);
        /* Children the reader may actually reach. Filtered here rather
           than inside the child list, because a parent whose every
           child is dmOnly must not draw a caret onto an empty tray. */
        const kids = (item.children ?? []).filter((c) => isDm || !c.dmOnly);
        /* Inside the tool, or on one of its own screens. The whole tray
           hangs off this: a tool's sections are only ever shown while
           you are in it, so the sidebar stays the length of the app
           rather than the length of the app plus every tool's insides.
           Matched on the path SEGMENT, not with startsWith — /todo must
           not light up for a /todolist that shipped later. */
        const here =
          pathname === href || pathname.startsWith(`${href}/`);
        /* Open unless folded away. A tool you are standing in shows you
           its screens without being asked; the caret is for the person
           who wants them out of the way, which is why the saved flag is
           `collapsed` and absent means open. */
        const open = kids.length > 0 && here && !folded?.has(item.id);
        /* The caret folds the tray; the label still navigates. Two
           targets on one row, so "show me what is in here" and "take me
           to the front of it" stay separate questions — collapsing them
           into one is how you end up unable to look without going. */
        return (
          <li key={item.id}>
            <div className="nav-row">
              <Link
                href={href}
                className={`nav-item${pathname === href ? " active" : ""}${
                  kids.length > 0 ? " has-kids" : ""
                }`}
                title={item.label}
              >
                <NavIcon icon={item.icon} art={item.art} />
                <span className="nav-label">{item.label}</span>
              </Link>
              {kids.length > 0 && here && onToggleFold && (
                <button
                  type="button"
                  className={`nav-caret${open ? " open" : ""}`}
                  aria-expanded={open}
                  aria-label={
                    open ? `Hide ${item.label}'s screens` : `Show ${item.label}'s screens`
                  }
                  title={open ? "Hide these" : "Show these"}
                  onClick={() => onToggleFold(item.id)}
                >
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
              )}
            </div>
            {open && (
              <div className="nav-sub">
                <NavList
                  items={kids}
                  base={base}
                  pathname={pathname}
                  isDm={isDm}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AppShell({
  campaignId,
  breadcrumb,
  children,
}: {
  campaignId: Id<"campaigns">;
  /**
   * The screen's name, for the browser tab.
   *
   * It used to be a "Moonbrook › NPCs" strip across the top of every
   * screen, which spent a row of every page telling you the two things
   * the sidebar already had highlighted. The tab is where a trail is
   * useful — it is how you find the window again.
   */
  breadcrumb: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const settings = useQuery(api.settings.mySettings);
  const saveSettings = useMutation(api.settings.saveMySettings);
  const { signOut } = useAuthActions();

  const campaign = campaigns?.find((c) => c._id === campaignId) ?? null;
  const base = `/campaign/${campaignId}`;
  /**
   * Two different questions, and conflating them is a trap.
   *
   * runsThis is structural — you are the GM of this campaign — and is
   * what decides whether the View as Player switch is offered at all.
   * isDm is what the sidebar filters on, and the preview turns it off
   * so the GM-only screens go away like they would for a player.
   *
   * The switch must hang off the first, never the second. Gate the way
   * OUT of a preview on not being in one and it becomes a one-way
   * door: the button disappears the moment it works.
   */
  const runsThis = campaign?.isDm ?? false;
  const previewing = Boolean(settings?.viewAsPlayer);
  const isDm = runsThis && !previewing;
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // The trail, moved to where a trail is worth having. Written in an
  // effect rather than through Next's metadata because these pages are
  // client components and the campaign name arrives from a query.
  useEffect(() => {
    document.title = campaign?.name
      ? `${breadcrumb} · ${campaign.name}`
      : breadcrumb;
  }, [breadcrumb, campaign?.name]);

  /**
   * The sidebar this person arranged, or the shipped grouping.
   *
   * Reconciled against what the app actually has either way: a layout
   * saved before a tool shipped has no opinion about it, and an item
   * the layout does not mention would be unreachable rather than
   * hidden — no menu entry, and no hint that there is one to un-hide.
   */
  const layout = useMemo<SidebarLayout>(
    () =>
      reconcileSidebar(
        settings?.sidebar ?? defaultSidebar(SIDEBAR_GROUPS),
        ALL_NAV_ITEMS.map((i) => i.id)
      ),
    [settings?.sidebar]
  );

  const sections = useMemo(() => {
    const allowed = ALL_NAV_ITEMS.filter((i) => isDm || !i.dmOnly).map(
      (i) => i.id
    );
    return visibleSidebar(layout, allowed, isDm);
  }, [layout, isDm]);

  /**
   * Folding a section, written straight through to the saved layout.
   *
   * Not component state, because there is no shared layout above these
   * screens — walking from the NPC table to the calendar remounts this
   * whole shell, and a fold kept in a useState would spring open on
   * every navigation. It is one small write per click on a document
   * this person already owns.
   */
  const toggleFold = (sectionId: string) => {
    void saveSettings({ sidebar: toggleSectionCollapsed(layout, sectionId) });
  };

  /**
   * The tools whose own screens this person has folded away. Saved for
   * the reason the section folds are: navigating remounts this shell.
   */
  const foldedIds = useMemo(
    () =>
      new Set(
        layout.sections
          .flatMap((s) => s.items)
          .filter((i) => i.collapsed)
          .map((i) => i.id)
      ),
    [layout]
  );

  const toggleItemFold = (itemId: string) => {
    void saveSettings({ sidebar: toggleItemCollapsed(layout, itemId) });
  };

  /**
   * The whole sidebar folded to a rail of icons — Airtable's arrow.
   * Saved, not component state, for the same reason the section folds
   * are: navigation remounts this shell, and a collapse kept in a
   * useState would spring open on every screen change.
   */
  const collapsed = Boolean(settings?.sidebarCollapsed);

  return (
    /* The provider wraps the whole shell, not one screen: edit mode has
       to survive walking to another screen to change that one, and the
       bar it puts along the bottom is mounted here so it does. */
    <UiProvider
      campaignId={campaignId}
      canEdit={isDm}
      previewing={runsThis && previewing}
    >
    <div className={`shell${collapsed ? " nav-collapsed" : ""}`}>
      <ThemeSync />
      <nav className="sidebar">
        {/* The campaign, on its own. It used to double as the heading of
            the first section, which made the name of the game also the
            label of a group of screens and left that one section unable
            to show a heading of its own. It is a block now, and every
            section below is an ordinary section. */}
        {/* The top of the sidebar is the campaign, and nothing above
            it. The wordmark used to sit here and said the same thing on
            every screen of every campaign — which is a logo's job on a
            marketing page and dead space in a tool you have open all
            evening. */}
        <div className="nav-campaign-block">
          <div className="nav-campaign-row">
            {/* Out, rather than up. It replaces the "All campaigns" row
                that used to sit in the footer among the places you go —
                leaving is not a place, and it belongs next to the thing
                you are leaving. */}
            <Link
              href="/"
              className="nav-back"
              title="All campaigns"
              aria-label="Back to all campaigns"
            >
              <BackIcon />
            </Link>

            {/* The campaign name doubles as the link to the live table.
                No GM badge beside it any more: the switch below says
                which of the two you are looking as, which is the same
                fact and the more useful half of it. Admin stays —
                borrowed authority is labelled, never disguised. */}
            <Link href={base} className="nav-campaign">
              <span className="nav-campaign-name">
                {campaign?.name ?? "Campaign"}
              </span>
              {campaign?.viaAdmin && <span className="badge admin">Admin</span>}
            </Link>
          </div>

          {/* Which of the two you are seeing, and one click to the
              other. It was a single button in the footer that changed
              its own label — so what it SAID and what you were looking
              at were the same word doing two jobs, and you read it to
              find out which.

              Two options with one marked cannot be a one-way door
              either, which the single button had to be careful about:
              both are drawn whenever you run this campaign, so the way
              back is on screen while you are in the preview. That is
              the structural check (runsThis), never the
              previewing-adjusted one. */}
          {runsThis && (
            <div className="view-as" role="group" aria-label="View as">
              <span className="view-as-label">View as:</span>
              <button
                type="button"
                className={`view-as-opt${previewing ? "" : " on"}`}
                aria-pressed={!previewing}
                onClick={() => void saveSettings({ viewAsPlayer: false })}
              >
                GM
              </button>
              <button
                type="button"
                className={`view-as-opt${previewing ? " on" : ""}`}
                title="See the app as a player in this campaign sees it"
                aria-pressed={previewing}
                onClick={() => void saveSettings({ viewAsPlayer: true })}
              >
                Player
              </button>
            </div>
          )}
        </div>

        {/* The sidebar, as this person arranged it. */}
        {sections.map((section) => {
          /* Only a titled section folds: the heading is all a folded
             one leaves on screen, so an untitled one would disappear
             with no way to bring it back. */
          const foldable = Boolean(section.title);
          const folded = foldable && Boolean(section.collapsed);
          return (
            <div className="nav-group" key={section.id}>
              {foldable && (
                <button
                  type="button"
                  className={`nav-group-title${folded ? " folded" : ""}`}
                  aria-expanded={!folded}
                  title={folded ? "Open this section" : "Fold this section up"}
                  onClick={() => toggleFold(section.id)}
                >
                  <span className="nav-fold" aria-hidden="true">
                    {folded ? "▸" : "▾"}
                  </span>
                  {section.title}
                  {/* No GM badge. Reported off: the section is only
                      RENDERED for the GM, so the pill told its one
                      possible reader something they already are. */}
                </button>
              )}
              {/* A collapsed rail shows every icon regardless of the
                  section folds: the headings that would explain a
                  folded gap are hidden, so honouring the fold would
                  just vanish those tools with no trace. */}
              {(collapsed || !folded) && (
                <NavList
                  items={section.items
                    .map((i) => NAV_ITEM_BY_ID.get(i.id))
                    .filter((i): i is NavItem => Boolean(i))}
                  base={base}
                  pathname={pathname}
                  isDm={isDm}
                  /* A rail of icons has nowhere to put a tray of
                     labelled sub-screens, so the caret is not offered
                     while it is collapsed — the tool's own front page
                     is one click away and has the same list on it. */
                  folded={collapsed ? undefined : foldedIds}
                  onToggleFold={collapsed ? undefined : toggleItemFold}
                />
              )}
            </div>
          );
        })}

        {/* Settings sits here rather than in the arranged sections
            above: it is the way back to the screen that arranges them,
            so a sidebar you could hide it from would be a door that
            locks from the inside. It is out of ALL_NAV_ITEMS for the
            same reason, which is also what stops it rendering twice. */}
        <div className="sidebar-footer">
          <Link
            href={`${base}/settings`}
            className={`nav-item${
              pathname === `${base}/settings` ? " active" : ""
            }`}
            title="Settings"
          >
            <span className="nav-icon">⚙</span>
            <span className="nav-label">Settings</span>
          </Link>
          {/* View as Player used to be here, and so was All campaigns.
              One is a switch about who you are and the other is the way
              out of the campaign; both belong with the campaign block
              at the top rather than filed among the places you go. */}
          <button
            type="button"
            className="nav-item subtle as-button"
            title="Send Feedback"
            onClick={() => setFeedbackOpen(true)}
          >
            <span className="nav-icon">✉</span>
            <span className="nav-label">Send Feedback</span>
          </button>
          <button
            type="button"
            className="nav-item subtle as-button"
            title="Sign out"
            onClick={() => {
              clearHistory();
              void signOut();
            }}
          >
            <span className="nav-icon">⏻</span>
            <span className="nav-label">Sign out</span>
          </button>
          {/* Airtable's arrow, asked for by screenshot: one press folds
              the sidebar to a thin rail of icons, the arrow flips, and
              the same press brings it back. Just the icon, larger — a
              "Collapse" label made it read as another nav row, and the
              name lives in the tooltip. */}
          <button
            type="button"
            className="nav-item subtle as-button nav-collapse-toggle"
            title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
            aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
            aria-expanded={!collapsed}
            onClick={() => void saveSettings({ sidebarCollapsed: !collapsed })}
          >
            <span className="nav-icon">{collapsed ? "»" : "«"}</span>
          </button>
        </div>
      </nav>

      <main className="workspace">{children}</main>

      {feedbackOpen && (
        <FeedbackForm onClose={() => setFeedbackOpen(false)} />
      )}
    </div>
    </UiProvider>
  );
}
