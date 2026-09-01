"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  AnswerSpan,
  RECENT_LIMIT,
  Span,
  answerSpans,
  highlight,
  pushRecent,
  queryTerms,
  sectionKeyOf,
  snippet,
  trailOf,
} from "@/components/rulesSnippet";

/**
 * Rules Lawyer — the rules text, searched, and a reading of it.
 *
 * It answers with the RULE, not with a summary of one. Every result on
 * this screen is a verbatim section of the document it came from, under
 * the heading it sits below, labelled with which document that is.
 *
 * That is the whole design, and it is why that half was built first: an
 * answer you can check beats an answer you have to trust.
 *
 * ---------------------------------------------------------------------
 * The second slice
 *
 * The AI answer now sits ABOVE the passages and never instead of them.
 * The ordering is the argument: you read the ruling, and the sections
 * it was drawn from are already on screen underneath it, each citation
 * a button that opens the one it points at. Nothing about the quoted
 * half changed to make room — turn the answer panel off and this is the
 * screen it always was.
 *
 * The model is given the retrieved passages and nothing else, and is
 * told to say so when they do not cover the question. See
 * convex/rulesAsk.ts for the prompt that enforces it.
 *
 * ---------------------------------------------------------------------
 * Why nothing here is keyed on a rule's `_id`
 *
 * `rules` is replaced wholesale by the importer, so every id changes
 * each time the SRD is converted again. A pin, a citation and the
 * `?open=` in a shared link are therefore all keyed on the section's
 * NAME — see sectionKeyOf. A link pasted into chat still opens the
 * right rule after a re-import; keyed on an id it would open nothing.
 */

type Hit = {
  _id: string;
  source: string;
  title: string;
  breadcrumb: string;
  text: string;
  order: number;
};

type Citation = {
  n: number;
  source: string;
  breadcrumb: string;
  title: string;
  order: number;
};

type Answer = {
  answer: string;
  citations: Citation[];
  model: string;
  cached: boolean;
};

/**
 * A pinned section, with the row it currently resolves to.
 *
 * `rule` is null when nothing in the imported rules answers to that
 * name any more — see convex/rules.ts. The screen has to render that
 * case, so the type makes it impossible to forget.
 */
type Pin = {
  _id: string;
  source: string;
  breadcrumb: string;
  title: string;
  pinnedAt: number;
  rule: Hit | null;
};

/** Where this browser remembers what it has been asked. */
const RECENTS_KEY = "gm.rules.recents";

/** Recents are a convenience on one device, so they live in the browser. */
function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === "string");
  } catch {
    // A private window, cleared site data, or storage the browser
    // refuses outright. An empty list is the correct screen either way.
    return [];
  }
}

export function RulesLawyerTool() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read ONCE, into initial state. Reading the URL on every render and
  // writing it from an effect is a loop; the URL is an entry point
  // here, and state owns the screen after that.
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [source, setSource] = useState(() => params.get("source") ?? "");
  const [openKey, setOpenKey] = useState<string | null>(
    () => params.get("open")
  );

  const [selected, setSelected] = useState(-1);
  const [recents, setRecents] = useState<string[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const hitRefs = useRef<(HTMLLIElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setRecents(loadRecents()), []);

  const trimmed = query.trim();
  const result = useQuery(
    api.lookup.searchRules,
    trimmed ? { q: trimmed, source: source || undefined } : { q: "" }
  );

  const pins = useQuery(api.rules.listPins, {});
  const togglePin = useMutation(api.rules.togglePin);
  const askRules = useAction(api.rulesAsk.ask);

  // An answer already paid for, shown the moment the question is typed.
  // Reactive and free — the ask button only ever spends on a miss.
  const cached = useQuery(
    api.rules.cachedAnswer,
    trimmed ? { question: trimmed, source: source || undefined } : "skip"
  );

  const terms = useMemo(() => queryTerms(trimmed), [trimmed]);
  const hits = useMemo(() => (result?.hits ?? []) as Hit[], [result]);
  const sources = result?.sources ?? [];

  const pinnedKeys = useMemo(
    () => new Set((pins ?? []).map((p) => sectionKeyOf(p))),
    [pins]
  );

  /** The answer on screen: a fresh one if asked, else whatever is cached. */
  const shown: Answer | null =
    answer ?? (cached ? { ...cached, cached: true } : null);

  // A new question invalidates the last answer. Without this the
  // previous ruling would sit above a different set of passages, which
  // is the one arrangement on this screen that could actually mislead.
  useEffect(() => {
    setAnswer(null);
    setAskError(null);
    setSelected(-1);
  }, [trimmed, source]);

  // The URL trails the screen rather than driving it. Debounced so
  // typing a question does not write a history entry per keystroke —
  // this is the address bar only; the search itself is untouched.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams();
      if (trimmed) next.set("q", trimmed);
      if (source) next.set("source", source);
      if (openKey) next.set("open", openKey);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 400);
    return () => clearTimeout(timer);
  }, [trimmed, source, openKey, pathname, router]);

  /** Remember a question only once it has been acted on. */
  const remember = useCallback((q: string) => {
    if (!q) return;
    setRecents((list) => {
      const next = pushRecent(list, q);
      try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Storage refused. The list still works for this session.
      }
      return next;
    });
  }, []);

  const openSection = useCallback(
    (key: string | null) => {
      setOpenKey((current) => (current === key ? null : key));
      remember(trimmed);
    },
    [remember, trimmed]
  );

  const ask = useCallback(async () => {
    if (!trimmed || asking) return;
    setAsking(true);
    setAskError(null);
    try {
      const got = await askRules({
        question: trimmed,
        source: source || undefined,
      });
      setAnswer(got);
      remember(trimmed);
    } catch (error) {
      // The action throws sentences meant to be read — an unset key, a
      // rate limit, nothing to cite. Showing the message beats showing
      // "request failed" over passages that are perfectly fine.
      setAskError(
        error instanceof Error ? error.message : "The AI layer failed."
      );
    } finally {
      setAsking(false);
    }
  }, [asking, askRules, remember, source, trimmed]);

  /**
   * Arrow keys move a cursor through the hits; Enter opens one.
   *
   * Handled on the container so it works while the caret is still in
   * the search box, which is where it is at a table — you type, you
   * arrow down, you read. Cmd/Ctrl+Enter asks instead of opening,
   * because that is the expensive one and it should take a deliberate
   * second key.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (hits.length === 0 && e.key !== "Escape") return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((at) => {
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = at + step;
        if (next < 0) return -1;
        return Math.min(next, hits.length - 1);
      });
      return;
    }

    if (e.key === "Enter") {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        void ask();
        return;
      }
      if (selected >= 0 && selected < hits.length) {
        e.preventDefault();
        openSection(sectionKeyOf(hits[selected]));
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      // Two stages, least destructive first: a cursor, then the query.
      if (selected >= 0) setSelected(-1);
      else if (trimmed) setQuery("");
      inputRef.current?.focus();
    }
  };

  // Keep the keyboard cursor on screen. `nearest` so arrowing down a
  // long list scrolls by one row rather than jumping the list.
  useEffect(() => {
    if (selected < 0) return;
    hitRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pinSection = useCallback(
    (ref: { source: string; breadcrumb: string; title: string }) => {
      void togglePin({
        source: ref.source,
        breadcrumb: ref.breadcrumb,
        title: ref.title,
      }).catch(() => {
        // The only failure is the pin cap, which the list already
        // shows. Nothing to recover here.
      });
    },
    [togglePin]
  );

  return (
    <div className="rules" onKeyDown={onKeyDown}>
      <div className="rules-bar">
        <h1 className="rules-title">Rules Lawyer</h1>
        <input
          className="npc-search rules-search"
          value={query}
          autoFocus
          ref={inputRef}
          placeholder="Search the rules — grappled, opportunity attack, hiding…"
          aria-label="Search the rules"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpenKey(null);
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

      {trimmed && hits.length > 0 && (
        <AnswerPanel
          answer={shown}
          asking={asking}
          error={askError}
          onAsk={ask}
          onOpenCitation={(cite) => {
            const key = sectionKeyOf(cite);
            setOpenKey(key);
            const at = hits.findIndex((h) => sectionKeyOf(h) === key);
            if (at >= 0) {
              setSelected(at);
              hitRefs.current[at]?.scrollIntoView({ block: "nearest" });
            }
          }}
        />
      )}

      {result === undefined && trimmed ? (
        <p className="centered-note">Searching…</p>
      ) : sources.length === 0 ? (
        <p className="centered-note">
          No rules imported yet — run <code>scripts/import-srd.mjs</code> and
          import the result into the <code>rules</code> table.
        </p>
      ) : !trimmed ? (
        <StartScreen
          pins={pins}
          recents={recents}
          onPick={(q) => {
            setQuery(q);
            inputRef.current?.focus();
          }}
          onOpen={openSection}
          openKey={openKey}
          onUnpin={pinSection}
        />
      ) : hits.length === 0 ? (
        <p className="centered-note">
          Nothing in {source || "the rules"} matches “{trimmed}”.
        </p>
      ) : (
        <ul className="rules-hits">
          {hits.map((hit, i) => {
            const key = sectionKeyOf(hit);
            return (
              <RuleHit
                key={hit._id}
                itemRef={(el) => {
                  hitRefs.current[i] = el;
                }}
                hit={hit}
                terms={terms}
                open={openKey === key}
                selected={selected === i}
                pinned={pinnedKeys.has(key)}
                onToggle={() => {
                  setSelected(i);
                  openSection(key);
                }}
                onPin={() => pinSection(hit)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The AI answer, above the passages it was drawn from.
 *
 * Nothing renders here until it is asked for: the button is the whole
 * panel on an unasked question. That is deliberate — this is the only
 * part of the app that costs money per use, so it never runs because
 * you typed.
 */
function AnswerPanel({
  answer,
  asking,
  error,
  onAsk,
  onOpenCitation,
}: {
  answer: Answer | null;
  asking: boolean;
  error: string | null;
  onAsk: () => void;
  onOpenCitation: (cite: Citation) => void;
}) {
  const known = useMemo(
    () => (answer?.citations ?? []).map((c) => c.n),
    [answer]
  );
  const spans: AnswerSpan[] = useMemo(
    () => (answer ? answerSpans(answer.answer, known) : []),
    [answer, known]
  );

  const byNumber = useMemo(() => {
    const map = new Map<number, Citation>();
    for (const c of answer?.citations ?? []) map.set(c.n, c);
    return map;
  }, [answer]);

  return (
    <section className="rules-answer" aria-label="Rules Lawyer answer">
      <div className="rules-answer-bar">
        <button
          type="button"
          className="text-button rules-ask"
          onClick={onAsk}
          disabled={asking}
        >
          {asking
            ? "Reading the passages…"
            : answer
              ? "Ask again"
              : "Ask the Rules Lawyer"}
        </button>
        {answer?.cached && (
          <span className="settings-note">
            Answered before — this one cost nothing.
          </span>
        )}
        <span className="settings-note rules-answer-note">
          Answered only from the sections below. Check the citations.
        </span>
      </div>

      {error && <p className="rules-answer-error">{error}</p>}

      {answer && (
        <>
          {/* Spans, not markup. The answer is model output and the
              citation markers inside it are model output; JSX escapes
              each span for free. */}
          <p className="rules-answer-text">
            {spans.map((span, i) => {
              const cite = span.cite === null ? null : byNumber.get(span.cite);
              return cite ? (
                <button
                  key={i}
                  type="button"
                  className="rules-cite"
                  title={trailOf(cite.breadcrumb, cite.title)}
                  onClick={() => onOpenCitation(cite)}
                >
                  {span.text}
                </button>
              ) : (
                <span key={i}>{span.text}</span>
              );
            })}
          </p>

          {answer.citations.length > 0 && (
            <ol className="rules-cites">
              {answer.citations.map((c) => (
                <li key={c.n}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpenCitation(c)}
                  >
                    [{c.n}] {trailOf(c.breadcrumb, c.title)}
                  </button>
                  <span className="rules-source">{c.source}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What the screen shows before anything is typed.
 *
 * Pinned sections and the questions this browser asked recently. Both
 * exist for the same reason: at a table you look up the same dozen
 * things all night, and typing "grappled" for the fourth time in an
 * evening is the thing worth removing.
 */
function StartScreen({
  pins,
  recents,
  openKey,
  onPick,
  onOpen,
  onUnpin,
}: {
  pins: Pin[] | undefined;
  recents: string[];
  openKey: string | null;
  onPick: (q: string) => void;
  onOpen: (key: string) => void;
  onUnpin: (ref: {
    source: string;
    breadcrumb: string;
    title: string;
  }) => void;
}) {
  if (pins === undefined) return <p className="centered-note">Loading…</p>;

  if (pins.length === 0 && recents.length === 0) {
    return (
      <p className="centered-note">
        Type a rule, a condition, or a question. Pin the ones you keep
        coming back to and they will be waiting here.
      </p>
    );
  }

  return (
    <div className="rules-start">
      {pins.length > 0 && (
        <section>
          <h2 className="rules-start-head">Pinned</h2>
          <ul className="rules-hits">
            {pins.map((pin) => {
              const key = sectionKeyOf(pin);
              return (
                <li
                  key={pin._id}
                  className={`rules-hit${openKey === key ? " open" : ""}`}
                >
                  <div className="rules-hit-head">
                    <button
                      type="button"
                      className="rules-hit-open"
                      onClick={() => onOpen(key)}
                      disabled={pin.rule === null}
                    >
                      <span className="rules-trail">
                        {trailOf(pin.breadcrumb, pin.title)}
                      </span>
                    </button>
                    <span className="rules-source">{pin.source}</span>
                    <button
                      type="button"
                      className="rules-pin on"
                      aria-label="Unpin this rule"
                      aria-pressed
                      onClick={() => onUnpin(pin)}
                    >
                      ★
                    </button>
                  </div>

                  {/* A pin whose section no longer resolves says so.
                      Dropping it silently would look exactly like a
                      bug to the person who set it. */}
                  {pin.rule === null ? (
                    <p className="rules-missing settings-note">
                      Not in the imported rules any more — the section was
                      renamed or removed. Unpin it, or re-import.
                    </p>
                  ) : (
                    <div className="rules-text">
                      {openKey === key
                        ? pin.rule.text
                        : snippet(pin.rule.text, [])}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {recents.length > 0 && (
        <section>
          <h2 className="rules-start-head">
            Recent questions
            <span className="settings-note"> — this browser, last {RECENT_LIMIT}</span>
          </h2>
          <ul className="rules-recents">
            {recents.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onPick(q)}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RuleHit({
  itemRef,
  hit,
  terms,
  open,
  selected,
  pinned,
  onToggle,
  onPin,
}: {
  /** Named for what it is, not `ref` — React treats that name specially. */
  itemRef: (el: HTMLLIElement | null) => void;
  hit: Hit;
  terms: string[];
  open: boolean;
  selected: boolean;
  pinned: boolean;
  onToggle: () => void;
  onPin: () => void;
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
    <li
      ref={itemRef}
      className={`rules-hit${open ? " open" : ""}${
        selected ? " selected" : ""
      }`}
      aria-current={selected ? "true" : undefined}
    >
      {/* A div, not a button: the pin is a control of its own and a
          button inside a button is not valid markup. */}
      <div className="rules-hit-head">
        <button type="button" className="rules-hit-open" onClick={onToggle}>
          <span className="rules-trail">
            {trailOf(hit.breadcrumb, hit.title)}
          </span>
        </button>
        <span className="rules-source">{hit.source}</span>
        <button
          type="button"
          className={`rules-pin${pinned ? " on" : ""}`}
          aria-label={pinned ? "Unpin this rule" : "Pin this rule"}
          aria-pressed={pinned}
          onClick={onPin}
        >
          ★
        </button>
      </div>

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
};

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
