import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * D&D Campaign App — Convex Schema
 *
 * Design principles:
 * - Two campaigns (your two groups) share one deployment; every content
 *   table carries campaignId so data never bleeds between groups.
 * - The DM is authoritative: campaign.dmId gates all mutations that
 *   change game state. Players get read access shaped by visibility
 *   fields (hidden combatants, masked HP).
 * - Map images live on the PowerEdge behind the Cloudflare tunnel; this
 *   schema stores only paths + metadata. Tags use the locked vocabulary
 *   from your existing Make/LLM tagging pipeline.
 * - tableState is the realtime heart of the player view: one document
 *   per campaign that every player client subscribes to. The DM changes
 *   it (active map, active encounter) and all screens follow instantly.
 */
export default defineSchema({
  ...authTables,

  profiles: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    accentColor: v.optional(v.string()),
    // Portrait served from the map server, e.g. "web/portraits/derek.webp"
    portraitPath: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  campaigns: defineTable({
    name: v.string(), // e.g. "Episode X — Valenar"
    dmId: v.id("users"),
    description: v.optional(v.string()),
  }).index("by_dm", ["dmId"]),

  campaignMembers: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_user", ["userId"])
    .index("by_campaign_user", ["campaignId", "userId"]),

  characters: defineTable({
    campaignId: v.id("campaigns"),
    playerId: v.optional(v.id("users")), // undefined = DM-run NPC sheet
    name: v.string(),
    className: v.optional(v.string()),
    level: v.optional(v.number()),
    maxHp: v.number(),
    ac: v.optional(v.number()),
    initiativeBonus: v.optional(v.number()),
    portraitPath: v.optional(v.string()), // on the map server
    notes: v.optional(v.string()), // DM-visible only
  })
    .index("by_campaign", ["campaignId"])
    .index("by_player", ["playerId"]),

  // Map library metadata. Images live at
  // https://maps.yourdomain.com/{webPath|originalPath}
  maps: defineTable({
    title: v.string(),
    originalPath: v.string(), // "originals/dungeons/sunken-crypt.png"
    webPath: v.string(), // "web/dungeons/sunken-crypt.webp"
    tags: v.array(v.string()), // locked vocabulary from tagging pipeline
    environment: v.optional(v.string()), // top-level category if you use one
    gridSizePx: v.optional(v.number()), // pixels per 5ft square
    widthSquares: v.optional(v.number()),
    heightSquares: v.optional(v.number()),
    source: v.optional(v.string()), // creator/pack attribution
  })
    .index("by_environment", ["environment"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["tags", "environment"],
    }),

  // One document per campaign: what the players' screens show right now.
  // Every player client subscribes to this; the DM app mutates it.
  tableState: defineTable({
    campaignId: v.id("campaigns"),
    activeMapId: v.optional(v.id("maps")),
    activeEncounterId: v.optional(v.id("encounters")),
    showGrid: v.boolean(),
    // Freeform DM broadcast line, e.g. "Roll perception" / "Short rest"
    banner: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  encounters: defineTable({
    campaignId: v.id("campaigns"),
    name: v.string(), // "Sky Temple — lightning rooftop"
    status: v.union(
      v.literal("prep"), // DM building it; invisible to players
      v.literal("active"),
      v.literal("ended")
    ),
    round: v.number(),
    // Whose turn it is; undefined until combat starts
    activeCombatantId: v.optional(v.id("combatants")),
    mapId: v.optional(v.id("maps")),
  }).index("by_campaign_status", ["campaignId", "status"]),

  combatants: defineTable({
    encounterId: v.id("encounters"),
    name: v.string(),
    kind: v.union(v.literal("pc"), v.literal("npc"), v.literal("monster")),
    characterId: v.optional(v.id("characters")), // linked for PCs
    initiative: v.number(),
    // Stable tiebreak for equal initiative (DM sets; default 0)
    tiebreak: v.number(),
    maxHp: v.number(),
    currentHp: v.number(),
    tempHp: v.number(),
    ac: v.optional(v.number()),
    conditions: v.array(v.string()), // "prone", "restrained", ...
    concentrating: v.optional(v.string()), // spell name, if any
    // Visibility controls (the DM-vs-player split):
    hidden: v.boolean(), // not yet revealed — players don't see it at all
    showHpToPlayers: v.boolean(), // false → players see status bucket only
    dmNotes: v.optional(v.string()), // never sent to players
  }).index("by_encounter", ["encounterId"]),
});
