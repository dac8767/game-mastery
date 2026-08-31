import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

// Convex Auth serves its token endpoints over HTTP actions; without this
// router the Password provider can't complete sign-in.
const http = httpRouter();

auth.addHttpRoutes(http);

/* ---------- the session recorder's way in --------------------------
 *
 * The home server transcribes a recording and posts the result here.
 * It is not a signed-in user and cannot become one, so these three
 * routes are authenticated by a shared secret instead — the same
 * arrangement, and the same care, as any webhook.
 *
 * The secret is a header, never a query parameter: a URL ends up in
 * access logs, in a proxy's history, and in whatever Cloudflare keeps.
 *
 * These write TRANSCRIPTS, and only ever to a recording that already
 * exists and was created by a signed-in GM. There is no route here that
 * creates a recording, and none that reads one — a leaked ingest secret
 * would let someone corrupt a transcript, which is bad, and not let
 * them read one, which would be worse.
 */

/** Timing-safe enough for a fixed-length secret compared once per POST. */
function secretOk(header: string | null): boolean {
  const expected = process.env.RECORDER_INGEST_SECRET;
  if (typeof expected !== "string" || expected.trim() === "") return false;
  if (typeof header !== "string") return false;
  const a = header.trim();
  const b = expected.trim();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Check the secret, read the body, and find the recording.
 *
 * One helper for all three routes so a new one cannot be added that
 * checks the secret and forgets to check that the id names something —
 * which would turn a typo on the home server into a 500 and a retry
 * loop rather than the 404 that makes it stop.
 */
async function open(
  ctx: { runQuery: any },
  request: Request
): Promise<
  | { ok: true; body: Record<string, unknown>; recordingId: any }
  | { ok: false; response: Response }
> {
  if (!secretOk(request.headers.get("x-recorder-secret"))) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, response: json({ error: "bad json" }, 400) };
  }
  const id = body.recordingId;
  if (typeof id !== "string") {
    return { ok: false, response: json({ error: "no recordingId" }, 400) };
  }
  const found = await ctx.runQuery(internal.recorder.forIngest, {
    recordingId: id,
  });
  if (!found) {
    return { ok: false, response: json({ error: "no such recording" }, 404) };
  }
  return { ok: true, body, recordingId: found._id };
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

http.route({
  path: "/recorder/begin",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const opened = await open(ctx, request);
    if (!opened.ok) return opened.response;
    await ctx.runMutation(internal.recorder.ingestBegin, {
      recordingId: opened.recordingId,
      audioKey: optionalString(opened.body.audioKey),
    });
    return json({ ok: true }, 200);
  }),
});

http.route({
  path: "/recorder/transcript",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const opened = await open(ctx, request);
    if (!opened.ok) return opened.response;
    const duration = opened.body.durationSec;
    const stored = await ctx.runMutation(internal.recorder.ingestTranscript, {
      recordingId: opened.recordingId,
      // Unvalidated on purpose: cleanSegments in
      // components/recorderModel.ts is what shapes this, and it is the
      // one place that decides what a malformed segment becomes. A
      // validator here would reject the whole POST over one bad row.
      segments: opened.body.segments,
      language: optionalString(opened.body.language),
      durationSec:
        typeof duration === "number" && Number.isFinite(duration)
          ? duration
          : undefined,
      audioKey: optionalString(opened.body.audioKey),
    });
    return json({ ok: true, segments: stored }, 200);
  }),
});

http.route({
  path: "/recorder/failed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const opened = await open(ctx, request);
    if (!opened.ok) return opened.response;
    await ctx.runMutation(internal.recorder.ingestFailed, {
      recordingId: opened.recordingId,
      error: optionalString(opened.body.error) ?? "The home server gave up.",
    });
    return json({ ok: true }, 200);
  }),
});

export default http;
