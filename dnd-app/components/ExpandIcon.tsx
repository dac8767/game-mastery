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
