/**
 * Guard 5 — the GM/player boundary.
 *
 * The project's hardest rule: hidden NPCs, `secret`, `dmNotes`, and
 * masked HP must never leave the server for a non-GM caller. A
 * regression here is invisible in the UI you look at (you're the GM —
 * you see everything either way) and only shows up when a player opens
 * the app. Nothing else in the toolchain checks it.
 */

import { read, requirePattern, sourceFiles, stripComments } from "./lib.mjs";

export const dmVisibility = {
  name: "dm-visibility",
  description: "GM-only fields stay server-side for non-GM callers",
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
      "npcs.listForCampaign must drop hidden NPCs for non-GM callers"
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
          "GM-only fields would ride along"
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

    // Every write is the GM's. A player must not be able to move a pin,
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
    // A GM previewing as a player must see what a player sees here too,
    // or the preview quietly reports the wrong thing.
    requirePattern(
      problems,
      groups,
      /const isDm = isCampaignDm && !viewAsPlayer/,
      "groups.listForCampaign must honour viewAsPlayer, the same way the " +
        "roster does — otherwise the preview shows the real member lists"
    );

    // Every write is the GM's. A player must not rename a faction,
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

    // ---- convex/sessions.ts ----------------------------------------
    // The GM notes on a session are a whole PAGE of things the table
    // does not know, and the withholding is stronger here than
    // anywhere else in the app on purpose: a non-GM request never
    // queries that side at all. Fetching both and returning one would
    // mean the GM's notes had been read out of the database on a
    // player's behalf and were sitting in a variable, one careless edit
    // from the wire.
    const sessions = read("convex", "sessions.ts");

    /**
     * One function's body, not the whole file.
     *
     * Every check below would otherwise be satisfied by
     * listForCampaign, which computes `isDm` the same way a few lines
     * up — so gutting the rule inside getNotes would leave the guard
     * green. A file-wide search for a line that appears twice proves
     * nothing about either copy.
     */
    const bodyOf = (name) => {
      const at = sessions.indexOf(`export const ${name} = `);
      if (at === -1) throw new Error(`no ${name} in convex/sessions.ts`);
      const next = sessions.indexOf("\nexport const ", at + 1);
      return sessions.slice(at, next === -1 ? undefined : next);
    };
    const getNotes = bodyOf("getNotes");

    requirePattern(
      problems,
      getNotes,
      /requireMember\(\s*\n?\s*ctx,\s*\n?\s*session\.campaignId\s*\n?\s*\)/,
      "sessions.getNotes must gate on requireMember(campaignId) — " +
        "requireUser alone would hand another campaign's notes to anyone"
    );
    requirePattern(
      problems,
      getNotes,
      /dm: isDm \? await side\("dm"\) : null/,
      "sessions.getNotes must not evaluate the dm side for a non-GM " +
        "caller — and must send null rather than [], because an empty " +
        "page says the GM wrote nothing, which is a different claim"
    );
    requirePattern(
      problems,
      getNotes,
      /const isDm = isCampaignDm && !viewAsPlayer/,
      "sessions.getNotes must honour viewAsPlayer — otherwise the GM's " +
        "player preview shows the GM notes and reports nothing withheld"
    );
    // The PAGE the boxes sit on is the same secret as the boxes, and it
    // is newer — so it is the half likely to be forgotten. Same shape:
    // never queried for a player, null rather than "".
    requirePattern(
      problems,
      getNotes,
      /dmBody: isDm \? await body\("dm"\) : null/,
      "sessions.getNotes must not read the GM's page for a non-GM caller " +
        "— the page carries the same secrets the boxes on it do"
    );
    requirePattern(
      problems,
      bodyOf("listForCampaign"),
      /const isDm = isCampaignDm && !viewAsPlayer/,
      "sessions.listForCampaign must honour viewAsPlayer too — the list " +
        "is where the preview flag is shown, and it would be lying"
    );

    // A shaper that spread the raw document would carry `side` out with
    // it, which is how a client ends up deciding what to render from a
    // field the server was supposed to have acted on.
    if (/\.map\((?:async )?\(b\)\s*=>\s*\(\{\s*\n?\s*\.\.\.b\b/.test(sessions)) {
      problems.push(
        "sessions.getNotes spreads the raw box document (...b) — the " +
          "storage id and the side would ride along"
      );
    }

    // Writing. The player side is any member's, the same rule
    // playerNotes runs on; the GM side is the GM's. What must never
    // happen is a box mutation that decides from an ARGUMENT which side
    // it is touching — the box's own `side` is the only trustworthy
    // answer, because an id is all a caller needs to name someone
    // else's box.
    requirePattern(
      problems,
      sessions,
      /if \(side === "dm"\) \{\s*\n\s*await requireDm\(ctx, campaignId\);/,
      "sessions.requireWriter must gate the dm side on requireDm"
    );
    for (const fn of ["updateBox", "deleteBox"]) {
      const at = sessions.indexOf(`export const ${fn} = mutation`);
      if (at === -1) {
        problems.push(`convex/sessions.ts no longer exports ${fn}`);
        continue;
      }
      const next = sessions.indexOf("export const ", at + 10);
      const body = sessions.slice(at, next === -1 ? undefined : next);
      if (!/requireWriter\(ctx, session\.campaignId, box\.side\)/.test(body)) {
        problems.push(
          `sessions.${fn} does not check the side the BOX is on — a ` +
            "player who knows a GM box's id could reach it"
        );
      }
    }
    // setBody names its side in an argument, which is safe ONLY because
    // requireWriter then refuses a non-GM the dm side. Without that
    // call it is a mutation that writes the GM's page for anyone who
    // passes side: "dm" — the exact hole the box mutations avoid by
    // reading the side off the document instead.
    {
      const body = bodyOf("setBody");
      if (!/requireWriter\(ctx, session\.campaignId, args\.side\)/.test(body)) {
        problems.push(
          "sessions.setBody does not pass the side to requireWriter — any " +
            "member could write the GM's page by asking for it"
        );
      }
      if (!/sanitizeBoxHtml\(args\.html\)/.test(body)) {
        problems.push(
          "sessions.setBody stores html unsanitised — the player page is " +
            "written by any member and rendered in the GM's browser"
        );
      }
    }

    for (const fn of ["createSession", "updateSession", "deleteSession"]) {
      const at = sessions.indexOf(`export const ${fn} = mutation`);
      if (at === -1) {
        problems.push(`convex/sessions.ts no longer exports ${fn}`);
        continue;
      }
      const next = sessions.indexOf("export const ", at + 10);
      const body = sessions.slice(at, next === -1 ? undefined : next);
      if (!/await requireDm\(/.test(body)) {
        problems.push(`sessions.${fn} is not gated on requireDm`);
      }
    }

    // Every write of a box's HTML is rebuilt from an allowlist.
    //
    // The notebook's boxes are one person's page and went to the
    // database untouched, which was fine while that was true of every
    // box in the app. A session's PLAYER notes are written by any
    // member and rendered in the GM's browser, so the same markup is
    // now a script running as them unless something rebuilds it. Two
    // mutations write `html`, and one of them forgetting is not
    // visible in anything you can look at.
    for (const fn of ["addBox", "updateBox"]) {
      const at = sessions.indexOf(`export const ${fn} = mutation`);
      if (at === -1) continue; // the export check above already said so
      const next = sessions.indexOf("export const ", at + 10);
      const body = sessions.slice(at, next === -1 ? undefined : next);
      if (!/sanitizeBoxHtml\(/.test(body)) {
        problems.push(
          `sessions.${fn} writes a box's html without rebuilding it — ` +
            "the player side is written by any member and read by the GM, " +
            "so unsanitised markup there runs as the GM"
        );
      }
    }
    // In the MUTATION, not in the editor: a hand-made call reaches the
    // mutation and never touches the component.
    if (/sanitizeBoxHtml/.test(read("components", "BoxCanvas.tsx"))) {
      problems.push(
        "BoxCanvas sanitises box html in the editor — that is the one " +
          "place it does not belong, because a call that skips the editor " +
          "skips the sanitiser with it"
      );
    }

    // And the screen must render the GM section from what the SERVER
    // sent rather than from its own idea of who is looking. `isDm` in a
    // component is a render decision; `dm === null` is the data not
    // being there.
    const detail = read("components", "SessionDetail.tsx");
    if (/\{isDm && [\s\S]{0,80}dm-notes/.test(detail)) {
      problems.push(
        "SessionDetail gates its GM notes section on the client's isDm — " +
          "it must render from `notes.dm` being present, which is the " +
          "server's answer rather than the browser's"
      );
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
        "convex/settings.ts accepts a role/isDm argument — GM status is " +
          "structural (campaign.dmId) and must never be self-settable"
      );
    }

    // ---- chat channel visibility -----------------------------------
    const chat = read("convex", "chat.ts");
    requirePattern(
      problems,
      chat,
      /case "dmOnly":\s*\n\s*return false;/,
      "chat.canSee must refuse dmOnly channels to non-GM callers"
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
      "chat.createChannel must be GM-gated"
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

    // ---- the client must not re-derive GM state --------------------
    // `dmNotes` is deliberately NOT here any more: it stopped being a
    // column when the record's GM Notes thread replaced it, so there
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

    // ---- convex/dmscreen.ts ----------------------------------------
    // The GM Screen's storage. Everything in it is the GM's own — the
    // arrangement, the workspaces, the prep notes — so every function
    // goes through requireDm, and the row-addressed mutations authorise
    // against the ROW's campaign rather than an argument a caller
    // could aim at somebody else's campaign.
    {
      const dmscreen = read("convex", "dmscreen.ts");
      const fnBody = (name) => {
        const at = dmscreen.indexOf(`export const ${name} = `);
        if (at === -1) throw new Error(`no ${name} in convex/dmscreen.ts`);
        const next = dmscreen.indexOf("\nexport const ", at + 1);
        return dmscreen.slice(at, next === -1 ? undefined : next);
      };

      for (const fn of ["getScreen", "saveLayout", "saveWorkspace", "addNote"]) {
        if (!/await requireDm\(ctx, args\.campaignId\)/.test(fnBody(fn))) {
          problems.push(`dmscreen.${fn} is not gated on requireDm`);
        }
      }
      // The row-addressed ones go through the owned helpers, which
      // authorise the row's own campaign AND its user.
      for (const [fn, helper] of [
        ["updateWorkspace", "ownedWorkspace"],
        ["deleteWorkspace", "ownedWorkspace"],
        ["updateNote", "ownedNote"],
        ["deleteNote", "ownedNote"],
      ]) {
        if (!new RegExp(`await ${helper}\\(ctx, args\\.`).test(fnBody(fn))) {
          problems.push(
            `dmscreen.${fn} does not authorise through ${helper} — a row id ` +
              "is all a caller needs to name another campaign's row"
          );
        }
      }
      // And the helpers check the USER too: two GMs of two campaigns
      // must not reach each other's rows through the shared table.
      for (const helper of ["ownedWorkspace", "ownedNote"]) {
        const at = dmscreen.indexOf(`async function ${helper}`);
        const body = dmscreen.slice(at, dmscreen.indexOf("\n}", at));
        if (!/row\.userId !== userId/.test(body)) {
          problems.push(
            `${helper} does not compare the row's userId — an admin or ` +
              "co-GM would reach rows that are not theirs"
          );
        }
      }
      // Note HTML is rebuilt like every other stored HTML.
      if (!/patch\.html = sanitizeBoxHtml\(args\.html\)/.test(fnBody("updateNote"))) {
        problems.push(
          "dmscreen.updateNote stores html unsanitised — pasted rich text " +
            "goes straight to the GM's own browser"
        );
      }
    }

    // ---- convex/todo.ts --------------------------------------------
    // The GM's prep list has no player-facing shape at all, which makes
    // it a different rule from everything above. An NPC has a redacted
    // version; "statblock for the lich before Tuesday" does not — the
    // task IS the spoiler. So every function refuses a non-GM caller
    // rather than filtering rows, and that includes the QUERY.
    //
    // requireMember would be the quiet failure here: it returns a list
    // instead of an error, and a list is a promise the tool works for
    // you. One day somebody would make that promise true.
    {
      const todo = read("convex", "todo.ts");
      const fnBody = (name) => {
        const at = todo.indexOf(`export const ${name} = `);
        if (at === -1) throw new Error(`no ${name} in convex/todo.ts`);
        const next = todo.indexOf("\nexport const ", at + 1);
        return todo.slice(at, next === -1 ? undefined : next);
      };

      for (const fn of [
        "listTodos",
        "addTodo",
        "reorderTodos",
        "clearDone",
        // The Vikunja shape's campaign-addressed functions. Listed by
        // name rather than swept, so ADDING one to this module is a
        // deliberate line here — a new mutation that nobody remembered
        // to gate is exactly the hole a sweep would wave through.
        "quickAdd",
        "addProject",
        "reorderProjects",
        "addLabel",
      ]) {
        if (!/await requireDm\(ctx, args\.campaignId\)/.test(fnBody(fn))) {
          problems.push(`todo.${fn} is not gated on requireDm`);
        }
      }
      // The row-addressed ones authorise against the ROW's campaign.
      // Trusting a campaignId in the arguments would make somebody
      // else's todo id plus your own campaign enough to edit theirs.
      for (const [fn, owner, arg] of [
        ["setDone", "ownedTodo", "todoId"],
        ["updateTodo", "ownedTodo", "todoId"],
        ["deleteTodo", "ownedTodo", "todoId"],
        ["setFavorite", "ownedTodo", "todoId"],
        ["updateProject", "ownedProject", "projectId"],
        ["deleteProject", "ownedProject", "projectId"],
        ["updateLabel", "ownedLabel", "labelId"],
        ["deleteLabel", "ownedLabel", "labelId"],
      ]) {
        if (
          !new RegExp(`await ${owner}\\(ctx, args\\.${arg}\\)`).test(fnBody(fn))
        ) {
          problems.push(
            `todo.${fn} does not authorise through ${owner} — a row id is ` +
              "all a caller needs to reach another campaign's list"
          );
        }
      }
      // The three owners all ask the same question of the row they
      // fetched. Checked separately from the functions that call them,
      // because an owner that forgot to requireDm would make every one
      // of the checks above pass while gating nothing.
      for (const [owner, table] of [
        ["ownedProject", "todoProjects"],
        ["ownedLabel", "todoLabels"],
      ]) {
        const at = todo.indexOf(`async function ${owner}(`);
        if (at === -1) throw new Error(`no ${owner} in convex/todo.ts`);
        const body = todo.slice(at, todo.indexOf("\n}", at));
        if (!/await requireDm\(ctx, row\.campaignId\)/.test(body)) {
          problems.push(
            `${owner} does not requireDm against the row's own campaign, so ` +
              `any ${table} id would be enough`
          );
        }
      }
      if (!/const row = await ctx\.db\.get\(todoId\);[\s\S]{0,160}await requireDm\(ctx, row\.campaignId\)/.test(
        todo
      )) {
        problems.push(
          "ownedTodo does not requireDm against the row's own campaign"
        );
      }
      // A batch aimed at one campaign must not carry a row from
      // another along with it.
      if (!/row\.campaignId !== args\.campaignId/.test(fnBody("reorderTodos"))) {
        problems.push(
          "todo.reorderTodos does not check each row's campaign — one batch " +
            "would be able to reorder another campaign's list"
        );
      }
      // requireMember anywhere in this file is the mistake this whole
      // section exists to catch.
      if (/requireMember/.test(todo)) {
        problems.push(
          "convex/todo.ts uses requireMember — a prep list has no " +
            "player-facing version, so a non-GM caller is refused rather " +
            "than served a filtered one"
        );
      }
    }

    // ---- convex/dice.ts --------------------------------------------
    // Two separate things have to hold, and both fail silently.
    //
    // The GM's secret roll must be ABSENT from a player's data, not
    // hidden in the UI — the same rule as a dmOnly channel. A player
    // who can see that a roll happened has learned something the GM
    // chose not to tell them, whatever the number was.
    //
    // And the dice must be thrown on the SERVER. A mutation that
    // accepts a total is a mutation that accepts a 20 every time, and
    // a shared roll nobody could have chosen is the entire point of
    // rolling in the open.
    {
      const dice = read("convex", "dice.ts");
      const fnBody = (name) => {
        const at = dice.indexOf(`export const ${name} = `);
        if (at === -1) throw new Error(`no ${name} in convex/dice.ts`);
        const next = dice.indexOf("\nexport const ", at + 1);
        return dice.slice(at, next === -1 ? undefined : next);
      };

      requirePattern(
        problems,
        fnBody("listRolls"),
        /\.filter\(\s*\(r\) => !r\.secret \|\| \(isDm && r\.userId === userId\)\s*\)/,
        "dice.listRolls must drop secret rolls server-side — a player must " +
          "not learn that the GM rolled at all"
      );
      // Filtered BEFORE the names are resolved and the rows are
      // shaped, so a secret roll cannot leak through a field added
      // later to the returned object.
      {
        const body = fnBody("listRolls");
        const filtered = body.indexOf("const visible");
        const returned = body.indexOf("return {");
        if (filtered === -1 || returned === -1 || filtered > returned) {
          problems.push(
            "dice.listRolls no longer filters before it shapes its return " +
              "value — every field is derived from the filtered set"
          );
        }
        if (/rolls: recent\.map|recent\.map\(\(r\) => \({/.test(body)) {
          problems.push(
            "dice.listRolls maps over the unfiltered rows — secret rolls " +
              "would reach every player"
          );
        }
      }

      const rollDice = fnBody("rollDice");
      // Only the GM rolls in secret, and the flag is ANDed with that
      // rather than taken from the client.
      requirePattern(
        problems,
        rollDice,
        /const secret = Boolean\(args\.secret\) && isDm;/,
        "dice.rollDice takes the client's secret flag at face value — a " +
          "player could hide their own rolls from the table"
      );
      // The notation is the only thing the client is trusted with.
      requirePattern(
        problems,
        rollDice,
        /const parsed = parseRoll\(args\.notation\)/,
        "dice.rollDice does not re-parse the notation server-side"
      );
      requirePattern(
        problems,
        rollDice,
        /rollParsed\(parsed, Math\.random\)/,
        "dice.rollDice does not roll on the server — a client that supplies " +
          "its own result supplies its own natural 20"
      );
      for (const arg of ["total", "dice", "values", "result", "userId"]) {
        if (new RegExp(`^\\s*${arg}: v\\.`, "m").test(
          rollDice.slice(0, rollDice.indexOf("handler:"))
        )) {
          problems.push(
            `dice.rollDice accepts a ${arg} argument — the roll and the ` +
              "roller must both come from the server, never from the caller"
          );
        }
      }

      // ---- the 3D dice must never carry a secret roll --------------
      // dddice broadcasts a throw to every participant in the room.
      // A hidden roll whose privacy depends on another client honouring
      // an is_hidden flag is not hidden — so a secret roll is never
      // SENT. The guard is on the component that decides what to draw.
      {
        const roller = stripComments(read("components", "DiceRoller.tsx"));
        if (!/latest\.mine && !latest\.secret/.test(roller)) {
          problems.push(
            "the 3D canvas is not gated on both `mine` and `!secret` — a " +
              "secret roll sent to the dddice room is a roll every player's " +
              "browser receives"
          );
        }
        const canvas = stripComments(read("components", "DiceCanvas.tsx"));
        if (/is_hidden/.test(canvas)) {
          problems.push(
            "DiceCanvas reaches for dddice's is_hidden — a secret roll is " +
              "kept private by not being sent, not by asking nicely"
          );
        }
        // The GM's own dddice key must never become a shared secret.
        const diceSrc = read("convex", "dice.ts");
        if (/apiKey|api_key|\bsecretKey\b/i.test(diceSrc)) {
          problems.push(
            "convex/dice.ts stores a dddice API key — every browser mints " +
              "its own guest account precisely so no key is shared"
          );
        }
        if (!/await requireMember\(ctx, args\.campaignId\)/.test(fnBody("getRoom"))) {
          problems.push(
            "dice.getRoom is not gated on requireMember — the room passcode " +
              "would be readable by anyone with a campaign id"
          );
        }
        if (!/await requireDm\(ctx, args\.campaignId\)/.test(fnBody("setRoom"))) {
          problems.push("dice.setRoom is not GM-gated");
        }
      }

      requirePattern(
        problems,
        fnBody("clearRolls"),
        /await requireDm\(ctx, args\.campaignId\)/,
        "dice.clearRolls is not GM-gated — one player could wipe the " +
          "table's shared record of a roll they did not like"
      );
    }

    // ---- convex/recorder.ts ----------------------------------------
    //
    // The same rule as the prep list, and for a stronger reason. A
    // transcript of a session is the whole evening: the aside to one
    // player while the others were getting food, the argument about a
    // ruling, whatever anybody said believing the laptop was there for
    // the battle map. There is no redacted version of that, so every
    // function refuses a non-GM caller rather than filtering rows.
    //
    // Two shapes of hole are specific to this module and neither is
    // visible to TypeScript: an ingest mutation made public (the home
    // server's routes have no user behind them, so those functions
    // check nothing themselves), and an ACTION whose authority lives
    // in the internal function it calls.
    {
      const rec = read("convex", "recorder.ts");
      const fnBody = (name) => {
        const at = rec.indexOf(`export const ${name} = `);
        if (at === -1) throw new Error(`no ${name} in convex/recorder.ts`);
        const next = rec.indexOf("\nexport const ", at + 1);
        return rec.slice(at, next === -1 ? undefined : next);
      };

      // Campaign-addressed: the argument names the campaign, so the
      // check is against the argument.
      for (const fn of ["getConfig", "listRecordings", "getRecording"]) {
        if (!/await requireDm\(ctx, args\.campaignId\)/.test(fnBody(fn))) {
          problems.push(`recorder.${fn} is not gated on requireDm`);
        }
      }

      // Row-addressed: authority comes from the ROW's campaign, never
      // from the campaignId in the arguments. Trusting that argument
      // would make somebody else's recording id plus your own campaign
      // enough to read their session.
      for (const fn of [
        "finishUpload",
        "markFailed",
        "rename",
        "setSpeakers",
        "linkSession",
        "requestSummary",
      ]) {
        if (!/await requireDm\(ctx, rec\.campaignId\)/.test(fnBody(fn))) {
          problems.push(
            `recorder.${fn} does not requireDm against the row's own ` +
              "campaign — a recording id would be all a caller needs"
          );
        }
      }
      // getRecording takes both, so it has to reject the mismatch
      // rather than serve one campaign's recording to another's GM.
      if (!/rec\.campaignId !== args\.campaignId/.test(fnBody("getRecording"))) {
        problems.push(
          "recorder.getRecording does not check the row belongs to the " +
            "campaign asked for"
        );
      }

      // The two public ACTIONS cannot call requireDm themselves — an
      // action has no database — so each one's authority lives in an
      // internal function, and that function is where it is checked.
      for (const [action, gate] of [
        ["startRecording", "create"],
        ["deleteRecording", "beforeDelete"],
      ]) {
        // \b on the end, because "create" is a prefix of every name a
        // refactor would give the ungated version of it —
        // createUnchecked, createRow — and an unanchored match would
        // find the new call and report the old check as still there.
        if (
          !new RegExp(`internal\\.recorder\\.${gate}\\b`).test(fnBody(action))
        ) {
          problems.push(
            `recorder.${action} no longer goes through ${gate}, which is ` +
              "where its GM check lives"
          );
        }
      }
      for (const gate of ["create", "beforeDelete"]) {
        if (!/await requireDm\(ctx, (args|rec)\.campaignId\)/.test(fnBody(gate))) {
          problems.push(
            `recorder.${gate} does not requireDm, so the action that calls ` +
              "it is doing no check at all — any signed-in user could open " +
              "a recording in any campaign"
          );
        }
      }

      // Everything the home server's HTTP routes reach, plus the
      // summarizer, must stay internal. These functions check nothing
      // themselves — the route checks the shared secret — so one of
      // them made public is a transcript anyone can write, or read.
      for (const fn of [
        "create",
        "removeRows",
        "beforeDelete",
        "ingestBegin",
        "ingestTranscript",
        "ingestFailed",
        "forIngest",
        "saveSummary",
        "summaryFailed",
        "transcriptFor",
        "summarize",
      ]) {
        if (
          !new RegExp(
            `export const ${fn} = internal(Mutation|Query|Action)\\(`
          ).test(rec)
        ) {
          problems.push(
            `recorder.${fn} is not declared internal. It is reachable from ` +
              "the home server's routes or from the scheduler, neither of " +
              "which has a user behind it, so it does no check of its own"
          );
        }
      }

      if (/requireMember/.test(rec)) {
        problems.push(
          "convex/recorder.ts uses requireMember — a session transcript has " +
            "no player-facing version, so a non-GM caller is refused rather " +
            "than served a filtered one"
        );
      }

      // And nothing else in the backend touches the two tables. A
      // future tool wanting "what did we decide last session" is
      // exactly the change that would add a player-readable path to a
      // transcript without anyone thinking of it as one.
      for (const [file, src] of sourceFiles("convex")) {
        // schema.ts DEFINES them, campaigns.ts sweeps them on a purge,
        // and recorder.ts owns them. Everything else is the check.
        if (
          file.endsWith("recorder.ts") ||
          file.endsWith("campaigns.ts") ||
          file.endsWith("schema.ts") ||
          file.includes("_generated")
        ) {
          continue;
        }
        for (const table of ["transcriptChunks", '"recordings"']) {
          if (src.includes(table)) {
            problems.push(
              `${file} reads ${table.replace(/"/g, "")}. Only convex/recorder.ts ` +
                "may, plus the campaign purge — a transcript reached through " +
                "another module is a transcript reached without this file's " +
                "checks"
            );
          }
        }
      }
    }

    return problems;
  },
};
