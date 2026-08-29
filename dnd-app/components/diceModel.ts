/**
 * Dice notation: parsing it, rolling it, and reading the result back.
 *
 * Everything here is pure arithmetic over an injected random source —
 * no React, no DOM, no Convex — so the unit guard can exercise the
 * parts that go wrong invisibly. A dice roller's failures are all
 * quiet ones: "4d6kh3" that keeps the lowest three, a modifier that
 * gets dropped, a d100 that can roll 0 or 101. Nobody notices at the
 * table; they just get a character with bad stats.
 *
 * The notation is the subset a D&D table actually types:
 *
 *   d20            one twenty-sided die
 *   2d6+3          two six-sided dice, plus three
 *   4d6kh3         four d6, keep the highest three — a stat roll
 *   2d20kh1        advantage.  2d20kl1 is disadvantage
 *   1d8+1d6-2      as many terms as you like
 *
 * `parseRoll` returns null rather than throwing: the input is a text
 * box, and a typo is an ordinary thing for a person to do, not an
 * exception for the caller to catch.
 */

/** One term of a roll: a group of dice, or a flat number. */
export type RollTerm =
  | {
      kind: "dice";
      sign: 1 | -1;
      count: number;
      sides: number;
      /** "keep highest 3" and the like. Null when every die counts. */
      keep: { mode: "high" | "low"; n: number } | null;
    }
  | { kind: "flat"; sign: 1 | -1; value: number };

export interface ParsedRoll {
  terms: RollTerm[];
  /** The notation as it will be shown and stored, tidied up. */
  notation: string;
}

export interface DieRoll {
  sides: number;
  value: number;
  /** False for a die dropped by a keep — shown struck through. */
  kept: boolean;
}

export interface RolledTerm {
  term: RollTerm;
  dice: DieRoll[];
  /** This term's contribution to the total, sign included. */
  subtotal: number;
}

export interface RollResult {
  notation: string;
  terms: RolledTerm[];
  total: number;
}

/**
 * Ceilings, so one pasted string cannot ask for a million dice. The
 * roll is stored and re-sent to every subscriber, so the cost of a
 * silly roll is paid by the whole table.
 */
export const MAX_DICE = 100;
export const MAX_SIDES = 1000;
export const MAX_TERMS = 12;
export const MAX_FLAT = 10000;

/** The dice a table actually owns, for the quick-roll buttons. */
export const STANDARD_DICE = [4, 6, 8, 10, 12, 20, 100] as const;

/**
 * One term at a time: an optional sign, then either NdM (with an
 * optional keep) or a plain number. Anchored by the caller walking the
 * string, so trailing junk is a parse failure rather than ignored.
 */
const TERM =
  /^([+-]?)\s*(?:(\d*)\s*d\s*(\d+)(?:\s*k\s*([hl])\s*(\d+))?|(\d+))\s*/i;

/**
 * Notation to terms, or null if it is not notation.
 *
 * The FIRST term may omit its sign; every later one must have one, so
 * "2d6 3" is a typo rather than a silent 2d6+3.
 */
export function parseRoll(input: string): ParsedRoll | null {
  let rest = String(input ?? "").trim().toLowerCase();
  if (rest === "") return null;

  const terms: RollTerm[] = [];
  let dice = 0;
  let first = true;

  while (rest !== "") {
    if (terms.length >= MAX_TERMS) return null;

    const m = TERM.exec(rest);
    if (!m) return null;

    const [, rawSign, rawCount, rawSides, keepMode, rawKeep, rawFlat] = m;
    if (!first && rawSign === "") return null;
    const sign: 1 | -1 = rawSign === "-" ? -1 : 1;

    if (rawFlat !== undefined) {
      const value = Number(rawFlat);
      if (!Number.isInteger(value) || value > MAX_FLAT) return null;
      terms.push({ kind: "flat", sign, value });
    } else {
      // "d20" means one die; "0d6" means nothing and is a typo.
      const count = rawCount === "" ? 1 : Number(rawCount);
      const sides = Number(rawSides);
      if (count < 1 || sides < 2 || sides > MAX_SIDES) return null;
      dice += count;
      if (dice > MAX_DICE) return null;

      let keep: { mode: "high" | "low"; n: number } | null = null;
      if (keepMode !== undefined) {
        const n = Number(rawKeep);
        // Keeping more dice than you rolled is a mistake worth naming,
        // not something to quietly clamp.
        if (n < 1 || n > count) return null;
        keep = { mode: keepMode === "h" ? "high" : "low", n };
      }
      terms.push({ kind: "dice", sign, count, sides, keep });
    }

    rest = rest.slice(m[0].length);
    first = false;
  }

  if (terms.length === 0) return null;
  return { terms, notation: formatNotation(terms) };
}

/** The terms written back out, so what is stored is normalised. */
export function formatNotation(terms: readonly RollTerm[]): string {
  return terms
    .map((t, i) => {
      // The leading "+" is noise on the first term and required on
      // every other, so that a re-parse of this string sees the same
      // terms the caller had.
      const sign = t.sign === -1 ? "-" : i === 0 ? "" : "+";
      const body =
        t.kind === "flat"
          ? String(t.value)
          : `${t.count}d${t.sides}` +
            (t.keep ? `k${t.keep.mode === "high" ? "h" : "l"}${t.keep.n}` : "");
      return `${sign}${body}`;
    })
    .join("");
}

/**
 * A parsed roll, rolled.
 *
 * `random` returns a float in [0, 1) — Math.random in the app, a fixed
 * sequence in the guard. Injected rather than reached for, because a
 * roller that cannot be replayed cannot be tested.
 */
export function rollParsed(
  parsed: ParsedRoll,
  random: () => number
): RollResult {
  const terms: RolledTerm[] = [];
  let total = 0;

  for (const term of parsed.terms) {
    if (term.kind === "flat") {
      const subtotal = term.sign * term.value;
      total += subtotal;
      terms.push({ term, dice: [], subtotal });
      continue;
    }

    const dice: DieRoll[] = [];
    for (let i = 0; i < term.count; i++) {
      const value = Math.floor(random() * term.sides) + 1;
      // A random source that misbehaves must not produce a d20 of 21.
      dice.push({
        sides: term.sides,
        value: Math.min(Math.max(value, 1), term.sides),
        kept: true,
      });
    }

    if (term.keep) {
      // Rank by value, then mark the losers — the dice stay in rolled
      // order so the log shows them as they landed.
      const order = dice
        .map((d, i) => ({ i, value: d.value }))
        .sort((a, b) =>
          term.keep!.mode === "high" ? b.value - a.value : a.value - b.value
        );
      for (const { i } of order.slice(term.keep.n)) dice[i].kept = false;
    }

    const kept = dice.filter((d) => d.kept).reduce((a, d) => a + d.value, 0);
    const subtotal = term.sign * kept;
    total += subtotal;
    terms.push({ term, dice, subtotal });
  }

  return { notation: parsed.notation, terms, total };
}

/** Parse and roll in one go. Null when the notation does not parse. */
export function roll(
  notation: string,
  random: () => number
): RollResult | null {
  const parsed = parseRoll(notation);
  return parsed === null ? null : rollParsed(parsed, random);
}

/**
 * The faces, flattened, for storage and for the log. Dropped dice are
 * kept — seeing the 2 you dropped is half the pleasure of 4d6kh3.
 */
export function allDice(result: RollResult): DieRoll[] {
  return result.terms.flatMap((t) => t.dice);
}

/**
 * A d20 that came up 20 or 1, which the table cares about more than
 * the total. Only ever true for a SINGLE scoring d20 — "8d20" has no
 * crit, and neither does a d20 that was dropped by a keep.
 *
 * Takes the flat dice rather than a RollResult, because the log reads
 * this off a stored row and the roller reads it off a fresh throw.
 * Two implementations of "is this a crit" would disagree eventually,
 * and the one on screen is the one people cheer at.
 */
export function critOfDice(dice: readonly DieRoll[]): "high" | "low" | null {
  const scoring = dice.filter((d) => d.sides === 20 && d.kept);
  if (scoring.length !== 1) return null;
  if (scoring[0].value === 20) return "high";
  if (scoring[0].value === 1) return "low";
  return null;
}

/** The same question, asked of a roll that has just been made. */
export function critOf(result: RollResult): "high" | "low" | null {
  return critOfDice(allDice(result));
}

/** "2d6+3 → 4, 5 +3" — the roll read back in one line. */
export function describe(result: RollResult): string {
  const parts = result.terms.map((t) => {
    if (t.term.kind === "flat") {
      return `${t.term.sign === -1 ? "−" : "+"}${t.term.value}`;
    }
    const faces = t.dice
      .map((d) => (d.kept ? String(d.value) : `(${d.value})`))
      .join(", ");
    return `${t.term.sign === -1 ? "−" : ""}${faces}`;
  });
  return `${result.notation} → ${parts.join(" ")} = ${result.total}`;
}
