import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";
import { MAX_DICE, parseRoll, rollParsed } from "../components/diceModel";

/**
 * The dice roller: shared rolls for the table, private ones for the DM.
 *
 * The dice are thrown HERE, on the server, not in the browser. A roll
 * everyone can see is only worth seeing if nobody could have chosen it,
 * and a client that rolls and then posts its own result is a client
 * that can post a 20 every time. The notation is re-parsed here too —
 * the string is the only thing the client is trusted with.
 *
 * `secret` is the DM's private roll, and it is filtered on the way out
 * of listRolls rather than hidden in the UI: a player must not be able
 * to learn that the DM rolled at all, let alone what it was. Same rule
 * as hidden NPCs and dmOnly channels.
 *
 * Math.random inside a mutation is Convex's seeded source — a fresh
 * seed per execution, which is exactly what a die needs. It would be
 * wrong in a query, where a cached re-read must return what it
 * returned before.
 */

/** The log is bounded: it re-sends to every subscriber on each roll. */
const ROLL_WINDOW = 60;

/** Longest notation string accepted, before parsing even starts. */
const MAX_NOTATION = 60;
const MAX_LABEL = 60;

/** Resolve display names once per roller rather than once per roll. */
async function rollerNames(
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

/**
 * The campaign's recent rolls, newest first.
 *
 * A player gets the table's rolls. The DM gets those plus their own
 * secret ones — nobody else's, because a secret roll belongs to
 * whoever threw it.
 */
export const listRolls = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { userId, isDm } = await requireMember(ctx, args.campaignId);

    const recent = await ctx.db
      .query("diceRolls")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(ROLL_WINDOW);

    // Filtered here, on the server. A secret roll must not reach a
    // player's browser at all — not hidden, not greyed out, ABSENT.
    const visible = recent.filter(
      (r) => !r.secret || (isDm && r.userId === userId)
    );

    const names = await rollerNames(
      ctx,
      visible.map((r) => r.userId)
    );

    return {
      isDm,
      rolls: visible.map((r) => ({
        _id: r._id,
        at: r._creationTime,
        by: names.get(r.userId) ?? "Someone",
        mine: r.userId === userId,
        notation: r.notation,
        label: r.label ?? null,
        dice: r.dice,
        total: r.total,
        secret: r.secret,
      })),
    };
  },
});

export const rollDice = mutation({
  args: {
    campaignId: v.id("campaigns"),
    notation: v.string(),
    label: v.optional(v.string()),
    secret: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId, isDm } = await requireMember(ctx, args.campaignId);

    if (args.notation.length > MAX_NOTATION) {
      throw new Error("That notation is too long.");
    }
    // Re-parsed server-side. The client's parse decides what to grey
    // out; this one decides what is real.
    const parsed = parseRoll(args.notation);
    if (!parsed) {
      throw new Error(
        `Can't read "${args.notation.trim()}". Try 2d6+3, 4d6kh3, or d20.`
      );
    }

    // Only the DM rolls in secret. A player asking for one is asking
    // for a roll nobody can check, which is the opposite of the point.
    const secret = Boolean(args.secret) && isDm;

    const result = rollParsed(parsed, Math.random);
    const dice = result.terms.flatMap((t) => t.dice);
    if (dice.length > MAX_DICE) throw new Error("That is too many dice.");

    const label = args.label?.trim().slice(0, MAX_LABEL) || undefined;

    await ctx.db.insert("diceRolls", {
      campaignId: args.campaignId,
      userId,
      notation: result.notation,
      label,
      dice,
      total: result.total,
      secret,
    });

    return { notation: result.notation, dice, total: result.total, secret };
  },
});

/**
 * Clear the log. The DM's alone — it is the shared record of the
 * table's rolls, so one player cannot wipe an inconvenient one.
 */
export const clearRolls = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const rows = await ctx.db
      .query("diceRolls")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(500);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
