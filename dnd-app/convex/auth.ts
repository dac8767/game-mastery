import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Auth + authorization helpers for the D&D app.
 *
 * Same Password-provider pattern as the home app: no public signup page in
 * the UI, and Cloudflare Access already gates the map server separately.
 * Roles are structural, not stored: you are "the DM" of a campaign iff
 * campaign.dmId === your userId. This keeps authority checks impossible
 * to desync from the data.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});

type Ctx = QueryCtx | MutationCtx;

/** Throws if not signed in; returns the userId. */
export async function requireUser(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not signed in");
  }
  return userId;
}

/**
 * Throws unless the caller is the DM of the campaign.
 * Every game-state mutation goes through this.
 */
export async function requireDm(
  ctx: Ctx,
  campaignId: Id<"campaigns">
): Promise<Id<"users">> {
  const userId = await requireUser(ctx);
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }
  if (campaign.dmId !== userId) {
    throw new Error("Only the DM can do that");
  }
  return userId;
}

/**
 * Throws unless the caller is the DM or a member of the campaign.
 * Returns whether the caller is the DM so queries can shape output.
 */
export async function requireMember(
  ctx: Ctx,
  campaignId: Id<"campaigns">
): Promise<{ userId: Id<"users">; isDm: boolean }> {
  const userId = await requireUser(ctx);
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }
  if (campaign.dmId === userId) {
    return { userId, isDm: true };
  }
  const membership = await ctx.db
    .query("campaignMembers")
    .withIndex("by_campaign_user", (q) =>
      q.eq("campaignId", campaignId).eq("userId", userId)
    )
    .unique();
  if (!membership) {
    throw new Error("Not a member of this campaign");
  }
  return { userId, isDm: false };
}
