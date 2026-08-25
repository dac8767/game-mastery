"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LINK_KIND_LABEL,
  LinkTarget,
  exactTarget,
  linkHtml,
  matchTargets,
  readHashQuery,
} from "@/components/noteLinks";
import {
  BOX_ATTR,
  insertScrapbookHtml,
  trackScrapbookSelection,
} from "@/components/notebookFormat";

/**
 * Type `#` in the notes and choose what you meant.
 *
 * The toolbar's Link button asks you to stop writing, reach for a
 * button and come back. This is the same thing without leaving the
 * sentence: `#` opens a list at the caret, every letter narrows it, and
 * choosing replaces the `#…` you typed with the link.
 *
 * THE THING TO UNDERSTAND, because everything else follows from it:
 * the query runs THROUGH SPACES. Names here have them — Kelja Ironfist,
 * the Mining Guild — so a picker that ended at the first space would be
 * asking people to type names that are not the names. But that means
 * the text itself never says where a name stops, so something else has
 * to. Three things do:
 *
 *   choosing      Enter, Tab or a click takes the highlighted option,
 *                 at any point. "#Kel" + Enter is a link.
 *   finishing it  a query that exactly names one target, with nothing
 *                 longer starting the same way, links itself. This is
 *                 what makes "#Kelja Ironfist" work with no keypress.
 *   giving up     Escape, or a query nothing matches. Both leave the
 *                 text exactly as typed, which is what somebody writing
 *                 "#3 on the list" wanted all along.
 *
 * Mounted once by the screen, like the format bar and for the same
 * reason: it reads the caret out of `notebookFormat`, which tracks one
 * for the whole document.
 */
export function NoteMentions({
  campaignId,
  targets,
}: {
  campaignId: string;
  targets: LinkTarget[];
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(0);

  /**
   * The text node and offsets the `#…` occupies, held in a ref.
   *
   * A live DOM node is the one thing that must not go in state: React
   * keeps the value from the render it was set in, and by the time a
   * click handler runs, the node it names may have been replaced by a
   * re-render of the box. Read fresh, used immediately, never rendered.
   */
  const spot = useRef<{ node: Text; from: number; to: number } | null>(null);

  /**
   * A `#` the person has dismissed, so it stays dismissed.
   *
   * Without this, Escape closes the panel and the very next keystroke
   * re-opens it on the same `#` — which is not "no thank you", it is a
   * panel you cannot get rid of without deleting what you typed.
   */
  const dropped = useRef<{ node: Text; from: number } | null>(null);

  const shown = query === null ? [] : matchTargets(targets, query, 8);

  const close = useCallback(() => {
    setQuery(null);
    setAt(null);
    setActive(0);
    spot.current = null;
  }, []);

  /**
   * Put the link in, in place of the `#…` that asked for it.
   *
   * The range is rebuilt here rather than remembered: `insertHTML`
   * replaces the SELECTION, so the selection has to be the text being
   * replaced — and `trackScrapbookSelection` is what tells the shared
   * helper that this is the range to restore. Skip that call and the
   * insert lands wherever the caret was last tracked, which is usually
   * one character to the left and occasionally in another box.
   */
  const commit = useCallback(
    (target: LinkTarget) => {
      const here = spot.current;
      const html = linkHtml(campaignId, target);
      if (!here || !html) return close();

      const range = document.createRange();
      const len = here.node.textContent?.length ?? 0;
      range.setStart(here.node, Math.min(here.from, len));
      range.setEnd(here.node, Math.min(here.to, len));

      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      trackScrapbookSelection();

      // A non-breaking space after the anchor, so the caret lands
      // OUTSIDE the link and the next word typed is not part of it. A
      // plain space is collapsed away by insertHTML and the caret stays
      // inside, which turns the rest of the sentence into the link.
      insertScrapbookHtml(`${html}&nbsp;`);
      close();
    },
    [campaignId, close]
  );

  /** Where the caret is, and whether it is in a `#…`. */
  const look = useCallback(() => {
    const sel = document.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return close();

    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return close();
    const text = node as Text;
    if (!text.parentElement?.closest(`[${BOX_ATTR}]`)) return close();

    const found = readHashQuery(text.textContent ?? "", sel.anchorOffset);
    if (!found) {
      dropped.current = null;
      return close();
    }

    const gone = dropped.current;
    if (gone && gone.node === text && gone.from === found.at) return close();
    dropped.current = null;

    spot.current = { node: text, from: found.at, to: sel.anchorOffset };

    // Finished naming something? Then it is named, and the panel never
    // needs to appear at all.
    const done = exactTarget(targets, found.query);
    if (done) return commit(done);

    // Measured across the `#` itself rather than at a collapsed caret:
    // a collapsed range reports a zero-width rect, and in an empty line
    // reports nothing at all.
    const probe = document.createRange();
    probe.setStart(text, found.at);
    probe.setEnd(text, Math.min(found.at + 1, text.textContent?.length ?? 0));
    const box = probe.getBoundingClientRect();

    setQuery(found.query);
    setAt({ x: box.left, y: box.bottom });
    setActive(0);
  }, [close, commit, targets]);

  useEffect(() => {
    // `input` catches the typing; `selectionchange` catches clicking or
    // arrowing away from a `#` that is still there. Neither alone is
    // enough — without the second, the panel follows you to the far end
    // of the page.
    document.addEventListener("input", look);
    document.addEventListener("selectionchange", look);
    return () => {
      document.removeEventListener("input", look);
      document.removeEventListener("selectionchange", look);
    };
  }, [look]);

  // Capture phase, so the arrow keys move the highlight rather than the
  // caret, and Enter takes the option rather than breaking the line.
  useEffect(() => {
    if (query === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const here = spot.current;
        if (here) dropped.current = { node: here.node, from: here.from };
        close();
        return;
      }
      if (shown.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : shown.length - 1;
        setActive((i) => (i + step) % shown.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commit(shown[Math.min(active, shown.length - 1)]);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [query, shown, active, close, commit]);

  // Nothing matching is not an empty panel, it is no panel: "#3 on the
  // list" is somebody writing, not somebody searching badly.
  if (query === null || at === null || shown.length === 0) return null;

  return (
    <div
      className="nb-mention"
      style={{
        left: Math.min(at.x, window.innerWidth - 260),
        top: Math.min(at.y + 4, window.innerHeight - 240),
      }}
    >
      <ul className="nb-link-list">
        {shown.map((t, i) => (
          <li key={`${t.kind}:${t.name}`}>
            <button
              type="button"
              className={`nb-link-opt${i === active ? " on" : ""}`}
              // Same rule as every button on the format bar: a click
              // would collapse the selection before the handler ran,
              // and the link would be inserted nowhere.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(t);
              }}
            >
              <span className="nb-link-kind">{LINK_KIND_LABEL[t.kind]}</span>
              {t.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
