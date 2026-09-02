/**
 * What a session's note box is allowed to contain.
 *
 * The notebook's boxes are private — one person's page, rendered only
 * for them — so their HTML went to the database and back untouched. A
 * SESSION's player notes are not: any member may write them and the GM
 * reads them, which makes a box exactly the problem notes already
 * solved. Markup written by one person and rendered in another's
 * browser is a script running as them unless something rebuilds it.
 *
 * Wider than a note's vocabulary, because the format toolbar puts
 * colours, faces, sizes and alignment on the text and a note has none
 * of those. Same shape though: an allowlist that EMITS what it
 * recognises rather than a blocklist that removes what it fears, so
 * whatever gets invented next is excluded by not being included.
 *
 * `style` is the one that needs its own allowlist inside the
 * allowlist. It has to be here — it is how execCommand writes a colour
 * — and it is also a whole language, most of which can make a request
 * (`background: url(...)`) or cover the screen. So the declarations are
 * rebuilt too, from five properties, with any value holding a url or a
 * bracket refused.
 *
 * Free of React, Convex, and the DOM: it runs in the mutation, where
 * there is no document to parse with, and the unit guard compiles it
 * alone.
 */

/* A RELATIVE import, not the "@/" alias. This module is compiled twice
   — once by the Next.js app, which knows the alias, and once by the
   Convex backend, whose tsconfig does not. convex/npcs.ts imports
   noteFormat the same way for the same reason. */
import { HtmlPolicy, sanitizeHtml } from "./noteFormat";

/** Generous for a page of notes, bounded against a paste-bomb. */
export const BOX_HTML_LIMIT = 40000;

/**
 * The declarations a box may carry.
 *
 * Everything the format toolbar can produce, and nothing that can
 * position, size, or fetch. `text-align` is here because alignment is
 * written onto the block rather than as a tag.
 */
const STYLE_PROPS = new Set([
  "color",
  "background-color",
  "text-align",
  "font-family",
  "font-size",
]);

/**
 * A style attribute rebuilt from the declarations that are allowed.
 *
 * Values are checked as well as names: `color` cannot make a request,
 * but `color: var(--x)` and anything with a url or a function call in
 * it is refused rather than reasoned about. A colour is a word, a hash,
 * or an rgb()/hsl() — which is the one bracketed form worth keeping,
 * so it is matched explicitly rather than allowed by not being
 * refused.
 */
export function safeStyle(raw: string): string | null {
  const out: string[] = [];

  for (const part of String(raw ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (!STYLE_PROPS.has(prop) || !value) continue;
    if (value.length > 80) continue;

    const plain = /^[#\w][\w\s,.%#-]*$/.test(value);
    const fn = /^(rgb|rgba|hsl|hsla)\(\s*[\d\s,.%/]+\)$/i.test(value);
    // Quoted font names are a family list, not a function call.
    const family =
      prop === "font-family" && /^[\w\s,'"-]+$/.test(value);
    if (!plain && !fn && !family) continue;

    out.push(`${prop}: ${value}`);
  }

  return out.length > 0 ? out.join("; ") : null;
}

/**
 * A link target inside the app.
 *
 * The links this app writes are app routes, and an app route starts
 * with a single slash. "//evil.example" is a PROTOCOL-RELATIVE url that
 * also starts with a slash and is not this app at all, so the second
 * character is checked as well — the same trap artSrc has a note about.
 */
export function safeBoxHref(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // Control characters, whitespace and the quoting characters, as
  // ESCAPES rather than as the characters themselves: written
  // literally, the low end of that range put real control bytes in
  // this file and made it binary to grep and to diff. NOT a range
  // like `[ -]` either, which is space-to-hyphen and swallows the
  // "%" in every url-encoded name.
  if (/[\u0000-\u0020\u007f"'<>\\`]/.test(value)) return null;
  return value;
}

const ALLOWED: Record<string, string[]> = {
  p: ["style"],
  div: ["style"],
  br: [],
  span: ["style"],
  font: ["color", "face", "size"],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  strike: [],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  code: [],
  pre: [],
  h3: ["style"],
  h4: ["style"],
  // `data-gm` is what makes a link OURS: the canvas follows those with
  // the router and leaves anything else alone.
  a: ["href", "data-gm"],
  // An image pasted into the text. What is kept is the storage KEY and
  // never a src: a data: URL is a megabyte in a document, an external
  // URL is a request to somebody's server from every member's browser,
  // and a blob: URL is dead by the next reload — which was the report,
  // word for word: pasted images that were images until the next day.
  // The URL is minted on every read (sessions.withImages) from the key.
  img: ["data-storage"],
};

/**
 * Whether this could be a storage id. Letters and digits, the length
 * Convex mints; the server's normalizeId is the real check, and this
 * keeps a quote or a space out of the attribute on the way there.
 */
export function isStorageKey(raw: unknown): boolean {
  return /^[a-z0-9]{16,64}$/.test(String(raw ?? ""));
}

const escapeAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const BOX_POLICY: HtmlPolicy = {
  allowed: ALLOWED,
  limit: BOX_HTML_LIMIT,
  attr(tag, attr, value) {
    if (attr === "style") {
      const style = safeStyle(value);
      return style === null ? null : ` style="${escapeAttr(style)}"`;
    }
    if (attr === "href") {
      const href = safeBoxHref(value);
      // No target and no rel: these go to a page in this app, through
      // the router, and opening the campaign in a second tab is not
      // what following a link to an NPC means.
      return href === null ? null : ` href="${escapeAttr(href)}"`;
    }
    if (attr === "data-storage") {
      return isStorageKey(value) ? ` data-storage="${value}"` : null;
    }
    if (attr === "data-gm") {
      // A kind, and only a kind. It reaches a route builder, so it is
      // held to letters rather than trusted to be one of the four.
      return /^[a-z]{1,16}$/.test(value)
        ? ` data-gm="${escapeAttr(value)}"`
        : null;
    }
    if (attr === "size") {
      // execCommand's legacy 1–7, not a CSS length.
      return /^[1-7]$/.test(value.trim()) ? ` size="${value.trim()}"` : null;
    }
    if (attr === "color") {
      const ok = safeStyle(`color: ${value}`);
      return ok === null ? null : ` color="${escapeAttr(value.trim())}"`;
    }
    if (attr === "face") {
      const ok = safeStyle(`font-family: ${value}`);
      return ok === null ? null : ` face="${escapeAttr(value.trim())}"`;
    }
    return null;
  },
};

/**
 * A note box's HTML, rebuilt from what a note box may contain.
 *
 * An <img> that kept no storage key is an <img> pointing at nothing
 * — an external picture, a data: URL, a paste from somewhere that was
 * not this app — and is removed whole rather than left as a bare tag
 * that draws a broken-image icon where the picture was.
 */
export function sanitizeBoxHtml(input: string): string {
  return sanitizeHtml(input, BOX_POLICY).replace(/<img>/g, "");
}

/* The canonical form the sanitizer emits, which is the only form a
   stored page has. Matching on it is what makes the two helpers below
   a pair of string replaces rather than a parser. */
const INLINE_IMAGE = /<img data-storage="([a-z0-9]+)">/g;

/**
 * Pasted pictures in their stored form, in HTML that is otherwise left
 * alone.
 *
 * For the notebook, whose boxes are private and are NOT sanitized —
 * they go to the database and back untouched, and a picture somebody
 * pasted there last year as a data: URL still works and must go on
 * working. Only the tags carrying a storage key are rewritten, to the
 * one form withImageSrcs matches: the key, and nothing else — the
 * blob: src the editor put on for its preview is dropped here, as the
 * sanitizer drops it for a session. A tag whose key is not a key is
 * left as it was.
 */
export function canonicalInlineImages(html: string): string {
  return String(html ?? "").replace(
    /<img\b[^>]*\bdata-storage\s*=\s*"([^"]*)"[^>]*>/gi,
    (tag, id: string) =>
      isStorageKey(id) ? `<img data-storage="${id}">` : tag
  );
}

/** The storage keys a stored page or box refers to, each once. */
export function imageStorageIds(html: string): string[] {
  const ids = new Set<string>();
  for (const m of String(html ?? "").matchAll(INLINE_IMAGE)) ids.add(m[1]);
  return [...ids];
}

/**
 * A stored page with its images made visible: a src beside each key,
 * from the URLs the server minted. A key whose file is gone is marked
 * rather than dropped, so a picture that went missing is a visible
 * gap and not a silent one.
 *
 * The src is NOT in the sanitizer's vocabulary, deliberately, so a
 * page written back after being read is the stored form again — the
 * key stays, the URL does not, and no URL of anybody's choosing is
 * ever stored.
 */
export function withImageSrcs(
  html: string,
  urls: ReadonlyMap<string, string | null>
): string {
  return String(html ?? "").replace(INLINE_IMAGE, (tag, id: string) => {
    const url = urls.get(id) ?? null;
    return url === null
      ? `<img data-storage="${id}" alt="Image missing">`
      : `<img data-storage="${id}" src="${escapeAttr(url)}">`;
  });
}
