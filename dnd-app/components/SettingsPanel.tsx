"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { THEMES } from "@/components/themes";
import { RULES_VERSIONS } from "@/components/lookupFilters";
import { DATE_FORMATS, formatCardDate } from "@/components/campaignCard";
import { NpcTemplateDesigner } from "@/components/NpcTemplateDesigner";
import { NameField } from "@/components/NameField";
import { TransferDm } from "@/components/TransferDm";
import { CampaignDetails } from "@/components/CampaignDetails";
import { CampaignRoster } from "@/components/CampaignRoster";
import { resolveTab, visibleTabs } from "@/components/settingsTabs";

/**
 * Settings, in five tabs.
 *
 * The tabs are declared in settingsTabs.ts and both the strip and the
 * panels read that one list, so a tab cannot exist without a panel or a
 * panel without a way to reach it.
 *
 * The division is by WHOSE setting a thing is rather than by subject.
 * Most of this page is personal and stops at your own browser; the
 * Campaign, Game Master and Players tabs are shared and DM-only, and
 * each says so at the top rather than relying on you to remember which
 * kind you are looking at.
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
  const [selected, setSelected] = useState<string>("general");

  if (settings === undefined || campaigns === undefined) {
    return <p className="centered-note">Loading settings…</p>;
  }

  const current = campaigns.find((c) => c._id === campaignId) ?? null;
  const owned = campaigns.filter((c) => c.isDm);
  const played = campaigns.filter((c) => !c.isDm && !c.viaAdmin);
  const borrowed = campaigns.filter((c) => c.viaAdmin);

  // Admin override borrows DM authority, and the DM tabs are how you use
  // it — so they open on the same terms the rest of the app grants it.
  const isDm = Boolean(current?.isDm || settings.adminOverride);
  const tabs = visibleTabs(isDm);
  const tab = resolveTab(selected, isDm);
  const active = tabs.find((t) => t.id === tab);

  return (
    <div className="settings">
      <div className="settings-tabs" role="tablist" aria-label="Settings">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={`settings-tab${t.id === tab ? " on" : ""}`}
            onClick={() => setSelected(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active && <p className="settings-blurb">{active.blurb}</p>}

      {tab === "general" && (
        <>
          <section className="settings-block">
            <h2>Your name</h2>
            <p className="settings-note">
              What everyone else sees you called — on a campaign card, as the
              DM of the games you run, and beside anything you write. Until you
              set it you show up as &ldquo;the DM&rdquo;.
            </p>
            <NameField current={settings.displayName} />
          </section>

          <section className="settings-block">
            <h2>Dates</h2>
            <p className="settings-note">
              Only about how dates are written — not what they mean. In-world
              dates use the campaign calendar under Tools, which has its own
              months.
            </p>
            <div className="theme-options">
              {DATE_FORMATS.map((f) => (
                <button
                  type="button"
                  key={f.value}
                  className={`theme-option${
                    (settings.dateFormat ?? "dmy") === f.value ? " on" : ""
                  }`}
                  onClick={() => void save({ dateFormat: f.value })}
                >
                  <span className="theme-name">{f.label}</span>
                  <span className="settings-note">
                    {formatCardDate("2026-09-05", f.value)}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-block">
            <h2>Roles</h2>
            <p className="settings-note">
              Roles are per campaign, so you hold several at once: DM of the
              ones you created, player in the ones you were added to. There is
              nothing to switch — you are the DM of a campaign because you own
              it.
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
                  <span className="settings-note">
                    {" "}
                    — not yours; opened by override
                  </span>
                </li>
              ))}
            </ul>

            {settings.adminEligible && (
              <p className="settings-note">
                You are also a <strong>platform admin</strong>.
              </p>
            )}
          </section>

          {settings.adminEligible && (
            <section className="settings-block admin-block">
              <h2>Platform admin</h2>
              <p className="settings-note">
                You&apos;re on the <code>ADMIN_EMAILS</code> list for this
                deployment, which is the only place this can be granted — no
                mutation, table, or setting can hand it to anyone, so changing
                who is an admin needs deployment access rather than app access.
              </p>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.adminOverride ?? false}
                  onChange={(e) =>
                    void save({ adminOverride: e.target.checked })
                  }
                />
                <span>
                  <strong>Admin override</strong>
                  <br />
                  <span className="settings-note">
                    Opens <em>every</em> campaign with DM-level access,
                    including secrets and DM notes, so you can diagnose and
                    repair. Off by default and meant to be turned off again —
                    leaving it on would quietly spoil any campaign you&apos;re
                    only a player in. Campaigns you reach this way are labelled{" "}
                    <em>Admin</em> above rather than shown as yours.
                  </span>
                </span>
              </label>
            </section>
          )}
        </>
      )}

      {tab === "campaign" && (
        <>
          <CampaignDetails campaignId={campaignId} />

          <section className="settings-block">
            <h2>Rules edition</h2>
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
                    (current?.rulesVersion ?? "2014") === r.value ? " on" : ""
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

          {isDm && <NpcTemplateDesigner campaignId={campaignId} />}
        </>
      )}

      {tab === "gm" && (
        <>
          <section className="settings-block">
            <h2>Preview</h2>
            <p className="settings-note">
              The one setting here that is yours alone — it changes what you
              are served, not what anyone else sees.
            </p>
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
          </section>

          {current?.isDm && (
            <TransferDm campaignId={campaignId} campaignName={current.name} />
          )}
        </>
      )}

      {tab === "players" && <CampaignRoster campaignId={campaignId} />}

      {tab === "interface" && (
        <>
          <section className="settings-block">
            <h2>Theme</h2>
            <p className="settings-note">
              Yours alone. Changing it doesn&apos;t touch anyone else&apos;s
              view.
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
              Dice-roll defaults, notification preferences, portrait style for
              AI generation, and per-table density.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
