"use client";

import { useSyncExternalStore } from "react";

/**
 * Does the viewport match a CSS media query right now?
 *
 * A subscription, not a one-off read: the answer changes when the
 * window is resized or the phone is turned, and a component that read
 * it once in an effect would be wrong until the next remount.
 *
 * On the server there is no viewport, so the answer is `false` — the
 * page hydrates in its wide layout and corrects itself in the same
 * frame the client takes over. The shell already flashes this way while
 * settings load, so this adds no flash that was not there.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
