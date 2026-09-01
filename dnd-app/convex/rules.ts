import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  QueryCtx,
} from "./_generated/server";
import { requireUser } from "./auth";

/**
 * Rules Lawyer — the tool's own backend.
 *
 * The search half lives in `convex/lookup.ts` with the rest of the
 * derived reference data, and this file deliberately does not touch it:
 * everything here is state the Rules Lawyer owns, which the library has
 * none of. Two things, and they are related only by what they point at:
 *
 *   pins      the sections one person keeps coming back to
 *   answers   what the AI layer has already been paid to say
 *
 * ---------------------------------------------------------------------
 * Why nothing here stores a rule's `_id`
 *
 * `rules` is derived reference data. `npx convex import --replace` drops
 * every row and writes new ones, so every `_id` in the table changes
 * each time the SRD is re-imported — which the tool's own docs say to do
 * whenever the converter changes. An id stored anywhere outside that
 * table is therefore a pointer that goes stale on a schedule.
 *
 * So a section is named, not referenced: source + breadcrumb + title,
 * resolved through the `by_source_title` index at read time. A pin whose
 * section no longer resolves comes back marked `missing` instead of
 * being dropped, because a pin that quietly disappears looks exactly
 * like a bug and there is no way for the person who set it to tell the
 * difference.
 */

/** A pinned list that has stopped being a list you can read. */
const MAX_PINS = 60;

/**
 * Titles are not unique inside a source — "Actions" sits under several
 * headings — so resolving a name reads the few rows sharing it and
 * matches on the breadcrumb. Small and bounded either way.
 */
const MAX_SAME_TITLE = 8;

/** What names a section, everywhere in this file. */
const sectionArgs = {
  source: v.string(),
  breadcrumb: v.string(),
  title: v.string(),
};

type SectionRef = {
  source: string;
  breadcrumb: string;
  title: string;
};

/**
 * The row a name points at now, or null if nothing does.
 *
 * Index-scoped to one source and one title, so this reads a handful of
 * rows however large the rules table gets.
 */
async function resolveSection(ctx: QueryCtx, ref: SectionRef) {
  const rows = await ctx.db
    .query("rules")
    .withIndex("by_source_title", (i) =>
      i.eq("source", ref.source).eq("title", ref.title)
    )
    .take(MAX_SAME_TITLE);

  return rows.find((r) => r.breadcrumb === ref.breadcrumb) ?? null;
}

/**
 * One cache key for one question.
 *
 * Case and spacing are not part of what was asked, and neither is a
 * trailing question mark — "How does grappling work?" and "how does
 * grappling work" are the same question and should not be billed twice.
 * The source filter IS part of it: the same words against SRD 5.1 and
 * against everything are two different questions with two different
 * sets of passages behind them.
 *
 * Module-private on purpose. Every read and every write of the cache
 * goes through this file, so the key is derived in one place and a
 * reader and a writer cannot disagree about what a question is called.
 * The action does not import it — it hands over the question and the
 * source, and recordAnswer derives the key here.
 */
function answerKey(question: string, source: string | null): string {
  const normal = String(question ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.\s]+$/g, "")
    .trim();
  return `${source ?? "*"}\u0000${normal}`;
}

// ---------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------

/**
 * This user's pinned sections, with their current text.
 *
 * Returns the pin's stored name alongside the resolved row so the
 * caller can render — and offer to remove — a pin whose section is
 * gone. `missing` is the honest answer, not an empty list.
 */
export const listPins = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);

    const pins = await ctx.db
      .query("rulePins")
      .withIndex("by_user", (i) => i.eq("userId", userId))
      .take(MAX_PINS);

    const out = [];
    for (const pin of pins) {
      const row = await resolveSection(ctx, pin);
      out.push({
        _id: pin._id,
        source: pin.source,
        breadcrumb: pin.breadcrumb,
        title: pin.title,
        pinnedAt: pin._creationTime,
        // Null rather than absent: the UI has to render the difference,
        // so it must not be able to miss it.
        rule: row
          ? {
              _id: row._id,
              source: row.source,
              title: row.title,
              breadcrumb: row.breadcrumb,
              text: row.text,
              order: row.order,
            }
          : null,
      });
    }

    // Newest first: a pin set this session is the one being used now.
    return out.sort((a, b) => b.pinnedAt - a.pinnedAt);
  },
});

/**
 * Pin a section, or unpin it if this user already had it.
 *
 * One call rather than two, because the button is one button. Returns
 * whether the section is pinned afterwards so the caller never has to
 * guess which way the toggle went.
 */
export const togglePin = mutation({
  args: sectionArgs,
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const existing = await ctx.db
      .query("rulePins")
      .withIndex("by_user_section", (i) =>
        i
          .eq("userId", userId)
          .eq("source", args.source)
          .eq("breadcrumb", args.breadcrumb)
          .eq("title", args.title)
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { pinned: false };
    }

    // Bounded on the way in. Without this the cap in listPins would
    // silently hide pins past the sixtieth rather than refuse them,
    // which is the same failure as losing them.
    const count = (
      await ctx.db
        .query("rulePins")
        .withIndex("by_user", (i) => i.eq("userId", userId))
        .take(MAX_PINS + 1)
    ).length;
    if (count > MAX_PINS) {
      throw new Error(
        `${MAX_PINS} pinned rules is the limit — unpin something first.`
      );
    }

    await ctx.db.insert("rulePins", {
      userId,
      source: args.source,
      breadcrumb: args.breadcrumb,
      title: args.title,
    });
    return { pinned: true };
  },
});

/**
 * Remove a pin by its own id.
 *
 * togglePin cannot do this job: a pin whose section no longer resolves
 * still needs a way off the list, and toggling it by name would insert
 * a second copy rather than delete the one that is there.
 */
export const removePin = mutation({
  args: { pinId: v.id("rulePins") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const pin = await ctx.db.get(args.pinId);
    // Ownership, not existence: deleting someone else's pin must fail
    // the same way as deleting one that was never there.
    if (!pin || pin.userId !== userId) return null;
    await ctx.db.delete(args.pinId);
    return null;
  },
});

// ---------------------------------------------------------------------
// The answer cache
// ---------------------------------------------------------------------

/**
 * An answer already written for this exact question, if there is one.
 *
 * Public and reactive so the screen can show a previous answer the
 * moment the question is typed, without anyone paying for a second one.
 * A cache read is the only path to an answer that costs nothing, so it
 * is the one the UI takes first.
 */
export const cachedAnswer = query({
  args: { question: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);

    const question = args.question.trim();
    if (!question) return null;

    const row = await ctx.db
      .query("ruleAnswers")
      .withIndex("by_key", (i) =>
        i.eq("key", answerKey(question, args.source ?? null))
      )
      .unique();

    if (!row) return null;
    return {
      answer: row.answer,
      citations: row.citations,
      model: row.model,
      askedAt: row._creationTime,
      cached: true as const,
    };
  },
});

/**
 * Store an answer that has been paid for.
 *
 * Internal: the only caller is the action that just spent the money.
 * A public mutation here would let a client write whatever it liked
 * into a table the screen presents as coming from the model.
 */
export const recordAnswer = internalMutation({
  args: {
    question: v.string(),
    source: v.union(v.string(), v.null()),
    answer: v.string(),
    citations: v.array(
      v.object({
        n: v.number(),
        source: v.string(),
        breadcrumb: v.string(),
        title: v.string(),
        order: v.number(),
      })
    ),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    // Derived here rather than passed in, so the key a question is
    // stored under and the key it is looked up by are the same
    // expression. The action never has to know the format.
    const key = answerKey(args.question, args.source);

    // Two people asking the same question at once both reach here. Last
    // writer wins on the body, but the key stays unique — `unique()` in
    // the readers throws on a duplicate, so this cannot be an insert
    // that races into two rows.
    const existing = await ctx.db
      .query("ruleAnswers")
      .withIndex("by_key", (i) => i.eq("key", key))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        answer: args.answer,
        citations: args.citations,
        model: args.model,
      });
      return null;
    }

    await ctx.db.insert("ruleAnswers", { ...args, key });
    return null;
  },
});

/**
 * Forget one answer, so the next ask pays for a fresh one.
 *
 * The escape hatch for an answer that reads wrong. Deleting the row is
 * the whole of it — the next ask misses the cache and writes a new one.
 */
export const forgetAnswer = mutation({
  args: { question: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const row = await ctx.db
      .query("ruleAnswers")
      .withIndex("by_key", (i) =>
        i.eq("key", answerKey(args.question.trim(), args.source ?? null))
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
