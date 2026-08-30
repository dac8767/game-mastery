import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Auth + authorization helpers for the D&D app.
 *
 * Same Password-provider pattern as the home app: no public signup page in
 * the UI, and Cloudflare Access already gates the map server separately.
 *
 * Roles are structural, not stored. You are "the GM" of a campaign iff
 * campaign.dmId === your userId, and roles are per-campaign — the same
 * person can GM one group and play in another with no flag to keep in
 * sync. Nothing in the app can grant a role to its own caller.
 *
 * Platform admin is the one cross-campaign power, and it is deliberately
 * the hardest thing here to obtain — see below.
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
 * Who may break glass, read from the ADMIN_EMAILS deployment variable.
 *
 * Deliberately NOT a table and NOT a mutation. Every other way of
 * granting this — a row, a flag, a settings field — is something a bug
 * or a compromised client could write. A deployment environment
 * variable can only be changed from the Convex dashboard or CLI, which
 * means changing who is an admin requires deployment access, not app
 * access.
 *
 *   npx convex env set ADMIN_EMAILS "you@example.com"
 *
 * Unset (the default) means nobody is eligible, which is the right
 * failure direction.
 */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Is this account allowed to turn admin access on at all? */
export async function isAdminEligible(
  ctx: Ctx,
  userId: Id<"users">
): Promise<boolean> {
  const allowed = adminEmails();
  if (allowed.length === 0) return false;
  const user = await ctx.db.get(userId);
  const email = user?.email?.toLowerCase();
  return Boolean(email && allowed.includes(email));
}

/**
 * Is admin access actually ACTIVE right now?
 *
 * Eligibility alone is not enough: the override is a switch in Settings
 * that defaults off. Break-glass access should be a thing you turn on to
 * investigate something, not a permanent state that quietly spoils every
 * campaign you are a player in. `viewAsPlayer` still wins over it, so
 * the player-preview remains truthful even for an admin.
 *
 * Read directly from userSettings rather than through convex/settings.ts
 * so this module stays free of a circular import.
 */
export async function hasActiveAdmin(
  ctx: Ctx,
  userId: Id<"users">
): Promise<boolean> {
  if (!(await isAdminEligible(ctx, userId))) return false;
  const settings = await ctx.db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return settings?.adminOverride === true;
}

/**
 * Throws unless the caller is the GM of the campaign — or an admin with
 * the override active, so a broken campaign can be repaired.
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
  if (campaign.dmId === userId) return userId;
  if (await hasActiveAdmin(ctx, userId)) return userId;
  throw new Error("Only the GM can do that");
}

/**
 * Throws unless the caller is the GM, a member of the campaign, or an
 * admin with the override active.
 *
 * Returns whether the caller is the GM so queries can shape output, and
 * whether that came from admin rather than ownership so the UI can say
 * so out loud — borrowed authority should never look like your own.
 */
export async function requireMember(
  ctx: Ctx,
  campaignId: Id<"campaigns">
): Promise<{ userId: Id<"users">; isDm: boolean; viaAdmin: boolean }> {
  const userId = await requireUser(ctx);
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }
  if (campaign.dmId === userId) {
    return { userId, isDm: true, viaAdmin: false };
  }

  const membership = await ctx.db
    .query("campaignMembers")
    .withIndex("by_campaign_user", (q) =>
      q.eq("campaignId", campaignId).eq("userId", userId)
    )
    .unique();

  if (membership) {
    // A member who is also an admin keeps the player's view unless the
    // override is on, so admin access never spoils a game by accident.
    if (await hasActiveAdmin(ctx, userId)) {
      return { userId, isDm: true, viaAdmin: true };
    }
    return { userId, isDm: false, viaAdmin: false };
  }

  if (await hasActiveAdmin(ctx, userId)) {
    return { userId, isDm: true, viaAdmin: true };
  }
  throw new Error("Not a member of this campaign");
}
