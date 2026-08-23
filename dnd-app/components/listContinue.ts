/**
 * Carrying a list on when you press Enter, in a plain textarea.
 *
 * Typing "1. the toolbar is wrong" and pressing Enter should give you
 * "2. ", because the alternative is typing every number yourself and
 * renumbering by hand the moment you insert one in the middle. Bullets
 * get the same treatment.
 *
 * Deliberately a textarea rather than a rich editor. Feedback is read as
 * plain text — by the dashboard, by the script, and here in a terminal —
 * and a markup editor would make a numbered list that only looks like
 * one after something renders it.
 *
 * Free of React so the unit guard can compile it alone.
 */

export interface Continuation {
  /** The text to insert at the caret. */
  insert: string;
  /** Characters to remove BEFORE the caret first, for an empty item. */
  remove: number;
}

/** A list marker, as the line before the caret ends with one. */
interface Marker {
  /** Whitespace the item is indented by, kept so nesting survives. */
  indent: string;
  /** "1." / "3)" for numbered, "-" / "*" for bullets. */
  bullet: string;
  /** The number, or null for a bullet. */
  number: number | null;
  /** Whether anything was typed after the marker. */
  empty: boolean;
}

/**
 * The list marker on a line, or null.
 *
 * Accepts both "1." and "1)" because people type both, and both bullet
 * characters for the same reason.
 */
export function markerOf(line: string): Marker | null {
  const numbered = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/.exec(line);
  if (numbered) {
    return {
      indent: numbered[1],
      bullet: numbered[3],
      number: Number(numbered[2]),
      empty: numbered[5].trim() === "",
    };
  }

  const bulleted = /^(\s*)([-*•])(\s+)(.*)$/.exec(line);
  if (bulleted) {
    return {
      indent: bulleted[1],
      bullet: bulleted[2],
      number: null,
      empty: bulleted[4].trim() === "",
    };
  }

  return null;
}

/**
 * What Enter should do, given everything before the caret.
 *
 * Returns null when Enter should just be Enter — which is most of the
 * time, and is why this takes the text before the caret rather than the
 * whole field: a list two paragraphs up is not the line you are on.
 *
 * Pressing Enter on an EMPTY item ends the list instead of adding
 * another empty one. That is the only way out that does not involve
 * deleting the marker by hand, and every editor that does this does it
 * that way.
 */
export function continueList(before: string): Continuation | null {
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const marker = markerOf(line);
  if (!marker) return null;

  if (marker.empty) {
    // Take the marker back out and drop to a plain line.
    return { insert: "\n", remove: line.length };
  }

  const next =
    marker.number === null
      ? `${marker.bullet} `
      : `${marker.number + 1}${marker.bullet} `;
  return { insert: `\n${marker.indent}${next}`, remove: 0 };
}

/**
 * The whole field after Enter, and where the caret lands.
 *
 * Returned together because they are one edit: setting the text without
 * moving the caret puts it back at the end of the field, which on a
 * six-line report is nowhere near where you were typing.
 */
export function applyContinuation(
  value: string,
  caret: number,
  continuation: Continuation
): { value: string; caret: number } {
  const start = caret - continuation.remove;
  const next =
    value.slice(0, start) + continuation.insert + value.slice(caret);
  return { value: next, caret: start + continuation.insert.length };
}
