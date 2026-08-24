"use client";

import { useEffect, useState } from "react";
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

/**
 * As many screenshots as one report carries.
 *
 * A cap rather than none, because a failed submission is queued in
 * localStorage with its attachments as data URLs — twenty screenshots
 * would blow the quota, and the quota failing is how a report is lost
 * at the exact moment it could not be sent.
 */
const SHOT_MAX = 6;

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

  // Prefill once the account resolves, without clobbering typing.
  useEffect(() => {
    if (!me) return;
    setName((cur) => cur || me.name || "");
    setEmail((cur) => cur || me.email || "");
  }, [me]);

  // Anything stranded by an earlier failure gets another go on open.
  useEffect(() => {
    setPending(queuedCount());
    void drainQueue().then((sent) => {
      if (sent > 0) setPending(queuedCount());
    });
  }, []);

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

  if (state === "sent") {
    /* One heading, one sentence, one way out.
       It had a "Thanks" heading over a "Thank you!" sentence and a
       Close in the header over a Close button below — a four-line
       window saying two things twice. The heading says what happened,
       the line thanks you once, and the shell's own Close is the only
       Close, which is also the one the form state uses. */
    return (
      <FeedbackShell onClose={onClose} title="Feedback sent">
        <p className="settings-note feedback-sent">
          Thanks — it&apos;s on its way.
        </p>
      </FeedbackShell>
    );
  }

  return (
    <FeedbackShell onClose={onClose} title="Send feedback">
      <form onSubmit={send} className="feedback-form">
        {pending > 0 && (
          <p className="npc-notice">
            {pending} earlier report{pending === 1 ? "" : "s"} still waiting to
            send. They&apos;ll go out automatically when the connection allows.
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
              // Enter on an empty item ends the list instead of adding
              // another empty one, which is the only way out that does
              // not mean deleting the marker by hand.
              if (e.key !== "Enter" || e.shiftKey) return;
              const el = e.currentTarget;
              const caret = el.selectionStart ?? 0;
              // A selection means Enter REPLACES something, which is a
              // different edit from carrying a list on.
              if (caret !== (el.selectionEnd ?? caret)) return;

              const step = continueList(el.value.slice(0, caret));
              if (!step) return;

              e.preventDefault();
              const next = applyContinuation(el.value, caret, step);
              setMessage(next.value);
              // After React has painted the new value: setting the text
              // alone puts the caret at the end of the field, which on a
              // six-line report is nowhere near where you were typing.
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

        <label className="field">
          <span>Screenshots (optional)</span>
          <input
            type="file"
            accept="image/*"
            multiple
            /* Each pick ADDS to what is attached rather than replacing
               it. A file input reports only its own last selection, so
               picking one screenshot and then going back for a second
               silently dropped the first — the box said "1 image
               attached" and the report arrived with the wrong one. The
               input is cleared after each pick so choosing the same
               file twice in a row still fires a change event. */
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (picked.length === 0) return;
              setShots((current) => {
                const merged = [...current];
                for (const file of picked) {
                  // Same name and size, picked twice, is the same
                  // screenshot — attaching it again helps nobody.
                  const already = merged.some(
                    (f) => f.name === file.name && f.size === file.size
                  );
                  if (!already && merged.length < SHOT_MAX) merged.push(file);
                }
                return merged;
              });
            }}
          />
        </label>

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

        {shots.length >= SHOT_MAX && (
          <p className="settings-note">
            {SHOT_MAX} is as many as one report carries. Remove one to
            attach another.
          </p>
        )}

        {error && <p className="form-error">{error}</p>}
        {state === "queued" && (
          <p className="settings-note">
            Saved locally and queued — it will send on the next try, so you
            can close this.
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
    </FeedbackShell>
  );
}

function FeedbackShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="feedback-modal" role="dialog" aria-label={title}>
        <header className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </>
  );
}
