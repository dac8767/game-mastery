"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

/**
 * Email + password sign-in (Convex Auth Password provider).
 *
 * "Create account" exists so the 11 players can register themselves once
 * before the DM adds them to a campaign by email. After everyone is in,
 * you can hide the toggle (or add an email allowlist in convex/auth.ts)
 * to shut the door.
 */
export function SignInForm() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="signin-wrap">
      <div className="signin-card">
        <h1>Table View</h1>
        <p className="subtitle">Sign in to see the table.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setPending(true);
            const formData = new FormData(event.currentTarget);
            formData.set("flow", flow);
            try {
              await signIn("password", formData);
            } catch {
              setError(
                flow === "signIn"
                  ? "Wrong email or password."
                  : "Couldn't create that account — is it already registered?"
              );
              setPending(false);
            }
          }}
        >
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={
              flow === "signIn" ? "current-password" : "new-password"
            }
            required
          />
          {error && <p className="form-error">{error}</p>}
          <button className="submit" type="submit" disabled={pending}>
            {flow === "signIn" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          type="button"
          className="text-button flow-toggle"
          onClick={() => {
            setFlow(flow === "signIn" ? "signUp" : "signIn");
            setError(null);
          }}
        >
          {flow === "signIn"
            ? "First time? Create an account"
            : "Already registered? Sign in"}
        </button>
      </div>
    </div>
  );
}
