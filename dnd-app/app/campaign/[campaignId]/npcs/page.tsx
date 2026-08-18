"use client";

import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Id } from "@/convex/_generated/dataModel";
import { SignInForm } from "@/components/SignInForm";
import { NpcTable } from "@/components/NpcTable";

export default function NpcsPage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId as Id<"campaigns">;

  return (
    <>
      <AuthLoading>
        <p className="centered-note">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <div className="page page-wide">
          <header className="page-header">
            <h1>
              <Link href="/" className="wordmark">
                Table View
              </Link>
            </h1>
            <Link href={`/campaign/${campaignId}`} className="muted">
              ← Table
            </Link>
          </header>
          <NpcTable campaignId={campaignId} />
        </div>
      </Authenticated>
    </>
  );
}
