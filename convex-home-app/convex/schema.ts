import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Home Coordination App — Convex Schema
 *
 * Core patterns:
 * - `authTables` (from Convex Auth) provides the `users` table. Every record
 *   that needs attribution references v.id("users").
 * - Visibility: `visibleTo` is optional. undefined = shared between both of
 *   you; set to a userId = private to that person. Queries filter on this.
 * - Images/attachments live in Cloudflare R2. The `attachments` table stores
 *   only the R2 key + metadata; Convex never holds the bytes, so database
 *   storage stays tiny.
 * - No createdAt fields needed: Convex adds _creationTime to every document.
 */
export default defineSchema({
  // users, authSessions, authAccounts, etc. — provided by Convex Auth
  ...authTables,

  // One profile per user: display name shown on comments, avatar in R2,
  // and an accent color so it's visually obvious who wrote/owns what.
  profiles: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    avatarKey: v.optional(v.string()), // R2 object key
    accentColor: v.optional(v.string()), // e.g. "#4f83cc"
  }).index("by_user", ["userId"]),

  tasks: defineTable({
    title: v.string(),
    details: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("done")),
    createdBy: v.id("users"),
    assignedTo: v.optional(v.id("users")), // undefined = either of you
    visibleTo: v.optional(v.id("users")), // undefined = shared
    dueDate: v.optional(v.number()), // ms since epoch
    completedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_assignee", ["assignedTo", "status"])
    .index("by_visibility", ["visibleTo", "status"]),

  notes: defineTable({
    title: v.string(),
    body: v.string(),
    createdBy: v.id("users"),
    visibleTo: v.optional(v.id("users")), // undefined = shared
    pinned: v.boolean(),
  })
    .index("by_visibility", ["visibleTo"])
    .index("by_pinned", ["pinned"]),

  // Simple recurring/shared lists (groceries, packing, errands).
  lists: defineTable({
    name: v.string(),
    createdBy: v.id("users"),
    visibleTo: v.optional(v.id("users")),
  }),

  listItems: defineTable({
    listId: v.id("lists"),
    label: v.string(),
    checked: v.boolean(),
    addedBy: v.id("users"),
    checkedBy: v.optional(v.id("users")),
  }).index("by_list", ["listId"]),

  // Polymorphic comments: attach a thread to any task, note, or list.
  // parentId is stored as a string so one table serves all parent types;
  // always pair it with parentType in queries via the index.
  comments: defineTable({
    parentType: v.union(
      v.literal("task"),
      v.literal("note"),
      v.literal("list")
    ),
    parentId: v.string(),
    authorId: v.id("users"),
    body: v.string(),
  }).index("by_parent", ["parentType", "parentId"]),

  // R2 attachment metadata. The actual file bytes live in Cloudflare R2;
  // this row is created by the R2 component's onUpload callback (files.ts).
  attachments: defineTable({
    r2Key: v.string(),
    fileName: v.string(),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    uploadedBy: v.id("users"),
    // Optional link to whatever the file is attached to. An attachment can
    // exist unlinked (e.g. a library of character art for the D&D app later).
    parentType: v.optional(
      v.union(v.literal("task"), v.literal("note"), v.literal("comment"))
    ),
    parentId: v.optional(v.string()),
  })
    .index("by_key", ["r2Key"])
    .index("by_parent", ["parentType", "parentId"])
    .index("by_uploader", ["uploadedBy"]),
});
