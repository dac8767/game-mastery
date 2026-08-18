"use client";

import { useState } from "react";
import {
  EXEC,
  FONTS,
  FONT_SIZES,
  applyScrapbookTextFormat,
} from "@/components/notebookFormat";

/**
 * The format toolbar for notebook text boxes.
 *
 * THE load-bearing detail, on every button in this file: onMouseDown
 * with preventDefault, never onClick.
 *
 * A click moves focus out of the contentEditable and collapses its
 * selection BEFORE the handler runs, so the format applies to nothing.
 * Preventing the default on mousedown keeps the selection alive. This is
 * not a nicety — with onClick the toolbar silently does nothing, which
 * reads as a broken command rather than a focus bug.
 *
 * The one exception is a <select>: preventing its mousedown stops it
 * opening at all. That is safe, because it is the range remembered in
 * notebookFormat, not the live selection, that the apply helper restores.
 *
 * Everything routes through applyScrapbookTextFormat and never
 * document.execCommand directly — the helper is also what writes the
 * box's new HTML back through the mutation.
 */

function FormatButton({
  cmd,
  label,
  title,
  style,
}: {
  cmd: keyof typeof EXEC | string;
  label: string;
  title: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      className="nb-fmt-btn"
      title={title}
      style={style}
      onMouseDown={(e) => {
        e.preventDefault();
        const name = EXEC[cmd];
        if (name) applyScrapbookTextFormat(name);
      }}
    >
      {label}
    </button>
  );
}

export function NotebookFormatBar() {
  const [colorOpen, setColorOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);

  return (
    <div className="nb-fmtbar">
      <select
        className="nb-fmt-select"
        title="Font"
        defaultValue=""
        onChange={(e) => {
          if (!e.target.value) return;
          applyScrapbookTextFormat("fontName", e.target.value);
          e.target.selectedIndex = 0;
        }}
      >
        <option value="" disabled hidden>
          Font
        </option>
        {FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
      </select>

      {/* Not execCommand('fontSize') directly: that takes the legacy 1–7
          scale, so "18pt" is not expressible. The helper's fontSizePx
          path tags the run at size 7 and rewrites each <font> as a
          pt-sized span. */}
      <select
        className="nb-fmt-select nb-fmt-size"
        title="Font size"
        defaultValue=""
        onChange={(e) => {
          if (!e.target.value) return;
          applyScrapbookTextFormat("fontSizePx", `${Number(e.target.value)}pt`);
          e.target.selectedIndex = 0;
        }}
      >
        <option value="" disabled hidden>
          Size
        </option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}pt
          </option>
        ))}
      </select>

      <span className="nb-fmt-sep" />

      <FormatButton cmd="bold" label="B" title="Bold" style={{ fontWeight: 700 }} />
      <FormatButton
        cmd="italic"
        label="I"
        title="Italic"
        style={{ fontStyle: "italic" }}
      />
      <FormatButton
        cmd="underline"
        label="U"
        title="Underline"
        style={{ textDecoration: "underline" }}
      />
      <FormatButton
        cmd="strike"
        label="S"
        title="Strikethrough"
        style={{ textDecoration: "line-through" }}
      />

      <span className="nb-fmt-sep" />

      <div className="nb-fmt-pop-host">
        <button
          type="button"
          className="nb-fmt-btn"
          title="Text colour"
          onMouseDown={(e) => {
            e.preventDefault();
            setColorOpen((o) => !o);
            setBgOpen(false);
          }}
        >
          A
        </button>
        {colorOpen && (
          <input
            type="color"
            className="nb-fmt-color"
            autoFocus
            onChange={(e) => {
              applyScrapbookTextFormat("foreColor", e.target.value);
              setColorOpen(false);
            }}
            onBlur={() => setColorOpen(false)}
          />
        )}
      </div>

      {/* execCommand has no "unset", so None paints the no-colour colour.
          Worth having: pasted text arrives carrying a highlight with no
          other way to clear it. */}
      <div className="nb-fmt-pop-host">
        <button
          type="button"
          className="nb-fmt-btn"
          title="Highlight — None removes it"
          onMouseDown={(e) => {
            e.preventDefault();
            setBgOpen((o) => !o);
            setColorOpen(false);
          }}
        >
          ▨
        </button>
        {bgOpen && (
          <div className="nb-fmt-pop">
            <input
              type="color"
              onChange={(e) => {
                applyScrapbookTextFormat("hiliteColor", e.target.value);
                setBgOpen(false);
              }}
            />
            <button
              type="button"
              className="nb-fmt-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                applyScrapbookTextFormat("hiliteColor", "transparent");
                setBgOpen(false);
              }}
            >
              None
            </button>
          </div>
        )}
      </div>

      <span className="nb-fmt-sep" />

      <FormatButton cmd="alignLeft" label="⯇" title="Align left" />
      <FormatButton cmd="alignCenter" label="≡" title="Align centre" />
      <FormatButton cmd="alignRight" label="⯈" title="Align right" />
      <FormatButton cmd="alignJustify" label="☰" title="Justify" />

      <span className="nb-fmt-sep" />

      <FormatButton cmd="bullets" label="•" title="Bulleted list" />
      <FormatButton cmd="numbers" label="1." title="Numbered list" />
      <FormatButton cmd="clear" label="⌫" title="Clear formatting" />
    </div>
  );
}
