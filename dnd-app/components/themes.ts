/**
 * The themes, in one place.
 *
 * Two things offer the choice — the Settings panel and the ribbon's
 * theme control — and a theme that exists in one and not the other is a
 * palette some people can never reach. The names here must match the
 * schema's literals, the bootstrap allowlist in app/layout.tsx, and the
 * [data-theme] blocks in globals.css; tests/guards/integrity.mjs checks
 * all four agree.
 */

export type ThemeName = "candlelight" | "slate" | "parchment";

export const THEMES: {
  value: ThemeName;
  label: string;
  note: string;
}[] = [
  {
    value: "candlelight",
    label: "Candlelight",
    note: "Warm and dim — built for a dark room and a bright map.",
  },
  {
    value: "slate",
    label: "Slate",
    note: "Cool grey-blue, higher contrast for long reading.",
  },
  {
    value: "parchment",
    label: "Parchment",
    note: "Light theme for bright rooms and printing.",
  },
];
