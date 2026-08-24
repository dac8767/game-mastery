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
 * ── Why the whole index is sent at once ──────────────────────────────
 *
 * The project's standing caution is to never subscribe a component to
 * an unpaginated list, because updating one row re-sends the list. That
 * is exactly right for the NPC roster and the combat tracker, and it
 * does not apply here, because THIS DATA NEVER CHANGES. There is no
 * mutation; a row can only change when Derek runs an import from a
 * terminal. A subscription to it therefore delivers once and then sits
 * silent.
 *
 * That makes the cheap design the good one. Each `index*` query returns
 * every row with the heavy fields stripped — no descriptions, no stat
 * blocks — which is tens of kilobytes, fetched once per screen. The
 * client then filters in memory, so a dozen filter controls and a
 * search box cost ZERO further function calls, instead of one per
 * keystroke against a search index.
 *
 * The full row, description and all, is fetched by id only when
 * something is actually opened.
 */

/**
 * Ceiling on one index fetch.
 *
 * Two different costs bound this, and the smaller one is not the
 * obvious one:
 *
 *   - What the BROWSER downloads is small, because the heavy fields are
 *     stripped: measured at roughly 0.4 MB for 3,000 rows.
 *   - What the QUERY READS is not, because Convex has no projection —
 *     `db.query()` returns whole documents, descriptions and stat
 *     blocks included, and only then are they stripped. Measured at
 *     roughly 1 MB per 1,000 rows, against a per-query read limit in
 *     the low tens of MB.
 *
 * So the read is what sets this, at a level with room underneath it.
 * `capped` rides back with the rows and the screen SAYS SO when it
 * binds — a library that silently stops at a round number reads as
 * missing data, and the fix (splitting the text into its own table so
 * the index reads small documents) is a real change worth prompting
 * rather than hiding.
 */
const MAX_INDEX = 5000;

async function requireReader(ctx: QueryCtx) {
  // Signed in is the whole bar. The library has nothing in it that one
  // member should see and another shouldn't — it is the rulebook, not
  // the campaign.
  await requireUser(ctx);
}

export const indexSpells = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db.query("spells").withIndex("by_name").take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        level: r.level,
        school: r.school ?? null,
        castingTime: r.castingTime ?? null,
        range: r.range ?? null,
        area: r.area ?? null,
        components: r.components ?? null,
        duration: r.duration ?? null,
        attackSave: r.attackSave ?? null,
        damageEffect: r.damageEffect ?? null,
        ritual: r.ritual,
        concentration: r.concentration,
        source: r.source ?? null,
      })),
    };
  },
});

export const indexItems = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db.query("items").withIndex("by_name").take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        kind: r.kind,
        subtype: r.subtype ?? null,
        properties: r.properties ?? null,
        rarity: r.rarity ?? null,
        price: r.price ?? null,
        weight: r.weight ?? null,
        attunement: r.attunement,
        source: r.source ?? null,
      })),
    };
  },
});

export const indexMonsters = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db
      .query("monsters")
      .withIndex("by_name")
      .take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        size: r.size ?? null,
        creatureType: r.creatureType ?? null,
        alignment: r.alignment ?? null,
        habitat: r.habitat ?? null,
        cr: r.cr ?? null,
        ac: r.ac ?? null,
        hp: r.hp ?? null,
        speed: r.speed ?? null,
        senses: r.senses ?? null,
        languages: r.languages ?? null,
        // The list needs to know a monster HAS legendary actions to
        // filter on it; it does not need the actions themselves.
        legendary: (r.legendaryActions?.length ?? 0) > 0,
        source: r.source ?? null,
      })),
    };
  },
});

// ---------------------------------------------------------------------
// The character-build half: feats, backgrounds, classes, species
// ---------------------------------------------------------------------
//
// Same shape as the three above, and same reasoning: no write path, so
// one unpaginated subscription per screen delivers once and sits
// silent. These four are much smaller than the spell list — a few
// hundred rows between them — so the read ceiling is nowhere near.
//
// `source` rides on every one of them because the 5e/5.5e rule is
// computed in the browser from it. Strip it here to save a few bytes
// and a 2024 Alert and a 2014 Alert both appear, indistinguishable.

export const indexFeats = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db.query("feats").withIndex("by_name").take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        category: r.category ?? null,
        prerequisite: r.prerequisite ?? null,
        repeatable: r.repeatable ?? false,
        source: r.source ?? null,
      })),
    };
  },
});

export const indexBackgrounds = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db
      .query("backgrounds")
      .withIndex("by_name")
      .take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        abilities: r.abilities ?? null,
        feat: r.feat ?? null,
        skills: r.skills ?? null,
        tools: r.tools ?? null,
        equipment: r.equipment ?? null,
        source: r.source ?? null,
      })),
    };
  },
});

export const indexClasses = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db
      .query("classes")
      .withIndex("by_name")
      .take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        isSubclass: r.isSubclass,
        parentClass: r.parentClass ?? null,
        hitDie: r.hitDie ?? null,
        primaryAbility: r.primaryAbility ?? null,
        saves: r.saves ?? null,
        spellcasting: r.spellcasting ?? null,
        source: r.source ?? null,
      })),
    };
  },
});

export const indexSpecies = query({
  args: {},
  handler: async (ctx) => {
    await requireReader(ctx);
    const rows = await ctx.db
      .query("species")
      .withIndex("by_name")
      .take(MAX_INDEX);
    return {
      capped: rows.length >= MAX_INDEX,
      rows: rows.map((r) => ({
        _id: r._id,
        name: r.name,
        image: r.image ?? null,
        size: r.size ?? null,
        speed: r.speed ?? null,
        creatureType: r.creatureType ?? null,
        darkvision: r.darkvision ?? null,
        source: r.source ?? null,
      })),
    };
  },
});

/**
 * One full row, fetched only when something is opened.
 *
 * Separate functions rather than one taking a table name: a string that
 * selects a table is a string a caller can change, and a handful of
 * three-line functions are cheaper than the argument validation that
 * would make one of them safe.
 */
export const getSpell = query({
  args: { id: v.id("spells") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

export const getItem = query({
  args: { id: v.id("items") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

export const getMonster = query({
  args: { id: v.id("monsters") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

export const getFeat = query({
  args: { id: v.id("feats") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

export const getBackground = query({
  args: { id: v.id("backgrounds") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

export const getClass = query({
  args: { id: v.id("classes") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

export const getSpecies = query({
  args: { id: v.id("species") },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    return await ctx.db.get(args.id);
  },
});

// ---------------------------------------------------------------------
// Rules Lawyer
// ---------------------------------------------------------------------

/**
 * Enough results to find what you meant, few enough to read.
 *
 * A rules search that returns forty sections has not answered the
 * question, it has moved it.
 */
const MAX_RULE_HITS = 12;

/**
 * Search the rules text.
 *
 * Two indexes, merged. The title index is asked first because a query
 * that names a rule — "grappled", "opportunity attack" — means the
 * section with that heading, and a body search would rank it against
 * every other section that happens to mention the word. The body index
 * then fills in the questions that are not a heading: "can I move
 * after attacking".
 *
 * `search` carries the heading and its breadcrumb folded in, so a
 * phrase spanning both — "grappled condition" — matches even though
 * "condition" appears only in the heading above the rule.
 *
 * Deduplicated by id, keeping the earlier (title) hit, so a section
 * matching both ways appears once, ranked as the stronger match.
 */
export const searchRules = query({
  args: {
    q: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireReader(ctx);

    const q = args.q.trim();
    if (!q) return { hits: [], sources: await ruleSources(ctx) };

    const byTitle = await ctx.db
      .query("rules")
      .withSearchIndex("search_title", (s) => {
        const base = s.search("title", q);
        return args.source ? base.eq("source", args.source) : base;
      })
      .take(MAX_RULE_HITS);

    const byText = await ctx.db
      .query("rules")
      .withSearchIndex("search_text", (s) => {
        const base = s.search("search", q);
        return args.source ? base.eq("source", args.source) : base;
      })
      .take(MAX_RULE_HITS);

    const seen = new Set<string>();
    const hits = [];
    for (const row of [...byTitle, ...byText]) {
      if (seen.has(row._id)) continue;
      seen.add(row._id);
      hits.push({
        _id: row._id,
        source: row.source,
        title: row.title,
        breadcrumb: row.breadcrumb,
        text: row.text,
        order: row.order,
      });
      if (hits.length >= MAX_RULE_HITS) break;
    }

    return { hits, sources: await ruleSources(ctx) };
  },
});

/** Every document imported, so the filter can offer them. */
async function ruleSources(ctx: QueryCtx): Promise<string[]> {
  const rows = await ctx.db.query("rules").withIndex("by_source_order").take(2000);
  return [...new Set(rows.map((r) => r.source))].sort();
}

/**
 * The sections either side of one, for reading on.
 *
 * A rule rarely stands alone — "Grappled" is followed by "Incapacitated",
 * and the sentence you needed is as often in the section after the one
 * you found. Ordered by position in the document, which is why `order`
 * is contiguous.
 */
export const ruleContext = query({
  args: { source: v.string(), order: v.number(), before: v.number(), after: v.number() },
  handler: async (ctx, args) => {
    await requireReader(ctx);
    const before = Math.min(5, Math.max(0, Math.round(args.before)));
    const after = Math.min(5, Math.max(0, Math.round(args.after)));

    const rows = await ctx.db
      .query("rules")
      .withIndex("by_source_order", (i) =>
        i
          .eq("source", args.source)
          .gte("order", args.order - before)
          .lte("order", args.order + after)
      )
      .take(before + after + 1);

    return rows.map((r) => ({
      _id: r._id,
      source: r.source,
      title: r.title,
      breadcrumb: r.breadcrumb,
      text: r.text,
      order: r.order,
    }));
  },
});
