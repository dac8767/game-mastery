import { QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Can this person see the thing a comment or attachment hangs off?
 *
 * The app's one visibility rule — `visibleTo` undefined means shared,
 * a user id means private to that person — applied to a polymorphic
 * parent. Comments and attachments store their parent as a string, so
 * without this check anyone signed in could read or attach to anything
 * by guessing at ids. A parent that does not exist is not visible.
 */
export type ParentType = "task" | "note" | "list" | "comment";

export async function canSeeParent(
  ctx: QueryCtx,
  userId: Id<"users">,
  parentType: ParentType,
  parentId: string
): Promise<boolean> {
  if (parentType === "comment") {
    const id = ctx.db.normalizeId("comments", parentId);
    const comment = id ? await ctx.db.get(id) : null;
    if (!comment) return false;
    return await canSeeParent(ctx, userId, comment.parentType, comment.parentId);
  }
  const table = parentType === "task" ? "tasks" : parentType === "note" ? "notes" : "lists";
  const id = ctx.db.normalizeId(table, parentId);
  const doc = id ? await ctx.db.get(id) : null;
  if (!doc) return false;
  return doc.visibleTo === undefined || doc.visibleTo === userId;
}
