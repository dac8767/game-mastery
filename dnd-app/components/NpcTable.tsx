"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useColumnWidths } from "@/components/useColumnWidths";

/**
 * The NPC roster — an Airtable-style grid over npcs.listForCampaign.
 *
 * Everything interactive (search, facet filters, grouping, sorting,
 * column widths) runs in the browser against the single subscription's
 * rows. That is the point: a server round trip per keystroke would spend
 * the free tier's pooled function-call budget on work a few hundred rows
 * can do instantly in memory. See the note in convex/npcs.ts for the
 * threshold at which this should become a paginated, server-filtered
 * query.
 *
 * The DM/player split is NOT enforced here — it already happened on the
 * server. Hidden NPCs never arrive for players, and `secret`/`dmNotes`
 * arrive as null, so the DM-only column simply renders empty. Never
 * reintroduce those fields client-side.
 */

type NpcListResult = FunctionReturnType<typeof api.npcs.listForCampaign>;
type Npc = NpcListResult["npcs"][number];

/** Bucket label for rows with no value in a faceted field. */
const EMPTY = "—";

/** Placeholder shown in a blank grid cell. */
const BLANK = "–";

/** Fields offered as filters and as "group by" options. */
const FACETS = [
  { key: "status", label: "Status" },
  { key: "species", label: "Species" },
  { key: "groups", label: "Groups" },
  { key: "place", label: "Place" },
  { key: "job", label: "Job" },
  { key: "maturity", label: "Maturity" },
  { key: "gender", label: "Gender" },
  { key: "lineage", label: "Lineage" },
  { key: "region", label: "Region" },
  { key: "kingdom", label: "Kingdom" },
  { key: "alignment", label: "Alignment" },
  { key: "sexuality", label: "Sexuality" },
] as const;

/** The three facets promoted to always-visible dropdowns. */
const QUICK_FILTERS = ["status", "species", "gender"] as const;

type ColumnKind = "text" | "chips" | "picture";

/** Columns in the grid. Headers sort; borders resize. */
const COLUMNS: {
  key: string;
  label: string;
  kind: ColumnKind;
  sortable?: boolean;
}[] = [
  { key: "portraitPath", label: "Picture", kind: "picture", sortable: false },
  { key: "name", label: "Name", kind: "text" },
  { key: "job", label: "Job", kind: "chips" },
  { key: "age", label: "Age", kind: "text" },
  { key: "gender", label: "Gender", kind: "chips" },
  { key: "species", label: "Species", kind: "chips" },
  { key: "lineage", label: "Lineage", kind: "text" },
  { key: "sexuality", label: "Sexuality", kind: "text" },
  { key: "familyMembers", label: "Family Members", kind: "chips" },
  { key: "groups", label: "Groups", kind: "chips" },
  { key: "place", label: "Place", kind: "chips" },
  { key: "status", label: "Status", kind: "chips" },
];

/** Key for the DM-only column, which isn't part of COLUMNS. */
const DM_COL = "__dm";

const DEFAULT_WIDTHS: Record<string, number> = {
  portraitPath: 76,
  name: 190,
  job: 150,
  age: 72,
  gender: 116,
  species: 130,
  lineage: 110,
  sexuality: 120,
  familyMembers: 220,
  groups: 190,
  place: 160,
  status: 150,
  [DM_COL]: 112,
};

/** Extra sort keys that aren't columns. */
const EXTRA_SORTS = [
  { key: "family", label: "Family name" },
  { key: "maturity", label: "Maturity" },
  { key: "maxAge", label: "Max age" },
  { key: "familyMemberCount", label: "Family size" },
  { key: "_creationTime", label: "Date added" },
] as const;

/** Life stages sort in narrative order, not alphabetically. */
const MATURITY_ORDER = ["Child", "Young Adult", "Adult", "Senior"];

function cell(npc: Npc, key: string): unknown {
  return (npc as unknown as Record<string, unknown>)[key];
}

/** The values a row contributes to a facet; [EMPTY] when it has none. */
function facetValues(npc: Npc, key: string): string[] {
  const raw = cell(npc, key);
  if (Array.isArray(raw)) {
    const vals = (raw as string[]).filter((v) => v && v.trim());
    return vals.length > 0 ? vals : [EMPTY];
  }
  if (typeof raw === "string" && raw.trim()) return [raw];
  return [EMPTY];
}

/** Values to render as chips in a grid cell — empty array when blank. */
function chipValues(npc: Npc, key: string): string[] {
  return facetValues(npc, key).filter((v) => v !== EMPTY);
}

/** Display string for a plain-text grid cell. */
function display(npc: Npc, key: string): string {
  const raw = cell(npc, key);
  if (Array.isArray(raw)) return (raw as string[]).join(", ");
  if (raw === null || raw === undefined || raw === "") return "";
  return String(raw);
}

/** Gender gets its own chip tint, as in the design. */
function chipClass(columnKey: string, value: string): string {
  if (columnKey !== "gender") return "chip";
  const v = value.toLowerCase();
  if (v.includes("female")) return "chip gender-female";
  if (v.includes("male")) return "chip gender-male";
  return "chip gender-other";
}

function searchText(npc: Npc): string {
  return [
    npc.name,
    npc.nickname,
    npc.prefix,
    npc.first,
    npc.middle,
    npc.family,
    npc.suffix,
    npc.job,
    npc.species,
    npc.lineage,
    npc.gender,
    npc.maturity,
    npc.region,
    npc.kingdom,
    npc.alignment,
    npc.sexuality,
    npc.voice,
    npc.description,
    npc.politics,
    npc.abilities,
    npc.wantsNeeds,
    npc.quirkMental,
    npc.quirkPhysical,
    npc.playerNotes,
    // Null for players — searchable only for the DM, by construction.
    npc.dmNotes,
    npc.secret,
    ...npc.status,
    ...npc.groups,
    ...npc.place,
    ...npc.familyMembers,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [groupBy, setGroupBy] = useState<string>("");
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<Id<"npcs"> | null>(null);

  const { widths, startResize, resetColumn, resetAll } = useColumnWidths(
    "npc-table-widths",
    DEFAULT_WIDTHS
  );

  const all = useMemo(() => result?.npcs ?? [], [result]);

  // Precompute one lowercase haystack per row so typing doesn't rebuild
  // every string on every keystroke.
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
    const active = Object.entries(filters).filter(([, v]) => v.length > 0);
    if (active.length === 0) return searched;
    // Within one facet the selections are OR'd; across facets they're
    // AND'd — the behavior people expect from Airtable and every
    // faceted search.
    return searched.filter((n) =>
      active.every(([key, chosen]) => {
        const vals = facetValues(n, key);
        return chosen.some((c) => vals.includes(c));
      })
    );
  }, [searched, filters]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      const c = compare(a, b, sortKey);
      return sortAsc ? c : -c;
    });
    return rows;
  }, [filtered, sortKey, sortAsc]);

  /** Facet options built from everything the search matched, with counts
   *  reflecting the current filter state. */
  const facetOptions = useMemo(() => {
    const out: {
      key: string;
      label: string;
      options: { value: string; count: number }[];
    }[] = [];

    for (const facet of FACETS) {
      const counts = new Map<string, number>();
      for (const n of searched) {
        for (const v of facetValues(n, facet.key)) {
          counts.set(v, 0);
        }
      }
      for (const n of filtered) {
        for (const v of facetValues(n, facet.key)) {
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      counts.delete(EMPTY);
      // A facet whose column is entirely blank (the base has several
      // wired-up-but-unused columns) is noise — leave it out.
      if (counts.size === 0) continue;

      const options = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      out.push({ key: facet.key, label: facet.label, options });
    }
    return out;
  }, [searched, filtered]);

  const groups = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, Npc[]>();
    for (const n of sorted) {
      // A row in two groups shows up under both, like Airtable.
      for (const v of facetValues(n, groupBy)) {
        if (!map.has(v)) map.set(v, []);
        map.get(v)!.push(n);
      }
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === EMPTY) return 1;
      if (b[0] === EMPTY) return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
  }, [sorted, groupBy]);

  const selectedNpc = useMemo(
    () => all.find((n) => n._id === selected) ?? null,
    [all, selected]
  );

  const activeFilterCount = Object.values(filters).reduce(
    (sum, v) => sum + v.length,
    0
  );

  function toggleFilter(key: string, value: string) {
    setFilters((prev) => {
      const cur = prev[key] ?? [];
      const next = cur.includes(value)
        ? cur.filter((v) => v !== value)
        : [...cur, value];
      const out = { ...prev, [key]: next };
      if (next.length === 0) delete out[key];
      return out;
    });
  }

  /** Quick dropdowns pick exactly one value (or clear the facet). */
  function setSingleFilter(key: string, value: string) {
    setFilters((prev) => {
      const out = { ...prev };
      if (!value) delete out[key];
      else out[key] = [value];
      return out;
    });
  }

  function sortOn(key: string, sortable?: boolean) {
    if (sortable === false) return;
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  if (result === undefined) {
    return <p className="centered-note">Loading the roster…</p>;
  }

  const colCount = COLUMNS.length + (result.isDm ? 1 : 0);
  const quick = facetOptions.filter((f) =>
    (QUICK_FILTERS as readonly string[]).includes(f.key)
  );

  return (
    <div className="npc-screen">
      <div className="npc-toolbar">
        <div className="quick-filters">
          {quick.map((f) => (
            <select
              key={f.key}
              className={`quick-select${filters[f.key]?.length ? " on" : ""}`}
              value={filters[f.key]?.[0] ?? ""}
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
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
            >
              <option value="">None</option>
              {facetOptions.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={`npc-btn${showFilters || activeFilterCount ? " on" : ""}`}
            onClick={() => setShowFilters((v) => !v)}
          >
            Filter{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
          </button>

          <label className="npc-select">
            <span>Sort</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
            >
              {COLUMNS.filter((c) => c.sortable !== false).map((c) => (
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
            onClick={() => setSortAsc((v) => !v)}
            title={sortAsc ? "Ascending" : "Descending"}
          >
            {sortAsc ? "↑" : "↓"}
          </button>

          <input
            className="npc-search"
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="npc-substrip">
        <span className="npc-count">
          {sorted.length === all.length
            ? `${all.length} NPCs`
            : `${sorted.length} of ${all.length}`}
        </span>
        {(search || activeFilterCount > 0 || groupBy) && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setSearch("");
              setFilters({});
              setGroupBy("");
            }}
          >
            Clear filters
          </button>
        )}
        <button type="button" className="text-button" onClick={resetAll}>
          Reset widths
        </button>
      </div>

      {result.truncated && (
        <p className="npc-notice">
          Showing the first {all.length} NPCs — the roster is larger than one
          subscription returns. Time to switch this screen to a paginated
          query.
        </p>
      )}

      {showFilters && (
        <div className="npc-filters">
          {facetOptions.map((facet) => (
            <div className="facet" key={facet.key}>
              <div className="facet-label">{facet.label}</div>
              <div className="facet-options">
                {facet.options.map((opt) => {
                  const on = (filters[facet.key] ?? []).includes(opt.value);
                  return (
                    <button
                      type="button"
                      key={opt.value}
                      className={`facet-chip${on ? " on" : ""}`}
                      onClick={() => toggleFilter(facet.key, opt.value)}
                    >
                      {opt.value}
                      <span className="n">{opt.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="npc-table-wrap">
        <table className="npc-table">
          <colgroup>
            {COLUMNS.map((c) => (
              <col key={c.key} style={{ width: `${widths[c.key]}px` }} />
            ))}
            {result.isDm && <col style={{ width: `${widths[DM_COL]}px` }} />}
          </colgroup>

          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => sortOn(c.key, c.sortable)}
                  className={sortKey === c.key ? "sorted" : undefined}
                >
                  <span className="th-label">
                    {c.label}
                    {sortKey === c.key && (
                      <span className="arrow">{sortAsc ? "↑" : "↓"}</span>
                    )}
                  </span>
                  <span
                    className="col-resize"
                    title="Drag to resize · double-click to reset"
                    onPointerDown={(e) => startResize(c.key, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      resetColumn(c.key);
                    }}
                  />
                </th>
              ))}
              {result.isDm && (
                <th className="dm-col">
                  <span className="th-label">DM</span>
                  <span
                    className="col-resize"
                    title="Drag to resize · double-click to reset"
                    onPointerDown={(e) => startResize(DM_COL, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      resetColumn(DM_COL);
                    }}
                  />
                </th>
              )}
            </tr>
          </thead>

          {groups ? (
            groups.map(([groupValue, rows]) => (
              <tbody key={groupValue}>
                <tr className="group-row">
                  <td colSpan={colCount}>
                    {groupValue}
                    <span className="n">{rows.length}</span>
                  </td>
                </tr>
                {rows.map((n) => (
                  <Row
                    key={`${groupValue}:${n._id}`}
                    npc={n}
                    isDm={result.isDm}
                    active={n._id === selected}
                    onOpen={() => setSelected(n._id)}
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
                  isDm={result.isDm}
                  active={n._id === selected}
                  onOpen={() => setSelected(n._id)}
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

      {selectedNpc && (
        <NpcDetail
          npc={selectedNpc}
          isDm={result.isDm}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Row({
  npc,
  isDm,
  active,
  onOpen,
}: {
  npc: Npc;
  isDm: boolean;
  active: boolean;
  onOpen: () => void;
}) {
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";

  return (
    <tr
      onClick={onOpen}
      className={[npc.hidden ? "hidden-npc" : "", active ? "selected" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {COLUMNS.map((c) => {
        if (c.kind === "picture") {
          return (
            <td key={c.key} className="pic-cell">
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

        if (c.kind === "chips") {
          const vals = chipValues(npc, c.key);
          return (
            <td key={c.key}>
              {vals.length === 0 ? (
                <span className="blank">{BLANK}</span>
              ) : (
                <span className="cell-chips">
                  {vals.map((v) => (
                    <span className={chipClass(c.key, v)} key={v}>
                      {v}
                    </span>
                  ))}
                </span>
              )}
            </td>
          );
        }

        const text = display(npc, c.key);
        return (
          <td key={c.key} className={c.key === "name" ? "name-cell" : undefined}>
            {text === "" ? <span className="blank">{BLANK}</span> : text}
          </td>
        );
      })}

      {isDm && (
        <td className="dm-col">
          {npc.hidden && <span className="chip warn">Hidden</span>}
          {npc.secret && <span className="chip warn">Secret</span>}
          {!npc.hidden && !npc.secret && <span className="blank">{BLANK}</span>}
        </td>
      )}
    </tr>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <div className="detail-value">{value}</div>
    </div>
  );
}

function NpcDetail({
  npc,
  isDm,
  onClose,
}: {
  npc: Npc;
  isDm: boolean;
  onClose: () => void;
}) {
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const ageLine = [
    npc.age !== null ? `${npc.age}` : null,
    npc.maxAge !== null ? `of ${npc.maxAge}` : null,
    npc.maturity,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="npc-drawer">
        <header className="drawer-header">
          <div>
            <h2>{npc.name}</h2>
            {npc.nickname && <p className="muted">“{npc.nickname}”</p>}
          </div>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </header>

        {npc.portraitPath && mapServer && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="drawer-portrait"
            src={`${mapServer}/${npc.portraitPath}`}
            alt={npc.name}
          />
        )}

        <div className="drawer-chips">
          {[...npc.status, ...npc.groups, ...npc.place].map((v, i) => (
            <span className="chip" key={`${v}-${i}`}>
              {v}
            </span>
          ))}
        </div>

        <Field label="Species" value={npc.species} />
        <Field label="Lineage" value={npc.lineage} />
        <Field label="Gender" value={npc.gender} />
        <Field label="Age" value={ageLine || null} />
        <Field label="Job" value={npc.job} />
        <Field label="Region" value={npc.region} />
        <Field label="Kingdom" value={npc.kingdom} />
        <Field label="Alignment" value={npc.alignment} />
        <Field label="Sexuality" value={npc.sexuality} />
        <Field
          label="Family"
          value={npc.familyMembers.length ? npc.familyMembers.join(", ") : null}
        />
        <Field label="Description" value={npc.description} />
        <Field label="Quirk — mental" value={npc.quirkMental} />
        <Field label="Quirk — physical" value={npc.quirkPhysical} />
        <Field label="Politics" value={npc.politics} />
        <Field label="Abilities" value={npc.abilities} />
        <Field label="Wants & needs" value={npc.wantsNeeds} />
        <Field label="Voice" value={npc.voice} />
        <Field label="Player notes" value={npc.playerNotes} />

        {isDm && (npc.secret || npc.dmNotes || npc.hidden) && (
          <div className="dm-block">
            <div className="dm-block-label">DM only</div>
            {npc.hidden && (
              <p className="muted">Hidden — players never receive this NPC.</p>
            )}
            <Field label="Secret" value={npc.secret} />
            <Field label="DM notes" value={npc.dmNotes} />
          </div>
        )}
      </aside>
    </>
  );
}
