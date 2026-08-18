import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./auth";

/**
 * Per-person table layout.
 *
 * Everyone arranges a table to their own taste — which columns show, in
 * what order, how wide, and the active sort/group/filter. None of it is
 * shared: both functions here resolve the caller from the auth context
 * and only ever touch that person's own row, so one player's layout is
 * unreachable from another's session by construction. Neither takes a
 * userId argument, because an argument is something a client can lie
 * about.
 *
 * This lives in Convex rather than localStorage so a layout follows you
 * between machines. Writes are debounced client-side — dragging a column
 * border must not be one mutation per pixel.
 */

const columnState = v.object({
  key: v.string(),
  width: v.number(),
  visible: v.boolean(),
});

const filterState = v.array(
  v.object({ field: v.string(), values: v.array(v.string()) })
);

export const getViewPrefs = query({
  args: { campaignId: v.id("campaigns"), view: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.campaignId);

    const doc = await ctx.db
      .query("viewPrefs")
      .withIndex("by_user_campaign_view", (q) =>
        q
          .eq("userId", userId)
          .eq("campaignId", args.campaignId)
          .eq("view", args.view)
      )
      .unique();

    // null = never customized; the client falls back to its defaults.
    if (!doc) return null;

    return {
      columns: doc.columns,
      sortKey: doc.sortKey ?? null,
      sortAsc: doc.sortAsc ?? null,
      groupBy: doc.groupBy ?? null,
      filters: doc.filters ?? [],
      viewMode: doc.viewMode ?? null,
      tilesPerRow: doc.tilesPerRow ?? null,
    };
  },
});

export const saveViewPrefs = mutation({
  args: {
    campaignId: v.id("campaigns"),
    view: v.string(),
    columns: v.array(columnState),
    sortKey: v.optional(v.string()),
    sortAsc: v.optional(v.boolean()),
    groupBy: v.optional(v.string()),
    filters: v.optional(filterState),
    viewMode: v.optional(v.union(v.literal("grid"), v.literal("tiles"))),
    tilesPerRow: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.campaignId);

    const existing = await ctx.db
      .query("viewPrefs")
      .withIndex("by_user_campaign_view", (q) =>
        q
          .eq("userId", userId)
          .eq("campaignId", args.campaignId)
          .eq("view", args.view)
      )
      .unique();

    const fields = {
      columns: args.columns,
      sortKey: args.sortKey,
      sortAsc: args.sortAsc,
      groupBy: args.groupBy,
      filters: args.filters ?? [],
      viewMode: args.viewMode,
      tilesPerRow: args.tilesPerRow,
    };

    if (existing) {
      // replace, not patch: clearing a group/sort must actually clear it
      await ctx.db.replace(existing._id, {
        userId,
        campaignId: args.campaignId,
        view: args.view,
        ...fields,
      });
      return;
    }

    await ctx.db.insert("viewPrefs", {
      userId,
      campaignId: args.campaignId,
      view: args.view,
      ...fields,
    });
  },
});
