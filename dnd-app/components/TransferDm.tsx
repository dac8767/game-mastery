"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/**
 * Handing a campaign to someone else.
 *
 * For the case where you set a game up and someone else runs it. It is
 * a one-field change — authority here is `campaign.dmId === userId`, not
 * a role somewhere that could fall out of step — so everything in the
 * app follows the moment it lands.
 *
 * Confirmed rather than typed, unlike deleting: this is reversible by
 * the person you hand it to, and it destroys nothing. But it does hand
 * over your ability to hand it back, which the dialog says plainly.
 */
export function TransferDm({
  campaignId,
  campaignName,
}: {
  campaignId: Id<"campaigns">;
  campaignName: string;
}) {
  const members = useQuery(api.campaigns.listMembers, { campaignId });
  const transfer = useMutation(api.campaigns.transferDm);
  const [picked, setPicked] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = members?.find((m) => m.userId === picked) ?? null;

  return (
    <section className="settings-block">
      <h2>Hand over the DM role</h2>
      <p className="settings-note">
        Made a campaign for someone else to run? Give it to them.
      </p>

      {members === undefined ? (
        <p className="settings-note">Loading the table…</p>
      ) : members.length === 0 ? (
        <p className="settings-note">
          Nobody else is in this campaign yet. Add a player first — the DM has
          to be someone at the table.
        </p>
      ) : (
        <div className="transfer-dm">
          <label className="settings-field">
            <span>Make DM</span>
            <select
              value={picked}
              onChange={(e) => {
                setPicked(e.target.value);
                setError(null);
              }}
            >
              <option value="">Choose someone…</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="text-button"
            disabled={!picked}
            onClick={() => setConfirming(true)}
          >
            Hand over…
          </button>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      {confirming && target && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirming(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true">
            <h2>Make {target.displayName} the DM?</h2>
            <p>
              They get full control of <strong>{campaignName}</strong> — DM
              notes, hidden NPCs, secrets, every setting, and the ability to
              delete it.
            </p>
            <p>
              You stay in the campaign as a player, so you keep access. But you
              will not be able to take it back yourself: only{" "}
              {target.displayName} can hand it on from then.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await transfer({
                      campaignId,
                      toUserId: target.userId as Id<"users">,
                    });
                    setConfirming(false);
                    setPicked("");
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : "Could not hand it over"
                    );
                    setConfirming(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Handing over…" : `Make ${target.displayName} the DM`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
