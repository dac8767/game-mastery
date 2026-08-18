"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Keeps the document's theme in step with the signed-in person's
 * settings, and mirrors it to localStorage so the bootstrap script in
 * app/layout.tsx can apply it before the next load paints.
 *
 * Renders nothing. Themes are personal — one player switching to slate
 * changes nothing for anyone else, because the value is read from that
 * person's own userSettings row.
 *
 * Critically, this does NOT apply a default while the query is in
 * flight. Writing "candlelight" during loading would stamp over what the
 * bootstrap already applied correctly, which is the flash it exists to
 * prevent.
 */
export function ThemeSync() {
  const settings = useQuery(api.settings.mySettings);

  useEffect(() => {
    const theme = settings?.theme;
    if (!theme) return; // still loading — leave the bootstrap's value alone

    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("gm-theme", theme);
    } catch {
      // Private browsing or quota. The theme still applies this session;
      // it just won't pre-apply on the next load.
    }
  }, [settings]);

  return null;
}
