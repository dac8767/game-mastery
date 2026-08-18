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

  /**
   * The NPC roster — the Airtable "NPCs Master List" base, migrated.
   *
   * Field shapes follow what the Airtable export actually contains:
   * - Multi-selects (`status`, `groups`, `place`, `familyMembers`) arrive
   *   comma-separated and are stored as string arrays so the browser can
   *   facet on them.
   * - Airtable checkboxes ("checked" / empty) become real booleans.
   * - Everything else is optional: the base has columns that are wired up
   *   but not yet filled in (voice, kingdom, alignment, sexuality,
   *   quirkPhysical, playerNotes), and they should round-trip once they
   *   are.
   *
   * DM-only fields — `dmNotes`, `secret`, and the `hidden` flag itself —
   * are stripped server-side in npcs.listForCampaign for non-DM callers,
   * the same way combat.getEncounterView masks combatants. They must
   * never be sent to a player client.
   *
   * No search index: the roster is small enough that one subscription
   * feeds the whole screen and the browser does the searching, which
   * costs zero function calls per keystroke. Past a few thousand NPCs,
   * switch to a search index plus a paginated query.
   */
  npcs: defineTable({
    campaignId: v.id("campaigns"),

    // Identity
    name: v.string(), // full display name, whitespace-normalized
    prefix: v.optional(v.string()), // "King", "Queen"
    first: v.optional(v.string()),
    middle: v.optional(v.string()),
    family: v.optional(v.string()),
    suffix: v.optional(v.string()), // "III", "XIV"
    nickname: v.optional(v.string()),
    noLastName: v.boolean(),

    // Who they are
    status: v.array(v.string()), // "Alive", "Dead", "Unknown", "NEW"
    gender: v.optional(v.string()),
    species: v.optional(v.string()),
    lineage: v.optional(v.string()), // "Mountain", "Deep", "Wood"
    sexuality: v.optional(v.string()),
    alignment: v.optional(v.string()),

    // Age
    startingAge: v.optional(v.number()),
    age: v.optional(v.number()),
    maxAge: v.optional(v.number()),
    maturity: v.optional(v.string()), // "Child", "Adult", "Senior"

    // Ties
    groups: v.array(v.string()), // "Townsfolk", "Mining Guild", "Royals"
    job: v.optional(v.string()),
    familyMembers: v.array(v.string()), // names, as free text
    familyMemberCount: v.optional(v.number()),

    // Where
    place: v.array(v.string()), // "Moonbrook", "Mines", "Cemetery"
    region: v.optional(v.string()),
    kingdom: v.optional(v.string()),

    // Flavor
    description: v.optional(v.string()),
    quirkMental: v.optional(v.string()),
    quirkPhysical: v.optional(v.string()),
    politics: v.optional(v.string()),
    abilities: v.optional(v.string()),
    wantsNeeds: v.optional(v.string()),
    voice: v.optional(v.string()),
    playerNotes: v.optional(v.string()),

    // Portrait on the map server, e.g. "web/portraits/npcs/xyz.webp".
    // The Airtable attachment URLs are signed and expire, so only the
    // filename survives the migration — see scripts/import-npcs.mjs.
    portraitPath: v.optional(v.string()),

    // DM-only — never sent to players (see npcs.listForCampaign)
    hidden: v.boolean(),
    dmNotes: v.optional(v.string()),
    secret: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  /**
   * Per-person app settings. One document per user, all of it personal.
   *
   * Note what is NOT here: whether you are a DM. That is structural —
   * you are the DM of a campaign iff campaign.dmId is your userId — and
   * it must stay that way. A self-settable role flag would let any
   * player grant themselves every secret and DM note in the campaign.
   *
   * `viewAsPlayer` is the safe inverse: a DM asking the server to treat
   * them as a player so they can see exactly what the table gives away.
   * It only ever removes access, so it is fine to let the caller set it.
   */
  userSettings: defineTable({
    userId: v.id("users"),
    theme: v.union(
      v.literal("candlelight"),
      v.literal("slate"),
      v.literal("parchment")
    ),
    viewAsPlayer: v.boolean(),
    /**
     * Break-glass switch for a platform admin. Storing it here is safe
     * because it does nothing on its own: eligibility comes from the
     * ADMIN_EMAILS deployment variable, which no mutation can write, and
     * auth.hasActiveAdmin requires both. Optional so rows written before
     * admin existed still validate.
     */
    adminOverride: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  /**
   * Per-person table layout. One document per (user, campaign, view).
   *
   * Everyone shapes a table to their own taste — which columns show, in
   * what order, how wide, and the active sort/group/filter — and none of
   * it is visible to anyone else. Queries only ever read the caller's
   * own row, so there is no sharing to opt out of.
   *
   * Stored server-side rather than in localStorage so a layout follows
   * you between the laptop and the desktop. Writes are debounced on the
   * client; dragging a column border is not one mutation per pixel.
   */
  viewPrefs: defineTable({
    userId: v.id("users"),
    campaignId: v.id("campaigns"),
    view: v.string(), // "npcs" — the table this layout belongs to
    columns: v.array(
      v.object({
        key: v.string(),
        width: v.number(),
        visible: v.boolean(),
      })
    ),
    sortKey: v.optional(v.string()),
    sortAsc: v.optional(v.boolean()),
    groupBy: v.optional(v.string()),
    // Airtable-style conditions: Where <field> <operator> <values>.
    // `operator` is optional so layouts saved before operators existed
    // still validate; they are read as "has any of".
    filters: v.optional(
      v.array(
        v.object({
          field: v.string(),
          operator: v.optional(v.string()),
          values: v.array(v.string()),
        })
      )
    ),
    filterConjunction: v.optional(
      v.union(v.literal("and"), v.literal("or"))
    ),
    // Grid (dense rows) or tiles (portrait-led cards).
    viewMode: v.optional(v.union(v.literal("grid"), v.literal("tiles"))),
    tilesPerRow: v.optional(v.number()),
  }).index("by_user_campaign_view", ["userId", "campaignId", "view"]),

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
