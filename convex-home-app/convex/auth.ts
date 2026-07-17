import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Convex Auth — Password provider.
 *
 * For a two-person household app, email + password is the simplest setup
 * with zero third-party dependencies. You and your wife each create one
 * account; there is no public signup page in the UI, so nobody else can
 * register even though the backend technically allows it. If you want to
 * be strict, add an allowlist check in the Password provider's `profile`
 * callback, or swap in a Google OAuth provider later — Convex Auth makes
 * either a small change.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
