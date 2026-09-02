"use client";

import { useEffect, useRef, useState } from "react";
import { redo, undo, type UndoOutcome } from "@/components/undoHistory";

/**
 * Cmd+Z and Cmd+Shift+Z, everywhere.
 *
 * Mounted once, under the providers, so it is listening on every screen
 * including the campaign list. It owns nothing but the keystroke and a
 * line of feedback; the history itself is `undoHistory`.
 *
 * The one real decision is who gets the key when a field has focus.
 * The browser's own undo comes first — typing in a box you have not
 * left is the browser's to take back, and it does that better than
 * anything re-implemented here. But once that field's own history is
 * spent (or it never had one: you tabbed into it fresh), the same key
 * has to reach the saved edit behind it, or Cmd+Z goes dead at exactly
 * the moment somebody wants it.
 *
 * Telling the two apart without guessing: a native undo announces
 * itself as an `input` event whose inputType is "historyUndo". So the
 * keydown lets the default happen, listens for that announcement, and
 * only if none arrives by the next tick does it reach for the stack.
 * Outside a field there is nothing to wait for, and the default (which
 * in Chrome is nothing at all) is cancelled so the page does not also
 * try to be helpful.
 *
 * The toast is the part that makes it believable. The field that was
 * put back may be on another screen, or scrolled away, or a table cell
 * with no editor open — without a word saying "Undid · Middle name",
 * the keystroke looks as dead as it did before.
 */
export function UndoKeys() {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const say = (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      setToast(text);
      timer.current = setTimeout(() => setToast(null), 2200);
    };

    const report = (outcome: UndoOutcome) => {
      switch (outcome.kind) {
        case "undid":
          say(`Undid · ${outcome.label}`);
          break;
        case "redid":
          say(`Redid · ${outcome.label}`);
          break;
        case "nothing":
          say(outcome.direction === "undo" ? "Nothing to undo" : "Nothing to redo");
          break;
        case "failed":
          say(
            `Could not ${outcome.direction} ${outcome.label}: ${
              outcome.error instanceof Error
                ? outcome.error.message
                : "the server refused it"
            }`
          );
          break;
        case "busy":
          break;
      }
    };

    const run = (direction: "undo" | "redo") => {
      void (direction === "undo" ? undo() : redo()).then(report);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      let direction: "undo" | "redo" | null = null;
      if (key === "z") direction = e.shiftKey ? "redo" : "undo";
      // Ctrl+Y is redo on Windows and Linux; Cmd+Y is history on a Mac.
      else if (key === "y" && e.ctrlKey && !e.metaKey) direction = "redo";
      if (!direction) return;

      if (isEditable(e.target)) {
        let native = false;
        const heard = (ev: Event) => {
          const type = (ev as InputEvent).inputType;
          if (type === "historyUndo" || type === "historyRedo") native = true;
        };
        document.addEventListener("input", heard, true);
        setTimeout(() => {
          document.removeEventListener("input", heard, true);
          if (!native) run(direction);
        }, 0);
        return;
      }

      e.preventDefault();
      run(direction);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!toast) return null;
  return (
    <div className="undo-toast" role="status" aria-live="polite">
      {toast}
    </div>
  );
}

/** Where the browser has its own undo stack to try first. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return !(target as HTMLTextAreaElement).readOnly;
  if (tag === "INPUT") {
    const input = target as HTMLInputElement;
    if (input.readOnly) return false;
    // Checkboxes, buttons, ranges: no text, no history of their own.
    return !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/.test(
      input.type
    );
  }
  return false;
}
