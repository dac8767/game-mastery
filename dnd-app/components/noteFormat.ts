/**
 * What a note is allowed to contain.
 *
 * Notes are rich text written by one person and rendered in everyone
 * else's browser. That is the whole security problem in one sentence:
 * a player writing a note is handing markup to the GM's browser, and
 * unsanitised HTML there is a script running as the GM. So the body is
 * rebuilt from an allowlist on the way IN — on the server, in the
 * mutation, not here in the editor where a hand-made call would skip
 * it entirely.
 *
 * Images are attachments rather than markup. An <img> in the body would
 * mean allowing a src, and a src is a request to wherever it points —
 * a tracking pixel at best. Attached files live on the note as storage
 * ids and are rendered separately, so the body never carries a URL.
 *
 * Free of React, Convex, and the DOM: it has to run in the mutation,
 * where there is no document to parse with, and the unit guard compiles
 * it alone.
 */

export const NOTE_LIMITS = {
  /** Generous for a note, small enough that a paste-bomb is bounded. */
  body: 20000,
  images: 8,
  /** Per NPC per channel. Beyond this the rail is a scroll, not a note. */
  perThread: 200,
};

/**
 * Tags a note may contain, and the attributes each may keep.
 *
 * Everything else is unwrapped — the tag goes, its text stays — rather
 * than dropped whole. Someone who pastes a styled paragraph out of a
 * document should get their words, not a blank note.
 */
const ALLOWED: Record<string, string[]> = {
  p: [],
  br: [],
  div: [],
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
  h3: [],
  h4: [],
  a: ["href"],
};

/** Tags whose CONTENT goes too, not just the tag. */
const NUKE = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
]);

const VOID = new Set(["br"]);

/**
 * Text, made safe to put back into HTML.
 *
 * The `&` rule is the one worth reading. This runs on HTML, not on
 * plain text: what arrives is a browser's `innerHTML`, and a browser
 * writes ENTITIES. A trailing space comes back as `&nbsp;`, a typed
 * ampersand as `&amp;`, a typed angle bracket as `&lt;`.
 *
 * Escaping every `&` therefore double-escaped all of them. A space
 * before a link came back as the literal text "&nbsp;", and — worse,
 * because it compounds — "Smith & Sons" grew another "amp;" on every
 * single save: "Smith &amp;amp;amp; Sons" after three edits.
 *
 * So a `&` that already begins a well-formed entity is left as it is,
 * and every other `&` is escaped. Leaving them is safe because an
 * entity cannot open a tag: `&lt;` stays `&lt;` and renders as the
 * character "<", not as markup. Attribute values are a separate
 * question and already answered separately — `safeHref` refuses
 * anything carrying a colon it does not recognise, entity-encoded or
 * not, and quotes are escaped after this runs.
 */
const ENTITY = /&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;

const escapeText = (s: string) =>
  s
    .replace(ENTITY, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * A link target that is safe to put in an href.
 *
 * `javascript:` is the obvious one. The subtle ones are the encodings
 * of it — a tab or a newline inside the scheme, which browsers strip
 * before resolving — so the scheme is read after removing every
 * character that cannot legally appear in one.
 */
function safeHref(raw: string): string | null {
    // Escapes, not literals: every character below 0x21 is stripped
  // before the scheme is read, because a browser strips them too —
  // "java\\tscript:" resolves as javascript: and would otherwise pass.
  const cleaned = raw.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (/^(https?:|mailto:)/.test(cleaned)) return raw.trim();
  // A bare path or anchor is fine; anything else with a colon is a
  // scheme this does not know, and unknown schemes are not allowed.
  if (!cleaned.includes(":")) return raw.trim();
  return null;
}

/**
 * Rebuild a note body from what is allowed, discarding everything else.
 *
 * Rebuild rather than strip: a blocklist is a list of the attacks
 * somebody thought of, and the next one is not on it. This emits only
 * tags it recognises, with only the attributes it recognises, so
 * anything new is excluded by not being included.
 */
/**
 * What one rebuild is allowed to emit.
 *
 * Parameterised because there are now two surfaces with the same
 * problem and different vocabularies: a note is prose, and a session's
 * note BOX carries the format toolbar's colours and alignment as well.
 * One scanner, two policies — a second scanner would be a second place
 * for `javascript:` to be missed.
 */
export interface HtmlPolicy {
  /** Tag -> attributes it may keep. A tag not here is unwrapped. */
  allowed: Record<string, string[]>;
  /** Longest body this surface accepts. */
  limit: number;
  /**
   * What an attribute's value becomes, or null to drop it.
   *
   * Returning the whole attribute text rather than just the value is
   * what lets `href` add `target` and `rel` alongside itself.
   */
  attr(tag: string, attr: string, value: string): string | null;
}

/** Anything a NOTE links to is elsewhere, so it opens there. */
function noteAttr(tag: string, attr: string, value: string): string | null {
  if (attr !== "href") {
    return ` ${attr}="${escapeText(value).replace(/"/g, "&quot;")}"`;
  }
  const href = safeHref(value);
  if (href === null) return null;
  // noopener, or the page it opens can navigate this one.
  return (
    ` href="${escapeText(href).replace(/"/g, "&quot;")}"` +
    ` target="_blank" rel="noopener noreferrer"`
  );
}

export const NOTE_POLICY: HtmlPolicy = {
  allowed: ALLOWED,
  limit: NOTE_LIMITS.body,
  attr: noteAttr,
};

export function sanitizeNoteHtml(input: string): string {
  return sanitizeHtml(input, NOTE_POLICY);
}

export function sanitizeHtml(input: string, policy: HtmlPolicy): string {
  const html = String(input ?? "").slice(0, policy.limit);
  let out = "";
  const open: string[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(html.slice(i));
      break;
    }
    if (lt > i) out += escapeText(html.slice(i, lt));

    // "5 < 6" is arithmetic, not a tag. A "<" only opens one when a
    // name, a slash, or a bang follows it — without this check the
    // scan finds the next ">" and eats everything between as a tag it
    // did not recognise, which silently deletes the words.
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? "")) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      // A stray "<" with no tag after it is text, not a broken tag.
      out += escapeText(html.slice(lt));
      break;
    }

    const raw = html.slice(lt + 1, gt);
    i = gt + 1;

    // Comments and doctypes carry nothing a note needs.
    if (raw.startsWith("!") || raw.startsWith("?")) continue;

    const closing = raw.startsWith("/");
    const nameMatch = (closing ? raw.slice(1) : raw).match(/^([a-zA-Z0-9]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();

    if (NUKE.has(name)) {
      // Skip to the matching close and drop everything between. A
      // <script> whose body survives is a <script> that runs the
      // moment anything re-wraps it.
      if (!closing) {
        const end = html.toLowerCase().indexOf(`</${name}`, i);
        i = end === -1 ? html.length : html.indexOf(">", end) + 1 || html.length;
      }
      continue;
    }

    const allowedAttrs = policy.allowed[name];
    if (!allowedAttrs) continue; // unwrapped: tag gone, text kept

    if (closing) {
      // Only close what is actually open, or a stray </p> in a paste
      // closes a tag this function opened and the rest of the note
      // inherits the formatting.
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }

    let attrs = "";
    if (allowedAttrs.length > 0) {
      for (const attr of allowedAttrs) {
        const m = raw.match(
          new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
        );
        const value = m?.[2] ?? m?.[3] ?? m?.[4];
        if (value === undefined) continue;
        const written = policy.attr(name, attr.toLowerCase(), value);
        if (written !== null) attrs += written;
      }
    }

    if (VOID.has(name) || raw.endsWith("/")) {
      out += `<${name}${attrs}>`;
      continue;
    }

    out += `<${name}${attrs}>`;
    open.push(name);
  }

  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}

/**
 * The words in a note, with the markup gone.
 *
 * Used to decide whether a note is empty: a body of "<p><br></p>" is
 * what an untouched contentEditable produces, and saving it would put
 * a blank card in the thread.
 */
export function noteText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h3|h4|blockquote)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function isEmptyNote(html: string): boolean {
  return noteText(html).length === 0;
}

/** The toolbar, as button keys the editor knows how to run. */
export const NOTE_TOOLS = [
  { key: "bold", label: "B", title: "Bold" },
  { key: "italic", label: "I", title: "Italic" },
  { key: "underline", label: "U", title: "Underline" },
  { key: "strike", label: "S", title: "Strikethrough" },
  { key: "bullets", label: "•", title: "Bulleted list" },
  { key: "numbers", label: "1.", title: "Numbered list" },
  { key: "quote", label: "❝", title: "Quote" },
  { key: "clear", label: "✕", title: "Clear formatting" },
];

/** execCommand names for the toolbar keys. */
export const NOTE_EXEC: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikeThrough",
  bullets: "insertUnorderedList",
  numbers: "insertOrderedList",
  quote: "formatBlock",
  clear: "removeFormat",
};

/** The argument a command needs, if any. */
export function noteExecValue(key: string): string | undefined {
  return key === "quote" ? "blockquote" : undefined;
}

/**
 * "just now", "5 minutes ago", "3 days ago", then a date.
 *
 * Relative while it is recent and absolute once it is not: "412 days
 * ago" is a number nobody converts, and "just now" is what you want on
 * the note you are looking at because you wrote it.
 */
export function whenText(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days <= 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const d = new Date(at);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
