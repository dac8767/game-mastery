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

function PeopleIcon() {
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
    </svg>
  );
}

/** Every drawing, by the name an item's `art` key uses. */
const ART: Record<string, () => React.JSX.Element> = {
  people: PeopleIcon,
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
