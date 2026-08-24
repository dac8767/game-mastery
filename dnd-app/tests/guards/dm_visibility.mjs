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
    //
    // Bounded to setPlayerNotes' OWN body. It used to run to the end of
    // the file, so the first later mutation to patch dmNotes — the
    // migration that exists to clear it — was reported as setPlayerNotes
    // writing it. A check that fails on unrelated code below it is one
    // that gets loosened rather than heeded.
    const notesStart = npcs.indexOf("export const setPlayerNotes");
    if (notesStart === -1) throw new Error("no setPlayerNotes in convex/npcs.ts");
    const notesEnd = npcs.indexOf("\nexport const ", notesStart + 1);
    const notesBody = npcs.slice(
      notesStart,
      notesEnd === -1 ? undefined : notesEnd
    );
    for (const field of ["dmNotes", "secret", "hidden:"]) {
      if (new RegExp(`ctx\\.db\\.patch[\\s\\S]{0,200}${field}`).test(notesBody)) {
        problems.push(
          `npcs.setPlayerNotes can write \`${field}\` — it must only reach playerNotes`
        );
      }
    }

    // ---- convex/locations.ts ---------------------------------------
    // A hidden location is a place the players have not found. Leaking
    // one is worse than leaking a hidden NPC: the map itself gives away
    // that there is somewhere to go.
    const locs = read("convex", "locations.ts");

    requirePattern(
      problems,
      locs,
      /requireMember\(\s*ctx,\s*args\.campaignId\s*\)/,
      "locations.listForCampaign must gate on requireMember(campaignId)"
    );
    requirePattern(
      problems,
      locs,
      /\.filter\(\(l\) => isDm \|\| !l\.hidden\)/,
      "locations.listForCampaign must drop hidden locations for players"
    );
    requirePattern(
      problems,
      locs,
      /dmNotes:\s*isDm\s*\?/,
      "locations.listForCampaign must gate dmNotes behind isDm"
    );
    requirePattern(
      problems,
      locs,
      /hidden:\s*isDm\s*\?/,
      "locations.listForCampaign must gate the hidden flag behind isDm"
    );
    if (/\.map\((?:async )?\(l\)\s*=>\s*\(\{\s*\n?\s*\.\.\.l\b/.test(locs)) {
      problems.push(
        "locations.listForCampaign spreads the raw document (...l) — " +
          "dmNotes and the hidden flag would ride along"
      );
    }

    // Every write is the DM's. A player must not be able to move a pin,
    // rename a place, or upload a map over one.
    for (const fn of [
      "createLocation",
      "updateLocation",
      "deleteLocation",
      "setPin",
      "generateUploadUrl",
      "setMap",
      "addPicture",
      "removePicture",
      "importLocations",
    ]) {
      const body = locs.slice(
        locs.indexOf(`export const ${fn} = mutation`),
        locs.indexOf("export const", locs.indexOf(`export const ${fn} = mutation`) + 10)
      );
      if (!body) {
        problems.push(`convex/locations.ts no longer exports ${fn}`);
      } else if (!/await requireDm\(/.test(body)) {
        problems.push(`locations.${fn} is not gated on requireDm`);
      }
    }

    // ---- convex/groups.ts ------------------------------------------
    // The leak here does not look like a leak. A group's member list is
    // built out of NPC rows, so a hidden NPC that survives into the
    // collection tells a player that someone they have not met is in
    // the cult — the name gets out through the group even though the
    // roster itself withheld the NPC. The filter has to run BEFORE the
    // names are collected, which is why this checks that the collected
    // set is the filtered one rather than merely that a filter exists
    // somewhere in the file.
    const groups = read("convex", "groups.ts");

    requirePattern(
      problems,
      groups,
      /requireMember\(\s*ctx,\s*args\.campaignId\s*\)/,
      "groups.listForCampaign must gate on requireMember(campaignId) — " +
        "requireUser alone would expose another campaign's factions"
    );
    requirePattern(
      problems,
      groups,
      /const visible = npcRows\.filter\(\(n\) => isDm \|\| !n\.hidden\)/,
      "groups.listForCampaign must drop hidden NPCs before it collects " +
        "the member lists"
    );
    requirePattern(
      problems,
      groups,
      /for \(const npc of visible\)/,
      "groups.listForCampaign must collect members from the FILTERED " +
        "rows — collecting from the raw ones would name a hidden NPC to " +
        "a player through the group they are in"
    );
    // The count and the inferred rows come from the same map, so both
    // follow the filter — but only while the map is the one built above.
    if (/members\.set\([^)]*npcRows/.test(groups)) {
      problems.push(
        "groups.listForCampaign builds its member map from npcRows — the " +
          "unfiltered list, which puts hidden NPCs back into the counts"
      );
    }
    // A DM previewing as a player must see what a player sees here too,
    // or the preview quietly reports the wrong thing.
    requirePattern(
      problems,
      groups,
      /const isDm = isCampaignDm && !viewAsPlayer/,
      "groups.listForCampaign must honour viewAsPlayer, the same way the " +
        "roster does — otherwise the preview shows the real member lists"
    );

    // Every write is the DM's. A player must not rename a faction,
    // describe one, delete one, or upload a picture onto one.
    for (const fn of [
      "createGroup",
      "describeGroup",
      "updateGroup",
      "deleteGroup",
      "generateUploadUrl",
      "addAttachment",
      "removeAttachment",
    ]) {
      const at = groups.indexOf(`export const ${fn} = mutation`);
      if (at === -1) {
        problems.push(`convex/groups.ts no longer exports ${fn}`);
        continue;
      }
      const next = groups.indexOf("export const ", at + 10);
      const body = groups.slice(at, next === -1 ? undefined : next);
      if (!/await requireDm\(/.test(body)) {
        problems.push(`groups.${fn} is not gated on requireDm`);
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
    // `dmNotes` is deliberately NOT here any more: it stopped being a
    // column when the record's DM Notes thread replaced it, so there
    // is no picker entry to mark dmOnly. The field still exists on the
    // document until npcs.migrateDmNotes has been run everywhere, and
    // the checks that matter for it — that the query nulls it for a
    // player, and that nothing player-writable can patch it — are
    // above and below this and still run.
    const columns = read("components", "npcColumns.ts");
    for (const field of ["hidden", "secret"]) {
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
