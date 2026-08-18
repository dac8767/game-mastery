import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireMember } from "./auth";

/**
 * The NPC roster.
 *
 * One subscription feeds the whole NPC screen: the client receives every
 * row it is allowed to see and does its own searching, filtering,
 * grouping, and sorting in memory. That is deliberate — pushing those
 * controls to the server would fire a Convex function call on every
 * keystroke and every facet toggle, and function calls are the metered,
 * account-pooled resource on the free tier. A few hundred metadata rows
 * cost far less than the call volume an interactive table would generate.
 *
 * Revisit past a few thousand NPCs: at that point add a search index and
 * paginate, because the whole-list subscription re-sends on every edit.
 */

/** Hard ceiling on one subscription's payload. */
const MAX_NPCS = 1000;

export const listForCampaign = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { isDm } = await requireMember(ctx, args.campaignId);

    // Take one extra so we can tell the client the list was cut off
    // rather than silently showing a partial roster.
    const rows = await ctx.db
      .query("npcs")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_NPCS + 1);

    const truncated = rows.length > MAX_NPCS;
    const page = truncated ? rows.slice(0, MAX_NPCS) : rows;

    // The DM/player split, enforced here so the data physically never
    // leaves the server for a player:
    //   - `hidden` NPCs are dropped from the list entirely
    //   - `dmNotes` and `secret` come back null
    // The row shape stays uniform either way so the table can render one
    // set of columns; the DM-only columns are simply empty for players.
    const npcs = page
      .filter((n) => isDm || !n.hidden)
      .map((n) => ({
        _id: n._id,
        _creationTime: n._creationTime,

        name: n.name,
        prefix: n.prefix ?? null,
        first: n.first ?? null,
        middle: n.middle ?? null,
        family: n.family ?? null,
        suffix: n.suffix ?? null,
        nickname: n.nickname ?? null,
        noLastName: n.noLastName,

        status: n.status,
        gender: n.gender ?? null,
        species: n.species ?? null,
        lineage: n.lineage ?? null,
        sexuality: n.sexuality ?? null,
        alignment: n.alignment ?? null,

        startingAge: n.startingAge ?? null,
        age: n.age ?? null,
        maxAge: n.maxAge ?? null,
        maturity: n.maturity ?? null,

        groups: n.groups,
        job: n.job ?? null,
        familyMembers: n.familyMembers,
        familyMemberCount: n.familyMemberCount ?? null,

        place: n.place,
        region: n.region ?? null,
        kingdom: n.kingdom ?? null,

        description: n.description ?? null,
        quirkMental: n.quirkMental ?? null,
        quirkPhysical: n.quirkPhysical ?? null,
        politics: n.politics ?? null,
        abilities: n.abilities ?? null,
        wantsNeeds: n.wantsNeeds ?? null,
        voice: n.voice ?? null,
        playerNotes: n.playerNotes ?? null,

        portraitPath: n.portraitPath ?? null,

        // DM-only from here down.
        hidden: isDm ? n.hidden : false,
        dmNotes: isDm ? (n.dmNotes ?? null) : null,
        secret: isDm ? (n.secret ?? null) : null,
      }));

    return { isDm, truncated, npcs };
  },
});
