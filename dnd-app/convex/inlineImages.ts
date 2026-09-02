import { MutationCtx, QueryCtx } from "./_generated/server";
import { imageStorageIds, withImageSrcs } from "../components/boxHtml";

/**
 * Pictures pasted into the text — the server's half.
 *
 * Both canvases store `<img data-storage="…">` and never a src (see
 * boxHtml's allowlist for why). These two are what a backend does
 * with that: mint the URL on read, and delete the file when the text
 * that pointed at it goes. Shared between sessions and the notebook so
 * the two cannot drift — a key one of them resolved and the other did
 * not would be a picture that shows on one screen and not the other.
 *
 * Helpers only. Nothing here is a Convex function, so this module
 * appears in the generated api as an empty namespace, which is fine.
 */

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
 * The files a page's or box's pasted images point at, deleted.
 *
 * Only when the page or box itself goes — with its tab, its session,
 * its notebook page. NOT on every save that no longer mentions a key:
 * Cmd+Z after deleting a picture puts the <img> back in the editor,
 * and a file deleted on the save in between would leave that undo
 * pointing at nothing. A file a picture was removed from stays until
 * its page does, which is storage spent on undo working.
 */
export async function deleteInlineImages(
  ctx: MutationCtx,
  html: string | null | undefined
): Promise<void> {
  for (const id of imageStorageIds(html ?? "")) {
    const sid = ctx.db.system.normalizeId("_storage", id);
    if (sid && (await ctx.db.system.get(sid))) await ctx.storage.delete(sid);
  }
}
