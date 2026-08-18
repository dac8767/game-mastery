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
      /requireMember\(\s*ctx,\s*args\.campaignId\s*\)/,
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
    if (/\.map\((?:async )?\(n\)\s*=>\s*\(\{\s*\n?\s*\.\.\.n\b/.test(npcs)) {
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

    // ---- the write path -------------------------------------------
    requirePattern(
      problems,
      npcs,
      /export const updateNpc[\s\S]*?await requireDm\(ctx, npc\.campaignId\)/,
      "npcs.updateNpc must gate on requireDm — it can write dmNotes, " +
        "secret, and the hidden flag"
    );
    requirePattern(
      problems,
      npcs,
      /export const createNpc[\s\S]*?await requireDm\(ctx, args\.campaignId\)/,
      "npcs.createNpc must gate on requireDm"
    );
    // The player-writable mutation must reach exactly one field.
    const notesBody = npcs.slice(npcs.indexOf("export const setPlayerNotes"));
    for (const field of ["dmNotes", "secret", "hidden:"]) {
      if (new RegExp(`ctx\\.db\\.patch[\\s\\S]{0,200}${field}`).test(notesBody)) {
        problems.push(
          `npcs.setPlayerNotes can write \`${field}\` — it must only reach playerNotes`
        );
      }
    }

    // ---- per-person view state is never shared ---------------------
    const views = read("convex", "views.ts");
    if (/args\.userId|userId:\s*v\.id\("users"\)/.test(views)) {
      problems.push(
        "convex/views.ts takes a userId argument — view prefs must be " +
          "resolved from the auth context, not from a client-supplied id"
      );
    }
    const settings = read("convex", "settings.ts");
    if (/args\.userId|userId:\s*v\.id\("users"\)/.test(settings)) {
      problems.push(
        "convex/settings.ts takes a userId argument — settings must be " +
          "resolved from the auth context"
      );
    }
    // A settable role would defeat the entire visibility model.
    if (/isDm:\s*v\.|role:\s*v\./.test(settings)) {
      problems.push(
        "convex/settings.ts accepts a role/isDm argument — DM status is " +
          "structural (campaign.dmId) and must never be self-settable"
      );
    }

    // ---- chat channel visibility -----------------------------------
    const chat = read("convex", "chat.ts");
    requirePattern(
      problems,
      chat,
      /case "dmOnly":\s*\n\s*return false;/,
      "chat.canSee must refuse dmOnly channels to non-DM callers"
    );
    requirePattern(
      problems,
      chat,
      /\.filter\(\(c\) => canSee\(c, userId, isDm\)\)/,
      "chat.listChannels must filter the list through canSee — a player " +
        "must not learn that a dmOnly channel exists"
    );
    requirePattern(
      problems,
      chat,
      /if \(!canSee\(channel, userId, isDm\)\) return null;/,
      "chat.listMessages must refuse a channel the caller cannot see"
    );
    requirePattern(
      problems,
      chat,
      /if \(!canSee\(channel, userId, isDm\)\) throw new Error/,
      "chat.sendMessage must refuse posting into a channel the caller " +
        "cannot see"
    );
    requirePattern(
      problems,
      chat,
      /export const createChannel[\s\S]*?await requireDm\(ctx, args\.campaignId\)/,
      "chat.createChannel must be DM-gated"
    );

    // ---- admin must not be grantable from inside the app -----------
    const authSrc = read("convex", "auth.ts");
    if (!/process\.env\.ADMIN_EMAILS/.test(authSrc)) {
      problems.push(
        "admin eligibility must come from the ADMIN_EMAILS deployment " +
          "variable — a table or mutation could be written by a bug"
      );
    }
    if (/ctx\.db[\s\S]{0,80}(adminEmails|isAdminEligible)/.test(authSrc)) {
      problems.push(
        "admin eligibility appears to be read from the database rather " +
          "than the environment"
      );
    }
    // The override alone must never be sufficient.
    if (
      !/hasActiveAdmin[\s\S]{0,400}isAdminEligible/.test(authSrc) ||
      !/hasActiveAdmin[\s\S]{0,400}adminOverride === true/.test(authSrc)
    ) {
      problems.push(
        "hasActiveAdmin must require BOTH env-var eligibility and the " +
          "stored override; either alone would be a self-grant"
      );
    }
    if (
      !/args\.adminOverride === true && !\(await isAdminEligible/.test(settings)
    ) {
      problems.push(
        "settings.saveMySettings lets a non-eligible caller switch " +
          "adminOverride on"
      );
    }

    // ---- the client must not re-derive DM state --------------------
    const columns = read("components", "npcColumns.ts");
    for (const field of ["hidden", "secret", "dmNotes"]) {
      const decl = columns.match(
        new RegExp(`key: "${field}"[^}]*`, "m")
      );
      if (!decl) {
        problems.push(`npcColumns.ts no longer defines the ${field} column`);
      } else if (!/dmOnly: true/.test(decl[0])) {
        problems.push(
          `the ${field} column is not marked dmOnly — it would be offered ` +
            "to players in the column picker"
        );
      }
    }
    if (!/if \(def\.dmOnly && !isDm\) continue;/.test(
      read("components", "NpcTable.tsx")
    )) {
      problems.push(
        "NpcTable does not filter dmOnly columns out of the rendered set"
      );
    }
    if (!/isDm \|\| !c\.dmOnly/.test(columns)) {
      problems.push(
        "npcColumns.reconcileColumns does not strip dmOnly columns for players"
      );
    }

    return problems;
  },
};
