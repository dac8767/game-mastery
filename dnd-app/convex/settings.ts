import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { isAdminEligible, requireUser } from "./auth";

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

const DEFAULTS = {
  theme: "candlelight" as const,
  viewAsPlayer: false,
  adminOverride: false,
  toolbarTokens: [] as string[],
  toolbarSet: false,
};

/** Shared reader so queries can honour viewAsPlayer without duplication. */
export async function getSettings(ctx: QueryCtx, userId: Id<"users">) {
  const doc = await ctx.db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return doc
    ? {
        theme: doc.theme,
        viewAsPlayer: doc.viewAsPlayer,
        adminOverride: doc.adminOverride ?? false,
        toolbarTokens: doc.toolbarTokens ?? [],
        // Reported as stored. The client seeds the default layout from
        // this flag alone — an empty toolbar is something a person can
        // legitimately have made, so "the array is empty" must never
        // stand in for "never arranged one".
        toolbarSet: doc.toolbarSet ?? false,
      }
    : DEFAULTS;
}

export const mySettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const settings = await getSettings(ctx, userId);
    // Eligibility is read from the deployment env var, never stored, so
    // the client can be told about it but can never grant it.
    return { ...settings, adminEligible: await isAdminEligible(ctx, userId) };
  },
});

export const saveMySettings = mutation({
  args: {
    theme: v.optional(themeValidator),
    viewAsPlayer: v.optional(v.boolean()),
    adminOverride: v.optional(v.boolean()),
    toolbarTokens: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    // Turning the override ON requires eligibility. Turning it off is
    // always allowed — nobody should ever be stuck holding it.
    if (args.adminOverride === true && !(await isAdminEligible(ctx, userId))) {
      throw new Error("Not an admin");
    }

    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        theme: args.theme ?? existing.theme,
        viewAsPlayer: args.viewAsPlayer ?? existing.viewAsPlayer,
        adminOverride: args.adminOverride ?? existing.adminOverride ?? false,
        // Writing a layout at all is what sets the flag, including an
        // empty one — that is the whole point of keeping it separate.
        toolbarTokens: args.toolbarTokens ?? existing.toolbarTokens,
        toolbarSet:
          args.toolbarTokens !== undefined || (existing.toolbarSet ?? false),
      });
      return;
    }

    await ctx.db.insert("userSettings", {
      userId,
      theme: args.theme ?? DEFAULTS.theme,
      viewAsPlayer: args.viewAsPlayer ?? DEFAULTS.viewAsPlayer,
      adminOverride: args.adminOverride ?? DEFAULTS.adminOverride,
      toolbarTokens: args.toolbarTokens,
      toolbarSet: args.toolbarTokens !== undefined,
    });
  },
});

/**
 * The signed-in person's name and email.
 *
 * The feedback form prefills from this instead of asking for a profile
 * the way a signed-out app has to — everyone here is already
 * authenticated, so asking again would be a form asking a question it
 * can already answer.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    return {
      email: user?.email ?? null,
      name: profile?.displayName ?? user?.name ?? null,
    };
  },
});
