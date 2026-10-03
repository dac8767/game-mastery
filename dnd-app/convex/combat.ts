import { v } from "convex/values";
import {
  mutation,
  query,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { requireDm, requireMember } from "./auth";
import { Doc, Id } from "./_generated/dataModel";
// Relative, not "@/": the Convex tsconfig does not carry the app's alias.
import {
  applyHpChange as hpAfter,
  checkAc,
  checkHpChange,
  checkInitiative,
  checkMaxHp,
  checkTempHp,
  nextTurn as turnAfter,
} from "../components/combatRules";

/**
 * Combat tracker — the reactive core of the app.
 *
 * Every player screen subscribes to getEncounterView. Every GM action
 * (damage, next turn, reveal) is a single mutation; Convex pushes the
 * updated view to all clients immediately. There is no refetch step and
 * no polling — the latency problem from the Airtable tracker cannot
 * occur in this architecture.
 *
 * Player-safe shaping happens server-side in getEncounterView:
 * - hidden combatants are omitted entirely
 * - HP is masked into status buckets unless showHpToPlayers
 * - dmNotes never leave the server for non-GM callers
 * - the active combatant is not named while they are hidden, or the
 *   turn marker would give away that something unseen is acting
 */

// ---------- Encounter lifecycle (GM only) ----------

export const createEncounter = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    mapId: v.optional(v.id("maps")),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    return await ctx.db.insert("encounters", {
      campaignId: args.campaignId,
      name: args.name,
      status: "prep",
      round: 0,
      mapId: args.mapId,
    });
  },
});

/** Start combat: sort by initiative, set round 1, point the table at it. */
export const startEncounter = mutation({
  args: { encounterId: v.id("encounters") },
  handler: async (ctx, args) => {
    const encounter = await ctx.db.get(args.encounterId);
    if (!encounter) throw new Error("Encounter not found");
    await requireDm(ctx, encounter.campaignId);

    const combatants = await sortedCombatants(ctx, args.encounterId);
    if (combatants.length === 0) {
      throw new Error("Add combatants before starting");
    }
    await ctx.db.patch(args.encounterId, {
      status: "active",
      round: 1,
      activeCombatantId: combatants[0]._id,
    });

    // Point the campaign's table state at this encounter.
    const state = await ctx.db
      .query("tableState")
      .withIndex("by_campaign", (q) =>
        q.eq("campaignId", encounter.campaignId)
      )
      .unique();
    if (state) {
      await ctx.db.patch(state._id, {
        activeEncounterId: args.encounterId,
        ...(encounter.mapId ? { activeMapId: encounter.mapId } : {}),
      });
    }
  },
});

export const endEncounter = mutation({
  args: { encounterId: v.id("encounters") },
  handler: async (ctx, args) => {
    const encounter = await ctx.db.get(args.encounterId);
    if (!encounter) throw new Error("Encounter not found");
    await requireDm(ctx, encounter.campaignId);

    await ctx.db.patch(args.encounterId, {
      status: "ended",
      activeCombatantId: undefined,
    });
    const state = await ctx.db
      .query("tableState")
      .withIndex("by_campaign", (q) =>
        q.eq("campaignId", encounter.campaignId)
      )
      .unique();
    if (state && state.activeEncounterId === args.encounterId) {
      await ctx.db.patch(state._id, { activeEncounterId: undefined });
    }
  },
});

// ---------- Combatants (GM only) ----------

export const addCombatant = mutation({
  args: {
    encounterId: v.id("encounters"),
    name: v.string(),
    kind: v.union(v.literal("pc"), v.literal("npc"), v.literal("monster")),
    characterId: v.optional(v.id("characters")),
    initiative: v.number(),
    maxHp: v.number(),
    ac: v.optional(v.number()),
    hidden: v.optional(v.boolean()),
    showHpToPlayers: v.optional(v.boolean()),
    dmNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const encounter = await ctx.db.get(args.encounterId);
    if (!encounter) throw new Error("Encounter not found");
    await requireDm(ctx, encounter.campaignId);
    const maxHp = checkMaxHp(args.maxHp);

    return await ctx.db.insert("combatants", {
      encounterId: args.encounterId,
      name: args.name,
      kind: args.kind,
      characterId: args.characterId,
      initiative: checkInitiative(args.initiative),
      tiebreak: 0,
      maxHp,
      currentHp: maxHp,
      tempHp: 0,
      ac: args.ac === undefined ? undefined : checkAc(args.ac),
      conditions: [],
      hidden: args.hidden ?? args.kind === "monster",
      showHpToPlayers: args.showHpToPlayers ?? args.kind === "pc",
      dmNotes: args.dmNotes,
    });
  },
});

export const setInitiative = mutation({
  args: {
    combatantId: v.id("combatants"),
    initiative: v.number(),
    tiebreak: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await dmForCombatant(ctx, args.combatantId);
    await ctx.db.patch(args.combatantId, {
      initiative: checkInitiative(args.initiative),
      ...(args.tiebreak !== undefined
        ? { tiebreak: checkInitiative(args.tiebreak, "Tiebreak") }
        : {}),
    });
  },
});

/**
 * Apply damage or healing. Negative amount = healing.
 * Damage consumes tempHp first, per RAW.
 */
export const applyHpChange = mutation({
  args: { combatantId: v.id("combatants"), amount: v.number() },
  handler: async (ctx, args) => {
    const { combatant } = await dmForCombatant(ctx, args.combatantId);
    await ctx.db.patch(
      args.combatantId,
      hpAfter(combatant, checkHpChange(args.amount))
    );
  },
});

export const setTempHp = mutation({
  args: { combatantId: v.id("combatants"), tempHp: v.number() },
  handler: async (ctx, args) => {
    await dmForCombatant(ctx, args.combatantId);
    await ctx.db.patch(args.combatantId, {
      tempHp: checkTempHp(args.tempHp),
    });
  },
});

export const toggleCondition = mutation({
  args: { combatantId: v.id("combatants"), condition: v.string() },
  handler: async (ctx, args) => {
    const { combatant } = await dmForCombatant(ctx, args.combatantId);
    const has = combatant.conditions.includes(args.condition);
    await ctx.db.patch(args.combatantId, {
      conditions: has
        ? combatant.conditions.filter((c) => c !== args.condition)
        : [...combatant.conditions, args.condition],
    });
  },
});

export const setConcentration = mutation({
  args: {
    combatantId: v.id("combatants"),
    spell: v.optional(v.string()), // undefined = drop concentration
  },
  handler: async (ctx, args) => {
    await dmForCombatant(ctx, args.combatantId);
    await ctx.db.patch(args.combatantId, { concentrating: args.spell });
  },
});

/** Reveal a hidden combatant to the players ("A shadow steps out..."). */
export const revealCombatant = mutation({
  args: { combatantId: v.id("combatants") },
  handler: async (ctx, args) => {
    await dmForCombatant(ctx, args.combatantId);
    await ctx.db.patch(args.combatantId, { hidden: false });
  },
});

export const removeCombatant = mutation({
  args: { combatantId: v.id("combatants") },
  handler: async (ctx, args) => {
    const { encounter, combatant } = await dmForCombatant(
      ctx,
      args.combatantId
    );
    // If it's their turn, hand it on — skipping them, so the last one
    // standing leaves no active combatant rather than one that is gone.
    if (encounter.activeCombatantId === combatant._id) {
      await advanceTurn(ctx, encounter, combatant._id);
    }
    await ctx.db.delete(args.combatantId);
  },
});

// ---------- Turn management (GM only) ----------

export const nextTurn = mutation({
  args: { encounterId: v.id("encounters") },
  handler: async (ctx, args) => {
    const encounter = await ctx.db.get(args.encounterId);
    if (!encounter) throw new Error("Encounter not found");
    await requireDm(ctx, encounter.campaignId);
    if (encounter.status !== "active") {
      throw new Error("Encounter is not active");
    }
    await advanceTurn(ctx, encounter);
  },
});

// ---------- Views ----------

/**
 * The one subscription both apps use. Shape depends on who's asking:
 * the GM gets everything; players get the player-safe projection.
 */
export const getEncounterView = query({
  args: { encounterId: v.id("encounters") },
  handler: async (ctx, args) => {
    const encounter = await ctx.db.get(args.encounterId);
    if (!encounter) return null;
    const { isDm } = await requireMember(ctx, encounter.campaignId);

    // Players never see prep-stage encounters.
    if (!isDm && encounter.status === "prep") return null;

    const combatants = await sortedCombatants(ctx, args.encounterId);
    const active = combatants.find((c) => c._id === encounter.activeCombatantId);
    const activeShown = isDm || (active !== undefined && !active.hidden);

    const shaped = combatants
      .filter((c) => isDm || !c.hidden)
      .map((c) => {
        if (isDm) {
          return { ...c, view: "dm" as const };
        }
        return {
          _id: c._id,
          name: c.name,
          kind: c.kind,
          initiative: c.initiative,
          conditions: c.conditions,
          concentrating: c.concentrating ?? null,
          isActive: encounter.activeCombatantId === c._id,
          ...(c.showHpToPlayers
            ? {
                currentHp: c.currentHp,
                maxHp: c.maxHp,
                tempHp: c.tempHp,
                hpStatus: hpStatus(c),
              }
            : {
                currentHp: null,
                maxHp: null,
                tempHp: null,
                // Players still get a narrative read on enemies:
                hpStatus: hpStatus(c),
              }),
          view: "player" as const,
        };
      });

    return {
      _id: encounter._id,
      name: encounter.name,
      status: encounter.status,
      round: encounter.round,
      activeCombatantId: activeShown
        ? (encounter.activeCombatantId ?? null)
        : null,
      combatants: shaped,
    };
  },
});

/** GM: list encounters for a campaign (prep + active + recent). */
export const listEncounters = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { isDm } = await requireMember(ctx, args.campaignId);
    if (!isDm) throw new Error("Only the GM can list encounters");
    return await ctx.db
      .query("encounters")
      .withIndex("by_campaign_status", (q) =>
        q.eq("campaignId", args.campaignId)
      )
      .collect();
  },
});

// ---------- Internals ----------

async function sortedCombatants(
  ctx: QueryCtx | MutationCtx,
  encounterId: Id<"encounters">
) {
  const rows = await ctx.db
    .query("combatants")
    .withIndex("by_encounter", (q) => q.eq("encounterId", encounterId))
    .collect();
  return rows.sort(
    (a, b) =>
      b.initiative - a.initiative ||
      b.tiebreak - a.tiebreak ||
      a._creationTime - b._creationTime
  );
}

async function dmForCombatant(
  ctx: MutationCtx,
  combatantId: Id<"combatants">
) {
  const combatant = await ctx.db.get(combatantId);
  if (!combatant) throw new Error("Combatant not found");
  const encounter = await ctx.db.get(combatant.encounterId);
  if (!encounter) throw new Error("Encounter not found");
  await requireDm(ctx, encounter.campaignId);
  return { combatant, encounter };
}

async function advanceTurn(
  ctx: MutationCtx,
  encounter: Doc<"encounters">,
  excluding?: Id<"combatants">
) {
  const order = await sortedCombatants(ctx, encounter._id);
  const { active, wrapped } = turnAfter(
    order.map((c) => c._id),
    encounter.activeCombatantId,
    excluding
  );
  await ctx.db.patch(encounter._id, {
    activeCombatantId: active,
    round: wrapped ? encounter.round + 1 : encounter.round,
  });
}

/** Narrative HP bucket for player screens ("bloodied" at half, per 4e/5e slang). */
function hpStatus(c: Doc<"combatants">) {
  if (c.currentHp <= 0) return "down";
  if (c.currentHp <= c.maxHp / 2) return "bloodied";
  if (c.currentHp < c.maxHp) return "injured";
  return "healthy";
}
