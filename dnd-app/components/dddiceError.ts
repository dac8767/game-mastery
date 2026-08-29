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

  // Laravel answers a rejected roll with {message, errors:{field:[…]}} in
  // the response BODY, and none of that is on the Error itself — which
  // is how a rejection prints as "{}" and says nothing. The body is
  // where the actual complaint lives.
  const body = (any.response as { data?: unknown } | undefined)?.data;
  if (typeof body === "string" && body) {
    bits.push(body.slice(0, 200));
  } else if (body && typeof body === "object") {
    const data = body as Record<string, unknown>;
    if (typeof data.message === "string" && data.message) bits.push(data.message);
    if (data.errors && typeof data.errors === "object") {
      for (const [field, problems] of Object.entries(
        data.errors as Record<string, unknown>
      )) {
        const first = Array.isArray(problems) ? problems[0] : problems;
        bits.push(`${field}: ${String(first)}`);
      }
    }
  }

  if (status) bits.push(`HTTP ${status}`);
  // An SDK error class with nothing on it still has a NAME, and
  // "RollError" beats "no reason given" by a wide margin.
  if (bits.length === 0) {
    const name = (e as { constructor?: { name?: string } }).constructor?.name;
    if (name && name !== "Object") bits.push(name);
  }
  return bits.length ? bits.join(" — ") : "no reason given";
}

/**
 * The room's background art, as a URL this page can load.
 *
 * dddice stores it as a path, and a path is only half an address. An
 * absolute URL is taken as-is; anything else is resolved against
 * dddice.com. A wrong guess costs nothing visible — the image simply
 * does not paint — so this logs what it tried rather than failing.
 */
function backgroundUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const url = `https://dddice.com/${path.replace(/^\/+/, "")}`;
  console.info("[dice] room background resolved to", url);
  return url;
}
