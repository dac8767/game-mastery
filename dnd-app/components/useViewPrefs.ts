"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  COLUMNS,
  ColumnDef,
  ColumnState,
  reconcileColumns,
} from "@/components/npcColumns";
import { Conjunction, FilterCondition } from "@/components/npcFilters";

/**
 * One person's layout for one table, synced to Convex.
 *
 * Server-side rather than localStorage so a layout follows you between
 * machines, and because "my view, not yours" is then enforced by the
 * query rather than by which browser you happen to be sitting at.
 *
 * Writes are debounced: dragging a column border fires a state update
 * per pixel and must not fire a mutation per pixel. Only changes the
 * person actually made are saved — hydrating from the server never
 * echoes straight back as a write.
 */

const SAVE_DEBOUNCE_MS = 800;

/**
 * The layout a view starts from, when it does not say otherwise.
 *
 * "name" is the NPC roster's and the Groups screen's. Sessions have no
 * name — the primary column is a NUMBER — so a view may pass its own,
 * and the hook hands whatever it settled on back out. The toolbar has
 * to answer "is a sort applied?" to decide whether to badge the Sort
 * button, and that question is only meaningful against the default this
 * view actually started from; a literal in the toolbar would report
 * "sorted" forever on any view whose default is not "name".
 */
export const DEFAULT_SORT_KEY = "name";
export const DEFAULT_SORT_ASC = true;

export function useViewPrefs(
  campaignId: Id<"campaigns">,
  view: string,
  isDm: boolean,
  /**
   * The field set this view arranges. Defaults to the NPC roster's,
   * which is the view this hook was written for; the Groups screen is
   * the same table over its own columns and passes them here.
   */
  columns: ColumnDef[] = COLUMNS,
  /** The sort this view starts from, for a view whose primary is not a name. */
  defaultSort: { key: string; asc: boolean } = {
    key: DEFAULT_SORT_KEY,
    asc: DEFAULT_SORT_ASC,
  }
) {
  const saved = useQuery(api.views.getViewPrefs, { campaignId, view });
  const save = useMutation(api.views.saveViewPrefs);

  const [columnState, setColumnsRaw] = useState<ColumnState[]>(() =>
    reconcileColumns(null, isDm, columns)
  );
  const [sortKey, setSortKeyRaw] = useState(defaultSort.key);
  const [sortAsc, setSortAscRaw] = useState(defaultSort.asc);
  const [groupBy, setGroupByRaw] = useState("");
  const [filters, setFiltersRaw] = useState<FilterCondition[]>([]);
  const [filterConjunction, setFilterConjunctionRaw] =
    useState<Conjunction>("and");
  const [viewMode, setViewModeRaw] = useState<"grid" | "tiles">("grid");
  const [tilesPerRow, setTilesPerRowRaw] = useState(4);
  /**
   * The expand column's width, when somebody has dragged it. Null is
   * "the default", which each table supplies (they share EXPAND_COL).
   *
   * Persisted as a pseudo-column "_expand" INSIDE the saved columns
   * array — the validator already accepts any {key, width, visible},
   * so the divider needed no schema change. reconcileColumns drops
   * unknown keys, which is right for real columns and would silently
   * eat this one; it is pulled out before reconcile runs and appended
   * back on save.
   */
  const [expandWidth, setExpandWidthRaw] = useState<number | null>(null);

  const hydrated = useRef(false);
  const dirty = useRef(false);
  const lastIsDm = useRef(isDm);

  // ---- hydrate once, from whatever the server has -------------------
  useEffect(() => {
    if (saved === undefined || hydrated.current) return;

    const savedExpand = saved?.columns?.find((c) => c.key === "_expand");
    if (savedExpand && Number.isFinite(savedExpand.width)) {
      setExpandWidthRaw(Math.max(34, Math.round(savedExpand.width)));
    }
    setColumnsRaw(reconcileColumns(saved?.columns ?? null, isDm, columns));
    if (saved) {
      setSortKeyRaw(saved.sortKey ?? defaultSort.key);
      setSortAscRaw(saved.sortAsc ?? defaultSort.asc);
      setGroupByRaw(saved.groupBy ?? "");
      setFiltersRaw(
        saved.filters.map((f) => ({
          field: f.field,
          operator: f.operator,
          values: f.values,
        }))
      );
      setFilterConjunctionRaw(saved.filterConjunction ?? "and");
      setViewModeRaw(saved.viewMode ?? "grid");
      setTilesPerRowRaw(saved.tilesPerRow ?? 4);
    }
    hydrated.current = true;
  }, [saved, isDm, columns, defaultSort.key, defaultSort.asc]);

  // A DM flipping into the player preview loses the DM-only columns;
  // flipping back restores them. Not a change the person "made", so it
  // deliberately does not mark the layout dirty.
  useEffect(() => {
    if (lastIsDm.current === isDm) return;
    lastIsDm.current = isDm;
    setColumnsRaw((cur) => reconcileColumns(cur, isDm, columns));
  }, [isDm, columns]);

  // ---- debounced save of anything the person changed ----------------
  useEffect(() => {
    if (!hydrated.current || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      void save({
        campaignId,
        view,
        columns:
          expandWidth === null
            ? columnState
            : [
                ...columnState,
                { key: "_expand", width: expandWidth, visible: true },
              ],
        sortKey,
        sortAsc,
        groupBy: groupBy || undefined,
        filters,
        filterConjunction,
        viewMode,
        tilesPerRow,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [
    columnState,
    expandWidth,
    sortKey,
    sortAsc,
    groupBy,
    filters,
    filterConjunction,
    viewMode,
    tilesPerRow,
    campaignId,
    view,
    save,
  ]);

  const touch = () => {
    dirty.current = true;
  };

  const setColumns = useCallback(
    (next: ColumnState[] | ((cur: ColumnState[]) => ColumnState[])) => {
      touch();
      setColumnsRaw(next);
    },
    []
  );
  const setSortKey = useCallback((k: string) => {
    touch();
    setSortKeyRaw(k);
  }, []);
  const setSortAsc = useCallback(
    (v: boolean | ((cur: boolean) => boolean)) => {
      touch();
      setSortAscRaw(v);
    },
    []
  );
  const setGroupBy = useCallback((k: string) => {
    touch();
    setGroupByRaw(k);
  }, []);
  const setFilters = useCallback(
    (
      next:
        | FilterCondition[]
        | ((cur: FilterCondition[]) => FilterCondition[])
    ) => {
      touch();
      setFiltersRaw(next);
    },
    []
  );
  const setFilterConjunction = useCallback((c: Conjunction) => {
    touch();
    setFilterConjunctionRaw(c);
  }, []);

  const setViewMode = useCallback((m: "grid" | "tiles") => {
    touch();
    setViewModeRaw(m);
  }, []);
  const setTilesPerRow = useCallback((n: number) => {
    touch();
    setTilesPerRowRaw(n);
  }, []);

  const setExpandWidth = useCallback((w: number) => {
    touch();
    // Floor at the shared default (34px): narrower would clip the
    // button whose track this is, and the way back to the default is
    // dragging back down to it, not through it.
    setExpandWidthRaw(Math.max(34, Math.round(w)));
  }, []);

  const resetLayout = useCallback(() => {
    touch();
    setColumnsRaw(reconcileColumns(null, isDm, columns));
    setExpandWidthRaw(null);
  }, [isDm, columns]);

  return {
    ready: saved !== undefined,
    /** What this view started from, so the Sort badge can be honest. */
    defaultSortKey: defaultSort.key,
    defaultSortAsc: defaultSort.asc,
    columns: columnState,
    setColumns,
    sortKey,
    setSortKey,
    sortAsc,
    setSortAsc,
    groupBy,
    setGroupBy,
    filters,
    setFilters,
    filterConjunction,
    setFilterConjunction,
    viewMode,
    setViewMode,
    tilesPerRow,
    setTilesPerRow,
    expandWidth,
    setExpandWidth,
    resetLayout,
  };
}
