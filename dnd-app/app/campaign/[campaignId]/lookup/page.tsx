"use client";

import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import { SignInForm } from "@/components/SignInForm";
import { AppShell } from "@/components/AppShell";
import { LookupScreen } from "@/components/LookupScreen";

export default function LookupPage() {
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
        <AppShell campaignId={campaignId} breadcrumb="Lookup">
          <LookupScreen campaignId={campaignId} />
        </AppShell>
      </Authenticated>
    </>
  );
}
