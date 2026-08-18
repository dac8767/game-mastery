"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ColumnState, reconcileColumns } from "@/components/npcColumns";
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

export function useViewPrefs(
  campaignId: Id<"campaigns">,
  view: string,
  isDm: boolean
) {
  const saved = useQuery(api.views.getViewPrefs, { campaignId, view });
  const save = useMutation(api.views.saveViewPrefs);

  const [columns, setColumnsRaw] = useState<ColumnState[]>(() =>
    reconcileColumns(null, isDm)
  );
  const [sortKey, setSortKeyRaw] = useState("name");
  const [sortAsc, setSortAscRaw] = useState(true);
  const [groupBy, setGroupByRaw] = useState("");
  const [filters, setFiltersRaw] = useState<FilterCondition[]>([]);
  const [filterConjunction, setFilterConjunctionRaw] =
    useState<Conjunction>("and");
  const [viewMode, setViewModeRaw] = useState<"grid" | "tiles">("grid");
  const [tilesPerRow, setTilesPerRowRaw] = useState(4);

  const hydrated = useRef(false);
  const dirty = useRef(false);
  const lastIsDm = useRef(isDm);

  // ---- hydrate once, from whatever the server has -------------------
  useEffect(() => {
    if (saved === undefined || hydrated.current) return;

    setColumnsRaw(reconcileColumns(saved?.columns ?? null, isDm));
    if (saved) {
      setSortKeyRaw(saved.sortKey ?? "name");
      setSortAscRaw(saved.sortAsc ?? true);
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
  }, [saved, isDm]);

  // A DM flipping into the player preview loses the DM-only columns;
  // flipping back restores them. Not a change the person "made", so it
  // deliberately does not mark the layout dirty.
  useEffect(() => {
    if (lastIsDm.current === isDm) return;
    lastIsDm.current = isDm;
    setColumnsRaw((cur) => reconcileColumns(cur, isDm));
  }, [isDm]);

  // ---- debounced save of anything the person changed ----------------
  useEffect(() => {
    if (!hydrated.current || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      void save({
        campaignId,
        view,
        columns,
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
    columns,
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

  const resetLayout = useCallback(() => {
    touch();
    setColumnsRaw(reconcileColumns(null, isDm));
  }, [isDm]);

  return {
    ready: saved !== undefined,
    columns,
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
    resetLayout,
  };
}
