/**
 * The combat tracker's arithmetic, with nothing imported.
 *
 * Pure so the unit guard can exercise it directly, and shared by
 * convex/combat.ts so the mutations cannot drift from what is tested.
 *
 * Every number a GM types arrives as `v.number()`, which accepts NaN,
 * Infinity, fractions and negatives. A NaN initiative sorts nowhere
 * (every comparison is false), and a negative max HP becomes a negative
 * healing cap that drags a creature below zero when healed — so each
 * value is checked here before it is stored, and a bad one is refused
 * rather than clamped into something the GM did not type.
 */

/** Largest value any combat number may take. Generous: a tarrasque has 676 HP. */
export const COMBAT_NUMBER_MAX = 100_000;

function wholeNumber(label: string, value: number, min: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number`);
  }
  if (value < min || value > COMBAT_NUMBER_MAX) {
    throw new Error(`${label} must be between ${min} and ${COMBAT_NUMBER_MAX}`);
  }
  return value;
}

/** Max HP: at least 1 — a creature with no hit points is not in the fight. */
export function checkMaxHp(value: number): number {
  return wholeNumber("Max HP", value, 1);
}

/** Temporary HP: zero or more. */
export function checkTempHp(value: number): number {
  return wholeNumber("Temporary HP", value, 0);
}

/** Armour class: zero or more. */
export function checkAc(value: number): number {
  return wholeNumber("AC", value, 0);
}

/**
 * Initiative and its tiebreak: may be negative (a roll of 1 with a -2
 * Dex modifier is -1), but must be a number that sorts.
 */
export function checkInitiative(value: number, label = "Initiative"): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number`);
  if (Math.abs(value) > COMBAT_NUMBER_MAX) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

/** A damage or healing amount: a whole number. Negative is healing. */
export function checkHpChange(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("Damage or healing must be a whole number");
  }
  if (Math.abs(value) > COMBAT_NUMBER_MAX) {
    throw new Error("Damage or healing is out of range");
  }
  return value;
}

export interface HpState {
  currentHp: number;
  tempHp: number;
  maxHp: number;
}

/**
 * Damage (positive) or healing (negative), per the rules as written.
 *
 * Damage is taken from temporary HP first, then current HP, which stops
 * at 0. Healing never touches temporary HP and never passes max HP.
 */
export function applyHpChange(
  state: HpState,
  amount: number
): { currentHp: number; tempHp: number } {
  let { currentHp, tempHp } = state;
  if (amount > 0) {
    const fromTemp = Math.min(tempHp, amount);
    tempHp -= fromTemp;
    currentHp = Math.max(0, currentHp - (amount - fromTemp));
  } else if (amount < 0) {
    currentHp = Math.min(state.maxHp, currentHp - amount);
  }
  return { currentHp, tempHp };
}

/**
 * Whose turn is next, given the turn order and whose turn it is now.
 *
 * `excluding` is a combatant about to be removed: they are skipped, so
 * removing the active combatant hands the turn on rather than back to
 * themselves. With nobody left, there is no active combatant — never a
 * pointer at a row that is about to be deleted.
 */
export function nextTurn<Id>(
  order: readonly Id[],
  active: Id | undefined,
  excluding?: Id
): { active: Id | undefined; wrapped: boolean } {
  const idx = active === undefined ? -1 : order.indexOf(active);
  for (let step = 1; step <= order.length; step++) {
    const next = idx === -1 ? step - 1 : (idx + step) % order.length;
    if (order[next] === excluding) continue;
    // The round turns over when the order wraps back past the top.
    const wrapped = idx !== -1 && idx + step >= order.length;
    return { active: order[next], wrapped };
  }
  return { active: undefined, wrapped: false };
}
