"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  LOOKUP_COLUMNS,
  LookupKind,
  MIN_LOOKUP_COL,
} from "@/components/lookupFields";

/**
 * One person's column widths for one Lookup table.
 *
 * Stored in Convex through the same viewPrefs row the NPC grid uses,
 * for the reason recorded there: a layout should follow you between the
 * laptop and the desktop, and "my view, not yours" is then enforced by
 * the query rather than by which browser you are sitting at. The view
 * key is per kind, so widening Range on Spells does not narrow Rarity
 * on Items.
 *
 * Writes are debounced. A drag fires a state update per pixel and must
 * not fire a mutation per pixel — on the free tier that is the one
 * thing worth being careful about.
 *
 * Only columns someone has actually dragged are stored. There is no
 * "unset" width to encode, so a column dropped from LOOKUP_COLUMNS
 * later just stops being mentioned rather than leaving a zero behind
 * that would read as a pinned, invisible column.
 */

const SAVE_DEBOUNCE_MS = 800;

export interface LookupLayout {
  widths: Record<string, number>;
  resize: (key: string, width: number) => void;
  reset: (key: string) => void;
}

export function useLookupLayout(
  campaignId: Id<"campaigns">,
  kind: LookupKind
): LookupLayout {
  const view = `lookup:${kind}`;

  const saved = useQuery(api.views.getViewPrefs, { campaignId, view });
  const save = useMutation(api.views.saveViewPrefs);

  const [widths, setWidths] = useState<Record<string, number>>({});

  // Which view the current widths belong to, rather than a boolean:
  // moving between Spells and Items reuses this hook, and a boolean
  // would leave the first table's widths applied to the second.
  const loadedFor = useRef<string | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    if (loadedFor.current === view) return;

    if (saved === undefined) {
      // Still loading a different table's row. Drop what is on screen so
      // the wrong widths are never briefly applied.
      setWidths((cur) => (Object.keys(cur).length === 0 ? cur : {}));
      return;
    }

    const known = new Set(LOOKUP_COLUMNS[kind].map((c) => c.key));
    const next: Record<string, number> = {};
    for (const c of saved?.columns ?? []) {
      // A key that is no longer a column is dropped rather than carried
      // — a renamed column would otherwise pin a track that no longer
      // exists and shift every column after it.
      if (!known.has(c.key)) continue;
      if (!Number.isFinite(c.width) || c.width <= 0) continue;
      next[c.key] = Math.max(MIN_LOOKUP_COL, Math.round(c.width));
    }

    setWidths(next);
    loadedFor.current = view;
  }, [saved, view, kind]);

  useEffect(() => {
    if (loadedFor.current !== view || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      void save({
        campaignId,
        view,
        columns: Object.entries(widths).map(([key, width]) => ({
          key,
          width,
          // Lookup has no column picker; every column always shows. The
          // field is required by the shared validator.
          visible: true,
        })),
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [widths, campaignId, view, save]);

  const resize = useCallback((key: string, width: number) => {
    dirty.current = true;
    setWidths((cur) => ({
      ...cur,
      [key]: Math.max(MIN_LOOKUP_COL, Math.round(width)),
    }));
  }, []);

  const reset = useCallback((key: string) => {
    dirty.current = true;
    setWidths((cur) => {
      if (!(key in cur)) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });
  }, []);

  return { widths, resize, reset };
}
