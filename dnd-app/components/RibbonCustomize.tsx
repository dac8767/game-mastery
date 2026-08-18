"use client";

import { useRef, useState } from "react";
import { DndColumns } from "@/components/DndColumns";
import { buildPalette, tokenIcon, tokenLabel } from "@/components/ribbonRegistry";
import {
  isSectionTitle,
  isStructural,
  spacerWidth,
  stripTall,
  withSpacerWidth,
} from "@/components/ribbonTokens";

/**
 * Customize the ribbon: two columns, Shown and Hidden.
 *
 * The Shown column IS the token sequence — same order, same length,
 * structural tokens included as their own rows. That is the whole
 * trick: there is no translation layer to get out of sync, because the
 * list *is* the model.
 *
 * Edits apply LIVE — the bar changes as you drag, with no Apply button,
 * because you are laying out a toolbar you are looking at. That means
 * Cancel needs a real snapshot rather than a diff, which is the ref
 * taken on open below.
 *
 * Two shapes that were tried and abandoned in the app this came from,
 * so they aren't re-invented here: an editable replica of the ribbon
 * inside the dialog (a losing battle to keep matching the real bar), and
 * in-place editing on the live bar itself (demos beautifully; makes the
 * bar a second editor for the thing this window edits, and needs
 * hundreds of lines of bespoke drag machinery).
 */

const STRUCTURAL = [
  { value: "divider", label: "Divider — one row" },
  { value: "divider2", label: "Divider — two rows" },
  { value: "spacer", label: "Spacer" },
  { value: "rowbreak", label: "Row Break" },
  { value: "rowbreakline", label: "Row Break (with line)" },
  { value: "title", label: "Section Title" },
  { value: "split", label: "Alignment Split" },
];

/**
 * Ids only need to be unique within the sequence, and they are also the
 * React keys of the rows — so a counter rides along with the clock, or
 * two pieces added in the same millisecond would collide and one row
 * would vanish mid-drag.
 */
let seq = 0;
const mintId = () => `${Date.now()}-${++seq}`;

const MINT: Record<string, () => string> = {
  divider: () => `d:${mintId()}`,
  divider2: () => `2!d:${mintId()}`, // a section boundary
  spacer: () => `s:${mintId()}`,
  rowbreak: () => `r:${mintId()}`,
  rowbreakline: () => `rl:${mintId()}`,
  title: () => "st:", // empty: its row IS a text field
};

export function RibbonCustomize({
  tokens,
  setTokens,
  onClose,
}: {
  tokens: string[];
  setTokens: (next: string[]) => void;
  onClose: () => void;
}) {
  // The snapshot Cancel restores, taken once when the window opened.
  const snapshot = useRef(tokens);
  const [note, setNote] = useState<string | null>(null);

  const placed = (value: string) => tokens.some((t) => stripTall(t) === value);
  const palette = buildPalette(placed);

  const addStructural = (kind: string) => {
    setNote(null);
    if (kind === "split") {
      // At most one. A second is silently ignored on parse, so refuse it
      // out loud rather than adding a token that does nothing.
      if (tokens.some((t) => t.startsWith("a:"))) {
        setNote("The toolbar already has an alignment split.");
        return;
      }
      setTokens([...tokens, `a:${mintId()}`]);
      return;
    }
    const mint = MINT[kind];
    if (mint) setTokens([...tokens, mint()]);
  };

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="rib-modal" role="dialog" aria-label="Customize toolbar">
        <header className="rib-modal-head">
          <h2>Customize the toolbar</h2>
          <button type="button" className="text-button" onClick={onClose}>
            Done
          </button>
        </header>

        <p className="settings-note">
          Drag to rearrange. This is your toolbar only — nobody else&apos;s
          view changes.
        </p>

        {note && <p className="form-error">{note}</p>}

        <DndColumns
          columns={[
            {
              id: "shown",
              title: "Shown",
              headerExtra: (
                <>
                  <AddMenu onPick={addStructural} />
                  <button
                    type="button"
                    className="dnd-headbtn"
                    onClick={() =>
                      setTokens([
                        ...tokens,
                        ...palette.flatMap((c) => c.options.map((o) => o.value)),
                      ])
                    }
                  >
                    Show All
                  </button>
                </>
              ),
              sections: [
                {
                  rows: tokens.map((tok) => ({
                    key: tok,
                    content: (
                      <span className="dnd-item">
                        <span className="dnd-item-icon">
                          {tokenIcon(tok)}
                        </span>

                        {isSectionTitle(stripTall(tok)) ? (
                          <SectionTitleInput
                            value={stripTall(tok).slice(3)}
                            onCommit={(v) =>
                              // An empty st: token still paints its band
                              // on the bar, so a title you have cleared
                              // is a title you have deleted.
                              setTokens(
                                v.trim()
                                  ? tokens.map((t) =>
                                      t === tok ? `st:${v.trim()}` : t
                                    )
                                  : tokens.filter((t) => t !== tok)
                              )
                            }
                          />
                        ) : (
                          <span
                            className={
                              isStructural(tok) ? "dnd-structural" : undefined
                            }
                          >
                            {tokenLabel(tok)}
                          </span>
                        )}

                        {spacerWidth(tok) !== null ||
                        stripTall(tok).startsWith("s:") ? (
                          <WidthInput
                            value={spacerWidth(tok)}
                            onCommit={(px) =>
                              setTokens(
                                tokens.map((t) =>
                                  t === tok ? withSpacerWidth(t, px) : t
                                )
                              )
                            }
                          />
                        ) : null}

                        <button
                          type="button"
                          className="dnd-rowbtn"
                          title="Remove from the toolbar"
                          onClick={() =>
                            setTokens(tokens.filter((t) => t !== tok))
                          }
                        >
                          ×
                        </button>
                      </span>
                    ),
                  })),
                },
              ],
            },
            {
              id: "hidden",
              title: "Hidden",
              isHidden: true,
              headerExtra: (
                <button
                  type="button"
                  className="dnd-headbtn"
                  onClick={() => setTokens([])}
                >
                  Hide All
                </button>
              ),
              sections: palette.map((cat) => ({
                label: cat.label,
                rows: cat.options.map((o) => ({
                  key: o.value,
                  content: (
                    <span className="dnd-item">
                      <span className="dnd-item-icon">{tokenIcon(o.value)}</span>
                      <span>{o.label}</span>
                      <button
                        type="button"
                        className="dnd-rowbtn"
                        title="Add to the end"
                        onClick={() => setTokens([...tokens, o.value])}
                      >
                        +
                      </button>
                    </span>
                  ),
                })),
              })),
            },
          ]}
          onDrop={(src, dst) => {
            const tok = src.key;
            if (dst.col === "hidden") {
              setTokens(tokens.filter((t) => t !== tok));
              return;
            }
            // Filtering first makes "new from the palette" and "moving
            // within the list" the same operation.
            const next = tokens.filter((t) => t !== tok);
            next.splice(Math.min(dst.idx, next.length), 0, tok);
            setTokens(next);
          }}
        />

        <footer className="rib-modal-foot">
          <button
            type="button"
            className="npc-btn"
            onClick={() => {
              setTokens(snapshot.current);
              onClose();
            }}
          >
            Cancel
          </button>
          <button type="button" className="npc-btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </>
  );
}

function AddMenu({ onPick }: { onPick: (kind: string) => void }) {
  return (
    <select
      className="dnd-headbtn"
      value=""
      onChange={(e) => {
        if (!e.target.value) return;
        onPick(e.target.value);
        e.target.selectedIndex = 0;
      }}
    >
      <option value="" disabled hidden>
        + Add
      </option>
      {STRUCTURAL.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A section title IS its token, and the token is the row's React key.
 *
 * Writing each keystroke straight through would give the row a new key
 * per character, remounting the input and dropping focus after one
 * letter. It looks broken while behaving exactly as written — so this
 * drafts locally and commits on blur.
 */
function SectionTitleInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="dnd-field"
      value={draft ?? value}
      placeholder="Section title"
      // The row's drag would otherwise steal the caret.
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}

/** Same draft-and-commit shape, for a spacer's width in pixels. */
function WidthInput({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (px: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));

  return (
    <label className="dnd-width">
      Width
      <input
        className="dnd-field dnd-field-num"
        type="number"
        min={0}
        value={shown}
        placeholder="auto"
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const px = Number(draft);
            onCommit(draft.trim() && Number.isFinite(px) && px > 0 ? px : null);
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
      />
    </label>
  );
}
