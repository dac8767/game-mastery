/**
 * Taking a picture of the screen, from inside the page.
 *
 * The browser will not hand a page its own pixels — that is the whole
 * point of the same-origin rules — so the only route is the screen
 * CAPTURE api, where the person picks what to share and the page reads
 * frames from the stream they chose. Chrome's `preferCurrentTab` puts
 * this tab at the top of that picker, which makes it one click rather
 * than a hunt.
 *
 * Which has one consequence worth stating plainly: a screenshot taken
 * this way is of the whole surface the picker chose, at the device's
 * own pixel scale. So a crop drawn on screen is in CSS pixels and the
 * image is not, and mapping between the two is the fiddly part rather
 * than the capture. That mapping is the pure half of this file, and it
 * is where the arithmetic is tested.
 *
 * The geometry functions know nothing about the DOM so the unit guard
 * can compile them alone.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Two corners of a drag, as a rectangle.
 *
 * A drag runs in whichever direction the hand went, so the second
 * corner is as often above and left of the first as below and right.
 * Every consumer downstream wants a top-left and a size, and computing
 * that at each of them is how one of them ends up with a negative
 * width and a crop that silently comes back empty.
 */
export function normalizeRect(
  ax: number,
  ay: number,
  bx: number,
  by: number
): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(ax - bx),
    h: Math.abs(ay - by),
  };
}

/**
 * A rectangle drawn on a displayed image, in that image's own pixels.
 *
 * The overlay shows the capture scaled to fit the window, so a drag is
 * in the displayed size and the crop has to happen in the natural one.
 * Clamped to the image, because a drag that leaves the element reports
 * coordinates outside it and a crop starting at -40 comes back with a
 * transparent band down its edge.
 */
export function toNatural(
  rect: Rect,
  shown: { w: number; h: number },
  natural: { w: number; h: number }
): Rect {
  if (shown.w <= 0 || shown.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };

  const sx = natural.w / shown.w;
  const sy = natural.h / shown.h;

  const x = Math.max(0, Math.min(natural.w, Math.round(rect.x * sx)));
  const y = Math.max(0, Math.min(natural.h, Math.round(rect.y * sy)));

  return {
    x,
    y,
    w: Math.max(0, Math.min(natural.w - x, Math.round(rect.w * sx))),
    h: Math.max(0, Math.min(natural.h - y, Math.round(rect.h * sy))),
  };
}

/** A crop too small to be a deliberate one — a click, or a twitch. */
export function isTinyRect(rect: Rect, min = 8): boolean {
  return rect.w < min || rect.h < min;
}

/** Whether this browser can be asked for the screen at all. */
export function canGrabScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/**
 * One frame of whatever the person chose to share.
 *
 * `hide` is the feedback window itself. It goes invisible before the
 * frame is read and comes back after, because a screenshot of the app
 * with the bug report sitting on top of it is a screenshot of the
 * report. `visibility` rather than `display`, so the window does not
 * collapse and reflow the page it is trying to photograph.
 *
 * Two frames are waited for, not one. The first can arrive before the
 * browser has finished compositing the hidden element away, which puts
 * the window in the picture it was hidden for.
 */
export async function grabScreen(hide?: HTMLElement | null): Promise<Blob | null> {
  if (!canGrabScreen()) return null;

  let stream: MediaStream | null = null;
  const previous = hide?.style.visibility ?? "";

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
      // Chrome-only, and harmless where it is not understood: it puts
      // this tab at the top of the picker instead of a list of windows.
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    if (hide) hide.style.visibility = "hidden";
    await nextFrame();
    await nextFrame();

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0) return null;
    ctx.drawImage(video, 0, 0);

    return await toBlob(canvas);
  } catch {
    // A refused picker is a normal answer, not an error to report.
    return null;
  } finally {
    if (hide) hide.style.visibility = previous;
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/** The same image with everything outside `rect` cut away. */
export async function cropBlob(blob: Blob, rect: Rect): Promise<Blob | null> {
  if (rect.w <= 0 || rect.h <= 0) return null;

  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = rect.w;
    canvas.height = rect.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(
      image,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      0,
      0,
      rect.w,
      rect.h
    );
    return await toBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A blob as a File the form can attach.
 *
 * Named with a timestamp rather than "screenshot.png": the form refuses
 * a second file with the same name and size as one already attached, so
 * two shots of the same still screen would collapse into one.
 */
export function shotFile(blob: Blob, kind: "page" | "area"): File {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([blob], `${kind}-${stamp}.png`, { type: "image/png" });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}
