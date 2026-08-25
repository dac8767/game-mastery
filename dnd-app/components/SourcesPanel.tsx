"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SourceBook, sourceBooks } from "@/components/sourceNames";

/**
 * Which books the library draws from.
 *
 * A switch per book. Off means its entries stop appearing in the
 * Lookup tables — all seven of them, everywhere, rather than a filter
 * you re-apply on each tab.
 *
 * Stored by the book's NAME rather than its abbreviation, because
 * several books answer to two codes and a list keyed on codes would
 * offer Elemental Evil twice and hide half of it when you switched one
 * off. sourceBooks() is what collapses those into one row apiece.
 *
 * Everything here is written OPTIMISTICALLY: the switch moves on the
 * click and the mutation follows. Ninety checkboxes that each wait for
 * a round trip is ninety visible lags, and this is the screen where
 * somebody turns off a dozen books in a row.
 */
export function SourcesPanel({
  excluded,
}: {
  /** Book names currently switched off, from mySettings. */
  excluded: string[];
}) {
  const save = useMutation(api.settings.saveMySettings);
  const books = useMemo(() => sourceBooks(), []);

  const [pending, setPending] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // The pending list while a write is in flight, the server's after it
  // lands. Reading the server's on every render would snap a switch
  // back for the moment between the click and the round trip.
  const off = new Set(pending ?? excluded);

  const write = (next: string[]) => {
    setPending(next);
    setError(null);
    void save({ excludedSources: next })
      .then(() => setPending(null))
      .catch((e) => {
        // Put it back. A switch that looks changed and was not is worse
        // than one that refuses.
        setPending(null);
        setError(e instanceof Error ? e.message : "That didn't save.");
      });
  };

  const toggle = (book: SourceBook) => {
    const next = off.has(book.name)
      ? [...off].filter((n) => n !== book.name)
      : [...off, book.name];
    write(next.sort());
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.codes.some((c) => c.toLowerCase().includes(q))
    );
  }, [books, query]);

  return (
    <div className="settings-section">
      <p className="settings-note">
        {off.size === 0
          ? "Every book is switched on."
          : `${off.size} of ${books.length} books switched off.`}{" "}
        A book the app has no name for is listed in the Lookup tables
        under its abbreviation and cannot be switched here — run{" "}
        <code>npm run sources</code> against the export to find those.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="sources-bar">
        <input
          className="detail-input"
          value={query}
          placeholder="Search books"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="npc-btn"
          disabled={off.size === 0}
          onClick={() => write([])}
        >
          Switch all on
        </button>
        <button
          type="button"
          className="npc-btn"
          disabled={off.size === books.length}
          onClick={() => write(books.map((b) => b.name).sort())}
        >
          Switch all off
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="centered-note">No book matches that.</p>
      ) : (
        <ul className="sources-list">
          {shown.map((book) => {
            const on = !off.has(book.name);
            return (
              <li key={book.name}>
                <label className="sources-row">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(book)}
                  />
                  <span className="sources-name">{book.name}</span>
                  {/* The codes, because the Source column falls back to
                      them on a narrow screen and because an export
                      writes them rather than the title. */}
                  <span className="sources-codes">{book.codes.join(", ")}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
