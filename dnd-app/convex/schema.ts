import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * D&D Campaign App — Convex Schema
 *
 * Design principles:
 * - Two campaigns (your two groups) share one deployment; every content
 *   table carries campaignId so data never bleeds between groups.
 * - The GM is authoritative: campaign.dmId gates all mutations that
 *   change game state. Players get read access shaped by visibility
 *   fields (hidden combatants, masked HP).
 * - Map images live on the PowerEdge behind the Cloudflare tunnel; this
 *   schema stores only paths + metadata. Tags use the locked vocabulary
 *   from your existing Make/LLM tagging pipeline.
 * - tableState is the realtime heart of the player view: one document
 *   per campaign that every player client subscribes to. The GM changes
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
    /**
     * Which edition this table plays: "2014" is 5e, "2024" is 5.5e.
     *
     * The Lookup library holds both — a DDB import carries PHB and PHB
     * 2024, MM and MM 2024 — so most core entries appear twice under one
     * name. This decides which of the pair a campaign sees. It does NOT
     * filter by book: Tasha's, Xanathar's and every adventure have no
     * counterpart in the other edition, so they show either way.
     *
     * Absent reads as "2014", so a campaign nobody has set behaves like
     * the edition its content was written for. The Lookup screen names
     * the active edition and counts what it folded away, so this is
     * never a silently shorter list.
     */
    rulesVersion: v.optional(
      v.union(v.literal("2014"), v.literal("2024"))
    ),

    /**
     * How this table levels: by XP totals, or by milestone.
     *
     * Decides which field a session's facts row shows — XP Awarded, or
     * "Leveled up to" with the levels not yet reached. Absent reads as
     * "xp", which is what every session row written before this
     * existed was using.
     */
    leveling: v.optional(v.union(v.literal("xp"), v.literal("milestone"))),

    /**
     * The picture on the campaign card, held the same two ways NPC
     * portraits are: `imageId` is an upload in Convex file storage and
     * wins when set; `imagePath` is the map-server route, e.g.
     * "web/campaigns/moonbrook.webp", for art you already keep there.
     */
    imageId: v.optional(v.id("_storage")),
    imagePath: v.optional(v.string()),

    /**
     * Real-world dates, as "YYYY-MM-DD" — the day the group first sat
     * down, and when they next will. Not in-world dates: the campaign
     * calendar owns those, and it is a per-campaign invention with its
     * own month names and week length (see calendars).
     */
    startDate: v.optional(v.string()),
    nextSessionDate: v.optional(v.string()),
  }).index("by_dm", ["dmId"]),

  /**
   * A link that puts someone in a campaign.
   *
   * The gap this fills: addMemberByEmail can only add an account that
   * already exists, so inviting somebody who has never signed up was a
   * conversation ("make an account, tell me the address, then I'll add
   * you") rather than a link. The invite carries the campaign, so
   * signing up THROUGH it lands you in the game.
   *
   * The token is the credential. It is unguessable, it expires, it can
   * be spent a fixed number of times and it can be revoked — because a
   * link that never dies is a permanent unauthenticated door into a
   * campaign, and links end up in group chats.
   */
  campaignInvites: defineTable({
    campaignId: v.id("campaigns"),
    /** URL-safe, unguessable, and the only thing that grants entry. */
    token: v.string(),
    createdBy: v.id("users"),
    /** Epoch ms. Past this the link is dead however many uses are left. */
    expiresAt: v.number(),
    /** How many people may still come through it. */
    usesLeft: v.number(),
    /** Set the moment the GM revokes it, so a spent link reads as spent. */
    revokedAt: v.optional(v.number()),
    /**
     * The character this invite hands over, if the GM built the roster
     * first. Claiming it sets `characters.playerId`, which is what turns
     * "a name the GM typed" into "an account that owns this sheet".
     */
    characterId: v.optional(v.id("characters")),
  })
    // Unique in practice, not by constraint: Convex has no unique index,
    // so createInvite checks before writing and acceptInvite reads the
    // first match. A collision on 122 bits of randomness is not the
    // failure mode worth designing around.
    .index("by_token", ["token"])
    .index("by_campaign", ["campaignId"]),

  campaignMembers: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_user", ["userId"])
    .index("by_campaign_user", ["campaignId", "userId"]),

  /**
   * The party. One row per character, whether or not the person playing
   * it has an account yet.
   *
   * A GM builds the roster before anyone signs up, so `playerId` and
   * `playerName` say different things and both can be absent:
   *
   *   playerName set, playerId unset   a real person, typed by the GM,
   *                                    waiting to be claimed
   *   playerId set                     claimed; that account owns it
   *   neither set                      a GM-run sheet, no player at all
   *
   * That distinction is why `playerName` exists rather than reusing an
   * empty `playerId`: "nobody plays this" and "the player has not signed
   * up yet" want opposite handling when someone finally registers.
   */
  characters: defineTable({
    campaignId: v.id("campaigns"),
    playerId: v.optional(v.id("users")),
    /** Who plays it, before they have an account to link. */
    playerName: v.optional(v.string()),
    name: v.string(),
    className: v.optional(v.string()),
    level: v.optional(v.number()),
    maxHp: v.number(),
    ac: v.optional(v.number()),
    initiativeBonus: v.optional(v.number()),
    /** Uploaded art wins over the map-server path, as NPCs do. */
    portraitId: v.optional(v.id("_storage")),
    portraitPath: v.optional(v.string()),
    notes: v.optional(v.string()), // GM-visible only
    /**
     * Still at the table. ABSENT MEANS ACTIVE — every row predates the
     * field — so read it through isActive() in components/rosterModel,
     * never as a truthiness test. `false` is the only meaningful value.
     *
     * Not a delete: someone who left is still in the session log for
     * the nights they played, and their character keeps its portrait
     * and its history. The flag only stops the name being offered.
     */
    active: v.optional(v.boolean()),
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
   * GM-only fields — `dmNotes`, `secret`, and the `hidden` flag itself —
   * are stripped server-side in npcs.listForCampaign for non-GM callers,
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

    /**
     * Who added this NPC, when it was not the GM.
     *
     * Players can create NPCs — someone the party met that the GM has
     * not written down yet — and the creator may keep editing the
     * ordinary fields on the one they made. Absent on every NPC the GM
     * created and on everything imported from Airtable, which is why it
     * is optional and why "no creator" must never read as "anyone may
     * edit this": updateNpc checks for the GM first.
     */
    createdBy: v.optional(v.id("users")),

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

    // GM-only — never sent to players (see npcs.listForCampaign)
    hidden: v.boolean(),
    dmNotes: v.optional(v.string()),
    secret: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  /**
   * One night at the table: what happened, who was there, and the notes.
   *
   * The row here is the table's row — number, date, attendance, XP, a
   * one-line description. The NOTES are boxes, in sessionBoxes, because
   * they are a notebook page rather than a text field: formatted text,
   * images and tables, arranged where you put them.
   *
   * `players` is free text, deliberately. Attendance is who was in the
   * room, which is not the same as the campaign's membership rows — a
   * friend who dropped in for one night was never a member, and a member
   * who missed three sessions is still one.
   *
   * `number` is not unique at the database level and is not meant to be
   * a key: two sessions numbered 7 is a mistake worth being able to make
   * and then fix, not one worth refusing a save over.
   */
  sessions: defineTable({
    campaignId: v.id("campaigns"),
    number: v.number(),
    /** ISO "YYYY-MM-DD", so it sorts as a string as well as reads as one. */
    date: v.optional(v.string()),
    players: v.array(v.string()),
    xp: v.optional(v.number()),
    /**
     * The level the party reached THIS session, in a milestone
     * campaign. Its own field beside `xp` rather than a reuse of it:
     * a campaign switched between the two modes keeps both histories,
     * and "Level 5" stored in a field called xp is a trap for every
     * future reader.
     */
    milestone: v.optional(v.number()),
    description: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  /**
   * A session's notes, as notebook boxes on one of two sides.
   *
   * The same shape as notebookBoxes and drawn by the same canvas, with
   * one field the notebook has no use for: `side`, which is the TAB
   * this box is on. Three tabs are built in — the shared player page,
   * the GM's notes, and the GM's prep — and a session may carry as many
   * more as anybody makes; see sessionTabs below.
   *
   * A GM-only tab must never leave the server for a player — see
   * sessions.getNotes.
   *
   * Still called `side` because that is what is written in every row
   * already imported. Renaming the column would be a migration over
   * Moonbrook's whole history for a word, and the word is not wrong: a
   * tab is which side of the screen you are writing on.
   *
   * A separate table rather than a `side` bolted onto notebookBoxes,
   * because the two have different OWNERS. A notebook box belongs to one
   * person and being the GM grants nothing over it; a session box
   * belongs to the campaign. Sharing a table would mean every notebook
   * query carrying a filter to keep the two apart, and a filter that is
   * forgotten once is a privacy bug rather than a rendering one.
   */
  sessionBoxes: defineTable({
    sessionId: v.id("sessions"),
    /**
     * Which tab: a built-in key ("player", "dm", "prep") or the id of a
     * sessionTabs row, as a string.
     *
     * A string rather than a union, because the set is no longer
     * closed. What keeps a made-up value out is not this validator but
     * sessions.resolveTab, which every write goes through and which
     * answers with the tab's VISIBILITY — a check a literal union never
     * made in the first place.
     */
    side: v.string(),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("table")),

    x: v.number(),
    y: v.number(),
    w: v.number(),
    h: v.number(),
    order: v.number(),

    html: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    rotate: v.optional(v.number()),
    borderW: v.optional(v.number()),
    borderColor: v.optional(v.string()),

    rows: v.optional(v.array(v.array(v.string()))),
    colWidths: v.optional(v.array(v.number())),
    rowHeights: v.optional(v.array(v.number())),
    align: v.optional(
      v.union(v.literal("left"), v.literal("center"), v.literal("right"))
    ),
    borderless: v.optional(v.boolean()),
    shading: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    // So a player's request can ask for ONE TAB at a time, and only for
    // the tabs they may see. Fetching the session's boxes and dropping
    // the GM's would mean those were read out of the database on a
    // player's behalf, one forgotten filter away from the wire.
    .index("by_session_side", ["sessionId", "side"]),

  /**
   * The page a session's notes are written ON.
   *
   * The boxes above are things you PLACE — a picture over here, a table
   * over there. This is the document underneath them: click it and
   * type, the way you would in any other editor. Reported as exactly
   * that, and it was the right report — having to add a text box before
   * you could write a sentence made a page of notes into a layout
   * exercise.
   *
   * Its own table rather than two more fields on `sessions`, for the
   * one reason the boxes are their own table too: a GM-only tab must be
   * withheld by NOT BEING QUERIED. Fields on the session row would be
   * read into memory on a player's request — the row is fetched to
   * check the campaign — and the whole guarantee would drop from "the
   * server never asked for it" to "the server asked for it and then
   * remembered to drop it". `by_session_side` keeps the strong version.
   */
  sessionPages: defineTable({
    sessionId: v.id("sessions"),
    /** Which tab. Same keys as sessionBoxes.side. */
    side: v.string(),
    html: v.string(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_side", ["sessionId", "side"]),

  /**
   * The tabs a session's notes are kept on, past the three built in.
   *
   * Asked for as one sentence: a GM Prep tab only the GM can see, and
   * new tabs anybody can make. The first is a built-in — it is on every
   * session whether or not anyone has written on it, so it needs no row
   * — and the rest are these.
   *
   * `dmOnly` is the whole point of the row and the reason for the
   * second index. A hidden tab's TITLE is a secret like its contents:
   * "Who the traitor is" gives the game away with no boxes on it at
   * all. So a player's request does not read the hidden rows and then
   * drop them — `by_session_dmOnly` asks for dmOnly === false and the
   * hidden titles are never fetched. Same rule the boxes have always
   * run on, one level up.
   *
   * `createdBy` is who may rename and delete it, alongside the GM. A
   * player who makes a tab for the party's shopping list owns that tab;
   * they do not own the GM's.
   *
   * A tab is not a document with a body. Its boxes and its page live in
   * sessionBoxes and sessionPages keyed by `side`, exactly as the
   * built-in tabs' do, so nothing about drawing a page had to learn
   * that custom tabs exist.
   */
  sessionTabs: defineTable({
    sessionId: v.id("sessions"),
    title: v.string(),
    dmOnly: v.boolean(),
    /** Position after the built-ins. Ties break by creation time. */
    order: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_session", ["sessionId"])
    // The narrow one: a non-GM request never asks for the hidden rows,
    // so it never holds a hidden tab's title.
    .index("by_session_dmOnly", ["sessionId", "dmOnly"]),

  /**
   * What a group IS, as opposed to who is in it.
   *
   * Membership is NOT here. An NPC carries `groups: string[]`, typed by
   * hand in Airtable long before this table existed, and that is still
   * where "who is in the Mining Guild" is written down. A row here adds
   * the things a name cannot carry — a description, and pictures —
   * keyed by that name.
   *
   * Which means the Groups screen lists more rows than this table has:
   * every name any NPC carries is a group whether or not anybody has
   * written it up, and a screen that showed only the described ones
   * would be empty on a roster full of groups. See groups.ts.
   *
   * `name` is not unique at the database level, because nothing here
   * can enforce it — createGroup and renameGroup check, which is where
   * a duplicate can actually be refused with something to say.
   */
  groups: defineTable({
    campaignId: v.id("campaigns"),
    name: v.string(),
    description: v.optional(v.string()),
    /** Uploaded images, in order. Deleted from storage with the row. */
    attachmentIds: v.optional(v.array(v.id("_storage"))),
  }).index("by_campaign", ["campaignId"]),

  /**
   * Per-person app settings. One document per user, all of it personal.
   *
   * Note what is NOT here: whether you are a GM. That is structural —
   * you are the GM of a campaign iff campaign.dmId is your userId — and
   * it must stay that way. A self-settable role flag would let any
   * player grant themselves every secret and GM note in the campaign.
   *
   * `viewAsPlayer` is the safe inverse: a GM asking the server to treat
   * them as a player so they can see exactly what the table gives away.
   * It only ever removes access, so it is fine to let the caller set it.
   */
  /**
   * The GM Screen's live arrangement: one row per person per campaign.
   *
   * `layout` is JSON, deliberately unvalidated here — the window model
   * keeps changing shape, and a validator would turn every tweak into
   * a migration of a personal preference blob. components/dmscreen.ts
   * owns the shape and its parseLayout trusts nothing on the way in.
   * Per person rather than per campaign, so an admin opening a broken
   * campaign does not sit in — or overwrite — the GM's arrangement.
   */
  dmScreens: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
    layout: v.string(),
  }).index("by_campaign_user", ["campaignId", "userId"]),

  /**
   * Named copies of a GM Screen arrangement — Premiere's workspaces.
   * Saving one snapshots the live layout; loading one copies it back.
   */
  dmWorkspaces: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
    name: v.string(),
    layout: v.string(),
  }).index("by_campaign_user", ["campaignId", "userId"]),

  /**
   * The rich text behind a note window.
   *
   * Documents of their own rather than text inside the layout, because
   * workspaces snapshot the LAYOUT: prep written into a note must
   * survive switching workspaces, and a note inlined in the snapshot
   * would quietly fork into as many copies as there are workspaces.
   */
  dmNotes: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
    title: v.string(),
    html: v.string(),
  }).index("by_campaign_user", ["campaignId", "userId"]),

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
    /**
     * How dates read on screen. Personal, because the same session is on
     * 9/5 or 5/9 depending on who is looking. Mirrors DATE_FORMATS in
     * components/campaignCard.ts.
     */
    dateFormat: v.optional(
      v.union(
        v.literal("dmy"),
        v.literal("mdy"),
        v.literal("numeric"),
        v.literal("iso")
      )
    ),
    /**
     * Books switched off in Settings, by their full NAME.
     *
     * The name rather than the abbreviation, because eight books in
     * components/sourceNames.ts answer to two codes apiece and a
     * ninth may answer to a third tomorrow. Storing "Elemental Evil
     * Player's Companion" keeps it switched off however a row spells
     * it; storing "EEPC" would let the same book back in under "EE".
     *
     * Personal, like the theme: what you want to read from is not a
     * fact about the campaign.
     */
    excludedSources: v.optional(v.array(v.string())),
    /**
     * The sidebar as this person arranged it: their sections, their
     * order, and what they hid. Personal, like the toolbar — it is a
     * view of the app rather than a fact about the campaign.
     *
     * Absent means "never touched it", which is not the same as an
     * empty one and is why this is optional rather than defaulted.
     * components/sidebarLayout.ts reconciles it against what the app
     * actually has, so a tool shipped since cannot be unreachable.
     */
    sidebar: v.optional(
      v.object({
        sections: v.array(
          v.object({
            id: v.string(),
            title: v.string(),
            /**
             * Folded up, and shown only to the GM. Both are optional
             * because both are rare, and because a validator that
             * demanded them would reject every sidebar saved before
             * they existed.
             */
            dmOnly: v.optional(v.boolean()),
            collapsed: v.optional(v.boolean()),
            items: v.array(
              v.object({
                id: v.string(),
                hidden: v.boolean(),
                /**
                 * Folded away, hiding this item's own sub-screens.
                 * Optional for the same reason the two above are: a
                 * sidebar saved before sub-items existed has no
                 * opinion, and a required field would reject it.
                 */
                collapsed: v.optional(v.boolean()),
                /**
                 * LEGACY, read by nothing. `collapsed` used to be
                 * called `expanded` and mean the opposite; a Convex
                 * object validator is strict, so rows still carrying
                 * the old key would fail to validate and `convex dev`
                 * would refuse to push — the app does not start.
                 * reconcileSidebar drops it, so rows heal themselves
                 * the first time the sidebar is saved.
                 */
                expanded: v.optional(v.boolean()),
              })
            ),
          })
        ),
      })
    ),
    /**
     * The whole sidebar folded to a rail of icons — Airtable's arrow
     * button. Stored like the section folds and for the same reason:
     * walking between screens remounts the shell, and a collapse kept
     * in component state would spring open on every navigation.
     */
    sidebarCollapsed: v.optional(v.boolean()),
    /**
     * How many rows every table shows per page. One of 10/20/30/40/50
     * — the mutation holds it to that set, and the client clamps it
     * again on the way out (components/pagerModel.ts), so a stray write can
     * never make a table load everything or nothing.
     */
    tableRows: v.optional(v.number()),
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

  /**
   * The rules text, in searchable sections — what Rules Lawyer reads.
   *
   * Derived reference data like spells and items: no write path, no
   * campaign, replaced wholesale by re-importing. Shared across every
   * campaign, because a rule is a rule in both of Derek's games.
   *
   * `text` is what a person reads; `search` is that plus the heading
   * and its trail, so "grappled condition" finds the Grappled section
   * even though "condition" appears only in the heading above it. Two
   * fields rather than one because a search index matches a single
   * field, and folding the breadcrumb into the displayed text would
   * put it on screen twice.
   */
  rules: defineTable({
    /** "SRD 5.2" — which document this came from, shown with the rule. */
    source: v.string(),
    title: v.string(),
    /** "Rules Glossary > Conditions", the headings above this one. */
    breadcrumb: v.string(),
    text: v.string(),
    search: v.string(),
    /** Position in the document, so results can be read in book order. */
    order: v.number(),
  })
    .index("by_source_order", ["source", "order"])
    // Resolving a section from its NAME rather than its id. Pins and
    // cached citations outlive the rows they point at — `--replace`
    // mints new ids for every section on every import — so they are
    // stored by name and looked up here. Title is not unique within a
    // source ("Actions" appears under several headings), so a lookup
    // takes the small set this returns and matches the breadcrumb.
    .index("by_source_title", ["source", "title"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["source"],
    })
    .searchIndex("search_text", {
      searchField: "search",
      filterFields: ["source"],
    }),

  /**
   * The sections one person keeps coming back to.
   *
   * Per-user and NOT per-campaign, for the reason the Rules Lawyer
   * route already gives for taking no campaignId: the rules are the
   * rules in every campaign, so the conditions you look up every
   * session are the same ones in both of Derek's games.
   *
   * Stored by NAME, never by `_id`. The rules table is derived
   * reference data with no write path — re-importing replaces every
   * row and mints new ids — so a pin holding an id would be a dangling
   * pointer the first time the SRD is re-imported. A pin whose section
   * genuinely went away survives as a row and is shown as missing
   * rather than dropped, because a pin vanishing silently is
   * indistinguishable from a bug.
   */
  rulePins: defineTable({
    userId: v.id("users"),
    source: v.string(),
    breadcrumb: v.string(),
    title: v.string(),
  })
    .index("by_user", ["userId"])
    // The uniqueness check on pinning, and the row to delete on
    // unpinning: one identity per user, so toggling cannot leave two.
    .index("by_user_section", ["userId", "source", "breadcrumb", "title"]),

  /**
   * Answers already paid for.
   *
   * The AI layer is the one part of this app that costs money per use,
   * and a table asks the same dozen questions every session — "how does
   * grappling work", "can I move after attacking". Keyed on the
   * normalised question plus the source filter, so the second person to
   * ask it that night is served from here for nothing.
   *
   * Citations are stored by name for the same reason pins are. There is
   * no write path from the client: only the action that paid for an
   * answer inserts one.
   */
  ruleAnswers: defineTable({
    /** Normalised question + source — see rules.answerKey. */
    key: v.string(),
    question: v.string(),
    /** The source filter in force, or null for "all". */
    source: v.union(v.string(), v.null()),
    answer: v.string(),
    citations: v.array(
      v.object({
        /**
         * The bracketed number as it appears in the answer text.
         *
         * Stored, not derived from position: only the CITED passages
         * are kept, so an answer citing [2] and [5] has two entries and
         * neither is at the index its number implies. Without this the
         * screen would link [5] to the wrong section.
         */
        n: v.number(),
        source: v.string(),
        breadcrumb: v.string(),
        title: v.string(),
        order: v.number(),
      })
    ),
    /** Which model wrote it, so a re-run after a model change is visible. */
    model: v.string(),
  }).index("by_key", ["key"]),

  /**
   * ── The character-build half of the library ───────────────────────
   *
   * Feats, backgrounds, classes and species. Same rules as the three
   * above: campaign-agnostic, no write path, loaded by `npx convex
   * import`, and emptied by scripts/clear-lookup.mjs when their shape
   * changes.
   *
   * Every one of them carries `source`, and that is not decoration —
   * it is what the 5e/5.5e rule reads. `applyEdition` groups by name
   * and keeps the printing whose book matches the campaign's edition,
   * so a 2024 Alert and a 2014 Alert become one row. A table without
   * `source` would show both and there would be no way to tell them
   * apart.
   *
   * The fields are deliberately shallow. What a feat or a background
   * actually SAYS lives in `blocks`, like everything else here; the
   * columns exist to sort and filter by, not to reproduce the entry.
   * A field Foundry does not reliably carry is better absent than
   * present and empty on nine rows in ten.
   */
  feats: defineTable({
    name: v.string(),
    image: v.optional(v.string()),
    /** Origin | General | Fighting Style | Epic Boon — 2024's grouping. */
    category: v.optional(v.string()),
    /** "Level 4+, Strength 13" — free text, as the book writes it. */
    prerequisite: v.optional(v.string()),
    /** Can be taken more than once. */
    repeatable: v.optional(v.boolean()),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["category"],
    }),

  backgrounds: defineTable({
    name: v.string(),
    image: v.optional(v.string()),
    /** "Dex, Int, Cha" — the three the 2024 backgrounds raise. */
    abilities: v.optional(v.string()),
    /** The origin feat it grants, by name. */
    feat: v.optional(v.string()),
    skills: v.optional(v.string()),
    tools: v.optional(v.string()),
    equipment: v.optional(v.string()),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", { searchField: "name" }),

  /**
   * Classes AND subclasses, in one table.
   *
   * A subclass is not a peer of a class, it is part of one — nobody
   * looks up "Champion" without meaning the Fighter. Two tables would
   * mean two screens and a Champion you could only find by knowing
   * which of them to open. `isSubclass` and `parentClass` are what the
   * filter and the column read.
   */
  classes: defineTable({
    name: v.string(),
    image: v.optional(v.string()),
    isSubclass: v.boolean(),
    /** The class identifier a subclass belongs to; absent on a class. */
    parentClass: v.optional(v.string()),
    /** "d10" — written as it is spoken, not as a number. */
    hitDie: v.optional(v.string()),
    primaryAbility: v.optional(v.string()),
    /** The two saving throws a class is proficient in. */
    saves: v.optional(v.string()),
    /** Full | Half | Third | Pact — absent when it does not cast. */
    spellcasting: v.optional(v.string()),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["parentClass"],
    }),

  species: defineTable({
    name: v.string(),
    image: v.optional(v.string()),
    size: v.optional(v.string()),
    /** "30 ft" — walking speed, as the entry writes it. */
    speed: v.optional(v.string()),
    /** Humanoid, almost always — but not on every species. */
    creatureType: v.optional(v.string()),
    /** Range in feet, as a number so it sorts and filters as one. */
    darkvision: v.optional(v.number()),
    blocks: v.optional(v.array(blockValidator)),
    source: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .searchIndex("search_name", { searchField: "name" }),

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
   * the GM put it whatever size the image is displayed at, and survives
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

    // GM-only — never sent to players (see locations.listForCampaign)
    hidden: v.boolean(),
    dmNotes: v.optional(v.string()),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_parent", ["parentId"]),

  /**
   * The campaign's calendar. One document per campaign, GM-owned.
   *
   * Every month is the same length, because `daysPerMonth` is one
   * number — months of differing lengths are a different data model and
   * nothing asked for one. The name lists are resized to their counts
   * on every save (see components/calendarModel.ts): a five-day week
   * with seven day names is a grid whose header doesn't line up with
   * its columns.
   */
  /**
   * The days and hours the GM has offered for the next session.
   *
   * One row per campaign: this is "when are we playing next", not a
   * calendar of proposals, and a second open poll would only ever
   * split the answers between them.
   *
   * The days are REAL dates, unlike everything else in the campaign —
   * nobody schedules a game for the 10th of Autumn. Times are minutes
   * from midnight so they sort and compare as numbers.
   */
  schedules: defineTable({
    campaignId: v.id("campaigns"),
    /** ISO "YYYY-MM-DD". */
    days: v.array(v.string()),
    startMinute: v.number(),
    endMinute: v.number(),
    slotMinutes: v.number(),
  }).index("by_campaign", ["campaignId"]),

  /**
   * One person's answer: the cells they marked.
   *
   * Stored as slot keys ("2026-08-25T540") rather than a row per cell,
   * because a person's availability is edited as a whole — dragging
   * across an afternoon is one save, not sixteen inserts — and is only
   * ever read alongside everyone else's.
   *
   * A row that exists with an empty list is a person who answered
   * "none of these", which is a different fact from not having
   * answered. The Scheduler reports both, so the distinction has to
   * survive: never delete a row to mean "cleared".
   */
  availability: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
    slots: v.array(v.string()),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_user", ["campaignId", "userId"]),

  /**
   * Notes on an NPC — a thread of them, not one text field.
   *
   * Two channels. `player` is the table's shared pad: anyone in the
   * campaign writes there and everyone reads it. `dm` is the GM's, and
   * is never sent to anyone else — the query filters it out server-side
   * rather than the client hiding it, like every other GM-only thing
   * here.
   *
   * The body is sanitised HTML. It is written by one member and
   * rendered in another's browser, so it is rebuilt from an allowlist
   * in the mutation — see components/noteFormat.ts. Images are storage
   * ids on the note rather than markup in it, so the body never carries
   * a URL.
   *
   * `authorId` is who may edit or delete it. Not the GM, not the
   * campaign owner: the person who wrote it.
   */
  npcNotes: defineTable({
    campaignId: v.id("campaigns"),
    npcId: v.id("npcs"),
    authorId: v.id("users"),
    channel: v.union(v.literal("player"), v.literal("dm")),
    body: v.string(),
    imageIds: v.optional(v.array(v.id("_storage"))),
    /** Set on every edit after the first save. */
    editedAt: v.optional(v.number()),
  })
    .index("by_npc", ["npcId"])
    .index("by_campaign", ["campaignId"]),

  /**
   * How an opened NPC is laid out, for the whole campaign.
   *
   * One row per campaign, written by the GM, read by everyone: the
   * point is that every record in the campaign reads the same way, so
   * a per-person version would defeat it. Which FIELDS a given person
   * actually receives is still the server's decision — a template
   * naming dmNotes does not send dmNotes to a player.
   *
   * Only the arrangement is stored. What a field is, and whether it is
   * GM-only, stays in components/npcColumns.ts, and
   * components/npcTemplate.ts reconciles a stored template against it
   * on the way in and out.
   */
  npcTemplates: defineTable({
    campaignId: v.id("campaigns"),
    tabs: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        fields: v.array(
          v.object({
            key: v.string(),
            /** 1–4 columns of the record's grid. */
            span: v.number(),
            /**
             * 1–6 rows of the record's grid.
             *
             * Optional because documents written before two-axis
             * resizing exist and are still valid — but note that this
             * validator went missing for a while AFTER saveTemplate
             * started writing the field, which made every save of a
             * layout fail validation at write time. The guard in
             * tests/guards/integrity.mjs now compares the two.
             */
            rows: v.optional(v.number()),
            /**
             * Hidden fields stay IN the template rather than being
             * removed from it. A field the template does not mention
             * is one reconcileTemplate puts back under "More" on the
             * next load, so removal is not a way to hide anything —
             * and a hidden field you cannot find is a field you cannot
             * un-hide.
             */
            hidden: v.optional(v.boolean()),
          })
        ),
      })
    ),
  }).index("by_campaign", ["campaignId"]),

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
    /** The era in words — "The Age of Embers". Absent where unnamed. */
    ageName: v.optional(v.string()),
    /** The era inside a date — the "AE" of "AE 744". */
    eraAbbr: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  /**
   * Things that happen on a day of the campaign calendar.
   *
   * The date is stored as the campaign's OWN year/month/day rather than
   * a timestamp: these are in-world dates in a calendar with invented
   * months and a week that is not seven days long, and there is no
   * real-world instant they correspond to.
   *
   * A repeating event is one row plus a rule, not a row per occurrence.
   * A yearly festival in a campaign that runs for centuries would
   * otherwise be thousands of rows nobody ever reads, and moving it
   * would mean rewriting all of them. components/calendarModel.ts
   * decides what lands on a given day.
   */
  calendarEvents: defineTable({
    campaignId: v.id("campaigns"),
    title: v.string(),
    notes: v.optional(v.string()),
    year: v.number(),
    /** 0-based, indexing monthNames, as the calendar stores months. */
    month: v.number(),
    /** 1-based, the way a person says a date. */
    day: v.number(),
    repeat: v.union(
      v.literal("once"),
      v.literal("weekly"),
      v.literal("monthly"),
      v.literal("yearly"),
      v.literal("everyNDays")
    ),
    /** Only read when repeat is "everyNDays". */
    intervalDays: v.optional(v.number()),
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
  })
    .index("by_user_campaign_view", ["userId", "campaignId", "view"])
    // Keyed by user first above, so deleting a campaign could not find
    // its rows without this second way in.
    .index("by_campaign", ["campaignId"]),

  /**
   * Chat channels for a campaign.
   *
   * Visibility is a property of the channel, checked server-side on
   * every read and every send:
   *   everyone — any member of the campaign
   *   dmOnly   — only the GM (and an admin with the override active)
   *   private  — the GM plus the listed members, for whispering to one
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
    /** For `private` channels; the GM always has access regardless. */
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
    .index("by_parent", ["parentId"])
    // Same reason as viewPrefs: a notebook belongs to one person, so
    // nothing else could enumerate a campaign's notebooks to delete them.
    .index("by_campaign", ["campaignId"]),

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
  // Every player client subscribes to this; the GM app mutates it.
  tableState: defineTable({
    campaignId: v.id("campaigns"),
    activeMapId: v.optional(v.id("maps")),
    activeEncounterId: v.optional(v.id("encounters")),
    showGrid: v.boolean(),
    // Freeform GM broadcast line, e.g. "Roll perception" / "Short rest"
    banner: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  encounters: defineTable({
    campaignId: v.id("campaigns"),
    name: v.string(), // "Sky Temple — lightning rooftop"
    status: v.union(
      v.literal("prep"), // GM building it; invisible to players
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
    // Stable tiebreak for equal initiative (GM sets; default 0)
    tiebreak: v.number(),
    maxHp: v.number(),
    currentHp: v.number(),
    tempHp: v.number(),
    ac: v.optional(v.number()),
    conditions: v.array(v.string()), // "prone", "restrained", ...
    concentrating: v.optional(v.string()), // spell name, if any
    // Visibility controls (the GM-vs-player split):
    hidden: v.boolean(), // not yet revealed — players don't see it at all
    showHpToPlayers: v.boolean(), // false → players see status bucket only
    dmNotes: v.optional(v.string()), // never sent to players
  }).index("by_encounter", ["encounterId"]),

  /**
   * What edit mode changed about the interface, for one campaign.
   *
   * Per campaign rather than per person: renaming "Player Notes" to
   * "Table Notes" is a decision about this game's table, and one that
   * only reached the GM's own browser would leave everyone else reading
   * different words for the same box. The GM writes it; everyone reads
   * it, the way the NPC template already works.
   *
   * Ids are free strings and are NOT validated against the registry
   * here — convex/ and components/ are separate compilations. The
   * client drops any id it does not know, which is the same thing
   * normalizeRibbon does with a retired toolbar token.
   */
  uiOverrides: defineTable({
    campaignId: v.id("campaigns"),
    text: v.array(v.object({ id: v.string(), value: v.string() })),
    layout: v.array(v.object({ id: v.string(), value: v.number() })),
  }).index("by_campaign", ["campaignId"]),

  /**
   * The GM's prep list.
   *
   * Campaign-scoped and the GM's alone — convex/todo.ts refuses a
   * non-GM caller outright rather than shaping the rows, because
   * unlike an NPC or a location there is no player-facing version of
   * this. "Statblock for the lich" is not a thing to show a player a
   * redacted copy of; it is a thing they must not know exists.
   *
   * A player-facing list is planned as its OWN table rather than a
   * flag on this one. Bolting a `visibility` field here would make
   * every query in the tool answer "which rows may this caller see",
   * which is the question this design exists to avoid asking.
   */
  todos: defineTable({
    campaignId: v.id("campaigns"),
    text: v.string(),
    done: v.boolean(),
    /**
     * Sort key, not an index. Moving one item rewrites one row rather
     * than renumbering the list — see components/todoModel.ts, which
     * owns the arithmetic and the rare case where a gap runs out.
     */
    order: v.number(),
    /** "YYYY-MM-DD". Compared as a string, so it has no timezone. */
    due: v.optional(v.string()),
    notes: v.optional(v.string()),
    /** When it was ticked, so finished items sort newest-first. */
    doneAt: v.optional(v.number()),
    /**
     * Where this came from.
     *
     * The eventual point: tag a line in a session's notes as a to-do
     * and the item carries a way back to the sentence that caused it.
     * `tool` is the nav item's id, so the chip can say "Sessions"
     * without storing the word.
     *
     * `href` is validated against the app's one internal-link rule on
     * the way in — these arrive from other TOOLS rather than from a
     * person typing, and a tool with a bug writes a bad URL just as
     * readily as a person does.
     */
    links: v.optional(
      v.array(
        v.object({ tool: v.string(), label: v.string(), href: v.string() })
      )
    ),

    /* ---- the Vikunja shape ------------------------------------------
     *
     * Four fields, all optional, all absent on every item written
     * before them. That is the design rather than an accident of
     * migration: a prep list has to work when you have filed nothing,
     * labelled nothing and set no priorities, because that is what the
     * first twenty seconds with it look like.
     */

    /**
     * Which project it is filed under. Absent is the Inbox — Vikunja
     * makes that a real project you cannot delete; here it is simply
     * the items that have no projectId, which cannot get out of step
     * with itself the way a magic row can.
     */
    projectId: v.optional(v.id("todoProjects")),
    /**
     * 1–5, Vikunja's scale: Low, Medium, High, Urgent, DO NOW. Absent
     * is "unset", which is not the same as Low — most tasks have no
     * priority and a list where everything is Low says nothing.
     *
     * Only High and above is drawn, which is Vikunja's rule too.
     */
    priority: v.optional(v.number()),
    /** Labels, by id. Cleaned server-side against this campaign's own. */
    labelIds: v.optional(v.array(v.id("todoLabels"))),
    /** Starred. Vikunja's Favorites pseudo-project, as a flag. */
    favorite: v.optional(v.boolean()),
  })
    .index("by_campaign", ["campaignId"])
    // Reading one project's list without reading the campaign's whole
    // list and throwing most of it away.
    .index("by_project", ["projectId"]),

  /**
   * A project: one list of tasks inside the campaign's prep.
   *
   * Vikunja's top-level container, and the reason the tool needs a
   * navigation of its own — "Session prep", "Worldbuilding", "Between
   * sessions" are different lists that want reading separately.
   *
   * Deliberately FLAT. Vikunja nests projects inside projects, which
   * earns its keep for a team tracking a product and costs a GM a tree
   * to maintain instead of a list to read.
   */
  todoProjects: defineTable({
    campaignId: v.id("campaigns"),
    title: v.string(),
    /**
     * A palette id — "amber", "sage" — never a colour. The client puts
     * this into a style, so what is stored has to be something the
     * client LOOKS UP rather than something it passes through; an
     * arbitrary string in that position is a hole with a CSS shape.
     * components/todoModel.ts owns the palette and the server checks
     * against it.
     */
    color: v.optional(v.string()),
    order: v.number(),
    /**
     * Out of the way without being gone. A campaign arc that finished
     * is not a project you want to delete — its tasks are the record
     * of what you prepared — and it is not one you want in the sidebar
     * either.
     */
    archived: v.optional(v.boolean()),
  }).index("by_campaign", ["campaignId"]),

  /**
   * A label. Vikunja's cross-cutting tag: "combat", "handout", "buy".
   *
   * Separate from projects because they answer different questions —
   * a project is WHICH LIST, a label is WHAT KIND — and a task has one
   * of the first and any number of the second.
   */
  todoLabels: defineTable({
    campaignId: v.id("campaigns"),
    title: v.string(),
    /** A palette id, checked server-side. See todoProjects.color. */
    color: v.string(),
  }).index("by_campaign", ["campaignId"]),

  /* ---- dice ---- */

  /**
   * The table's roll log.
   *
   * The dice are thrown on the SERVER (convex/dice.ts) and the faces
   * stored, so the log is a record rather than a claim — a client that
   * rolled for itself could post a 20 every time.
   *
   * `secret` is the GM's private roll. It is filtered out of listRolls
   * for everyone else rather than hidden in the UI, so a player cannot
   * learn that a roll happened at all.
   */
  diceRolls: defineTable({
    campaignId: v.id("campaigns"),
    userId: v.id("users"),
    /** Normalised notation, as re-written by the parser. */
    notation: v.string(),
    /** What the roll was for — "Stealth", "Fireball". Optional. */
    label: v.optional(v.string()),
    /**
     * Every face rolled, dropped ones included: seeing the 2 you threw
     * away is half the point of 4d6kh3.
     */
    dice: v.array(
      v.object({
        sides: v.number(),
        value: v.number(),
        kept: v.boolean(),
        /**
         * Which term threw it. "8d6+4d4" is twelve faces in one list
         * and nothing else says where the d6s stop. Optional because
         * rows written before this field exist; groupDice falls back
         * to runs of one die size for those.
         */
        t: v.optional(v.number()),
      })
    ),
    /**
     * The flat modifier, all of it, signed. Stored rather than re-read
     * out of the notation so the log needs no parser of its own — and
     * without it the "+3" of "8d6+4d4+3" appears nowhere on screen.
     */
    mod: v.optional(v.number()),
    total: v.number(),
    secret: v.boolean(),
  }).index("by_campaign", ["campaignId"]),

  /**
   * The campaign's dddice room, for the 3D dice.
   *
   * The passcode is here because a private room needs one to join and
   * the players' browsers are the things joining. It reaches a browser
   * only through a query that checks campaign membership first — the
   * same rule as everything else the server shapes. It is not an
   * account credential: it grants throwing dice in one room.
   *
   * No API key is stored. Each browser mints its own dddice guest
   * account, so Derek's key never leaves his machine.
   */
  diceRooms: defineTable({
    campaignId: v.id("campaigns"),
    /** The room's slug, from its dddice URL. */
    slug: v.string(),
    passcode: v.optional(v.string()),
    /** Theme slug for the dice, e.g. "dddice-bees". */
    theme: v.optional(v.string()),
    enabled: v.boolean(),
  }).index("by_campaign", ["campaignId"]),

  /* ---- Session Recorder -------------------------------------------
   *
   * One night at the table, recorded, transcribed and summarized.
   *
   * The audio is NOT here and never will be. Convex's free tier is a
   * gigabyte of file storage; four hours of Opus is about sixty
   * megabytes, so seventeen sessions would fill it and the eighteenth
   * would fail during a game. The audio lives on the PowerEdge beside
   * the battle maps, and what crosses into Convex is text — which is
   * both small and the part anything else in this app can use.
   *
   * `audioKey` is therefore a filename on that server, not a
   * storage id, and this table can name a recording whose file has
   * been deleted. That is a state the screen shows rather than one it
   * treats as corruption: a transcript outlives its audio on purpose.
   */
  recordings: defineTable({
    campaignId: v.id("campaigns"),
    /** What the GM calls it. Defaults to the date it was recorded. */
    title: v.string(),
    /**
     * The status machine in components/recorderModel.ts, as a string.
     *
     * A v.union of literals would be tighter, and is deliberately not
     * used: the value is also written by the home server through an
     * HTTP action, and a Convex object validator is strict, so a
     * server running a version this schema has not heard of would have
     * its POST rejected and the recording would sit in `transcribing`
     * for ever with no error anywhere. A string that fails the model's
     * own check renders as "unknown" instead, which is visible.
     */
    status: v.string(),
    /** What the server said when it gave up. Shown verbatim. */
    error: v.optional(v.string()),

    /** Epoch ms the recording started. Sorts the list. */
    startedAt: v.number(),
    /** Wall-clock seconds of audio, as the browser measured it. */
    durationSec: v.optional(v.number()),
    /** Bytes uploaded, so "did it all get there" has an answer. */
    bytes: v.optional(v.number()),

    /**
     * The file on the home server, relative to its recordings root.
     * Absent until the upload finishes; absent again if it is pruned.
     */
    audioKey: v.optional(v.string()),

    /**
     * WhisperX's tag for each voice, mapped to a name a person uses.
     *
     * Keyed by "SPEAKER_00" and friends, which is a key from outside
     * this app — see speakerName() in components/recorderModel.ts for
     * why every read of it goes through hasOwnProperty.
     */
    speakers: v.optional(v.record(v.string(), v.string())),
    /** How many segments the transcript came to, for the list row. */
    segmentCount: v.optional(v.number()),
    /** The language WhisperX detected, if it said. */
    language: v.optional(v.string()),

    /**
     * The generated notes, section by section, as
     * SUMMARY_SECTIONS in components/recorderModel.ts describes them.
     * Absent until somebody asks for a summary — the transcript costs
     * nothing to make and the summary is a paid API call, so the two
     * are separate states and not two halves of one.
     */
    summary: v.optional(
      v.object({
        recap: v.string(),
        beats: v.array(v.string()),
        decisions: v.array(v.string()),
        npcs: v.array(v.string()),
        loot: v.array(v.string()),
        threads: v.array(v.string()),
      })
    ),
    /** Which model wrote it, so notes from two eras are tellable apart. */
    summaryModel: v.optional(v.string()),
    summarizedAt: v.optional(v.number()),

    /** The session in the log this was the recording OF, once linked. */
    sessionId: v.optional(v.id("sessions")),
  })
    .index("by_campaign", ["campaignId"])
    // The home server posts back knowing only the id it was handed, so
    // there is nothing to look up by here — but a recording linked to a
    // session is looked up from the session's side.
    .index("by_session", ["sessionId"]),

  /**
   * The transcript, in rows of roughly 48 KB.
   *
   * Not one field on the recording: a Convex document is capped at a
   * megabyte and a four-hour transcript passes that. Splitting it also
   * keeps the reactive query cheap — renaming a speaker rewrites the
   * recording row, not the hour of text hanging off it.
   *
   * `index` is the order, assigned by the ingest and never reused.
   */
  transcriptChunks: defineTable({
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
    index: v.number(),
    segments: v.array(
      v.object({
        start: v.number(),
        end: v.number(),
        text: v.string(),
        speaker: v.optional(v.string()),
      })
    ),
  })
    .index("by_recording", ["recordingId", "index"])
    .index("by_campaign", ["campaignId"]),
});
