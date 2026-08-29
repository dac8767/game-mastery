/**
 * Reading a dddice failure back.
 *
 * Pure, and in its own module, because getting this wrong is invisible
 * in the worst way: the integration keeps working, and only the
 * DIAGNOSTIC is broken. The first version printed a rejected roll as
 * "{}" — the SDK had handed it an object with no message and no
 * status, and the complaint was in the response body all along.
 *
 * A message nobody can act on costs a round trip every time something
 * goes wrong, so these two get tested like anything else.
 */

/**
 * Whatever the thing that failed had to say for itself.
 *
 * dddice's errors are not all Error instances — the SDK throws its own
 * APIError types and axios-shaped rejections — and `String(e)` on one
 * of those is "[object Object]", which is how a diagnosable failure
 * turns into an unactionable one.
 */
export function statusOf(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const any = e as Record<string, unknown>;
  if (typeof any.status === "number") return any.status;
  const response = any.response as { status?: number } | undefined;
  return typeof response?.status === "number" ? response.status : null;
}

export function reason(e: unknown): string {
  if (typeof e === "string") return e;
  if (!e || typeof e !== "object") return "no reason given";

  const any = e as Record<string, unknown>;
  const status = statusOf(e);
  const bits: string[] = [];

  if (typeof any.message === "string" && any.message) bits.push(any.message);

  // Anything learned from the BODY is tracked separately from the
  // error's own message, and that separation is the whole point.
  //
  // axios always sets a message — "Request failed with status code
  // 422" — so a check for "did we find anything at all" is always
  // satisfied before the body is ever looked at, and the body is
  // where the server says what was actually wrong. Three messages in
  // a row identified one failure as "422" and nothing else for
  // exactly this reason.
  const body = (any.response as { data?: unknown } | undefined)?.data;
  const fromBody: string[] = [];

  if (typeof body === "string" && body) {
    fromBody.push(body.slice(0, 200));
  } else if (body && typeof body === "object") {
    const data = body as Record<string, unknown>;
    if (typeof data.message === "string" && data.message) {
      fromBody.push(data.message);
    }
    if (data.errors && typeof data.errors === "object") {
      for (const [field, problems] of Object.entries(
        data.errors as Record<string, unknown>
      )) {
        const first = Array.isArray(problems) ? problems[0] : problems;
        fromBody.push(`${field}: ${String(first)}`);
      }
    }
    // A body whose shape was guessed wrong is printed as it came. A
    // reader that only understands the shapes it expects goes blind
    // exactly when it is needed.
    if (fromBody.length === 0) {
      try {
        const dumped = JSON.stringify(body);
        if (dumped && dumped !== "{}" && dumped !== "null") {
          fromBody.push(dumped.slice(0, 300));
        }
      } catch {
        // A body that will not serialise is one more thing to survive.
      }
    }
  }

  bits.push(...fromBody);
  if (status) bits.push(`HTTP ${status}`);

  // An SDK error class with nothing on it still has a NAME, and
  // "RollError" beats "no reason given" by a wide margin.
  if (bits.length === 0) {
    const name = (e as { constructor?: { name?: string } }).constructor?.name;
    if (name && name !== "Object") bits.push(name);
  }
  return bits.length ? bits.join(" — ") : "no reason given";
}
