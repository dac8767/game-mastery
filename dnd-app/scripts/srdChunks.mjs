/**
 * Cutting a rules document into searchable pieces.
 *
 * The unit a person wants back from a rules search is a SECTION — the
 * whole of "Grappled", not the sentence that happened to match. So the
 * document is split on its headings, and each chunk carries the path of
 * headings above it: searching "grappled" should show you that you are
 * looking at Rules Glossary → Conditions → Grappled, because "a rule
 * with no idea where it came from" is the thing this tool exists to
 * avoid.
 *
 * Plain ESM rather than TypeScript so the importer can use it directly —
 * `npm run` scripts have no build step — and so the unit guard can
 * import it without compiling anything.
 *
 * The app does NOT import this. Chunking happens once, at import; the
 * app only ever reads chunks back out. components/rulesSnippet.ts is
 * the other half, and the two share nothing on purpose.
 */

export const CHUNK_LIMITS = {
  /**
   * Characters. A section longer than this is split at paragraph
   * boundaries.
   *
   * Not a storage limit — a reading one. A "chunk" that is four pages
   * of combat rules is a chunk whose match you still have to go
   * hunting through, which is the problem search was meant to solve.
   */
  maxChars: 4000,
  /** Below this, a trailing split is folded back into the one before. */
  minChars: 200,
  titleLength: 200,
};

/** "## Conditions" → { depth: 2, title: "Conditions" }, else null. */
function headingOf(line) {
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  const title = m[2].replace(/\*+/g, "").trim();
  if (!title) return null;
  return { depth: m[1].length, title: title.slice(0, CHUNK_LIMITS.titleLength) };
}

/**
 * Split prose into paragraphs, keeping tables and lists whole.
 *
 * A markdown table is blank-line-free, so splitting on blank lines
 * already keeps it together — but a table separated from the sentence
 * that introduces it is a table of numbers with no column meanings, so
 * a paragraph ending in a colon stays with what follows it.
 */
function paragraphsOf(text) {
  const raw = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of raw) {
    const prev = out[out.length - 1];
    if (prev && /[:：]$/.test(prev)) out[out.length - 1] = `${prev}\n\n${p}`;
    else out.push(p);
  }
  return out;
}

/**
 * A long section, split at paragraph boundaries.
 *
 * Never mid-sentence: a chunk that starts halfway through a clause
 * reads as a different rule than the one it came from, which is worse
 * than a chunk that is slightly too long.
 */
function splitLong(text) {
  if (text.length <= CHUNK_LIMITS.maxChars) return [text];

  const parts = [];
  let current = "";
  for (const para of paragraphsOf(text)) {
    if (current && current.length + para.length + 2 > CHUNK_LIMITS.maxChars) {
      parts.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) parts.push(current);

  // A stub left at the end is a chunk that says nothing on its own.
  if (
    parts.length > 1 &&
    parts[parts.length - 1].length < CHUNK_LIMITS.minChars
  ) {
    const tail = parts.pop();
    parts[parts.length - 1] += `\n\n${tail}`;
  }
  return parts;
}

/**
 * A markdown rules document, as chunks.
 *
 * Splits at every heading. The breadcrumb is the chain of headings
 * ABOVE this one, so a chunk knows where it sits without the reader
 * having to scroll up.
 *
 * Text before the first heading is kept as a chunk too — a document
 * whose licence notice or introduction is silently discarded is a
 * document you cannot verify you imported correctly.
 */
export function chunkMarkdown(markdown, source) {
  const lines = String(markdown ?? "").split("\n");
  const chunks = [];

  /** The heading stack: index 0 is depth 1. */
  const path = [];
  let title = "";
  let depth = 0;
  let buffer = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text && !title) return;

    // The breadcrumb excludes this chunk's own heading — it is the
    // trail TO here, not including here.
    const breadcrumb = path.slice(0, Math.max(0, depth - 1)).filter(Boolean);

    for (const part of splitLong(text)) {
      chunks.push({
        source,
        title: title || source,
        breadcrumb: breadcrumb.join(" > "),
        text: part,
      });
    }
  };

  for (const line of lines) {
    const heading = headingOf(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }

    flush();

    // Deeper headings extend the path; a shallower one truncates it,
    // which is what stops "Spells > Fireball" following you into the
    // next chapter.
    path.length = Math.max(0, heading.depth - 1);
    path[heading.depth - 1] = heading.title;
    title = heading.title;
    depth = heading.depth;
  }
  flush();

  // A section heading with nothing under it is a table of contents
  // entry, not a rule. Numbered AFTER that filter, so order is
  // contiguous and "the next section" means the next one you can read.
  return chunks
    .filter((c) => c.text.length > 0)
    .map((c, i) => ({ ...c, order: i }));
}

/**
 * What the search index actually matches on.
 *
 * The heading and its trail are folded into the searchable text, so
 * "grappled condition" finds the Grappled section even though the word
 * "condition" appears only in the heading above it. Stored alongside
 * the display text rather than instead of it — the reader gets the
 * rule, the index gets the rule plus its context.
 */
export function searchTextOf(chunk) {
  return [chunk.breadcrumb, chunk.title, chunk.text]
    .filter(Boolean)
    .join("\n");
}
