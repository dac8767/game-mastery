"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useViewPrefs } from "@/components/useViewPrefs";
import { Pager } from "@/components/Pager";
import { clampPageSize, pageSlice } from "@/components/pagerModel";
import { NpcDetail, fromInput } from "@/components/NpcDetail";
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
import {
  COLUMNS,
  COLUMN_BY_KEY,
  ColumnDef,
  ColumnState,
  EXTRA_SORTS,
  FACET_KEYS,
  MATURITY_ORDER,
  portraitSrc,
} from "@/components/npcColumns";

/**
 * The expand column's width, in pixels.
 *
 * Fixed and outside the layout: it is the way into a record rather than
 * a fact about the NPC, so it cannot be hidden, reordered or dragged
 * narrower. The table's own width has to count it or the last column
 * runs off the end of the wrapper.
 */
const EXPAND_COL = 34;

/**
 * What following a link will do, said before you click it.
 *
 * A chip that navigates and a chip that does not look identical
 * otherwise, and the difference matters most on the columns where both
 * kinds sit side by side.
 */
const LINK_TITLES: Record<NonNullable<ColumnDef["linksTo"]>, string> = {
  npc: "Open this NPC",
  species: "Look this species up",
  location: "Show this place on the map",
  group: "Open this group",
};

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
 * machines. The one thing personal preference cannot reach is the GM
 * boundary: hidden NPCs never arrive for a player, `secret` and
 * `dmNotes` arrive as null, and GM-only columns are not offered.
 */

type NpcListResult = FunctionReturnType<typeof api.npcs.listForCampaign>;
type Npc = NpcListResult["npcs"][number];

const MIN_COL_WIDTH = 48;
/**
 * The one column that can't be hidden.
 *
 * "Hide all" with nothing exempt leaves a table of zero columns, which
 * looks like the roster was wiped rather than like a display setting.
 * Airtable protects its primary field the same way.
 */
const PRIMARY_COLUMN = "name";

/** Life stages sort in narrative order rather than alphabetically. */
const RANKS = { maturity: MATURITY_ORDER };

function chipClass(columnKey: string, value: string): string {
  if (columnKey !== "gender") return "chip";
  const v = value.toLowerCase();
  if (v.includes("female")) return "chip gender-female";
  if (v.includes("male")) return "chip gender-male";
  return "chip gender-other";
}

export function NpcTable({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const result = useQuery(api.npcs.listForCampaign, { campaignId });
  const isDm = result?.isDm ?? false;
  // The page size. AppShell already holds this subscription, so this
  // is the same one rather than a second server call.
  const settings = useQuery(api.settings.mySettings);

  const prefs = useViewPrefs(campaignId, "npcs", isDm);
  const updateNpc = useMutation(api.npcs.updateNpc);
  const createNpc = useMutation(api.npcs.createNpc);
  const setPlayerNotes = useMutation(api.npcs.setPlayerNotes);

  const [search, setSearch] = useState("");
  /**
   * One panel at a time.
   *
   * Three independent booleans let Columns, Filter and Sort stack on
   * top of each other and push the table off the screen — and a toolbar
   * whose buttons each show a count is a toolbar you open to change one
   * thing and close again.
   */
  const [panel, setPanel] = useState<
    "columns" | "group" | "filter" | "sort" | null
  >(null);
  const togglePanel = (which: typeof panel) =>
    setPanel((cur) => (cur === which ? null : which));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Id<"npcs"> | null>(null);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(
    null
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [columnSearch, setColumnSearch] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const all = useMemo(() => result?.npcs ?? [], [result]);

  /* ?open=<name> — how another screen sends you to one NPC.
     A NAME rather than an id, the same way Locations and Lookup take
     one, because the caller is a Groups row whose member list is built
     out of NPC names. A name that matches nobody lands you on the
     roster rather than on an error. Opened once per name, tracked in a
     ref rather than derived from state, or closing the record you were
     sent to would reopen it on the next render. */
  const params = useSearchParams();
  const openName = params.get("open");
  const handledOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!openName || all.length === 0) return;
    if (handledOpen.current === openName) return;
    const want = openName.replace(/\s+/g, " ").trim().toLowerCase();
    const found = all.find(
      (n) => n.name.replace(/\s+/g, " ").trim().toLowerCase() === want
    );
    if (!found) return;
    handledOpen.current = openName;
    setSelected(found._id);
  }, [openName, all]);

  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of all) m.set(n._id, searchText(n, COLUMNS));
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

  const sorted = useMemo(
    () => sortRows(filtered, prefs.sortKey, prefs.sortAsc, RANKS),
    [filtered, prefs.sortKey, prefs.sortAsc]
  );

  const facetOptions = useMemo(() => {
    const out: {
      key: string;
      label: string;
      options: { value: string; count: number }[];
    }[] = [];

    for (const key of FACET_KEYS) {
      const def = COLUMN_BY_KEY.get(key);
      if (!def || (def.dmOnly && !isDm)) continue;

      const options = facetCounts(searched, filtered, key);
      // A facet whose column is entirely blank is noise — leave it out.
      if (options.length === 0) continue;
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

  /* One page of the list, cut BEFORE grouping: "N rows at a time"
     counts rows, and the groups on screen are rebuilt from the page.
     The page is clamped against the list rather than reset by it, so
     a filter that shrinks the list lands on the new last page. */
  const [page, setPage] = useState(0);
  const pageSize = clampPageSize(settings?.tableRows);
  const paged = useMemo(
    () => pageSlice(sorted, page, pageSize),
    [sorted, page, pageSize]
  );

  const groups = useMemo(
    () => (prefs.groupBy ? groupRows(paged, prefs.groupBy) : null),
    [paged, prefs.groupBy]
  );

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

  /**
   * Whether a sort has been CHOSEN, which is not the same as whether the
   * list is sorted — it always is. Measured against the shipped default
   * rather than a literal, so the badge cannot start lying the day the
   * default changes.
   */
  const sortCount =
    prefs.sortKey !== prefs.defaultSortKey ||
    prefs.sortAsc !== prefs.defaultSortAsc
      ? 1
      : 0;

  /** Everything the Sort panel may sort on, in the order it offers it. */
  const sortableFields = useMemo(
    () => [
      ...COLUMNS.filter((c) => c.sortable !== false && (isDm || !c.dmOnly)),
      ...EXTRA_SORTS,
    ],
    [isDm]
  );

  /** Fields a condition may target — GM-only columns only for the GM. */
  const filterableFields = useMemo(
    () => COLUMNS.filter((c) => isDm || !c.dmOnly),
    [isDm]
  );

  const canEdit = (def: ColumnDef) =>
    isDm ? Boolean(def.editable) : Boolean(def.playerEditable);

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

  function startExpandResize(event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = prefs.expandWidth ?? EXPAND_COL;
    const onMove = (e: PointerEvent) =>
      prefs.setExpandWidth(startWidth + (e.clientX - startX));
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

  /** Same normalising the record's family links use. */
  const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();

  /**
   * Follow a value that names something else.
   *
   * Which columns do this is declared in npcColumns.ts, not decided
   * here: the grid should not know that Place means the Locations
   * tool. Every one of these is free text somebody typed into
   * Airtable, so a value that resolves to nothing does nothing rather
   * than navigating to an empty screen.
   */
  const openLink = (kind: ColumnDef["linksTo"], raw: string) => {
    const value = raw.trim();
    if (!kind || !value) return;

    if (kind === "npc") {
      const found = all.find((n) => norm(n.name) === norm(value));
      if (found) setSelected(found._id);
      return;
    }

    // Named per kind rather than reached by a ternary's else-branch.
    // `kind === "species" ? "species" : "locations"` sent EVERY other
    // kind to Locations, so a fifth link target added later would have
    // navigated somewhere plausible and wrong instead of failing.
    //
    // A group used to be the exception here: it set a filter on this
    // list instead of navigating, because a group WAS a set of NPCs and
    // nothing else. It has a screen of its own now — a description, its
    // pictures, and the roll of who is in it — so the chip goes there
    // like every other link on the row.
    const to =
      kind === "species"
        ? `lookup?tab=species&open=${encodeURIComponent(value)}`
        : kind === "location"
          ? `locations?open=${encodeURIComponent(value)}`
          : kind === "group"
            ? `groups?open=${encodeURIComponent(value)}`
            : null;
    if (!to) return;
    router.push(`/campaign/${campaignId}/${to}`);
  };

  if (result === undefined || !prefs.ready) {
    return <p className="centered-note">Loading the roster…</p>;
  }

  return (
    <div className="npc-screen">
      {!selectedNpc && (
      <div className="npc-toolbar">
        {/* + New NPC on the left, everything that CHANGES the list on
            the right. The three quick-filter dropdowns that used to sit
            here are gone: Filter does the same job with every field
            rather than three, and three permanently open selects made
            the row read as a form. */}
        <div className="toolbar-left">
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
            <UiText id="npc.bar.new" />
          </button>

          {/* The count, beside the button that changes it. It was down
              on the substrip under the toolbar, a row of its own for
              one short phrase, and a long way from anything it relates
              to. */}
          <span className="npc-count">
            {sorted.length === all.length
              ? `${all.length} NPCs`
              : `${sorted.length} of ${all.length}`}
          </span>
        </div>


        <div className="toolbar-right">
          {/* Filter, Group, Sort, View, Search, and then the menu — the
              order runs from "what is shown" to "which of it" to the
              settings you touch once a week.

              A count, not the setting. "Group Species · Filter 2 · Sort
              Last seen" was three settings read out at you every time
              you looked at the screen; the number is the part you need
              at a glance, and the panel behind the button is where the
              detail belongs. */}
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
              <span><UiText id="list.panel.groupBy" /></span>
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
              <span><UiText id="list.panel.sortBy" /></span>
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
            labelId="npc.bar.search"
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
                    {def.dmOnly && <span className="dm-tag">GM</span>}

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
          </MoreMenu>
        </div>
      </div>
      )}

      {/* The substrip is now only for things that are TRUE right now —
          a preview in progress, filters worth clearing. With the count
          moved up it is usually nothing, and an empty strip taking a
          row is the reason the count was down here in the first
          place. */}
      {!selectedNpc && (search || activeFilterCount > 0 || prefs.groupBy) && (
      <div className="npc-substrip">
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
      </div>
      )}

      {error && <p className="form-error">{error}</p>}

      {result.truncated && (
        <p className="npc-notice">
          Showing the first {all.length} NPCs — the roster is larger than one
          subscription returns. Time to switch this screen to a paginated
          query.
        </p>
      )}





      {/* An open record takes the list's place in the layout rather than
          covering it: same flex slot, so it gets the whole area the
          table had. The toolbar above stays, which is what makes it
          read as "inside the list" rather than as a separate page. */}
      {selectedNpc ? (
        <NpcDetail
          npc={selectedNpc}
          campaignId={campaignId}
          isDm={isDm}
          /* Resolved here because the roster lives here. Case- and
             space-insensitive: these names were typed by hand into
             Airtable, and "Kelja  Ironfist" should still find her. */
          onOpenNamed={(name) => {
            const want = name.replace(/\s+/g, " ").trim().toLowerCase();
            const found = all.find(
              (n) => n.name.replace(/\s+/g, " ").trim().toLowerCase() === want
            );
            if (!found) return false;
            setSelected(found._id);
            return true;
          }}
          onClose={() => setSelected(null)}
        />
      ) : prefs.viewMode === "tiles" ? (
        <TileGrid
          groups={groups}
          rows={paged}
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
          <table
            className="npc-table"
            style={{ width: `${totalWidth + (prefs.expandWidth ?? EXPAND_COL)}px` }}
          >
          {/* The expand column, ahead of everything the layout
              arranges. It is not a COLUMN in the useViewPrefs sense —
              it cannot be hidden, reordered or resized, because it is
              the way into the record rather than a fact about the NPC,
              and a layout that could hide it would hide the only
              visible way to open one. */}
          <colgroup>
            <col style={{ width: `${prefs.expandWidth ?? EXPAND_COL}px` }} />
            {shown.map(({ state }) => (
              <col key={state.key} style={{ width: `${state.width}px` }} />
            ))}
          </colgroup>

          <thead>
            <tr>
                            <th className="expand-th" aria-label="Open">
                {/* The divider Derek asked for: the button's own track
                    can be widened to space the fields away from it.
                    Persisted with the rest of the layout. */}
                <span
                  className="col-resize"
                  title="Drag to move the first column"
                  onPointerDown={(e) => startExpandResize(e)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
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
                      onLink={openLink}
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
              {paged.map((n) => (
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
                  onLink={openLink}
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

      {/* Under both views, never under an open record. */}
      {!selectedNpc && (
        <Pager
          total={sorted.length}
          page={page}
          size={pageSize}
          onPage={setPage}
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
  onLink,
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
  /** Follow a value that names something else. See COLUMNS.linksTo. */
  onLink?: (kind: ColumnDef["linksTo"], value: string) => void;
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
      {/* Opening the record had no visible control at all: you clicked
          the portrait, or a cell you could not edit, and learned that
          by trying. A row of 198 with no picture had nowhere obvious to
          click, and every editable cell went into edit instead. */}
      <td className="expand-cell">
        <button
          type="button"
          className="expand-btn"
          title={`Open ${npc.name || "this NPC"}`}
          aria-label={`Open ${npc.name || "this NPC"}`}
          onClick={onOpen}
        >
          <ExpandIcon />
        </button>
      </td>

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
          const src = portraitSrc(npc.portraitUrl, npc.portraitPath, mapServer);
          return (
            /* No longer opens the record. The expand button is the one
               way in, so a picture that also opened it was a second,
               invisible control that only rows WITH a portrait had. */
            <td key={state.key} className="pic-cell">
              {src ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img className="row-portrait" src={src} alt="" />
              ) : (
                <span className="row-portrait empty" />
              )}
            </td>
          );
        }

        if (def.kind === "chips" || def.chip) {
          const vals = chipValues(npc, def.key);
          const links = Boolean(def.linksTo && onLink);
          return (
            <td
              key={state.key}
              className={editable ? "editable" : undefined}
              /* A linking column edits on DOUBLE click and follows on
                 single. Every other editable cell edits on single.
                 The two readings of the report collide here — these
                 columns are both editable and links — and this is the
                 split that keeps editing reachable while a single
                 click on a chip does the thing the chip looks like it
                 does. */
              onDoubleClick={open}
              onClick={links || !editable ? undefined : open}
            >
              {vals.length === 0 ? (
                <span className="blank">{BLANK}</span>
              ) : (
                <span className="cell-chips">
                  {vals.map((v) =>
                    links ? (
                      <button
                        type="button"
                        className={`${chipClass(def.key, v)} chip-link`}
                        key={v}
                        title={LINK_TITLES[def.linksTo!]}
                        onClick={(e) => {
                          // The row and the cell both listen; without
                          // this, following a link would also start an
                          // edit underneath it.
                          e.stopPropagation();
                          onLink?.(def.linksTo, v);
                        }}
                      >
                        {v}
                      </button>
                    ) : (
                      <span className={chipClass(def.key, v)} key={v}>
                        {v}
                      </span>
                    )
                  )}
                </span>
              )}
            </td>
          );
        }

        const text = display(npc, def.key, def.format);
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
            /* Single click edits, for a GM. It used to take two, and
               the name cell opened the record instead — so the one
               cell every row has was the one you could not edit
               without knowing to double-click it. */
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
        {portraitSrc(npc.portraitUrl, npc.portraitPath, mapServer) ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={portraitSrc(npc.portraitUrl, npc.portraitPath, mapServer)!}
            alt=""
          />
        ) : (
          <span className="tile-portrait-empty">{npc.name.charAt(0)}</span>
        )}
      </div>

      <h3 className="tile-name">{npc.name}</h3>

      <dl className="tile-fields">
        {fields.map(({ def }) => {
          const chips =
            def.kind === "chips" || def.chip ? chipValues(npc, def.key) : null;
          const text = display(npc, def.key, def.format);
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
