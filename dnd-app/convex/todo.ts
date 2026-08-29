import { v } from "convex/values";
import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireDm } from "./auth";
import {
  MAX_NOTES,
  MAX_TEXT,
  isDate,
  orderAfter,
  orderBefore,
} from "../components/todoModel";

/**
 * The DM's prep list.
 *
 * Every function here is DM-only, and that is a stronger statement than
 * it is elsewhere in this app. NPCs and locations have a player-facing
 * shape — the same row with the secrets stripped. This has none. There
 * is no redacted version of "statblock for the lich before Tuesday":
 * the task itself is the spoiler, so a non-DM caller is refused rather
 * than served a filtered list.
 *
 * Which is why the QUERY takes requireDm too. A player asking for this
 * campaign's todos gets an error, not an empty array — an empty array
 * would be a promise that the tool works for them, and one day
 * somebody would make it true.
 *
 * The player-facing list Derek wants later is deliberately a separate
 * table and a separate module. Adding a `visibility` field here would
 * turn every one of these functions into a question about who is
 * asking, which is exactly the cost this split avoids.
 */

/** A prep list longer than this is a project plan. */
const MAX_ITEMS = 300;

/**
 * The row, and the campaign that owns it.
 *
 * Row-addressed mutations authorise against the ROW's campaign rather
 * than a campaignId in the arguments — otherwise the id of somebody
 * else's todo plus your own campaignId would be enough to edit theirs.
 */
async function ownedTodo(
  ctx: MutationCtx,
  todoId: Id<"todos">
): Promise<{ _id: Id<"todos">; campaignId: Id<"campaigns">; order: number }> {
  const row = await ctx.db.get(todoId);
  if (!row) throw new Error("That item is gone.");
  await requireDm(ctx, row.campaignId);
  return row;
}

/** Every item on the list, oldest key first. Sorting is the client's. */
export const listTodos = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx: QueryCtx, args) => {
    await requireDm(ctx, args.campaignId);

    const rows = await ctx.db
      .query("todos")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_ITEMS);

    return rows.map((r) => ({
      _id: r._id,
      text: r.text,
      done: r.done,
      order: r.order,
      due: r.due ?? null,
      notes: r.notes ?? null,
      doneAt: r.doneAt ?? null,
    }));
  },
});

/** A blank string clears; a missing one leaves the field alone. */
function trimTo(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed === "" ? undefined : trimmed;
}

export const addTodo = mutation({
  args: {
    campaignId: v.id("campaigns"),
    text: v.string(),
    due: v.optional(v.string()),
    notes: v.optional(v.string()),
    /** Put it at the top rather than the bottom. */
    atTop: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const text = args.text.trim().slice(0, MAX_TEXT);
    if (text === "") throw new Error("An item needs some words.");

    const due = trimTo(args.due, 10);
    if (due !== undefined && !isDate(due)) {
      throw new Error("A due date looks like 2026-09-01.");
    }

    const existing = await ctx.db
      .query("todos")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_ITEMS);
    if (existing.length >= MAX_ITEMS) {
      throw new Error("That list is full. Clear some finished items.");
    }

    // The ends of the OPEN list. A finished item has sunk to the
    // bottom of the reading order, so appending after one would put a
    // new task below the things you have already done.
    const open = existing.filter((r) => !r.done).map((r) => r.order);
    const order = args.atTop
      ? orderBefore(open.length ? Math.min(...open) : undefined)
      : orderAfter(open.length ? Math.max(...open) : undefined);

    return await ctx.db.insert("todos", {
      campaignId: args.campaignId,
      text,
      done: false,
      order,
      due,
      notes: trimTo(args.notes, MAX_NOTES),
    });
  },
});

export const setDone = mutation({
  args: { todoId: v.id("todos"), done: v.boolean() },
  handler: async (ctx, args) => {
    await ownedTodo(ctx, args.todoId);
    await ctx.db.patch(args.todoId, {
      done: args.done,
      // Cleared on un-ticking, so an item put back on the list does
      // not keep sorting by when it was briefly finished.
      doneAt: args.done ? Date.now() : undefined,
    });
  },
});

export const updateTodo = mutation({
  args: {
    todoId: v.id("todos"),
    text: v.optional(v.string()),
    due: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ownedTodo(ctx, args.todoId);

    const patch: Record<string, string | undefined> = {};

    if (args.text !== undefined) {
      const text = args.text.trim().slice(0, MAX_TEXT);
      // An item with no words is a deletion somebody did not mean.
      if (text === "") throw new Error("An item needs some words.");
      patch.text = text;
    }
    if (args.due !== undefined) {
      const due = trimTo(args.due, 10);
      if (due !== undefined && !isDate(due)) {
        throw new Error("A due date looks like 2026-09-01.");
      }
      patch.due = due;
    }
    if (args.notes !== undefined) patch.notes = trimTo(args.notes, MAX_NOTES);

    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(args.todoId, patch);
  },
});

/**
 * Move items, as a batch of new sort keys.
 *
 * The client works out the keys — components/todoModel.ts owns that
 * arithmetic and is unit-tested — and usually sends exactly one. It
 * sends the whole list only when a gap has run out of room to split,
 * which is why this takes an array rather than a single id.
 */
export const reorderTodos = mutation({
  args: {
    campaignId: v.id("campaigns"),
    moves: v.array(v.object({ todoId: v.id("todos"), order: v.number() })),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    if (args.moves.length > MAX_ITEMS) throw new Error("Too many moves.");

    for (const move of args.moves) {
      const row = await ctx.db.get(move.todoId);
      // Checked per row: a batch aimed at one campaign must not be a
      // way to move a row belonging to another.
      if (!row || row.campaignId !== args.campaignId) continue;
      if (!Number.isFinite(move.order)) continue;
      await ctx.db.patch(move.todoId, { order: move.order });
    }
  },
});

export const deleteTodo = mutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, args) => {
    await ownedTodo(ctx, args.todoId);
    await ctx.db.delete(args.todoId);
  },
});

/** Sweep the finished items. The open ones are untouched. */
export const clearDone = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const rows = await ctx.db
      .query("todos")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_ITEMS);

    let gone = 0;
    for (const row of rows) {
      if (!row.done) continue;
      await ctx.db.delete(row._id);
      gone++;
    }
    return gone;
  },
});
