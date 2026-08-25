/**
 * Telling a page apart from a box, by its id.
 *
 * The format toolbar knows one kind of thing: an editable region with
 * an id, which it writes back through whatever saver the screen
 * registered. A session now has three of those per side — the boxes,
 * which are rows in `sessionBoxes`, and the PAGE, which is a row in
 * `sessionPages` and reached by a different mutation.
 *
 * So the id carries which. A prefix rather than a second registry: the
 * saver gets an id and nothing else, and a lookup table it would have
 * to be kept in step with is a lookup table that will one day be out
 * of step — at which point a page edit is sent to `updateBox` with an
 * id that is not a document id, and Convex rejects it as an argument
 * validation error rather than as anything a person could read.
 *
 * Free of React and Convex so both sides of that decision can be
 * tested without either.
 */

export type NoteSide = "player" | "dm";

const PREFIX = "page:";

/** The id the page body wears on the canvas. */
export function pageBoxId(side: NoteSide): string {
  return `${PREFIX}${side}`;
}

/**
 * Which side's page this id is, or null for anything else.
 *
 * Null for a real box id, and null for a prefixed id naming a side
 * that does not exist — a saver that treated `page:everyone` as a page
 * would send "everyone" to a validator expecting one of two literals.
 */
export function pageSide(boxId: unknown): NoteSide | null {
  const id = String(boxId ?? "");
  if (!id.startsWith(PREFIX)) return null;
  const side = id.slice(PREFIX.length);
  return side === "player" || side === "dm" ? side : null;
}
