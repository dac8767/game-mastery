"use client";

/**
 * The control that opens a row, drawn once and used by every list.
 *
 * It started in the NPC table. The Lookup tabs had their own: a `+` at
 * the far right of the row, which put the way in to an entry on the
 * opposite side of the screen from the name you were reading — so
 * scanning the list and opening something from it were a movement
 * apart. Derek asked for one gesture in the same place everywhere,
 * which only means anything if it is also the same drawing, so the
 * icon moved here rather than being copied.
 *
 * Two arrows pulling apart, not a chevron: a chevron says "there is
 * more below this", which is what the sidebar's folds and the family
 * carets say. This says "open this thing", and the two should not wear
 * the same symbol.
 *
 * Which cut the other way once the Lookup rows started expanding IN
 * PLACE: they wore this icon while doing the chevron's job, promising
 * a window and delivering a reveal. So the rule is now stated as a
 * pair, in one file:
 *
 *   ExpandIcon   clicking this REPLACES the screen — the NPC record,
 *                a session's notes, a group.
 *   CaretIcon    clicking this reveals something under the row, and
 *                the rest of the list is still there when it does.
 */
export function ExpandIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M9.5 2.5H13.5V6.5M6.5 13.5H2.5V9.5M13.5 2.5L9 7M2.5 13.5L7 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The in-place gesture's icon: a chevron, pointing right until the
 * thing it reveals is showing, then down.
 *
 * Drawn rather than the ▸ character the family sub-rows use, because
 * this one sits in the table's expand track next to rows that used to
 * wear ExpandIcon — a text glyph there renders at the label font's
 * size and weight and reads as a different control from one row to the
 * next. Rotated by CSS transform so the open and closed states cannot
 * drift apart in shape.
 */
export function CaretIcon({ open }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
      style={{
        transform: open ? "rotate(90deg)" : undefined,
        transition: "transform 120ms ease",
      }}
    >
      <path
        d="M6 3.5L11 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
