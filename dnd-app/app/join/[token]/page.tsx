"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SignInForm } from "@/components/SignInForm";
import { inviteMessage } from "@/components/inviteModel";

/**
 * The other end of an invite link.
 *
 * The one page in the app that shows something to a stranger, because
 * it has to: the person clicking has no account, and "sign up to find
 * out what you have been invited to" is not an invitation. So it names
 * the campaign and the DM first, and asks for an account second.
 *
 * The token stays in the URL the whole way through. Signing up
 * navigates nowhere — the sign-in form swaps itself for the Join button
 * in place — so the invite survives creating the account, which is the
 * step it exists to get somebody through.
 */
export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = String(params.token ?? "");
  const invite = useQuery(api.campaigns.peekInvite, { token });

  if (invite === undefined) {
    return <p className="centered-note">Checking the invite…</p>;
  }

  if (!invite.ok) {
    return (
      <div className="page join-page">
        <h1>Invite</h1>
        <p className="form-error">{inviteMessage(invite.problem)}</p>
      </div>
    );
  }

  return (
    <div className="page join-page">
      <section className="join-card">
        <p className="settings-note">You have been invited to</p>
        <h1>{invite.campaignName}</h1>
        <p className="join-dm">Run by {invite.dmName}</p>
        {invite.characterName && (
          <p className="settings-note">
            A character is waiting for you: <strong>{invite.characterName}</strong>
          </p>
        )}

        <AuthLoading>
          <p className="centered-note">Loading…</p>
        </AuthLoading>

        <Unauthenticated>
          <p className="settings-note join-hint">
            Create an account to join. If you already have one, sign in and
            you will be added to the campaign.
          </p>
          <SignInForm />
        </Unauthenticated>

        <Authenticated>
          <JoinButton token={token} campaignName={invite.campaignName} />
        </Authenticated>
      </section>
    </div>
  );
}

/**
 * Declared at module level, never inside JoinPage.
 *
 * A component defined during render is a new component type every
 * render, so React remounts it — and the integrity guard fails on it,
 * which is how that rule stopped being one somebody has to remember.
 */
function JoinButton({
  token,
  campaignName,
}: {
  token: string;
  campaignName: string;
}) {
  const router = useRouter();
  const accept = useMutation(api.campaigns.acceptInvite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="join-actions">
      {error && <p className="form-error">{error}</p>}
      <button
        type="button"
        className="npc-btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setError(null);
            const campaignId = await accept({ token });
            // Straight into the campaign, not back to a picker. The
            // link said which game this was; landing on a list of games
            // makes you choose it again.
            router.push(`/campaign/${campaignId}`);
          } catch (e) {
            setBusy(false);
            setError(
              e instanceof Error ? e.message : "Could not join the campaign."
            );
          }
        }}
      >
        {busy ? "Joining…" : `Join ${campaignName}`}
      </button>
    </div>
  );
}
