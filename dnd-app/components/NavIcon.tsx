"use client";

/**
 * A nav item's icon: a typed character, or a drawn one.
 *
 * Almost every item in navItems.ts carries a single character — "◷",
 * "⚔", "✎" — and that is deliberately still the default. A character
 * costs nothing, inherits colour and size from the text around it, and
 * needs no component.
 *
 * Some things have no character. There is no outlined-group-of-people
 * glyph that renders the same way on two machines, and NPCs had been
 * borrowing the moon from the campaign block, which meant two different
 * things in the sidebar wore the same symbol. Those get an `art` key
 * naming a drawing here.
 *
 * The drawings live in this file rather than in navItems.ts because
 * navItems.ts is a plain .ts module that several non-React things read,
 * and JSX in it would make it a .tsx nobody could import from a script.
 * An `art` key with no drawing behind it is caught by the integrity
 * guard — otherwise it would quietly fall back to the character and the
 * icon would simply be the old one, which is exactly the change you
 * were trying to make.
 */

/**
 * The shared frame every drawing sits in.
 *
 * One place for the viewBox and the stroke, because the sidebar's icons
 * only read as a set if they are drawn at one weight. A 24-unit box
 * rendered at 15px means every coordinate below is in sixteenths of a
 * pixel, which is the resolution these are actually designed at.
 */
export function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function PeopleIcon() {
  return (
    <Glyph>
      {/* The one in front, drawn largest — the others read as "and
          others" rather than as three equal figures. */}
      <circle cx="12" cy="7" r="3.1" />
      <path d="M7.2 19.5v-2.9a4.8 4.8 0 0 1 9.6 0v2.9a2 2 0 0 1-2 2h-5.6a2 2 0 0 1-2-2Z" />
      {/* Shoulders only for the two behind, cut off at the frame the
          way a crowd is. */}
      <circle cx="4.6" cy="9.2" r="2.4" />
      <path d="M6.6 12.2a3.7 3.7 0 0 0-5.1 3.4v2.4a2 2 0 0 0 2 2h2.1" />
      <circle cx="19.4" cy="9.2" r="2.4" />
      <path d="M17.4 12.2a3.7 3.7 0 0 1 5.1 3.4v2.4a2 2 0 0 1-2 2h-2.1" />
    </Glyph>
  );
}

/** A month, with its binder rings and a grid of days. */
function CalendarIcon() {
  return (
    <Glyph>
      <rect x="3" y="5" width="18" height="16" rx="2.2" />
      {/* The header rule is what makes it a calendar rather than a
          window — without it the rings read as an aerial. */}
      <path d="M3 10h18" />
      <path d="M8 2.8v4.4M16 2.8v4.4" />
      {/* Six days, not the thirty-one a month has. Filled squares
          rather than outlined ones: at 15px an outlined 2px box is a
          grey smudge, and the source's grid survives as squares only
          because they are solid. */}
      {[12.4, 16.6].map((y) =>
        [6.2, 10.7, 15.2].map((x) => (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="2.6"
            height="2.6"
            rx="0.5"
            fill="currentColor"
            stroke="none"
          />
        ))
      )}
    </Glyph>
  );
}

/** A speech bubble, mid-sentence. */
function SpeechIcon() {
  return (
    <Glyph>
      {/* One closed path rather than a circle with a tail stuck on it:
          two shapes at this size leave a seam where they meet. */}
      <path d="M12 3a8.9 8.9 0 0 0-7.6 13.6l-1.2 3.7a.9.9 0 0 0 1.1 1.1l3.7-1.2A8.9 8.9 0 1 0 12 3Z" />
      <circle cx="8.4" cy="11.6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="11.6" r="1.15" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** A twenty, unrolled. */
function D20Icon() {
  return (
    <Glyph>
      <path d="M12 2.4 20.6 7.2v9.6L12 21.6 3.4 16.8V7.2Z" />
      {/* The face, and three edges running off it. The 20 that is
          printed on the real thing is left off: at 15px two digits
          inside a triangle are four grey pixels, and the silhouette is
          what says "die" anyway. */}
      <path d="M12 7.2 17.4 16.2H6.6Z" />
      <path d="M12 7.2V2.4M6.6 16.2 12 21.6M17.4 16.2 12 21.6" />
    </Glyph>
  );
}

/**
 * The screen you hide behind: a centre panel and two wings.
 *
 * Proportions taken off the reference rather than guessed, because they
 * are the whole picture. The wings are HALF the centre's width and
 * shifted up by nearly two fifths of its height — that steep tilt is
 * what makes three flat quadrilaterals read as a screen standing on a
 * table with its ends angled towards you. Drawn shallower and wider,
 * the same three shapes read as a folded map.
 */
function TrifoldIcon() {
  return (
    <Glyph>
      <path d="M7.2 8.8h9.6v10H7.2Z" />
      {/* Parallelograms: each wing's inner edge IS the centre panel's
          side, at its full height, with the outer edge lifted.
          Measured off the reference rather than judged by eye, because
          three numbers carry the whole picture: the centre is 46% of
          the width, each wing 27%, and the lift is 38% of the panel's
          height, in a footprint half again as wide as it is tall. */}
      <path d="M7.2 8.8 1.6 5v10l5.6 3.8" />
      <path d="M16.8 8.8 22.4 5v10l-5.6 3.8" />
    </Glyph>
  );
}

/** A magnifying glass: the thing you look something up with. */
function SearchIcon() {
  return (
    <Glyph>
      <circle cx="10.5" cy="10.5" r="6.6" />
      <path d="M15.4 15.4 20.8 20.8" />
    </Glyph>
  );
}

/**
 * Two chevrons pointing back, for the way out of a campaign.
 *
 * Exported rather than in the ART map: it is not a nav item's icon, so
 * nothing would ever ask for it by name and the guard would rightly
 * call it a drawing nobody uses. It goes through Glyph like the rest,
 * which is the part that matters — it sits inches from five icons that
 * would look wrong beside it at a different weight.
 */
export function BackIcon() {
  return (
    <Glyph>
      <path d="M11 5 4 12l7 7M19 5l-7 7 7 7" />
    </Glyph>
  );
}

/** A ring-bound notepad, ruled. */
function NotepadIcon() {
  return (
    <Glyph>
      <rect x="6" y="2.5" width="15.5" height="19" rx="2.2" />
      {/* Three bindings and three rules, not the five of each the
          reference has. At 15px ten horizontal strokes inside a 19-unit
          box is a grey hatch; three is a ruled pad. They share their
          rows on purpose — a binding and its line read as one band
          crossing the spine, which is what a ring binder looks like. */}
      <path d="M3.8 7h4.4M3.8 12h4.4M3.8 17h4.4" />
      <path d="M10.6 7h7.6M10.6 12h7.6M10.6 17h7.6" />
    </Glyph>
  );
}

/**
 * Every drawing, by the name an item's `art` key uses.
 *
 * The names describe the DRAWING, not the screen: "people" rather than
 * "npcs", "trifold" rather than "dm-screen". Two items could reasonably
 * want the same picture, and a name that says which screen it belongs
 * to would make the second one read as a mistake.
 */
const ART: Record<string, () => React.JSX.Element> = {
  people: PeopleIcon,
  calendar: CalendarIcon,
  speech: SpeechIcon,
  d20: D20Icon,
  trifold: TrifoldIcon,
  notepad: NotepadIcon,
  search: SearchIcon,
};

/** The names a nav item may ask for, for the guard to check against. */
export const ART_NAMES = Object.keys(ART);

export function NavIcon({
  icon,
  art,
  className = "nav-icon",
}: {
  icon: string;
  art?: string;
  className?: string;
}) {
  const Drawn = art ? ART[art] : undefined;
  return (
    <span className={className}>{Drawn ? <Drawn /> : icon}</span>
  );
}
