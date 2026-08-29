/**
 * Showing a rules search result.
 *
 * The other half of scripts/srdChunks.mjs, and deliberately sharing
 * nothing with it: chunking happens once, at import, and this happens
 * on every keystroke. Neither needs the other.
 *
 * Everything here is about one property — a result must never let you
 * mistake a paraphrase for the rule. So the text is returned as spans
 * to highlight, never as HTML to inject, and a snippet is always a
 * contiguous run of the real text with the elisions marked.
 *
 * Free of React and Convex so the unit guard can compile it alone.
 */

export const SNIPPET_LIMITS = {
  /** Characters shown before the reader asks for the whole section. */
  length: 320,
  /** Words shorter than this are ignored when scoring a match. */
  minTerm: 2,
};

/**
 * The words a query is actually looking for.
 *
 * Lowercased, punctuation stripped, one-letter words dropped: matching
 * on "a" would highlight most of the page and rank every section
 * equally, which is the same as not ranking at all.
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of String(query ?? "").toLowerCase().split(/[^a-z0-9']+/)) {
    const term = raw.replace(/^'+|'+$/g, "");
    if (term.length >= SNIPPET_LIMITS.minTerm) seen.add(term);
  }
  return [...seen];
}

export interface Span {
  text: string;
  hit: boolean;
}

/**
 * Text split into runs, marking which ones matched.
 *
 * Spans rather than marked-up HTML: this is rules text going onto a
 * page, and the only safe way to emphasise part of a string you did
 * not write is to hand the renderer the pieces and let JSX do the
 * escaping. Building `<mark>` tags here would put string concatenation
 * between a document and a browser.
 */
export function highlight(text: string, terms: string[]): Span[] {
  const body = String(text ?? "");
  if (terms.length === 0 || !body) return [{ text: body, hit: false }];

  // Longest first, so "attack" inside "attacks" does not win over a
  // term that matches the whole word.
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  const lower = body.toLowerCase();

  /** Which characters are inside a match. */
  const marked = new Array<boolean>(body.length).fill(false);
  for (const term of ordered) {
    let at = lower.indexOf(term);
    while (at !== -1) {
      for (let i = at; i < at + term.length; i++) marked[i] = true;
      at = lower.indexOf(term, at + term.length);
    }
  }

  const spans: Span[] = [];
  let start = 0;
  for (let i = 1; i <= body.length; i++) {
    if (i === body.length || marked[i] !== marked[start]) {
      spans.push({ text: body.slice(start, i), hit: marked[start] });
      start = i;
    }
  }
  return spans.length > 0 ? spans : [{ text: body, hit: false }];
}

/**
 * The part of a section worth showing first.
 *
 * Centred on the densest run of matches rather than the first one: a
 * section that mentions the word once in passing and then explains it
 * three paragraphs down should open at the explanation.
 *
 * Cut at word boundaries, with an ellipsis on whichever end was cut, so
 * it is always visible that this is an extract and not the whole rule.
 */
export function snippet(
  text: string,
  terms: string[],
  length = SNIPPET_LIMITS.length
): string {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  if (body.length <= length) return body;
  if (terms.length === 0) return `${cutAtWord(body, length)}…`;

  const lower = body.toLowerCase();
  const hits: number[] = [];
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at !== -1) {
      hits.push(at);
      at = lower.indexOf(term, at + term.length);
    }
  }
  if (hits.length === 0) return `${cutAtWord(body, length)}…`;

  // The window containing the most matches. Ties go to the earliest,
  // because the first explanation of a term is usually the definition.
  hits.sort((a, b) => a - b);
  let bestAt = hits[0];
  let best = 0;
  for (const start of hits) {
    const count = hits.filter((h) => h >= start && h < start + length).length;
    if (count > best) {
      best = count;
      bestAt = start;
    }
  }

  let from = Math.max(0, bestAt - Math.floor(length / 4));
  if (from > 0) {
    const space = body.indexOf(" ", from);
    from = space === -1 ? from : space + 1;
  }
  const to = Math.min(body.length, from + length);
  const cut = body.slice(from, to);

  return `${from > 0 ? "…" : ""}${
    to < body.length ? cutAtWord(cut, length) + "…" : cut
  }`;
}

function cutAtWord(text: string, length: number): string {
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return (space > length / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * "Rules Glossary › Conditions › Grappled", for one line above a rule.
 *
 * The breadcrumb is stored with " > " between its parts because that is
 * what reads correctly in a plain-text search index; the chevron is a
 * display choice and belongs here, not in the data.
 */
export function trailOf(breadcrumb: string, title: string): string {
  return [...String(breadcrumb ?? "").split(" > "), title]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" › ");
}

/**
 * The AI layer's half.
 *
 * Everything below serves the answer panel rather than the hit list.
 * Same property as everything above it, for the same reason: an answer
 * is text out of a model, the citation markers inside it are text out
 * of a model, and neither is ever built into markup here.
 */

/** How many past questions the box remembers, per browser. */
export const RECENT_LIMIT = 8;

export interface AnswerSpan {
  text: string;
  /** The number this span cites, or null when it is ordinary prose. */
  cite: number | null;
}

/**
 * An answer split into prose and the citation markers inside it.
 *
 * The answer arrives as prose with `[1]`-style markers where the claims
 * are, and the screen turns each marker into a control that opens the
 * section it names. Doing that by string replacement would mean
 * building HTML out of model output — the one thing this file exists to
 * avoid — so the marker is located here and the caller renders a button.
 *
 * Only numbers the answer actually carries citations for are treated as
 * markers; `known` is that set. A bare `[4]` in an answer with three
 * citations stays prose, because a control that opens nothing is worse
 * than the bracket it replaced.
 */
export function answerSpans(answer: string, known: number[]): AnswerSpan[] {
  const body = String(answer ?? "");
  if (!body) return [];

  const allowed = new Set(known);
  const spans: AnswerSpan[] = [];
  let at = 0;

  for (const match of body.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (!allowed.has(n)) continue;
    const start = match.index ?? 0;
    if (start > at) spans.push({ text: body.slice(at, start), cite: null });
    spans.push({ text: match[0], cite: n });
    at = start + match[0].length;
  }

  if (at < body.length) spans.push({ text: body.slice(at), cite: null });
  return spans;
}

/**
 * Written as an escape, not as the character itself.
 *
 * A separator has to be something that cannot occur inside a source, a
 * breadcrumb or a title, and NUL is the only one document text can
 * never contain. Typed literally it turns this file binary to `grep`
 * and to diffs; as an escape the file stays plain text and the value is
 * the same.
 */
const SECTION_SEP = "\u0000";

/**
 * What identifies a section across a re-import.
 *
 * The rules table has no stable ids — `--replace` mints new ones every
 * time the SRD is converted again — so a pin, a citation and a hit are
 * matched to each other by name. Mirrors the key the server pins on.
 */
export function sectionKeyOf(ref: {
  source: string;
  breadcrumb: string;
  title: string;
}): string {
  return [ref.source, ref.breadcrumb, ref.title]
    .map((p) => String(p ?? "").trim())
    .join(SECTION_SEP);
}

/**
 * A question added to the recent list.
 *
 * Newest first, no duplicates, capped. Pure so the guard can check the
 * behaviour that matters: asking the same thing twice moves it up the
 * list rather than leaving a second copy of it further down.
 */
export function pushRecent(
  list: readonly string[],
  query: string,
  limit = RECENT_LIMIT
): string[] {
  const next = String(query ?? "").trim();
  if (!next) return list.slice(0, limit);
  const rest = list.filter((q) => q.toLowerCase() !== next.toLowerCase());
  return [next, ...rest].slice(0, limit);
}
