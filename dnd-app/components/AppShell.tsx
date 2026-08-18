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
 * Sections that aren't built yet are rendered as disabled items rather
 * than links, so the shape of the app is visible without dead routes
 * that 404. Flip `href` on for a section as it lands.
 */

type Section = {
  label: string;
  /** Path segment under /campaign/[id]; "" is the campaign root. */
  slug?: string;
  icon: string;
};

/** Content sections scoped to one campaign. */
const CAMPAIGN_SECTIONS: Section[] = [
  { label: "NPCs", slug: "npcs", icon: "☾" },
  { label: "Table", slug: "", icon: "▦" },
  { label: "Library", icon: "❋" },
  { label: "Shops", icon: "⌂" },
  { label: "Locations", icon: "⌖" },
  { label: "Calendar", icon: "◷" },
];

/** Cross-campaign tools. None of these are built yet. */
const TOOL_SECTIONS: Section[] = [
  { label: "Tools & Resources", icon: "⚒" },
  { label: "Combat", icon: "⚔" },
  { label: "Dungeon Master", icon: "✦" },
  { label: "Asset Library", icon: "▤" },
];

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
          <div className="nav-campaign">
            <span className="nav-campaign-icon">☾</span>
            <span className="nav-campaign-name">
              {campaign?.name ?? "Campaign"}
            </span>
            {campaign?.isDm && <span className="badge">DM</span>}
          </div>

          <ul className="nav-list">
            {CAMPAIGN_SECTIONS.map((s) => {
              if (s.slug === undefined) {
                return (
                  <li key={s.label}>
                    <span className="nav-item disabled">
                      <span className="nav-icon">{s.icon}</span>
                      {s.label}
                      <span className="soon">soon</span>
                    </span>
                  </li>
                );
              }
              const href = s.slug ? `${base}/${s.slug}` : base;
              const active = pathname === href;
              return (
                <li key={s.label}>
                  <Link
                    href={href}
                    className={`nav-item${active ? " active" : ""}`}
                  >
                    <span className="nav-icon">{s.icon}</span>
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="nav-group">
          <ul className="nav-list">
            {TOOL_SECTIONS.map((s) => (
              <li key={s.label}>
                <span className="nav-item disabled">
                  <span className="nav-icon">{s.icon}</span>
                  {s.label}
                  <span className="soon">soon</span>
                </span>
              </li>
            ))}
          </ul>
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
