"use client";

import { useState } from "react";
import {
  FilterDef,
  FilterState,
  FilterValue,
  FILTERS,
  activeCount,
  hasActiveAdvanced,
  isEmptyValue,
} from "@/components/lookupFilters";
import { LookupKind } from "@/components/lookupFields";

/**
 * The filter bar: a compact row, and an advanced panel behind a toggle.
 *
 * Every control is rendered from the declarations in lookupFilters.ts
 * rather than written out here, so the bar, the panel and Reset cannot
 * drift from what actually filters. Adding a filter is one entry in
 * that file.
 *
 * There is no "Filter" button. D&D Beyond has one because its filtering
 * is a round trip to a server; ours is a predicate over a list already
 * in memory, so results follow as you type and a button would only make
 * you press it.
 *
 * Named FilterBar, not Filters, because lookupFilters.ts sits next to
 * it: on a case-insensitive disk a `LookupFilters` import resolves to
 * whichever of the two TypeScript tries first, and it tries `.ts`
 * before `.tsx`. The build stays green on Linux and fails on a Mac.
 */

export function LookupFilterBar({
  kind,
  state,
  setState,
  matched,
  total,
}: {
  kind: LookupKind;
  state: FilterState;
  setState: (next: FilterState) => void;
  matched: number;
  total: number;
}) {
  const defs = FILTERS[kind];
  const compact = defs.filter((f) => !f.advanced);
  const advanced = defs.filter((f) => f.advanced);

  // Opens already showing an advanced filter that is set, so a hidden
  // filter can never be the unexplained reason a list looks short.
  const [open, setOpen] = useState(() => hasActiveAdvanced(kind, state));
  const active = activeCount(kind, state);

  const set = (key: string, value: FilterValue) =>
    setState({ ...state, [key]: value });

  const chips = compact.find((f) => f.control.type === "chips");
  const fields = compact.filter((f) => f.control.type !== "chips");

  return (
    <section className="lf">
      {chips && <ChipRow def={chips} state={state} set={set} />}

      <div className="lf-row">
        {fields.map((def) => (
          <Field key={def.key} def={def} state={state} set={set} />
        ))}

        <div className="lf-actions">
          <span className="lf-count">
            {matched === total
              ? `${total} entries`
              : `${matched} of ${total}`}
          </span>
          {active > 0 && (
            <button
              type="button"
              className="text-button lf-reset"
              onClick={() => setState({})}
            >
              Reset all filters
            </button>
          )}
        </div>
      </div>

      {open && advanced.length > 0 && (
        <div className="lf-row lf-advanced">
          {advanced.map((def) => (
            <Field key={def.key} def={def} state={state} set={set} />
          ))}
        </div>
      )}

      {advanced.length > 0 && (
        <button
          type="button"
          className="lf-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide advanced filters" : "Show advanced filters"}
        </button>
      )}
    </section>
  );
}

/** The exclusive category row: "All", then one chip per option. */
function ChipRow({
  def,
  state,
  set,
}: {
  def: FilterDef;
  state: FilterState;
  set: (key: string, value: FilterValue) => void;
}) {
  if (def.control.type !== "chips") return null;
  const current = typeof state[def.key] === "string" ? (state[def.key] as string) : "";

  return (
    <div className="lf-chips">
      <button
        type="button"
        className={`lf-chip${current === "" ? " on" : ""}`}
        onClick={() => set(def.key, "")}
      >
        All
      </button>
      {def.control.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`lf-chip${current === o.value ? " on" : ""}`}
          // Clicking the active chip clears it, so the row never traps
          // you into needing the Reset button to see everything again.
          onClick={() => set(def.key, current === o.value ? "" : o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({
  def,
  state,
  set,
}: {
  def: FilterDef;
  state: FilterState;
  set: (key: string, value: FilterValue) => void;
}) {
  const value = state[def.key];
  const on = !isEmptyValue(value);

  return (
    <label className={`lf-field${on ? " on" : ""}`}>
      <span className="lf-label">{def.label}</span>
      <Control def={def} value={value} set={set} />
    </label>
  );
}

function Control({
  def,
  value,
  set,
}: {
  def: FilterDef;
  value: FilterValue | undefined;
  set: (key: string, value: FilterValue) => void;
}) {
  const c = def.control;

  if (c.type === "text") {
    return (
      <input
        className="lf-input"
        type="search"
        placeholder={def.hint ?? ""}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => set(def.key, e.target.value)}
      />
    );
  }

  if (c.type === "toggle") {
    return (
      <span className="lf-toggle-cell">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => set(def.key, e.target.checked)}
        />
        <span className="muted">Only</span>
      </span>
    );
  }

  if (c.type === "range") {
    const bounds =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { min: string; max: string })
        : { min: "", max: "" };
    return (
      <span className="lf-range">
        <input
          className="lf-input lf-num"
          type="number"
          placeholder="Min"
          value={bounds.min}
          onChange={(e) => set(def.key, { ...bounds, min: e.target.value })}
        />
        <span className="lf-dash">–</span>
        <input
          className="lf-input lf-num"
          type="number"
          placeholder="Max"
          value={bounds.max}
          onChange={(e) => set(def.key, { ...bounds, max: e.target.value })}
        />
      </span>
    );
  }

  if (c.type === "select") {
    return (
      <select
        className="lf-input"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => set(def.key, e.target.value)}
      >
        <option value="">Any</option>
        {c.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  // multi — a row of small toggles rather than a multi-select, because a
  // native multi-select needs a modifier key nobody discovers.
  const picked = Array.isArray(value) ? (value as string[]) : [];
  return (
    <span className="lf-multi">
      {c.options.map((o) => {
        const on = picked.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`lf-pill${on ? " on" : ""}`}
            onClick={() =>
              set(
                def.key,
                on ? picked.filter((p) => p !== o.value) : [...picked, o.value]
              )
            }
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}
