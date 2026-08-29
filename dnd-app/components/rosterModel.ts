/**
 * Who is still at the table.
 *
 * A campaign outlives the people in it. Someone moves away at session
 * 30: their character stops turning up, but the roster is the record of
 * who played and the session log still names them on the nights they
 * were there. So leaving is a FLAG rather than a delete — the row, the
 * portrait and the history all stay, and the name simply stops being
 * offered by the fields that suggest players.
 *
 * Absent means active, and that is the whole reason this is a function
 * instead of `c.active` at five call sites. Every character in the
 * database predates the field, so a truthiness test would retire the
 * entire party the moment it shipped. `false` is the only value that
 * means anything; nothing needs to write `true`, and nothing may read
 * this as `=== true`.
 */

/** A character row, as much of one as this file needs. */
export interface Rostered {
  active?: boolean | null;
  playerId?: string | null;
  playerName?: string | null;
}

export function isActive(c: Rostered): boolean {
  return c.active !== false;
}

/**
 * The accounts whose every character has been retired.
 *
 * A person is offered by the attendance field for as long as they have
 * one sheet still in play, because a player who retired a character and
 * rolled a new one has not left — that is the most ordinary thing that
 * happens in a long campaign. Only somebody whose sheets are ALL
 * inactive has actually gone.
 *
 * An account with no character at all is never in here. There is
 * nowhere to mark such a person inactive (the roster is the character
 * list), so absence of evidence must not read as evidence of absence.
 */
export function retiredPlayerIds(
  characters: readonly Rostered[] | null | undefined
): Set<string> {
  const anyActive = new Map<string, boolean>();
  for (const c of characters ?? []) {
    const id = c.playerId;
    if (!id) continue;
    anyActive.set(id, (anyActive.get(id) ?? false) || isActive(c));
  }
  const retired = new Set<string>();
  for (const [id, active] of anyActive) if (!active) retired.add(id);
  return retired;
}
