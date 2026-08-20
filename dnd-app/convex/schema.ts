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
/**
 * A description, as ordered blocks rather than one flattened string.
 *
 * Foundry writes real tables and lists into descriptions, and
 * flattening them runs a d100 table's cells together into an
 * unreadable sentence. Blocks keep a table a table, in its place in the
 * prose — and keep raw HTML out of the database, so nothing downstream
 * is ever rendered as markup.
 */
const blockValidator = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("table"),
    /** Empty when the table had no header row of its own. */
    headers: v.array(v.string()),
    rows: v.array(v.array(v.string())),
  }),
  v.object({
    type: v.literal("list"),
    ordered: v.boolean(),
    items: v.array(v.string()),
  })
);

const featureValidator = v.object({
  name: v.string(),
  blocks: v.array(blockValidator),
});

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

    /**
     * Portrait, held two ways.
     *
     * `portraitId` is an uploaded image in Convex file storage and wins
     * when set. `portraitPath` is the older map-server route, e.g.
     * "web/portraits/npcs/xyz.webp" — the Airtable export's attachment
     * URLs are signed and expire, so only a derived filename survived
     * the migration (see scripts/import-npcs.mjs).
     *
     * Both are kept rather than migrating one into the other: the
     * imported paths still name which portrait an NPC is *supposed* to
     * have, which is worth keeping until a real image replaces it.
     */
    portraitId: v.optional(v.id("_storage")),
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
    /**
     * The ribbon toolbar's layout: one flat array of short tokens. Not a
     * tree and not an object, so there is no migration scaffolding for a
     * shape that keeps changing — see components/ribbonTokens.ts for the
     * grammar.
     */
    toolbarTokens: v.optional(v.array(v.string())),
    /**
     * Has this person ever arranged their toolbar?
     *
     * Judged from what was PERSISTED, never from the normalized result.
     * An empty toolbar is a legitimate thing to have made, so seeding the
     * default whenever the array is empty would resurrect it on every
     * load for anyone who cleared theirs.
     */
    toolbarSet: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  /**
   * ── Lookup: the reference library ─────────────────────────────────
   *
   * Spells, items and monsters. These three tables are deliberately
   * NOT campaign-scoped: a fireball is a fireball in both of Derek's
   * groups, and a per-campaign copy would mean importing the SRD twice
   * and having them drift.
   *
   * That makes them the only shared, cross-campaign content in the
   * schema, so the access rule is different too — every signed-in
   * member reads them, and NOTHING writes them from inside the app.
   * They are populated by `npx convex import`, which writes straight to
   * the table without a mutation, so there is no write path to secure
   * and no function-call cost for a thousand-row load.
   *
   * Each carries a search index, because these are the only tables big
   * enough that sending the whole list to a subscribed component would
   * be the free tier's bandwidth footgun.
   *
   * `source` records where a row came from ("SRD 5.1", "DDB"), so a
   * re-import can be told apart from what was already there.
   */
  spells: defineTable({
    name: v.string(),
    /**
     * Artwork, as a Foundry-relative path ("icons/magic/...").
     *
     * Stored as a path and served from the map server, the same way
     * NPC portraits and location maps are — the files come out of a
     * running Foundry via scripts/fetch-foundry-images.mjs. Keeping
     * paths rather than uploading a thousand icons into file storage
     * keeps the free tier's storage for things that are actually
     * Derek's.
     */
    image: v.optional(v.string()),
    level: v.number(), // 0 = cantrip
    school: v.optional(v.string()),
    castingTime: v.optional(v.string()),
    range: v.optional(v.string()),
    components: v.optional(v.string()),
    materials: v.optional(v.string()),
    duration: v.optional(v.string()),
    /** The shape it fills, when it fills one: "20 ft Sphere". */
    area: v.optional(v.string()),
    /** What you roll against it: "DEX Save", "Ranged". */
    attackSave: v.optional(v.string()),
    /** What it does: a damage type, or "Healing". */
    damageEffect: v.optional(v.string()),
    ritual: v.boolean(),
    concentration: v.boolean(),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["level", "school"],
    }),

  items: defineTable({
    name: v.string(),
    image: v.optional(v.string()),
    /** weapon | armor | gear | consumable | tool | container | other */
    kind: v.string(),
    /** The real dnd5e subtype the kind bucket flattens: "wondrous". */
    subtype: v.optional(v.string()),
    /** "Magical, Adamantine" — the Details tab's property checkboxes. */
    properties: v.optional(v.string()),
    rarity: v.optional(v.string()),
    price: v.optional(v.string()),
    weight: v.optional(v.number()),
    attunement: v.boolean(),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["kind", "rarity"],
    }),

  monsters: defineTable({
    name: v.string(),
    image: v.optional(v.string()),
    size: v.optional(v.string()),
    creatureType: v.optional(v.string()),
    alignment: v.optional(v.string()),
    /** Stored as a number so it sorts; 0.25 is "1/4" on screen. */
    cr: v.optional(v.number()),
    ac: v.optional(v.number()),
    hp: v.optional(v.number()),
    speed: v.optional(v.string()),
    abilities: v.optional(
      v.object({
        str: v.optional(v.number()),
        dex: v.optional(v.number()),
        con: v.optional(v.number()),
        int: v.optional(v.number()),
        wis: v.optional(v.number()),
        cha: v.optional(v.number()),
      })
    ),
    habitat: v.optional(v.string()),
    skills: v.optional(v.string()),
    senses: v.optional(v.string()),
    languages: v.optional(v.string()),
    proficiencyBonus: v.optional(v.number()),
    xp: v.optional(v.number()),
    /**
     * Traits and actions are EMBEDDED items on a Foundry actor rather
     * than fields, so they arrive as a list of named blocks. Stored as
     * one array each rather than their own table: a stat block is read
     * whole or not at all, and splitting it would turn one row into
     * thirty.
     */
    traits: v.optional(v.array(featureValidator)),
    actions: v.optional(v.array(featureValidator)),
    legendaryActions: v.optional(v.array(featureValidator)),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["creatureType", "cr"],
    }),

  /**
   * Locations — a tree of places, each of which may carry a map.
   *
   * A region map holds pins for its towns; double-clicking a town whose
   * location has a map of its own descends into it, and the pattern
   * repeats down to a battle map. So a location is BOTH a pin on its
   * parent's map (x, y) and, if it has one, a map of its own.
   *
   * `x`/`y` are normalized 0..1 rather than pixels, so a pin stays where
   * the DM put it whatever size the image is displayed at, and survives
   * the map being replaced with a larger scan.
   *
   * `dmNotes` and `hidden` follow the same rule as NPCs and combatants:
   * stripped server-side in listForCampaign, never sent to a player.
   * Hiding a location does NOT hide its children — see
   * components/locationTree.ts, which surfaces a child whose parent is
   * missing at the root rather than losing it.
   */
  locations: defineTable({
    campaignId: v.id("campaigns"),
    /** The location this one sits inside. Absent = a top-level map. */
    parentId: v.optional(v.id("locations")),
    name: v.string(),
    description: v.optional(v.string()),
    /** Sort order among siblings. */
    order: v.number(),

    /** Where this sits on its PARENT's map, normalized 0..1. */
    x: v.optional(v.number()),
    y: v.optional(v.number()),

    /**
     * This location's own map, held two ways for the same reason NPC
     * portraits are: an uploaded file wins, and the map-server path is
     * the older route that still names which image it should have.
     */
    mapId: v.optional(v.id("_storage")),
    mapPath: v.optional(v.string()),

    /** Uploaded pictures of the place itself, not of its map. */
    pictureIds: v.optional(v.array(v.id("_storage"))),

    // DM-only — never sent to players (see locations.listForCampaign)
    hidden: v.boolean(),
    dmNotes: v.optional(v.string()),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_parent", ["parentId"]),

  /**
   * The campaign's calendar. One document per campaign, DM-owned.
   *
   * Every month is the same length, because `daysPerMonth` is one
   * number — months of differing lengths are a different data model and
   * nothing asked for one. The name lists are resized to their counts
   * on every save (see components/calendarModel.ts): a five-day week
   * with seven day names is a grid whose header doesn't line up with
   * its columns.
   */
  calendars: defineTable({
    campaignId: v.id("campaigns"),
    daysPerWeek: v.number(),
    dayNames: v.array(v.string()),
    daysPerMonth: v.number(),
    monthsPerYear: v.number(),
    monthNames: v.array(v.string()),
    currentYear: v.number(),
    /** 0-based, so it indexes monthNames directly. */
    currentMonth: v.number(),
    /** 1-based, the way a person says a date. */
    currentDay: v.number(),
  }).index("by_campaign", ["campaignId"]),

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

  /**
   * Chat channels for a campaign.
   *
   * Visibility is a property of the channel, checked server-side on
   * every read and every send:
   *   everyone — any member of the campaign
   *   dmOnly   — only the DM (and an admin with the override active)
   *   private  — the DM plus the listed members, for whispering to one
   *              player without the table seeing it
   *
   * A player must not be able to learn that a dmOnly channel exists, so
   * those are filtered out of the channel list rather than shown locked.
   */
  chatChannels: defineTable({
    campaignId: v.id("campaigns"),
    name: v.string(),
    visibility: v.union(
      v.literal("everyone"),
      v.literal("dmOnly"),
      v.literal("private")
    ),
    /** For `private` channels; the DM always has access regardless. */
    memberIds: v.optional(v.array(v.id("users"))),
    order: v.number(),
  }).index("by_campaign", ["campaignId"]),

  chatMessages: defineTable({
    channelId: v.id("chatChannels"),
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
    body: v.string(),
    editedAt: v.optional(v.number()),
  }).index("by_channel", ["channelId"]),

  /**
   * The Notebook — a tree of pages and coloured folders, each page a
   * canvas of free-floating boxes.
   *
   * Ported from ScriptCraft's Scrapbook, with two deliberate changes.
   * That version kept everything in one localStorage blob, which would
   * not follow you between the laptop and the desktop and capped images
   * at a shared ~5MB. And it rewrote the whole blob on every mutation.
   *
   * Here the tree is flat rows rather than a nested document: Convex
   * validators cannot express a recursive node type, and a flat table
   * with parentId is both checkable and repairable. The client builds
   * the tree and drops orphans on load — the equivalent of that port's
   * reconcileTree(), which exists because a half-written blob must come
   * up empty rather than throw.
   *
   * Notebooks are personal: one per (user, campaign), private to that
   * person, like their table layouts.
   */
  notebookNodes: defineTable({
    userId: v.id("users"),
    campaignId: v.id("campaigns"),
    kind: v.union(v.literal("page"), v.literal("section")),
    title: v.string(),
    /** undefined = top level. Sections may nest. */
    parentId: v.optional(v.id("notebookNodes")),
    /** Sort key among siblings. */
    order: v.number(),
    color: v.optional(v.string()), // folder tint
    collapsed: v.optional(v.boolean()),
  })
    .index("by_user_campaign", ["userId", "campaignId"])
    .index("by_parent", ["parentId"]),

  /**
   * One row per box, not an array on the page.
   *
   * Dragging a box then rewrites one small document instead of the whole
   * page, and a page full of images can't run into the 1MB document
   * limit. Images are Convex file storage ids rather than base64 data
   * URLs — the single biggest thing the handoff said to change on the
   * way over.
   *
   * Stacking is `order` alone, exactly one source for it. The handoff is
   * explicit that a z-index field beside an array position is how two
   * orderings drift apart.
   */
  notebookBoxes: defineTable({
    pageId: v.id("notebookNodes"),
    userId: v.id("users"),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("table")),

    x: v.number(),
    y: v.number(),
    w: v.number(),
    h: v.number(),
    order: v.number(),

    html: v.optional(v.string()), // text boxes
    storageId: v.optional(v.id("_storage")), // image boxes
    rotate: v.optional(v.number()),
    borderW: v.optional(v.number()),
    borderColor: v.optional(v.string()),

    rows: v.optional(v.array(v.array(v.string()))), // table boxes
    colWidths: v.optional(v.array(v.number())),
    rowHeights: v.optional(v.array(v.number())),
    align: v.optional(
      v.union(v.literal("left"), v.literal("center"), v.literal("right"))
    ),
    borderless: v.optional(v.boolean()),
    shading: v.optional(v.string()),
  }).index("by_page", ["pageId"]),

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
