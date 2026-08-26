import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireDm } from "./auth";
import { sanitizeBoxHtml } from "../components/boxHtml";

/**
 * The DM Screen's storage: the live arrangement, named workspaces, and
 * the notes the note windows show.
 *
 * Everything here goes through requireDm — this is the DM's side of
 * the table — and every row is ALSO keyed by userId, so an admin
 * opening a broken campaign gets their own scratch arrangement rather
 * than sitting in, or overwriting, the DM's.
 *
 * The layout is a JSON string the client's parseLayout distrusts
 * completely (see components/dmScreenModel.ts). The server's only
 * opinions about it are that it exists and is not absurdly large.
 */

/** A layout blob past this size is a bug, not an arrangement. */
const MAX_LAYOUT = 64 * 1024;

/** One note's rich text. Same ceiling the session boxes use. */
const MAX_NOTE = 40 * 1024;

const MAX_WORKSPACES = 30;
const MAX_NOTES = 100;

function checkLayout(layout: string) {
  if (layout.length > MAX_LAYOUT) {
    throw new Error("That layout is too large to store.");
  }
}

export const getScreen = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const userId = await requireDm(ctx, args.campaignId);

    const screen = await ctx.db
      .query("dmScreens")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .unique();

    const workspaces = await ctx.db
      .query("dmWorkspaces")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .take(MAX_WORKSPACES);

    const notes = await ctx.db
      .query("dmNotes")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .take(MAX_NOTES);

    return {
      layout: screen?.layout ?? null,
      workspaces: workspaces.map((w) => ({
        _id: w._id,
        name: w.name,
        layout: w.layout,
      })),
      notes: notes.map((n) => ({
        _id: n._id,
        title: n.title,
        html: n.html,
      })),
    };
  },
});

export const saveLayout = mutation({
  args: { campaignId: v.id("campaigns"), layout: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireDm(ctx, args.campaignId);
    checkLayout(args.layout);

    const existing = await ctx.db
      .query("dmScreens")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .unique();

    if (existing) await ctx.db.patch(existing._id, { layout: args.layout });
    else {
      await ctx.db.insert("dmScreens", {
        campaignId: args.campaignId,
        userId,
        layout: args.layout,
      });
    }
  },
});

// ---------------------------------------------------------------------
// Workspaces — named copies of the arrangement
// ---------------------------------------------------------------------

export const saveWorkspace = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    layout: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireDm(ctx, args.campaignId);
    checkLayout(args.layout);

    const name = args.name.trim();
    if (!name) throw new Error("A workspace needs a name.");

    const existing = await ctx.db
      .query("dmWorkspaces")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .take(MAX_WORKSPACES);
    if (existing.length >= MAX_WORKSPACES) {
      throw new Error(`${MAX_WORKSPACES} workspaces is plenty. Delete one.`);
    }

    return await ctx.db.insert("dmWorkspaces", {
      campaignId: args.campaignId,
      userId,
      name,
      layout: args.layout,
    });
  },
});

/**
 * A workspace mutation's ownership check.
 *
 * The row's OWN campaign is what gets authorised — an id is all a
 * caller needs to name any row, and trusting a campaignId argument
 * would let the DM of one campaign edit workspaces in another.
 */
async function ownedWorkspace(
  ctx: Parameters<typeof requireDm>[0],
  workspaceId: Id<"dmWorkspaces">
) {
  const row = await ctx.db.get(workspaceId);
  if (!row) throw new Error("Not found");
  const userId = await requireDm(ctx, row.campaignId);
  if (row.userId !== userId) throw new Error("Not found");
  return row;
}

export const updateWorkspace = mutation({
  args: {
    workspaceId: v.id("dmWorkspaces"),
    name: v.optional(v.string()),
    layout: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ownedWorkspace(ctx, args.workspaceId);

    const patch: { name?: string; layout?: string } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("A workspace needs a name.");
      patch.name = name;
    }
    if (args.layout !== undefined) {
      checkLayout(args.layout);
      patch.layout = args.layout;
    }
    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(row._id, patch);
  },
});

export const deleteWorkspace = mutation({
  args: { workspaceId: v.id("dmWorkspaces") },
  handler: async (ctx, args) => {
    const row = await ownedWorkspace(ctx, args.workspaceId);
    await ctx.db.delete(row._id);
  },
});

// ---------------------------------------------------------------------
// Notes — the documents behind note windows
// ---------------------------------------------------------------------

export const addNote = mutation({
  args: { campaignId: v.id("campaigns"), title: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireDm(ctx, args.campaignId);

    const existing = await ctx.db
      .query("dmNotes")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .take(MAX_NOTES);
    if (existing.length >= MAX_NOTES) {
      throw new Error("That is a lot of notes. Delete one first.");
    }

    return await ctx.db.insert("dmNotes", {
      campaignId: args.campaignId,
      userId,
      title: args.title.trim() || "Note",
      html: "",
    });
  },
});

async function ownedNote(
  ctx: Parameters<typeof requireDm>[0],
  noteId: Id<"dmNotes">
) {
  const row = await ctx.db.get(noteId);
  if (!row) throw new Error("Not found");
  const userId = await requireDm(ctx, row.campaignId);
  if (row.userId !== userId) throw new Error("Not found");
  return row;
}

export const updateNote = mutation({
  args: {
    noteId: v.id("dmNotes"),
    title: v.optional(v.string()),
    html: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ownedNote(ctx, args.noteId);

    const patch: { title?: string; html?: string } = {};
    if (args.title !== undefined) patch.title = args.title.trim() || "Note";
    if (args.html !== undefined) {
      if (args.html.length > MAX_NOTE) {
        throw new Error("That note is too large to store.");
      }
      // Rebuilt from the allowlist like every other stored HTML. The
      // DM's own browser renders this back, and "it is my own text" is
      // one pasted rich-text snippet away from being untrue.
      patch.html = sanitizeBoxHtml(args.html);
    }
    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(row._id, patch);
  },
});

export const deleteNote = mutation({
  args: { noteId: v.id("dmNotes") },
  handler: async (ctx, args) => {
    const row = await ownedNote(ctx, args.noteId);
    await ctx.db.delete(row._id);
  },
});
