"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useViewPrefs } from "@/components/useViewPrefs";
import { NpcDetail, fromInput } from "@/components/NpcDetail";
import { FilterPanel } from "@/components/FilterPanel";
import { matchesAll } from "@/components/npcFilters";
import {
  COLUMNS,
  COLUMN_BY_KEY,
  ColumnDef,
  ColumnState,
  EXTRA_SORTS,
  FACET_KEYS,
  MATURITY_ORDER,
  QUICK_FILTER_KEYS,
} from "@/components/npcColumns";

/**
 * The NPC roster — an Airtable-style grid over npcs.listForCampaign.
 *
 * Search, filter, group, sort, and layout all run in the browser against
 * the single subscription's rows. A server round trip per keystroke
 * would spend the free tier's pooled function-call budget on work a few
 * hundred rows do instantly in memory. See convex/npcs.ts for the
 * threshold at which this should become a paginated, server-filtered
 * query.
 *
 * Layout is per-person (convex/views.ts) — columns, widths, order,
 * sort, group, and filters are yours alone and follow you between
 * machines. The one thing personal preference cannot reach is the DM
 * boundary: hidden NPCs never arrive for a player, `secret` and
 * `dmNotes` arrive as null, and DM-only columns are not offered.
 */

type NpcListResult = FunctionReturnType<typeof api.npcs.listForCampaign>;
type Npc = NpcListResult["npcs"][number];

/** Bucket label for rows with no value in a faceted field. */
const EMPTY = "—";
/** Placeholder shown in a blank grid cell. */
const BLANK = "–";
const MIN_COL_WIDTH = 48;
/**
 * The one column that can't be hidden.
 *
 * "Hide all" with nothing exempt leaves a table of zero columns, which
 * looks like the roster was wiped rather than like a display setting.
 * Airtable protects its primary field the same way.
 */
const PRIMARY_COLUMN = "name";

function cell(npc: Npc, key: string): unknown {
  return (npc as unknown as Record<string, unknown>)[key];
}

function facetValues(npc: Npc, key: string): string[] {
  const raw = cell(npc, key);
  if (Array.isArray(raw)) {
    const vals = (raw as string[]).filter((v) => v && v.trim());
    return vals.length > 0 ? vals : [EMPTY];
  }
  if (typeof raw === "string" && raw.trim()) return [raw];
  return [EMPTY];
}

function chipValues(npc: Npc, key: string): string[] {
  return facetValues(npc, key).filter((v) => v !== EMPTY);
}

function display(npc: Npc, key: string): string {
  const raw = cell(npc, key);
  if (Array.isArray(raw)) return (raw as string[]).join(", ");
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  return String(raw);
}

function chipClass(columnKey: string, value: string): string {
  if (columnKey !== "gender") return "chip";
  const v = value.toLowerCase();
  if (v.includes("female")) return "chip gender-female";
  if (v.includes("male")) return "chip gender-male";
  return "chip gender-other";
}

function searchText(npc: Npc): string {
  const parts: string[] = [];
  for (const col of COLUMNS) {
    const raw = cell(npc, col.key);
    if (Array.isArray(raw)) parts.push(...(raw as string[]));
    else if (typeof raw === "string") parts.push(raw);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function compare(a: Npc, b: Npc, key: string): number {
  if (key === "maturity") {
    const rank = (n: Npc) => {
      const i = MATURITY_ORDER.indexOf(n.maturity ?? "");
      return i === -1 ? MATURITY_ORDER.length : i;
    };
    return rank(a) - rank(b);
  }

  const av = cell(a, key);
  const bv = cell(b, key);

  const aEmpty =
    av === null || av === undefined || (Array.isArray(av) && av.length === 0);
  const bEmpty =
    bv === null || bv === undefined || (Array.isArray(bv) && bv.length === 0);
  // Blanks always sink to the bottom, in both directions.
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof av === "number" && typeof bv === "number") return av - bv;

  const as = Array.isArray(av) ? (av as string[]).join(", ") : String(av);
  const bs = Array.isArray(bv) ? (bv as string[]).join(", ") : String(bv);
  return as.localeCompare(bs, undefined, { sensitivity: "base" });
}

export function NpcTable({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const result = useQuery(api.npcs.listForCampaign, { campaignId });
  const isDm = result?.isDm ?? false;

  const prefs = useViewPrefs(campaignId, "npcs", isDm);
  const updateNpc = useMutation(api.npcs.updateNpc);
  const createNpc = useMutation(api.npcs.createNpc);
  const setPlayerNotes = useMutation(api.npcs.setPlayerNotes);

  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Id<"npcs"> | null>(null);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(
    null
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const all = useMemo(() => result?.npcs ?? [], [result]);

  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of all) m.set(n._id, searchText(n));
    return m;
  }, [all]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((n) => {
      const hay = haystacks.get(n._id) ?? "";
      return terms.every((t) => hay.includes(t));
    });
  }, [all, haystacks, search]);

  const filtered = useMemo(() => {
    if (prefs.filters.length === 0) return searched;
    // Conditions are evaluated in the browser against the single
    // subscription — a condition costs nothing per keystroke.
    return searched.filter((n) =>
      matchesAll(
        (field) => cell(n, field),
        prefs.filters,
        prefs.filterConjunction
      )
    );
  }, [searched, prefs.filters, prefs.filterConjunction]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      const c = compare(a, b, prefs.sortKey);
      return prefs.sortAsc ? c : -c;
    });
    return rows;
  }, [filtered, prefs.sortKey, prefs.sortAsc]);

  const facetOptions = useMemo(() => {
    const out: {
      key: string;
      label: string;
      options: { value: string; count: number }[];
    }[] = [];

    for (const key of FACET_KEYS) {
      const def = COLUMN_BY_KEY.get(key);
      if (!def || (def.dmOnly && !isDm)) continue;

      const counts = new Map<string, number>();
      for (const n of searched) {
        for (const v of facetValues(n, key)) counts.set(v, 0);
      }
      for (const n of filtered) {
        for (const v of facetValues(n, key)) {
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      counts.delete(EMPTY);
      // A facet whose column is entirely blank is noise — leave it out.
      if (counts.size === 0) continue;

      const options = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      out.push({ key, label: def.label, options });
    }
    return out;
  }, [searched, filtered, isDm]);

  /** Known values per field, so conditions can offer options. */
  const valueOptions = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const col of COLUMNS) {
      const seen = new Set<string>();
      for (const n of all) {
        const raw = cell(n, col.key);
        if (Array.isArray(raw)) {
          for (const v of raw as string[]) if (v) seen.add(v);
        } else if (typeof raw === "string" && raw.trim()) {
          seen.add(raw);
        }
      }
      if (seen.size > 0 && seen.size <= 200) {
        m.set(col.key, Array.from(seen).sort());
      }
    }
    return m;
  }, [all]);

  const groups = useMemo(() => {
    if (!prefs.groupBy) return null;
    const map = new Map<string, Npc[]>();
    for (const n of sorted) {
      // A row in two groups shows up under both.
      for (const v of facetValues(n, prefs.groupBy)) {
        if (!map.has(v)) map.set(v, []);
        map.get(v)!.push(n);
      }
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === EMPTY) return 1;
      if (b[0] === EMPTY) return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
  }, [sorted, prefs.groupBy]);

  const selectedNpc = useMemo(
    () => all.find((n) => n._id === selected) ?? null,
    [all, selected]
  );

  /** Ordered, visible, permitted columns paired with their definitions. */
  const shown = useMemo(() => {
    const out: { state: ColumnState; def: ColumnDef }[] = [];
    for (const state of prefs.columns) {
      const def = COLUMN_BY_KEY.get(state.key);
      if (!def || !state.visible) continue;
      if (def.dmOnly && !isDm) continue;
      out.push({ state, def });
    }
    return out;
  }, [prefs.columns, isDm]);

  // An explicit total width is what lets a column shrink below its
  // content: with `table-layout: fixed` the browser honours the <col>
  // widths and the cells clip, instead of the table growing to fit.
  const totalWidth = shown.reduce((sum, c) => sum + c.state.width, 0);

  const activeFilterCount = prefs.filters.length;

  /** Fields a condition may target — DM-only columns only for the DM. */
  const filterableFields = useMemo(
    () => COLUMNS.filter((c) => isDm || !c.dmOnly),
    [isDm]
  );

  const canEdit = (def: ColumnDef) =>
    isDm ? Boolean(def.editable) : Boolean(def.playerEditable);

  /**
   * The quick dropdowns are a shortcut for a single condition. Which
   * operator depends on how the field is stored: `has any of` for a real
   * array, `is` for a scalar that merely renders as a pill.
   */
  function quickOperator(key: string): string {
    return COLUMN_BY_KEY.get(key)?.kind === "chips" ? "hasAnyOf" : "is";
  }

  function quickFilterValue(key: string): string {
    const op = quickOperator(key);
    const c = prefs.filters.find((f) => f.field === key && f.operator === op);
    return c?.values[0] ?? "";
  }

  function setSingleFilter(key: string, value: string) {
    const op = quickOperator(key);
    prefs.setFilters((cur) => {
      const rest = cur.filter((f) => !(f.field === key && f.operator === op));
      if (!value) return rest;
      return [...rest, { field: key, operator: op, values: [value] }];
    });
  }

  function sortOn(def: ColumnDef) {
    if (def.sortable === false) return;
    if (def.key === prefs.sortKey) prefs.setSortAsc((v) => !v);
    else {
      prefs.setSortKey(def.key);
      prefs.setSortAsc(true);
    }
  }

  function startResize(key: string, event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth =
      prefs.columns.find((c) => c.key === key)?.width ?? MIN_COL_WIDTH;

    const onMove = (e: PointerEvent) => {
      const next = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
      prefs.setColumns((cur) =>
        cur.map((c) => (c.key === key ? { ...c, width: next } : c))
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("col-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("col-resizing");
  }

  function toggleColumn(key: string) {
    prefs.setColumns((cur) =>
      cur.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c))
    );
  }

  /**
   * Drop `fromKey` where `toKey` currently sits.
   *
   * Lift-and-insert, not a swap: dragging a field from the bottom of the
   * list to the top should slide everything else down by one, which is
   * what the gesture looks like. A swap would fling whatever was at the
   * top down to the bottom.
   */
  function reorderColumn(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    prefs.setColumns((cur) => {
      const from = cur.findIndex((c) => c.key === fromKey);
      const to = cur.findIndex((c) => c.key === toKey);
      if (from === -1 || to === -1) return cur;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  /** Show or hide every column at once, except the primary field. */
  function setAllColumns(visible: boolean) {
    prefs.setColumns((cur) =>
      cur.map((c) => {
        const def = COLUMN_BY_KEY.get(c.key);
        if (!def || (def.dmOnly && !isDm)) return c;
        if (c.key === PRIMARY_COLUMN) return { ...c, visible: true };
        return { ...c, visible };
      })
    );
  }

  function toggleGroup(value: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function commitEdit(npc: Npc, def: ColumnDef, text: string) {
    setEditing(null);
    const value = fromInput(def, text);
    try {
      setError(null);
      if (def.key === "playerNotes" && !isDm) {
        await setPlayerNotes({
          npcId: npc._id,
          playerNotes: value as string | null,
        });
        return;
      }
      await updateNpc({ npcId: npc._id, [def.key]: value } as unknown as {
        npcId: typeof npc._id;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that change.");
    }
  }

  if (result === undefined || !prefs.ready) {
    return <p className="centered-note">Loading the roster…</p>;
  }

  return (
    <div className="npc-screen">
      <div className="npc-toolbar">
        <div className="quick-filters">
          {facetOptions
            .filter((f) => QUICK_FILTER_KEYS.includes(f.key))
            .map((f) => (
              <select
                key={f.key}
                className={`quick-select${
                  quickFilterValue(f.key) ? " on" : ""
                }`}
                value={quickFilterValue(f.key)}
                onChange={(e) => setSingleFilter(f.key, e.target.value)}
              >
                <option value="">{f.label}</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.value} ({o.count})
                  </option>
                ))}
              </select>
            ))}
        </div>

        <div className="toolbar-right">
          <label className="npc-select">
            <span>Group</span>
            <select
              value={prefs.groupBy}
              onChange={(e) => prefs.setGroupBy(e.target.value)}
            >
              <option value="">None</option>
              {facetOptions.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="npc-select">
            <span>View</span>
            <select
              value={prefs.viewMode}
              onChange={(e) =>
                prefs.setViewMode(e.target.value as "grid" | "tiles")
              }
            >
              <option value="grid">Grid</option>
              <option value="tiles">Tiles</option>
            </select>
          </label>

          {prefs.viewMode === "tiles" && (
            <label className="npc-select">
              <span>Per row</span>
              <select
                value={prefs.tilesPerRow}
                onChange={(e) => prefs.setTilesPerRow(Number(e.target.value))}
              >
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            type="button"
            className={`npc-btn${showColumns ? " on" : ""}`}
            onClick={() => setShowColumns((v) => !v)}
          >
            Columns
          </button>

          <button
            type="button"
            className={`npc-btn${
              showFilters || activeFilterCount ? " on" : ""
            }`}
            onClick={() => setShowFilters((v) => !v)}
          >
            Filter{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
          </button>

          <label className="npc-select">
            <span>Sort</span>
            <select
              value={prefs.sortKey}
              onChange={(e) => prefs.setSortKey(e.target.value)}
            >
              {COLUMNS.filter(
                (c) => c.sortable !== false && (isDm || !c.dmOnly)
              ).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
              {EXTRA_SORTS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="npc-btn"
            onClick={() => prefs.setSortAsc((v) => !v)}
            title={prefs.sortAsc ? "Ascending" : "Descending"}
          >
            {prefs.sortAsc ? "↑" : "↓"}
          </button>

          <input
            className="npc-search"
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {isDm && (
            <button
              type="button"
              className="npc-btn primary"
              onClick={async () => {
                try {
                  setError(null);
                  const id = await createNpc({ campaignId });
                  // Open it straight away — a blank row is only useful
                  // once you're typing into it.
                  setSelected(id);
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Could not create an NPC."
                  );
                }
              }}
            >
              + New NPC
            </button>
          )}
        </div>
      </div>

      <div className="npc-substrip">
        <span className="npc-count">
          {sorted.length === all.length
            ? `${all.length} NPCs`
            : `${sorted.length} of ${all.length}`}
        </span>
        {result.previewingAsPlayer && (
          <span className="preview-flag">
            Viewing as a player — hidden NPCs and DM fields withheld
          </span>
        )}
        {(search || activeFilterCount > 0 || prefs.groupBy) && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setSearch("");
              prefs.setFilters([]);
              prefs.setGroupBy("");
            }}
          >
            Clear filters
          </button>
        )}
        <button
          type="button"
          className="text-button reset-layout"
          onClick={prefs.resetLayout}
        >
          Reset layout
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {result.truncated && (
        <p className="npc-notice">
          Showing the first {all.length} NPCs — the roster is larger than one
          subscription returns. Time to switch this screen to a paginated
          query.
        </p>
      )}

      {showColumns && (
        <div className="column-panel">
          <div className="facet-label">
            Columns — yours alone; nobody else&apos;s view changes
          </div>

          <input
            className="column-find"
            type="search"
            placeholder="Find a field"
            value={columnSearch}
            onChange={(e) => setColumnSearch(e.target.value)}
          />

          <ul className="column-list">
            {prefs.columns.map((state) => {
              const def = COLUMN_BY_KEY.get(state.key);
              if (!def || (def.dmOnly && !isDm)) return null;
              if (
                columnSearch.trim() &&
                !def.label
                  .toLowerCase()
                  .includes(columnSearch.trim().toLowerCase())
              ) {
                return null;
              }

              const isPrimary = state.key === PRIMARY_COLUMN;
              return (
                <li
                  key={state.key}
                  className={[
                    "column-item",
                    dragKey === state.key ? "dragging" : "",
                    dropKey === state.key ? "drop-target" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  draggable
                  onDragStart={(e) => {
                    // WebKit refuses the drag outright without this.
                    e.dataTransfer.setData("text/plain", state.key);
                    e.dataTransfer.effectAllowed = "move";
                    setDragKey(state.key);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setDropKey(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropKey !== state.key) setDropKey(state.key);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from =
                      e.dataTransfer.getData("text/plain") || dragKey;
                    setDragKey(null);
                    setDropKey(null);
                    if (from) reorderColumn(from, state.key);
                  }}
                >
                  <button
                    type="button"
                    className={`column-switch${state.visible ? " on" : ""}`}
                    role="switch"
                    aria-checked={state.visible}
                    aria-label={`Show ${def.label}`}
                    disabled={isPrimary}
                    title={
                      isPrimary
                        ? "The primary field always shows"
                        : state.visible
                          ? "Hide this field"
                          : "Show this field"
                    }
                    onClick={() => toggleColumn(state.key)}
                  >
                    <span className="knob" />
                  </button>

                  <span className="column-name">{def.label}</span>
                  {def.dmOnly && <span className="dm-tag">DM</span>}

                  {/* Grip is a hint, not the handle — the whole row is
                      draggable, which is a much larger target. */}
                  <span className="column-grip" aria-hidden="true">
                    ⠿
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="column-panel-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => setAllColumns(false)}
            >
              Hide all
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setAllColumns(true)}
            >
              Show all
            </button>
          </div>
        </div>
      )}

      {showFilters && (
        <FilterPanel
          conditions={prefs.filters}
          conjunction={prefs.filterConjunction}
          fields={filterableFields}
          valueOptions={valueOptions}
          onChange={prefs.setFilters}
          onConjunctionChange={prefs.setFilterConjunction}
        />
      )}

      {prefs.viewMode === "tiles" ? (
        <TileGrid
          groups={groups}
          rows={sorted}
          shown={shown}
          perRow={prefs.tilesPerRow}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
          onOpen={setSelected}
          emptyNote={
            all.length === 0
              ? "No NPCs imported yet."
              : "Nothing matches those filters."
          }
        />
      ) : (
        <div className="npc-table-wrap">
          <table className="npc-table" style={{ width: `${totalWidth}px` }}>
          <colgroup>
            {shown.map(({ state }) => (
              <col key={state.key} style={{ width: `${state.width}px` }} />
            ))}
          </colgroup>

          <thead>
            <tr>
              {shown.map(({ state, def }) => (
                <th
                  key={state.key}
                  onClick={() => sortOn(def)}
                  className={prefs.sortKey === def.key ? "sorted" : undefined}
                >
                  <span className="th-label">
                    {def.label}
                    {prefs.sortKey === def.key && (
                      <span className="arrow">
                        {prefs.sortAsc ? "↑" : "↓"}
                      </span>
                    )}
                  </span>
                  <span
                    className="col-resize"
                    title="Drag to resize"
                    onPointerDown={(e) => startResize(state.key, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
            </tr>
          </thead>

          {groups ? (
            groups.map(([groupValue, rows]) => (
              <tbody key={groupValue}>
                <tr
                  className="group-row"
                  onClick={() => toggleGroup(groupValue)}
                >
                  <td colSpan={shown.length}>
                    <span className="caret">
                      {collapsed.has(groupValue) ? "▸" : "▾"}
                    </span>
                    {groupValue}
                    <span className="n">{rows.length}</span>
                  </td>
                </tr>
                {!collapsed.has(groupValue) &&
                  rows.map((n) => (
                    <Row
                      key={`${groupValue}:${n._id}`}
                      npc={n}
                      shown={shown}
                      selected={n._id === selected}
                      editing={editing}
                      draft={draft}
                      setDraft={setDraft}
                      canEdit={canEdit}
                      onOpen={() => setSelected(n._id)}
                      onStartEdit={(def, value) => {
                        setEditing({ id: n._id, key: def.key });
                        setDraft(value);
                      }}
                      onCommit={(def, text) => void commitEdit(n, def, text)}
                      onCancel={() => setEditing(null)}
                    />
                  ))}
              </tbody>
            ))
          ) : (
            <tbody>
              {sorted.map((n) => (
                <Row
                  key={n._id}
                  npc={n}
                  shown={shown}
                  selected={n._id === selected}
                  editing={editing}
                  draft={draft}
                  setDraft={setDraft}
                  canEdit={canEdit}
                  onOpen={() => setSelected(n._id)}
                  onStartEdit={(def, value) => {
                    setEditing({ id: n._id, key: def.key });
                    setDraft(value);
                  }}
                  onCommit={(def, text) => void commitEdit(n, def, text)}
                  onCancel={() => setEditing(null)}
                />
              ))}
            </tbody>
          )}
        </table>

          {sorted.length === 0 && (
            <p className="centered-note">
              {all.length === 0
                ? "No NPCs imported yet."
                : "Nothing matches those filters."}
            </p>
          )}
        </div>
      )}

      {selectedNpc && (
        <NpcDetail
          npc={selectedNpc}
          isDm={isDm}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Row({
  npc,
  shown,
  selected,
  editing,
  draft,
  setDraft,
  canEdit,
  onOpen,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  npc: Npc;
  shown: { state: ColumnState; def: ColumnDef }[];
  selected: boolean;
  editing: { id: string; key: string } | null;
  draft: string;
  setDraft: (v: string) => void;
  canEdit: (def: ColumnDef) => boolean;
  onOpen: () => void;
  onStartEdit: (def: ColumnDef, value: string) => void;
  onCommit: (def: ColumnDef, text: string) => void;
  onCancel: () => void;
}) {
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";

  return (
    <tr
      className={[npc.hidden ? "hidden-npc" : "", selected ? "selected" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {shown.map(({ state, def }) => {
        const isEditing = editing?.id === npc._id && editing.key === def.key;

        if (isEditing) {
          return (
            <td key={state.key} className="editing-cell">
              <input
                autoFocus
                className="cell-input"
                type={def.kind === "number" ? "number" : "text"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => onCommit(def, draft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommit(def, draft);
                  if (e.key === "Escape") onCancel();
                }}
              />
            </td>
          );
        }

        const editable = canEdit(def) && def.kind !== "picture";
        const open = () => {
          if (!editable) return;
          const raw = cell(npc, def.key);
          onStartEdit(
            def,
            Array.isArray(raw)
              ? (raw as string[]).join(", ")
              : raw === null || raw === undefined
                ? ""
                : String(raw)
          );
        };

        if (def.kind === "picture") {
          return (
            <td key={state.key} className="pic-cell" onClick={onOpen}>
              {npc.portraitPath && mapServer ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  className="row-portrait"
                  src={`${mapServer}/${npc.portraitPath}`}
                  alt=""
                />
              ) : (
                <span className="row-portrait empty" />
              )}
            </td>
          );
        }

        if (def.kind === "chips" || def.chip) {
          const vals = chipValues(npc, def.key);
          return (
            <td
              key={state.key}
              className={editable ? "editable" : undefined}
              onDoubleClick={open}
              onClick={editable ? undefined : onOpen}
            >
              {vals.length === 0 ? (
                <span className="blank">{BLANK}</span>
              ) : (
                <span className="cell-chips">
                  {vals.map((v) => (
                    <span className={chipClass(def.key, v)} key={v}>
                      {v}
                    </span>
                  ))}
                </span>
              )}
            </td>
          );
        }

        const text = display(npc, def.key);
        return (
          <td
            key={state.key}
            className={[
              def.key === "name" ? "name-cell" : "",
              editable ? "editable" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={text || undefined}
            onDoubleClick={open}
            onClick={def.key === "name" ? onOpen : undefined}
          >
            {text === "" ? <span className="blank">{BLANK}</span> : text}
          </td>
        );
      })}
    </tr>
  );
}

/**
 * Tile view — the portrait leads, the fields follow.
 *
 * Reuses the same visible-column set as the grid, so the fields on a
 * tile are whatever that person chose to show. Grouping and collapsing
 * behave identically; only the presentation differs.
 */
function TileGrid({
  groups,
  rows,
  shown,
  perRow,
  collapsed,
  onToggleGroup,
  onOpen,
  emptyNote,
}: {
  groups: [string, Npc[]][] | null;
  rows: Npc[];
  shown: { state: ColumnState; def: ColumnDef }[];
  perRow: number;
  collapsed: Set<string>;
  onToggleGroup: (value: string) => void;
  onOpen: (id: Id<"npcs">) => void;
  emptyNote: string;
}) {
  const style = { gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` };

  if (rows.length === 0) {
    return <p className="centered-note">{emptyNote}</p>;
  }

  if (!groups) {
    return (
      <div className="tile-grid" style={style}>
        {rows.map((n) => (
          <Tile key={n._id} npc={n} shown={shown} onOpen={onOpen} />
        ))}
      </div>
    );
  }

  return (
    <div className="tile-groups">
      {groups.map(([value, groupRows]) => (
        <section key={value}>
          <button
            type="button"
            className="tile-group-head"
            onClick={() => onToggleGroup(value)}
          >
            <span className="caret">{collapsed.has(value) ? "▸" : "▾"}</span>
            {value}
            <span className="n">{groupRows.length}</span>
          </button>
          {!collapsed.has(value) && (
            <div className="tile-grid" style={style}>
              {groupRows.map((n) => (
                <Tile
                  key={`${value}:${n._id}`}
                  npc={n}
                  shown={shown}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Tile({
  npc,
  shown,
  onOpen,
}: {
  npc: Npc;
  shown: { state: ColumnState; def: ColumnDef }[];
  onOpen: (id: Id<"npcs">) => void;
}) {
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const fields = shown.filter(
    ({ def }) => def.kind !== "picture" && def.key !== "name"
  );

  return (
    <article
      className={`tile${npc.hidden ? " hidden-npc" : ""}`}
      onClick={() => onOpen(npc._id)}
    >
      <div className="tile-portrait">
        {npc.portraitPath && mapServer ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={`${mapServer}/${npc.portraitPath}`} alt="" />
        ) : (
          <span className="tile-portrait-empty">{npc.name.charAt(0)}</span>
        )}
      </div>

      <h3 className="tile-name">{npc.name}</h3>

      <dl className="tile-fields">
        {fields.map(({ def }) => {
          const chips =
            def.kind === "chips" || def.chip ? chipValues(npc, def.key) : null;
          const text = display(npc, def.key);
          if (chips ? chips.length === 0 : text === "") return null;
          return (
            <div className="tile-field" key={def.key}>
              <dt>{def.label}</dt>
              <dd>
                {chips ? (
                  <span className="cell-chips">
                    {chips.map((v) => (
                      <span className={chipClass(def.key, v)} key={v}>
                        {v}
                      </span>
                    ))}
                  </span>
                ) : (
                  text
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </article>
  );
}
