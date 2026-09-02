"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";
import { UndoKeys } from "@/components/UndoKeys";

/**
 * Client-side Convex + auth provider.
 *
 * The whole app is client-rendered (every screen is a live subscription
 * anyway), so we use the plain React ConvexAuthProvider rather than the
 * Next.js server integration — no middleware, no server tokens, fewer
 * moving parts to drift between versions.
 */
export function Providers({ children }: { children: ReactNode }) {
  const convex = useMemo(
    () => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string),
    []
  );
  return (
    <ConvexAuthProvider client={convex}>
      {children}
      {/* Cmd+Z on every screen, campaign list included. */}
      <UndoKeys />
    </ConvexAuthProvider>
  );
}
