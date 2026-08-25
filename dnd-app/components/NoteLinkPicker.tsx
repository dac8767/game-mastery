"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LINK_KIND_LABEL,
  LinkTarget,
  linkHtml,
  matchTargets,
} from "@/components/noteLinks";
import {
  hasScrapbookFocus,
  insertScrapbookHtml,
} from "@/components/notebookFormat";

/**
 * Link, on the format bar: pick something in the campaign and put its
 * name in the notes.
 *
 * The one thing to get right is the same thing every button on this bar
 * gets right, and for the same reason: a click moves focus out of the
 * text box and collapses its selection BEFORE the handler runs, so the
 * insert would land nowhere. Every control here uses onMouseDown with
 * preventDefault, and the search box is deliberately NOT focused when
 * the panel opens — focusing it would take the caret out of the box the
 * link is meant to go into, which is the failure this whole mechanism
 * exists to avoid. You type into it without it holding focus, because
 * the keystrokes are handled rather than typed.
 */
export function NoteLinkPicker({
  campaignId,
  targets,
}: {
  campaignId: string;
  targets: LinkTarget[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLSpanElement>(null);

  const shown = useMemo(() => matchTargets(targets, query), [targets, query]);

  // Typed into without ever holding focus. A real input would steal the
  // caret from the text box, and the remembered range is only alive
  // while nothing else has claimed the selection.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setQuery((q) => q + e.key);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const insert = (target: LinkTarget) => {
    const html = linkHtml(campaignId, target);
    if (html) insertScrapbookHtml(html);
    setOpen(false);
    setQuery("");
  };

  return (
    /* nb-fmt-pop-HOST, not nb-fmt-pop. The second is the floating panel
       itself — `position: absolute; top: 1.9rem` — so wearing it here
       took the Link button out of the toolbar's flow and hung it in a
       box of its own below the bar's right-hand end. Reported as "a
       floating attachment icon out of place", which is precisely what
       it was. */
    <span className="nb-fmt-pop-host" ref={wrap}>
      <button
        type="button"
        className={`nb-fmt-btn${open ? " on" : ""}`}
        title="Link to an NPC, place or group"
        onMouseDown={(e) => {
          e.preventDefault();
          // Refuses rather than opening onto nothing: with no caret in
          // a text box there is nowhere for a link to go, and a panel
          // that let you choose one and then swallowed it is worse
          // than a button that does not open.
          if (!hasScrapbookFocus()) return;
          setOpen((v) => !v);
          setQuery("");
        }}
      >
        🔗
      </button>

      {open && (
        <>
          <span
            className="view-scrim"
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen(false);
            }}
          />
          <div className="nb-link-panel">
            <div className="nb-link-query">
              {query || <span className="muted">Type to search…</span>}
            </div>
            {shown.length === 0 ? (
              <p className="muted nb-link-empty">Nothing matches that.</p>
            ) : (
              <ul className="nb-link-list">
                {shown.map((t) => (
                  <li key={`${t.kind}:${t.name}`}>
                    <button
                      type="button"
                      className="nb-link-opt"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insert(t);
                      }}
                    >
                      <span className="nb-link-kind">
                        {LINK_KIND_LABEL[t.kind]}
                      </span>
                      {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </span>
  );
}
