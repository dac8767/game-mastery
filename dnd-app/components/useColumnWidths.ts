"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-to-resize column widths for any table in the app.
 *
 * Widths persist per table in localStorage, so a layout you set up for
 * reading the roster survives a reload and a restart. Kept generic
 * (`storageKey` + a defaults map) so the next table — encounters, the
 * map library — reuses it instead of reimplementing the drag maths.
 *
 * Pair with `table-layout: fixed` and a <colgroup>; without fixed layout
 * the browser treats widths as suggestions and content overrides them.
 */

/** Never let a column collapse to unusable. */
const MIN_WIDTH = 56;

export function useColumnWidths(
  storageKey: string,
  defaults: Record<string, number>
) {
  const [widths, setWidths] = useState<Record<string, number>>(defaults);

  // Always-current mirror so the pointer handlers don't capture a stale
  // widths object mid-drag.
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const hydrated = useRef(false);

  // Load saved widths after mount — localStorage doesn't exist during
  // the server render.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, number>;
        setWidths((cur) => {
          const next = { ...cur };
          for (const [k, v] of Object.entries(saved)) {
            // Ignore stale keys from a since-changed column set.
            if (k in cur && typeof v === "number" && v >= MIN_WIDTH) {
              next[k] = v;
            }
          }
          return next;
        });
      }
    } catch {
      // Private browsing or corrupt JSON — defaults are fine.
    }
    hydrated.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Not worth surfacing: the table still works, it just won't
      // remember the layout.
    }
  }, [storageKey, widths]);

  const startResize = useCallback(
    (key: string, event: React.PointerEvent<HTMLElement>) => {
      // Stop the header's sort handler from firing on the drag.
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = widthsRef.current[key] ?? MIN_WIDTH;

      const onMove = (e: PointerEvent) => {
        const next = Math.max(MIN_WIDTH, startWidth + (e.clientX - startX));
        setWidths((w) => ({ ...w, [key]: next }));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("col-resizing");
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.classList.add("col-resizing");
    },
    []
  );

  /** Double-click a handle to send one column back to its default. */
  const resetColumn = useCallback(
    (key: string) => {
      setWidths((w) => ({ ...w, [key]: defaults[key] ?? MIN_WIDTH }));
    },
    [defaults]
  );

  const resetAll = useCallback(() => setWidths(defaults), [defaults]);

  return { widths, startResize, resetColumn, resetAll };
}
