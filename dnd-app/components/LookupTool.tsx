"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
