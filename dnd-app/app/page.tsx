"use client";

import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { SignInForm } from "@/components/SignInForm";
import { CampaignList } from "@/components/CampaignList";

export default function HomePage() {
  return (
    <>
      <AuthLoading>
        <p className="centered-note">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <CampaignList />
      </Authenticated>
    </>
  );
}
