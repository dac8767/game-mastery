/**
 * The four alignment buttons, drawn.
 *
 * They were characters — ⯇ ≡ ⯈ ☰ — and two of those have no glyph in
 * the fonts this app ships, so the browser substituted whatever it had.
 * On screen the row read ▤ ≡ ▤ ≡: four buttons, two shapes, and no way
 * to tell left from right without hovering each one for its tooltip.
 *
 * Drawn instead, from the icons Derek supplied. Four bars, and the
 * SECOND and FOURTH are what carry the meaning — the long ones are the
 * same in all four, and it is where the short lines sit that says which
 * alignment this is. Justify has no short line at all, which is exactly
 * what justified text looks like.
 *
 * One `<svg>`, in one frame, with the four sets of bars as data. Four
 * hand-written SVGs would drift in stroke weight the first time one was
 * touched, and a toolbar of icons that do not match is worse than the
 * characters were.
 */

export type AlignKind = "left" | "center" | "right" | "justify";

/**
 * A bar's ends, in the 512 box the source icons were drawn in.
 *
 * Inset by half the stroke: a round cap reaches 24 past its endpoint,
 * so a bar that should paint from 45 to 467 is a line from 69 to 443.
 * Getting this wrong is not a crash, it is four icons whose margins do
 * not line up with anything else on the bar.
 */
const FULL: [number, number] = [69, 443];
const SHORT_LEFT: [number, number] = [69, 321];
const SHORT_CENTER: [number, number] = [129, 383];
const SHORT_RIGHT: [number, number] = [191, 443];

/** Which bar is which, per alignment. Rows top to bottom. */
const BARS: Record<AlignKind, [number, number][]> = {
  left: [FULL, SHORT_LEFT, FULL, SHORT_LEFT],
  center: [FULL, SHORT_CENTER, FULL, SHORT_CENTER],
  right: [FULL, SHORT_RIGHT, FULL, SHORT_RIGHT],
  justify: [FULL, FULL, FULL, FULL],
};

/** Where the four bars sit, evenly down the box. */
const ROWS = [82, 198, 314, 430];

export function AlignIcon({ kind }: { kind: AlignKind }) {
  return (
    <svg
      className="align-icon"
      viewBox="0 0 512 512"
      // Decorative: every one of these sits in a button that already
      // has a title, and a second reading of "align left" is noise.
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={48}
      strokeLinecap="round"
    >
      {BARS[kind].map(([x1, x2], i) => (
        <line key={i} x1={x1} x2={x2} y1={ROWS[i]} y2={ROWS[i]} />
      ))}
    </svg>
  );
}
