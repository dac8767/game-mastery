"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  INVITE_LIMITS,
  expiryText,
  inviteUrl,
} from "@/components/inviteModel";

/**
 * The DM's invite links.
 *
 * addMemberByEmail beside this can only add an account that already
 * exists, which made inviting somebody a conversation: make an account,
 * tell me the address, then I'll add you. A link collapses that into one
 * step, and is the only way in for a person who is not in the database
 * yet.
 *
 * Every link dies three ways — a clock, a counter, and this Cancel
 * button — because a link that never expires is a permanent
 * unauthenticated door into the campaign, and links end up in group
 * chats.
 */
export function InvitePanel({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const invites = useQuery(api.campaigns.listInvites, { campaignId });
  const characters = useQuery(api.campaigns.listCharacters, { campaignId });
  const create = useMutation(api.campaigns.createInvite);
  const revoke = useMutation(api.campaigns.revokeInvite);

  const [days, setDays] = useState(String(INVITE_LIMITS.defaultDays));
  const [uses, setUses] = useState(String(INVITE_LIMITS.defaultUses));
  const [characterId, setCharacterId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Read at render rather than stored: the app runs on localhost in
  // development and on Vercel in production, and a link built from a
  // saved origin is a link to the wrong host for the rest of its life.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  // Characters nobody has claimed — the only ones worth handing out.
  // A claimed sheet already has an account behind it, and offering it
  // again would be offering somebody else's character.
  const unclaimed = (characters ?? []).filter((c) => c.playerId === undefined);

  return (
    <section className="settings-block">
      <h2>Invite links</h2>
      <p className="settings-note">
        A link anyone can follow to create an account and land in this
        campaign. Use it for someone who has not signed up yet — for an
        account that already exists, adding them by email above is one
        step fewer. Every link expires, admits a fixed number of people,
        and can be cancelled here.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="invite-new">
        <label className="npc-select">
          Lasts
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>

        <label className="npc-select">
          Admits
          <select value={uses} onChange={(e) => setUses(e.target.value)}>
            <option value="1">1 person</option>
            <option value="2">2 people</option>
            <option value="4">4 people</option>
            <option value="6">6 people</option>
            <option value="10">10 people</option>
          </select>
        </label>

        {unclaimed.length > 0 && (
          <label className="npc-select">
            Character
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
            >
              <option value="">None</option>
              {unclaimed.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          className="npc-btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setError(null);
              await create({
                campaignId,
                days: Number(days),
                uses: Number(uses),
                characterId: characterId
                  ? (characterId as Id<"characters">)
                  : undefined,
              });
              setCharacterId("");
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not make a link."
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Making…" : "New invite link"}
        </button>
      </div>

      {invites === undefined ? (
        <p className="settings-note">Loading links…</p>
      ) : invites.length === 0 ? (
        <p className="settings-note">No links yet.</p>
      ) : (
        <ul className="invite-list">
          {invites.map((invite) => {
            const url = inviteUrl(origin, invite.token);
            const dead =
              invite.revokedAt !== undefined ||
              invite.expiresAt <= Date.now() ||
              invite.usesLeft <= 0;
            return (
              <li
                key={invite._id}
                className={`invite-row${dead ? " dead" : ""}`}
              >
                {/* Readonly rather than a link: this is something to
                    copy and paste into a chat, and clicking it would
                    spend the DM's own invite on the DM. */}
                <input
                  className="detail-input invite-url"
                  value={url}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span className="settings-note invite-facts">
                  {invite.revokedAt !== undefined
                    ? "cancelled"
                    : `${expiryText(invite.expiresAt, Date.now())} · ${
                        invite.usesLeft
                      } left`}
                  {invite.characterName ? ` · ${invite.characterName}` : ""}
                </span>

                {!dead && (
                  <>
                    <button
                      type="button"
                      className="npc-btn"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(url);
                          setCopied(invite._id);
                        } catch {
                          // Refused clipboard access. The link is in a
                          // field on screen either way, so say nothing
                          // rather than claim it was copied.
                          setCopied(null);
                        }
                      }}
                    >
                      {copied === invite._id ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void revoke({ inviteId: invite._id })}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
