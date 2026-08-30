"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { THEMES } from "@/components/themes";
import { RULES_VERSIONS } from "@/components/lookupFilters";
import { LEVELING_MODES } from "@/components/sessionColumns";
import { DATE_FORMATS, formatCardDate } from "@/components/campaignCard";
import { PAGE_SIZES, clampPageSize } from "@/components/pagerModel";
import { SidebarDesigner } from "@/components/SidebarDesigner";
import { EditModeSwitch, UiText } from "@/components/UiEditor";
import { NameField } from "@/components/NameField";
import { TransferDm } from "@/components/TransferDm";
import { CampaignDetails } from "@/components/CampaignDetails";
import { CampaignRoster } from "@/components/CampaignRoster";
import { InvitePanel } from "@/components/InvitePanel";
import { resolveTab, visibleTabs } from "@/components/settingsTabs";
import { SourcesPanel } from "@/components/SourcesPanel";

/**
 * Settings, in four tabs.
 *
 * The tabs are declared in settingsTabs.ts and both the strip and the
 * panels read that one list, so a tab cannot exist without a panel or a
 * panel without a way to reach it.
 *
 * The division is by WHOSE setting a thing is rather than by subject.
 * Most of this page is personal and stops at your own browser; the
 * Campaign tab is shared and GM-only, and says so at the top rather
 * than relying on you to remember which kind you are looking at.
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
  const setLeveling = useMutation(api.campaigns.setLeveling);
  const [selected, setSelected] = useState<string>("general");

  if (settings === undefined || campaigns === undefined) {
    return <p className="centered-note">Loading settings…</p>;
  }

  const current = campaigns.find((c) => c._id === campaignId) ?? null;
  const owned = campaigns.filter((c) => c.isDm);
  const played = campaigns.filter((c) => !c.isDm && !c.viaAdmin);
  const borrowed = campaigns.filter((c) => c.viaAdmin);

  // Admin override borrows GM authority, and the GM tabs are how you use
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
            <UiText id={`settings.tab.${t.id}`} />
          </button>
        ))}
      </div>

      {active && <p className="settings-blurb">{active.blurb}</p>}

      {tab === "system" && (
        <>
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
            <h2>Tables</h2>
            <p className="settings-note">
              How many rows every table loads at a time. The rest waits
              behind the page numbers under the table.
            </p>
            <div className="theme-options">
              {PAGE_SIZES.map((n) => (
                <button
                  type="button"
                  key={n}
                  className={`theme-option${
                    clampPageSize(settings.tableRows) === n ? " on" : ""
                  }`}
                  onClick={() => void save({ tableRows: n })}
                >
                  <span className="theme-name">{n} rows</span>
                </button>
              ))}
            </div>
          </section>

        </>
      )}

      {tab === "user" && (
        <>
          <section className="settings-block">
            <h2>Your name</h2>
            <p className="settings-note">
              What everyone else sees you called — on a campaign card, as the
              GM of the games you run, and beside anything you write. Until you
              set it you show up as &ldquo;the GM&rdquo;.
            </p>
            <NameField current={settings.displayName} />
          </section>

          <section className="settings-block">
            <h2>Roles</h2>
            <p className="settings-note">
              Roles are per campaign, so you hold several at once: GM of the
              ones you created, player in the ones you were added to. There is
              nothing to switch — you are the GM of a campaign because you own
              it.
            </p>

            <ul className="role-list">
              {owned.map((c) => (
                <li key={c._id}>
                  <span className="badge">GM</span> {c.name}
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
                    Opens <em>every</em> campaign with GM-level access,
                    including secrets and GM notes, so you can diagnose and
                    repair. Off by default and meant to be turned off again —
                    leaving it on would quietly spoil any campaign you&apos;re
                    only a player in. Campaigns you reach this way are labelled{" "}
                    <em>Admin</em> above rather than shown as yours.
                  </span>
                </span>
              </label>
            </section>
          )}
          {/* The GM controls, on the person rather than in a tab of
              their own. They only ever applied to one person, and a
              tab that appears and disappears as the campaign changes
              hands is a tab most people never see exist. */}
          {isDm && (
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
                    data — hidden NPCs and GM fields never reach the browser — so
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
        </>
      )}


      {tab === "campaign" && (
        <>
          <CampaignDetails campaignId={campaignId} />

          {/* Who is at the table, moved in from a Players tab of its
              own. It held exactly these two panels, and both answer
              the same question this tab does — what IS this campaign —
              so it was a second tab you had to know to look in. */}
          <CampaignRoster campaignId={campaignId} />
          <InvitePanel campaignId={campaignId} />

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

          <section className="settings-block">
            <h2>Leveling</h2>
            <p className="settings-note">
              How this table levels up. XP puts an &ldquo;XP Awarded&rdquo;
              field on every session; milestone replaces it with
              &ldquo;Leveled up to&rdquo; and a pick of the levels the
              campaign has not reached yet.
            </p>
            <div className="theme-options">
              {LEVELING_MODES.map((m) => (
                <button
                  type="button"
                  key={m.value}
                  className={`theme-option${
                    (current?.leveling ?? "xp") === m.value ? " on" : ""
                  }`}
                  onClick={() =>
                    void setLeveling({ campaignId, leveling: m.value })
                  }
                >
                  <span className="theme-name">{m.label}</span>
                  <span className="settings-note">{m.note}</span>
                </button>
              ))}
            </div>
          </section>

        </>
      )}


      {tab === "sources" && (
        <section className="settings-block">
          <h2>Books</h2>
          {/* One switch per book, applied to every Lookup table at
              once. It is a personal setting: two people at the same
              table can read from different shelves. */}
          <SourcesPanel excluded={settings?.excludedSources ?? []} />
        </section>
      )}

      {tab === "interface" && (
        <>
          <section className="settings-block">
            <h2>Edit mode</h2>
            {/* The switch first, the explanation after. It was the
                other way round, and the one line saying WHY the switch
                was missing sat under six lines of prose about what the
                switch does — so a GM previewing as a player read the
                whole block and concluded there was no button. */}
            <EditModeSwitch />
            <p className="settings-note">
              Turn this on and every label you are allowed to change grows
              a dotted outline — click one to rename it in place. On the
              NPC record the fields themselves become draggable: move one,
              drag its edges to resize it, drop it on a tab to send it
              there, and rename or add tabs on the strip. Walk to any
              screen with it on and edit it there; the bar along the
              bottom follows you. Save applies it for everyone in this
              campaign, and Export gives you the whole set of changes to
              send back so they can ship as the defaults.
            </p>
          </section>

          <SidebarDesigner />

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
