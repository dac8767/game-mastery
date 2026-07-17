import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Comments — the module that shows off why Convex fits this app.
 *
 * Any React component that uses:
 *   const comments = useQuery(api.comments.listForParent, { parentType, parentId });
 * is automatically subscribed. When your wife adds a comment, your screen
 * updates instantly — no polling, no websocket code, no cache invalidation.
 */

export const listForParent = query({
  args: {
    parentType: v.union(
      v.literal("task"),
      v.literal("note"),
      v.literal("list")
    ),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId)
      )
      .collect();

    // Join in author display info so the UI can show who wrote each one.
    return await Promise.all(
      comments.map(async (comment) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_user", (q) => q.eq("userId", comment.authorId))
          .unique();
        return {
          ...comment,
          authorName: profile?.displayName ?? "Unknown",
          authorColor: profile?.accentColor,
          isMine: comment.authorId === userId,
        };
      })
    );
  },
});

export const add = mutation({
  args: {
    parentType: v.union(
      v.literal("task"),
      v.literal("note"),
      v.literal("list")
    ),
    parentId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Must be signed in to comment");
    }
    const body = args.body.trim();
    if (body.length === 0) {
      throw new Error("Comment cannot be empty");
    }
    return await ctx.db.insert("comments", {
      parentType: args.parentType,
      parentId: args.parentId,
      authorId: userId,
      body,
    });
  },
});

export const remove = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Must be signed in");
    }
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return;
    // Only the author can delete their own comment.
    if (comment.authorId !== userId) {
      throw new Error("You can only delete your own comments");
    }
    await ctx.db.delete(args.commentId);
  },
});
