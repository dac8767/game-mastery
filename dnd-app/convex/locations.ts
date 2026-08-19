import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";

/**
 * Locations — the tree of places, and the maps that link them.
 *
 * The visibility rule is the same one the rest of the app runs on and
 * it is enforced here rather than in the client: a non-DM caller never
 * receives a hidden location, its dmNotes, or the hidden flag itself.
 * Shaping this in the component would mean the data had already crossed
 * the wire, and "the UI doesn't render it" is not a boundary.
 *
 * Hiding a location deliberately does NOT hide its children. A hidden
 * city with a visible district is a real thing a DM wants — the players
 * know the district, not what it belongs to — and the client's tree
 * surfaces a child whose parent is missing at the root instead of
 * losing it.
 */

/** Ceiling on one campaign's atlas, so a runaway loop can't unbound it. */
const MAX_LOCATIONS = 1000;

/** Uploaded maps are capped; a scan can be very large. */
const MAX_PICTURES = 12;

async function ownedLocation(
  ctx: { db: { get: (id: Id<"locations">) => Promise<Doc<"locations"> | null> } },
  locationId: Id<"locations">
): Promise<Doc<"locations">> {
  const loc = await ctx.db.get(locationId);
  if (!loc) throw new Error("Not found");
  return loc;
}

export const listForCampaign = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { isDm } = await requireMember(ctx, args.campaignId);

    const rows = await ctx.db
      .query("locations")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_LOCATIONS);

    const locations = await Promise.all(
      rows
        .filter((l) => isDm || !l.hidden)
        .map(async (l) => ({
          _id: l._id,
          parentId: l.parentId ?? null,
          name: l.name,
          description: l.description ?? null,
          order: l.order,
          x: l.x ?? null,
          y: l.y ?? null,
          mapPath: l.mapPath ?? null,
          mapUrl: l.mapId ? await ctx.storage.getUrl(l.mapId) : null,
          pictureUrls: (
            await Promise.all(
              (l.pictureIds ?? []).map((id) => ctx.storage.getUrl(id))
            )
          ).filter((u): u is string => Boolean(u)),
          hidden: isDm ? l.hidden : false,
          dmNotes: isDm ? (l.dmNotes ?? null) : null,
        }))
    );

    return { locations, isDm };
  },
});

export const createLocation = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    parentId: v.optional(v.id("locations")),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const siblings = await ctx.db
      .query("locations")
      .withIndex("by_parent", (q) => q.eq("parentId", args.parentId))
      .collect();

    return await ctx.db.insert("locations", {
      campaignId: args.campaignId,
      parentId: args.parentId,
      name: args.name.trim() || "New location",
      order: siblings.length,
      x: args.x === undefined ? undefined : clamp01(args.x),
      y: args.y === undefined ? undefined : clamp01(args.y),
      hidden: false,
    });
  },
});

export const updateLocation = mutation({
  args: {
    locationId: v.id("locations"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    dmNotes: v.optional(v.union(v.string(), v.null())),
    hidden: v.optional(v.boolean()),
    parentId: v.optional(v.union(v.id("locations"), v.null())),
  },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);

    const patch: Partial<Doc<"locations">> = {};
    if (args.name !== undefined) patch.name = args.name.trim() || loc.name;
    if (args.description !== undefined) {
      patch.description = args.description ?? undefined;
    }
    if (args.dmNotes !== undefined) patch.dmNotes = args.dmNotes ?? undefined;
    if (args.hidden !== undefined) patch.hidden = args.hidden;

    if (args.parentId !== undefined) {
      const next = args.parentId ?? undefined;
      // Reparenting under your own descendant makes the branch
      // unreachable, and nothing about the shape of the data stops it.
      if (next && (await wouldCycle(ctx, args.locationId, next))) {
        throw new Error("A location cannot sit inside itself.");
      }
      patch.parentId = next;
      // A pin's position belongs to the map it was placed on, so moving
      // to a new parent drops it rather than carrying a coordinate that
      // meant something on a different image.
      patch.x = undefined;
      patch.y = undefined;
    }

    await ctx.db.patch(args.locationId, patch);
  },
});

/**
 * Delete one location, and PROMOTE its children to its parent.
 *
 * Not a cascade: the DM asked to remove one place, and taking every
 * district in a city with it is a much larger request that should be
 * made explicitly, one location at a time.
 */
export const deleteLocation = mutation({
  args: { locationId: v.id("locations") },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);

    const children = await ctx.db
      .query("locations")
      .withIndex("by_parent", (q) => q.eq("parentId", args.locationId))
      .collect();

    for (const child of children) {
      // Promoted children lose their pin: it named a spot on the map
      // that is going away.
      await ctx.db.patch(child._id, {
        parentId: loc.parentId,
        x: undefined,
        y: undefined,
      });
    }

    if (loc.mapId) await ctx.storage.delete(loc.mapId);
    for (const id of loc.pictureIds ?? []) await ctx.storage.delete(id);
    await ctx.db.delete(args.locationId);
  },
});

/** Where this location sits on its parent's map, normalized 0..1. */
export const setPin = mutation({
  args: {
    locationId: v.id("locations"),
    x: v.number(),
    y: v.number(),
  },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);
    await ctx.db.patch(args.locationId, {
      x: clamp01(args.x),
      y: clamp01(args.y),
    });
  },
});

export const generateUploadUrl = mutation({
  args: { locationId: v.id("locations") },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Set (or clear) this location's own map. Replacing deletes the old. */
export const setMap = mutation({
  args: {
    locationId: v.id("locations"),
    storageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);

    if (loc.mapId && loc.mapId !== args.storageId) {
      await ctx.storage.delete(loc.mapId);
    }
    await ctx.db.patch(args.locationId, {
      mapId: args.storageId ?? undefined,
    });
  },
});

export const addPicture = mutation({
  args: {
    locationId: v.id("locations"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);

    const pictures = loc.pictureIds ?? [];
    if (pictures.length >= MAX_PICTURES) {
      // Refuse rather than silently dropping the upload the DM just
      // waited for — and delete the orphaned file, since nothing else
      // will ever reference it.
      await ctx.storage.delete(args.storageId);
      throw new Error(`A location holds at most ${MAX_PICTURES} pictures.`);
    }
    await ctx.db.patch(args.locationId, {
      pictureIds: [...pictures, args.storageId],
    });
  },
});

export const removePicture = mutation({
  args: {
    locationId: v.id("locations"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const loc = await ownedLocation(ctx, args.locationId);
    await requireDm(ctx, loc.campaignId);

    await ctx.db.patch(args.locationId, {
      pictureIds: (loc.pictureIds ?? []).filter((id) => id !== args.storageId),
    });
    await ctx.storage.delete(args.storageId);
  },
});

/**
 * Bulk-create locations from a Foundry export.
 *
 * The tree arrives FLAT, with each row naming its parent by an
 * importer-chosen key rather than by id: the ids do not exist until
 * this runs, so a nested payload would need a recursive validator and
 * still could not reference itself. Keys are resolved here, in
 * dependency order, so a child may appear before its parent in the
 * array.
 *
 * One mutation rather than one per row, because the free tier's
 * function calls are pooled across every project on the account. NPCs
 * go the other way — `npx convex import` writes straight to the table
 * and costs nothing at all — but that path cannot resolve a parent
 * reference, which is the whole shape of this data.
 */
export const importLocations = mutation({
  args: {
    campaignId: v.id("campaigns"),
    locations: v.array(
      v.object({
        /** Unique within this payload. Not stored. */
        key: v.string(),
        parentKey: v.optional(v.string()),
        name: v.string(),
        description: v.optional(v.string()),
        mapPath: v.optional(v.string()),
        x: v.optional(v.number()),
        y: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    if (args.locations.length > MAX_LOCATIONS) {
      throw new Error(
        `That import has ${args.locations.length} locations; the limit is ${MAX_LOCATIONS}.`
      );
    }

    const idByKey = new Map<string, Id<"locations">>();
    let pending = args.locations.slice();
    let created = 0;
    let orphaned = 0;

    // Repeat until a pass creates nothing. Whatever is left then has a
    // parent that is missing or circular, and those are imported at the
    // ROOT rather than dropped — the same rule the client's tree
    // follows. Losing a place silently is the one outcome worth
    // preventing; a misplaced one is visible and can be dragged.
    while (pending.length > 0) {
      const stuck: typeof pending = [];
      let progressed = false;

      for (const row of pending) {
        const parentId = row.parentKey
          ? idByKey.get(row.parentKey)
          : undefined;
        if (row.parentKey && parentId === undefined) {
          stuck.push(row);
          continue;
        }

        const siblings = await ctx.db
          .query("locations")
          .withIndex("by_parent", (q) => q.eq("parentId", parentId))
          .collect();

        const id = await ctx.db.insert("locations", {
          campaignId: args.campaignId,
          parentId,
          name: row.name.trim().slice(0, 200) || "Unnamed",
          description: row.description?.trim() || undefined,
          mapPath: row.mapPath || undefined,
          order: siblings.length,
          x: row.x === undefined ? undefined : clamp01(row.x),
          y: row.y === undefined ? undefined : clamp01(row.y),
          hidden: false,
        });
        idByKey.set(row.key, id);
        created++;
        progressed = true;
      }

      if (!progressed) {
        // Strip the unresolvable parent and let the next pass place
        // them at the root.
        orphaned = stuck.length;
        pending = stuck.map((r) => ({ ...r, parentKey: undefined }));
        if (orphaned === 0) break;
        continue;
      }
      pending = stuck;
    }

    return { created, orphaned };
  },
});

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Walk up from `parentId`; stop on a repeat so a bad row can't hang. */
async function wouldCycle(
  ctx: { db: { get: (id: Id<"locations">) => Promise<Doc<"locations"> | null> } },
  childId: Id<"locations">,
  parentId: Id<"locations">
): Promise<boolean> {
  const seen = new Set<string>();
  let cur: Doc<"locations"> | null = await ctx.db.get(parentId);

  while (cur && !seen.has(cur._id)) {
    if (cur._id === childId) return true;
    seen.add(cur._id);
    cur = cur.parentId ? await ctx.db.get(cur.parentId) : null;
  }
  return false;
}
