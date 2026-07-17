import { R2 } from "@convex-dev/r2";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Cloudflare R2 file storage via the official Convex R2 component.
 *
 * Flow:
 *  1. Client calls generateUploadUrl → gets a signed URL for a direct
 *     browser → R2 upload (bytes never pass through Convex).
 *  2. Client PUTs the file to that URL, then calls syncMetadata.
 *  3. Client calls registerAttachment with the returned key to create the
 *     metadata row that the rest of the app queries against.
 *  4. To display, call getAttachmentUrl (returns a signed R2 URL).
 *
 * Required environment variables (set via `npx convex env set`):
 *  R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * NOTE: The @convex-dev/r2 component API evolves — if a callback signature
 * doesn't compile, check the component README for your installed version.
 */
export const r2 = new R2(components.r2);

export const { generateUploadUrl, syncMetadata } = r2.clientApi({
  // Only signed-in household members may upload.
  checkUpload: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Must be signed in to upload files");
    }
  },
});

/**
 * After a successful upload, create the attachment metadata record.
 * Optionally link it to a task, note, or comment right away.
 */
export const registerAttachment = mutation({
  args: {
    r2Key: v.string(),
    fileName: v.string(),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    parentType: v.optional(
      v.union(v.literal("task"), v.literal("note"), v.literal("comment"))
    ),
    parentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Must be signed in");
    }
    return await ctx.db.insert("attachments", {
      r2Key: args.r2Key,
      fileName: args.fileName,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      uploadedBy: userId,
      parentType: args.parentType,
      parentId: args.parentId,
    });
  },
});

/**
 * List attachments for a given parent (e.g. all photos on a task).
 * Reactive: any component using this query updates live when either of
 * you adds or removes a file.
 */
export const listForParent = query({
  args: {
    parentType: v.union(
      v.literal("task"),
      v.literal("note"),
      v.literal("comment")
    ),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId)
      )
      .collect();

    // Resolve a signed serving URL for each file.
    return await Promise.all(
      rows.map(async (row) => ({
        ...row,
        url: await r2.getUrl(row.r2Key),
      }))
    );
  },
});

/**
 * Get a signed URL for a single attachment (e.g. avatar display).
 */
export const getAttachmentUrl = query({
  args: { r2Key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    return await r2.getUrl(args.r2Key);
  },
});

/**
 * Delete an attachment: removes both the R2 object and the metadata row.
 */
export const deleteAttachment = mutation({
  args: { attachmentId: v.id("attachments") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Must be signed in");
    }
    const row = await ctx.db.get(args.attachmentId);
    if (!row) return;
    await r2.deleteObject(ctx, row.r2Key);
    await ctx.db.delete(args.attachmentId);
  },
});
