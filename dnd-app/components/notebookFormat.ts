/**
 * Rich-text formatting for notebook text boxes.
 *
 * Two problems have to be solved together, and solving only one of them
 * produces a toolbar that looks right and does nothing:
 *
 *   1. A toolbar click blurs the box and collapses its selection BEFORE
 *      the handler runs. So the live selection is tracked continuously,
 *      and the remembered range is restored before the command runs.
 *      (The buttons also have to use onMouseDown + preventDefault — see
 *      NotebookFormatBar. Both halves are required.)
 *
 *   2. execCommand changes what is on screen and nothing else. Without
 *      writing the box's new HTML back through the mutation, the edit
 *      looks applied and is gone on reload — the failure that made this
 *      helper necessary in the app this was ported from.
 *
 * Nothing here imports React or Convex: the saver is registered by
 * NotebookTool, so this module stays a plain DOM helper that the unit
 * guard can import in Node.
 */

/** execCommand names, keyed by what the button means. */
export const EXEC: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikeThrough",
  alignLeft: "justifyLeft",
  alignCenter: "justifyCenter",
  alignRight: "justifyRight",
  alignJustify: "justifyFull",
  bullets: "insertUnorderedList",
  numbers: "insertOrderedList",
  clear: "removeFormat",
};

/**
 * A fixed ladder, not a free number field: a list of known sizes is
 * faster to hit than a spinner and cannot produce 13.5pt.
 */
export const FONT_SIZES = [
  8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96,
];

export const FONTS = [
  "Inter",
  "Helvetica",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Menlo",
  "Verdana",
];

/** The command a button key runs, or null if the key is unknown. */
export function execName(key: string): string | null {
  return EXEC[key] ?? null;
}

// ---------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------

/**
 * The attribute the tracker keys on.
 *
 * It is the editable element itself that carries this, not its wrapper:
 * the apply helper reads `innerHTML` off whatever it finds, so pointing
 * at a wrapper would persist the wrapper's markup into the box.
 */
export const BOX_ATTR = "data-nb-box";

let sbBody: HTMLElement | null = null;
let sbBoxId: string | null = null;
let sbRange: Range | null = null;
let sbSave: ((boxId: string, html: string) => void) | null = null;

/**
 * NotebookTool owns the mutation, so it registers the writer once and
 * this module never learns what Convex is. Returns its own undo.
 */
export function registerScrapbookSaver(
  fn: (boxId: string, html: string) => void
): () => void {
  sbSave = fn;
  return () => {
    if (sbSave === fn) sbSave = null;
  };
}

/**
 * Seed the tracker directly when a box takes focus.
 *
 * Belt and braces next to the selectionchange listener: the very first
 * toolbar press has to work, and on a fresh click into an empty box no
 * selectionchange has necessarily fired yet.
 */
export function focusScrapbookBox(el: HTMLElement | null, boxId: string) {
  if (!el) return;
  sbBody = el;
  sbBoxId = boxId;
}

/** Forget a box that is going away, so nothing writes to a dead node. */
export function forgetScrapbookBox(boxId: string) {
  if (sbBoxId !== boxId) return;
  sbBody = null;
  sbBoxId = null;
  sbRange = null;
}

/** Remember the live selection whenever it sits inside a text box. */
export function trackScrapbookSelection() {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const node = sel.anchorNode;
  const el = (
    node && node.nodeType === 3 ? node.parentElement : node
  ) as HTMLElement | null;
  const body = el?.closest?.(`[${BOX_ATTR}]`) as HTMLElement | null;
  if (body) {
    sbBody = body;
    sbBoxId = body.getAttribute(BOX_ATTR);
    sbRange = sel.getRangeAt(0).cloneRange();
  }
}

/** Which box a format button would act on right now, if any. */
export function focusedScrapbookBoxId(): string | null {
  return sbBoxId;
}

/**
 * Apply a formatting command to the focused text box AND persist it.
 *
 * `command` is an execCommand name, plus a synthetic `fontSizePx` that
 * sets an arbitrary size — execCommand('fontSize') only takes the legacy
 * 1–7 scale, so passing "18" silently gives you size 7.
 */
export function applyScrapbookTextFormat(
  command: string,
  value?: string
): boolean {
  const el = sbBody;
  if (!el || !sbBoxId || typeof document.execCommand !== "function") {
    return false;
  }

  el.focus();
  if (sbRange) {
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(sbRange);
  }

  document.execCommand("styleWithCSS", false, "true");

  if (command === "fontSizePx") {
    // Tag the run at legacy size 7, then swap each tag for a px-sized
    // span. styleWithCSS is turned OFF for this path deliberately: the
    // <font size="7"> element is what the rewrite looks for, and with
    // CSS styling on there would be no font tag to find.
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7");
    el.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement("span");
      span.style.fontSize = value || "";
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
    });
  } else {
    document.execCommand(command, false, value);
  }

  // Persist, or the edit is lost the moment anything re-renders.
  sbSave?.(sbBoxId, el.innerHTML);

  // The command moved the selection; keep tracking where it landed so a
  // second button press acts on the same run.
  const sel = document.getSelection();
  if (sel && sel.rangeCount) sbRange = sel.getRangeAt(0).cloneRange();
  return true;
}

/**
 * Put a piece of markup where the caret is.
 *
 * The link picker's whole mechanism: `createLink` needs a selection and
 * does nothing without one, which is the common case — you click Link
 * to ADD a name, not to wrap one you already typed. Inserting the
 * finished anchor covers both, because a selection is replaced by it.
 *
 * Same three obligations as applying a format, and skipping any of them
 * is a link that looks inserted and is not: restore the remembered
 * range, write the box's new HTML back through the saver, and keep
 * tracking where the caret ended up.
 */
export function insertScrapbookHtml(html: string): boolean {
  const el = sbBody;
  if (!el || !sbBoxId || typeof document.execCommand !== "function") {
    return false;
  }

  el.focus();
  if (sbRange) {
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(sbRange);
  }

  document.execCommand("insertHTML", false, html);
  sbSave?.(sbBoxId, el.innerHTML);

  const sel = document.getSelection();
  if (sel && sel.rangeCount) sbRange = sel.getRangeAt(0).cloneRange();
  return true;
}

/** Whether the caret is in a text box, so Link has somewhere to go. */
export function hasScrapbookFocus(): boolean {
  return Boolean(sbBody && sbBoxId);
}
