import { v } from "convex/values";
import {
  MutationCtx,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";
import { getSettings } from "./settings";
import { sanitizeBoxHtml } from "../components/boxHtml";

/**
 * Sessions — one row per night at the table, and the notes from it.
 *
 * The row is what the list shows: number, date, who was there, XP, a
 * line about it. The NOTES are boxes, on two sides:
 *
 *   player   the shared account of the night. Any member may write it —
 *            the same rule the NPC record's player notes run on, and the
 *            reason it is called the player side rather than the public
 *            one.
 *   dm       what the DM knew and the table did not. DM-only, and the
 *            interesting half of this file.
 *
 * The DM side is withheld the strongest way available here: a non-DM
 * request never QUERIES it. Fetching both sides and returning one would
 * mean the DM's notes had been read out of the database on a player's
 * behalf and were sitting in a variable one careless edit from the wire.
 * `by_session_side` exists so the query itself can be narrow.
 *
 * A DM previewing as a player is served as a player, exactly as the
 * roster is, so the preview genuinely shows what a player would see.
 */

/** Ceiling on one campaign's sessions in a single subscription. */
const MAX_SESSIONS = 500;

/** Same ceiling a notebook page uses. */
const MAX_BOXES = 300;

type Side = "player" | "dm";

async function ownedSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Not found");
  return session;
}

async function ownedBox(
  ctx: MutationCtx,
  boxId: Id<"sessionBoxes">
): Promise<{ box: Doc<"sessionBoxes">; session: Doc<"sessions"> }> {
  const box = await ctx.db.get(boxId);
  if (!box) throw new Error("Not found");
  const session = await ctx.db.get(box.sessionId);
  if (!session) throw new Error("Not found");
  return { box, session };
}

/**
 * Who may write this side.
 *
 * The DM side is the DM's. The player side is any member's, which is
 * the same rule playerNotes runs on: the shared account of the night is
 * written by the people who were there, not dictated to them.
 */
async function requireWriter(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  side: Side
) {
  if (side === "dm") {
    await requireDm(ctx, campaignId);
    return;
  }
  await requireMember(ctx, campaignId);
}

export const listForCampaign = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { userId, isDm: isCampaignDm } = await requireMember(
      ctx,
      args.campaignId
    );
    const { viewAsPlayer } = await getSettings(ctx, userId);
    const isDm = isCampaignDm && !viewAsPlayer;

    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_SESSIONS + 1);

    const truncated = rows.length > MAX_SESSIONS;
    const page = truncated ? rows.slice(0, MAX_SESSIONS) : rows;

    return {
      isDm,
      truncated,
      sessions: page.map((s) => ({
        _id: s._id,
        _creationTime: s._creationTime,
        number: s.number,
        date: s.date ?? null,
        players: s.players,
        xp: s.xp ?? null,
        milestone: s.milestone ?? null,
        description: s.description ?? null,
      })),
    };
  },
});

/**
 * One session's notes.
 *
 * `dm` comes back as null for a player — not as an empty array, which
 * would read as "the DM has not written anything" and is a different
 * claim from "this is not yours to see". The client shows no DM section
 * at all rather than an empty one.
 */
export const getNotes = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;

    const { userId, isDm: isCampaignDm } = await requireMember(
      ctx,
      session.campaignId
    );
    const { viewAsPlayer } = await getSettings(ctx, userId);
    const isDm = isCampaignDm && !viewAsPlayer;

    const side = async (which: Side) => {
      const boxes = await ctx.db
        .query("sessionBoxes")
        .withIndex("by_session_side", (q) =>
          q.eq("sessionId", args.sessionId).eq("side", which)
        )
        .take(MAX_BOXES);
      return await Promise.all(
        boxes
          .sort((a, b) => a.order - b.order)
          .map(async (b) => ({
            _id: b._id,
            type: b.type,
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
            order: b.order,
            html: b.html ?? null,
            // Resolved here so the client never handles storage ids.
            src: b.storageId ? await ctx.storage.getUrl(b.storageId) : null,
            rotate: b.rotate ?? 0,
            borderW: b.borderW ?? 0,
            borderColor: b.borderColor ?? null,
            rows: b.rows ?? null,
            colWidths: b.colWidths ?? null,
            rowHeights: b.rowHeights ?? null,
            align: b.align ?? null,
            borderless: b.borderless ?? false,
            shading: b.shading ?? null,
          }))
      );
    };

    /** The page the boxes sit on — the document you type into. */
    const body = async (which: Side) => {
      const page = await ctx.db
        .query("sessionPages")
        .withIndex("by_session_side", (q) =>
          q.eq("sessionId", args.sessionId).eq("side", which)
        )
        .first();
      return page?.html ?? "";
    };

    return {
      isDm,
      player: await side("player"),
      playerBody: await body("player"),
      // Neither of these is queried at all for a player.
      dm: isDm ? await side("dm") : null,
      dmBody: isDm ? await body("dm") : null,
    };
  },
});

export const createSession = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    // Numbered one past the highest, because "what number is this one"
    // is a question with an obvious answer that nobody should have to
    // go and look up. Edit it if the answer is wrong.
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_SESSIONS);
    const next = existing.reduce((max, s) => Math.max(max, s.number), 0) + 1;

    return await ctx.db.insert("sessions", {
      campaignId: args.campaignId,
      number: next,
      date: undefined,
      players: [],
      xp: undefined,
      description: undefined,
    });
  },
});

/**
 * A campaign's session history, imported in one sweep — see
 * scripts/import-moonbrook-sessions.mjs, which carries the records and
 * invokes this through `npx convex run` in batches.
 *
 * INTERNAL, not public: it writes into a campaign with no signed-in
 * caller, which only the deployment's own tooling may do. Existing
 * session NUMBERS are skipped, never overwritten — a record typed by
 * hand outranks anything a merge document says — so running it twice
 * is safe: the second run reports every record as skipped.
 *
 * `dmNotes` lands as the session's DM page, through the same
 * sanitizer every stored page goes through. The DM side stays behind
 * getNotes' gate like any other; importing does not change who may
 * read it.
 */
export const importRecords = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    records: v.array(
      v.object({
        number: v.number(),
        date: v.optional(v.string()),
        players: v.array(v.string()),
        xp: v.optional(v.number()),
        description: v.optional(v.string()),
        dmNotes: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("No such campaign");

    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_SESSIONS);
    const taken = new Set(existing.map((s) => s.number));

    let created = 0;
    let skipped = 0;
    for (const r of args.records) {
      if (taken.has(r.number)) {
        skipped++;
        continue;
      }
      taken.add(r.number);
      const sessionId = await ctx.db.insert("sessions", {
        campaignId: args.campaignId,
        number: r.number,
        date: r.date,
        players: r.players,
        xp: r.xp,
        description: r.description,
      });
      if (r.dmNotes) {
        await ctx.db.insert("sessionPages", {
          sessionId,
          side: "dm",
          html: sanitizeBoxHtml(r.dmNotes),
        });
      }
      created++;
    }
    return { campaign: campaign.name, created, skipped };
  },
});

export const updateSession = mutation({
  args: {
    sessionId: v.id("sessions"),
    number: v.optional(v.number()),
    date: v.optional(v.union(v.string(), v.null())),
    players: v.optional(v.array(v.string())),
    xp: v.optional(v.union(v.number(), v.null())),
    milestone: v.optional(v.union(v.number(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireDm(ctx, session.campaignId);

    const { sessionId, ...rest } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      // null means "empty this field": Convex removes a field patched
      // with undefined, and null is not legal for v.optional(...).
      patch[key] = value === null ? undefined : value;
    }
    if (Object.keys(patch).length === 0) return;

    if (typeof patch.number === "number" && !Number.isFinite(patch.number)) {
      throw new Error("A session number has to be a number.");
    }

    // A milestone is a LEVEL: a whole number a character sheet can
    // say. 2 through 20, because level 1 is where a campaign starts
    // rather than somewhere it arrives.
    if (patch.milestone !== undefined) {
      const m = patch.milestone;
      if (typeof m !== "number" || !Number.isInteger(m) || m < 2 || m > 20) {
        throw new Error("A milestone is a level from 2 to 20.");
      }
    }

    await ctx.db.patch(sessionId, patch as Partial<Doc<"sessions">>);
  },
});

export const deleteSession = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireDm(ctx, session.campaignId);

    const boxes = await ctx.db
      .query("sessionBoxes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(MAX_BOXES * 2);
    for (const box of boxes) {
      if (box.storageId) await ctx.storage.delete(box.storageId);
      await ctx.db.delete(box._id);
    }

    // The pages too, or the notes outlive the night they belong to.
    const pages = await ctx.db
      .query("sessionPages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(4);
    for (const page of pages) await ctx.db.delete(page._id);

    await ctx.db.delete(args.sessionId);
  },
});

/**
 * The page's own text, written back.
 *
 * One row per side, made on the first save rather than when the session
 * is created — otherwise every session ever made before this existed
 * would have no page to write to, and the fix for that is a migration
 * where an upsert will do.
 *
 * Sanitised like every other stored HTML on this screen. The player
 * page is written by any member and read by the DM, which is the
 * direction that matters.
 */
export const setBody = mutation({
  args: {
    sessionId: v.id("sessions"),
    side: v.union(v.literal("player"), v.literal("dm")),
    html: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireWriter(ctx, session.campaignId, args.side);

    const html = sanitizeBoxHtml(args.html);
    const existing = await ctx.db
      .query("sessionPages")
      .withIndex("by_session_side", (q) =>
        q.eq("sessionId", args.sessionId).eq("side", args.side)
      )
      .first();

    if (existing) await ctx.db.patch(existing._id, { html });
    else {
      await ctx.db.insert("sessionPages", {
        sessionId: args.sessionId,
        side: args.side,
        html,
      });
    }
  },
});

export const addBox = mutation({
  args: {
    sessionId: v.id("sessions"),
    side: v.union(v.literal("player"), v.literal("dm")),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("table")),
    x: v.number(),
    y: v.number(),
    w: v.number(),
    h: v.number(),
    html: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    rows: v.optional(v.array(v.array(v.string()))),
    colWidths: v.optional(v.array(v.number())),
    rowHeights: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireWriter(ctx, session.campaignId, args.side);

    const existing = await ctx.db
      .query("sessionBoxes")
      .withIndex("by_session_side", (q) =>
        q.eq("sessionId", args.sessionId).eq("side", args.side)
      )
      .take(MAX_BOXES);
    if (existing.length >= MAX_BOXES) {
      throw new Error("These notes are full — start another session.");
    }
    const order = existing.reduce((max, b) => Math.max(max, b.order), 0) + 1;

    const { sessionId, html, ...rest } = args;
    return await ctx.db.insert("sessionBoxes", {
      ...rest,
      // Rebuilt here, in the mutation, rather than in the editor: a
      // hand-made call would skip an editor-side sanitiser entirely,
      // and the player side is written by any member and read by the
      // DM. See components/boxHtml.ts.
      html: html === undefined ? undefined : sanitizeBoxHtml(html),
      sessionId,
      order,
    });
  },
});

export const updateBox = mutation({
  args: {
    boxId: v.id("sessionBoxes"),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
    order: v.optional(v.number()),
    html: v.optional(v.string()),
    rotate: v.optional(v.number()),
    borderW: v.optional(v.number()),
    borderColor: v.optional(v.union(v.string(), v.null())),
    rows: v.optional(v.array(v.array(v.string()))),
    colWidths: v.optional(v.array(v.number())),
    rowHeights: v.optional(v.array(v.number())),
    align: v.optional(
      v.union(v.literal("left"), v.literal("center"), v.literal("right"))
    ),
    borderless: v.optional(v.boolean()),
    shading: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { box, session } = await ownedBox(ctx, args.boxId);
    // The box says which side it is on, so a player cannot reach a DM
    // box by knowing its id.
    await requireWriter(ctx, session.campaignId, box.side);

    const { boxId, ...rest } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      patch[key] = value === null ? undefined : value;
    }
    // Every write of `html` goes through the rebuild, including this
    // one — it is the write the format toolbar makes on every command,
    // so it is the one that carries markup most often.
    if (typeof patch.html === "string") {
      patch.html = sanitizeBoxHtml(patch.html);
    }
    if (Object.keys(patch).length === 0) return;

    await ctx.db.patch(boxId, patch as Partial<Doc<"sessionBoxes">>);
  },
});

export const deleteBox = mutation({
  args: { boxId: v.id("sessionBoxes") },
  handler: async (ctx, args) => {
    const { box, session } = await ownedBox(ctx, args.boxId);
    await requireWriter(ctx, session.campaignId, box.side);

    if (box.storageId) await ctx.storage.delete(box.storageId);
    await ctx.db.delete(args.boxId);
  },
});

/** Short-lived URL the browser PUTs an image to. */
export const generateUploadUrl = mutation({
  args: {
    sessionId: v.id("sessions"),
    side: v.union(v.literal("player"), v.literal("dm")),
  },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireWriter(ctx, session.campaignId, args.side);
    return await ctx.storage.generateUploadUrl();
  },
});
