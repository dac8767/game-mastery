"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Applies the signed-in person's theme by stamping `data-theme` on the
 * document root; every palette is a block of CSS variables keyed off
 * that attribute.
 *
 * Renders nothing. Themes are personal — one player switching to slate
 * changes nothing for anyone else, because the value is read from that
 * person's own userSettings row.
 */
export function ThemeSync() {
  const settings = useQuery(api.settings.mySettings);

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? "candlelight";
  }, [settings]);

  return null;
}
