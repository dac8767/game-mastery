import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";

/**
 * Campaign chat.
 *
 * Built on Convex rather than ported from Stoat: everyone here already
 * has an account and a role, so a chat that knows who the DM is comes
 * free, where a separate platform would mean a second login and a
 * second identity to keep in step.
 *
 * Visibility is enforced on every read and every send, never in the UI.
 * A player must not be able to discover that a dmOnly channel exists, so
 * those are filtered out of the list rather than returned locked — the
 * same rule as hidden NPCs.
 */

/** Recent history is bounded: chat grows without limit, subscriptions
 *  re-send on every new message, and nobody scrolls back 10,000 lines. */
const MESSAGE_WINDOW = 100;
const MAX_BODY = 4000;

function canSee(
  channel: Doc<"chatChannels">,
  userId: Id<"users">,
  isDm: boolean
): boolean {
  if (isDm) return true; // the DM sees every channel in their campaign
  switch (channel.visibility) {
    case "everyone":
      return true;
    case "dmOnly":
      return false;
    case "private":
      return (channel.memberIds ?? []).includes(userId);
  }
}

/** Channels the caller may see, in order. */
export const listChannels = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { userId, isDm } = await requireMember(ctx, args.campaignId);

    const channels = await ctx.db
      .query("chatChannels")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(100);

    return channels
      .filter((c) => canSee(c, userId, isDm))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((c) => ({
        _id: c._id,
        name: c.name,
        visibility: c.visibility,
        memberCount: c.memberIds?.length ?? null,
      }));
  },
});

/** Resolve display names once per author rather than once per message. */
async function authorNames(
  ctx: QueryCtx,
  userIds: Id<"users">[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(userIds)) {
    const user = await ctx.db.get(id);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", id))
      .unique();
    out.set(
      id,
      profile?.displayName ||
        user?.name ||
        user?.email?.split("@")[0] ||
        "Someone"
    );
  }
  return out;
}

export const listMessages = query({
  args: { channelId: v.id("chatChannels") },
  handler: async (ctx, args) => {
    const channel = await ctx.db.get(args.channelId);
    if (!channel) return null;
    const { userId, isDm } = await requireMember(ctx, channel.campaignId);
    // Indistinguishable from "no such channel": a player probing an id
    // must not learn that a dmOnly channel is there.
    if (!canSee(channel, userId, isDm)) return null;

    const recent = await ctx.db
      .query("chatMessages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .take(MESSAGE_WINDOW);

    const names = await authorNames(
      ctx,
      recent.map((m) => m.userId)
    );

    return {
      channelName: channel.name,
      visibility: channel.visibility,
      canPost: true,
      messages: recent
        .reverse() // newest last, the way a transcript reads
        .map((m) => ({
          _id: m._id,
          body: m.body,
          at: m._creationTime,
          editedAt: m.editedAt ?? null,
          authorName: names.get(m.userId) ?? "Someone",
          isMine: m.userId === userId,
          canDelete: m.userId === userId || isDm,
        })),
    };
  },
});

export const createChannel = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    visibility: v.union(
      v.literal("everyone"),
      v.literal("dmOnly"),
      v.literal("private")
    ),
    memberIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) => {
    // Only the DM shapes the campaign's channels.
    await requireDm(ctx, args.campaignId);

    const existing = await ctx.db
      .query("chatChannels")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(100);
    if (existing.length >= 100) throw new Error("Too many channels");

    const order = existing.reduce((max, c) => Math.max(max, c.order), 0) + 1;

    return await ctx.db.insert("chatChannels", {
      campaignId: args.campaignId,
      name: args.name.trim() || "channel",
      visibility: args.visibility,
      memberIds: args.visibility === "private" ? (args.memberIds ?? []) : undefined,
      order,
    });
  },
});

export const deleteChannel = mutation({
  args: { channelId: v.id("chatChannels") },
  handler: async (ctx, args) => {
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error("Not found");
    await requireDm(ctx, channel.campaignId);

    // Messages first: a channel deleted with its messages still pointing
    // at it leaves rows nothing can ever read or clean up.
    let remaining = true;
    while (remaining) {
      const batch = await ctx.db
        .query("chatMessages")
        .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
        .take(200);
      for (const m of batch) await ctx.db.delete(m._id);
      remaining = batch.length === 200;
    }
    await ctx.db.delete(args.channelId);
  },
});

export const sendMessage = mutation({
  args: { channelId: v.id("chatChannels"), body: v.string() },
  handler: async (ctx, args) => {
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error("Not found");
    const { userId, isDm } = await requireMember(ctx, channel.campaignId);
    if (!canSee(channel, userId, isDm)) throw new Error("Not found");

    const body = args.body.trim();
    if (!body) return;
    if (body.length > MAX_BODY) throw new Error("That message is too long.");

    await ctx.db.insert("chatMessages", {
      channelId: args.channelId,
      campaignId: channel.campaignId,
      userId,
      body,
    });
  },
});

export const deleteMessage = mutation({
  args: { messageId: v.id("chatMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Not found");
    const { userId, isDm } = await requireMember(ctx, message.campaignId);
    // Your own words, or the DM moderating their table.
    if (message.userId !== userId && !isDm) throw new Error("Not yours");
    await ctx.db.delete(args.messageId);
  },
});
