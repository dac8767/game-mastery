import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  hasActiveAdmin,
  requireDm,
  requireMember,
  requireUser,
} from "./auth";

/**
 * Campaigns, membership, and characters.
 *
 * Two campaigns = your two groups. A DM adds a member either by the
 * email they already signed up with, or — for somebody with no account
 * yet — by handing them an invite link, which is the only path that
 * works before the person exists in the database at all.
 */

/** The picker shows every campaign you are in; admins see a bounded set. */
const MAX_CARDS = 60;

/** Characters read per card. A party larger than this is not a party. */
const MAX_PARTY = 20;

/**
 * Rows deleted per purge run, well under what one Convex mutation may
 * write. The job reschedules itself while there is more, so this is a
 * throughput knob rather than a limit on campaign size.
 */
const PURGE_BATCH = 200;

export const createCampaign = mutation({
  args: { name: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const campaignId = await ctx.db.insert("campaigns", {
      name: args.name,
      dmId: userId,
      description: args.description,
    });
    // Create the table state doc up front.
    await ctx.db.insert("tableState", {
      campaignId,
      showGrid: true,
    });
    return campaignId;
  },
});

/**
 * Campaigns the caller can see: their own as DM, the ones they play in,
 * and — only while the admin override is active — every campaign, so a
 * broken one can be opened and repaired.
 */
export const myCampaigns = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);

    if (await hasActiveAdmin(ctx, userId)) {
      const every = await ctx.db.query("campaigns").take(200);
      return every.map((c) => ({
        ...c,
        isDm: c.dmId === userId,
        // Borrowed authority is labelled, never disguised as ownership.
        viaAdmin: c.dmId !== userId,
      }));
    }

    const asDm = await ctx.db
      .query("campaigns")
      .withIndex("by_dm", (q) => q.eq("dmId", userId))
      .collect();
    const memberships = await ctx.db
      .query("campaignMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const asMember = (
      await Promise.all(memberships.map((m) => ctx.db.get(m.campaignId)))
    ).filter((c): c is NonNullable<typeof c> => c !== null);

    const seen = new Set<string>();
    return [...asDm, ...asMember]
      .filter((c) => {
        if (seen.has(c._id)) return false;
        seen.add(c._id);
        return true;
      })
      .map((c) => ({ ...c, isDm: c.dmId === userId, viaAdmin: false }));
  },
});

/**
 * The picker's cards: everything shown before you have chosen a
 * campaign — its picture, when it started, when you next play, who runs
 * it, and who is at the table.
 *
 * Separate from myCampaigns on purpose. That one is subscribed to by
 * the app shell and by Lookup on every screen, so it stays a cheap list
 * of names and roles; this one fans out to members, profiles, characters
 * and file storage, and is only ever mounted on the one page that shows
 * all of it.
 */
export const campaignCards = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const admin = await hasActiveAdmin(ctx, userId);

    const mine = admin
      ? await ctx.db.query("campaigns").take(MAX_CARDS)
      : await (async () => {
          const asDm = await ctx.db
            .query("campaigns")
            .withIndex("by_dm", (q) => q.eq("dmId", userId))
            .collect();
          const memberships = await ctx.db
            .query("campaignMembers")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect();
          const asMember = (
            await Promise.all(memberships.map((m) => ctx.db.get(m.campaignId)))
          ).filter((c): c is NonNullable<typeof c> => c !== null);
          const seen = new Set<string>();
          return [...asDm, ...asMember].filter((c) => {
            if (seen.has(c._id)) return false;
            seen.add(c._id);
            return true;
          });
        })();

    return await Promise.all(
      mine.map(async (c) => {
        const dmProfile = await ctx.db
          .query("profiles")
          .withIndex("by_user", (q) => q.eq("userId", c.dmId))
          .unique();

        const characters = await ctx.db
          .query("characters")
          .withIndex("by_campaign", (q) => q.eq("campaignId", c._id))
          .take(MAX_PARTY);

        return {
          _id: c._id,
          name: c.name,
          description: c.description ?? null,
          startDate: c.startDate ?? null,
          nextSessionDate: c.nextSessionDate ?? null,
          rulesVersion: c.rulesVersion ?? null,
          leveling: c.leveling ?? "xp",
          isDm: c.dmId === userId,
          viaAdmin: admin && c.dmId !== userId,
          imageUrl: c.imageId ? await ctx.storage.getUrl(c.imageId) : null,
          imagePath: c.imagePath ?? null,
          dmName: dmProfile?.displayName ?? "the DM",
          /**
           * The party as the DM entered it. A character with no player
           * at all is the DM's own sheet and is not somebody at the
           * table, so it is left off the card's roster.
           */
          party: await Promise.all(
            characters
              .filter((ch) => ch.playerId || ch.playerName)
              .map(async (ch) => ({
                _id: ch._id,
                name: ch.name,
                playerName: ch.playerName ?? null,
                claimed: ch.playerId !== undefined,
                portraitUrl: ch.portraitId
                  ? await ctx.storage.getUrl(ch.portraitId)
                  : null,
                portraitPath: ch.portraitPath ?? null,
              }))
          ),
        };
      })
    );
  },
});

/** DM: the details behind a campaign card. */
export const updateCampaign = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    startDate: v.optional(v.string()),
    nextSessionDate: v.optional(v.string()),
    imagePath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const { campaignId, ...fields } = args;

    // A blank string is "clear this", not the literal empty string —
    // otherwise a cleared date sorts and renders as a real value.
    const patch: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (key === "name" && trimmed === "") continue; // a campaign needs one
      patch[key] = trimmed === "" ? undefined : trimmed;
    }
    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(campaignId, patch);
  },
});

export const generateImageUploadUrl = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** DM: attach an uploaded picture, replacing whatever was there. */
export const setCampaignImage = mutation({
  args: {
    campaignId: v.id("campaigns"),
    storageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Campaign not found");

    // The old blob is nobody's after this, and file storage is the part
    // of the free tier worth not littering.
    if (campaign.imageId && campaign.imageId !== args.storageId) {
      await ctx.storage.delete(campaign.imageId);
    }
    await ctx.db.patch(args.campaignId, {
      imageId: args.storageId ?? undefined,
    });
  },
});

/**
 * DM: delete a campaign, and everything in it.
 *
 * The typed name is the whole safety mechanism. There is no undo and no
 * backup here: a confirm dialog is one misplaced click, and this throws
 * away a notebook, an NPC roster and a campaign's history at once.
 *
 * The campaign row goes immediately so the picker stops showing it, and
 * its contents are swept up by a scheduled job — a campaign's worth of
 * rows can exceed what one mutation may write, so the purge deletes a
 * bounded batch and reschedules itself until nothing is left.
 */
export const deleteCampaign = mutation({
  args: { campaignId: v.id("campaigns"), confirmName: v.string() },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Campaign not found");

    if (args.confirmName.trim() !== campaign.name.trim()) {
      throw new Error(
        `That is not the campaign's name. Type "${campaign.name}" exactly.`
      );
    }

    if (campaign.imageId) await ctx.storage.delete(campaign.imageId);
    await ctx.db.delete(args.campaignId);
    await ctx.scheduler.runAfter(0, internal.campaigns.purgeCampaign, {
      campaignId: args.campaignId,
    });
  },
});

/**
 * DM: choose which edition this table plays.
 *
 * Campaign-wide rather than personal — an edition is a property of the
 * game everyone at the table is in, not of one person's browser — so it
 * goes through requireDm like every other game-state change.
 */
/**
 * DM: choose how this table levels. Campaign-wide for the same reason
 * the edition is — it changes what everyone sees on a session, and it
 * goes through requireDm like every other game-state change.
 */
export const setLeveling = mutation({
  args: {
    campaignId: v.id("campaigns"),
    leveling: v.union(v.literal("xp"), v.literal("milestone")),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    await ctx.db.patch(args.campaignId, { leveling: args.leveling });
  },
});

export const setRulesVersion = mutation({
  args: {
    campaignId: v.id("campaigns"),
    rulesVersion: v.union(v.literal("2014"), v.literal("2024")),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    await ctx.db.patch(args.campaignId, { rulesVersion: args.rulesVersion });
  },
});

/**
 * Sweep up everything that belonged to a deleted campaign.
 *
 * Internal and unauthenticated by design: the campaign row is already
 * gone by the time this runs, so there is no DM left to check against.
 * deleteCampaign is the only thing that schedules it, and that one does
 * check.
 *
 * Children before parents, so an interrupted run never strands rows
 * behind a parent that no longer exists. Every table carrying a
 * campaignId is listed here, plus the two — notebookBoxes, combatants —
 * reachable only through one. tests/guards/integrity.mjs reads the
 * schema and fails if a campaign-scoped table is missing from this
 * function, because the cost of forgetting one is invisible: rows that
 * are never read, never shown, and never deleted.
 *
 * Uploaded files go too. Convex storage is billed by what is stored,
 * not by what is referenced, so an orphaned blob is a bill with no
 * screen to show for it.
 */
export const purgeCampaign = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { campaignId } = args;
    let left = PURGE_BATCH;

    /** Delete up to the remaining budget; report whether more remain. */
    const sweep = async <T extends { _id: any }>(
      rows: T[],
      onDelete?: (row: T) => Promise<void>
    ) => {
      for (const row of rows) {
        if (left <= 0) return true;
        if (onDelete) await onDelete(row);
        await ctx.db.delete(row._id);
        left--;
      }
      return false;
    };

    const more = async () => {
      await ctx.scheduler.runAfter(0, internal.campaigns.purgeCampaign, {
        campaignId,
      });
    };

    // ---- children reachable only through a parent -------------------
    const encounters = await ctx.db
      .query("encounters")
      .withIndex("by_campaign_status", (q) => q.eq("campaignId", campaignId))
      .take(MAX_PARTY);
    for (const encounter of encounters) {
      const combatants = await ctx.db
        .query("combatants")
        .withIndex("by_encounter", (q) => q.eq("encounterId", encounter._id))
        .take(left);
      if (await sweep(combatants)) return await more();
    }

    const channels = await ctx.db
      .query("chatChannels")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(MAX_PARTY);
    for (const channel of channels) {
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .take(left);
      if (await sweep(messages)) return await more();
    }

    const nodes = await ctx.db
      .query("notebookNodes")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(MAX_PARTY);
    for (const node of nodes) {
      const boxes = await ctx.db
        .query("notebookBoxes")
        .withIndex("by_page", (q) => q.eq("pageId", node._id))
        .take(left);
      if (
        await sweep(boxes, async (b) => {
          if (b.storageId) await ctx.storage.delete(b.storageId);
        })
      ) {
        return await more();
      }
    }

    // ---- everything keyed directly by the campaign ------------------
    if (await sweep(encounters)) return await more();
    if (await sweep(channels)) return await more();
    if (await sweep(nodes)) return await more();

    const npcs = await ctx.db
      .query("npcs")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (
      await sweep(npcs, async (n) => {
        if (n.portraitId) await ctx.storage.delete(n.portraitId);
      })
    ) {
      return await more();
    }

    const locations = await ctx.db
      .query("locations")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (
      await sweep(locations, async (l) => {
        if (l.mapId) await ctx.storage.delete(l.mapId);
        for (const id of l.pictureIds ?? []) await ctx.storage.delete(id);
      })
    ) {
      return await more();
    }

    // A session's notes hang off the session, so they go first — the
    // same order the encounters' combatants and the notebook's boxes
    // are swept in.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(MAX_PARTY);
    for (const session of sessions) {
      const boxes = await ctx.db
        .query("sessionBoxes")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(left);
      if (
        await sweep(boxes, async (b) => {
          if (b.storageId) await ctx.storage.delete(b.storageId);
        })
      ) {
        return await more();
      }

      // And the page those boxes sat on. It holds no files, so it
      // sweeps without the storage callback — but it holds the text,
      // which is the part somebody asked to be rid of.
      const pages = await ctx.db
        .query("sessionPages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(left);
      if (await sweep(pages)) return await more();
    }
    if (await sweep(sessions)) return await more();

    const groups = await ctx.db
      .query("groups")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (
      await sweep(groups, async (g) => {
        for (const id of g.attachmentIds ?? []) await ctx.storage.delete(id);
      })
    ) {
      return await more();
    }

    const characters = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (
      await sweep(characters, async (c) => {
        if (c.portraitId) await ctx.storage.delete(c.portraitId);
      })
    ) {
      return await more();
    }

    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(calendars)) return await more();

    const calendarEvents = await ctx.db
      .query("calendarEvents")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(calendarEvents)) return await more();

    const npcNotes = await ctx.db
      .query("npcNotes")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (
      await sweep(npcNotes, async (n) => {
        for (const id of n.imageIds ?? []) await ctx.storage.delete(id);
      })
    ) {
      return await more();
    }

    /* The DM Screen's rows. Their index is by_campaign_user, which a
       campaign-only prefix query still walks — every user's screens,
       workspaces and notes for this campaign go. */
    const dmScreens = await ctx.db
      .query("dmScreens")
      .withIndex("by_campaign_user", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(dmScreens)) return await more();

    const dmWorkspaces = await ctx.db
      .query("dmWorkspaces")
      .withIndex("by_campaign_user", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(dmWorkspaces)) return await more();

    const dmNotes = await ctx.db
      .query("dmNotes")
      .withIndex("by_campaign_user", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(dmNotes)) return await more();

    const npcTemplates = await ctx.db
      .query("npcTemplates")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(npcTemplates)) return await more();

    const schedules = await ctx.db
      .query("schedules")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(schedules)) return await more();

    const availability = await ctx.db
      .query("availability")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(availability)) return await more();

    const prefs = await ctx.db
      .query("viewPrefs")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(prefs)) return await more();

    const invites = await ctx.db
      .query("campaignInvites")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(invites)) return await more();

    const uiOverrides = await ctx.db
      .query("uiOverrides")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(uiOverrides)) return await more();

    const members = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(members)) return await more();

    const state = await ctx.db
      .query("tableState")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .take(left);
    if (await sweep(state)) return await more();
  },
});

/**
 * DM: hand the campaign to someone else.
 *
 * Authority in this app is structural — you are the DM of a campaign
 * because `dmId` is you — so handing it over is a one-field change and
 * every check in the app follows immediately. There is no role table to
 * fall out of step with.
 *
 * The outgoing DM is kept as a MEMBER rather than dropped. Someone who
 * built a campaign and handed it to a friend should not lose the ability
 * to open it in the same click; leaving is a separate, deliberate act.
 * The incoming DM keeps their membership row too — harmless, and it
 * means transferring back does not have to reinstate one.
 *
 * Only a member can receive it. Handing a campaign to a stranger would
 * be a way to lose one permanently, and the DM is by definition someone
 * at the table.
 */
export const transferDm = mutation({
  args: { campaignId: v.id("campaigns"), toUserId: v.id("users") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Campaign not found");
    if (campaign.dmId === args.toUserId) return;

    const membership = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", args.toUserId)
      )
      .unique();
    if (!membership) {
      throw new Error(
        "Only someone already in the campaign can be made DM — add them first"
      );
    }

    const outgoing = campaign.dmId;
    await ctx.db.patch(args.campaignId, { dmId: args.toUserId });

    // Keep the outgoing DM in the game unless they choose otherwise.
    const existing = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", outgoing)
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("campaignMembers", {
        campaignId: args.campaignId,
        userId: outgoing,
      });
    }
  },
});

/** DM: add a player to the campaign by the email they signed up with. */
export const addMemberByEmail = mutation({
  args: { campaignId: v.id("campaigns"), email: v.string() },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const email = args.email.trim().toLowerCase();

    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), email))
      .unique();
    if (!user) {
      throw new Error(
        `No account found for ${email} — have them sign up first`
      );
    }
    const existing = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", user._id)
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("campaignMembers", {
      campaignId: args.campaignId,
      userId: user._id,
    });
  },
});

/** Members + their profiles, for the DM's roster view. */
export const listMembers = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    const members = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    return await Promise.all(
      members.map(async (m) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_user", (q) => q.eq("userId", m.userId))
          .unique();
        return {
          userId: m.userId,
          displayName: profile?.displayName ?? "Unnamed",
          accentColor: profile?.accentColor,
          portraitPath: profile?.portraitPath,
        };
      })
    );
  },
});

// ---------- Characters ----------

export const upsertCharacter = mutation({
  args: {
    characterId: v.optional(v.id("characters")),
    campaignId: v.id("campaigns"),
    playerId: v.optional(v.id("users")),
    name: v.string(),
    className: v.optional(v.string()),
    level: v.optional(v.number()),
    maxHp: v.number(),
    ac: v.optional(v.number()),
    initiativeBonus: v.optional(v.number()),
    playerName: v.optional(v.string()),
    portraitPath: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, isDm } = await requireMember(ctx, args.campaignId);
    // Players may only manage their own characters; the DM can manage any.
    if (!isDm && args.playerId !== userId) {
      throw new Error("You can only edit your own character");
    }
    const { characterId, ...fields } = args;
    if (characterId) {
      const existing = await ctx.db.get(characterId);
      if (!existing || existing.campaignId !== args.campaignId) {
        throw new Error("Character not found in this campaign");
      }
      if (!isDm && existing.playerId !== userId) {
        throw new Error("You can only edit your own character");
      }
      // Players never write DM notes, and never rename who plays what —
      // playerName is the DM's roster of people who have not signed up,
      // so a player editing their own sheet must not be able to reassign
      // it to somebody else.
      const patch = isDm
        ? fields
        : { ...fields, notes: existing.notes, playerName: existing.playerName };
      await ctx.db.patch(characterId, patch);
      return characterId;
    }
    // Players never write DM notes — on create either.
    return await ctx.db.insert("characters", {
      ...fields,
      notes: isDm ? fields.notes : undefined,
      playerName: isDm ? fields.playerName : undefined,
    });
  },
});

/**
 * DM: take a character off the roster.
 *
 * DM-only even for a claimed character: a player leaving the table is
 * the DM's call, and a player deleting their own sheet mid-campaign
 * takes the party's history with it.
 */
export const deleteCharacter = mutation({
  args: { characterId: v.id("characters") },
  handler: async (ctx, args) => {
    const character = await ctx.db.get(args.characterId);
    if (!character) return;
    await requireDm(ctx, character.campaignId);
    if (character.portraitId) await ctx.storage.delete(character.portraitId);
    await ctx.db.delete(args.characterId);
  },
});

export const generatePortraitUploadUrl = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Attach uploaded art to a character. The DM, or the player who owns it. */
export const setCharacterPortrait = mutation({
  args: {
    characterId: v.id("characters"),
    storageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, args) => {
    const character = await ctx.db.get(args.characterId);
    if (!character) throw new Error("Character not found");
    const { userId, isDm } = await requireMember(ctx, character.campaignId);
    if (!isDm && character.playerId !== userId) {
      throw new Error("You can only change your own character");
    }
    if (character.portraitId && character.portraitId !== args.storageId) {
      await ctx.storage.delete(character.portraitId);
    }
    await ctx.db.patch(args.characterId, {
      portraitId: args.storageId ?? undefined,
    });
  },
});

export const listCharacters = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { isDm } = await requireMember(ctx, args.campaignId);
    const characters = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    // Strip DM notes for players, and resolve the portrait: a storage
    // id is useless to the browser, and the shaping belongs here rather
    // than in every screen that draws a character.
    return await Promise.all(
      characters.map(async (c) => ({
        ...(isDm ? c : { ...c, notes: undefined }),
        portraitUrl: c.portraitId ? await ctx.storage.getUrl(c.portraitId) : null,
      }))
    );
  },
});

/* ---------- invites: the way into a campaign -------------------------
 *
 * addMemberByEmail above can only add an account that already exists,
 * so inviting someone who has never signed up was a conversation rather
 * than a link. These four functions are the link.
 *
 * The rules — how long, how many, revoked — live in
 * components/inviteModel.ts and are duplicated here as constants rather
 * than imported: convex/ and components/ are separate compilations, and
 * the integrity guard compares the two copies.
 */

/** Matches INVITE_LIMITS in components/inviteModel.ts. */
const INVITE_DEFAULT_DAYS = 14;
const INVITE_MAX_DAYS = 90;
const INVITE_DEFAULT_USES = 1;
const INVITE_MAX_USES = 50;

/** DM: mint a link. */
export const createInvite = mutation({
  args: {
    campaignId: v.id("campaigns"),
    days: v.optional(v.number()),
    uses: v.optional(v.number()),
    characterId: v.optional(v.id("characters")),
  },
  handler: async (ctx, args) => {
    const userId = await requireDm(ctx, args.campaignId);

    // A character from ANOTHER campaign would hand a stranger a sheet in
    // a game they were never invited to.
    if (args.characterId) {
      const character = await ctx.db.get(args.characterId);
      if (!character || character.campaignId !== args.campaignId) {
        throw new Error("That character is not in this campaign");
      }
    }

    const days = Math.min(
      INVITE_MAX_DAYS,
      Math.max(1, Math.round(args.days ?? INVITE_DEFAULT_DAYS) || INVITE_DEFAULT_DAYS)
    );
    const uses = Math.min(
      INVITE_MAX_USES,
      Math.max(1, Math.round(args.uses ?? INVITE_DEFAULT_USES) || INVITE_DEFAULT_USES)
    );

    const token = crypto.randomUUID().replace(/-/g, "");

    await ctx.db.insert("campaignInvites", {
      campaignId: args.campaignId,
      token,
      createdBy: userId,
      expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
      usesLeft: uses,
      characterId: args.characterId,
    });

    return token;
  },
});

/** DM: the links that exist, so they can be copied or killed. */
export const listInvites = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const invites = await ctx.db
      .query("campaignInvites")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();

    return await Promise.all(
      invites.map(async (i) => ({
        _id: i._id,
        token: i.token,
        expiresAt: i.expiresAt,
        usesLeft: i.usesLeft,
        revokedAt: i.revokedAt,
        characterName: i.characterId
          ? (await ctx.db.get(i.characterId))?.name ?? null
          : null,
      }))
    );
  },
});

/** DM: kill a link. Kept rather than deleted, so it reads as cancelled. */
export const revokeInvite = mutation({
  args: { inviteId: v.id("campaignInvites") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return;
    await requireDm(ctx, invite.campaignId);
    await ctx.db.patch(args.inviteId, { revokedAt: Date.now() });
  },
});

/**
 * What a link is for, WITHOUT being signed in.
 *
 * This is the only function in the app that answers to nobody, because
 * it has to: the person clicking has no account yet, and "sign up to
 * find out what you are joining" is not an invitation.
 *
 * So it returns the campaign's NAME, the DM's display name, and the
 * character being offered — and nothing else. Not the id, not the
 * roster, not the description. A stranger guessing tokens learns
 * whether a guess hit, which unguessable tokens already concede, and
 * one campaign name.
 *
 * A dead link and a token that never existed return the same shape with
 * different reasons; the client says the same words for both.
 */
export const peekInvite = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("campaignInvites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!invite) return { ok: false as const, problem: "unknown" as const };
    if (invite.revokedAt !== undefined) {
      return { ok: false as const, problem: "revoked" as const };
    }
    if (invite.expiresAt <= Date.now()) {
      return { ok: false as const, problem: "expired" as const };
    }
    if (invite.usesLeft <= 0) {
      return { ok: false as const, problem: "spent" as const };
    }

    const campaign = await ctx.db.get(invite.campaignId);
    if (!campaign) return { ok: false as const, problem: "unknown" as const };

    const dmProfile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", campaign.dmId))
      .unique();
    const character = invite.characterId
      ? await ctx.db.get(invite.characterId)
      : null;

    return {
      ok: true as const,
      campaignName: campaign.name,
      dmName: dmProfile?.displayName ?? "the DM",
      characterName: character?.name ?? null,
    };
  },
});

/**
 * Spend a link and join the campaign.
 *
 * Signed in, necessarily — this is the step that needs an account to
 * attach the membership to, which is why the join page signs you up
 * first and calls this second.
 *
 * Every check from peekInvite runs AGAIN here. peek is a courtesy for
 * the screen; this is the gate, and the two are minutes apart in a flow
 * that includes creating an account.
 */
export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const invite = await ctx.db
      .query("campaignInvites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!invite) throw new Error("This invite link is not valid");
    if (invite.revokedAt !== undefined) {
      throw new Error("This invite was cancelled");
    }
    if (invite.expiresAt <= Date.now()) {
      throw new Error("This invite has expired");
    }
    if (invite.usesLeft <= 0) {
      throw new Error("This invite has already been used");
    }

    const campaign = await ctx.db.get(invite.campaignId);
    if (!campaign) throw new Error("This invite link is not valid");

    // Already in? Then the link is not spent on them — walking into a
    // room you are already in should not use up somebody else's seat.
    const existing = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", invite.campaignId).eq("userId", userId)
      )
      .unique();
    const alreadyIn = existing !== null || campaign.dmId === userId;

    if (!alreadyIn) {
      await ctx.db.insert("campaignMembers", {
        campaignId: invite.campaignId,
        userId,
      });
      await ctx.db.patch(invite._id, { usesLeft: invite.usesLeft - 1 });
    }

    // The character, if this link carried one and nobody has claimed it.
    // Not reassigned if someone already has it: two people following the
    // same link must not end up fighting over one sheet.
    if (invite.characterId) {
      const character = await ctx.db.get(invite.characterId);
      if (
        character &&
        character.campaignId === invite.campaignId &&
        character.playerId === undefined
      ) {
        await ctx.db.patch(invite.characterId, { playerId: userId });
      }
    }

    return invite.campaignId;
  },
});
