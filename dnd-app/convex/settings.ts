import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireUser } from "./auth";

/**
 * Personal app settings.
 *
 * Everything here is scoped to the caller, resolved from the auth
 * context — no function takes a userId, because an argument is
 * something a client can lie about. Changing your theme changes nothing
 * for anyone else.
 *
 * Deliberately absent: a DM/player role switch. Authority in this app is
 * structural (campaign.dmId === userId) precisely so it cannot desync
 * from the data, and a settable role would hand every player the DM's
 * secrets. `viewAsPlayer` is the safe direction — a DM choosing to be
 * served the player's view — and is honoured by npcs.listForCampaign so
 * the preview is real rather than cosmetic.
 */

export const themeValidator = v.union(
  v.literal("candlelight"),
  v.literal("slate"),
  v.literal("parchment")
);

const DEFAULTS = { theme: "candlelight" as const, viewAsPlayer: false };

/** Shared reader so queries can honour viewAsPlayer without duplication. */
export async function getSettings(ctx: QueryCtx, userId: Id<"users">) {
  const doc = await ctx.db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return doc
    ? { theme: doc.theme, viewAsPlayer: doc.viewAsPlayer }
    : DEFAULTS;
}

export const mySettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    return await getSettings(ctx, userId);
  },
});

export const saveMySettings = mutation({
  args: {
    theme: v.optional(themeValidator),
    viewAsPlayer: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        theme: args.theme ?? existing.theme,
        viewAsPlayer: args.viewAsPlayer ?? existing.viewAsPlayer,
      });
      return;
    }

    await ctx.db.insert("userSettings", {
      userId,
      theme: args.theme ?? DEFAULTS.theme,
      viewAsPlayer: args.viewAsPlayer ?? DEFAULTS.viewAsPlayer,
    });
  },
});
