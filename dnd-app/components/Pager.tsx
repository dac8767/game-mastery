"use client";

import {
  clampPage,
  pageCount,
  pageNumbers,
} from "@/components/pagerModel";

/**
 * The page row under every table: Previous, the standard numbered
 * pages with gaps elided, Next. Renders nothing at all for a single
 * page — controls that can do nothing are noise under every short
 * list.
 *
 * Takes the TOTAL and derives the count, so no caller can disagree
 * with the arithmetic in pager.ts about how many pages there are.
 */
export function Pager({
  total,
  page,
  size,
  onPage,
}: {
  total: number;
  page: number;
  size: number;
  onPage: (page: number) => void;
}) {
  const count = pageCount(total, size);
  if (count <= 1) return null;
  const p = clampPage(page, count);

  return (
    <nav className="pager" aria-label="Pages">
      <button
        type="button"
        className="pager-step"
        disabled={p === 0}
        onClick={() => onPage(p - 1)}
      >
        ‹ Previous
      </button>
      {pageNumbers(p, count).map((n, i) =>
        n === "gap" ? (
          <span key={`gap${i}`} className="pager-gap">
            …
          </span>
        ) : (
          <button
            type="button"
            key={n}
            className={`pager-num${n === p ? " on" : ""}`}
            aria-current={n === p ? "page" : undefined}
            onClick={() => onPage(n)}
          >
            {n + 1}
          </button>
        )
      )}
      <button
        type="button"
        className="pager-step"
        disabled={p === count - 1}
        onClick={() => onPage(p + 1)}
      >
        Next ›
      </button>
    </nav>
  );
}
