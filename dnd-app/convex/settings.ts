import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { isAdminEligible, requireDm, requireMember, requireUser } from "./auth";

/**
 * Personal app settings.
 *
 * Everything here is scoped to the caller, resolved from the auth
 * context — no function takes a userId, because an argument is
 * something a client can lie about. Changing your theme changes nothing
 * for anyone else.
 *
 * Deliberately absent: a DM/player role switch. Authority in this app is
 * structural (campaign.dmId === userId) precisely so it cannot desync
 * from the data, and a settable role would hand every player the DM's
 * secrets. `viewAsPlayer` is the safe direction — a DM choosing to be
 * served the player's view — and is honoured by npcs.listForCampaign so
 * the preview is real rather than cosmetic.
 */

export const themeValidator = v.union(
  v.literal("candlelight"),
  v.literal("slate"),
  v.literal("parchment")
);

const DEFAULTS = {
  theme: "candlelight" as const,
  viewAsPlayer: false,
  adminOverride: false,
  toolbarTokens: [] as string[],
  toolbarSet: false,
  // Day-first, matching what the campaign card already showed. Changing
  // an existing display is not a default's job.
  dateFormat: "dmy" as const,
  // Nothing switched off. An empty list and "never opened the Sources
  // tab" are the same thing here, which is why this needs no flag of
  // the kind the toolbar has.
  excludedSources: [] as string[],
  // Open, the way the app has always started.
  sidebarCollapsed: false,
  // Mirrors DEFAULT_PAGE_SIZE in components/pagerModel.ts.
  tableRows: 20,
};

/** Shared reader so queries can honour viewAsPlayer without duplication. */
export async function getSettings(ctx: QueryCtx, userId: Id<"users">) {
  const doc = await ctx.db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return doc
    ? {
        theme: doc.theme,
        viewAsPlayer: doc.viewAsPlayer,
        adminOverride: doc.adminOverride ?? false,
        toolbarTokens: doc.toolbarTokens ?? [],
        // Reported as stored. The client seeds the default layout from
        // this flag alone — an empty toolbar is something a person can
        // legitimately have made, so "the array is empty" must never
        // stand in for "never arranged one".
        toolbarSet: doc.toolbarSet ?? false,
        dateFormat: doc.dateFormat ?? DEFAULTS.dateFormat,
        excludedSources: doc.excludedSources ?? DEFAULTS.excludedSources,
        // Null rather than a default: absent means "never arranged
        // one", which the client needs to tell apart from an arranged
        // layout that happens to match the shipped grouping.
        sidebar: doc.sidebar ?? null,
        sidebarCollapsed: doc.sidebarCollapsed ?? DEFAULTS.sidebarCollapsed,
        tableRows: doc.tableRows ?? DEFAULTS.tableRows,
      }
    : { ...DEFAULTS, sidebar: null };
}

export const mySettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const settings = await getSettings(ctx, userId);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    // Eligibility is read from the deployment env var, never stored, so
    // the client can be told about it but can never grant it.
    return {
      ...settings,
      displayName: profile?.displayName ?? null,
      adminEligible: await isAdminEligible(ctx, userId),
    };
  },
});

export const dateFormatValidator = v.union(
  v.literal("dmy"),
  v.literal("mdy"),
  v.literal("numeric"),
  v.literal("iso")
);

/**
 * Mirrors SidebarLayout in components/sidebarLayout.ts.
 *
 * Every key the client writes has to be declared here: a Convex object
 * validator REJECTS an undeclared one, so a field added to the
 * TypeScript interface and forgotten here does not degrade — it makes
 * every save of the whole layout fail.
 */
export const sidebarValidator = v.object({
  sections: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      dmOnly: v.optional(v.boolean()),
      collapsed: v.optional(v.boolean()),
      items: v.array(
        v.object({
          id: v.string(),
          hidden: v.boolean(),
          /** Folded away, hiding the item's sub-screens. See SidebarItem. */
          collapsed: v.optional(v.boolean()),
          /**
           * LEGACY. Read by nothing, written by nothing.
           *
           * The flag above used to be called `expanded` and mean the
           * opposite. Renaming it broke the deployment rather than the
           * code: a Convex object validator is STRICT, so every
           * userSettings row already carrying the old key stopped
           * matching the schema and `convex dev` refused to push at
           * all — the app would not start.
           *
           * A field is not renameable in place. It is accepted here so
           * those rows still validate, and reconcileSidebar drops it,
           * so a row heals the first time its owner touches the
           * sidebar. Once no row has one it can go.
           */
          expanded: v.optional(v.boolean()),
        })
      ),
    })
  ),
});

export const saveMySettings = mutation({
  args: {
    theme: v.optional(themeValidator),
    viewAsPlayer: v.optional(v.boolean()),
    adminOverride: v.optional(v.boolean()),
    toolbarTokens: v.optional(v.array(v.string())),
    dateFormat: v.optional(dateFormatValidator),
    excludedSources: v.optional(v.array(v.string())),
    sidebar: v.optional(v.union(sidebarValidator, v.null())),
    sidebarCollapsed: v.optional(v.boolean()),
    // The exact offered set, not any number: a validator that took 7
    // or 7000 would let one bad write outlast every clamp after it.
    tableRows: v.optional(
      v.union(
        v.literal(10),
        v.literal(20),
        v.literal(30),
        v.literal(40),
        v.literal(50)
      )
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    // Turning the override ON requires eligibility. Turning it off is
    // always allowed — nobody should ever be stuck holding it.
    if (args.adminOverride === true && !(await isAdminEligible(ctx, userId))) {
      throw new Error("Not an admin");
    }

    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        theme: args.theme ?? existing.theme,
        viewAsPlayer: args.viewAsPlayer ?? existing.viewAsPlayer,
        adminOverride: args.adminOverride ?? existing.adminOverride ?? false,
        // Writing a layout at all is what sets the flag, including an
        // empty one — that is the whole point of keeping it separate.
        toolbarTokens: args.toolbarTokens ?? existing.toolbarTokens,
        toolbarSet:
          args.toolbarTokens !== undefined || (existing.toolbarSet ?? false),
        dateFormat: args.dateFormat ?? existing.dateFormat,
        // `??`, so switching the last book back ON — an empty array —
        // is stored rather than read as "did not mention it".
        excludedSources: args.excludedSources ?? existing.excludedSources,
        // An explicit null is "put it back to the default", which is a
        // different request from not mentioning it at all.
        sidebar:
          args.sidebar === null
            ? undefined
            : (args.sidebar ?? existing.sidebar),
        sidebarCollapsed: args.sidebarCollapsed ?? existing.sidebarCollapsed,
        tableRows: args.tableRows ?? existing.tableRows,
      });
      return;
    }

    await ctx.db.insert("userSettings", {
      userId,
      theme: args.theme ?? DEFAULTS.theme,
      viewAsPlayer: args.viewAsPlayer ?? DEFAULTS.viewAsPlayer,
      adminOverride: args.adminOverride ?? DEFAULTS.adminOverride,
      toolbarTokens: args.toolbarTokens,
      toolbarSet: args.toolbarTokens !== undefined,
      dateFormat: args.dateFormat,
      excludedSources: args.excludedSources,
      sidebar: args.sidebar ?? undefined,
      sidebarCollapsed: args.sidebarCollapsed,
      tableRows: args.tableRows,
    });
  },
});

/**
 * Your own name, as everyone else sees it.
 *
 * Lives on `profiles` rather than `userSettings` because it is the one
 * thing on this page other people read: a campaign card says who runs
 * it, and until this is set it can only say "the DM".
 */
export const setMyName = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const name = args.displayName.trim();
    if (name === "") throw new Error("A name cannot be blank");
    if (name.length > 60) throw new Error("That name is too long");

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (profile) {
      await ctx.db.patch(profile._id, { displayName: name });
      return;
    }
    await ctx.db.insert("profiles", { userId, displayName: name });
  },
});

/**
 * The signed-in person's name and email.
 *
 * The feedback form prefills from this instead of asking for a profile
 * the way a signed-out app has to — everyone here is already
 * authenticated, so asking again would be a form asking a question it
 * can already answer.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    return {
      email: user?.email ?? null,
      name: profile?.displayName ?? user?.name ?? null,
    };
  },
});

/* ---------- edit mode: what the interface says and how it splits -----
 *
 * NOT personal, unlike everything above it in this file. The rest of
 * this module is "your theme, your sidebar, nobody else's"; this is the
 * words on the screen for one campaign, so the DM writes it and every
 * member reads it. It lives here because a new convex/ module cannot be
 * added without running codegen, which the sandbox has no network for.
 */

/** Longest a renamed label may be, matching components/uiRegistry.ts. */
const UI_TEXT_LENGTH = 400;
/** Longest an id may be, so one bad write cannot bloat the document. */
const UI_ID_LENGTH = 80;
/** Most overrides one campaign may store. */
const UI_ENTRIES = 500;

/**
 * The overrides for a campaign, for anyone who is in it.
 *
 * Not DM-gated: the words on the screen are not a secret, and a player
 * who could not read them would see the shipped labels while the DM saw
 * their own — two people describing different buttons to each other.
 */
export const getUiOverrides = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    const row = await ctx.db
      .query("uiOverrides")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();
    return {
      text: row?.text ?? [],
      layout: row?.layout ?? [],
    };
  },
});

/**
 * Replace a campaign's overrides. DM only, like every other decision
 * about how this campaign's screens are laid out.
 *
 * The whole set at once rather than one entry at a time: edit mode
 * drafts locally and saves on the way out, so a partial write is never
 * a state the client asks for, and a replace cannot leave a half-renamed
 * screen behind.
 */
export const saveUiOverrides = mutation({
  args: {
    campaignId: v.id("campaigns"),
    text: v.array(v.object({ id: v.string(), value: v.string() })),
    layout: v.array(v.object({ id: v.string(), value: v.number() })),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    if (args.text.length + args.layout.length > UI_ENTRIES) {
      throw new Error("Too many interface changes to save at once");
    }
    for (const e of [...args.text, ...args.layout]) {
      if (!e.id || e.id.length > UI_ID_LENGTH) {
        throw new Error("An interface change has a bad id");
      }
    }

    // Trimmed and capped here as well as on the client. The client caps
    // it so the editor cannot produce something too long; the server
    // caps it because a mutation is a public API and the client is not
    // the only thing that can call it.
    const text = args.text
      .map((e) => ({ id: e.id, value: e.value.trim().slice(0, UI_TEXT_LENGTH) }))
      .filter((e) => e.value.length > 0);

    const layout = args.layout.filter((e) => Number.isFinite(e.value));

    const existing = await ctx.db
      .query("uiOverrides")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { text, layout });
      return;
    }
    await ctx.db.insert("uiOverrides", {
      campaignId: args.campaignId,
      text,
      layout,
    });
  },
});
