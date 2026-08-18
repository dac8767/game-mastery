import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  hasActiveAdmin,
  requireDm,
  requireMember,
  requireUser,
} from "./auth";

/**
 * Campaigns, membership, and characters.
 *
 * Two campaigns = your two groups. Members are added by the DM by email
 * lookup after players have created their accounts (no invite-link system
 * needed at this scale).
 */

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
      // Players never write DM notes.
      const patch = isDm ? fields : { ...fields, notes: existing.notes };
      await ctx.db.patch(characterId, patch);
      return characterId;
    }
    // Players never write DM notes — on create either.
    return await ctx.db.insert("characters", {
      ...fields,
      notes: isDm ? fields.notes : undefined,
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
    // Strip DM notes for players.
    return characters.map((c) =>
      isDm ? c : { ...c, notes: undefined }
    );
  },
});
