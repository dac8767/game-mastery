import { v } from "convex/values";
import {
  MutationCtx,
  QueryCtx,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";
import { getSettings } from "./settings";
import { sanitizeBoxHtml } from "../components/boxHtml";
import {
  BUILTIN_TABS,
  MAX_CUSTOM_TABS,
  TabDef,
  builtinTab,
  isValidTitle,
  orderTabs,
  tabTitle,
} from "../components/sessionTabs";

/**
 * Sessions — one row per night at the table, and the notes from it.
 *
 * The row is what the list shows: number, date, who was there, XP, a
 * line about it. The NOTES are boxes on TABS. Three tabs are built in:
 *
 *   dm       what the GM knew and the table did not. GM-only, and the
 *            interesting half of this file.
 *   prep     what the DM means to run. DM-only as well, and separate
 *            from the above because prep is written before the night
 *            and notes during it.
 *   player   the shared account of the night. Any member may write it —
 *            the same rule the NPC record's player notes run on, and the
 *            reason it is called the player tab rather than the public
 *            one.
 *
 * Past those, anybody may make more (sessionTabs). A member's tab is
 * shared; only the GM may make one the players cannot see.
 *
 * A GM-only tab is withheld the strongest way available here: a non-GM
 * request never QUERIES it — not its boxes, not its page, and not its
 * TITLE, which is a secret of the same kind ("Who the traitor is" needs
 * no boxes on it to give the game away). Fetching everything and
 * returning some of it would mean the GM's notes had been read out of
 * the database on a player's behalf and were sitting in a variable one
 * careless edit from the wire. `by_session_side` and
 * `by_session_dmOnly` exist so the queries themselves can be narrow.
 *
 * Which tab a write lands on is never taken on trust: every write goes
 * through resolveTab, which finds the tab in THIS session and answers
 * with its visibility. A key naming another session's tab, or nothing
 * at all, is a "Not found" rather than a write.
 *
 * A GM previewing as a player is served as a player, exactly as the
 * roster is, so the preview genuinely shows what a player would see.
 */

/** Ceiling on one campaign's sessions in a single subscription. */
const MAX_SESSIONS = 500;

/** Same ceiling a notebook page uses. Per TAB, not per session. */
const MAX_BOXES = 300;

/** Every tab a session can have: the built-ins plus its own. */
const MAX_TABS = BUILTIN_TABS.length + MAX_CUSTOM_TABS;

/**
 * A tab key. "player", "dm", "prep", or a sessionTabs id as a string —
 * open by design, and checked by resolveTab rather than by spelling.
 */
type Side = string;

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
 * What tab this key names, in THIS session.
 *
 * The one place a tab key is turned into a thing with a visibility, and
 * every read and every write goes through it. A built-in is itself; a
 * custom key has to be an id of a row belonging to this session, so a
 * key copied out of another session's URL resolves to nothing rather
 * than to that session's tab.
 *
 * normalizeId rather than a cast: `ctx.db.get` on a string that is not
 * an id of that table throws, and a tab picker left open while the tab
 * was deleted would surface as a crash instead of "Not found".
 */
async function resolveTab(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  key: Side
): Promise<TabDef> {
  const builtin = builtinTab(key);
  if (builtin) return builtin;

  const tabId = ctx.db.normalizeId("sessionTabs", key);
  if (!tabId) throw new Error("No such tab");
  const tab = await ctx.db.get(tabId);
  if (!tab || tab.sessionId !== sessionId) throw new Error("No such tab");
  return {
    key: tab._id,
    title: tab.title,
    dmOnly: tab.dmOnly,
    builtin: false,
  };
}

/**
 * Who may write on this tab.
 *
 * A GM-only tab is the GM's. A shared tab is any member's, which is the
 * same rule playerNotes runs on: the shared account of the night is
 * written by the people who were there, not dictated to them. A tab a
 * player made is shared by construction — createTab refuses to make
 * them a hidden one — so this is the whole of the rule.
 */
async function requireWriter(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  side: Side
): Promise<TabDef> {
  const tab = await resolveTab(ctx, session._id, side);
  if (tab.dmOnly) await requireDm(ctx, session.campaignId);
  else await requireMember(ctx, session.campaignId);
  return tab;
}

/**
 * Who may rename or delete a tab: the DM, or whoever made it.
 *
 * The DM owns the campaign, so the DM owns its tabs. A player who made
 * a tab for the party's shopping list owns that one — being handed a
 * "new tab" button and then not being allowed to put it right is worse
 * than not having the button.
 */
async function requireTabOwner(
  ctx: MutationCtx,
  tabId: Id<"sessionTabs">
): Promise<{ tab: Doc<"sessionTabs">; session: Doc<"sessions"> }> {
  const tab = await ctx.db.get(tabId);
  if (!tab) throw new Error("Not found");
  const session = await ctx.db.get(tab.sessionId);
  if (!session) throw new Error("Not found");

  const { userId, isDm } = await requireMember(ctx, session.campaignId);
  if (!isDm && tab.createdBy !== userId) {
    throw new Error("That tab is not yours to change.");
  }
  return { tab, session };
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
 * One session's notes, tab by tab.
 *
 * A player is sent the tabs they may see and is told nothing about the
 * rest — not their contents, not their names, not that they exist. That
 * is a stronger answer than the `dm: null` this used to send back, and
 * a simpler one to keep true: absence IS the withholding, so there is
 * no sentinel to forget to check.
 *
 * The order the queries run in is the whole guarantee. `visible` is
 * settled first, from an index narrowed by dmOnly for a non-GM caller,
 * and every content query below is keyed on a tab already in that list.
 * Nothing else in this function reads sessionBoxes or sessionPages, so
 * there is no path by which a hidden tab's rows are fetched and then
 * dropped.
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

    // The hidden rows are not read and then filtered — they are not
    // asked for. A tab's title is a secret of the same kind its boxes
    // are.
    const custom = isDm
      ? await ctx.db
          .query("sessionTabs")
          .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
          .take(MAX_CUSTOM_TABS)
      : await ctx.db
          .query("sessionTabs")
          .withIndex("by_session_dmOnly", (q) =>
            q.eq("sessionId", args.sessionId).eq("dmOnly", false)
          )
          .take(MAX_CUSTOM_TABS);
    const visible = orderTabs(isDm, custom);

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
      tabs: await Promise.all(
        visible.map(async (tab) => ({
          key: tab.key,
          title: tab.title,
          dmOnly: tab.dmOnly,
          builtin: tab.builtin,
          // Whether this person may put the tab RIGHT, which is not the
          // same as whether they may write on it: a shared tab is
          // everybody's to write and its maker's to rename. A DM
          // previewing as a player is a player here too, or the preview
          // would show controls the player does not have.
          canManage: !tab.builtin && (isDm || ownTab(custom, tab, userId)),
          boxes: await side(tab.key),
          body: await body(tab.key),
        }))
      ),
    };
  },
});

/** Whether this custom tab is the caller's own. Built-ins are nobody's. */
function ownTab(
  custom: Doc<"sessionTabs">[],
  tab: TabDef,
  userId: Id<"users">
): boolean {
  if (tab.builtin) return false;
  return custom.some((c) => c._id === tab.key && c.createdBy === userId);
}

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
 * caller, which only the deployment's own tooling may do. A session
 * already in the campaign under that NUMBER or that DATE is skipped,
 * never overwritten — a record corrected by hand outranks anything a
 * merge document says — so running it twice is safe: the second run
 * reports every record as skipped. The date half of that test is what
 * stops a renumbered campaign from being imported into twice.
 *
 * `dmNotes` lands as the session's GM page, through the same
 * sanitizer every stored page goes through. The GM side stays behind
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
    const dated = new Set(existing.flatMap((s) => (s.date ? [s.date] : [])));

    let created = 0;
    let skipped = 0;
    for (const r of args.records) {
      if (taken.has(r.number) || (r.date !== undefined && dated.has(r.date))) {
        skipped++;
        continue;
      }
      taken.add(r.number);
      if (r.date !== undefined) dated.add(r.date);
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

/**
 * The summaries, written onto sessions that already exist.
 *
 * A second pass beside importRecords, because the two answer
 * different questions: that one asks "does this session exist yet",
 * this one asks "does it say what happened". Rewriting the summaries
 * has to reach records imported by an earlier run, which the
 * skip-if-present rule there deliberately will not do.
 *
 * Keyed on the DATE, never the number. Session numbers are the GM's
 * to change — renumbering after a correction is normal, and it has
 * already happened once — and a summary matched by number lands on
 * whatever now holds that number, silently describing the wrong
 * night. A campaign runs one game on a given day, so the date is the
 * identity that survives renumbering.
 *
 * An empty description CLEARS the field: a session whose summary was
 * withdrawn has to lose the old text, not keep it forever because
 * there is nothing to overwrite it with.
 *
 * Only `description` is touched — number, date, players and XP are
 * left exactly as they are.
 */
export const setDescriptions = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    entries: v.array(v.object({ date: v.string(), description: v.string() })),
  },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("No such campaign");

    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_SESSIONS);
    const byDate = new Map(
      existing.flatMap((s) => (s.date ? [[s.date, s] as const] : []))
    );

    let written = 0;
    let cleared = 0;
    let missing = 0;
    for (const e of args.entries) {
      const row = byDate.get(e.date);
      if (!row) {
        missing++;
        continue;
      }
      const next = e.description.trim() === "" ? undefined : e.description;
      if (row.description === next) continue;
      await ctx.db.patch(row._id, { description: next });
      if (next === undefined) cleared++;
      else written++;
    }
    return { campaign: campaign.name, written, cleared, missing };
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

    // Every tab's worth, which is what MAX_TABS boxes means: addBox
    // holds each tab to MAX_BOXES, so the session's true ceiling is
    // that times the tabs it may have. It used to be `MAX_BOXES * 2`
    // when there were two sides, and the arithmetic has to move with
    // the number of tabs or a deleted session leaves boxes behind —
    // rows keyed to a session that is gone, which nothing lists and
    // nothing can reach.
    const boxes = await ctx.db
      .query("sessionBoxes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(MAX_BOXES * MAX_TABS);
    for (const box of boxes) {
      if (box.storageId) await ctx.storage.delete(box.storageId);
      await ctx.db.delete(box._id);
    }

    // The pages too, or the notes outlive the night they belong to.
    // One per tab, doubled for slack: setBody upserts on a `.first()`,
    // so two saves racing on a tab with no page yet can leave two.
    const pages = await ctx.db
      .query("sessionPages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(MAX_TABS * 2);
    for (const page of pages) await ctx.db.delete(page._id);

    // And the tabs themselves, whose rows would otherwise be the only
    // thing left of a session nobody can reach.
    const tabs = await ctx.db
      .query("sessionTabs")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(MAX_CUSTOM_TABS);
    for (const tab of tabs) await ctx.db.delete(tab._id);

    await ctx.db.delete(args.sessionId);
  },
});

/**
 * A new tab on this session.
 *
 * Any member may make one, which is what was asked for — "players and
 * dm can create new tabs if they want". Only the DM may make one the
 * players cannot see: a hidden tab is a thing the DM keeps from the
 * table, and a player hiding something from the DM is not a shape this
 * app has. Asking for one is refused out loud rather than quietly
 * downgraded to a shared tab, because a player who thought they had
 * made a private tab and had not is worse off than one who was told no.
 */
export const createTab = mutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    dmOnly: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    const { userId, isDm } = await requireMember(ctx, session.campaignId);

    if (args.dmOnly && !isDm) {
      throw new Error("Only the DM can make a tab the players cannot see.");
    }
    const title = tabTitle(args.title);
    if (!isValidTitle(title)) throw new Error("Give the tab a name.");

    const existing = await ctx.db
      .query("sessionTabs")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(MAX_CUSTOM_TABS + 1);
    if (existing.length >= MAX_CUSTOM_TABS) {
      throw new Error(
        `A session holds ${MAX_CUSTOM_TABS} tabs of its own — delete one first.`
      );
    }

    return await ctx.db.insert("sessionTabs", {
      sessionId: args.sessionId,
      title,
      dmOnly: args.dmOnly,
      order: existing.reduce((max, t) => Math.max(max, t.order), 0) + 1,
      createdBy: userId,
    });
  },
});

/** Rename a tab. The DM's, or your own — see requireTabOwner. */
export const renameTab = mutation({
  args: { tabId: v.id("sessionTabs"), title: v.string() },
  handler: async (ctx, args) => {
    const { tab } = await requireTabOwner(ctx, args.tabId);
    const title = tabTitle(args.title);
    if (!isValidTitle(title)) throw new Error("Give the tab a name.");
    if (title === tab.title) return;
    await ctx.db.patch(args.tabId, { title });
  },
});

/**
 * Delete a tab, and everything written on it.
 *
 * The boxes and the page go with it. Leaving them would leave rows
 * keyed to a tab nothing can name — invisible, undeletable, and still
 * counted against the box ceiling of a tab that no longer exists.
 */
export const deleteTab = mutation({
  args: { tabId: v.id("sessionTabs") },
  handler: async (ctx, args) => {
    const { tab } = await requireTabOwner(ctx, args.tabId);

    const boxes = await ctx.db
      .query("sessionBoxes")
      .withIndex("by_session_side", (q) =>
        q.eq("sessionId", tab.sessionId).eq("side", tab._id)
      )
      .take(MAX_BOXES);
    for (const box of boxes) {
      if (box.storageId) await ctx.storage.delete(box.storageId);
      await ctx.db.delete(box._id);
    }

    const pages = await ctx.db
      .query("sessionPages")
      .withIndex("by_session_side", (q) =>
        q.eq("sessionId", tab.sessionId).eq("side", tab._id)
      )
      .take(2);
    for (const page of pages) await ctx.db.delete(page._id);

    await ctx.db.delete(args.tabId);
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
 * page is written by any member and read by the GM, which is the
 * direction that matters.
 */
export const setBody = mutation({
  args: {
    sessionId: v.id("sessions"),
    side: v.string(),
    html: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireWriter(ctx, session, args.side);

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
    side: v.string(),
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
    await requireWriter(ctx, session, args.side);

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
      // GM. See components/boxHtml.ts.
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
    // The box says which tab it is on, so a player cannot reach a box
    // on a GM-only tab by knowing its id.
    await requireWriter(ctx, session, box.side);

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
    await requireWriter(ctx, session, box.side);

    if (box.storageId) await ctx.storage.delete(box.storageId);
    await ctx.db.delete(args.boxId);
  },
});

/** Short-lived URL the browser PUTs an image to. */
export const generateUploadUrl = mutation({
  args: { sessionId: v.id("sessions"), side: v.string() },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    await requireWriter(ctx, session, args.side);
    return await ctx.storage.generateUploadUrl();
  },
});
