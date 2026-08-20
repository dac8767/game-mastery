import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { requireUser } from "./auth";

/**
 * Lookup — the shared reference library.
 *
 * Spells, items and monsters, and the only content in the app that is
 * not scoped to a campaign: a fireball is a fireball in both of Derek's
 * groups. So the access rule is different from everything else here.
 * There is no requireMember, because there is no campaign to be a member
 * of; requireUser is the whole check. Nothing in this file writes,
 * either — the tables are loaded by `npx convex import`, which goes
 * straight to the table without a mutation.
 *
 * These are also the only tables big enough that handing a subscribed
 * component the whole list would be the free tier's bandwidth footgun
 * (updating one row re-sends the list). Every read here is bounded, and
 * a typed query goes through the search index rather than scanning.
 */

/**
 * One screen's worth.
 *
 * Deliberately small. A reference library is searched, not scrolled —
 * and a page size that comfortably fills the list is also a page size
 * that keeps each reactive update cheap.
 */
const PAGE = 50;

/** Trimmed the same way for every table, so short queries can't scan. */
function normalizeTerm(term: string): string | null {
  const t = term.trim();
  return t.length >= 2 ? t.slice(0, 80) : null;
}

async function requireReader(ctx: QueryCtx) {
  // Signed in is the whole bar. The library has nothing in it that one
  // member should be able to see and another shouldn't — it is the
  // rulebook, not the campaign.
  await requireUser(ctx);
}

export const searchSpells = query({
  args: {
    term: v.optional(v.string()),
    level: v.optional(v.number()),
    school: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    const term = normalizeTerm(args.term ?? "");

    if (term) {
      return await ctx.db
        .query("spells")
        .withSearchIndex("search_name", (q) => {
          let s = q.search("name", term);
          if (args.level !== undefined) s = s.eq("level", args.level);
          if (args.school) s = s.eq("school", args.school);
          return s;
        })
        .take(PAGE);
    }

    // No term: the first page by name, so the screen has something on
    // it before anyone types.
    const rows = await ctx.db.query("spells").withIndex("by_name").take(PAGE);
    return rows.filter(
      (r) =>
        (args.level === undefined || r.level === args.level) &&
        (!args.school || r.school === args.school)
    );
  },
});

export const searchItems = query({
  args: {
    term: v.optional(v.string()),
    kind: v.optional(v.string()),
    rarity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    const term = normalizeTerm(args.term ?? "");

    if (term) {
      return await ctx.db
        .query("items")
        .withSearchIndex("search_name", (q) => {
          let s = q.search("name", term);
          if (args.kind) s = s.eq("kind", args.kind);
          if (args.rarity) s = s.eq("rarity", args.rarity);
          return s;
        })
        .take(PAGE);
    }

    const rows = await ctx.db.query("items").withIndex("by_name").take(PAGE);
    return rows.filter(
      (r) =>
        (!args.kind || r.kind === args.kind) &&
        (!args.rarity || r.rarity === args.rarity)
    );
  },
});

export const searchMonsters = query({
  args: {
    term: v.optional(v.string()),
    creatureType: v.optional(v.string()),
    cr: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    const term = normalizeTerm(args.term ?? "");

    if (term) {
      return await ctx.db
        .query("monsters")
        .withSearchIndex("search_name", (q) => {
          let s = q.search("name", term);
          if (args.creatureType) s = s.eq("creatureType", args.creatureType);
          if (args.cr !== undefined) s = s.eq("cr", args.cr);
          return s;
        })
        .take(PAGE);
    }

    const rows = await ctx.db.query("monsters").withIndex("by_name").take(PAGE);
    return rows.filter(
      (r) =>
        (!args.creatureType || r.creatureType === args.creatureType) &&
        (args.cr === undefined || r.cr === args.cr)
    );
  },
});

/**
 * How much is in the library, per table.
 *
 * Cheap and worth having: an import that silently landed in the wrong
 * table, or never ran, looks exactly like an empty search otherwise.
 * Counted against a bounded take rather than a full scan, so the number
 * saturates instead of growing a read cost.
 */
export const librarySize = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const CAP = 2000;
    const [spells, items, monsters] = await Promise.all([
      ctx.db.query("spells").take(CAP),
      ctx.db.query("items").take(CAP),
      ctx.db.query("monsters").take(CAP),
    ]);
    return {
      spells: spells.length,
      items: items.length,
      monsters: monsters.length,
      capped: CAP,
    };
  },
});
