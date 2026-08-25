"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { NavIcon } from "@/components/NavIcon";
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
  toggleSectionCollapsed,
  visibleSidebar,
} from "@/components/sidebarLayout";

/**
 * The application frame: navigation on the left, the selected thing on
 * the right.
 *
 * The customizable ribbon deliberately does NOT live here. It belongs to
 * the DM Screen and nowhere else, so every other screen keeps its full
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
}: {
  items: NavItem[];
  base: string;
  pathname: string;
  isDm: boolean;
}) {
  return (
    <ul className="nav-list">
      {items.filter((item) => isDm || !item.dmOnly).map((item) => {
        if (item.slug === undefined) {
          return (
            <li key={item.id}>
              <span className="nav-item disabled">
                <NavIcon icon={item.icon} art={item.art} />
                {item.label}
                <span className="soon">soon</span>
              </span>
            </li>
          );
        }
        const href = navHref(item, base);
        return (
          <li key={item.id}>
            <Link
              href={href}
              className={`nav-item${pathname === href ? " active" : ""}`}
            >
              <NavIcon icon={item.icon} art={item.art} />
              {item.label}
            </Link>
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
   * runsThis is structural — you are the DM of this campaign — and is
   * what decides whether the View as Player switch is offered at all.
   * isDm is what the sidebar filters on, and the preview turns it off
   * so the DM-only screens go away like they would for a player.
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

  return (
    /* The provider wraps the whole shell, not one screen: edit mode has
       to survive walking to another screen to change that one, and the
       bar it puts along the bottom is mounted here so it does. */
    <UiProvider
      campaignId={campaignId}
      canEdit={isDm}
      previewing={runsThis && previewing}
    >
    <div className="shell">
      <ThemeSync />
      <nav className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">GM</span>
          <span className="brand-name">Game Mastery</span>
        </Link>

        {/* The campaign, on its own. It used to double as the heading of
            the first section, which made the name of the game also the
            label of a group of screens and left that one section unable
            to show a heading of its own. It is a block now, and every
            section below is an ordinary section. */}
        <div className="nav-campaign-block">
          {/* The campaign name doubles as the link to the live table.
              No DM badge beside it any more: the switch below says
              which of the two you are looking as, which is the same
              fact and the more useful half of it. Admin stays —
              borrowed authority is labelled, never disguised. */}
          <Link href={base} className="nav-campaign">
            <span className="nav-campaign-icon">☾</span>
            <span className="nav-campaign-name">
              {campaign?.name ?? "Campaign"}
            </span>
            {campaign?.viaAdmin && <span className="badge admin">Admin</span>}
          </Link>

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
                DM
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
                  {section.dmOnly && <span className="badge">DM</span>}
                </button>
              )}
              {!folded && (
                <NavList
                  items={section.items
                    .map((i) => NAV_ITEM_BY_ID.get(i.id))
                    .filter((i): i is NavItem => Boolean(i))}
                  base={base}
                  pathname={pathname}
                  isDm={isDm}
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
          >
            <span className="nav-icon">⚙</span>
            Settings
          </Link>
          {/* View as Player used to be here. It is a switch about who
              you are, which belongs with the campaign it is about,
              rather than a place to go filed with the places. */}
          <Link href="/" className="nav-item subtle">
            <span className="nav-icon">⇤</span>
            All campaigns
          </Link>
          <button
            type="button"
            className="nav-item subtle as-button"
            onClick={() => setFeedbackOpen(true)}
          >
            <span className="nav-icon">✉</span>
            Send Feedback
          </button>
          <button
            type="button"
            className="nav-item subtle as-button"
            onClick={() => signOut()}
          >
            <span className="nav-icon">⏻</span>
            Sign out
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
