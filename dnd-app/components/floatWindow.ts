/**
 * A window you can move and resize, as arithmetic.
 *
 * Everything hard about a floating window is at the edges. Drag it far
 * enough and the title bar goes past the top of the screen, where there
 * is nothing left to grab it by; resize it small enough and the close
 * button is outside its own frame; shrink the BROWSER and a window that
 * was politely centred is suddenly off the side entirely. None of those
 * are visible in the happy path, and all of them leave the person stuck
 * with a window they cannot reach.
 *
 * So the rule is one function — `clampBox` — that every change goes
 * through, rather than a bounds check at each of the three call sites,
 * two of which would be right.
 *
 * Free of React and the DOM so the unit guard can exercise the corners
 * without a browser.
 */

export interface WinBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/**
 * The smallest the window is allowed to get.
 *
 * Not an aesthetic floor — below roughly this, the header's title and
 * its Close button stop fitting on one line and the form's two-column
 * name/email row wraps into something taller than the box holding it.
 */
export const MIN_W = 320;
export const MIN_H = 260;

/** How far off the edges a freshly opened window sits. */
const MARGIN = 24;

/**
 * One axis, kept reachable.
 *
 * The two readings of "on screen" agree wherever the window fits and
 * disagree exactly where it does not, so both are written out. A window
 * WIDER than the viewport can only be moved between covering the left
 * edge and covering the right one — clamping it to `[0, view - size]`
 * there would give an empty range, and `Math.min` of an inverted range
 * pins it to a corner it cannot be dragged out of.
 */
function clampAxis(pos: number, size: number, view: number): number {
  if (size >= view) return Math.min(0, Math.max(view - size, pos));
  return Math.max(0, Math.min(view - size, pos));
}

/** A box trimmed to fit the viewport and moved back into it. */
export function clampBox(box: WinBox, view: Size): WinBox {
  const w = Math.max(MIN_W, Math.min(box.w, view.w));
  const h = Math.max(MIN_H, Math.min(box.h, view.h));
  return {
    x: clampAxis(box.x, w, view.w),
    y: clampAxis(box.y, h, view.h),
    w,
    h,
  };
}

/**
 * Where a window opens: middle of the screen, at the size it wants or
 * as close to it as the screen allows.
 */
export function initialBox(view: Size, want: Size): WinBox {
  const w = Math.max(MIN_W, Math.min(want.w, view.w - MARGIN * 2));
  const h = Math.max(MIN_H, Math.min(want.h, view.h - MARGIN * 2));
  return clampBox(
    {
      x: Math.round((view.w - w) / 2),
      y: Math.round((view.h - h) / 2),
      w,
      h,
    },
    view
  );
}

/**
 * The same window, dragged.
 *
 * `dx`/`dy` are measured from where the drag STARTED against the box it
 * started from, not from the last pointer event against the current
 * box. The incremental version drifts: every move the clamp refuses is
 * a pixel the pointer keeps and the window never gets back, so dragging
 * into the top edge and out again leaves the window lower than the hand.
 */
export function moveBox(box: WinBox, dx: number, dy: number, view: Size): WinBox {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy }, view);
}

/**
 * The same window, resized by its corner.
 *
 * Growth stops at the edge of the screen rather than pushing the window
 * back from it: capping the width at `view.w` alone would let a window
 * near the right edge grow wider than the space it has, and `clampBox`
 * would then slide it LEFT — a corner drag to the right that moves the
 * window in the other direction.
 */
export function resizeBox(
  box: WinBox,
  dx: number,
  dy: number,
  view: Size
): WinBox {
  return clampBox(
    {
      ...box,
      w: Math.max(MIN_W, Math.min(box.w + dx, view.w - box.x)),
      h: Math.max(MIN_H, Math.min(box.h + dy, view.h - box.y)),
    },
    view
  );
}
