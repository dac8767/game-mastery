import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Table View",
  description: "D&D campaign player app — live map and combat tracker",
};

export const viewport: Viewport = {
  themeColor: "#141210",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning on <html> only: browser extensions stamp
    // attributes onto the root element before React hydrates (a screen
    // recorder adding data-scribe-recorder-ready, password managers,
    // dark-mode forcers), and ThemeSync sets data-theme from the signed-in
    // person's settings after mount. Neither is a real mismatch, and the
    // warning is not suppressed for anything inside <body>, where a
    // mismatch would mean an actual bug.
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
