import { v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireMember, requireUser } from "./auth";
import { canonicalInlineImages } from "../components/boxHtml";
import { deleteInlineImages, withImages } from "./inlineImages";

/**
 * The Notebook.
 *
 * One notebook per person per campaign, private to them: every function
 * here resolves the caller from the auth context and filters by that
 * userId, so there is no way to read or write someone else's pages. The
 * campaign only scopes it — being the GM grants nothing over a player's
 * notes, which is deliberate. Session notes are where you write things
 * you have not decided to share.
 *
 * Boxes are their own rows rather than an array on the page, so moving
 * one box writes one small document and a page of images cannot hit the
 * 1MB document limit.
 */

/** Ceiling on one notebook's tree, so a runaway loop can't unbound it. */
const MAX_NODES = 500;

async function ownedNode(
  ctx: MutationCtx,
  nodeId: Id<"notebookNodes">
): Promise<Doc<"notebookNodes">> {
  const userId = await requireUser(ctx);
  const node = await ctx.db.get(nodeId);
  // Same error either way: "not yours" and "not there" should be
  // indistinguishable to a caller probing for ids.
  if (!node || node.userId !== userId) throw new Error("Not found");
  return node;
}

async function ownedBox(
  ctx: MutationCtx,
  boxId: Id<"notebookBoxes">
): Promise<Doc<"notebookBoxes">> {
  const userId = await requireUser(ctx);
  const box = await ctx.db.get(boxId);
  if (!box || box.userId !== userId) throw new Error("Not found");
  return box;
}

/** The whole tree, flat. The client assembles and repairs it. */
export const getTree = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.campaignId);
    const rows = await ctx.db
      .query("notebookNodes")
      .withIndex("by_user_campaign", (q) =>
        q.eq("userId", userId).eq("campaignId", args.campaignId)
      )
      .take(MAX_NODES);

    return rows.map((n) => ({
      _id: n._id,
      kind: n.kind,
      title: n.title,
      parentId: n.parentId ?? null,
      order: n.order,
      color: n.color ?? null,
      collapsed: n.collapsed ?? false,
    }));
  },
});

/** Every box on one page, with image URLs resolved. */
export const getPage = query({
  args: { pageId: v.id("notebookNodes") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.userId !== userId) return null;

    const boxes = await ctx.db
      .query("notebookBoxes")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .take(300);

    const shaped = await Promise.all(
      boxes
        .sort((a, b) => a.order - b.order)
        .map(async (b) => ({
          _id: b._id,
          type: b.type,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          order: b.order,
          // A pasted picture's key becomes a src here, on every read,
          // the same as the image box's below. See convex/inlineImages.
          html: b.html ? await withImages(ctx, b.html) : null,
          // Resolved here so the client never handles storage ids.
          src: b.storageId ? await ctx.storage.getUrl(b.storageId) : null,
          rotate: b.rotate ?? 0,
          borderW: b.borderW ?? 0,
          borderColor: b.borderColor ?? null,
          rows: b.rows ?? null,
          colWidths: b.colWidths ?? null,
          rowHeights: b.rowHeights ?? null,
          align: b.align ?? null,
          borderless: b.borderless ?? false,
          shading: b.shading ?? null,
        }))
    );

    return { title: page.title, boxes: shaped };
  },
});

export const addNode = mutation({
  args: {
    campaignId: v.id("campaigns"),
    kind: v.union(v.literal("page"), v.literal("section")),
    title: v.string(),
    parentId: v.optional(v.id("notebookNodes")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.campaignId);

    const existing = await ctx.db
      .query("notebookNodes")
      .withIndex("by_user_campaign", (q) =>
        q.eq("userId", userId).eq("campaignId", args.campaignId)
      )
      .take(MAX_NODES + 1);
    if (existing.length > MAX_NODES) {
      throw new Error("This notebook is full — archive some pages first.");
    }

    if (args.parentId) {
      const parent = await ownedNode(ctx, args.parentId);
      if (parent.kind !== "section") throw new Error("Pages can't hold pages");
    }

    const siblings = existing.filter(
      (n) => (n.parentId ?? null) === (args.parentId ?? null)
    );
    const order = siblings.reduce((max, n) => Math.max(max, n.order), 0) + 1;

    return await ctx.db.insert("notebookNodes", {
      userId,
      campaignId: args.campaignId,
      kind: args.kind,
      title: args.title.trim() || (args.kind === "page" ? "New page" : "Folder"),
      parentId: args.parentId,
      order,
    });
  },
});

export const renameNode = mutation({
  args: { nodeId: v.id("notebookNodes"), title: v.string() },
  handler: async (ctx, args) => {
    await ownedNode(ctx, args.nodeId);
    await ctx.db.patch(args.nodeId, { title: args.title.trim() || "Untitled" });
  },
});

export const setNodeColor = mutation({
  args: {
    nodeId: v.id("notebookNodes"),
    color: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await ownedNode(ctx, args.nodeId);
    await ctx.db.patch(args.nodeId, { color: args.color ?? undefined });
  },
});

export const setCollapsed = mutation({
  args: { nodeId: v.id("notebookNodes"), collapsed: v.boolean() },
  handler: async (ctx, args) => {
    await ownedNode(ctx, args.nodeId);
    await ctx.db.patch(args.nodeId, { collapsed: args.collapsed });
  },
});

/**
 * Re-parent and/or reorder a node.
 *
 * The cycle check lives here as well as in the UI: a folder dropped into
 * its own descendant would detach that whole branch from the root, and
 * the client's check is only a courtesy.
 */
export const moveNode = mutation({
  args: {
    nodeId: v.id("notebookNodes"),
    parentId: v.optional(v.id("notebookNodes")),
    order: v.number(),
  },
  handler: async (ctx, args) => {
    const node = await ownedNode(ctx, args.nodeId);

    if (args.parentId) {
      const parent = await ownedNode(ctx, args.parentId);
      if (parent.kind !== "section") throw new Error("Pages can't hold pages");

      // Walk up from the intended parent; meeting the node means the
      // move would make a branch its own ancestor.
      let cursor: Doc<"notebookNodes"> | null = parent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor._id === node._id) {
          throw new Error("A folder can't go inside itself");
        }
        if (seen.has(cursor._id)) break; // damaged data — stop rather than hang
        seen.add(cursor._id);
        cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null;
      }
    }

    await ctx.db.patch(args.nodeId, {
      parentId: args.parentId,
      order: args.order,
    });
  },
});

/** Delete a node, its descendants, and every box on any page removed. */
export const deleteNode = mutation({
  args: { nodeId: v.id("notebookNodes") },
  handler: async (ctx, args) => {
    const node = await ownedNode(ctx, args.nodeId);

    const all = await ctx.db
      .query("notebookNodes")
      .withIndex("by_user_campaign", (q) =>
        q.eq("userId", node.userId).eq("campaignId", node.campaignId)
      )
      .take(MAX_NODES);

    // Collect the subtree first; deleting while walking loses children.
    const doomed = new Set<string>([node._id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of all) {
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n._id)) {
          doomed.add(n._id);
          grew = true;
        }
      }
    }

    for (const id of doomed) {
      const nodeId = id as Id<"notebookNodes">;
      const boxes = await ctx.db
        .query("notebookBoxes")
        .withIndex("by_page", (q) => q.eq("pageId", nodeId))
        .take(300);
      for (const b of boxes) {
        // Drop the stored image too, or the file outlives every
        // reference to it and nothing will ever clean it up. The
        // pictures pasted into a text box are files of the same kind.
        if (b.storageId) await ctx.storage.delete(b.storageId);
        await deleteInlineImages(ctx, b.html);
        await ctx.db.delete(b._id);
      }
      await ctx.db.delete(nodeId);
    }
  },
});

// ---- boxes ----------------------------------------------------------

export const addBox = mutation({
  args: {
    pageId: v.id("notebookNodes"),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("table")),
    x: v.number(),
    y: v.number(),
    w: v.number(),
    h: v.number(),
    html: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    rows: v.optional(v.array(v.array(v.string()))),
    colWidths: v.optional(v.array(v.number())),
    rowHeights: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    const page = await ownedNode(ctx, args.pageId);
    if (page.kind !== "page") throw new Error("Boxes belong on pages");

    const existing = await ctx.db
      .query("notebookBoxes")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .take(300);
    if (existing.length >= 300) {
      throw new Error("This page is full — start a new one.");
    }
    const order = existing.reduce((max, b) => Math.max(max, b.order), 0) + 1;

    const { pageId, ...rest } = args;
    return await ctx.db.insert("notebookBoxes", {
      ...rest,
      // Not sanitized — a notebook is private — but a pasted picture
      // is stored as its key alone, or the read side cannot find it.
      html: rest.html === undefined ? undefined : canonicalInlineImages(rest.html),
      pageId,
      userId: page.userId,
      order,
    });
  },
});

export const updateBox = mutation({
  args: {
    boxId: v.id("notebookBoxes"),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
    order: v.optional(v.number()),
    html: v.optional(v.string()),
    rotate: v.optional(v.number()),
    borderW: v.optional(v.number()),
    borderColor: v.optional(v.union(v.string(), v.null())),
    rows: v.optional(v.array(v.array(v.string()))),
    colWidths: v.optional(v.array(v.number())),
    rowHeights: v.optional(v.array(v.number())),
    align: v.optional(
      v.union(v.literal("left"), v.literal("center"), v.literal("right"))
    ),
    borderless: v.optional(v.boolean()),
    shading: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await ownedBox(ctx, args.boxId);
    const { boxId, ...rest } = args;

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      patch[key] = value === null ? undefined : value;
    }
    if (Object.keys(patch).length === 0) return;
    // See addBox: the pasted picture's key, and only its key.
    if (typeof patch.html === "string") {
      patch.html = canonicalInlineImages(patch.html);
    }

    await ctx.db.patch(boxId, patch as Partial<Doc<"notebookBoxes">>);
  },
});

export const deleteBox = mutation({
  args: { boxId: v.id("notebookBoxes") },
  handler: async (ctx, args) => {
    const box = await ownedBox(ctx, args.boxId);
    if (box.storageId) await ctx.storage.delete(box.storageId);
    await deleteInlineImages(ctx, box.html);
    await ctx.db.delete(args.boxId);
  },
});

/** Short-lived URL the browser PUTs an image to. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
