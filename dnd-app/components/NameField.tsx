"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Your display name, saved on blur.
 *
 * Its own component because it is the one field on the settings page
 * that can fail — a blank name is refused by the server — and an inline
 * input with no way to show that would swallow the refusal.
 */
export function NameField({ current }: { current: string | null }) {
  const setMyName = useMutation(api.settings.setMyName);
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeded once. Re-syncing on every change would fight your cursor as
  // the mutation echoes back through the subscription mid-word.
  const seeded = useRef(current !== null);
  useEffect(() => {
    if (seeded.current || current === null) return;
    setValue(current);
    seeded.current = true;
  }, [current]);

  return (
    <div className="name-field">
      <input
        value={value}
        placeholder="Your name"
        aria-label="Your display name"
        maxLength={60}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
          setError(null);
        }}
        onBlur={async () => {
          const next = value.trim();
          if (next === (current ?? "")) return;
          if (next === "") {
            setError("A name cannot be blank.");
            return;
          }
          try {
            await setMyName({ displayName: next });
            setSaved(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save it");
          }
        }}
      />
      {error ? (
        <span className="form-error">{error}</span>
      ) : saved ? (
        <span className="settings-note">Saved</span>
      ) : null}
    </div>
  );
}
