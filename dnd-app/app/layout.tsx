import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  // The browser tab, everywhere. No page sets its own title, so this one
  // string is what every tab says — which is the point: you find the tab
  // by the app's name, not by whichever screen you left open in it.
  //
  // The tab's ICON is app/icon.svg. Next's file convention emits the
  // <link rel="icon"> for it, which is why nothing here references it.
  title: "Game Mastery",
  description: "D&D campaign app — live map, combat tracker and DM tools",
};

export const viewport: Viewport = {
  themeColor: "#141210",
};

/**
 * Applies the remembered theme before the first paint.
 *
 * The real source of truth is the person's userSettings row, but that
 * needs auth plus a round trip — long enough to paint the default theme
 * first and then visibly repaint. This reads a localStorage mirror
 * synchronously, so the very first frame is already correct.
 *
 * The value is checked against the known themes rather than trusted:
 * localStorage is writable by anything running on the origin, and this
 * writes into a DOM attribute.
 *
 * A brand-new browser has no mirror yet and briefly shows the default
 * until the query lands. That is once per device, not once per load.
 */
const THEME_BOOTSTRAP = `(function(){try{
var t=localStorage.getItem('gm-theme');
if(t==='candlelight'||t==='slate'||t==='parchment'){
document.documentElement.setAttribute('data-theme',t);}
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning on <html> only: browser extensions stamp
    // attributes onto the root element before React hydrates (a screen
    // recorder adding data-scribe-recorder-ready, password managers,
    // dark-mode forcers), and the bootstrap below sets data-theme. Neither
    // is a real mismatch, and the warning is not suppressed for anything
    // inside <body>, where a mismatch would mean an actual bug.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* First thing in the document, so it runs before any paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
