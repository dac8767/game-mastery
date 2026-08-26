"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyContinuation,
  continueList,
} from "@/components/listContinue";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  CATEGORIES,
  Category,
  drainQueue,
  queuedCount,
  submitFeedback,
} from "@/components/feedbackClient";
import {
  canGrabScreen,
  cropBlob,
  grabScreen,
  isTinyRect,
  normalizeRect,
  shotFile,
  toNatural,
} from "@/components/screenGrab";
import {
  WinBox,
  clampBox,
  initialBox,
  moveBox,
  resizeBox,
} from "@/components/floatWindow";

/**
 * As many screenshots as one report carries.
 *
 * A cap rather than none, because a failed submission is queued in
 * localStorage with its attachments as data URLs — twenty screenshots
 * would blow the quota, and the quota failing is how a report is lost
 * at the exact moment it could not be sent.
 */
const SHOT_MAX = 6;

/** The size the window opens at, before the screen has its say. */
const WANT_W = 544;
const WANT_H = 560;

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

/**
 * The feedback form.
 *
 * Name and email prefill from the signed-in account rather than asking
 * for a profile — everyone here is already authenticated. They stay
 * editable, since the address you want a reply at isn't always the one
 * you signed up with.
 *
 * A failed submission is queued locally, not lost, and drained the next
 * time the form opens.
 *
 * It is a WINDOW rather than a modal: movable, resizable, and with
 * nothing dimmed behind it, so the screen you are reporting on stays
 * visible and usable while you write about it. That is also what makes
 * the two capture buttons worth having — the thing you want a picture
 * of is still on screen.
 */
export function FeedbackForm({ onClose }: { onClose: () => void }) {
  const me = useQuery(api.settings.me);

  const [category, setCategory] = useState<Category>("Bug Report");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [shots, setShots] = useState<File[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "queued">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  // Whether this browser can be asked for the screen at all. Read once:
  // it cannot change while the form is open, and a value that flips
  // between renders would take the buttons away mid-click.
  const [canGrab] = useState(canGrabScreen);
  const [grabbing, setGrabbing] = useState<null | "page" | "area">(null);
  const [cropping, setCropping] = useState<Blob | null>(null);

  // The window itself, so a capture can hide it. A screenshot of the
  // app with the bug report sitting on top of it is a screenshot of the
  // bug report.
  const windowRef = useRef<HTMLDivElement>(null);

  // Prefill once the account resolves, without clobbering typing.
  useEffect(() => {
    if (!me) return;
    setName((cur) => cur || me.name || "");
    setEmail((cur) => cur || me.email || "");
  }, [me]);

  /**
   * The thank-you closes itself. Two seconds is long enough to read
   * one sentence and short enough that nobody reaches for the Close
   * button first — which stays, for whoever does.
   *
   * The timer is cleared if the state changes out of "sent" or the
   * form unmounts: a timeout that survives its window closes whatever
   * REPLACED the window two seconds later.
   */
  useEffect(() => {
    if (state !== "sent") return;
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [state, onClose]);

  // Anything stranded by an earlier failure gets another go on open.
  useEffect(() => {
    setPending(queuedCount());
    void drainQueue().then((sent) => {
      if (sent > 0) setPending(queuedCount());
    });
  }, []);

  /**
   * The one way a screenshot gets onto the report.
   *
   * The file picker, the page capture and the area capture all come
   * through here, so the cap and the duplicate check apply to all
   * three. When the capture buttons were wired straight to `setShots`
   * they were the one path that could go past six.
   */
  const addShots = useCallback((picked: File[]) => {
    if (picked.length === 0) return;
    setShots((current) => {
      const merged = [...current];
      for (const file of picked) {
        // Same name and size, twice, is the same screenshot — attaching
        // it again helps nobody. Captures are named with the moment
        // they were taken for exactly this reason.
        const already = merged.some(
          (f) => f.name === file.name && f.size === file.size
        );
        if (!already && merged.length < SHOT_MAX) merged.push(file);
      }
      return merged;
    });
  }, []);

  /**
   * Ask for the screen, and either attach it or hand it to the cropper.
   *
   * A `null` back from `grabScreen` means the share picker was
   * dismissed, which is an answer rather than a failure — nothing is
   * said about it.
   */
  async function capture(kind: "page" | "area") {
    setGrabbing(kind);
    try {
      const blob = await grabScreen(windowRef.current);
      if (!blob) return;
      if (kind === "page") addShots([shotFile(blob, "page")]);
      else setCropping(blob);
    } finally {
      setGrabbing(null);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim()) {
      setError("Say what happened first.");
      return;
    }
    setState("sending");
    setError(null);
    try {
      await submitFeedback(
        {
          category,
          message: message.trim(),
          name: name.trim(),
          email: email.trim(),
        },
        shots
      );
      setState("sent");
    } catch (err) {
      // submitFeedback queues before it throws, so nothing is lost.
      setState("queued");
      setPending(queuedCount());
      setError(err instanceof Error ? err.message : "The submission failed.");
    }
  }

  const full = shots.length >= SHOT_MAX;

  return (
    <>
      <FeedbackShell
        onClose={onClose}
        windowRef={windowRef}
        title={state === "sent" ? "Feedback sent" : "Send feedback"}
        /* The thank-you is one sentence, and it inherited the size of
           the form somebody may have grown to write a long report —
           reported as a huge window of blank space. Shrunk to its
           content, in place, and back to full size if another report
           is started from the same window. */
        shrink={state === "sent"}
      >
        {/* One heading, one sentence, one way out. It had a "Thanks"
            heading over a "Thank you!" sentence and a Close in the
            header over a Close button below — a four-line window saying
            two things twice. The shell's own Close is the only Close.
            The shell stays MOUNTED across the send, so a window you
            moved and sized does not jump back to the middle to tell you
            it worked. */}
        {state === "sent" ? (
          <p className="settings-note feedback-sent">
            Thanks — it&apos;s on its way.
          </p>
        ) : (
          <form onSubmit={send} className="feedback-form">
            {pending > 0 && (
              <p className="npc-notice">
                {pending} earlier report{pending === 1 ? "" : "s"} still waiting
                to send. They&apos;ll go out automatically when the connection
                allows.
              </p>
            )}

            <label className="field">
              <span>Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>What happened?</span>
              <textarea
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What you did, what you expected, what happened instead."
                onKeyDown={(e) => {
                  // "1. the toolbar is wrong" + Enter gives you "2. ".
                  // Enter on an empty item ends the list instead of
                  // adding another empty one, which is the only way out
                  // that does not mean deleting the marker by hand.
                  if (e.key !== "Enter" || e.shiftKey) return;
                  const el = e.currentTarget;
                  const caret = el.selectionStart ?? 0;
                  // A selection means Enter REPLACES something, which
                  // is a different edit from carrying a list on.
                  if (caret !== (el.selectionEnd ?? caret)) return;

                  const step = continueList(el.value.slice(0, caret));
                  if (!step) return;

                  e.preventDefault();
                  const next = applyContinuation(el.value, caret, step);
                  setMessage(next.value);
                  // After React has painted the new value: setting the
                  // text alone puts the caret at the end of the field,
                  // which on a six-line report is nowhere near where
                  // you were typing.
                  requestAnimationFrame(() => {
                    el.selectionStart = next.caret;
                    el.selectionEnd = next.caret;
                  });
                }}
              />
            </label>

            <div className="field-row">
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            </div>

            {/* A div rather than a label, now that there are buttons in
                here: everything inside a label is a click on the label,
                so "Capture the page" would ALSO open the file picker. */}
            <div className="field">
              <span>Screenshots (optional)</span>
              <input
                type="file"
                accept="image/*"
                multiple
                /* Each pick ADDS to what is attached rather than
                   replacing it. A file input reports only its own last
                   selection, so picking one screenshot and then going
                   back for a second silently dropped the first — the
                   box said "1 image attached" and the report arrived
                   with the wrong one. The input is cleared after each
                   pick so choosing the same file twice in a row still
                   fires a change event. */
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  addShots(picked);
                }}
              />

              {canGrab && (
                <>
                  <div className="feedback-grabs">
                    <button
                      type="button"
                      className="npc-btn"
                      disabled={grabbing !== null || full}
                      onClick={() => void capture("page")}
                    >
                      {grabbing === "page" ? "Capturing…" : "Capture the page"}
                    </button>
                    <button
                      type="button"
                      className="npc-btn"
                      disabled={grabbing !== null || full}
                      onClick={() => void capture("area")}
                    >
                      {grabbing === "area" ? "Capturing…" : "Capture an area"}
                    </button>
                  </div>
                  <p className="settings-note">
                    The browser asks which screen or tab to share — this
                    window is left out of the picture either way.
                  </p>
                </>
              )}
            </div>

            {shots.length > 0 && (
              <ul className="feedback-shots">
                {shots.map((file, i) => (
                  <li key={`${file.name}-${file.size}-${i}`}>
                    <span className="feedback-shot-name">{file.name}</span>
                    <button
                      type="button"
                      className="text-button"
                      title="Take this one off the report"
                      onClick={() =>
                        setShots((current) => current.filter((_, j) => j !== i))
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {full && (
              <p className="settings-note">
                {SHOT_MAX} is as many as one report carries. Remove one to
                attach another.
              </p>
            )}

            {error && <p className="form-error">{error}</p>}
            {state === "queued" && (
              <p className="settings-note">
                Saved locally and queued — it will send on the next try, so
                you can close this.
              </p>
            )}

            <div className="feedback-actions">
              <button type="button" className="text-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="npc-btn primary"
                disabled={state === "sending"}
              >
                {state === "sending" ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </FeedbackShell>

      {cropping && (
        <AreaPicker
          source={cropping}
          onCancel={() => setCropping(null)}
          onPick={(file) => {
            addShots([file]);
            setCropping(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The frame: a window rather than a modal.
 *
 * No scrim. A dimmed page is a page you cannot read, and the whole
 * point of this form is that you are describing something on the screen
 * behind it — often while still clicking around in it. What a scrim
 * normally provides is the sense of floating above the page, so the
 * shadow does that job instead.
 *
 * Dragging works off the box the drag STARTED from plus the pointer's
 * total travel, never the previous position plus a step, so a drag into
 * an edge and back out lands the window under the hand rather than
 * short of it.
 */
function FeedbackShell({
  title,
  children,
  onClose,
  windowRef,
  shrink = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  windowRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Fit the window to its content instead of the dragged size.
   *
   * The POSITION is kept — the window stays where it was put, only the
   * box tightens around what is left in it. The dragged size is kept
   * too, untouched underneath, so this is not a resize the person has
   * to undo afterwards.
   */
  shrink?: boolean;
}) {
  const [box, setBox] = useState<WinBox>(() =>
    typeof window === "undefined"
      ? { x: 0, y: 0, w: WANT_W, h: WANT_H }
      : initialBox(viewport(), { w: WANT_W, h: WANT_H })
  );

  // Held in a ref rather than state: it changes on every pointer move
  // and nothing renders from it, and re-rendering the form on each
  // mousemove is how a drag turns into a stutter.
  const drag = useRef<
    null | { mode: "move" | "size"; x: number; y: number; from: WinBox }
  >(null);

  // A window parked at the right edge of a wide browser is off the side
  // of a narrow one, with no title bar to drag it back by.
  useEffect(() => {
    const onResize = () => setBox((cur) => clampBox(cur, viewport()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const begin = (mode: "move" | "size") => (e: React.PointerEvent) => {
    // A press on the Close button is a press on the button.
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, from: box };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const view = viewport();
    setBox(
      d.mode === "move"
        ? moveBox(d.from, dx, dy, view)
        : resizeBox(d.from, dx, dy, view)
    );
  };

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="feedback-modal"
      role="dialog"
      aria-label={title}
      ref={windowRef}
      style={
        shrink
          ? { left: box.x, top: box.y, width: "22rem", height: "auto" }
          : { left: box.x, top: box.y, width: box.w, height: box.h }
      }
    >
      <header
        className="drawer-header feedback-grip"
        onPointerDown={begin("move")}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <h2>{title}</h2>
        <button type="button" className="text-button" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="feedback-body">{children}</div>

      {/* No corner grip on the shrunk window: it is sized to one
          sentence, and a handle would resize a box that snaps back
          the moment the form returns. */}
      {!shrink && (
        <span
          className="feedback-resize"
          title="Drag to resize"
          onPointerDown={begin("size")}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
    </div>
  );
}

/**
 * Draw a rectangle on the captured picture to keep just that part.
 *
 * The crop happens on the IMAGE, after the capture, not on the live
 * page before it: the share picker interrupts whatever you were doing,
 * so a rectangle drawn first would be a rectangle drawn on a page that
 * has since scrolled. This way what you cut out is exactly what was
 * photographed.
 *
 * The drag is tracked in the viewport's own coordinates and the
 * marquee drawn with `position: fixed`, so the rectangle needs no
 * knowledge of where the image sits inside the overlay. Only the crop
 * itself converts, and it converts once.
 */
function AreaPicker({
  source,
  onCancel,
  onPick,
}: {
  source: Blob;
  onCancel: () => void;
  onPick: (file: File) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [drag, setDrag] = useState<
    null | { ax: number; ay: number; bx: number; by: number }
  >(null);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const made = URL.createObjectURL(source);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const marquee = drag
    ? normalizeRect(drag.ax, drag.ay, drag.bx, drag.by)
    : null;

  async function finish() {
    const img = image.current;
    setDrag(null);
    if (!img || !drag) return;

    const shown = img.getBoundingClientRect();
    const local = normalizeRect(
      drag.ax - shown.left,
      drag.ay - shown.top,
      drag.bx - shown.left,
      drag.by - shown.top
    );
    // A click, or a twitch. Clearing the drag and staying open is the
    // right answer — cropping a 3px square would attach a blank tile,
    // and closing would make a mis-click throw the capture away.
    if (isTinyRect(local)) return;

    const cut = toNatural(
      local,
      { w: shown.width, h: shown.height },
      { w: img.naturalWidth, h: img.naturalHeight }
    );
    const cropped = await cropBlob(source, cut);
    if (cropped) onPick(shotFile(cropped, "area"));
  }

  return (
    <div className="shot-picker">
      <div className="shot-picker-bar">
        <span>Drag to choose the part you want.</span>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div
        className="shot-picker-frame"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({
            ax: e.clientX,
            ay: e.clientY,
            bx: e.clientX,
            by: e.clientY,
          });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          setDrag((d) => (d ? { ...d, bx: e.clientX, by: e.clientY } : d));
        }}
        onPointerUp={() => void finish()}
        onPointerCancel={() => setDrag(null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url && <img ref={image} src={url} alt="The captured screen" />}
      </div>

      {marquee && (
        <div
          className="shot-picker-rect"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.w,
            height: marquee.h,
          }}
        />
      )}
    </div>
  );
}
