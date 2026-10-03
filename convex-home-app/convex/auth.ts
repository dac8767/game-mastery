import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Convex Auth — Password provider, household only.
 *
 * There is no public signup page in the UI, but the backend's sign-up
 * flow can be called directly by anyone, and every shared task, note
 * and file is visible to every account. So sign-up is refused unless
 * the email is on the HOUSEHOLD_EMAILS deployment variable:
 *
 *   npx convex env set HOUSEHOLD_EMAILS "you@example.com,partner@example.com"
 *
 * Unset means nobody can register, which is the right failure direction.
 *
 * Emails are trimmed and lower-cased before they become the account id,
 * so `You@Example.com` is the same account rather than a second one.
 * Addresses are not verified, so register both household accounts
 * before deploying anything people rely on — an address on the list
 * belongs to whoever registers it first.
 */
function householdEmails(): string[] {
  return (process.env.HOUSEHOLD_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = String(params.email ?? "").trim().toLowerCase();
        if (params.flow === "signUp" && !householdEmails().includes(email)) {
          throw new Error("Sign-up is limited to this household");
        }
        return { email };
      },
    }),
  ],
});
