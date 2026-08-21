"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { THEMES } from "@/components/themes";
import { RULES_VERSIONS } from "@/components/lookupFilters";

/**
 * Settings.
 *
 * Almost everything here is PERSONAL — theme, preview mode, break-glass
 * admin — and affects only the person changing it. The rules edition is
 * the exception: it belongs to the campaign, so it is DM-only, labelled
 * as shared, and kept in its own section rather than mixed in with the
 * choices that stop at your own browser.
 *
 * The theme list is shared with the ribbon's theme control rather than
 * repeated here: a theme offered in one place and not the other is a
 * palette some people can never reach.
 */

export function SettingsPanel({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const settings = useQuery(api.settings.mySettings);
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const save = useMutation(api.settings.saveMySettings);
  const setRulesVersion = useMutation(api.campaigns.setRulesVersion);

  if (settings === undefined || campaigns === undefined) {
    return <p className="centered-note">Loading settings…</p>;
  }

  const current = campaigns.find((c) => c._id === campaignId) ?? null;
  const owned = campaigns.filter((c) => c.isDm);
  const played = campaigns.filter((c) => !c.isDm && !c.viaAdmin);
  const borrowed = campaigns.filter((c) => c.viaAdmin);

  return (
    <div className="settings">
      <section className="settings-block">
        <h2>Roles</h2>
        <p className="settings-note">
          Roles are per campaign, so you hold several at once: DM of the ones
          you created, player in the ones you were added to. There is nothing
          to switch — you are the DM of a campaign because you own it.
        </p>

        <ul className="role-list">
          {owned.map((c) => (
            <li key={c._id}>
              <span className="badge">DM</span> {c.name}
            </li>
          ))}
          {played.map((c) => (
            <li key={c._id}>
              <span className="badge player">Player</span> {c.name}
            </li>
          ))}
          {borrowed.map((c) => (
            <li key={c._id}>
              <span className="badge admin">Admin</span> {c.name}
              <span className="settings-note"> — not yours; opened by override</span>
            </li>
          ))}
        </ul>

        {settings.adminEligible && (
          <p className="settings-note">
            You are also a <strong>platform admin</strong>.
          </p>
        )}

        {(current?.isDm || settings.adminOverride) && (
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
                this is a real preview, not a mask. It outranks admin access,
                so it stays truthful either way. You can still edit.
              </span>
            </span>
          </label>
        )}
      </section>

      {settings.adminEligible && (
        <section className="settings-block admin-block">
          <h2>Platform admin</h2>
          <p className="settings-note">
            You&apos;re on the <code>ADMIN_EMAILS</code> list for this
            deployment, which is the only place this can be granted — no
            mutation, table, or setting can hand it to anyone, so changing who
            is an admin needs deployment access rather than app access.
          </p>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.adminOverride ?? false}
              onChange={(e) => void save({ adminOverride: e.target.checked })}
            />
            <span>
              <strong>Admin override</strong>
              <br />
              <span className="settings-note">
                Opens <em>every</em> campaign with DM-level access, including
                secrets and DM notes, so you can diagnose and repair. Off by
                default and meant to be turned off again — leaving it on would
                quietly spoil any campaign you&apos;re only a player in.
                Campaigns you reach this way are labelled <em>Admin</em> above
                rather than shown as yours.
              </span>
            </span>
          </label>
        </section>
      )}

      {current?.isDm && (
        <section className="settings-block">
          <h2>Rules edition</h2>
          <p className="settings-note">
            <strong>Campaign-wide, and yours to set as DM</strong> — unlike
            everything else on this page, this one changes what your players
            see too.
          </p>
          <p className="settings-note">
            A D&amp;D Beyond import carries both printings of the core books,
            so most spells, items and monsters exist twice under one name.
            This picks which of the pair Lookup shows. It does not filter by
            book: Tasha&apos;s, Xanathar&apos;s and every adventure have no
            counterpart in the other edition and show either way.
          </p>
          <div className="theme-options">
            {RULES_VERSIONS.map((r) => (
              <button
                type="button"
                key={r.value}
                className={`theme-option${
                  (current.rulesVersion ?? "2014") === r.value ? " on" : ""
                }`}
                onClick={() =>
                  void setRulesVersion({
                    campaignId,
                    rulesVersion: r.value,
                  })
                }
              >
                <span className="theme-name">{r.label}</span>
                <span className="settings-note">{r.note}</span>
              </button>
            ))}
          </div>
        </section>
      )}

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
          page; anything campaign-wide belongs to the DM and is labelled as
          such, the way the rules edition above is.
        </p>
      </section>
    </div>
  );
}
