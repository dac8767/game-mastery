"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { navHref } from "@/components/navItems";
import { NavIcon } from "@/components/NavIcon";
import { THEMES, ThemeName } from "@/components/themes";
import {
  BUILTIN_BY_KEY,
  COMMAND_BY_ID,
  DEFAULT_RIBBON,
  TOOL_BY_ID,
  registrySnapshot,
} from "@/components/ribbonRegistry";
import {
  RibbonSection,
  normalizeRibbon,
  parseRibbon,
  spacerWidth,
  stripTall,
} from "@/components/ribbonTokens";
import { RibbonCustomize } from "@/components/RibbonCustomize";
import { FeedbackForm } from "@/components/FeedbackForm";

/**
 * The ribbon: a Word-style toolbar organised into sections, where every
 * item, divider, spacer and section is arranged by the person using it.
 *
 * A section renders one or two rows, and that is the only thing a
 * section tells its items:
 *
 *   - no row break  → single row, every item a BIG button (large icon,
 *                     label underneath) filling the section's height
 *   - a row break   → two rows of small icon buttons
 *
 * It lives on the DM Screen and nowhere else. That was a deliberate
 * call: a toolbar you arranged yourself is worth its height on the
 * screen built around it, and is just a band across the top of every
 * other one.
 *
 * Deliberately NOT built: priority-based collapse, where items fold into
 * a ⋯ menu as the window narrows. A narrow window scrolls the ribbon
 * horizontally instead — sections vanishing as you resize reads as the
 * bar breaking. Two CSS lines, and better behaviour than the system it
 * would replace.
 */

export function RibbonBar({
  campaignId,
  extras,
}: {
  campaignId: Id<"campaigns">;
  /**
   * Renderers for the builtins whose content belongs to the SCREEN the
   * bar is standing on — the DM Screen's Add Window and Workspaces
   * menus, and its note format bar. Injected rather than imported,
   * because those menus read and write the screen's own state, and the
   * bar knowing about DmScreen would be the dependency pointing the
   * wrong way.
   */
  extras?: Record<string, (big: boolean) => React.ReactNode>;
}) {
  const settings = useQuery(api.settings.mySettings);
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const save = useMutation(api.settings.saveMySettings);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const [customizing, setCustomizing] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const campaign = campaigns?.find((c) => c._id === campaignId) ?? null;
  const base = `/campaign/${campaignId}`;
  const isDm = campaign?.isDm ?? false;

  /**
   * Seeded from the `toolbarSet` flag alone, never from whether the
   * stored array is empty: an empty toolbar is a legitimate thing for
   * someone to have made, and treating it as "unset" would resurrect
   * the default on every load.
   */
  const tokens = useMemo(() => {
    if (!settings) return null;
    const stored = settings.toolbarSet ? settings.toolbarTokens : DEFAULT_RIBBON;
    return normalizeRibbon(stored, registrySnapshot());
  }, [settings]);

  const setTokens = useCallback(
    (next: string[]) => void save({ toolbarTokens: next }),
    [save]
  );

  // Every id in TOOLBAR_COMMANDS needs an arm here. A command with no
  // arm renders a button that does nothing, which TypeScript cannot see
  // because the link between the two is a string.
  const run = useCallback(
    (commandId: string) => {
      if (commandId === "feedback") setFeedbackOpen(true);
      if (commandId === "campaigns") router.push("/");
      if (commandId === "signOut") void signOut();
    },
    [router, signOut]
  );

  const setTheme = useCallback(
    (theme: ThemeName) => void save({ theme }),
    [save]
  );
  const setViewAsPlayer = useCallback(
    (viewAsPlayer: boolean) => void save({ viewAsPlayer }),
    [save]
  );

  // A control that doesn't exist right now is filtered OUT, not rendered
  // empty. An empty element still measures, and a zero-width item is a
  // gap in the bar nobody can account for.
  const available = useCallback(
    (raw: string) => {
      const tok = stripTall(raw);
      if (tok === "b:viewAsPlayer") return isDm;
      // An injected builtin exists only where its screen supplied the
      // renderer — anywhere else the token is filtered out rather than
      // rendered empty.
      if (
        tok === "b:addWindow" ||
        tok === "b:workspaces" ||
        tok === "b:noteFormat"
      ) {
        return Boolean(extras?.[tok.slice(2)]);
      }
      return true;
    },
    [isDm, extras]
  );

  const renderToken = (raw: string, big: boolean) => {
    const tok = stripTall(raw);

    if (tok.startsWith("d:")) {
      return (
        <div key={raw} className={`rib-sep${big ? " rib-tall" : ""}`} />
      );
    }
    if (tok.startsWith("s:")) {
      const px = spacerWidth(tok);
      return (
        <div
          key={raw}
          className="rib-spacer"
          style={px ? { width: px } : undefined}
        />
      );
    }
    if (tok.startsWith("t:")) {
      const tool = TOOL_BY_ID[tok.slice(2)];
      if (!tool) return null;
      return (
        <Link
          key={raw}
          href={navHref(tool, base)}
          className={`rib-btn${big ? " rib-btn-big" : ""}`}
          title={tool.label}
        >
          <NavIcon icon={tool.icon} art={tool.art} className="rib-icon" />
          {big && <span className="rib-label">{tool.label}</span>}
        </Link>
      );
    }
    if (tok.startsWith("c:")) {
      const cmd = COMMAND_BY_ID[tok.slice(2)];
      if (!cmd) return null;
      return (
        <button
          key={raw}
          type="button"
          className={`rib-btn${big ? " rib-btn-big" : ""}`}
          title={cmd.label}
          onClick={() => run(cmd.id)}
        >
          <span className="rib-icon">{cmd.icon}</span>
          {big && <span className="rib-label">{cmd.label}</span>}
        </button>
      );
    }
    if (tok.startsWith("b:")) {
      return renderBuiltin(tok.slice(2), raw, big);
    }
    // Unknown tokens render nothing rather than throwing.
    return null;
  };

  const renderBuiltin = (key: string, raw: string, big: boolean) => {
    const meta = BUILTIN_BY_KEY[key];
    if (!meta) return null;
    const cls = [
      "rib-btn",
      big ? "rib-btn-big" : "",
      meta.desktopOnly ? "rib-desktop" : "",
    ]
      .filter(Boolean)
      .join(" ");

    switch (key) {
      case "campaign":
        return (
          <Link key={raw} href={base} className={cls} title="This campaign">
            <span className="rib-icon">{meta.icon}</span>
            <span className="rib-label">
              {campaign?.name ?? "Campaign"}
              {campaign?.isDm && <span className="badge">DM</span>}
              {campaign?.viaAdmin && <span className="badge admin">Admin</span>}
            </span>
          </Link>
        );

      case "theme":
        return (
          <select
            key={raw}
            className={`rib-select${meta.desktopOnly ? " rib-desktop" : ""}`}
            title="Theme"
            value={settings?.theme ?? "candlelight"}
            onChange={(e) => setTheme(e.target.value as ThemeName)}
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        );

      case "viewAsPlayer":
        return (
          <button
            key={raw}
            type="button"
            className={`${cls}${settings?.viewAsPlayer ? " active" : ""}`}
            title="See exactly what a player sees"
            onClick={() => setViewAsPlayer(!settings?.viewAsPlayer)}
          >
            <span className="rib-icon">{meta.icon}</span>
            {big && <span className="rib-label">{meta.label}</span>}
          </button>
        );

      case "customize":
        return (
          <button
            key={raw}
            type="button"
            className={cls}
            title="Customize the toolbar"
            onClick={() => setCustomizing(true)}
          >
            <span className="rib-icon">{meta.icon}</span>
            {big && <span className="rib-label">{meta.label}</span>}
          </button>
        );

      case "addWindow":
      case "workspaces":
      case "noteFormat": {
        const extra = extras?.[key];
        return extra ? (
          <div key={raw} className="rib-extra">
            {extra(big)}
          </div>
        ) : null;
      }

      default:
        return null;
    }
  };

  if (!tokens) return <div className="rib-stack rib-loading" />;

  const { sections, splitAt } = parseRibbon(tokens.filter(available));

  /*
    An EMPTY section renders nothing, but its boundary divider would
    still paint — a stray line left of the first item or right of the
    last. Skip them, then re-derive the split against what is left.
  */
  const live = sections
    .map((s, orig) => ({ s, orig }))
    .filter(({ s }) => s.top.length + s.bottom.length > 0);
  const liveSplit =
    splitAt === null ? null : live.findIndex(({ orig }) => orig >= splitAt);
  const leftLive =
    liveSplit === null || liveSplit < 0 ? live : live.slice(0, liveSplit);
  const rightLive =
    liveSplit === null || liveSplit < 0 ? [] : live.slice(liveSplit);

  const anyTitle = live.some(({ s }) => Boolean(s.title));

  const sectionInner = (s: RibbonSection) => (
    <>
      <div className={`rib-sec-title${s.title ? "" : " rib-sec-title-empty"}`}>
        {s.title || ""}
      </div>
      <div className="rib-row">
        {s.top.map((t) => renderToken(t, !s.hasBreak))}
      </div>
      {s.hasBreak && s.breakLine && <div className="rib-row-line" />}
      {s.hasBreak && (
        <div className="rib-row">
          {s.bottom.map((t) => renderToken(t, false))}
        </div>
      )}
    </>
  );

  const sectionEl = ({ s, orig }: { s: RibbonSection; orig: number }) => (
    <div
      key={orig}
      className={`rib-section${s.hasBreak ? "" : " rib-single"}${
        s.title ? "" : " rib-kind-untitled"
      }`}
    >
      {sectionInner(s)}
    </div>
  );

  return (
    <div className="rib-stack">
      <div className={`rib-bar${anyTitle ? "" : " rib-no-titles"}`}>
        {leftLive.map(sectionEl)}
        {/* A real element, not margin-left:auto — it collapses when the
            bar overflows so the right-hand run just follows on and
            scrolls into view. */}
        {rightLive.length > 0 && <div className="rib-align-gap" />}
        {rightLive.map(sectionEl)}
      </div>

      {customizing && (
        <RibbonCustomize
          tokens={tokens}
          setTokens={setTokens}
          onClose={() => setCustomizing(false)}
        />
      )}

      {feedbackOpen && (
        <FeedbackForm onClose={() => setFeedbackOpen(false)} />
      )}
    </div>
  );
}
