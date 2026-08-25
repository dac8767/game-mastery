"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { GroupDetail, GroupRow } from "@/components/GroupDetail";
import { ColumnDef, ColumnState } from "@/components/npcColumns";
import {
  GROUP_COLUMNS,
  GROUP_COLUMN_BY_KEY,
  GROUP_EXTRA_SORTS,
  GROUP_FACET_KEYS,
  GROUP_PRIMARY_COLUMN,
} from "@/components/groupColumns";

/**
 * The Groups screen — the NPC roster's table, over factions.
 *
 * Same toolbar, same expand column, same per-person layout: Derek asked
 * for a second list that works exactly like the first, and the parts
 * that are literally the same are literally the same code —
 * TableToolbar for the bar and its popovers, recordGrid for what a cell
 * does with a value, useViewPrefs for the layout. What is different is
 * the shape of a row, and that is where this file's own weight is.
 *
 * A row is not simply a document. Half of them are: a `groups` row with
 * a description and pictures. The other half are names some NPC
 * carries that nobody has written up, which the query returns with
 * `groupId: null` — see convex/groups.ts. So rows are keyed by `key`,
 * a normalised name, rather than by `_id`, which two of the five
 * columns and half the rows do not have.
 *
 * Three of the five columns are DERIVED — the members, the count, and
 * the attachments all come out of the roster and out of storage — so
 * they are not editable in the grid. Editing them there would be
 * editing a shadow: membership is a field on the NPC, and the way to
 * change it is to open the NPC.
 */

const EXPAND_COL = 34;
const MIN_COL_WIDTH = 48;

export function GroupTable({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const result = useQuery(api.groups.listForCampaign, { campaignId });
  const isDm = result?.isDm ?? false;

  const prefs = useViewPrefs(campaignId, "groups", isDm, GROUP_COLUMNS);
  const createGroup = useMutation(api.groups.createGroup);
  const describeGroup = useMutation(api.groups.describeGroup);
  const updateGroup = useMutation(api.groups.updateGroup);

  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<
    "columns" | "group" | "filter" | "sort" | null
  >(null);
  const togglePanel = (which: typeof panel) =>
    setPanel((cur) => (cur === which ? null : which));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(
    null
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const router = useRouter();

  const all = useMemo(
    () => (result?.groups ?? []) as GroupRow[],
    [result]
  );

  /* ?open=<name> — how the NPC list sends you to one group.
     A NAME, because the caller is a chip in an NPC's Groups field,
     which is free text. It may match nothing, and that is a normal
     outcome: you land on the list. Opened once per name, tracked in a
     ref, or closing the record you were sent to would reopen it on the
     next render. */
  const params = useSearchParams();
  const openName = params.get("open");
  const handledOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!openName || all.length === 0) return;
    if (handledOpen.current === openName) return;
    const want = openName.replace(/\s+/g, " ").trim().toLowerCase();
    const found = all.find((g) => g.key === want);
    if (!found) return;
    handledOpen.current = openName;
    setSelected(found.rowId);
  }, [openName, all]);

  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of all) m.set(g.rowId, searchText(g, GROUP_COLUMNS));
    return m;
  }, [all]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((g) => {
      const hay = haystacks.get(g.rowId) ?? "";
      return terms.every((t) => hay.includes(t));
    });
  }, [all, haystacks, search]);

  const filtered = useMemo(() => {
    if (prefs.filters.length === 0) return searched;
    return searched.filter((g) =>
      matchesAll(
        (field) => cell(g, field),
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
    for (const key of GROUP_FACET_KEYS) {
      const def = GROUP_COLUMN_BY_KEY.get(key);
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
    for (const col of GROUP_COLUMNS) {
      const seen = new Set<string>();
      for (const g of all) {
        const raw = cell(g, col.key);
        if (Array.isArray(raw)) {
          for (const v of raw as string[]) if (typeof v === "string" && v) seen.add(v);
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

  const selectedGroup = useMemo(
    () => all.find((g) => g.rowId === selected) ?? null,
    [all, selected]
  );

  /** Ordered, visible columns paired with their definitions. */
  const shown = useMemo(() => {
    const out: { state: ColumnState; def: ColumnDef }[] = [];
    for (const state of prefs.columns) {
      const def = GROUP_COLUMN_BY_KEY.get(state.key);
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
      ...GROUP_COLUMNS.filter((c) => c.sortable !== false),
      ...GROUP_EXTRA_SORTS,
    ],
    []
  );

  const filterableFields = GROUP_COLUMNS;

  /** Only the group's own two fields are writable, and only by the DM. */
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
        c.key === GROUP_PRIMARY_COLUMN ? { ...c, visible: true } : { ...c, visible }
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

  /**
   * Save a cell edit, creating the group's row if it had none.
   *
   * A row that is only a name has nothing to patch, so the first edit
   * on one is two writes: describeGroup makes it real, updateGroup
   * fills the field in. `selected` follows the new key, because
   * renaming a group changes the key every other piece of state on
   * this screen is holding.
   */
  async function commitEdit(row: GroupRow, def: ColumnDef, text: string) {
    setEditing(null);
    const value = text.trim();
    if (def.key === "name" && value === "") return;
    try {
      setError(null);
      const groupId =
        row.groupId ?? (await describeGroup({ campaignId, name: row.name }));
      // A row that had no document has just been given one, and its
      // identity moves with it: it was keyed by its name and is keyed
      // by its id from here on. Anything still holding the old key —
      // the open record, chiefly — has to follow, or the record you
      // are looking at closes itself the moment you type in it.
      if (!row.groupId) {
        setSelected((cur) => (cur === row.rowId ? groupId : cur));
      }
      await updateGroup(
        def.key === "name"
          ? { groupId, name: value }
          : { groupId, description: value === "" ? null : value }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that change.");
    }
  }

  /** Follow a member's name to that NPC's own record. */
  const openNpc = (name: string) => {
    const value = name.trim();
    if (!value) return;
    router.push(
      `/campaign/${campaignId}/npcs?open=${encodeURIComponent(value)}`
    );
  };

  if (result === undefined || !prefs.ready) {
    return <p className="centered-note">Loading the groups…</p>;
  }

  return (
    <div className="npc-screen">
      {!selectedGroup && (
        <div className="npc-toolbar">
          <div className="toolbar-left">
            <button
              type="button"
              className="npc-btn primary"
              disabled={!isDm}
              title={isDm ? undefined : "Only the DM can add a group"}
              onClick={async () => {
                try {
                  setError(null);
                  // Opened straight away — a blank row is only useful
                  // once you are typing into it.
                  setSelected(await createGroup({ campaignId }));
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Could not create a group."
                  );
                }
              }}
            >
              <UiText id="group.bar.new" />
            </button>

            <span className="npc-count">
              {sorted.length === all.length
                ? `${all.length} groups`
                : `${sorted.length} of ${all.length}`}
            </span>
          </div>


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
                fields={filterableFields}
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
              labelId="group.bar.search"
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
                    const def = GROUP_COLUMN_BY_KEY.get(state.key);
                    if (!def) return null;
                    if (
                      columnSearch.trim() &&
                      !def.label
                        .toLowerCase()
                        .includes(columnSearch.trim().toLowerCase())
                    ) {
                      return null;
                    }

                    const isPrimary = state.key === GROUP_PRIMARY_COLUMN;
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

      {!selectedGroup && (search || activeFilterCount > 0 || prefs.groupBy) && (
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
          Showing the first {all.length} groups — this campaign is larger than
          one subscription returns. Time to switch this screen to a paginated
          query.
        </p>
      )}

      {selectedGroup ? (
        <GroupDetail
          group={selectedGroup}
          campaignId={campaignId}
          isDm={isDm}
          onOpenNpc={openNpc}
          onBecameReal={(groupId) => setSelected(groupId)}
          onClose={() => setSelected(null)}
        />
      ) : prefs.viewMode === "tiles" ? (
        <GroupTiles
          groups={groups}
          rows={sorted}
          shown={shown}
          perRow={prefs.tilesPerRow}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
          onOpen={setSelected}
          emptyNote={
            all.length === 0
              ? "No groups yet. Add one, or put a group on an NPC."
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
                    rows.map((g) => (
                      <GroupRowCells
                        key={`${groupValue}:${g.rowId}`}
                        row={g}
                        shown={shown}
                        selected={g.rowId === selected}
                        editing={editing}
                        draft={draft}
                        setDraft={setDraft}
                        canEdit={canEdit}
                        onOpen={() => setSelected(g.rowId)}
                        onOpenNpc={openNpc}
                        onStartEdit={(def, value) => {
                          setEditing({ id: g.rowId, key: def.key });
                          setDraft(value);
                        }}
                        onCommit={(def, text) => void commitEdit(g, def, text)}
                        onCancel={() => setEditing(null)}
                      />
                    ))}
                </tbody>
              ))
            ) : (
              <tbody>
                {sorted.map((g) => (
                  <GroupRowCells
                    key={g.rowId}
                    row={g}
                    shown={shown}
                    selected={g.rowId === selected}
                    editing={editing}
                    draft={draft}
                    setDraft={setDraft}
                    canEdit={canEdit}
                    onOpen={() => setSelected(g.rowId)}
                    onOpenNpc={openNpc}
                    onStartEdit={(def, value) => {
                      setEditing({ id: g.rowId, key: def.key });
                      setDraft(value);
                    }}
                    onCommit={(def, text) => void commitEdit(g, def, text)}
                    onCancel={() => setEditing(null)}
                  />
                ))}
              </tbody>
            )}
          </table>

          {sorted.length === 0 && (
            <p className="centered-note">
              {all.length === 0
                ? "No groups yet. Add one, or put a group on an NPC."
                : "Nothing matches those filters."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function GroupRowCells({
  row,
  shown,
  selected,
  editing,
  draft,
  setDraft,
  canEdit,
  onOpen,
  onOpenNpc,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  row: GroupRow;
  shown: { state: ColumnState; def: ColumnDef }[];
  selected: boolean;
  editing: { id: string; key: string } | null;
  draft: string;
  setDraft: (v: string) => void;
  canEdit: (def: ColumnDef) => boolean;
  onOpen: () => void;
  onOpenNpc: (name: string) => void;
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
          title={`Open ${row.name || "this group"}`}
          aria-label={`Open ${row.name || "this group"}`}
          onClick={onOpen}
        >
          <ExpandIcon />
        </button>
      </td>

      {shown.map(({ state, def }) => {
        const isEditing = editing?.id === row.rowId && editing.key === def.key;

        if (isEditing) {
          return (
            <td key={state.key} className="editing-cell">
              <input
                autoFocus
                className="cell-input"
                type="text"
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
          onStartEdit(def, raw === null || raw === undefined ? "" : String(raw));
        };

        if (def.kind === "picture") {
          // The first attachment stands for the rest, the way the
          // roster's portrait column does. The count says there are
          // more without the row growing to hold them.
          const first = row.attachments[0];
          return (
            <td key={state.key} className="pic-cell">
              {first ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img className="row-portrait" src={first.url} alt="" />
              ) : (
                <span className="row-portrait empty" />
              )}
              {row.attachments.length > 1 && (
                <span className="shot-more">+{row.attachments.length - 1}</span>
              )}
            </td>
          );
        }

        if (def.kind === "chips") {
          const vals = chipValues(row, def.key);
          return (
            <td key={state.key}>
              {vals.length === 0 ? (
                <span className="blank">{BLANK}</span>
              ) : (
                <span className="cell-chips">
                  {vals.map((v) => (
                    <button
                      type="button"
                      className="chip chip-link"
                      key={v}
                      title="Open this NPC"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenNpc(v);
                      }}
                    >
                      {v}
                    </button>
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
              def.key === "name" ? "name-cell" : "",
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
 * Tile view — the first attachment leads, the fields follow.
 *
 * The same visible-column set as the grid, so hiding a field hides it
 * in both places rather than the two views drifting into two different
 * answers to "what is on a group".
 */
function GroupTiles({
  groups,
  rows,
  shown,
  perRow,
  collapsed,
  onToggleGroup,
  onOpen,
  emptyNote,
}: {
  groups: [string, GroupRow[]][] | null;
  rows: GroupRow[];
  shown: { state: ColumnState; def: ColumnDef }[];
  perRow: number;
  collapsed: Set<string>;
  onToggleGroup: (value: string) => void;
  onOpen: (key: string) => void;
  emptyNote: string;
}) {
  const style = { ["--tiles-per-row" as string]: String(perRow) };

  if (rows.length === 0) return <p className="centered-note">{emptyNote}</p>;

  if (groups) {
    return (
      <div className="tile-groups">
        {groups.map(([value, groupRowsIn]) => (
          <section key={value}>
            <button
              type="button"
              className="tile-group-head"
              onClick={() => onToggleGroup(value)}
            >
              <span className="caret">{collapsed.has(value) ? "▸" : "▾"}</span>
              {value}
              <span className="n">{groupRowsIn.length}</span>
            </button>
            {!collapsed.has(value) && (
              <div className="tile-grid" style={style}>
                {groupRowsIn.map((g) => (
                  <GroupTile
                    key={`${value}:${g.rowId}`}
                    row={g}
                    shown={shown}
                    onOpen={() => onOpen(g.rowId)}
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
      {rows.map((g) => (
        <GroupTile
          key={g.rowId}
          row={g}
          shown={shown}
          onOpen={() => onOpen(g.rowId)}
        />
      ))}
    </div>
  );
}

function GroupTile({
  row,
  shown,
  onOpen,
}: {
  row: GroupRow;
  shown: { state: ColumnState; def: ColumnDef }[];
  onOpen: () => void;
}) {
  const first = row.attachments[0];
  const fields = shown.filter(
    (c) => c.def.kind !== "picture" && c.def.key !== "name"
  );

  return (
    <button type="button" className="npc-tile" onClick={onOpen}>
      {first ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="tile-portrait" src={first.url} alt="" />
      ) : (
        <span className="tile-portrait empty" />
      )}
      <span className="tile-name">{row.name || "Unnamed group"}</span>
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
