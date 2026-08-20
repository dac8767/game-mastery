"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  LOOKUP_COLUMNS,
  LOOKUP_TITLES,
  LookupKind,
  abilityCells,
  columnTemplate,
  features,
  itemFacts,
  itemSubtitle,
  monsterSubtitle,
  monsterTraitLines,
  sortByColumn,
  spellCells,
} from "@/components/lookupFields";
import { FilterState, applyFilters } from "@/components/lookupFilters";
import { LookupFilters } from "@/components/LookupFilters";

/**
 * The Lookup screens: spells, items, monsters.
 *
 * A full-width table with sortable columns, where a row expands
 * DOWNWARD in place to show the whole entry. Expanding in the list
 * rather than opening a side panel is what lets you compare two things
 * — open both, and they sit in the table with the rows you were
 * scanning still around them.
 *
 * One component for all three kinds. The columns, the filters and the
 * expanded layout are all declarations elsewhere, so this file is the
 * shape of the screen rather than three screens in a trench coat.
 *
 * The whole lightweight index is fetched once and filtered in memory.
 * That is the cheap option here rather than the expensive one, because
 * this data has no write path and a subscription to it delivers once
 * and then sits silent — see convex/lookup.ts. The full row, with its
 * description and stat block, is fetched by id only when a row is
 * actually opened.
 */

/** How many rows the table draws before asking you to narrow down. */
const MAX_ROWS = 300;

export function LookupTool({ kind }: { kind: LookupKind }) {
  const [filters, setFilters] = useState<FilterState>({});
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({
    key: "name",
    desc: false,
  });
  // A Set rather than one id: comparing two spells means having both
  // open at once, which a single-selection panel cannot do.
  const [open, setOpen] = useState<Set<string>>(new Set());

  const spells = useQuery(api.lookup.indexSpells, kind === "spells" ? {} : "skip");
  const items = useQuery(api.lookup.indexItems, kind === "items" ? {} : "skip");
  const monsters = useQuery(
    api.lookup.indexMonsters,
    kind === "monsters" ? {} : "skip"
  );

  const index = kind === "spells" ? spells : kind === "items" ? items : monsters;
  const all = useMemo(
    () => (index?.rows ?? []) as Record<string, unknown>[],
    [index]
  );

  const matched = useMemo(
    () => sortByColumn(kind, applyFilters(kind, all, filters), sort.key, sort.desc),
    [kind, all, filters, sort]
  );
  const shown = matched.slice(0, MAX_ROWS);

  const columns = LOOKUP_COLUMNS[kind];
  const template = columnTemplate(kind);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sortBy = (key: string) =>
    setSort((prev) =>
      // Clicking the sorted column reverses it; clicking another starts
      // that one ascending, which is what a first click should mean.
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: false }
    );

  const loading = index === undefined;
  const empty = !loading && all.length === 0;

  return (
    <div className="lookup">
      {loading ? (
        <p className="centered-note">Loading the library…</p>
      ) : empty ? (
        /* An import that never ran and a filter that matched nothing
           look identical otherwise, and the fix for each is different. */
        <p className="centered-note">
          No {LOOKUP_TITLES[kind].toLowerCase()} imported yet. They are loaded
          from a Foundry export — see Step 9c in SETUP-CONVEX.md.
        </p>
      ) : (
        <>
          <LookupFilters
            kind={kind}
            state={filters}
            setState={setFilters}
            matched={matched.length}
            total={all.length}
          />

          <div className="lk-table">
            <div
              className="lk-head"
              style={{ ["--lk-cols" as string]: template }}
            >
              {columns.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`lk-th${c.align === "center" ? " center" : ""}${
                    sort.key === c.key ? " sorted" : ""
                  }`}
                  onClick={() => sortBy(c.key)}
                >
                  {c.label}
                  <span className="lk-arrow">
                    {sort.key === c.key ? (sort.desc ? "▾" : "▴") : "⇅"}
                  </span>
                </button>
              ))}
              <span />
            </div>

            <div className="lk-rows">
              {shown.length === 0 && (
                <p className="muted lookup-hint">
                  Nothing matches those filters.
                </p>
              )}

              {shown.map((row) => {
                const id = String(row._id);
                const isOpen = open.has(id);
                return (
                  <div
                    key={id}
                    className={`lk-entry${isOpen ? " open" : ""}`}
                  >
                    <div
                      className="lk-tr"
                      style={{ ["--lk-cols" as string]: template }}
                      onClick={() => toggle(id)}
                    >
                      {columns.map((c) => (
                        <span
                          key={c.key}
                          className={`lk-td${
                            c.align === "center" ? " center" : ""
                          }${c.primary ? " primary" : ""}`}
                        >
                          <span className="lk-cell">{c.get(row) ?? "—"}</span>
                          {c.primary && typeof row.source === "string" && (
                            <span className="lk-cell-sub">{row.source}</span>
                          )}
                        </span>
                      ))}
                      <button
                        type="button"
                        className="lk-expand"
                        aria-label={isOpen ? "Collapse" : "Expand"}
                        aria-expanded={isOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(id);
                        }}
                      >
                        {isOpen ? "−" : "+"}
                      </button>
                    </div>

                    {isOpen && <ExpandedRow kind={kind} id={id} />}
                  </div>
                );
              })}

              {/* Never truncate silently: a table that stops at 300 with
                  no explanation reads as missing data. */}
              {matched.length > shown.length && (
                <p className="muted lookup-hint">
                  Showing {shown.length} of {matched.length}. Narrow the filters
                  to see the rest.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The opened row.
 *
 * Its own component so the fetch is scoped to it: closing the row
 * unmounts the hook and the subscription with it, rather than leaving
 * one query per row you have ever looked at.
 */
function ExpandedRow({ kind, id }: { kind: LookupKind; id: string }) {
  const spell = useQuery(
    api.lookup.getSpell,
    kind === "spells" ? { id: id as Id<"spells"> } : "skip"
  );
  const item = useQuery(
    api.lookup.getItem,
    kind === "items" ? { id: id as Id<"items"> } : "skip"
  );
  const monster = useQuery(
    api.lookup.getMonster,
    kind === "monsters" ? { id: id as Id<"monsters"> } : "skip"
  );

  const row = (kind === "spells" ? spell : kind === "items" ? item : monster) as
    | Record<string, unknown>
    | null
    | undefined;

  return (
    <div className="lk-panel">
      {row === undefined && <p className="muted lookup-hint">Loading…</p>}
      {row === null && (
        <p className="muted lookup-hint">That entry is no longer there.</p>
      )}
      {row && <LookupDetail kind={kind} row={row} />}
    </div>
  );
}

/**
 * Three layouts, because the three kinds are read differently.
 *
 * An item is a subtitle and prose. A spell is a grid of eight labelled
 * cells you scan without reading the labels, so a missing value keeps
 * its slot rather than collapsing the grid. A monster is a stat block —
 * rules between bands, ability scores in a row, traits and actions as
 * named blocks — with its description underneath rather than inside it,
 * because the block is reference and the description is story.
 */
function LookupDetail({
  kind,
  row,
}: {
  kind: LookupKind;
  row: Record<string, unknown>;
}) {
  const description =
    typeof row.description === "string" ? row.description : "";
  const source = typeof row.source === "string" ? row.source : "";

  return (
    <article className={`lk lk-${kind}`}>
      <h2 className="lk-name">{String(row.name)}</h2>

      {kind === "items" && <ItemHead row={row} />}
      {kind === "spells" && <SpellHead row={row} />}
      {kind === "monsters" && <MonsterBlock row={row} />}

      {description && (
        <section className="lk-body">
          {/* On a monster this is a section of its own, under the block:
              the stat block is reference, the description is story. */}
          {kind === "monsters" && <h3 className="lk-h">Description</h3>}
          <Prose text={description} />
        </section>
      )}

      {kind === "spells" && typeof row.materials === "string" && row.materials && (
        <p className="lk-footnote">* — ({row.materials})</p>
      )}

      {source && <p className="lk-source">{source}</p>}
    </article>
  );
}

/** "Wondrous Item, very rare (requires attunement)", then cost/weight. */
function ItemHead({ row }: { row: Record<string, unknown> }) {
  const facts = itemFacts(row);
  return (
    <>
      <p className="lk-sub">{itemSubtitle(row)}</p>
      <div className="lk-rule" />
      {facts.length > 0 && (
        <dl className="lk-facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** The eight-cell grid above a spell's text. */
function SpellHead({ row }: { row: Record<string, unknown> }) {
  const cells = spellCells(row);
  const flags = [
    row.ritual === true ? "Ritual" : null,
    row.concentration === true ? "Concentration" : null,
  ].filter(Boolean);

  return (
    <>
      <div className="lk-rule accent" />
      <dl className="lk-grid">
        {cells.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd>{c.value}</dd>
          </div>
        ))}
      </dl>
      {flags.length > 0 && (
        <div className="lk-tags">
          {flags.map((f) => (
            <span key={f} className="lk-tag">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="lk-rule accent" />
    </>
  );
}

/** The stat block: bands separated by rules, in the printed order. */
function MonsterBlock({ row }: { row: Record<string, unknown> }) {
  const subtitle = monsterSubtitle(row);
  const abilities = abilityCells(row.abilities);
  const lines = monsterTraitLines(row);
  const traits = features(row.traits);
  const actions = features(row.actions);
  const legendary = features(row.legendaryActions);

  const defence = [
    typeof row.ac === "number" ? { label: "Armor Class", value: row.ac } : null,
    typeof row.hp === "number" ? { label: "Hit Points", value: row.hp } : null,
    typeof row.speed === "string" && row.speed
      ? { label: "Speed", value: row.speed }
      : null,
  ].filter(Boolean) as { label: string; value: string | number }[];

  return (
    <div className="lk-block">
      {subtitle && <p className="lk-sub">{subtitle}</p>}

      {defence.length > 0 && (
        <>
          <div className="lk-rule" />
          <ul className="lk-lines">
            {defence.map((d) => (
              <li key={d.label}>
                <span className="lk-key">{d.label}</span> {d.value}
              </li>
            ))}
          </ul>
        </>
      )}

      {abilities.length > 0 && (
        <>
          <div className="lk-rule" />
          <div className="lk-abilities">
            {abilities.map((a) => (
              <div key={a.key}>
                <div className="lk-ab-label">{a.label}</div>
                <div className="lk-ab-score">
                  {a.score} <span className="lk-ab-mod">({a.modifier})</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {lines.length > 0 && (
        <>
          <div className="lk-rule" />
          <ul className="lk-lines">
            {lines.map((l) => (
              <li key={l.label}>
                <span className="lk-key">{l.label}</span> {l.value}
              </li>
            ))}
          </ul>
        </>
      )}

      <FeatureList title="Traits" items={traits} />
      <FeatureList title="Actions" items={actions} />
      <FeatureList title="Legendary Actions" items={legendary} />
    </div>
  );
}

function FeatureList({
  title,
  items,
}: {
  title: string;
  items: { name: string; text: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="lk-features">
      <h3 className="lk-h">{title}</h3>
      {items.map((f) => (
        <div key={f.name} className="lk-feature">
          <span className="lk-feature-name">{f.name}.</span>{" "}
          <Prose text={f.text} inline />
        </div>
      ))}
    </section>
  );
}

/** Blank-line-separated paragraphs, the way the converter writes them. */
function Prose({ text, inline }: { text: string; inline?: boolean }) {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  if (inline) return <>{paras.join(" ")}</>;
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}
