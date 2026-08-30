/**
 * What an invite link is, and when it stops working.
 *
 * The rules live here rather than in the mutation because they are the
 * whole security surface and they are worth testing on their own. An
 * invite is an UNAUTHENTICATED door into a campaign: anyone holding the
 * link is anyone at all until the moment they sign in. So it has three
 * independent ways to die — a clock, a counter, and the GM's hand — and
 * every one of them is checked on the way in, not on the way out.
 *
 * Free of React and Convex so the unit guard can compile it alone.
 */

export const INVITE_LIMITS = {
  /** Days a new link lasts unless the GM says otherwise. */
  defaultDays: 14,
  maxDays: 90,
  /** People a new link admits unless the GM says otherwise. */
  defaultUses: 1,
  maxUses: 50,
  /** Hex characters. 32 is one UUID's worth — 122 bits of randomness. */
  tokenLength: 32,
};

/** Why a link will not let someone in. */
export type InviteProblem = "unknown" | "revoked" | "expired" | "spent";

export interface InviteState {
  expiresAt: number;
  usesLeft: number;
  revokedAt?: number;
}

/**
 * The reason this link is dead, or null if it is alive.
 *
 * Ordered deliberately: revoked beats expired beats spent, so the
 * message names the thing the GM actually did rather than whichever
 * clock ran out first afterwards. A link the GM killed on Monday should
 * not report itself as having expired on Friday.
 */
export function inviteProblem(
  invite: InviteState | null | undefined,
  now: number
): InviteProblem | null {
  if (!invite) return "unknown";
  if (invite.revokedAt !== undefined) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  if (invite.usesLeft <= 0) return "spent";
  return null;
}

/** What to put on the screen for each way in which it failed. */
export function inviteMessage(problem: InviteProblem): string {
  switch (problem) {
    case "revoked":
      return "This invite was cancelled. Ask the GM for a new link.";
    case "expired":
      return "This invite has expired. Ask the GM for a new link.";
    case "spent":
      return "This invite has already been used. Ask the GM for a new link.";
    default:
      // Deliberately the same words as "expired" would get from a token
      // that never existed: telling a stranger which of their guesses
      // was a real campaign is telling them something.
      return "This invite link is not valid. Ask the GM for a new one.";
  }
}

/**
 * A token, from random bytes.
 *
 * Hex rather than base64url so it survives being pasted into a chat
 * client that helpfully "corrects" punctuation, and carries no
 * characters that need escaping in a URL.
 */
export function tokenFrom(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, INVITE_LIMITS.tokenLength);
}

/** Days the GM asked for, held inside what the app will actually issue. */
export function clampDays(days: unknown): number {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n) || n <= 0) return INVITE_LIMITS.defaultDays;
  return Math.min(INVITE_LIMITS.maxDays, n);
}

/** Same, for how many people one link may admit. */
export function clampUses(uses: unknown): number {
  const n = Math.round(Number(uses));
  if (!Number.isFinite(n) || n <= 0) return INVITE_LIMITS.defaultUses;
  return Math.min(INVITE_LIMITS.maxUses, n);
}

/** Epoch ms this link should die at. */
export function expiryFrom(now: number, days: unknown): number {
  return now + clampDays(days) * 24 * 60 * 60 * 1000;
}

/**
 * The link itself.
 *
 * Built from an origin the CALLER supplies rather than a stored one:
 * the app runs on localhost in development and on Vercel in
 * production, and a link baked at creation time would be a link to the
 * wrong host for the rest of its life.
 */
export function inviteUrl(origin: string, token: string): string {
  return `${String(origin ?? "").replace(/\/+$/, "")}/join/${token}`;
}

/** "in 13 days", "today", "3 days ago" — for the GM's list of links. */
export function expiryText(expiresAt: number, now: number): string {
  const days = Math.round((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (expiresAt <= now) return "expired";
  if (days <= 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}
