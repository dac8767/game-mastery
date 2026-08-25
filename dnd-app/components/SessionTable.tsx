"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useViewPrefs } from "@/components/useViewPrefs";
import { FilterPanel } from "@/components/FilterPanel";
import { matchesAll } from "@/components/npcFilters";
import { UiText } from "@/components/UiEditor";
import {
  BLANK,
  cell,
  chipValues,
  display,
  facetCounts,
  groupRows,
  searchText,
  sortRows,
} from "@/components/recordGrid";
import {
  BarButton,
  MoreMenu,
  SearchBox,
  ViewPicker,
} from "@/components/TableToolbar";
import { ExpandIcon } from "@/components/ExpandIcon";
import { SessionDetail, SessionRow } from "@/components/SessionDetail";
import { ColumnDef, ColumnState } from "@/components/npcColumns";
import {
  SESSION_COLUMNS,
  SESSION_COLUMN_BY_KEY,
  SESSION_DEFAULT_SORT,
  SESSION_EXTRA_SORTS,
  SESSION_FACET_KEYS,
  SESSION_PRIMARY_COLUMN,
  sessionPatch,
} from "@/components/sessionColumns";

/**
 * The Sessions log — the NPC roster's table, over nights at the table.
 *
 * Third use of the same machinery and the least of the three to write,
 * which is the point of having extracted it: TableToolbar for the bar
 * and its popovers, recordGrid for what a cell does with a value,
 * useViewPrefs for the layout. What is different here is small and
 * worth naming:
 *
 *   - the primary column is a NUMBER, not a name, so the view brings
 *     its own default sort — newest first, because a session log is a
 *     diary rather than a reference
 *   - the row is the night's facts; the NOTES behind the expand button
 *     are two notebook pages, and the DM's is withheld by the server
 *
 * Every row here is an ordinary document, which after Groups is worth
 * saying out loud: no synthetic keys, no rows that become real when you
 * type into them.
 */

const EXPAND_COL = 34;
const MIN_COL_WIDTH = 48;

export function SessionTable({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const result = useQuery(api.sessions.listForCampaign, { campaignId });
  const isDm = result?.isDm ?? false;

  const prefs = useViewPrefs(
    campaignId,
    "sessions",
    isDm,
    SESSION_COLUMNS,
    SESSION_DEFAULT_SORT
  );
  const createSession = useMutation(api.sessions.createSession);
  const updateSession = useMutation(api.sessions.updateSession);

  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<
    "columns" | "group" | "filter" | "sort" | null
  >(null);
  const togglePanel = (which: typeof panel) =>
    setPanel((cur) => (cur === which ? null : which));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Id<"sessions"> | null>(null);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(
    null
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const all = useMemo(
    () => (result?.sessions ?? []) as SessionRow[],
    [result]
  );

  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of all) m.set(s._id, searchText(s, SESSION_COLUMNS));
    return m;
  }, [all]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((s) => {
      const hay = haystacks.get(s._id) ?? "";
      return terms.every((t) => hay.includes(t));
    });
  }, [all, haystacks, search]);

  const filtered = useMemo(() => {
    if (prefs.filters.length === 0) return searched;
    return searched.filter((s) =>
      matchesAll(
        (field) => cell(s, field),
        prefs.filters,
        prefs.filterConjunction
      )
    );
  }, [searched, prefs.filters, prefs.filterConjunction]);

  const sorted = useMemo(
    () => sortRows(filtered, prefs.sortKey, prefs.sortAsc),
    [filtered, prefs.sortKey, prefs.sortAsc]
  );

  const facetOptions = useMemo(() => {
    const out: {
      key: string;
      label: string;
      options: { value: string; count: number }[];
    }[] = [];
    for (const key of SESSION_FACET_KEYS) {
      const def = SESSION_COLUMN_BY_KEY.get(key);
      if (!def) continue;
      const options = facetCounts(searched, filtered, key);
      if (options.length === 0) continue;
      out.push({ key, label: def.label, options });
    }
    return out;
  }, [searched, filtered]);

  /** Known values per field, so conditions can offer options. */
  const valueOptions = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const col of SESSION_COLUMNS) {
      const seen = new Set<string>();
      for (const s of all) {
        const raw = cell(s, col.key);
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

  const groups = useMemo(
    () => (prefs.groupBy ? groupRows(sorted, prefs.groupBy) : null),
    [sorted, prefs.groupBy]
  );

  const selectedSession = useMemo(
    () => all.find((s) => s._id === selected) ?? null,
    [all, selected]
  );

  /** Ordered, visible columns paired with their definitions. */
  const shown = useMemo(() => {
    const out: { state: ColumnState; def: ColumnDef }[] = [];
    for (const state of prefs.columns) {
      const def = SESSION_COLUMN_BY_KEY.get(state.key);
      if (!def || !state.visible) continue;
      out.push({ state, def });
    }
    return out;
  }, [prefs.columns]);

  const totalWidth = shown.reduce((sum, c) => sum + c.state.width, 0);
  const activeFilterCount = prefs.filters.length;
  const sortCount =
    prefs.sortKey !== prefs.defaultSortKey ||
    prefs.sortAsc !== prefs.defaultSortAsc
      ? 1
      : 0;

  const sortableFields = useMemo(
    () => [
      ...SESSION_COLUMNS.filter((c) => c.sortable !== false),
      ...SESSION_EXTRA_SORTS,
    ],
    []
  );

  /** The night's facts are the DM's record of it. */
  const canEdit = (def: ColumnDef) => isDm && Boolean(def.editable);

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

  function setAllColumns(visible: boolean) {
    prefs.setColumns((cur) =>
      cur.map((c) =>
        c.key === SESSION_PRIMARY_COLUMN
          ? { ...c, visible: true }
          : { ...c, visible }
      )
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

  async function commitEdit(row: SessionRow, def: ColumnDef, text: string) {
    setEditing(null);
    const patch = sessionPatch(def.key, text);
    // Nothing to write is a normal outcome — a blank session number, or
    // a typo where a number belongs. The cell goes back to what it was
    // rather than storing NaN.
    if (Object.keys(patch).length === 0) return;
    try {
      setError(null);
      await updateSession({ sessionId: row._id, ...patch });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that change.");
    }
  }

  if (result === undefined || !prefs.ready) {
    return <p className="centered-note">Loading the sessions…</p>;
  }

  return (
    <div className="npc-screen">
      {!selectedSession && (
        <div className="npc-toolbar">
          <div className="toolbar-left">
            <button
              type="button"
              className="npc-btn primary"
              disabled={!isDm}
              title={isDm ? undefined : "Only the DM can add a session"}
              onClick={async () => {
                try {
                  setError(null);
                  setSelected(await createSession({ campaignId }));
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not create a session."
                  );
                }
              }}
            >
              <UiText id="session.bar.new" />
            </button>

            <span className="npc-count">
              {sorted.length === all.length
                ? `${all.length} sessions`
                : `${sorted.length} of ${all.length}`}
            </span>
          </div>

          {result.previewingAsPlayer && (
            <span className="preview-flag">Viewing as a player</span>
          )}

          <div className="toolbar-right">
            <BarButton
              labelId="list.bar.filter"
              count={activeFilterCount}
              open={panel === "filter"}
              onClick={() => togglePanel("filter")}
              onClose={() => setPanel(null)}
            >
              <FilterPanel
                conditions={prefs.filters}
                conjunction={prefs.filterConjunction}
                fields={SESSION_COLUMNS}
                valueOptions={valueOptions}
                onChange={prefs.setFilters}
                onConjunctionChange={prefs.setFilterConjunction}
              />
            </BarButton>

            <BarButton
              labelId="list.bar.group"
              count={prefs.groupBy ? 1 : 0}
              open={panel === "group"}
              onClick={() => togglePanel("group")}
              onClose={() => setPanel(null)}
            >
              <div className="filter-panel">
                <div className="filter-title">Group</div>
                <label className="npc-select">
                  <span>
                    <UiText id="list.panel.groupBy" />
                  </span>
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
                {prefs.groupBy && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => prefs.setGroupBy("")}
                  >
                    Remove grouping
                  </button>
                )}
              </div>
            </BarButton>

            <BarButton
              labelId="list.bar.sort"
              count={sortCount}
              open={panel === "sort"}
              onClick={() => togglePanel("sort")}
              onClose={() => setPanel(null)}
            >
              <div className="filter-panel">
                <div className="filter-title">Sort</div>
                <label className="npc-select">
                  <span>
                    <UiText id="list.panel.sortBy" />
                  </span>
                  <select
                    value={prefs.sortKey}
                    onChange={(e) => prefs.setSortKey(e.target.value)}
                  >
                    {sortableFields.map((c) => (
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
                >
                  <UiText
                    id={
                      prefs.sortAsc
                        ? "list.panel.ascending"
                        : "list.panel.descending"
                    }
                  />
                </button>
                {sortCount > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      prefs.setSortKey(prefs.defaultSortKey);
                      prefs.setSortAsc(prefs.defaultSortAsc);
                    }}
                  >
                    Back to the default
                  </button>
                )}
              </div>
            </BarButton>

            <ViewPicker
              mode={prefs.viewMode}
              perRow={prefs.tilesPerRow}
              setMode={prefs.setViewMode}
              setPerRow={prefs.setTilesPerRow}
            />

            <SearchBox
              value={search}
              onChange={setSearch}
              labelId="session.bar.search"
            />

            <MoreMenu
              fieldsOpen={panel === "columns"}
              onFields={() => togglePanel("columns")}
              onCloseFields={() => setPanel(null)}
              onResetLayout={prefs.resetLayout}
            >
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
                    const def = SESSION_COLUMN_BY_KEY.get(state.key);
                    if (!def) return null;
                    if (
                      columnSearch.trim() &&
                      !def.label
                        .toLowerCase()
                        .includes(columnSearch.trim().toLowerCase())
                    ) {
                      return null;
                    }

                    const isPrimary = state.key === SESSION_PRIMARY_COLUMN;
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
            </MoreMenu>
          </div>
        </div>
      )}

      {!selectedSession &&
        (search || activeFilterCount > 0 || prefs.groupBy) && (
          <div className="npc-substrip">
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
          </div>
        )}

      {error && <p className="form-error">{error}</p>}

      {result.truncated && (
        <p className="npc-notice">
          Showing the first {all.length} sessions — this campaign is longer
          than one subscription returns. Time to switch this screen to a
          paginated query.
        </p>
      )}

      {selectedSession ? (
        <SessionDetail
          session={selectedSession}
          isDm={isDm}
          onClose={() => setSelected(null)}
        />
      ) : prefs.viewMode === "tiles" ? (
        <SessionTiles
          groups={groups}
          rows={sorted}
          shown={shown}
          perRow={prefs.tilesPerRow}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
          onOpen={setSelected}
          emptyNote={
            all.length === 0
              ? "No sessions yet."
              : "Nothing matches those filters."
          }
        />
      ) : (
        <div className="npc-table-wrap">
          <table
            className="npc-table"
            style={{ width: `${totalWidth + EXPAND_COL}px` }}
          >
            <colgroup>
              <col style={{ width: `${EXPAND_COL}px` }} />
              {shown.map(({ state }) => (
                <col key={state.key} style={{ width: `${state.width}px` }} />
              ))}
            </colgroup>

            <thead>
              <tr>
                <th className="expand-th" aria-label="Open" />
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
                    <td colSpan={shown.length + 1}>
                      <span className="caret">
                        {collapsed.has(groupValue) ? "▸" : "▾"}
                      </span>
                      {groupValue}
                      <span className="n">{rows.length}</span>
                    </td>
                  </tr>
                  {!collapsed.has(groupValue) &&
                    rows.map((s) => (
                      <SessionRowCells
                        key={`${groupValue}:${s._id}`}
                        row={s}
                        shown={shown}
                        selected={s._id === selected}
                        editing={editing}
                        draft={draft}
                        setDraft={setDraft}
                        canEdit={canEdit}
                        onOpen={() => setSelected(s._id)}
                        onStartEdit={(def, value) => {
                          setEditing({ id: s._id, key: def.key });
                          setDraft(value);
                        }}
                        onCommit={(def, text) => void commitEdit(s, def, text)}
                        onCancel={() => setEditing(null)}
                      />
                    ))}
                </tbody>
              ))
            ) : (
              <tbody>
                {sorted.map((s) => (
                  <SessionRowCells
                    key={s._id}
                    row={s}
                    shown={shown}
                    selected={s._id === selected}
                    editing={editing}
                    draft={draft}
                    setDraft={setDraft}
                    canEdit={canEdit}
                    onOpen={() => setSelected(s._id)}
                    onStartEdit={(def, value) => {
                      setEditing({ id: s._id, key: def.key });
                      setDraft(value);
                    }}
                    onCommit={(def, text) => void commitEdit(s, def, text)}
                    onCancel={() => setEditing(null)}
                  />
                ))}
              </tbody>
            )}
          </table>

          {sorted.length === 0 && (
            <p className="centered-note">
              {all.length === 0
                ? "No sessions yet."
                : "Nothing matches those filters."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SessionRowCells({
  row,
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
  row: SessionRow;
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
  return (
    <tr className={selected ? "selected" : undefined}>
      <td className="expand-cell">
        <button
          type="button"
          className="expand-btn"
          title={`Open session ${row.number}`}
          aria-label={`Open session ${row.number}`}
          onClick={onOpen}
        >
          <ExpandIcon />
        </button>
      </td>

      {shown.map(({ state, def }) => {
        const isEditing = editing?.id === row._id && editing.key === def.key;

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

        const editable = canEdit(def);
        const open = () => {
          if (!editable) return;
          const raw = cell(row, def.key);
          onStartEdit(
            def,
            Array.isArray(raw)
              ? (raw as string[]).join(", ")
              : raw === null || raw === undefined
                ? ""
                : String(raw)
          );
        };

        if (def.kind === "chips") {
          const vals = chipValues(row, def.key);
          return (
            <td
              key={state.key}
              className={editable ? "editable" : undefined}
              onClick={editable ? open : undefined}
            >
              {vals.length === 0 ? (
                <span className="blank">{BLANK}</span>
              ) : (
                <span className="cell-chips">
                  {vals.map((v) => (
                    <span className="chip" key={v}>
                      {v}
                    </span>
                  ))}
                </span>
              )}
            </td>
          );
        }

        const text = display(row, def.key, def.format);
        return (
          <td
            key={state.key}
            className={[
              def.key === SESSION_PRIMARY_COLUMN ? "name-cell" : "",
              editable ? "editable" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={text || undefined}
            onDoubleClick={open}
            onClick={editable ? open : undefined}
          >
            {text === "" ? <span className="blank">{BLANK}</span> : text}
          </td>
        );
      })}
    </tr>
  );
}

/**
 * Tile view — no picture, because a session has none.
 *
 * The number leads at the size a portrait would be, which is what makes
 * a wall of these scannable: you are looking for a night, and the night
 * has a number.
 */
function SessionTiles({
  groups,
  rows,
  shown,
  perRow,
  collapsed,
  onToggleGroup,
  onOpen,
  emptyNote,
}: {
  groups: [string, SessionRow[]][] | null;
  rows: SessionRow[];
  shown: { state: ColumnState; def: ColumnDef }[];
  perRow: number;
  collapsed: Set<string>;
  onToggleGroup: (value: string) => void;
  onOpen: (id: Id<"sessions">) => void;
  emptyNote: string;
}) {
  const style = { ["--tiles-per-row" as string]: String(perRow) };

  if (rows.length === 0) return <p className="centered-note">{emptyNote}</p>;

  if (groups) {
    return (
      <div className="tile-groups">
        {groups.map(([value, inGroup]) => (
          <section key={value}>
            <button
              type="button"
              className="tile-group-head"
              onClick={() => onToggleGroup(value)}
            >
              <span className="caret">{collapsed.has(value) ? "▸" : "▾"}</span>
              {value}
              <span className="n">{inGroup.length}</span>
            </button>
            {!collapsed.has(value) && (
              <div className="tile-grid" style={style}>
                {inGroup.map((s) => (
                  <SessionTile
                    key={`${value}:${s._id}`}
                    row={s}
                    shown={shown}
                    onOpen={() => onOpen(s._id)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="tile-grid" style={style}>
      {rows.map((s) => (
        <SessionTile
          key={s._id}
          row={s}
          shown={shown}
          onOpen={() => onOpen(s._id)}
        />
      ))}
    </div>
  );
}

function SessionTile({
  row,
  shown,
  onOpen,
}: {
  row: SessionRow;
  shown: { state: ColumnState; def: ColumnDef }[];
  onOpen: () => void;
}) {
  const fields = shown.filter((c) => c.def.key !== SESSION_PRIMARY_COLUMN);

  return (
    <button type="button" className="npc-tile" onClick={onOpen}>
      <span className="tile-number">{row.number}</span>
      <span className="tile-name">Session {row.number}</span>
      {fields.map(({ state, def }) => {
        const text = display(row, def.key, def.format);
        if (!text) return null;
        return (
          <span className="tile-field" key={state.key}>
            {text}
          </span>
        );
      })}
    </button>
  );
}
