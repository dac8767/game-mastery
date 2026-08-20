"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  LOOKUP_TITLES,
  LookupKind,
  abilityCells,
  features,
  itemFacts,
  itemSubtitle,
  lookupSubtitle,
  monsterSubtitle,
  monsterTraitLines,
  spellCells,
} from "@/components/lookupFields";
import {
  FilterState,
  SORTS,
  applyFilters,
  sortRows,
} from "@/components/lookupFilters";
import { LookupFilters } from "@/components/LookupFilters";

/**
 * The Lookup screens: spells, items, monsters.
 *
 * One component for all three. They differ in which index they read,
 * which filters they offer and how a row prints — and all three of
 * those are declarations elsewhere, so this file is the shape of the
 * screen rather than three screens in a trench coat.
 *
 * The whole lightweight index is fetched once and filtered in memory.
 * That is the cheap option here rather than the expensive one, because
 * this data has no write path and a subscription to it delivers once
 * and then sits silent — see convex/lookup.ts. It also means every
 * filter is free: no query per keystroke, and no filter that cannot be
 * expressed because no index backs it.
 *
 * The full row — description, stat block — is fetched by id only when
 * something is opened.
 */

/** How many results the list draws before asking you to narrow down. */
const MAX_ROWS = 300;

export function LookupTool({ kind }: { kind: LookupKind }) {
  const [filters, setFilters] = useState<FilterState>({});
  const [sort, setSort] = useState("name");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    () => sortRows(kind, applyFilters(kind, all, filters), sort),
    [kind, all, filters, sort]
  );
  const shown = matched.slice(0, MAX_ROWS);

  // Fetched only for what is open. Three hooks rather than one, because
  // a Convex query reference is static and the id is typed per table.
  const spell = useQuery(
    api.lookup.getSpell,
    kind === "spells" && selectedId
      ? { id: selectedId as Id<"spells"> }
      : "skip"
  );
  const item = useQuery(
    api.lookup.getItem,
    kind === "items" && selectedId ? { id: selectedId as Id<"items"> } : "skip"
  );
  const monster = useQuery(
    api.lookup.getMonster,
    kind === "monsters" && selectedId
      ? { id: selectedId as Id<"monsters"> }
      : "skip"
  );
  const selected = (kind === "spells" ? spell : kind === "items" ? item : monster) as
    | Record<string, unknown>
    | null
    | undefined;

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

          <div className="lookup-body">
            <div className="lookup-side">
              <div className="lookup-sort">
                <span className="lf-label">Sort</span>
                <select
                  className="lf-input"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  {SORTS[kind].map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="lookup-list">
                {shown.length === 0 && (
                  <p className="muted lookup-hint">
                    Nothing matches those filters.
                  </p>
                )}
                {shown.map((row) => {
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
                      <span className="lookup-row-name">
                        {String(row.name)}
                      </span>
                      {subtitle && (
                        <span className="lookup-row-sub">{subtitle}</span>
                      )}
                    </button>
                  );
                })}
                {/* Never truncate silently: a list that stops at 300
                    with no explanation reads as missing data. */}
                {matched.length > shown.length && (
                  <p className="muted lookup-hint">
                    Showing {shown.length} of {matched.length}. Narrow the
                    filters to see the rest.
                  </p>
                )}
              </div>
            </div>

            <aside className="lookup-panel">
              {selectedId && selected === undefined && (
                <p className="muted lookup-hint">Loading…</p>
              )}
              {selected ? (
                <LookupDetail kind={kind} row={selected} />
              ) : (
                !selectedId && (
                  <p className="muted lookup-hint">Pick one to read it.</p>
                )
              )}
            </aside>
          </div>
        </>
      )}
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
