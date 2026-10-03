import { MutationCtx, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { imageStorageIds, withImageSrcs } from "../components/boxHtml";

/**
 * Uploaded files — who owns one, and the pictures pasted into text.
 *
 * Helpers only. Nothing here is a Convex function, so this module
 * appears in the generated api as an empty namespace, which is fine.
 *
 * OWNERSHIP. Every mutation that attaches a file takes a bare
 * `v.id("_storage")`, and every delete removes whatever id its record
 * holds. Unchecked, that is a way to delete somebody else's file: put
 * its id on a record you control, then delete the record. So a file is
 * CLAIMED for one campaign and one person the first time it is
 * attached (`claimFile`), and a claim can only be made on a fresh
 * upload — an attach follows its upload by seconds, while an id
 * somebody read off another record is older than that, or already
 * claimed. Files from before claims existed are therefore unclaimable,
 * which is the safe direction: the records holding them still own them.
 */

/**
 * How long after its upload a file may first be claimed.
 *
 * Long enough for a slow connection and a person who wandered off
 * mid-upload; short enough that an id read off a list query an hour
 * later is useless.
 */
const CLAIM_WINDOW_MS = 60 * 60 * 1000;

type Owner = { campaignId: Id<"campaigns">; userId: Id<"users"> };

async function claimOf(ctx: QueryCtx | MutationCtx, storageId: Id<"_storage">) {
  return await ctx.db
    .query("storageClaims")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
}

/** Can this file be claimed for `owner` right now, and if not, why not? */
async function claimRefusal(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  owner: Owner
): Promise<string | null> {
  const claim = await claimOf(ctx, storageId);
  if (claim) {
    // Your own upload again — re-attaching it is not taking anything.
    return claim.campaignId === owner.campaignId && claim.userId === owner.userId
      ? null
      : "That file is already attached somewhere else. Upload it again.";
  }
  const file = await ctx.db.system.get(storageId);
  if (!file) return "That upload could not be found. Upload it again.";
  if (Date.now() - file._creationTime > CLAIM_WINDOW_MS) {
    return "That upload has expired. Upload it again.";
  }
  return null;
}

/**
 * Claim a just-uploaded file for the record it is being attached to.
 *
 * Call it BEFORE anything else touches the id — in particular before an
 * over-the-limit branch deletes the "orphaned" upload, or that branch
 * deletes a file the caller never owned.
 */
export async function claimFile(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  owner: Owner
): Promise<void> {
  const refusal = await claimRefusal(ctx, storageId, owner);
  if (refusal) throw new Error(refusal);
  if (!(await claimOf(ctx, storageId))) {
    await ctx.db.insert("storageClaims", { storageId, ...owner });
  }
}

/**
 * Delete a file a record held, and its claim.
 *
 * For ids read off the record being deleted or replaced — never for an
 * id taken from the caller's arguments, which is the attack.
 */
export async function releaseFile(
  ctx: MutationCtx,
  storageId: Id<"_storage">
): Promise<void> {
  const claim = await claimOf(ctx, storageId);
  if (claim) await ctx.db.delete(claim._id);
  if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
}

/**
 * A stored page or text box, with its pasted images made visible.
 *
 * The URL is minted here, on every read, from the key — the same thing
 * an image BOX has always had done for it (`src: await
 * ctx.storage.getUrl(...)` in each getter). A key that names no file
 * comes back marked missing rather than dropped.
 *
 * The key is not checked against the page it is on, and that is a
 * choice: a storage id is thirty-two random characters, the URL it
 * resolves to is already reachable by anybody holding it, and a page
 * that refused keys it did not mint would refuse the one case that
 * matters — a picture cut from one page and pasted into another.
 */
export async function withImages(
  ctx: QueryCtx,
  html: string
): Promise<string> {
  const ids = imageStorageIds(html);
  if (ids.length === 0) return html;
  const urls = new Map<string, string | null>();
  for (const id of ids) {
    const sid = ctx.db.system.normalizeId("_storage", id);
    urls.set(id, sid ? await ctx.storage.getUrl(sid) : null);
  }
  return withImageSrcs(html, urls);
}

/**
 * Claim the pictures newly pasted into a page or box, on save.
 *
 * Lenient where `claimFile` is strict: a key that cannot be claimed —
 * a picture cut from another page, or one somebody else pasted — is
 * left in the text unclaimed rather than failing the save, because the
 * save is the format toolbar's every keystroke. An unclaimed key is
 * shown but never deleted by `deleteInlineImages`, which is what makes
 * the leniency safe.
 */
export async function claimInlineImages(
  ctx: MutationCtx,
  html: string | null | undefined,
  owner: Owner
): Promise<void> {
  for (const id of imageStorageIds(html ?? "")) {
    const sid = ctx.db.system.normalizeId("_storage", id);
    if (!sid || (await claimOf(ctx, sid))) continue;
    if ((await claimRefusal(ctx, sid, owner)) === null) {
      await ctx.db.insert("storageClaims", { storageId: sid, ...owner });
    }
  }
}

/**
 * The files a page's or box's pasted images point at, deleted.
 *
 * Only when the page or box itself goes — with its tab, its session,
 * its notebook page. NOT on every save that no longer mentions a key:
 * Cmd+Z after deleting a picture puts the <img> back in the editor,
 * and a file deleted on the save in between would leave that undo
 * pointing at nothing. A file a picture was removed from stays until
 * its page does, which is storage spent on undo working.
 *
 * Only files claimed for this campaign, by the person deleting or with
 * the GM's authority (`isDm`, which a campaign purge also passes). The
 * text is written by its author, so the keys in it are whatever its
 * author typed: without the claim check, writing another file's key
 * into your own box and deleting the box would delete that file.
 */
export async function deleteInlineImages(
  ctx: MutationCtx,
  html: string | null | undefined,
  by: { campaignId: Id<"campaigns">; userId: Id<"users"> | null; isDm: boolean }
): Promise<void> {
  for (const id of imageStorageIds(html ?? "")) {
    const sid = ctx.db.system.normalizeId("_storage", id);
    if (!sid) continue;
    const claim = await claimOf(ctx, sid);
    if (!claim || claim.campaignId !== by.campaignId) continue;
    if (!by.isDm && claim.userId !== by.userId) continue;
    await releaseFile(ctx, sid);
  }
}
