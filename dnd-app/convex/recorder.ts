import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireDm } from "./auth";
import {
  MAX_SEGMENTS,
  MAX_SPEAKERS,
  SUMMARY_SECTIONS,
  chunkSegments,
  cleanSegments,
  cleanSpeakers,
  cleanSummary,
  cleanTitle,
  formatClock,
  isUploadUrl,
  joinChunks,
  speakerName,
  speakerTags,
  toTurns,
  transcriptText,
} from "../components/recorderModel";

/**
 * Recording, transcribing and summarizing a night at the table.
 *
 * GM-only, in the same strong sense convex/todo.ts is: every function
 * here goes through requireDm and there is no player-facing shape of a
 * transcript. A recording of a session contains everything the GM said
 * at the table INCLUDING the parts said to one player while the others
 * were out of the room, and everything said between players who
 * thought the recorder was for the fight scene. There is no filtered
 * version of that; there is only "the GM has it".
 *
 * Three pieces of infrastructure, and the boundaries between them are
 * the whole design:
 *
 *   browser ──chunks──► home server ──transcript──► Convex ──► Claude
 *
 * - The AUDIO never enters Convex. Free-tier file storage is a
 *   gigabyte and one session is sixty megabytes; more to the point,
 *   transcribing four hours cannot happen inside a Convex action's
 *   time limit however it is stored. It goes to the PowerEdge, which
 *   already serves the battle maps, has the disk, and can take as long
 *   as it likes.
 * - The TRANSCRIPT comes back over an HTTP action authenticated by a
 *   shared secret, because the home server is not a signed-in user and
 *   never will be.
 * - The SUMMARY is the only paid step, and it is opt-in per recording.
 *   A transcript with no summary is a finished, useful thing.
 *
 * The browser is never given either secret. It gets a TICKET: an HMAC
 * over one recording id and an expiry, minted here, verified by the
 * home server. It grants uploading and deleting one recording's audio
 * and nothing else, and it stops working the next morning.
 */

/* ---------- configuration ----------------------------------------- */

/** Where the home server answers. `npx convex env set RECORDER_UPLOAD_URL`. */
const UPLOAD_URL = "RECORDER_UPLOAD_URL";
/** Shared with the home server; signs upload tickets. Never leaves here. */
const UPLOAD_SECRET = "RECORDER_UPLOAD_SECRET";
/** Shared with the home server; authenticates the transcript coming back. */
const INGEST_SECRET = "RECORDER_INGEST_SECRET";
/** The summarizer's key. Absent means the summary button explains itself. */
const API_KEY = "ANTHROPIC_API_KEY";
/** Overridable so a cheaper model can be tried without a deploy. */
const SUMMARY_MODEL = "RECORDER_SUMMARY_MODEL";

const DEFAULT_MODEL = "claude-opus-5";

/**
 * How long an upload ticket lasts.
 *
 * Twelve hours: long enough that a session which starts at seven and
 * runs past midnight uploads its last chunk on the same ticket, short
 * enough that one left in a browser's memory is useless by the next
 * game. It is scoped to a single recording id either way.
 */
const TICKET_SECONDS = 12 * 60 * 60;

/**
 * The most transcript one summary request will carry, in characters.
 *
 * Half a million is around ten hours of people talking — past any real
 * session, and comfortably inside the model's context. Past it, the
 * request is truncated and the notes SAY they are truncated, because a
 * recap that quietly stops two hours early is worse than no recap.
 */
const MAX_PROMPT_CHARS = 500000;

function env(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* ---------- tickets ------------------------------------------------ */

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * A ticket the home server can check without asking us anything.
 *
 * `<recordingId>.<expiry>.<hmac>`, where the HMAC covers the first two
 * parts. Stateless on purpose: a chunk arrives every thirty seconds
 * for four hours, and a design where each one costs a round trip back
 * to Convex to be authorised is a design that bills for four hundred
 * function calls per session and stops uploading when the internet
 * hiccups.
 */
async function mintTicket(recordingId: string, secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + TICKET_SECONDS;
  const payload = `${recordingId}.${expires}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${hex(sig)}`;
}

/* ---------- reading ------------------------------------------------ */

/**
 * Whether the tool can record at all, and if not, what is missing.
 *
 * A query rather than something the component works out, because the
 * answer is three environment variables the browser must never see the
 * values of. It sees only which ones are set — which is what turns a
 * dead Record button into a screen that says the sentence Derek needs
 * to read.
 */
export const getConfig = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const url = env(UPLOAD_URL);
    return {
      /** Set, and a URL this app is willing to post audio to. */
      uploadReady: isUploadUrl(url) && env(UPLOAD_SECRET) !== null,
      /** Set but rejected — almost always a missing "s" in "https". */
      uploadUrlBad: url !== null && !isUploadUrl(url),
      ingestReady: env(INGEST_SECRET) !== null,
      /** Whether a summary can be written, rather than what the key is. */
      summaryReady: env(API_KEY) !== null,
      summaryModel: env(SUMMARY_MODEL) ?? DEFAULT_MODEL,
    };
  },
});

/**
 * The campaign's recordings, newest first, without their transcripts.
 *
 * `summary` is left out here and `hasSummary` sent instead. The list is
 * a live subscription and the notes are the biggest thing on the row;
 * sending every recording's notes to draw a list of dates means one
 * rename re-sends the lot.
 */
export const listRecordings = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const rows = await ctx.db
      .query("recordings")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    return rows
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({
        _id: r._id,
        title: r.title,
        status: r.status,
        error: r.error ?? null,
        startedAt: r.startedAt,
        durationSec: r.durationSec ?? null,
        bytes: r.bytes ?? null,
        segmentCount: r.segmentCount ?? null,
        sessionId: r.sessionId ?? null,
        hasSummary: r.summary !== undefined,
      }));
  },
});

/**
 * One recording with its whole transcript.
 *
 * Every chunk in one read: the screen shows the transcript as a
 * scrollable whole and searches it in the browser, so paginating here
 * would only move the joining somewhere less convenient. The rows are
 * sized so that a four-hour session is a few dozen of them.
 */
export const getRecording = query({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const rec = await ctx.db.get(args.recordingId);
    // Addressed by row, authorised by the ROW's campaign — a recording
    // id from one campaign handed to another campaign's GM is not this
    // campaign's data to serve.
    if (!rec || rec.campaignId !== args.campaignId) return null;

    const chunks = await ctx.db
      .query("transcriptChunks")
      .withIndex("by_recording", (q) => q.eq("recordingId", rec._id))
      .collect();

    return {
      recording: {
        _id: rec._id,
        title: rec.title,
        status: rec.status,
        error: rec.error ?? null,
        startedAt: rec.startedAt,
        durationSec: rec.durationSec ?? null,
        bytes: rec.bytes ?? null,
        audioKey: rec.audioKey ?? null,
        speakers: rec.speakers ?? {},
        segmentCount: rec.segmentCount ?? null,
        language: rec.language ?? null,
        summary: rec.summary ?? null,
        summaryModel: rec.summaryModel ?? null,
        summarizedAt: rec.summarizedAt ?? null,
        sessionId: rec.sessionId ?? null,
      },
      segments: joinChunks(chunks),
    };
  },
});

/* ---------- starting one ------------------------------------------- */

/**
 * The row, and the authority check for the action that opens it.
 *
 * requireDm belongs HERE rather than in startRecording, even though
 * startRecording is the public door: an action reaches the database
 * only through calls like this one, and the identity travels with the
 * call. Checking in the action and not in the mutation would mean the
 * check and the write were in different places, which is how one of
 * them ends up being the one that got refactored.
 */
export const create = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    title: v.string(),
    startedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    return await ctx.db.insert("recordings", {
      campaignId: args.campaignId,
      title: cleanTitle(args.title),
      status: "recording",
      startedAt: args.startedAt,
    });
  },
});

/**
 * Open a recording and hand back everything the browser needs to send
 * audio to the home server.
 *
 * An action rather than a mutation because minting the ticket is a
 * crypto.subtle call, and because the row has to exist before the id
 * can be signed. requireDm runs inside the mutation it calls, so the
 * authority check is still on the database side of the boundary.
 */
export const startRecording = action({
  args: {
    campaignId: v.id("campaigns"),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    recordingId: Id<"recordings">;
    uploadUrl: string;
    ticket: string;
  }> => {
    const url = env(UPLOAD_URL);
    const secret = env(UPLOAD_SECRET);
    if (!isUploadUrl(url) || !secret) {
      throw new Error(
        "The recorder is not configured. Set RECORDER_UPLOAD_URL and RECORDER_UPLOAD_SECRET on the Convex deployment."
      );
    }

    const recordingId: Id<"recordings"> = await ctx.runMutation(
      internal.recorder.create,
      {
        campaignId: args.campaignId,
        title: args.title ?? "",
        startedAt: Date.now(),
      }
    );

    return {
      recordingId,
      uploadUrl: url as string,
      ticket: await mintTicket(recordingId, secret),
    };
  },
});

/**
 * The browser stopped, and says how much it sent.
 *
 * Status goes to `queued` rather than `transcribing`: the home server
 * decides when it starts, and claiming otherwise from the browser
 * would show a spinner for work nothing has begun.
 */
export const finishUpload = mutation({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
    durationSec: v.number(),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await requireDm(ctx, rec.campaignId);
    await ctx.db.patch(rec._id, {
      status: "queued",
      durationSec: Math.max(0, Math.round(args.durationSec)),
      bytes: Math.max(0, Math.round(args.bytes)),
      error: undefined,
    });
  },
});

/** The browser gave up — a refused microphone, a failed upload, a crash. */
export const markFailed = mutation({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await requireDm(ctx, rec.campaignId);
    await ctx.db.patch(rec._id, {
      status: "failed",
      error: args.error.slice(0, 500),
    });
  },
});

/* ---------- editing one -------------------------------------------- */

export const rename = mutation({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await requireDm(ctx, rec.campaignId);
    await ctx.db.patch(rec._id, { title: cleanTitle(args.title) });
  },
});

/**
 * Put names to WhisperX's voices.
 *
 * The whole map is written at once rather than one tag at a time, and
 * it is cleaned against the tags this recording actually contains —
 * so a name cannot be stored for a speaker who is not in it, and the
 * row cannot grow keys from a stale form.
 */
export const setSpeakers = mutation({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
    speakers: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await requireDm(ctx, rec.campaignId);

    const chunks = await ctx.db
      .query("transcriptChunks")
      .withIndex("by_recording", (q) => q.eq("recordingId", rec._id))
      .collect();
    const tags = speakerTags(joinChunks(chunks)).slice(0, MAX_SPEAKERS);

    await ctx.db.patch(rec._id, {
      speakers: cleanSpeakers(args.speakers, tags),
    });
  },
});

/** Tie a recording to the session in the log that it is a recording of. */
export const linkSession = mutation({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
    sessionId: v.union(v.id("sessions"), v.null()),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await requireDm(ctx, rec.campaignId);

    if (args.sessionId === null) {
      await ctx.db.patch(rec._id, { sessionId: undefined });
      return;
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.campaignId !== rec.campaignId) {
      throw new Error("That session is not in this campaign");
    }
    await ctx.db.patch(rec._id, { sessionId: session._id });
  },
});

/** The rows. The audio on the home server is `removeAudio`'s problem. */
export const removeRows = internalMutation({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("transcriptChunks")
      .withIndex("by_recording", (q) => q.eq("recordingId", args.recordingId))
      .collect();
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    await ctx.db.delete(args.recordingId);
  },
});

/** Check the caller may delete this, and say what the audio file is called. */
export const beforeDelete = internalQuery({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec || rec.campaignId !== args.campaignId) {
      throw new Error("Recording not found");
    }
    await requireDm(ctx, rec.campaignId);
    return { audioKey: rec.audioKey ?? null };
  },
});

/**
 * Delete a recording, its transcript, and its audio.
 *
 * An action because the audio is on another machine. The home server
 * is told first and the rows go whether or not it answered: a server
 * that is off must not make "delete this" fail, or the only way to
 * clear a bad recording is to wait for the PowerEdge to come back. The
 * server's own retention sweep catches an orphaned file either way.
 */
export const deleteRecording = action({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
  },
  handler: async (ctx, args): Promise<null> => {
    const { audioKey }: { audioKey: string | null } = await ctx.runQuery(
      internal.recorder.beforeDelete,
      args
    );

    const url = env(UPLOAD_URL);
    const secret = env(UPLOAD_SECRET);
    if (audioKey && isUploadUrl(url) && secret) {
      try {
        const ticket = await mintTicket(args.recordingId, secret);
        await fetch(
          `${(url as string).replace(/\/+$/, "")}/recording/${args.recordingId}`,
          { method: "DELETE", headers: { "x-recorder-ticket": ticket } }
        );
      } catch (e) {
        console.warn("[recorder] could not delete the audio on the server", e);
      }
    }

    await ctx.runMutation(internal.recorder.removeRows, {
      recordingId: args.recordingId,
    });
    return null;
  },
});

/* ---------- the transcript arriving -------------------------------- */

/**
 * The home server says it has started.
 *
 * Also clears any transcript already stored, because this is what a
 * re-run posts: transcribing the same recording twice must replace the
 * transcript rather than appending a second copy of it.
 */
export const ingestBegin = internalMutation({
  args: {
    recordingId: v.id("recordings"),
    audioKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    const chunks = await ctx.db
      .query("transcriptChunks")
      .withIndex("by_recording", (q) => q.eq("recordingId", rec._id))
      .collect();
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    await ctx.db.patch(rec._id, {
      status: "transcribing",
      error: undefined,
      audioKey: args.audioKey ?? rec.audioKey,
      segmentCount: undefined,
    });
  },
});

/**
 * The transcript itself, stored in rows.
 *
 * One mutation for the whole thing: a transcript arrives complete or
 * not at all, and writing it in pieces across several calls would
 * leave a half-transcript readable on screen if the second call failed.
 */
export const ingestTranscript = internalMutation({
  args: {
    recordingId: v.id("recordings"),
    segments: v.any(),
    language: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    audioKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");

    const segments = cleanSegments(args.segments, MAX_SEGMENTS);

    const old = await ctx.db
      .query("transcriptChunks")
      .withIndex("by_recording", (q) => q.eq("recordingId", rec._id))
      .collect();
    for (const chunk of old) await ctx.db.delete(chunk._id);

    const chunks = chunkSegments(segments);
    for (let i = 0; i < chunks.length; i++) {
      await ctx.db.insert("transcriptChunks", {
        campaignId: rec.campaignId,
        recordingId: rec._id,
        index: i,
        segments: chunks[i],
      });
    }

    await ctx.db.patch(rec._id, {
      status: "transcribed",
      error: undefined,
      segmentCount: segments.length,
      language: args.language,
      audioKey: args.audioKey ?? rec.audioKey,
      durationSec:
        typeof args.durationSec === "number" && Number.isFinite(args.durationSec)
          ? Math.max(0, Math.round(args.durationSec))
          : rec.durationSec,
    });
    return segments.length;
  },
});

/** The home server gave up. Its message is stored and shown verbatim. */
export const ingestFailed = internalMutation({
  args: { recordingId: v.id("recordings"), error: v.string() },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await ctx.db.patch(rec._id, {
      status: "failed",
      error: args.error.slice(0, 500),
    });
  },
});

/**
 * Does this id name a recording, and does the shared secret match?
 *
 * Both questions in one place so http.ts has no way to answer the
 * second one and forget the first. Returns null rather than throwing
 * for an id that does not exist, so a stale POST from the home server
 * gets a 404 and stops retrying instead of a 500 and a backoff.
 */
export const forIngest = internalQuery({
  args: { recordingId: v.string() },
  handler: async (ctx, args) => {
    // normalizeId answers null for a string that is not an id of this
    // table rather than throwing, which is what makes a stale POST from
    // the home server a 404 it stops retrying instead of a 500 it backs
    // off from for ever.
    const id = ctx.db.normalizeId("recordings", args.recordingId);
    if (!id) return null;
    const rec = await ctx.db.get(id);
    return rec ? { _id: rec._id, campaignId: rec.campaignId } : null;
  },
});

/* ---------- the summary -------------------------------------------- */

export const saveSummary = internalMutation({
  args: {
    recordingId: v.id("recordings"),
    summary: v.any(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    const summary = cleanSummary(args.summary);
    if (!summary) {
      await ctx.db.patch(rec._id, {
        status: "transcribed",
        error: "The summary came back empty.",
      });
      return;
    }
    await ctx.db.patch(rec._id, {
      status: "done",
      error: undefined,
      summary,
      summaryModel: args.model,
      summarizedAt: Date.now(),
    });
  },
});

export const summaryFailed = internalMutation({
  args: { recordingId: v.id("recordings"), error: v.string() },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    // Back to `transcribed`, not `failed`. The transcript is still
    // there and still the valuable half; a failed summary is a button
    // you press again, not a broken recording.
    await ctx.db.patch(rec._id, {
      status: "transcribed",
      error: args.error.slice(0, 500),
    });
  },
});

/** The transcript as one block of text, named speakers and all. */
export const transcriptFor = internalQuery({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    const chunks = await ctx.db
      .query("transcriptChunks")
      .withIndex("by_recording", (q) => q.eq("recordingId", rec._id))
      .collect();
    const segments = joinChunks(chunks);
    const names = rec.speakers ?? {};
    return {
      title: rec.title,
      text: transcriptText(toTurns(segments), names),
      cast: speakerTags(segments).map((tag) => speakerName(tag, names)),
      durationSec: rec.durationSec ?? null,
      empty: segments.length === 0,
    };
  },
});

/**
 * Ask for a summary.
 *
 * A mutation that schedules the action, rather than the action itself:
 * requireDm needs the database, the model call takes a minute or two,
 * and the button should come back immediately with the row already
 * saying `summarizing`. If the browser is closed in between, the work
 * still finishes.
 */
export const requestSummary = mutation({
  args: {
    campaignId: v.id("campaigns"),
    recordingId: v.id("recordings"),
  },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.recordingId);
    if (!rec) throw new Error("Recording not found");
    await requireDm(ctx, rec.campaignId);
    if (!env(API_KEY)) {
      throw new Error(
        "No summarizer is configured. Set ANTHROPIC_API_KEY on the Convex deployment."
      );
    }
    if (rec.status === "summarizing") return;
    await ctx.db.patch(rec._id, { status: "summarizing", error: undefined });
    await ctx.scheduler.runAfter(0, internal.recorder.summarize, {
      recordingId: rec._id,
    });
  },
});

/**
 * What the model is asked for.
 *
 * Built from SUMMARY_SECTIONS so the prompt and the headings on screen
 * cannot drift: a section that exists in one and not the other is the
 * classic silent failure here — six headings drawn, five ever filled.
 */
function buildPrompt(
  title: string,
  cast: readonly string[],
  durationSec: number | null,
  text: string,
  truncated: boolean
): string {
  const fields = SUMMARY_SECTIONS.map(
    (s) =>
      `  "${s.key}": ${s.kind === "prose" ? "a string" : "an array of strings"} — ${s.asked}`
  ).join("\n");

  return [
    "You are writing the session notes for a tabletop roleplaying game.",
    "",
    `The recording is titled "${title}".`,
    durationSec ? `It runs ${formatClock(durationSec)}.` : "",
    cast.length > 0 ? `Voices in it: ${cast.join(", ")}.` : "",
    "",
    "It is an automatic transcript of people talking around a table, so it",
    "contains crosstalk, food orders, rules arguments and jokes alongside the",
    "game. Speaker attribution is a guess by software and is sometimes wrong.",
    "Write about the GAME. Leave out the table talk unless it changed what",
    "happened in the fiction.",
    "",
    "Players speak both as themselves and as their characters. Where you can",
    "tell them apart, name the character for in-fiction events and the player",
    "only for decisions made out of character.",
    "",
    "Do not invent anything. If the transcript does not say what a name is or",
    "how something resolved, leave it out rather than guessing. Garbled audio",
    "is normal; an unreadable stretch is a stretch to skip, not to fill in.",
    "",
    truncated
      ? "IMPORTANT: this transcript was too long to send whole and has been cut. Say so in the first line of the recap."
      : "",
    "",
    "Reply with a single JSON object and nothing else — no preamble, no code",
    "fence. Its fields:",
    "",
    "{",
    fields,
    "}",
    "",
    "Every list may be empty if the session had none of that.",
    "",
    "--- transcript ---",
    text,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The first JSON object in a reply, parsed.
 *
 * Brace counting rather than a regex, and string-aware, because a
 * recap that mentions a "}" is not the end of the object. The prompt
 * asks for bare JSON and a code fence is what it gets anyway often
 * enough that scanning for the first `{` is the honest implementation.
 */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < reply.length; i++) {
    const ch = reply[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(reply.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Read the transcript, write the notes.
 *
 * Internal and scheduled, never called from a browser — requestSummary
 * is the door, and it is the one that checks who is knocking.
 */
export const summarize = internalAction({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, args): Promise<null> => {
    const key = env(API_KEY);
    if (!key) {
      await ctx.runMutation(internal.recorder.summaryFailed, {
        recordingId: args.recordingId,
        error: "No ANTHROPIC_API_KEY is set on this deployment.",
      });
      return null;
    }

    const source: {
      title: string;
      text: string;
      cast: string[];
      durationSec: number | null;
      empty: boolean;
    } = await ctx.runQuery(internal.recorder.transcriptFor, {
      recordingId: args.recordingId,
    });

    if (source.empty) {
      await ctx.runMutation(internal.recorder.summaryFailed, {
        recordingId: args.recordingId,
        error: "There is no transcript to summarize yet.",
      });
      return null;
    }

    const truncated = source.text.length > MAX_PROMPT_CHARS;
    const model = env(SUMMARY_MODEL) ?? DEFAULT_MODEL;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: buildPrompt(
                source.title,
                source.cast,
                source.durationSec,
                truncated ? source.text.slice(0, MAX_PROMPT_CHARS) : source.text,
                truncated
              ),
            },
          ],
        }),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`the API answered ${res.status}: ${detail}`);
      }

      const body = (await res.json()) as {
        content?: { type?: string; text?: string }[];
      };
      const reply = (body.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");

      const parsed = extractJson(reply);
      if (!parsed) throw new Error("the reply was not JSON");

      await ctx.runMutation(internal.recorder.saveSummary, {
        recordingId: args.recordingId,
        summary: parsed,
        model,
      });
    } catch (e) {
      await ctx.runMutation(internal.recorder.summaryFailed, {
        recordingId: args.recordingId,
        error: `Summarizing failed — ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return null;
  },
});
