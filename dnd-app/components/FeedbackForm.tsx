"use client";

import { useEffect, useState } from "react";
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
    return (
      <FeedbackShell onClose={onClose} title="Thanks">
        <p className="settings-note">
          Sent. It lands in Derek&apos;s queue tagged <strong>Game Mastery</strong>.
        </p>
        <button type="button" className="npc-btn primary" onClick={onClose}>
          Close
        </button>
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
            onChange={(e) => setShots(Array.from(e.target.files ?? []))}
          />
        </label>

        {shots.length > 0 && (
          <p className="settings-note">
            {shots.length} image{shots.length === 1 ? "" : "s"} attached.
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
