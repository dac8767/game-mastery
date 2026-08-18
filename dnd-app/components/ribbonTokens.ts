/**
 * The ribbon's grammar.
 *
 * The entire toolbar is a flat array of short strings. Not a tree, not a
 * config object, not a component list. Structure is punctuation *inside*
 * the sequence: a section boundary is a token, a row break is a token,
 * the right-alignment split is a token.
 *
 * That one decision is what makes everything else cheap. Reordering is
 * array reordering. Persisting is an array of strings, so there is no
 * migration scaffolding for a shape that keeps changing. The Customize
 * window is a list because the model is a list. And a malformed layout
 * is impossible to represent — extra row breaks merge, a second align
 * split degrades to a plain boundary, and the parser is total.
 *
 * Deliberately free of React, Convex, and any import at all: this is the
 * first thing to get right, and tests/guards/unit.mjs compiles this file
 * on its own and fuzzes the round-trip. The registries are injected
 * (see `normalizeRibbon`) rather than imported, precisely so that stays
 * possible.
 *
 * | Token          | Means                                              |
 * |----------------|----------------------------------------------------|
 * | b:<key>        | a built-in control (its own dropdown or state)     |
 * | c:<id>         | a one-shot command button                          |
 * | t:<id>         | a tool/screen launcher                             |
 * | d:<id>         | a divider line                                     |
 * | 2!d:<id>       | a full-height divider = a SECTION BOUNDARY         |
 * | nd:<id>        | a section boundary that paints no line             |
 * | r:<id>         | row break — what follows goes on the second row    |
 * | rl:<id>        | row break that draws a line between the rows       |
 * | a:<id>         | alignment split — what follows hugs the right edge |
 * | st:<text>      | section title — the text IS the rest of the token  |
 * | s:<id>         | spacer                                             |
 * | s:<id>:<px>    | spacer with an explicit width                      |
 */

export const TALL_PREFIX = "2!";

export const isTall = (t: string) => t.startsWith(TALL_PREFIX);
export const stripTall = (t: string) =>
  isTall(t) ? t.slice(TALL_PREFIX.length) : t;
export const makeTall = (t: string) => (isTall(t) ? t : TALL_PREFIX + t);

export const isSectionDivider = (t: string) =>
  isTall(t) && stripTall(t).startsWith("d:");
export const isNakedDivider = (t: string) => t.startsWith("nd:");
export const isRowBreak = (t: string) =>
  t.startsWith("r:") || t.startsWith("rl:");
export const isAlignSplit = (t: string) => t.startsWith("a:");
export const isSectionTitle = (t: string) => t.startsWith("st:");

/** Punctuation rather than a control — it has no registry entry. */
export function isStructural(token: string): boolean {
  const t = stripTall(token);
  return (
    t.startsWith("d:") ||
    t.startsWith("nd:") ||
    t.startsWith("s:") ||
    isRowBreak(t) ||
    isAlignSplit(t) ||
    isSectionTitle(t)
  );
}

/** Explicit width on a spacer token, if it carries one. */
export function spacerWidth(token: string): number | null {
  const t = stripTall(token);
  if (!t.startsWith("s:")) return null;
  const px = Number(t.split(":")[2]);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/** Rewrite a spacer's width, keeping its id. Zero or NaN clears it. */
export function withSpacerWidth(token: string, px: number | null): string {
  const t = stripTall(token);
  if (!t.startsWith("s:")) return token;
  const id = t.split(":")[1] ?? "";
  const next =
    px && Number.isFinite(px) && px > 0 ? `s:${id}:${Math.round(px)}` : `s:${id}`;
  return isTall(token) ? makeTall(next) : next;
}

export interface RibbonSection {
  top: string[];
  bottom: string[];
  /** false ⇒ single row, and every item renders as a big button. */
  hasBreak: boolean;
  /** Draw a line between the two rows. */
  breakLine: boolean;
  title?: string;
  /** This section's leading boundary paints no line. */
  noSepBefore?: boolean;
}

export interface RibbonModel {
  sections: RibbonSection[];
  /** Index of the first right-aligned section, or null. */
  splitAt: number | null;
}

/**
 * Tokens → structure. TOTAL: every input yields a model.
 *
 * Extra row breaks inside one section merge into the first, because a
 * section has at most two rows; a second align split acts as a plain
 * boundary. Nothing here can throw, so a layout that arrived damaged
 * still renders something a person can fix.
 */
export function parseRibbon(tokens: string[]): RibbonModel {
  const sections: RibbonSection[] = [];
  let splitAt: number | null = null;
  let cur: RibbonSection = {
    top: [],
    bottom: [],
    hasBreak: false,
    breakLine: false,
  };

  const push = () => {
    sections.push(cur);
    cur = { top: [], bottom: [], hasBreak: false, breakLine: false };
  };

  for (const raw of tokens) {
    if (isAlignSplit(raw)) {
      push();
      if (splitAt === null) splitAt = sections.length;
      continue;
    }
    if (isSectionDivider(raw)) {
      push();
      continue;
    }
    if (isNakedDivider(raw)) {
      push();
      cur.noSepBefore = true;
      continue;
    }
    if (isSectionTitle(raw)) {
      cur.title = raw.slice(3);
      continue;
    }
    if (isRowBreak(raw)) {
      cur.hasBreak = true;
      cur.breakLine = cur.breakLine || raw.startsWith("rl:");
      continue;
    }
    (cur.hasBreak ? cur.bottom : cur.top).push(raw);
  }
  push();

  return { sections, splitAt };
}

/** Structure → tokens, canonical form. */
export function serializeRibbon(model: RibbonModel): string[] {
  const { sections, splitAt } = model;
  const out: string[] = [];

  sections.forEach((s, i) => {
    if (i > 0) {
      out.push(
        i === splitAt
          ? `a:split-${i}`
          : s.noSepBefore
            ? `nd:sec-${i}`
            : `2!d:sec-${i}`
      );
    }
    // An empty title is emitted too — defined means present, so its
    // editable field survives a round-trip through the Customize list.
    if (s.title !== undefined) out.push(`st:${s.title}`);
    out.push(...s.top);
    if (s.hasBreak) {
      out.push(`${s.breakLine ? "rl" : "r"}:row-${i}`, ...s.bottom);
    }
  });

  return out;
}

/** What `normalizeRibbon` needs to know about the app's controls. */
export interface RibbonRegistrySnapshot {
  /** Every `b:` key that has a renderer right now. */
  builtins: string[];
  /** Built-ins that cannot be lost, whatever a saved layout says. */
  permanent: string[];
  /** Every `t:` id that resolves to a screen that exists. */
  tools: string[];
  /** Every `c:` id with a handler. */
  commands: string[];
}

/**
 * Never trust persisted tokens. Run this on every load.
 *
 * Must be IDEMPOTENT — normalize(normalize(x)) === normalize(x) — since
 * it runs against its own output on the next load.
 *
 * An item whose control doesn't exist any more is DISCARDED rather than
 * rendered empty: an empty element still measures, and a zero-width item
 * in a toolbar is a mystery gap nobody can explain. That is also the
 * retirement path — delete a registry row and the token sheds itself
 * from every saved layout on the next load. To retire a button WITHOUT
 * doing that, mark it `unlisted` instead: the row stays, so the token
 * keeps rendering, and only the palette stops offering it.
 */
export function normalizeRibbon(
  tokens: string[] | undefined,
  registry: RibbonRegistrySnapshot
): string[] {
  const known: Record<string, Set<string>> = {
    "b:": new Set(registry.builtins),
    "t:": new Set(registry.tools),
    "c:": new Set(registry.commands),
  };

  const seen = new Set<string>();
  const out: string[] = [];
  let haveSplit = false;

  for (const raw of tokens ?? []) {
    const tall = isTall(raw);
    const tok = stripTall(raw);

    // The tall flag survives only where it means something: on a `d:`
    // token, marking a section boundary. It used to ride items too.
    const keep = (t: string) =>
      out.push(tall && t.startsWith("d:") ? makeTall(t) : t);

    const prefix = tok.slice(0, 2);
    if (known[prefix]) {
      // Dedup first-wins: one of each control. A second copy of a button
      // is not something the UI can produce, so it only ever arrives
      // from hand-edited data, and `placed()` would be lying about it.
      if (!known[prefix].has(tok.slice(2)) || seen.has(tok)) continue;
      seen.add(tok);
      keep(tok);
      continue;
    }

    // At most one alignment split. A second is meaningless on parse, so
    // it becomes the plain boundary it was already behaving as.
    if (isAlignSplit(tok)) {
      if (haveSplit) {
        keep(`d:${tok.slice(2)}`);
        continue;
      }
      haveSplit = true;
    }

    keep(tok); // d: / nd: / s: / r: / rl: / st: / a:
  }

  // Re-insert any permanent control a saved layout has lost.
  for (const key of registry.permanent) {
    if (!out.some((t) => stripTall(t) === `b:${key}`)) out.push(`b:${key}`);
  }

  return out;
}
