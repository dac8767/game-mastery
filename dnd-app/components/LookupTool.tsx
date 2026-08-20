"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  LOOKUP_FIELDS,
  LOOKUP_TITLES,
  LookupKind,
  lookupSubtitle,
} from "@/components/lookupFields";

/**
 * The Lookup screens: spells, items, monsters.
 *
 * One component for all three, because they differ only in which query
 * they call and which fields they show — and a copy each would be three
 * places to fix a layout bug in.
 *
 * A reference library is SEARCHED, not scrolled. Every read is bounded
 * server-side to one page, so nothing here subscribes to a thousand-row
 * list; typing narrows it through the search index instead. That is not
 * a nicety on the free tier, where a subscribed component re-receives
 * the whole list every time one row in it changes.
 *
 * There is no write path at all. These tables are loaded by
 * `npx convex import` and the app only ever reads them.
 */

const DEBOUNCE_MS = 200;

export function LookupTool({ kind }: { kind: LookupKind }) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounced, so a query does not fire per keystroke. Function calls
  // are pooled across every project on the account.
  useEffect(() => {
    const t = setTimeout(() => setTerm(input), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);

  const spells = useQuery(
    api.lookup.searchSpells,
    kind === "spells" ? { term } : "skip"
  );
  const items = useQuery(
    api.lookup.searchItems,
    kind === "items" ? { term } : "skip"
  );
  const monsters = useQuery(
    api.lookup.searchMonsters,
    kind === "monsters" ? { term } : "skip"
  );
  const size = useQuery(api.lookup.librarySize);

  const rows = (kind === "spells" ? spells : kind === "items" ? items : monsters) as
    | Record<string, unknown>[]
    | undefined;

  const loaded = rows !== undefined;
  const empty = size !== undefined && size[kind] === 0;
  const selected =
    rows?.find((r) => String(r._id) === selectedId) ?? null;

  return (
    <div className="lookup">
      <div className="lookup-bar">
        <input
          className="detail-input lookup-search"
          type="search"
          placeholder={`Search ${LOOKUP_TITLES[kind].toLowerCase()}…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        {size !== undefined && (
          <span className="muted lookup-count">
            {size[kind]}
            {size[kind] >= size.capped ? "+" : ""} in the library
          </span>
        )}
      </div>

      {/* An import that never ran and a search that found nothing look
          identical otherwise, and the fix for each is different. */}
      {empty ? (
        <p className="centered-note">
          Nothing imported yet. {LOOKUP_TITLES[kind]} are loaded from a
          Foundry export — see Step 9c in SETUP-CONVEX.md.
        </p>
      ) : (
        <div className="lookup-body">
          <div className="lookup-list">
            {!loaded && <p className="muted lookup-hint">Searching…</p>}
            {loaded && rows.length === 0 && (
              <p className="muted lookup-hint">
                {term.trim().length >= 2
                  ? `No ${LOOKUP_TITLES[kind].toLowerCase()} match “${term}”.`
                  : "Type at least two letters to search."}
              </p>
            )}
            {loaded &&
              rows.map((row) => {
                const id = String(row._id);
                const subtitle = lookupSubtitle(kind, row);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`lookup-row${
                      selectedId === id ? " selected" : ""
                    }`}
                    onClick={() => setSelectedId(id)}
                  >
                    <span className="lookup-row-name">{String(row.name)}</span>
                    {subtitle && (
                      <span className="lookup-row-sub">{subtitle}</span>
                    )}
                  </button>
                );
              })}
          </div>

          <aside className="lookup-panel">
            {selected ? (
              <LookupDetail kind={kind} row={selected} />
            ) : (
              <p className="muted lookup-hint">
                Pick one to read it.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function LookupDetail({
  kind,
  row,
}: {
  kind: LookupKind;
  row: Record<string, unknown>;
}) {
  const fields = LOOKUP_FIELDS[kind]
    .map((f) => ({ label: f.label, value: f.get(row) }))
    .filter((f) => f.value !== null);

  const description =
    typeof row.description === "string" ? row.description : "";

  return (
    <div className="lookup-detail">
      <h2>{String(row.name)}</h2>

      <dl className="lookup-stats">
        {fields.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>

      {description && (
        <div className="lookup-text">
          {description.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      )}
    </div>
  );
}
