/**
 * What a session's note box is allowed to contain.
 *
 * The notebook's boxes are private — one person's page, rendered only
 * for them — so their HTML went to the database and back untouched. A
 * SESSION's player notes are not: any member may write them and the DM
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
};

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

/** A note box's HTML, rebuilt from what a note box may contain. */
export function sanitizeBoxHtml(input: string): string {
  return sanitizeHtml(input, BOX_POLICY);
}
