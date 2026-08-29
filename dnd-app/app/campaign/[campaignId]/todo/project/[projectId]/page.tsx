"use client";

import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import { SignInForm } from "@/components/SignInForm";
import { AppShell } from "@/components/AppShell";
import { TodoProjectView } from "@/components/TodoProjects";

/**
 * One project's list.
 *
 * Not a nav slug, deliberately: the sidebar's contents are a static
 * module read by the ribbon and by the guards, neither of which can
 * call a query to find out what a campaign's projects are called. The
 * Projects screen lists them; this is where its rows lead.
 */
export default function TodoProjectPage() {
  const params = useParams<{ campaignId: string; projectId: string }>();
  const campaignId = params.campaignId as Id<"campaigns">;
  const projectId = params.projectId as Id<"todoProjects">;

  return (
    <>
      <AuthLoading>
        <p className="centered-note">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <AppShell campaignId={campaignId} breadcrumb="Project · To-Do">
          <TodoProjectView campaignId={campaignId} projectId={projectId} />
        </AppShell>
      </Authenticated>
    </>
  );
}
