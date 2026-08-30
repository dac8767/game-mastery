import { v } from "convex/values";
import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireDm } from "./auth";
import {
  DEFAULT_COLOR,
  MAX_LABELS,
  MAX_LINKS,
  MAX_NOTES,
  MAX_PROJECTS,
  MAX_TASK_LABELS,
  MAX_TEXT,
  cleanPriority,
  cleanTitle,
  isColorId,
  isDate,
  nameKey,
  normalizeLinks,
  orderAfter,
  orderBefore,
} from "../components/todoModel";
import { parseQuickAdd } from "../components/quickAdd";

/** One link, as it crosses the wire. */
const linkValidator = v.object({
  tool: v.string(),
  label: v.string(),
  href: v.string(),
});

/**
 * The GM's prep list.
 *
 * Every function here is GM-only, and that is a stronger statement than
 * it is elsewhere in this app. NPCs and locations have a player-facing
 * shape — the same row with the secrets stripped. This has none. There
 * is no redacted version of "statblock for the lich before Tuesday":
 * the task itself is the spoiler, so a non-GM caller is refused rather
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
): Promise<Doc<"todos">> {
  const row = await ctx.db.get(todoId);
  if (!row) throw new Error("That item is gone.");
  await requireDm(ctx, row.campaignId);
  return row;
}

/** The same, for a project. */
async function ownedProject(
  ctx: MutationCtx,
  projectId: Id<"todoProjects">
): Promise<Doc<"todoProjects">> {
  const row = await ctx.db.get(projectId);
  if (!row) throw new Error("That project is gone.");
  await requireDm(ctx, row.campaignId);
  return row;
}

/** And for a label. */
async function ownedLabel(
  ctx: MutationCtx,
  labelId: Id<"todoLabels">
): Promise<Doc<"todoLabels">> {
  const row = await ctx.db.get(labelId);
  if (!row) throw new Error("That label is gone.");
  await requireDm(ctx, row.campaignId);
  return row;
}

/**
 * Label ids that belong to THIS campaign, deduplicated and capped.
 *
 * The check is not paranoia about the screen: a Convex id validator
 * proves the argument names a row in the todoLabels table and says
 * nothing about whose. Without this, one campaign's label id would
 * attach to another campaign's task and render there — a small leak,
 * but a leak of the kind this app's whole authority model is built to
 * make impossible.
 */
async function cleanLabelIds(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  ids: Id<"todoLabels">[] | undefined
): Promise<Id<"todoLabels">[] | undefined> {
  if (ids === undefined) return undefined;
  const out: Id<"todoLabels">[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(String(id)) || out.length >= MAX_TASK_LABELS) continue;
    const row = await ctx.db.get(id);
    if (!row || row.campaignId !== campaignId) continue;
    seen.add(String(id));
    out.push(id);
  }
  return out;
}

/** A project id that belongs to this campaign, or undefined. */
async function cleanProjectId(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  id: Id<"todoProjects"> | undefined
): Promise<Id<"todoProjects"> | undefined> {
  if (id === undefined) return undefined;
  const row = await ctx.db.get(id);
  if (!row || row.campaignId !== campaignId) return undefined;
  return id;
}

/**
 * Everything the tool draws, in one subscription.
 *
 * Tasks, projects and labels together rather than three queries,
 * because every screen in this tool needs all three at once: a task row
 * shows its labels and its project, and the sidebar of counts needs the
 * tasks to count. Three subscriptions would re-render the same screen
 * three times for one change and cost three times the function calls on
 * a free tier that pools them across every project on the account.
 *
 * `labelIds` is filtered against the campaign's OWN labels on the way
 * out. A dangling id — a label deleted while a task still named it —
 * would otherwise render as a blank chip nobody can remove.
 */
export const listTodos = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx: QueryCtx, args) => {
    await requireDm(ctx, args.campaignId);

    const [rows, projects, labels] = await Promise.all([
      ctx.db
        .query("todos")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .take(MAX_ITEMS),
      ctx.db
        .query("todoProjects")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .take(MAX_PROJECTS),
      ctx.db
        .query("todoLabels")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .take(MAX_LABELS),
    ]);

    const liveLabels = new Set(labels.map((l) => String(l._id)));
    const liveProjects = new Set(projects.map((p) => String(p._id)));

    return {
      items: rows.map((r) => ({
        _id: r._id,
        text: r.text,
        done: r.done,
        order: r.order,
        due: r.due ?? null,
        notes: r.notes ?? null,
        doneAt: r.doneAt ?? null,
        links: r.links ?? [],
        // Same treatment as the labels: a project deleted under a task
        // leaves it in the Inbox rather than in a list that is gone.
        projectId: r.projectId && liveProjects.has(String(r.projectId))
          ? r.projectId
          : null,
        priority: r.priority ?? null,
        labelIds: (r.labelIds ?? []).filter((id) => liveLabels.has(String(id))),
        favorite: r.favorite ?? false,
      })),
      projects: projects.map((p) => ({
        _id: p._id,
        title: p.title,
        color: p.color ?? null,
        order: p.order,
        archived: p.archived ?? false,
      })),
      labels: labels.map((l) => ({
        _id: l._id,
        title: l.title,
        color: l.color,
      })),
    };
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
    /**
     * Where this came from, when another tool is the one adding it.
     * Cleaned server-side — the caller is trusted to be in the app,
     * not to have got its own URLs right.
     */
    links: v.optional(v.array(linkValidator)),
    /** Put it at the top rather than the bottom. */
    atTop: v.optional(v.boolean()),
    /** The Vikunja properties, all optional. */
    projectId: v.optional(v.id("todoProjects")),
    priority: v.optional(v.number()),
    labelIds: v.optional(v.array(v.id("todoLabels"))),
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

    const links = normalizeLinks(args.links);

    const labelIds = await cleanLabelIds(ctx, args.campaignId, args.labelIds);

    return await ctx.db.insert("todos", {
      campaignId: args.campaignId,
      text,
      done: false,
      order,
      due,
      notes: trimTo(args.notes, MAX_NOTES),
      links: links.length ? links : undefined,
      projectId: await cleanProjectId(ctx, args.campaignId, args.projectId),
      priority: cleanPriority(args.priority),
      labelIds: labelIds?.length ? labelIds : undefined,
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

/**
 * Edit one item.
 *
 * Absent argument = leave the field alone. That is what makes this
 * callable from six different controls without each of them having to
 * send the whole row back — and it is why the three fields that can be
 * UNSET take `null` explicitly rather than reusing absence. "Move this
 * to the Inbox" and "I am not talking about the project" are different
 * instructions, and a shape where they look the same is a shape where
 * ticking a checkbox quietly unfiles a task.
 */
export const updateTodo = mutation({
  args: {
    todoId: v.id("todos"),
    text: v.optional(v.string()),
    due: v.optional(v.string()),
    notes: v.optional(v.string()),
    projectId: v.optional(v.union(v.id("todoProjects"), v.null())),
    priority: v.optional(v.union(v.number(), v.null())),
    labelIds: v.optional(v.array(v.id("todoLabels"))),
  },
  handler: async (ctx, args) => {
    const row = await ownedTodo(ctx, args.todoId);

    const patch: Record<string, unknown> = {};

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

    if (args.projectId !== undefined) {
      patch.projectId =
        args.projectId === null
          ? undefined
          : await cleanProjectId(ctx, row.campaignId, args.projectId);
    }
    if (args.priority !== undefined) {
      patch.priority =
        args.priority === null ? undefined : cleanPriority(args.priority);
    }
    if (args.labelIds !== undefined) {
      const ids = await cleanLabelIds(ctx, row.campaignId, args.labelIds);
      patch.labelIds = ids?.length ? ids : undefined;
    }

    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(args.todoId, patch);
  },
});

/** Starred, or not. Vikunja's Favorites, as one flag. */
export const setFavorite = mutation({
  args: { todoId: v.id("todos"), favorite: v.boolean() },
  handler: async (ctx, args) => {
    await ownedTodo(ctx, args.todoId);
    // Cleared rather than set false, so an unstarred task is identical
    // to one that was never starred.
    await ctx.db.patch(args.todoId, {
      favorite: args.favorite ? true : undefined,
    });
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

/**
 * Attach a link to an item that already exists.
 *
 * Separate from addTodo because the two cases are different: a tool
 * that CREATES a task knows its source up front, and a person tagging
 * a second sentence onto an existing task does not. Re-linking the
 * same href is a no-op rather than a duplicate chip.
 */
export const linkTodo = mutation({
  args: { todoId: v.id("todos"), link: linkValidator },
  handler: async (ctx, args) => {
    const row = await ownedTodo(ctx, args.todoId);
    const existing = row.links ?? [];
    // Normalised TOGETHER, so the new link is deduplicated against
    // what is already there rather than only against itself.
    const links = normalizeLinks([...existing, args.link]);
    if (links.length === existing.length && existing.length >= MAX_LINKS) {
      throw new Error("That item has all the links it can hold.");
    }
    await ctx.db.patch(args.todoId, {
      links: links.length ? links : undefined,
    });
  },
});

/** Drop one link by its address. */
export const unlinkTodo = mutation({
  args: { todoId: v.id("todos"), href: v.string() },
  handler: async (ctx, args) => {
    const row = await ownedTodo(ctx, args.todoId);
    const links = (row.links ?? []).filter((l) => l.href !== args.href);
    await ctx.db.patch(args.todoId, {
      links: links.length ? links : undefined,
    });
  },
});

export const deleteTodo = mutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, args) => {
    await ownedTodo(ctx, args.todoId);
    await ctx.db.delete(args.todoId);
  },
});

/* ---------------------------------------------------------------- */
/* Projects — Vikunja's lists                                         */
/* ---------------------------------------------------------------- */

export const addProject = mutation({
  args: {
    campaignId: v.id("campaigns"),
    title: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const title = cleanTitle(args.title);
    if (title === "") throw new Error("A project needs a name.");

    const existing = await ctx.db
      .query("todoProjects")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_PROJECTS);
    if (existing.length >= MAX_PROJECTS) {
      throw new Error("That is as many projects as this list holds.");
    }
    // Same name, same project. Quick-add resolves `+name` by matching,
    // so two projects that differ only in case would make which one a
    // task lands in depend on which was written first.
    const clash = existing.find((p) => nameKey(p.title) === nameKey(title));
    if (clash) return clash._id;

    return await ctx.db.insert("todoProjects", {
      campaignId: args.campaignId,
      title,
      color: isColorId(args.color) ? args.color : undefined,
      order: orderAfter(
        existing.length ? Math.max(...existing.map((p) => p.order)) : undefined
      ),
    });
  },
});

export const updateProject = mutation({
  args: {
    projectId: v.id("todoProjects"),
    title: v.optional(v.string()),
    color: v.optional(v.union(v.string(), v.null())),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ownedProject(ctx, args.projectId);
    const patch: Record<string, unknown> = {};

    if (args.title !== undefined) {
      const title = cleanTitle(args.title);
      if (title === "") throw new Error("A project needs a name.");
      const siblings = await ctx.db
        .query("todoProjects")
        .withIndex("by_campaign", (q) => q.eq("campaignId", row.campaignId))
        .take(MAX_PROJECTS);
      if (
        siblings.some(
          (p) => p._id !== row._id && nameKey(p.title) === nameKey(title)
        )
      ) {
        throw new Error("There is already a project with that name.");
      }
      patch.title = title;
    }
    if (args.color !== undefined) {
      // An unknown id is dropped rather than stored: this value is
      // looked up in a palette on the way out, and a row holding a
      // string that is not in it renders as the default forever with
      // nothing saying why.
      patch.color =
        args.color !== null && isColorId(args.color) ? args.color : undefined;
    }
    if (args.archived !== undefined) {
      patch.archived = args.archived ? true : undefined;
    }

    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(args.projectId, patch);
  },
});

export const reorderProjects = mutation({
  args: {
    campaignId: v.id("campaigns"),
    moves: v.array(
      v.object({ projectId: v.id("todoProjects"), order: v.number() })
    ),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    if (args.moves.length > MAX_PROJECTS) throw new Error("Too many moves.");
    for (const move of args.moves) {
      const row = await ctx.db.get(move.projectId);
      // Per row, like reorderTodos: a batch aimed at one campaign must
      // not be a way to move a row belonging to another.
      if (!row || row.campaignId !== args.campaignId) continue;
      if (!Number.isFinite(move.order)) continue;
      await ctx.db.patch(move.projectId, { order: move.order });
    }
  },
});

/**
 * Delete a project. Its tasks go to the Inbox; they are not deleted.
 *
 * A project is a filing decision and its tasks are the work. Deleting
 * the folder must not delete the work — that is the difference between
 * a list you can reorganise and one you are afraid to touch. Vikunja
 * deletes the tasks with the project and asks first; this does the
 * safer thing instead, and Clear finished is still there for a sweep.
 */
export const deleteProject = mutation({
  args: { projectId: v.id("todoProjects") },
  handler: async (ctx, args) => {
    const row = await ownedProject(ctx, args.projectId);
    const orphans = await ctx.db
      .query("todos")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_ITEMS);
    for (const task of orphans) {
      await ctx.db.patch(task._id, { projectId: undefined });
    }
    await ctx.db.delete(row._id);
    return orphans.length;
  },
});

/* ---------------------------------------------------------------- */
/* Labels                                                            */
/* ---------------------------------------------------------------- */

/**
 * A label by name, made if this campaign has not got one.
 *
 * Shared by addLabel and by quick-add's `*name`, which is the reason it
 * exists: typing `*handout` has to WORK the first time, and a syntax
 * that only attaches labels you created in another screen first is a
 * syntax nobody reaches for. Projects deliberately do not do this —
 * `+Sesion` should fail to file rather than silently create a fourth
 * list named after a typo.
 */
async function labelByName(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  raw: string,
  color?: string
): Promise<Id<"todoLabels"> | null> {
  const title = cleanTitle(raw);
  if (title === "") return null;

  const existing = await ctx.db
    .query("todoLabels")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .take(MAX_LABELS);

  const found = existing.find((l) => nameKey(l.title) === nameKey(title));
  if (found) return found._id;
  if (existing.length >= MAX_LABELS) return null;

  return await ctx.db.insert("todoLabels", {
    campaignId,
    title,
    color: isColorId(color) ? (color as string) : DEFAULT_COLOR,
  });
}

export const addLabel = mutation({
  args: {
    campaignId: v.id("campaigns"),
    title: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const id = await labelByName(ctx, args.campaignId, args.title, args.color);
    if (id === null) throw new Error("That list has all the labels it holds.");
    return id;
  },
});

export const updateLabel = mutation({
  args: {
    labelId: v.id("todoLabels"),
    title: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ownedLabel(ctx, args.labelId);
    const patch: Record<string, unknown> = {};

    if (args.title !== undefined) {
      const title = cleanTitle(args.title);
      if (title === "") throw new Error("A label needs a name.");
      const siblings = await ctx.db
        .query("todoLabels")
        .withIndex("by_campaign", (q) => q.eq("campaignId", row.campaignId))
        .take(MAX_LABELS);
      if (
        siblings.some(
          (l) => l._id !== row._id && nameKey(l.title) === nameKey(title)
        )
      ) {
        throw new Error("There is already a label with that name.");
      }
      patch.title = title;
    }
    // Unlike a project's, a label's colour is required — it is the only
    // thing telling two chips apart at a glance — so an unknown id
    // falls back to the default rather than clearing the field.
    if (args.color !== undefined) {
      patch.color = isColorId(args.color) ? args.color : DEFAULT_COLOR;
    }

    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(args.labelId, patch);
  },
});

/**
 * Delete a label, and take it off everything wearing it.
 *
 * The sweep is the point. listTodos already filters dangling ids out of
 * what it returns, so skipping this would LOOK correct — and would
 * leave every task carrying a dead id forever, invisible until
 * something else reads the column.
 */
export const deleteLabel = mutation({
  args: { labelId: v.id("todoLabels") },
  handler: async (ctx, args) => {
    const row = await ownedLabel(ctx, args.labelId);
    const tasks = await ctx.db
      .query("todos")
      .withIndex("by_campaign", (q) => q.eq("campaignId", row.campaignId))
      .take(MAX_ITEMS);
    for (const task of tasks) {
      if (!task.labelIds?.some((id) => id === args.labelId)) continue;
      const left = task.labelIds.filter((id) => id !== args.labelId);
      await ctx.db.patch(task._id, {
        labelIds: left.length ? left : undefined,
      });
    }
    await ctx.db.delete(row._id);
  },
});

/**
 * Quick Add Magic, resolved against this campaign's own lists.
 *
 * The parse itself is pure and lives in components/quickAdd.ts, which
 * is where it is unit-tested; this is the half that cannot be — turning
 * `*handout` into a label id, making the label if there is not one, and
 * matching `+Session prep` against a project WITHOUT making one.
 *
 * `today` comes from the browser rather than from the server clock, and
 * that is deliberate: "tomorrow" means the day after the one the person
 * typing it is having, and a Convex function has no idea which that is.
 * It is validated as a date and used only for arithmetic.
 */
export const quickAdd = mutation({
  args: {
    campaignId: v.id("campaigns"),
    text: v.string(),
    today: v.string(),
    /** Where an unfiled task lands — the project screen you are on. */
    projectId: v.optional(v.id("todoProjects")),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    if (!isDate(args.today)) throw new Error("That is not a date.");

    const parsed = parseQuickAdd(args.text, args.today);
    if (parsed.text.trim() === "") {
      throw new Error("An item needs some words as well as its tags.");
    }

    const labelIds: Id<"todoLabels">[] = [];
    for (const name of parsed.labels) {
      const id = await labelByName(ctx, args.campaignId, name);
      if (id) labelIds.push(id);
    }

    let projectId = await cleanProjectId(ctx, args.campaignId, args.projectId);
    if (parsed.project) {
      const projects = await ctx.db
        .query("todoProjects")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .take(MAX_PROJECTS);
      const found = projects.find(
        (p) => nameKey(p.title) === nameKey(parsed.project as string)
      );
      // A `+name` that matches nothing files the task where it would
      // have gone anyway rather than throwing the whole line away. The
      // field shows what it understood, so an unmatched project is
      // visible before you press Enter.
      if (found) projectId = found._id;
    }

    const existing = await ctx.db
      .query("todos")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_ITEMS);
    if (existing.length >= MAX_ITEMS) {
      throw new Error("That list is full. Clear some finished items.");
    }
    const open = existing.filter((r) => !r.done).map((r) => r.order);

    return await ctx.db.insert("todos", {
      campaignId: args.campaignId,
      text: parsed.text.slice(0, MAX_TEXT),
      done: false,
      order: orderAfter(open.length ? Math.max(...open) : undefined),
      due: parsed.due ?? undefined,
      projectId,
      priority: cleanPriority(parsed.priority),
      labelIds: labelIds.length ? labelIds : undefined,
    });
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
