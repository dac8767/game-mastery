import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";
import { getSettings } from "./settings";

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
    const { userId, isDm: isCampaignDm } = await requireMember(
      ctx,
      args.campaignId
    );

    // A DM previewing the player view is served as a player, so the
    // preview is real: the withheld data genuinely never leaves the
    // server. Mutations still check actual DM status, so previewing
    // does not lock the DM out of editing.
    const { viewAsPlayer } = await getSettings(ctx, userId);
    const isDm = isCampaignDm && !viewAsPlayer;

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

    return {
      isDm,
      // True only while a real DM is deliberately seeing less, so the
      // UI can say so rather than looking broken.
      previewingAsPlayer: isCampaignDm && !isDm,
      truncated,
      npcs,
    };
  },
});

/**
 * Optional text that the DM may also clear.
 *
 * `null` means "empty this field" and is translated to `undefined`
 * before the patch, because Convex removes a field patched with
 * `undefined` while `null` is not a legal value for `v.optional(...)`.
 */
const clearableText = v.optional(v.union(v.string(), v.null()));
const clearableNumber = v.optional(v.union(v.number(), v.null()));

/**
 * DM: edit any field on an NPC.
 *
 * Required fields (name, the array fields, the booleans) take no `null`,
 * so there is no way to patch an NPC into a shape the schema rejects.
 */
export const updateNpc = mutation({
  args: {
    npcId: v.id("npcs"),

    name: v.optional(v.string()),
    prefix: clearableText,
    first: clearableText,
    middle: clearableText,
    family: clearableText,
    suffix: clearableText,
    nickname: clearableText,
    noLastName: v.optional(v.boolean()),

    status: v.optional(v.array(v.string())),
    gender: clearableText,
    species: clearableText,
    lineage: clearableText,
    sexuality: clearableText,
    alignment: clearableText,

    startingAge: clearableNumber,
    age: clearableNumber,
    maxAge: clearableNumber,
    maturity: clearableText,

    groups: v.optional(v.array(v.string())),
    job: clearableText,
    familyMembers: v.optional(v.array(v.string())),
    familyMemberCount: clearableNumber,

    place: v.optional(v.array(v.string())),
    region: clearableText,
    kingdom: clearableText,

    description: clearableText,
    quirkMental: clearableText,
    quirkPhysical: clearableText,
    politics: clearableText,
    abilities: clearableText,
    wantsNeeds: clearableText,
    voice: clearableText,
    playerNotes: clearableText,
    portraitPath: clearableText,

    // DM-only fields — reachable only through this DM-gated mutation.
    hidden: v.optional(v.boolean()),
    dmNotes: clearableText,
    secret: clearableText,
  },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");
    await requireDm(ctx, npc.campaignId);

    const { npcId, ...rest } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue; // field not being edited
      patch[key] = value === null ? undefined : value; // null clears it
    }
    if (Object.keys(patch).length === 0) return;

    await ctx.db.patch(npcId, patch as Partial<Doc<"npcs">>);
  },
});

/**
 * Any campaign member: edit the shared Player Notes on an NPC.
 *
 * Deliberately its own mutation rather than a flag on updateNpc — the
 * only field a player may write is the only field this can reach, so
 * there is no argument a player could pass to touch anything else.
 * Hidden NPCs are refused because a player must not be able to confirm
 * one exists by writing to it.
 */
export const setPlayerNotes = mutation({
  args: {
    npcId: v.id("npcs"),
    playerNotes: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");
    const { isDm } = await requireMember(ctx, npc.campaignId);

    if (npc.hidden && !isDm) {
      throw new Error("NPC not found");
    }

    await ctx.db.patch(args.npcId, {
      playerNotes: args.playerNotes === null ? undefined : args.playerNotes,
    });
  },
});

/**
 * DM: add a new NPC to the campaign.
 *
 * Seeds only the fields the schema requires and leaves the rest empty —
 * the record then gets filled in through the same editor as any other
 * NPC, rather than needing a separate creation form to be kept in sync
 * with the field list.
 */
export const createNpc = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    return await ctx.db.insert("npcs", {
      campaignId: args.campaignId,
      name: args.name?.trim() || "New NPC",
      noLastName: false,
      status: [],
      groups: [],
      familyMembers: [],
      place: [],
      // New NPCs start hidden: the DM decides when the table meets them.
      hidden: true,
    });
  },
});
