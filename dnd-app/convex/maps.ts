import { v } from "convex/values";
import { mutation, MutationCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireDm, requireMember, requireUser } from "./auth";
import { Id } from "./_generated/dataModel";

/**
 * Map library + live table state.
 *
 * The map picker (DM app) searches this table; the player view subscribes
 * to getTableState and renders whatever map the DM has made active.
 * Image URLs are built client-side as:
 *   `${MAP_SERVER_BASE}/${map.webPath}`      — players
 *   `${MAP_SERVER_BASE}/${map.originalPath}` — DM app, when needed
 */

/** Search the library by title text, optionally filtered by tag. */
export const searchMaps = query({
  args: {
    text: v.optional(v.string()),
    tag: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const limit = Math.min(args.limit ?? 24, 100);

    if (args.text && args.text.trim().length > 0) {
      // Search by title, then apply the tag filter in memory. (The search
      // index's `.eq()` filter takes the whole array value for array
      // fields in the installed Convex version, so it can't express
      // "tags contains X" — over-fetch and filter instead. Library
      // metadata is small; image bytes live elsewhere.)
      const results = await ctx.db
        .query("maps")
        .withSearchIndex("search_title", (s) =>
          s.search("title", args.text!.trim())
        )
        .take(args.tag ? Math.max(limit * 4, 100) : limit);
      const filtered = args.tag
        ? results.filter((m) => m.tags.includes(args.tag!))
        : results;
      return filtered.slice(0, limit);
    }

    // No text: browse mode. Filter by tag in memory (library metadata is
    // small — image bytes are the heavy part and they live elsewhere).
    const all = await ctx.db.query("maps").collect();
    const filtered = args.tag
      ? all.filter((m) => m.tags.includes(args.tag!))
      : all;
    return filtered.slice(0, limit);
  },
});

/** Distinct tag list for building the picker's filter UI. */
export const listTags = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const all = await ctx.db.query("maps").collect();
    const tags = new Set<string>();
    for (const m of all) for (const t of m.tags) tags.add(t);
    return Array.from(tags).sort();
  },
});

/** Add a map to the library (used by the Airtable migration + DM app). */
export const addMap = mutation({
  args: {
    title: v.string(),
    originalPath: v.string(),
    webPath: v.string(),
    tags: v.array(v.string()),
    environment: v.optional(v.string()),
    gridSizePx: v.optional(v.number()),
    widthSquares: v.optional(v.number()),
    heightSquares: v.optional(v.number()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.insert("maps", args);
  },
});

/**
 * The player screen's single subscription target. Returns the table state
 * joined with the active map's metadata so the client can render in one
 * round trip. Reactive: changes propagate to every subscribed player
 * instantly.
 */
export const getTableState = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    const state = await ctx.db
      .query("tableState")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();
    if (!state) return null;

    const activeMap = state.activeMapId
      ? await ctx.db.get(state.activeMapId)
      : null;

    return {
      showGrid: state.showGrid,
      banner: state.banner ?? null,
      activeEncounterId: state.activeEncounterId ?? null,
      activeMap: activeMap
        ? {
            _id: activeMap._id,
            title: activeMap.title,
            webPath: activeMap.webPath,
            gridSizePx: activeMap.gridSizePx ?? null,
            widthSquares: activeMap.widthSquares ?? null,
            heightSquares: activeMap.heightSquares ?? null,
          }
        : null,
    };
  },
});

/** DM: change what every player screen displays. */
export const setActiveMap = mutation({
  args: {
    campaignId: v.id("campaigns"),
    mapId: v.optional(v.id("maps")), // undefined = clear the table
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const state = await getOrCreateTableState(ctx, args.campaignId);
    await ctx.db.patch(state._id, { activeMapId: args.mapId });
  },
});

/** DM: toggle the grid overlay on player screens. */
export const setShowGrid = mutation({
  args: { campaignId: v.id("campaigns"), showGrid: v.boolean() },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const state = await getOrCreateTableState(ctx, args.campaignId);
    await ctx.db.patch(state._id, { showGrid: args.showGrid });
  },
});

/** DM: broadcast a banner line ("Roll perception", "Short rest"). */
export const setBanner = mutation({
  args: {
    campaignId: v.id("campaigns"),
    banner: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const state = await getOrCreateTableState(ctx, args.campaignId);
    await ctx.db.patch(state._id, { banner: args.banner });
  },
});

/** Internal helper: ensure the campaign has exactly one tableState doc. */
async function getOrCreateTableState(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">
) {
  const existing = await ctx.db
    .query("tableState")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("tableState", {
    campaignId,
    showGrid: true,
  });
  return (await ctx.db.get(id))!;
}
