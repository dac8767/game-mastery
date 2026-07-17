"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";

export function CampaignList() {
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const { signOut } = useAuthActions();

  return (
    <div className="page">
      <header className="page-header">
        <h1>
          <span className="wordmark">Table View</span>
        </h1>
        <button type="button" className="text-button" onClick={() => signOut()}>
          Sign out
        </button>
      </header>

      {campaigns === undefined ? (
        <p className="centered-note">Loading campaigns…</p>
      ) : campaigns.length === 0 ? (
        <p className="centered-note">
          You&apos;re not in a campaign yet. Ask your DM to add you — they need
          the email you signed up with.
        </p>
      ) : (
        <ul className="campaign-list">
          {campaigns.map((campaign) => (
            <li key={campaign._id}>
              <Link
                href={`/campaign/${campaign._id}`}
                className="campaign-card"
              >
                <span className="name">
                  {campaign.name}
                  {campaign.isDm && <span className="badge">DM</span>}
                </span>
                {campaign.description && (
                  <span className="description">{campaign.description}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
