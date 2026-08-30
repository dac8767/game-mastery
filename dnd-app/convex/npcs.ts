import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { requireDm, requireMember, requireUser } from "./auth";
import { Id } from "./_generated/dataModel";
import {
  NOTE_LIMITS,
  isEmptyNote,
  sanitizeNoteHtml,
} from "../components/noteFormat";
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

    // A GM previewing the player view is served as a player, so the
    // preview is real: the withheld data genuinely never leaves the
    // server. Mutations still check actual GM status, so previewing
    // does not lock the GM out of editing.
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

    // The GM/player split, enforced here so the data physically never
    // leaves the server for a player:
    //   - `hidden` NPCs are dropped from the list entirely
    //   - `dmNotes` and `secret` come back null
    // The row shape stays uniform either way so the table can render one
    // set of columns; the GM-only columns are simply empty for players.
    // Resolving a storage URL is async, so the shaping runs in parallel
    // rather than sequentially per row.
    const npcs = await Promise.all(
      page
        .filter((n) => isDm || !n.hidden)
        .map(async (n) => ({
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
        // Resolved server-side so the client never handles storage ids.
        // An uploaded image wins over the legacy map-server path.
        portraitUrl: n.portraitId
          ? await ctx.storage.getUrl(n.portraitId)
          : null,

        // GM-only from here down.
        hidden: isDm ? n.hidden : false,
        dmNotes: isDm ? (n.dmNotes ?? null) : null,
        secret: isDm ? (n.secret ?? null) : null,
        }))
    );

    return {
      isDm,
      truncated,
      npcs,
    };
  },
});

/**
 * Optional text that the GM may also clear.
 *
 * `null` means "empty this field" and is translated to `undefined`
 * before the patch, because Convex removes a field patched with
 * `undefined` while `null` is not a legal value for `v.optional(...)`.
 */
const clearableText = v.optional(v.union(v.string(), v.null()));
const clearableNumber = v.optional(v.union(v.number(), v.null()));

/**
 * GM: edit any field on an NPC.
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

    // GM-only fields — reachable only through this GM-gated mutation.
    // `dmNotes` is deliberately not among them: it stopped being a
    // field on the record when the GM notes thread replaced it, and an
    // argument nothing sends is a way in nobody is watching.
    hidden: v.optional(v.boolean()),
    secret: clearableText,
  },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");

    /**
     * The GM, or the player who created this one.
     *
     * A player who can add an NPC but cannot type a name into it has
     * been given a button, not a feature. So the creator keeps writing
     * to the NPC they made — but only to the ORDINARY fields. The
     * GM-only three are refused below whoever asks, which is what keeps
     * "a player made this" from becoming "a player can write the GM's
     * notes on it".
     *
     * The GM check comes first and `createdBy` is only set for a
     * player's NPC, so "no creator" can never read as "anyone".
     */
    const { userId, isDm } = await requireMember(ctx, npc.campaignId);
    const isCreator = npc.createdBy !== undefined && npc.createdBy === userId;
    if (!isDm && !isCreator) {
      throw new Error("Only the GM can edit that NPC");
    }

    const { npcId, ...rest } = args;

    if (!isDm) {
      for (const key of DM_ONLY_FIELDS) {
        if (rest[key] !== undefined) {
          throw new Error("Only the GM can change that");
        }
      }
    }

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
 * The fields only the GM may write, named once.
 *
 * The same three the query strips on the way out, so the boundary reads
 * the same in both directions. Listed as a const rather than checked
 * inline because a fourth GM-only field added to the schema and not to
 * this list is a field a player could write — and that is exactly the
 * silent kind of failure the guards exist for, so integrity.mjs
 * compares this list against the GM-only columns.
 */
const DM_ONLY_FIELDS = ["hidden", "secret"] as const;

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
 * GM: add a new NPC to the campaign.
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
    const { userId, isDm } = await requireMember(ctx, args.campaignId);

    return await ctx.db.insert("npcs", {
      campaignId: args.campaignId,
      name: args.name?.trim() || "New NPC",
      noLastName: false,
      status: [],
      groups: [],
      familyMembers: [],
      place: [],
      /**
       * A GM's new NPC starts hidden — they decide when the table meets
       * them. A PLAYER's does not, and cannot: hidden NPCs are withheld
       * from players server-side, so one created hidden would vanish the
       * instant it was made, with no way for its author to reach it.
       */
      hidden: isDm,
      // Recorded only for a player's, so "no creator" stays unambiguous.
      createdBy: isDm ? undefined : userId,
    });
  },
});

/**
 * GM: delete an NPC, and everything hanging off it.
 *
 * GM-only even for an NPC a player created. Deleting is the one action
 * here that cannot be undone by the person it surprises, and a roster
 * everyone can delete from is a roster that quietly loses people.
 *
 * The notes and the portrait go with it. A note whose NPC is gone is
 * unreachable rather than deleted, and an orphaned portrait is a file
 * in storage nothing references and nothing will ever clean up.
 */
export const deleteNpc = mutation({
  args: { npcId: v.id("npcs") },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) return;
    await requireDm(ctx, npc.campaignId);

    const notes = await ctx.db
      .query("npcNotes")
      .withIndex("by_npc", (q) => q.eq("npcId", args.npcId))
      .collect();
    for (const note of notes) {
      for (const image of note.imageIds ?? []) {
        await ctx.storage.delete(image);
      }
      await ctx.db.delete(note._id);
    }

    if (npc.portraitId) await ctx.storage.delete(npc.portraitId);
    await ctx.db.delete(args.npcId);
  },
});

/**
 * GM: upload a portrait.
 *
 * Two steps, which is Convex's upload shape: mint a short-lived URL,
 * POST the file straight to storage, then hand the id back. The file
 * never passes through a mutation, so a large portrait can't blow the
 * argument size limit.
 */
export const generatePortraitUploadUrl = mutation({
  args: { npcId: v.id("npcs") },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");
    await requireDm(ctx, npc.campaignId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** GM: attach an uploaded image, or clear the portrait entirely. */
export const setPortrait = mutation({
  args: {
    npcId: v.id("npcs"),
    storageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");
    await requireDm(ctx, npc.campaignId);

    // Replacing a portrait drops the old file. Skipping this leaves an
    // image nothing references and nothing will ever clean up.
    if (npc.portraitId && npc.portraitId !== args.storageId) {
      await ctx.storage.delete(npc.portraitId);
    }

    await ctx.db.patch(args.npcId, {
      portraitId: args.storageId ?? undefined,
    });
  },
});

// ---------------------------------------------------------------------
// The record layout
// ---------------------------------------------------------------------

/**
 * How an opened NPC is laid out in this campaign.
 *
 * Lives here rather than in a module of its own because it is read
 * alongside the roster and written by the same authority. Returning
 * null where no row exists is deliberate: the client builds the
 * shipped arrangement from npcSections in that case, and a server-side
 * default would be a second copy of it.
 */
export const getTemplate = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    const row = await ctx.db
      .query("npcTemplates")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();
    return row ? { tabs: row.tabs } : null;
  },
});

/** Bounds matching components/npcTemplate.ts, enforced where it counts. */
const MAX_TABS = 12;
const MAX_TITLE = 40;

/**
 * GM: replace the campaign's layout.
 *
 * Sent whole rather than patched: the designer edits a draft and saves
 * it, and a per-move mutation would be one write per drag. The shape
 * is re-clamped here because a mutation is a public API — the client
 * clamp is so the form behaves, not a guarantee about what arrives.
 */
export const saveTemplate = mutation({
  args: {
    campaignId: v.id("campaigns"),
    tabs: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        fields: v.array(
          v.object({
            key: v.string(),
            span: v.number(),
            rows: v.optional(v.number()),
            hidden: v.optional(v.boolean()),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const tabs = args.tabs.slice(0, MAX_TABS).map((t, i) => ({
      id: t.id.slice(0, 64) || `tab-${i}`,
      title: t.title.trim().slice(0, MAX_TITLE) || `Tab ${i + 1}`,
      fields: t.fields.map((f) => ({
        key: f.key.slice(0, 64),
        span: Math.min(4, Math.max(1, Math.round(f.span) || 1)),
        rows: Math.min(6, Math.max(1, Math.round(f.rows ?? 1) || 1)),
        // Written only when true, so a visible field carries no key at
        // all rather than a `false` on every row of every layout.
        ...(f.hidden ? { hidden: true } : {}),
      })),
    }));

    const existing = await ctx.db
      .query("npcTemplates")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { tabs });
      return;
    }
    await ctx.db.insert("npcTemplates", { campaignId: args.campaignId, tabs });
  },
});

/** GM: go back to the arrangement the app ships with. */
export const resetTemplate = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const existing = await ctx.db
      .query("npcTemplates")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

// ---------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------

/**
 * The notes on one NPC.
 *
 * GM notes are filtered out SERVER-SIDE for anyone who is not the GM.
 * That is the rule the whole app runs on: a player's browser never
 * receives what it is not allowed to render, so there is nothing for a
 * devtools console to reveal.
 *
 * Author names come from the user documents rather than being stored on
 * the note, so renaming yourself renames you on everything you wrote.
 */
export const listNotes = query({
  args: { npcId: v.id("npcs") },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) return { notes: [], youId: null, isDm: false };

    const { userId, isDm: isCampaignDm } = await requireMember(
      ctx,
      npc.campaignId
    );
    const { viewAsPlayer } = await getSettings(ctx, userId);
    const isDm = isCampaignDm && !viewAsPlayer;

    const rows = await ctx.db
      .query("npcNotes")
      .withIndex("by_npc", (q) => q.eq("npcId", args.npcId))
      .take(NOTE_LIMITS.perThread * 2);

    const visible = rows.filter((n) => isDm || n.channel === "player");

    const names = new Map<string, string>();
    const out = [];
    for (const n of visible) {
      if (!names.has(n.authorId)) {
        const person = await ctx.db.get(n.authorId);
        names.set(n.authorId, person?.name ?? person?.email ?? "Someone");
      }
      out.push({
        _id: n._id,
        _creationTime: n._creationTime,
        channel: n.channel,
        body: n.body,
        editedAt: n.editedAt ?? null,
        authorId: n.authorId,
        authorName: names.get(n.authorId) ?? "Someone",
        // Resolved here because the client must never handle storage
        // ids directly, the same as portraits.
        images: (
          await Promise.all(
            (n.imageIds ?? []).map(async (id) => ({
              id,
              url: await ctx.storage.getUrl(id),
            }))
          )
        ).filter((img) => img.url),
      });
    }

    out.sort((a, b) => a._creationTime - b._creationTime);
    return { notes: out, youId: userId, isDm };
  },
});

const channelValidator = v.union(v.literal("player"), v.literal("dm"));

/** Only the GM may write in — or read — the GM channel. */
async function requireChannel(
  ctx: Parameters<typeof requireDm>[0],
  campaignId: Id<"campaigns">,
  channel: "player" | "dm"
) {
  if (channel === "dm") {
    await requireDm(ctx, campaignId);
    return;
  }
  await requireMember(ctx, campaignId);
}

export const addNote = mutation({
  args: {
    npcId: v.id("npcs"),
    channel: channelValidator,
    body: v.string(),
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");
    await requireChannel(ctx, npc.campaignId, args.channel);
    const userId = await requireUser(ctx);

    // Sanitised HERE, not in the editor. The editor's version is a
    // convenience; this one is the guarantee, because a hand-made call
    // never goes near the editor.
    const body = sanitizeNoteHtml(args.body);
    if (isEmptyNote(body) && (args.imageIds ?? []).length === 0) {
      throw new Error("A note needs something in it");
    }

    const existing = await ctx.db
      .query("npcNotes")
      .withIndex("by_npc", (q) => q.eq("npcId", args.npcId))
      .take(NOTE_LIMITS.perThread * 2);
    if (
      existing.filter((n) => n.channel === args.channel).length >=
      NOTE_LIMITS.perThread
    ) {
      throw new Error("That thread is full — tidy some notes up first");
    }

    return await ctx.db.insert("npcNotes", {
      campaignId: npc.campaignId,
      npcId: args.npcId,
      authorId: userId,
      channel: args.channel,
      body,
      imageIds: (args.imageIds ?? []).slice(0, NOTE_LIMITS.images),
    });
  },
});

/**
 * Move the old `dmNotes` FIELD into the GM notes thread.
 *
 * The record grew a GM Notes thread beside a `dmNotes` text field that
 * predated it, so the screen showed two things with the same name and
 * the same purpose. The field is the one that goes — a thread says who
 * wrote what and when, and a field is one box everybody overwrites.
 *
 * Run once per campaign. IDEMPOTENT: it only touches NPCs whose field
 * still has something in it, and clears the field as it goes, so a
 * second run does nothing rather than filing every note twice. That
 * matters more than usual here — the obvious way to check whether it
 * worked is to run it again.
 *
 * Nothing is deleted before it is copied. The clear happens in the
 * same transaction as the insert, so there is no window where the text
 * has left the field and is not yet a note.
 *
 * INTERNAL, and it takes no identity.
 *
 * It was a public GM-gated mutation run with `--identity`, which meant
 * the command to run it carried a YOUR_USER_ID placeholder — a
 * paste-ready line that is not actually paste-ready, and pasting it
 * gets "Unable to decode ID: Invalid ID length 12" from deep inside
 * the auth check. An internal function is not reachable from a
 * browser at all, so the gate it needed was the one thing making it
 * awkward to run.
 *
 * The notes are authored by the campaign's GM rather than by whoever
 * ran the command, which is also more correct: these are the GM's
 * notes, and they were the GM's before this moved them.
 */
export const migrateDmNotes = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Campaign not found");
    const userId = campaign.dmId;

    const npcs = await ctx.db
      .query("npcs")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();

    let moved = 0;
    let skipped = 0;

    for (const npc of npcs) {
      const raw = (npc.dmNotes ?? "").trim();
      if (!raw) continue;

      // The field was a PLAIN TEXTAREA and the thread stores HTML, so
      // the text is escaped rather than passed through. Anything with
      // a "<" in it would otherwise arrive as markup — and the one
      // thing worse than losing the note is silently rewriting it.
      const body = sanitizeNoteHtml(
        raw
          .split(/\n{2,}/)
          .map(
            (para) =>
              "<p>" +
              para
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\n/g, "<br>") +
              "</p>"
          )
          .join("")
      );

      if (isEmptyNote(body)) {
        // Whitespace and markup only. Clear it — it is not worth a
        // note and leaving it means the field never empties and the
        // migration never finishes.
        await ctx.db.patch(npc._id, { dmNotes: undefined });
        skipped++;
        continue;
      }

      const existing = await ctx.db
        .query("npcNotes")
        .withIndex("by_npc", (q) => q.eq("npcId", npc._id))
        .take(NOTE_LIMITS.perThread * 2);
      if (
        existing.filter((n) => n.channel === "dm").length >=
        NOTE_LIMITS.perThread
      ) {
        // A full thread is the one case where clearing WOULD lose the
        // text, so this leaves the field alone and reports it.
        skipped++;
        continue;
      }

      await ctx.db.insert("npcNotes", {
        campaignId: args.campaignId,
        npcId: npc._id,
        authorId: userId,
        channel: "dm",
        body,
      });
      await ctx.db.patch(npc._id, { dmNotes: undefined });
      moved++;
    }

    return { npcs: npcs.length, moved, skipped };
  },
});

/**
 * Edit a note you wrote.
 *
 * The author, and nobody else — not the GM. A note says who wrote it,
 * so a GM able to rewrite one would make the attribution a lie.
 */
export const editNote = mutation({
  args: {
    noteId: v.id("npcNotes"),
    body: v.string(),
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) throw new Error("Note not found");

    const userId = await requireUser(ctx);
    if (note.authorId !== userId) {
      throw new Error("Only whoever wrote a note can change it");
    }
    // Still a member, and still allowed in that channel: a GM who
    // handed the campaign over keeps their notes but loses the room.
    await requireChannel(ctx, note.campaignId, note.channel);

    const body = sanitizeNoteHtml(args.body);
    const images = (args.imageIds ?? note.imageIds ?? []).slice(
      0,
      NOTE_LIMITS.images
    );
    if (isEmptyNote(body) && images.length === 0) {
      throw new Error("A note needs something in it");
    }

    await ctx.db.patch(args.noteId, {
      body,
      imageIds: images,
      editedAt: Date.now(),
    });
  },
});

/** Delete a note you wrote, and the images that were only on it. */
export const deleteNote = mutation({
  args: { noteId: v.id("npcNotes") },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) return;

    const userId = await requireUser(ctx);
    if (note.authorId !== userId) {
      throw new Error("Only whoever wrote a note can delete it");
    }
    await requireChannel(ctx, note.campaignId, note.channel);

    for (const id of note.imageIds ?? []) {
      await ctx.storage.delete(id);
    }
    await ctx.db.delete(args.noteId);
  },
});

/** A short-lived URL for attaching an image to a note. */
export const generateNoteImageUploadUrl = mutation({
  args: { npcId: v.id("npcs") },
  handler: async (ctx, args) => {
    const npc = await ctx.db.get(args.npcId);
    if (!npc) throw new Error("NPC not found");
    await requireMember(ctx, npc.campaignId);
    return await ctx.storage.generateUploadUrl();
  },
});
