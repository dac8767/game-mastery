"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Span,
  highlight,
  queryTerms,
  snippet,
  trailOf,
} from "@/components/rulesSnippet";

/**
 * Rules Lawyer — the rules text, searched.
 *
 * It answers with the RULE, not with a summary of one. Every result on
 * this screen is a verbatim section of the document it came from, under
 * the heading it sits below, labelled with which document that is. There
 * is nothing here that could be wrong in a way the source is not,
 * because there is nothing here that was written by anything but the
 * source.
 *
 * That is the whole design, and it is why this half was built first: an
 * answer you can check beats an answer you have to trust, and the AI
 * layer that reads these passages back to you is worth far less without
 * the passages sitting underneath it.
 */

type Hit = {
  _id: string;
  source: string;
  title: string;
  breadcrumb: string;
  text: string;
  order: number;
};

export function RulesLawyerTool() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string>("");
  const [openId, setOpenId] = useState<string | null>(null);

  // Trimmed before it reaches the server: a query of spaces is a full
  // scan that can only return everything.
  const trimmed = query.trim();
  const result = useQuery(
    api.lookup.searchRules,
    trimmed ? { q: trimmed, source: source || undefined } : { q: "" }
  );

  const terms = useMemo(() => queryTerms(trimmed), [trimmed]);
  const hits = (result?.hits ?? []) as Hit[];
  const sources = result?.sources ?? [];

  return (
    <div className="rules">
      <div className="rules-bar">
        <h1 className="rules-title">Rules Lawyer</h1>
        <input
          className="npc-search rules-search"
          value={query}
          autoFocus
          placeholder="Search the rules — grappled, opportunity attack, hiding…"
          aria-label="Search the rules"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpenId(null);
          }}
        />
        {sources.length > 1 && (
          <label className="npc-select">
            Source
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">All</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <p className="settings-note rules-hint">
        Every result is the rules text itself, quoted whole, from the
        document it came from. Nothing here is summarised or rewritten.
      </p>

      {result === undefined && trimmed ? (
        <p className="centered-note">Searching…</p>
      ) : sources.length === 0 ? (
        <p className="centered-note">
          No rules imported yet — run <code>scripts/import-srd.mjs</code> and
          import the result into the <code>rules</code> table.
        </p>
      ) : !trimmed ? (
        <p className="centered-note">
          Type a rule, a condition, or a question.
        </p>
      ) : hits.length === 0 ? (
        <p className="centered-note">
          Nothing in {source || "the rules"} matches “{trimmed}”.
        </p>
      ) : (
        <ul className="rules-hits">
          {hits.map((hit) => (
            <RuleHit
              key={hit._id}
              hit={hit}
              terms={terms}
              open={openId === hit._id}
              onToggle={() =>
                setOpenId(openId === hit._id ? null : hit._id)
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RuleHit({
  hit,
  terms,
  open,
  onToggle,
}: {
  hit: Hit;
  terms: string[];
  open: boolean;
  onToggle: () => void;
}) {
  // Only fetched once the section is open — the neighbours of twelve
  // results nobody expanded are twelve queries nobody needed.
  const context = useQuery(
    api.lookup.ruleContext,
    open
      ? { source: hit.source, order: hit.order, before: 0, after: 1 }
      : "skip"
  );

  const next = (context ?? []).find((c) => c.order === hit.order + 1);
  const shown = open ? hit.text : snippet(hit.text, terms);

  return (
    <li className={`rules-hit${open ? " open" : ""}`}>
      <button type="button" className="rules-hit-head" onClick={onToggle}>
        <span className="rules-trail">
          {trailOf(hit.breadcrumb, hit.title)}
        </span>
        <span className="rules-source">{hit.source}</span>
      </button>

      <div className="rules-text">
        <Marked text={shown} terms={terms} />
      </div>

      {open && next && (
        <div className="rules-next">
          <span className="settings-note">Next section</span>
          <strong>{trailOf(next.breadcrumb, next.title)}</strong>
          <p>{snippet(next.text, [])}</p>
        </div>
      )}

      {!open && hit.text.length > shown.length && (
        <button type="button" className="text-button" onClick={onToggle}>
          Read the whole section
        </button>
      )}
    </li>
  );
}

/**
 * The matched words, emphasised.
 *
 * Rendered from spans rather than injected as markup. This is text out
 * of a document, and building HTML from it — even to add a `<mark>` —
 * would put string concatenation between a file and a browser. JSX
 * escapes each span for free.
 */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  const spans: Span[] = highlight(text, terms);
  return (
    <>
      {spans.map((span, i) =>
        span.hit ? (
          <mark key={i}>{span.text}</mark>
        ) : (
          <span key={i}>{span.text}</span>
        )
      )}
    </>
  );
}
