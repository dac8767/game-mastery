import { v } from "convex/values";
import { MutationCtx, mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireDm, requireMember } from "./auth";
import { getSettings } from "./settings";

/**
 * Groups — the factions, guilds, families and mobs an NPC belongs to.
 *
 * The one thing to understand before changing anything here: a group's
 * MEMBERSHIP is not stored in the groups table. It is `npcs.groups`, a
 * string array typed by hand in Airtable years before this table
 * existed, and it is still the only place that says who is in the
 * Mining Guild. A groups row adds what a bare name cannot carry — a
 * description and some pictures — and it is keyed by that name.
 *
 * So the list this query returns is the UNION of two things:
 *
 *   described   a row in the groups table
 *   used        a name at least one NPC carries
 *
 * A name in the second set with nothing in the first still gets a row,
 * marked `described: false`. Without that the screen would be empty on
 * a roster already full of groups, and following a group chip from the
 * NPC list — which is the whole point of the screen — would land on
 * nothing for every group that exists today.
 *
 * The visibility rule is the same one the roster runs on, and it has
 * one more edge here than it looks: a group's member list is built from
 * NPC rows, so a hidden NPC must be dropped BEFORE the names are
 * collected. Otherwise a player learns that someone they have not met
 * is in the cult — the name leaks through the group even though the NPC
 * itself is withheld. A group nobody visible belongs to still shows if
 * it has been described; the description is the GM's writing, not a
 * roster fact.
 */

/** Ceiling on one campaign's groups, so a runaway loop can't unbound it. */
const MAX_GROUPS = 500;

/** Same ceiling the roster subscription uses. */
const MAX_NPCS = 1000;

/** A group holds at most this many pictures. */
const MAX_ATTACHMENTS = 12;

/**
 * The key a name is matched on: case- and space-insensitive.
 *
 * "Mining Guild" and "mining guild " are the same group. They ARE both
 * in the data — the field is free text and nobody typed it twice the
 * same way — so matching on the raw string would file the same guild
 * under two rows with half the members each.
 */
export function groupKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

async function ownedGroup(
  ctx: { db: { get: (id: Id<"groups">) => Promise<Doc<"groups"> | null> } },
  groupId: Id<"groups">
): Promise<Doc<"groups">> {
  const group = await ctx.db.get(groupId);
  if (!group) throw new Error("Not found");
  return group;
}

export const listForCampaign = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { userId, isDm: isCampaignDm } = await requireMember(
      ctx,
      args.campaignId
    );

    // A GM previewing the player view is served as a player, exactly as
    // the roster is — otherwise the preview would show the real member
    // lists and say nothing was being withheld.
    const { viewAsPlayer } = await getSettings(ctx, userId);
    const isDm = isCampaignDm && !viewAsPlayer;

    const npcRows = await ctx.db
      .query("npcs")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_NPCS);

    // Dropped before anything is counted or named. A hidden NPC must
    // not show up in a member list, in a member COUNT, or as the reason
    // a group exists at all.
    const visible = npcRows.filter((n) => isDm || !n.hidden);

    const members = new Map<string, string[]>();
    // The name as somebody typed it, remembered on the way past. The
    // key is lower-cased and space-squashed, and "mining guild" is not
    // what the guild is called — so the first spelling the roster
    // offers is what an undescribed group wears.
    const spelling = new Map<string, string>();
    for (const npc of visible) {
      for (const raw of npc.groups) {
        const key = groupKey(raw);
        if (!key) continue;
        if (!members.has(key)) {
          members.set(key, []);
          spelling.set(key, raw.replace(/\s+/g, " ").trim());
        }
        members.get(key)!.push(npc.name);
      }
    }

    const described = await ctx.db
      .query("groups")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_GROUPS);

    /* Described rows first, so a group somebody has written up owns its
       own spelling of its name. The inferred ones then fill in whatever
       is left over. */
    const rows: {
      /**
       * Unique per ROW, which the name key is not: two groups created
       * and not yet named both key to "". The client renders and
       * selects on this.
       */
      rowId: string;
      key: string;
      groupId: Id<"groups"> | null;
      name: string;
      description: string | null;
      attachments: { storageId: Id<"_storage">; url: string }[];
      members: string[];
      memberCount: number;
      described: boolean;
    }[] = [];
    const taken = new Set<string>();

    for (const group of described) {
      const key = groupKey(group.name);
      taken.add(key);
      const attachments = await Promise.all(
        (group.attachmentIds ?? []).map(async (storageId) => ({
          storageId,
          url: await ctx.storage.getUrl(storageId),
        }))
      );
      const names = members.get(key) ?? [];
      rows.push({
        rowId: group._id,
        key,
        groupId: group._id,
        name: group.name,
        description: group.description ?? null,
        // A storage id whose file is gone resolves to null. Dropping it
        // here keeps the client from rendering a broken frame for a
        // picture nothing can supply.
        attachments: attachments.filter(
          (a): a is { storageId: Id<"_storage">; url: string } => a.url !== null
        ),
        members: names.slice().sort((a, b) => a.localeCompare(b)),
        memberCount: names.length,
        described: true,
      });
    }

    for (const [key, names] of members) {
      if (taken.has(key)) continue;
      rows.push({
        // An undescribed group has no document, so its name key IS its
        // identity — and it is never blank, because a blank name keys
        // to nothing and was skipped above.
        rowId: key,
        key,
        groupId: null,
        name: spelling.get(key) ?? key,
        description: null,
        attachments: [],
        members: names.slice().sort((a, b) => a.localeCompare(b)),
        memberCount: names.length,
        described: false,
      });
    }

    return {
      isDm,
      truncated: npcRows.length >= MAX_NPCS || described.length >= MAX_GROUPS,
      groups: rows,
    };
  },
});

/**
 * Refuse a name a group already answers to.
 *
 * Two rows for one name would split its description and its pictures
 * between them and show the same members twice, and nothing downstream
 * could tell which one was meant.
 */
async function assertNameFree(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  name: string,
  except?: Id<"groups">
) {
  const key = groupKey(name);
  const existing = await ctx.db
    .query("groups")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .take(MAX_GROUPS);
  for (const group of existing) {
    if (group._id === except) continue;
    if (groupKey(group.name) === key) {
      throw new Error(`There is already a group called "${group.name}".`);
    }
  }
}

export const createGroup = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const name = (args.name ?? "").replace(/\s+/g, " ").trim();
    if (name) await assertNameFree(ctx, args.campaignId, name);

    return await ctx.db.insert("groups", {
      campaignId: args.campaignId,
      // A blank name is allowed on purpose: + New Group opens an empty
      // record for you to type into, the same way + New NPC does.
      name,
      description: undefined,
      attachmentIds: [],
    });
  },
});

/**
 * Describe a group a name alone had been standing in for.
 *
 * The screen lists names nobody has written up, and opening one has to
 * be able to become a real row without asking you to retype the name
 * you just clicked. Idempotent: if the row appeared between the click
 * and the save, the existing one is returned rather than a second row
 * for the same name.
 */
export const describeGroup = mutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const name = args.name.replace(/\s+/g, " ").trim();
    if (!name) throw new Error("A group needs a name.");

    const key = groupKey(name);
    const existing = await ctx.db
      .query("groups")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_GROUPS);
    const already = existing.find((g) => groupKey(g.name) === key);
    if (already) return already._id;

    return await ctx.db.insert("groups", {
      campaignId: args.campaignId,
      name,
      description: undefined,
      attachmentIds: [],
    });
  },
});

/**
 * Rename or re-describe a group.
 *
 * A rename carries: every NPC that lists the old name is rewritten to
 * the new one in the same transaction. Membership lives on the NPC, so
 * renaming only the row here would leave the guild's members behind
 * under the old name — the group would appear to empty out, and the old
 * name would come straight back as an undescribed row beside it.
 */
export const updateGroup = mutation({
  args: {
    groupId: v.id("groups"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const group = await ownedGroup(ctx, args.groupId);
    await requireDm(ctx, group.campaignId);

    const patch: { name?: string; description?: string } = {};

    if (args.description !== undefined) {
      // null means "empty this field": Convex removes a field patched
      // with undefined, and null is not legal for v.optional(v.string()).
      patch.description = args.description ?? undefined;
    }

    if (args.name !== undefined) {
      const name = args.name.replace(/\s+/g, " ").trim();
      if (!name) throw new Error("A group needs a name.");
      if (groupKey(name) !== groupKey(group.name)) {
        await assertNameFree(ctx, group.campaignId, name, group._id);
        await retagNpcs(ctx, group.campaignId, group.name, name);
      }
      patch.name = name;
    }

    await ctx.db.patch(args.groupId, patch);
  },
});

/**
 * Delete the group, and take its name off everybody in it.
 *
 * Deleting only the row would look like nothing happened: the name is
 * still on the NPCs, so the screen would redraw it a second later as an
 * undescribed group — with the description and the pictures gone. So
 * this is the whole thing, and the client says so before calling it.
 */
export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => {
    const group = await ownedGroup(ctx, args.groupId);
    await requireDm(ctx, group.campaignId);

    for (const id of group.attachmentIds ?? []) await ctx.storage.delete(id);
    await retagNpcs(ctx, group.campaignId, group.name, null);
    await ctx.db.delete(args.groupId);
  },
});

/**
 * Take a group's name off every NPC that carries it, or swap it.
 *
 * Matching is on the key, so a group typed three different ways is
 * caught all three times; the replacement is written in the group's own
 * spelling, which is how the field tidies itself up over time.
 */
async function retagNpcs(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  from: string,
  to: string | null
) {
  const key = groupKey(from);
  if (!key) return;

  const rows = await ctx.db
    .query("npcs")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .take(MAX_NPCS);

  for (const npc of rows) {
    if (!npc.groups.some((g) => groupKey(g) === key)) continue;
    const next: string[] = [];
    for (const g of npc.groups) {
      if (groupKey(g) !== key) {
        next.push(g);
        continue;
      }
      // Renaming three spellings of one group into one name would
      // otherwise leave the NPC holding it three times.
      if (to !== null && !next.some((n) => groupKey(n) === groupKey(to))) {
        next.push(to);
      }
    }
    await ctx.db.patch(npc._id, { groups: next });
  }
}

export const generateUploadUrl = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => {
    const group = await ownedGroup(ctx, args.groupId);
    await requireDm(ctx, group.campaignId);
    return await ctx.storage.generateUploadUrl();
  },
});

export const addAttachment = mutation({
  args: {
    groupId: v.id("groups"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const group = await ownedGroup(ctx, args.groupId);
    await requireDm(ctx, group.campaignId);

    const current = group.attachmentIds ?? [];
    if (current.length >= MAX_ATTACHMENTS) {
      // Refuse rather than silently dropping the upload that just
      // finished — and delete the orphan, since nothing would ever
      // reference it again.
      await ctx.storage.delete(args.storageId);
      throw new Error(`A group holds at most ${MAX_ATTACHMENTS} pictures.`);
    }
    await ctx.db.patch(args.groupId, {
      attachmentIds: [...current, args.storageId],
    });
  },
});

export const removeAttachment = mutation({
  args: {
    groupId: v.id("groups"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const group = await ownedGroup(ctx, args.groupId);
    await requireDm(ctx, group.campaignId);

    await ctx.db.patch(args.groupId, {
      attachmentIds: (group.attachmentIds ?? []).filter(
        (id) => id !== args.storageId
      ),
    });
    await ctx.storage.delete(args.storageId);
  },
});
