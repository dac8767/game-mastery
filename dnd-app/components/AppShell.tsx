"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/**
 * The application frame: navigation on the left, the selected thing on
 * the right.
 *
 * A section with no `slug` isn't built yet and renders as a disabled
 * item rather than a link, so the shape of the app is visible without
 * dead routes that 404. To bring one online, add its page under
 * app/campaign/[campaignId]/<slug>/ and give it a `slug` here.
 */

type NavItem = {
  label: string;
  icon: string;
  /** Path segment under /campaign/[id]. Omitted = not built yet. */
  slug?: string;
};

/** Content scoped to the campaign. Titled with the campaign's name. */
const CAMPAIGN_ITEMS: NavItem[] = [
  { label: "Sessions", icon: "✦" },
  { label: "NPCs", icon: "☾", slug: "npcs" },
  { label: "Shops", icon: "⌂" },
  { label: "Locations", icon: "⌖" },
  { label: "Calendar", icon: "◷" },
];

const TOOL_ITEMS: NavItem[] = [
  { label: "Dice Roller", icon: "⚄" },
  { label: "Combat Tracker", icon: "⚔" },
  { label: "Notebook", icon: "✎" },
  { label: "Scheduler", icon: "⏱" },
];

const ASSET_ITEMS: NavItem[] = [
  { label: "Dynamic Maps", icon: "▦" },
  { label: "Static Maps", icon: "▤" },
  { label: "Miniatures", icon: "♟" },
];

function NavList({
  items,
  base,
  pathname,
}: {
  items: NavItem[];
  base: string;
  pathname: string;
}) {
  return (
    <ul className="nav-list">
      {items.map((item) => {
        if (item.slug === undefined) {
          return (
            <li key={item.label}>
              <span className="nav-item disabled">
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                <span className="soon">soon</span>
              </span>
            </li>
          );
        }
        const href = item.slug ? `${base}/${item.slug}` : base;
        return (
          <li key={item.label}>
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

  return (
    <div className="shell">
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
          </Link>
          <NavList items={CAMPAIGN_ITEMS} base={base} pathname={pathname} />
        </div>

        <div className="nav-group">
          <div className="nav-group-title">Tools</div>
          <NavList items={TOOL_ITEMS} base={base} pathname={pathname} />
        </div>

        <div className="nav-group">
          <div className="nav-group-title">Asset Library</div>
          <NavList items={ASSET_ITEMS} base={base} pathname={pathname} />
        </div>

        <div className="sidebar-footer">
          <Link href="/" className="nav-item subtle">
            <span className="nav-icon">⇤</span>
            All campaigns
          </Link>
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
    </div>
  );
}
