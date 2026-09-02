/**
 * The app's undo history: every committed edit, in order, and the way
 * back from each.
 *
 * The browser already undoes typing inside a field. What it cannot
 * undo is a field that has SAVED — Enter in a table cell, Tab out of a
 * name, a click away from a note. Every table here closes its editor
 * on commit, and every record field saves on blur, so to somebody at
 * the keyboard Cmd+Z did nothing anywhere: by the time they reached
 * for it, the change was already on the server and the field that had
 * held it was gone.
 *
 * So an edit that goes to the server registers here with its inverse,
 * and Cmd+Z runs the inverse — the same mutation, the old value. It
 * is a plain module rather than React state because the stack has to
 * outlive the screen the edit was made on: rename an NPC, open the
 * notebook, change your mind. And it has no idea what Convex is, so
 * the unit guard can drive it.
 *
 * Both directions are async and the stack is locked while one runs.
 * Two Cmd+Zs in flight at once would race the server for the same
 * row, and whichever landed second would win — which is not what
 * either keystroke meant.
 */

export interface UndoEntry {
  /** What the toast says was put back: "Middle name", "Todo text". */
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

export type UndoOutcome =
  | { kind: "undid"; label: string }
  | { kind: "redid"; label: string }
  | { kind: "nothing"; direction: "undo" | "redo" }
  | { kind: "busy" }
  | { kind: "failed"; direction: "undo" | "redo"; label: string; error: unknown };

/** Kept from growing without bound in a session that lasts all night. */
export const HISTORY_LIMIT = 200;

let past: UndoEntry[] = [];
let future: UndoEntry[] = [];
let busy = false;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/**
 * A committed change and its way back.
 *
 * Registering a new edit throws away the redo stack, the way every
 * editor does: a redo after a fresh edit would re-apply something on
 * top of a state it was never made against.
 */
export function record(entry: UndoEntry): void {
  past.push(entry);
  if (past.length > HISTORY_LIMIT) past = past.slice(-HISTORY_LIMIT);
  future = [];
  notify();
}

export function canUndo(): boolean {
  return past.length > 0;
}

export function canRedo(): boolean {
  return future.length > 0;
}

/** The label of what Cmd+Z would put back, for a tooltip or a menu. */
export function peekUndo(): string | null {
  return past.length ? past[past.length - 1].label : null;
}

export function peekRedo(): string | null {
  return future.length ? future[future.length - 1].label : null;
}

async function step(direction: "undo" | "redo"): Promise<UndoOutcome> {
  if (busy) return { kind: "busy" };
  const from = direction === "undo" ? past : future;
  const entry = from[from.length - 1];
  if (!entry) return { kind: "nothing", direction };

  // Taken off BEFORE it runs. An inverse can register a fresh entry
  // while it is in flight — undoing a notebook box blurs it, and the
  // blur commits whatever the box held — and popping afterwards would
  // then take that new entry off the top and leave this one behind.
  from.pop();
  busy = true;
  try {
    await (direction === "undo" ? entry.undo() : entry.redo());
  } catch (error) {
    // Put back where it was: the server refused the inverse, so the
    // state it describes is still the state. Dropping it would leave
    // the NEXT Cmd+Z skipping over a change that never went back.
    from.push(entry);
    busy = false;
    notify();
    return { kind: "failed", direction, label: entry.label, error };
  }
  (direction === "undo" ? future : past).push(entry);
  busy = false;
  notify();
  return direction === "undo"
    ? { kind: "undid", label: entry.label }
    : { kind: "redid", label: entry.label };
}

export function undo(): Promise<UndoOutcome> {
  return step("undo");
}

export function redo(): Promise<UndoOutcome> {
  return step("redo");
}

/** For a UI that wants to grey its buttons. Returns the unsubscribe. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Forget everything — on sign-out, so one person's edits are not the next's Cmd+Z. */
export function clearHistory(): void {
  past = [];
  future = [];
  notify();
}
