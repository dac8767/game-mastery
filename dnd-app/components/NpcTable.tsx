"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  DEFAULT_SORT_ASC,
  DEFAULT_SORT_KEY,
  useViewPrefs,
} from "@/components/useViewPrefs";
import { NpcDetail, fromInput } from "@/components/NpcDetail";
import { FilterPanel } from "@/components/FilterPanel";
import { matchesAll } from "@/components/npcFilters";
import { UiText, useUiText } from "@/components/UiEditor";
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

/**
 * A toolbar button that carries a count instead of its setting.
 *
 * The count is the whole point: "Filter 2" tells you the list you are
 * looking at is not the whole list, which is the thing you need from
 * across the room. WHICH two filters is a question you ask by opening
 * the panel, and it is the only question the panel exists to answer.
 *
 * Zero shows nothing at all rather than a "0" — a badge that is always
 * there stops being a signal.
 */
function BarButton({
  labelId,
  count,
  open,
  onClick,
}: {
  /** A registry id, so edit mode can rename it in place. */
  labelId: string;
  count: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`bar-btn${open ? " open" : ""}${count > 0 ? " on" : ""}`}
      aria-expanded={open}
      onClick={onClick}
    >
      <UiText id={labelId} />
      {count > 0 && <span className="bar-count">{count}</span>}
    </button>
  );
}

/**
 * How the roster is drawn, as a chip rather than a labelled dropdown.
 *
 * "View  [Grid ⌄]" spent two words and a form control saying what one
 * word and a caret say. The icon carries the meaning across the room —
 * rows for a grid, squares for tiles — and the name is there for when
 * it does not.
 *
 * Tiles-per-row lives INSIDE it rather than beside it, because it is a
 * setting of one view. On the grid it was a control for something you
 * could not see.
 */
function ViewPicker({
  mode,
  perRow,
  setMode,
  setPerRow,
}: {
  mode: "grid" | "tiles";
  perRow: number;
  setMode: (next: "grid" | "tiles") => void;
  setPerRow: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="view-picker">
      <button
        type="button"
        className={`bar-btn${open ? " open" : ""}`}
        aria-expanded={open}
        aria-label={`View: ${mode === "grid" ? "Grid" : "Tiles"}`}
        onClick={() => setOpen((v) => !v)}
      >
        {mode === "grid" ? <GridIcon /> : <TilesIcon />}
        <UiText id={mode === "grid" ? "npc.view.grid" : "npc.view.tiles"} />
        <CaretIcon />
      </button>

      {open && (
        <>
          {/* Closes on a click anywhere else, which is the gesture
              everybody already tries. */}
          <span className="view-scrim" onClick={() => setOpen(false)} />
          <div className="view-menu" role="menu">
            <button
              type="button"
              className={`view-option${mode === "grid" ? " on" : ""}`}
              onClick={() => {
                setMode("grid");
                setOpen(false);
              }}
            >
              <GridIcon />
              <UiText id="npc.view.grid" />
            </button>
            <button
              type="button"
              className={`view-option${mode === "tiles" ? " on" : ""}`}
              onClick={() => setMode("tiles")}
            >
              <TilesIcon />
              <UiText id="npc.view.tiles" />
            </button>

            {mode === "tiles" && (
              <label className="npc-select view-perrow">
                <UiText id="npc.view.perRow" />
                <select
                  value={perRow}
                  onChange={(e) => setPerRow(Number(e.target.value))}
                >
                  {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * The chevron on the View chip.
 *
 * Drawn rather than typed. It was "⌄" — U+2304 DOWN ARROWHEAD — which
 * a text renderer sits on the BASELINE like a letter, so it hung below
 * the words beside it and no amount of line-height fixed it: the glyph
 * is where the font says it is. An SVG is centred by the flexbox like
 * the other icons on the bar, because it is a box rather than a
 * character.
 */
function CaretIcon() {
  return (
    <svg
      className="bar-caret"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 6l5 5 5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The expand icon on each row: two arrows going opposite ways. */
function ExpandIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M9.5 2.5H13.5V6.5M6.5 13.5H2.5V9.5M13.5 2.5L9 7M2.5 13.5L7 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Three vertical dots: the things you reach for once a week. */
function MoreIcon() {
  return (
    <svg
      className="bar-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="3" r="1.5" fill="currentColor" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="13" r="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * The overflow menu, right of the search box.
 *
 * Reset and Fields lived on the bar beside Filter, Group and Sort, and
 * did not belong there: those three are what you are doing to the list
 * right now and carry a count saying so, while these two are settings
 * you touch once and then not again for a week. Six buttons in a row
 * all look equally likely; four plus a menu says which is which.
 */
function MoreMenu({
  onResetLayout,
  onFields,
  fieldsOpen,
}: {
  onResetLayout: () => void;
  onFields: () => void;
  fieldsOpen: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="view-picker">
      <button
        type="button"
        className={`bar-btn icon-only${open ? " open" : ""}`}
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>

      {open && (
        <>
          <span className="view-scrim" onClick={() => setOpen(false)} />
          <div className="view-menu" role="menu">
            <button
              type="button"
              className={`view-option${fieldsOpen ? " on" : ""}`}
              onClick={() => {
                onFields();
                setOpen(false);
              }}
            >
              <UiText id="npc.more.fields" />
            </button>
            <button
              type="button"
              className="view-option"
              onClick={() => {
                onResetLayout();
                setOpen(false);
              }}
            >
              <UiText id="npc.more.reset" />
            </button>
          </div>
        </>
      )}
    </span>
  );
}

function GridIcon() {
  return (
    <svg
      className="bar-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2.5" width="13" height="3" rx="1" fill="currentColor" />
      <rect x="1.5" y="6.75" width="13" height="3" rx="1" fill="currentColor" />
      <rect x="1.5" y="11" width="13" height="3" rx="1" fill="currentColor" />
    </svg>
  );
}

function TilesIcon() {
  return (
    <svg
      className="bar-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * Search: an icon until you want it, a field once you do.
 *
 * It does NOT collapse while it holds text. A search box that tidied
 * itself away with a query still in it would leave a shorter list on
 * screen and nothing saying why — the same failure as a hidden filter,
 * and the one thing this toolbar is careful about everywhere else.
 *
 * Declared at module level, not inside NpcTable: a component defined
 * during render is a new component type on every render, so React
 * unmounts the old one and the input loses focus after each keystroke.
 */
function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // A placeholder is an attribute, not a child, so it reads the text
  // through the hook rather than rendering <UiText>. Renaming it in
  // edit mode still works — you rename it on the collapsed button,
  // which is the same registry entry.
  const label = useUiText("npc.bar.search");

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open && !value) {
    return (
      <button
        type="button"
        className="bar-btn bar-search-btn"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
      </button>
    );
  }

  return (
    <div className="bar-search">
      <SearchIcon />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={label}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          onChange("");
          setOpen(false);
        }}
      />
      <button
        type="button"
        className="bar-search-clear"
        aria-label="Close the search"
        onClick={() => {
          onChange("");
          setOpen(false);
        }}
      >
        ×
      </button>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      className="bar-search-icon"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="7"
        cy="7"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <line
        x1="10.4"
        y1="10.4"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function NpcTable({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const result = useQuery(api.npcs.listForCampaign, { campaignId });
  const isDm = result?.isDm ?? false;

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

  /**
   * Whether a sort has been CHOSEN, which is not the same as whether the
   * list is sorted — it always is. Measured against the shipped default
   * rather than a literal, so the badge cannot start lying the day the
   * default changes.
   */
  const sortCount =
    prefs.sortKey !== DEFAULT_SORT_KEY || prefs.sortAsc !== DEFAULT_SORT_ASC
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

  /** Fields a condition may target — DM-only columns only for the DM. */
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

        {/* Between the count and the controls, centred by the flex
            gap on either side of it. It was down on the substrip, a
            row below the bar and hard against the left edge — a state
            you are IN, filed under the row for things you have DONE. */}
        {result.previewingAsPlayer && (
          <span className="preview-flag">Viewing as a player</span>
        )}

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
            labelId="npc.bar.filter"
            count={activeFilterCount}
            open={panel === "filter"}
            onClick={() => togglePanel("filter")}
          />
          <BarButton
            labelId="npc.bar.group"
            count={prefs.groupBy ? 1 : 0}
            open={panel === "group"}
            onClick={() => togglePanel("group")}
          />
          <BarButton
            labelId="npc.bar.sort"
            count={sortCount}
            open={panel === "sort"}
            onClick={() => togglePanel("sort")}
          />

          <ViewPicker
            mode={prefs.viewMode}
            perRow={prefs.tilesPerRow}
            setMode={prefs.setViewMode}
            setPerRow={prefs.setTilesPerRow}
          />

          <SearchBox value={search} onChange={setSearch} />

          <MoreMenu
            fieldsOpen={panel === "columns"}
            onFields={() => togglePanel("columns")}
            onResetLayout={prefs.resetLayout}
          />
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

      {panel === "group" && (
        <div className="filter-panel">
          <div className="filter-title">Group</div>
          <label className="npc-select">
            <span><UiText id="npc.panel.groupBy" /></span>
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
      )}

      {panel === "sort" && (
        <div className="filter-panel">
          <div className="filter-title">Sort</div>
          <label className="npc-select">
            <span><UiText id="npc.panel.sortBy" /></span>
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
                  ? "npc.panel.ascending"
                  : "npc.panel.descending"
              }
            />
          </button>
          {sortCount > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                prefs.setSortKey(DEFAULT_SORT_KEY);
                prefs.setSortAsc(DEFAULT_SORT_ASC);
              }}
            >
              Back to the default
            </button>
          )}
        </div>
      )}

      {panel === "columns" && (
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

      {panel === "filter" && (
        <FilterPanel
          conditions={prefs.filters}
          conjunction={prefs.filterConjunction}
          fields={filterableFields}
          valueOptions={valueOptions}
          onChange={prefs.setFilters}
          onConjunctionChange={prefs.setFilterConjunction}
        />
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
          <table
            className="npc-table"
            style={{ width: `${totalWidth + EXPAND_COL}px` }}
          >
          {/* The expand column, ahead of everything the layout
              arranges. It is not a COLUMN in the useViewPrefs sense —
              it cannot be hidden, reordered or resized, because it is
              the way into the record rather than a fact about the NPC,
              and a layout that could hide it would hide the only
              visible way to open one. */}
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
            <td key={state.key} className="pic-cell" onClick={onOpen}>
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
