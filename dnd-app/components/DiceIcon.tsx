"use client";

/**
 * The seven dice, drawn.
 *
 * A tray of buttons reading "d4 d6 d8 d10 d12 d20 d100" is a list of
 * words. A tray of SHAPES is a handful of dice, and picking one out of
 * it is the thing a player already knows how to do with their hands.
 * That difference is most of why a dice roller feels like a dice roller
 * rather than a calculator.
 *
 * Each die is its real silhouette — the triangle, the cube, the two
 * pyramids of a d8, the kite of a d10, the hexagon of a d20 — with the
 * number printed on it the way it is printed on the plastic. The number
 * matters: at tray size a d8 and a d10 are two similar diamonds, and
 * the digit is what tells them apart in the half-second somebody spends
 * looking.
 *
 * Drawn in one 24-unit box at one stroke weight, for the same reason
 * NavIcon's are: seven shapes only read as a set if they are drawn like
 * a set.
 */

/**
 * The shared frame. `currentColor` throughout, so the button themes it.
 *
 * `ty` is the numeral's baseline, per shape rather than shared: a
 * triangle, a pentagon and a kite have their open space in different
 * places, and one baseline for all seven put the 4 on the d4's bottom
 * edge and the 8 across the d8's waist. The digit has to sit in the
 * clear part of its own silhouette.
 */
function Die({
  children,
  label,
  ty = 15,
}: {
  children: React.ReactNode;
  label: string;
  ty?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
      <text
        x="12"
        y={ty}
        textAnchor="middle"
        fontSize="7.5"
        // The digits are the one part that must not be hairline — a
        // stroked "20" at this size fills in and reads as a blob.
        stroke="none"
        fill="currentColor"
        fontWeight="600"
      >
        {label}
      </text>
    </svg>
  );
}

/** Tetrahedron: one triangle, with the near edges running to the apex. */
function D4() {
  return (
    <Die label="4" ty={17}>
      <path d="M12 2.5 21.5 19.5H2.5Z" />
    </Die>
  );
}

/** Cube, turned very slightly so it is a die and not a checkbox. */
function D6() {
  return (
    <Die label="6" ty={15}>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="3" />
    </Die>
  );
}

/** Octahedron: two pyramids meeting at a waist. */
function D8() {
  return (
    <Die label="8" ty={15}>
      <path d="M12 2.2 20.5 12 12 21.8 3.5 12Z" />
    </Die>
  );
}

/** Pentagonal trapezohedron — the kite everyone calls a d10. */
function D10() {
  return (
    <Die label="10" ty={14}>
      <path d="M12 2.2 20.8 9.6 12 21.8 3.2 9.6Z" />
    </Die>
  );
}

/** The percentile die: a d10 wearing two zeroes. */
function D100() {
  return (
    <Die label="00" ty={14}>
      <path d="M12 2.2 20.8 9.6 12 21.8 3.2 9.6Z" />
    </Die>
  );
}

/** Dodecahedron, as its pentagonal outline. */
function D12() {
  return (
    <Die label="12" ty={15}>
      <path d="M12 2.2 21.3 9 17.7 20.2H6.3L2.7 9Z" />
    </Die>
  );
}

/** Icosahedron: the hexagon with the face you actually read. */
function D20() {
  return (
    <Die label="20" ty={15}>
      <path d="M12 2.2 20.6 7.1v9.8L12 21.8 3.4 16.9V7.1Z" />
    </Die>
  );
}

const SHAPES: Record<number, () => React.JSX.Element> = {
  4: D4,
  6: D6,
  8: D8,
  10: D10,
  12: D12,
  20: D20,
  100: D100,
};

/**
 * The die for `sides`, or null when there is no drawing for it.
 *
 * Null rather than a fallback shape: a d30 drawn as a d20 is a lie the
 * tray tells silently, and only STANDARD_DICE are ever put in the tray.
 */
export function DiceIcon({ sides }: { sides: number }) {
  const Shape = SHAPES[sides];
  return Shape ? <Shape /> : null;
}

/** The sizes that have a drawing, for the guard to check against. */
export const DICE_ICON_SIDES = Object.keys(SHAPES).map(Number);
