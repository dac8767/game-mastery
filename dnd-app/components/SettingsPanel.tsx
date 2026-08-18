"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/**
 * Personal settings. Everything here affects only the person changing
 * it — theme, preview mode, and later whatever else belongs to one
 * person rather than to the campaign.
 */

const THEMES: { value: "candlelight" | "slate" | "parchment"; label: string; note: string }[] =
  [
    {
      value: "candlelight",
      label: "Candlelight",
      note: "Warm and dim — built for a dark room and a bright map.",
    },
    {
      value: "slate",
      label: "Slate",
      note: "Cool grey-blue, higher contrast for long reading.",
    },
    {
      value: "parchment",
      label: "Parchment",
      note: "Light theme for bright rooms and printing.",
    },
  ];

export function SettingsPanel({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const settings = useQuery(api.settings.mySettings);
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const save = useMutation(api.settings.saveMySettings);

  if (settings === undefined || campaigns === undefined) {
    return <p className="centered-note">Loading settings…</p>;
  }

  const campaign = campaigns.find((c) => c._id === campaignId) ?? null;
  const isDm = Boolean(campaign?.isDm);

  return (
    <div className="settings">
      <section className="settings-block">
        <h2>Role</h2>
        <p className="settings-value">
          {isDm ? (
            <>
              <strong>Dungeon Master</strong> of {campaign?.name}
            </>
          ) : (
            <>
              <strong>Player</strong> in {campaign?.name}
            </>
          )}
        </p>
        <p className="settings-note">
          Your role isn&apos;t a setting — it&apos;s whoever owns the campaign.
          You are the DM of a campaign if you created it, and a player
          otherwise. Deliberately not switchable here: if role were a
          preference, any player could tick a box and read every secret and
          DM note in the campaign. To hand a campaign to someone else, the
          current DM transfers it.
        </p>

        {isDm && (
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.viewAsPlayer}
              onChange={(e) => void save({ viewAsPlayer: e.target.checked })}
            />
            <span>
              <strong>View as a player</strong>
              <br />
              <span className="settings-note">
                Serves you the player&apos;s view so you can check what
                you&apos;re giving away. The server genuinely withholds the
                data — hidden NPCs and DM fields never reach the browser — so
                this is a real preview, not a mask. You can still edit.
              </span>
            </span>
          </label>
        )}
      </section>

      <section className="settings-block">
        <h2>Theme</h2>
        <p className="settings-note">
          Yours alone. Changing it doesn&apos;t touch anyone else&apos;s view.
        </p>
        <div className="theme-options">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.value}
              className={`theme-option${
                settings.theme === t.value ? " on" : ""
              }`}
              onClick={() => void save({ theme: t.value })}
            >
              <span className={`theme-swatch theme-${t.value}`} />
              <span className="theme-name">{t.label}</span>
              <span className="settings-note">{t.note}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-block">
        <h2>Coming here later</h2>
        <p className="settings-note">
          Dice-roll defaults, notification preferences, portrait style for AI
          generation, and per-table density. Anything personal belongs on this
          page; anything campaign-wide belongs to the DM.
        </p>
      </section>
    </div>
  );
}
