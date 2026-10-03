import { R2 } from "@convex-dev/r2";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canSeeParent } from "./visibility";

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
 * Access follows the parent: an attachment on a private task or note is
 * as private as the task or note. Only whoever uploaded a file may
 * delete it.
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

const parentTypeValidator = v.union(
  v.literal("task"),
  v.literal("note"),
  v.literal("comment")
);

/**
 * May this person see this attachment?
 *
 * The uploader always can. A linked one follows its parent; an unlinked
 * one (a shared library file) is shared, like `visibleTo` undefined.
 */
async function canSeeAttachment(
  ctx: QueryCtx,
  userId: Id<"users">,
  row: Doc<"attachments">
): Promise<boolean> {
  if (row.uploadedBy === userId) return true;
  if (row.parentType === undefined || row.parentId === undefined) return true;
  return await canSeeParent(ctx, userId, row.parentType, row.parentId);
}

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
    parentType: v.optional(parentTypeValidator),
    parentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Must be signed in");
    }
    if ((args.parentType === undefined) !== (args.parentId === undefined)) {
      throw new Error("parentType and parentId go together");
    }
    if (
      args.parentType !== undefined &&
      args.parentId !== undefined &&
      !(await canSeeParent(ctx, userId, args.parentType, args.parentId))
    ) {
      throw new Error("Not found");
    }
    // One row per object. A second row naming somebody else's key would
    // make that key "uploaded by" the caller, and deleteAttachment would
    // then delete their file.
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_key", (q) => q.eq("r2Key", args.r2Key))
      .first();
    if (existing) {
      throw new Error("That file is already registered");
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
    parentType: parentTypeValidator,
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    if (!(await canSeeParent(ctx, userId, args.parentType, args.parentId))) {
      return [];
    }

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
 * Get a signed URL for a single file (e.g. avatar display).
 *
 * Only for a key the app knows about and the caller may see: a
 * registered attachment, or somebody's profile avatar. An arbitrary key
 * is refused rather than signed.
 */
export const getAttachmentUrl = query({
  args: { r2Key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const row = await ctx.db
      .query("attachments")
      .withIndex("by_key", (q) => q.eq("r2Key", args.r2Key))
      .first();
    if (row) {
      return (await canSeeAttachment(ctx, userId, row))
        ? await r2.getUrl(args.r2Key)
        : null;
    }

    // Avatars are shown to the whole household. Profiles are one row
    // per person, so this scan is two rows.
    const profiles = await ctx.db.query("profiles").collect();
    return profiles.some((p) => p.avatarKey === args.r2Key)
      ? await r2.getUrl(args.r2Key)
      : null;
  },
});

/**
 * Delete an attachment: removes both the R2 object and the metadata row.
 * Only whoever uploaded it.
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
    if (row.uploadedBy !== userId) {
      throw new Error("You can only delete files you uploaded");
    }
    await r2.deleteObject(ctx, row.r2Key);
    await ctx.db.delete(args.attachmentId);
  },
});
