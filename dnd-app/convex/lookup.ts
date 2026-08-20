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

/**
 * One full row, fetched only when something is opened.
 *
 * The three are separate functions rather than one taking a table name:
 * a string that selects a table is a string a caller can change, and
 * three three-line functions are cheaper than the argument validation
 * that would make one of them safe.
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
