"use client";

import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import { SignInForm } from "@/components/SignInForm";
import { AppShell } from "@/components/AppShell";
import { SettingsPanel } from "@/components/SettingsPanel";

export default function SettingsPage() {
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
        <AppShell campaignId={campaignId} breadcrumb="Settings">
          <SettingsPanel campaignId={campaignId} />
        </AppShell>
      </Authenticated>
    </>
  );
}
