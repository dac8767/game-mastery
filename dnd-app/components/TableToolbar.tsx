"use client";

import { useEffect, useRef, useState } from "react";
import { UiText, useUiText } from "@/components/UiEditor";

/**
 * The toolbar every record list wears, and the popovers that hang off
 * it: Filter, Group, Sort, View, Search, and the ⋮ menu.
 *
 * It lived inside NpcTable until the Groups screen needed the same bar.
 * Two copies would have been two places for the scrim rule to be got
 * wrong — a panel that opens with nothing to dismiss it is the quiet
 * failure this bar has already been reported for once — so the controls
 * moved here whole and NpcTable imports them.
 *
 * What did NOT move is the panels' contents. Which fields you may
 * filter on, what a column is, what "+ New" creates: those are facts
 * about a particular list, and the bar takes them as children rather
 * than knowing them.
 *
 * The words are registry ids under `list.*` — shared, because "Filter"
 * means the same thing on both screens and renaming it on one and not
 * the other would be a bug rather than a preference. The two that name
 * their own screen's contents ("+ New NPC", "Search groups") are passed
 * in.
 */

/**
 * A toolbar button that carries a count instead of its setting.
 *
 * The count is the whole point: "Filter 2" tells you the list you are
 * looking at is not the whole list, which is the thing you need from
 * across the room. WHICH two filters is a question you ask by opening
 * the panel, and it is the only question the panel exists to answer.
 *
 * Zero shows nothing at all rather than a "0" — a badge that is always
 * there stops being a signal.
 */
export function BarButton({
  labelId,
  count,
  open,
  onClick,
  onClose,
  children,
}: {
  /** A registry id, so edit mode can rename it in place. */
  labelId: string;
  count: number;
  open: boolean;
  onClick: () => void;
  /** Dismiss, for the click-anywhere-else scrim. */
  onClose?: () => void;
  /** The panel this button opens, hung under it. */
  children?: React.ReactNode;
}) {
  return (
    <span className="bar-pop">
      <button
        type="button"
        className={`bar-btn${open ? " open" : ""}${count > 0 ? " on" : ""}`}
        aria-expanded={open}
        onClick={onClick}
      >
        <UiText id={labelId} />
        {count > 0 && <span className="bar-count">{count}</span>}
      </button>

      {/* Hung UNDER the button rather than pushed into the list.
          These used to be blocks in the flow, so opening Filter moved
          every row down the page and closing it moved them back —
          which is the layout jumping under your pointer at the exact
          moment you were aiming at a row. */}
      {open && children && (
        <>
          {/* Catches the click that dismisses, without a document
              listener that would also fire on the button that opened
              it. */}
          <span className="view-scrim" onClick={onClose} />
          <div className="bar-panel">{children}</div>
        </>
      )}
    </span>
  );
}

/**
 * How the roster is drawn, as a chip rather than a labelled dropdown.
 *
 * "View  [Grid ⌄]" spent two words and a form control saying what one
 * word and a caret say. The icon carries the meaning across the room —
 * rows for a grid, squares for tiles — and the name is there for when
 * it does not.
 *
 * Tiles-per-row lives INSIDE it rather than beside it, because it is a
 * setting of one view. On the grid it was a control for something you
 * could not see.
 */
export function ViewPicker({
  mode,
  perRow,
  setMode,
  setPerRow,
}: {
  mode: "grid" | "tiles";
  perRow: number;
  setMode: (next: "grid" | "tiles") => void;
  setPerRow: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="view-picker">
      <button
        type="button"
        className={`bar-btn${open ? " open" : ""}`}
        aria-expanded={open}
        aria-label={`View: ${mode === "grid" ? "Grid" : "Tiles"}`}
        onClick={() => setOpen((v) => !v)}
      >
        {mode === "grid" ? <GridIcon /> : <TilesIcon />}
        <UiText id={mode === "grid" ? "list.view.grid" : "list.view.tiles"} />
        <CaretIcon />
      </button>

      {open && (
        <>
          {/* Closes on a click anywhere else, which is the gesture
              everybody already tries. */}
          <span className="view-scrim" onClick={() => setOpen(false)} />
          <div className="view-menu" role="menu">
            <button
              type="button"
              className={`view-option${mode === "grid" ? " on" : ""}`}
              onClick={() => {
                setMode("grid");
                setOpen(false);
              }}
            >
              <GridIcon />
              <UiText id="list.view.grid" />
            </button>
            <button
              type="button"
              className={`view-option${mode === "tiles" ? " on" : ""}`}
              onClick={() => setMode("tiles")}
            >
              <TilesIcon />
              <UiText id="list.view.tiles" />
            </button>

            {mode === "tiles" && (
              <label className="npc-select view-perrow">
                <UiText id="list.view.perRow" />
                <select
                  value={perRow}
                  onChange={(e) => setPerRow(Number(e.target.value))}
                >
                  {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * The chevron on the View chip.
 *
 * Drawn rather than typed. It was "⌄" — U+2304 DOWN ARROWHEAD — which
 * a text renderer sits on the BASELINE like a letter, so it hung below
 * the words beside it and no amount of line-height fixed it: the glyph
 * is where the font says it is. An SVG is centred by the flexbox like
 * the other icons on the bar, because it is a box rather than a
 * character.
 */
function CaretIcon() {
  return (
    <svg
      className="bar-caret"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 6l5 5 5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Three vertical dots: the things you reach for once a week. */
function MoreIcon() {
  return (
    <svg
      className="bar-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="3" r="1.5" fill="currentColor" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="13" r="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * The overflow menu, right of the search box.
 *
 * Reset and Fields lived on the bar beside Filter, Group and Sort, and
 * did not belong there: those three are what you are doing to the list
 * right now and carry a count saying so, while these two are settings
 * you touch once and then not again for a week. Six buttons in a row
 * all look equally likely; four plus a menu says which is which.
 */
export function MoreMenu({
  onResetLayout,
  onFields,
  onCloseFields,
  fieldsOpen,
  children,
}: {
  onResetLayout: () => void;
  onFields: () => void;
  onCloseFields: () => void;
  fieldsOpen: boolean;
  /** The Fields panel, hung under this button when it is open. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="view-picker bar-pop">
      <button
        type="button"
        className={`bar-btn icon-only${open ? " open" : ""}`}
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>

      {open && (
        <>
          <span className="view-scrim" onClick={() => setOpen(false)} />
          <div className="view-menu" role="menu">
            <button
              type="button"
              className={`view-option${fieldsOpen ? " on" : ""}`}
              onClick={() => {
                onFields();
                setOpen(false);
              }}
            >
              <UiText id="list.more.fields" />
            </button>
            <button
              type="button"
              className="view-option"
              onClick={() => {
                onResetLayout();
                setOpen(false);
              }}
            >
              <UiText id="list.more.reset" />
            </button>
          </div>
        </>
      )}

      {/* Fields opens from the menu above and hangs off the same
          button, so the panel appears where the thing that opened it
          was rather than shoving the table down the page. */}
      {fieldsOpen && children && (
        <>
          <span className="view-scrim" onClick={onCloseFields} />
          <div className="bar-panel">{children}</div>
        </>
      )}
    </span>
  );
}

function GridIcon() {
  return (
    <svg
      className="bar-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2.5" width="13" height="3" rx="1" fill="currentColor" />
      <rect x="1.5" y="6.75" width="13" height="3" rx="1" fill="currentColor" />
      <rect x="1.5" y="11" width="13" height="3" rx="1" fill="currentColor" />
    </svg>
  );
}

function TilesIcon() {
  return (
    <svg
      className="bar-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * Search: an icon until you want it, a field once you do.
 *
 * It does NOT collapse while it holds text. A search box that tidied
 * itself away with a query still in it would leave a shorter list on
 * screen and nothing saying why — the same failure as a hidden filter,
 * and the one thing this toolbar is careful about everywhere else.
 *
 * Declared at module level, not inside NpcTable: a component defined
 * during render is a new component type on every render, so React
 * unmounts the old one and the input loses focus after each keystroke.
 */
export function SearchBox({
  value,
  onChange,
  labelId,
}: {
  value: string;
  onChange: (next: string) => void;
  /** A registry id, so each list names what it searches. */
  labelId: string;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // A placeholder is an attribute, not a child, so it reads the text
  // through the hook rather than rendering <UiText>. Renaming it in
  // edit mode still works — you rename it on the collapsed button,
  // which is the same registry entry.
  const label = useUiText(labelId);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open && !value) {
    return (
      <button
        type="button"
        className="bar-btn bar-search-btn"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
      </button>
    );
  }

  return (
    <div className="bar-search">
      <SearchIcon />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={label}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          onChange("");
          setOpen(false);
        }}
      />
      <button
        type="button"
        className="bar-search-clear"
        aria-label="Close the search"
        onClick={() => {
          onChange("");
          setOpen(false);
        }}
      >
        ×
      </button>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      className="bar-search-icon"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="7"
        cy="7"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <line
        x1="10.4"
        y1="10.4"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
