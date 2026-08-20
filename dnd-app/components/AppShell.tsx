"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ReactNode, useState } from "react";
import { api } from "@/convex/_generated/api";
import { ThemeSync } from "@/components/ThemeSync";
import { FeedbackForm } from "@/components/FeedbackForm";
import { Id } from "@/convex/_generated/dataModel";
import {
  ASSET_ITEMS,
  CAMPAIGN_ITEMS,
  LOOKUP_ITEMS,
  NavItem,
  TOOL_ITEMS,
  navHref,
} from "@/components/navItems";

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
  const { signOut } = useAuthActions();

  const campaign = campaigns?.find((c) => c._id === campaignId) ?? null;
  const base = `/campaign/${campaignId}`;
  const isDm = campaign?.isDm ?? false;
  const [feedbackOpen, setFeedbackOpen] = useState(false);

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
            items={CAMPAIGN_ITEMS}
            base={base}
            pathname={pathname}
            isDm={isDm}
          />
        </div>

        <div className="nav-group">
          <div className="nav-group-title">Tools</div>
          <NavList
            items={TOOL_ITEMS}
            base={base}
            pathname={pathname}
            isDm={isDm}
          />
        </div>

        <div className="nav-group">
          <div className="nav-group-title">Lookup</div>
          <NavList
            items={LOOKUP_ITEMS}
            base={base}
            pathname={pathname}
            isDm={isDm}
          />
        </div>

        <div className="nav-group">
          <div className="nav-group-title">Asset Library</div>
          <NavList
            items={ASSET_ITEMS}
            base={base}
            pathname={pathname}
            isDm={isDm}
          />
        </div>

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
