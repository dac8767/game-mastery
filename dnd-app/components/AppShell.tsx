"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ReactNode, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { ThemeSync } from "@/components/ThemeSync";
import { FeedbackForm } from "@/components/FeedbackForm";
import { Id } from "@/convex/_generated/dataModel";
import {
  ALL_NAV_ITEMS,
  NAV_ITEM_BY_ID,
  NavItem,
  SIDEBAR_GROUPS,
  navHref,
} from "@/components/navItems";
import {
  defaultSidebar,
  reconcileSidebar,
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
                <span className="nav-icon">{item.icon}</span>
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
              <span className="nav-icon">{item.icon}</span>
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
  /** Trailing crumb — the campaign name is prepended automatically. */
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

  /**
   * The sidebar this person arranged, or the shipped grouping.
   *
   * Reconciled against what the app actually has either way: a layout
   * saved before a tool shipped has no opinion about it, and an item
   * the layout does not mention would be unreachable rather than
   * hidden — no menu entry, and no hint that there is one to un-hide.
   */
  const sections = useMemo(() => {
    const allowed = ALL_NAV_ITEMS.filter((i) => isDm || !i.dmOnly).map(
      (i) => i.id
    );
    const layout = reconcileSidebar(
      settings?.sidebar ?? defaultSidebar(SIDEBAR_GROUPS),
      ALL_NAV_ITEMS.map((i) => i.id)
    );
    return visibleSidebar(layout, allowed);
  }, [settings?.sidebar, isDm]);

  // The first section sits under the campaign name rather than under a
  // heading of its own — the campaign IS its heading.
  const firstSection = (sections[0]?.items ?? [])
    .map((i) => NAV_ITEM_BY_ID.get(i.id))
    .filter((i): i is NavItem => Boolean(i));
  const restSections = sections.slice(1);

  return (
    <div className="shell">
      <ThemeSync />
      <nav className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">GM</span>
          <span className="brand-name">Game Mastery</span>
        </Link>

        <div className="nav-group">
          {/* The campaign name doubles as the link to the live table. */}
          <Link href={base} className="nav-campaign">
            <span className="nav-campaign-icon">☾</span>
            <span className="nav-campaign-name">
              {campaign?.name ?? "Campaign"}
            </span>
            {campaign?.isDm && <span className="badge">DM</span>}
            {campaign?.viaAdmin && <span className="badge admin">Admin</span>}
          </Link>
          <NavList
            items={firstSection}
            base={base}
            pathname={pathname}
            isDm={isDm}
          />
        </div>

        {/* The rest of the sidebar, as this person arranged it. The
            campaign block above stays put because the campaign name is
            the header of the whole thing, not an item in a list. */}
        {restSections.map((section) => (
          <div className="nav-group" key={section.id}>
            {section.title && (
              <div className="nav-group-title">{section.title}</div>
            )}
            <NavList
              items={section.items
                .map((i) => NAV_ITEM_BY_ID.get(i.id))
                .filter((i): i is NavItem => Boolean(i))}
              base={base}
              pathname={pathname}
              isDm={isDm}
            />
          </div>
        ))}

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
          {runsThis && (
            <button
              type="button"
              className={`nav-item as-button${previewing ? " active" : ""}`}
              title="See the app as a player in this campaign sees it"
              onClick={() => void saveSettings({ viewAsPlayer: !previewing })}
            >
              <span className="nav-icon">{previewing ? "◉" : "◎"}</span>
              {previewing ? "Viewing as player" : "View as Player"}
            </button>
          )}
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

      <main className="workspace">
        <div className="crumbs">
          <Link href={base}>{campaign?.name ?? "Campaign"}</Link>
          <span className="sep">›</span>
          <span className="current">{breadcrumb}</span>
        </div>
        {children}
      </main>

      {feedbackOpen && (
        <FeedbackForm onClose={() => setFeedbackOpen(false)} />
      )}
    </div>
  );
}
