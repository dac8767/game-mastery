/**
 * Guard 5 — the DM/player boundary.
 *
 * The project's hardest rule: hidden NPCs, `secret`, `dmNotes`, and
 * masked HP must never leave the server for a non-DM caller. A
 * regression here is invisible in the UI you look at (you're the DM —
 * you see everything either way) and only shows up when a player opens
 * the app. Nothing else in the toolchain checks it.
 */

import { read, requirePattern } from "./lib.mjs";

export const dmVisibility = {
  name: "dm-visibility",
  description: "DM-only fields stay server-side for non-DM callers",
  run() {
    const problems = [];

    // ---- convex/npcs.ts --------------------------------------------
    const npcs = read("convex", "npcs.ts");

    requirePattern(
      problems,
      npcs,
      /requireMember\(ctx,\s*args\.campaignId\)/,
      "npcs.listForCampaign must gate on requireMember(campaignId) — " +
        "requireUser alone would expose another campaign's roster"
    );
    requirePattern(
      problems,
      npcs,
      /\.filter\(\s*\(n\)\s*=>\s*isDm\s*\|\|\s*!n\.hidden\s*\)/,
      "npcs.listForCampaign must drop hidden NPCs for non-DM callers"
    );
    requirePattern(
      problems,
      npcs,
      /dmNotes:\s*isDm\s*\?/,
      "npcs.listForCampaign must gate dmNotes behind isDm"
    );
    requirePattern(
      problems,
      npcs,
      /secret:\s*isDm\s*\?/,
      "npcs.listForCampaign must gate secret behind isDm"
    );
    requirePattern(
      problems,
      npcs,
      /hidden:\s*isDm\s*\?/,
      "npcs.listForCampaign must gate the hidden flag behind isDm"
    );

    // Spreading the raw document would defeat every check above.
    if (/\.map\(\(n\)\s*=>\s*\(\{\s*\n?\s*\.\.\.n\b/.test(npcs)) {
      problems.push(
        "npcs.listForCampaign spreads the raw document (...n) — " +
          "DM-only fields would ride along"
      );
    }

    // ---- convex/combat.ts ------------------------------------------
    const combat = read("convex", "combat.ts");

    requirePattern(
      problems,
      combat,
      /\.filter\(\(c\)\s*=>\s*isDm\s*\|\|\s*!c\.hidden\)/,
      "combat.getEncounterView must drop hidden combatants for players"
    );

    // The player branch is everything after the `if (isDm) return` — it
    // must never name dmNotes.
    const playerBranch = combat.slice(combat.indexOf('view: "dm" as const'));
    if (/dmNotes/.test(playerBranch)) {
      problems.push(
        "combat.getEncounterView's player branch references dmNotes"
      );
    }

    // ---- the client must not re-derive DM state --------------------
    const table = read("components", "NpcTable.tsx");
    if (!/\{isDm\s*&&\s*\(\s*\n?\s*<td className="dm-col">/.test(table)) {
      problems.push(
        "NpcTable renders the DM column without an isDm guard"
      );
    }

    return problems;
  },
};
