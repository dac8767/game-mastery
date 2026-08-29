/**
 * Our rolled dice, translated into what dddice can draw.
 *
 * dddice renders the throw; it does not decide it. Every die goes over
 * with a `value` already set — their API calls that "passing a
 * predetermined value (i.e. when integrating with VTTs)", which is
 * exactly what we are. Convex stays the authority on what was rolled,
 * and this file is only concerned with putting the same numbers on
 * screen in three dimensions.
 *
 * Pure on purpose: no SDK import, no DOM. The translation has three
 * ways to be quietly wrong — a percentile split into the wrong two
 * dice, a dropped die drawn as a counting one, a pool bigger than the
 * room will accept — and none of them can be seen from a screenshot,
 * because the total on our own log is right either way.
 */

import type { DieRoll } from "@/components/diceModel";

/**
 * One die as dddice wants it. A subset of their IDiceRoll: the fields
 * we set and nothing else.
 */
export interface DddiceDie {
  type: string;
  value: number;
  /** What the face should READ, when that differs from `value`. */
  value_to_display?: number;
  /** Dropped by a keep — drawn, but not counted. */
  is_dropped?: boolean;
  theme?: string;
}

/**
 * A room's default dice limit. Rooms can raise it; this is what an
 * unconfigured one accepts, and going over it is the difference
 * between a fireball that lands and one that silently does not.
 */
export const DDDICE_DIE_LIMIT = 25;

/**
 * The dice dddice has meshes for. Note the absence of a d100: a
 * percentile roll is drawn as a tens die plus a units die, which is
 * what a real table does too.
 */
const MESHES: Record<number, string> = {
  4: "d4",
  6: "d6",
  8: "d8",
  10: "d10",
  12: "d12",
  20: "d20",
};

/**
 * A d100 result, split into the two dice that show it.
 *
 * 73 is a 70 and a 3. The edges are the whole difficulty: 100 is 90
 * and 10 rather than 100 and 0, and 5 is 0 and 5 rather than 5 and 0 —
 * a naive `v % 10` puts a zero on the units die, which is a face it
 * does not have.
 */
export function splitPercentile(value: number): { tens: number; ones: number } {
  const v = Math.min(Math.max(Math.round(value), 1), 100);
  const ones = v % 10 === 0 ? 10 : v % 10;
  return { tens: v - ones, ones };
}

/**
 * The tens die's `value`, which is an INDEX rather than a face.
 *
 * dddice's d10x carries the faces [10, 20 … 90, 0] and documents
 * `value` as running 1–10 with `value_to_display` running 0–90, so the
 * two have to be sent together. This is the one part of the mapping
 * read off a field description rather than a worked example, so it is
 * isolated here where it can be corrected in one place.
 */
function tensIndex(tens: number): number {
  return tens === 0 ? 10 : tens / 10;
}

/**
 * A whole roll, ready to send — or null when dddice cannot draw it.
 *
 * Null rather than a partial roll. Half a fireball on the table is
 * worse than none: the log already shows the real result, and dice
 * that disagree with it are the one outcome worth avoiding entirely.
 */
export function toDddiceRoll(
  dice: readonly DieRoll[],
  theme?: string,
  limit: number = DDDICE_DIE_LIMIT
): DddiceDie[] | null {
  if (dice.length === 0) return null;

  const out: DddiceDie[] = [];
  for (const die of dice) {
    const mesh = MESHES[die.sides];

    if (mesh) {
      out.push({
        type: mesh,
        value: die.value,
        ...(die.kept ? {} : { is_dropped: true }),
        ...(theme ? { theme } : {}),
      });
      continue;
    }

    if (die.sides === 100) {
      const { tens, ones } = splitPercentile(die.value);
      const extra = die.kept ? {} : { is_dropped: true };
      out.push({
        type: "d10x",
        value: tensIndex(tens),
        value_to_display: tens,
        ...extra,
        ...(theme ? { theme } : {}),
      });
      out.push({
        type: "d10",
        value: ones,
        ...extra,
        ...(theme ? { theme } : {}),
      });
      continue;
    }

    // A d7 is a legal roll here and an impossible one there. Nothing
    // is drawn rather than something wrong being drawn.
    return null;
  }

  // A percentile die counts as two against the room's limit, which is
  // why this is measured on the OUTPUT rather than on the input.
  if (out.length > limit) return null;
  return out;
}
