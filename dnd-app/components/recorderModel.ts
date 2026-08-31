/**
 * The Session Recorder's pure half.
 *
 * Everything here is a function of its arguments: no Convex, no React,
 * no clock, no network. That is what lets the unit guard hold it, and
 * it matters more here than in most tools because two of the things
 * this file does are parsing input from outside the app — WhisperX's
 * segments, and a model's JSON — and both of those arrive shaped by
 * something this repo does not control.
 *
 * The rule that follows from that: **nothing in here trusts its
 * input.** A segment with no speaker, a summary with a number where a
 * string belongs, a speaker map whose key is "toString" — each has a
 * defined answer below rather than a crash or, worse, a value that
 * looks right and is not.
 */

/* ---------- where a recording is up to ---------------------------- */

/**
 * The life of one recording, in order.
 *
 * Eight states rather than a boolean because six different things can
 * be true while nothing is on screen yet, and "processing…" for forty
 * minutes is indistinguishable from a hang. Each of these is a
 * different answer to "should I be worried".
 *
 * `transcribed` is a resting state, not a step on the way to `done`.
 * The transcript is the part that runs on Derek's own hardware and
 * costs nothing; the summary is a paid API call. A recording with no
 * summary is finished work, not a failure, and it says so.
 */
export const RECORDER_STAGES = [
  "recording",
  "uploading",
  "queued",
  "transcribing",
  "transcribed",
  "summarizing",
  "done",
  "failed",
] as const;

export type RecorderStatus = (typeof RECORDER_STAGES)[number];

export const STATUS_LABEL: Record<RecorderStatus, string> = {
  recording: "Recording",
  uploading: "Uploading",
  queued: "Waiting to transcribe",
  transcribing: "Transcribing",
  transcribed: "Transcript ready",
  summarizing: "Summarizing",
  done: "Done",
  failed: "Failed",
};

/**
 * One sentence saying what is happening and who is doing it.
 *
 * The audience is a GM at 1am wondering whether to close the laptop.
 * "Queued" alone does not answer that; "the server has the audio and
 * will start on it" does.
 */
export const STATUS_NOTE: Record<RecorderStatus, string> = {
  recording: "Capturing from the microphone in this browser.",
  uploading: "Sending the audio to the home server.",
  queued: "The server has the audio and will start on it shortly.",
  transcribing:
    "WhisperX is working through the recording. Roughly real time on CPU, far faster on a GPU — you can close this.",
  transcribed:
    "The transcript is in. No summary yet — write one whenever you like.",
  summarizing: "Reading the transcript and writing the session notes.",
  done: "Transcript and notes are both in.",
  failed: "Something went wrong. The message below is what the server said.",
};

export function isRecorderStatus(s: unknown): s is RecorderStatus {
  return (
    typeof s === "string" &&
    (RECORDER_STAGES as readonly string[]).includes(s)
  );
}

/** Where in the run a status sits, for the progress rail. -1 if unknown. */
export function stageIndex(s: unknown): number {
  return isRecorderStatus(s) ? RECORDER_STAGES.indexOf(s) : -1;
}

/** Nothing more will happen on its own. */
export function isSettled(s: unknown): boolean {
  return s === "done" || s === "transcribed" || s === "failed";
}

/** The server, not the browser, is what moves it forward from here. */
export function isServerBusy(s: unknown): boolean {
  return s === "queued" || s === "transcribing" || s === "summarizing";
}

/* ---------- numbers a person reads -------------------------------- */

/**
 * Seconds as a clock: "4:07", and "1:04:23" once there is an hour.
 *
 * Hours are dropped below an hour rather than shown as "0:04:07",
 * because most of what this formats is a timecode inside a transcript
 * and a leading zero-hour on every line is three characters of noise
 * per line for four hours of lines.
 *
 * Anything that is not a finite number is 0:00. This formats values
 * that arrive from a MediaRecorder and from WhisperX, and both can
 * hand over a NaN at the edges — a duration read before the first
 * chunk, a segment with no end.
 */
export function formatClock(seconds: unknown): string {
  const n = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  const total = Math.max(0, Math.floor(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Bytes, to one decimal from MB up.
 *
 * Powers of 1024 and labelled KB/MB/GB, which is what every operating
 * system a GM will compare this against does, whatever the standard
 * says the prefixes mean.
 */
export function formatBytes(bytes: unknown): string {
  const n = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
  const b = Math.max(0, n);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = b / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const dp = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(dp)} ${units[unit]}`;
}

/* ---------- what WhisperX hands over ------------------------------ */

/**
 * One segment as WhisperX writes it.
 *
 * `speaker` is optional because diarization is a separate model from
 * transcription and can decline to label a segment — crosstalk, a
 * cough, a stretch too short to attribute. Those segments still carry
 * words, so they are kept and shown as unattributed rather than
 * dropped: at a table of six people, the bits nobody can be pinned to
 * are frequently the bits worth reading.
 */
export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

/**
 * A segment once it has been through cleanSegments — the shape that is
 * stored and the shape the schema validates.
 *
 * The difference from `Segment` is one word: no `null`. Reading, the
 * speaker may be missing in three ways because three different things
 * write it; writing, there is exactly one way to say "not attributed",
 * which is for the key to be absent. A stored row that could be either
 * would make every reader of it choose, and the schema's optional
 * string does not accept null anyway.
 */
export type StoredSegment = Omit<Segment, "speaker"> & { speaker?: string };

/** Consecutive segments from one speaker, joined into something readable. */
export interface Turn {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/** Speaker tags normalize to "" — the one value meaning "not attributed". */
export function speakerTag(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Segments as they arrive, cleaned into something the rest of this
 * file can rely on.
 *
 * Out-of-range numbers, missing text and non-object entries are the
 * expected input rather than the exception — this is parsing a POST
 * body. A segment survives only if it has text; everything else is
 * repaired to a sane value, because a bad `end` is not a reason to
 * lose what was said.
 */
export function cleanSegments(
  raw: unknown,
  max = MAX_SEGMENTS
): StoredSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredSegment[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) continue;
    const start =
      typeof row.start === "number" && Number.isFinite(row.start)
        ? Math.max(0, row.start)
        : 0;
    const rawEnd =
      typeof row.end === "number" && Number.isFinite(row.end) ? row.end : start;
    const seg: StoredSegment = {
      start,
      end: Math.max(start, rawEnd),
      text: text.slice(0, MAX_SEGMENT_TEXT),
    };
    const tag = speakerTag(row.speaker);
    if (tag) seg.speaker = tag;
    out.push(seg);
  }
  return out;
}

/** A four-hour session runs to a few thousand; this is the wall. */
export const MAX_SEGMENTS = 20000;
/** One segment is a phrase. Anything longer is a bug upstream. */
export const MAX_SEGMENT_TEXT = 2000;

/**
 * The gap, in seconds, that ends a turn even when the speaker has not
 * changed.
 *
 * Without it, one person who talks on and off across an hour — the GM,
 * every session — becomes a single turn an hour long with an hour-old
 * timecode on it. Ten seconds is roughly the pause where a table has
 * moved on to something else.
 */
export const TURN_GAP = 10;

/** And the wall on one turn's length, so a monologue still breaks up. */
export const TURN_CHARS = 1200;

/**
 * Segments into turns: same speaker, close together, joined.
 *
 * This is the only place the transcript's shape on screen is decided,
 * and it is here rather than in the component because it is the part
 * worth testing. The failure it prevents is a transcript that reads as
 * three thousand one-line rows, each stamped and attributed, which is
 * technically the same information and is unreadable.
 */
export function toTurns(segments: readonly Segment[]): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const speaker = speakerTag(seg.speaker);
    const last = turns[turns.length - 1];
    const joinable =
      last !== undefined &&
      last.speaker === speaker &&
      seg.start - last.end <= TURN_GAP &&
      last.text.length + seg.text.length + 1 <= TURN_CHARS;
    if (joinable) {
      last.text = `${last.text} ${seg.text}`;
      last.end = Math.max(last.end, seg.end);
    } else {
      turns.push({
        speaker,
        start: seg.start,
        end: Math.max(seg.start, seg.end),
        text: seg.text,
      });
    }
  }
  return turns;
}

/** Every speaker in the transcript, in the order they first say something. */
export function speakerTags(segments: readonly Segment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of segments) {
    const tag = speakerTag(seg.speaker);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * How long each speaker held the floor, in seconds, by tag.
 *
 * Two uses, both practical: it orders the naming form so the person
 * who talked most is the first one you name — and at a D&D table that
 * is almost always the GM — and it is how you spot that the mic caught
 * one end of the room and not the other.
 */
export function speakingTime(
  segments: readonly Segment[]
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const seg of segments) {
    const tag = speakerTag(seg.speaker);
    const span = Math.max(0, seg.end - seg.start);
    totals.set(tag, (totals.get(tag) ?? 0) + span);
  }
  return totals;
}

/**
 * The name to print for a speaker tag.
 *
 * `names` comes from the database and its KEYS are WhisperX's, so this
 * is an object being indexed by a string from outside — the exact
 * shape that made `colorOf` in the To-Do tool return a function for
 * the tag "toString". hasOwnProperty, not `names[tag] ??`, for the
 * same reason and with the same consequence if it is got wrong: the
 * value lands in JSX.
 *
 * The fallback counts from 1. WhisperX numbers from SPEAKER_00 and
 * nobody at a table thinks of themselves as speaker zero.
 */
export function speakerName(
  tag: string,
  names: Record<string, string> | null | undefined
): string {
  const key = speakerTag(tag);
  if (
    names &&
    Object.prototype.hasOwnProperty.call(names, key) &&
    typeof names[key] === "string" &&
    names[key].trim() !== ""
  ) {
    return names[key].trim();
  }
  if (!key) return "Unattributed";
  const m = /^SPEAKER_(\d+)$/i.exec(key);
  if (m) return `Speaker ${Number(m[1]) + 1}`;
  return key;
}

/**
 * Turns matching a search, or all of them for an empty search.
 *
 * Matches the words and the speaker's PRINTED name, because "what did
 * Marcus say about the tower" is the actual question and the tag
 * SPEAKER_03 is not how anyone remembers it.
 */
export function searchTurns(
  turns: readonly Turn[],
  query: string,
  names?: Record<string, string> | null
): Turn[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...turns];
  return turns.filter(
    (t) =>
      t.text.toLowerCase().includes(q) ||
      speakerName(t.speaker, names).toLowerCase().includes(q)
  );
}

/** The whole thing as text, for the clipboard and for the summarizer. */
export function transcriptText(
  turns: readonly Turn[],
  names?: Record<string, string> | null
): string {
  return turns
    .map(
      (t) =>
        `[${formatClock(t.start)}] ${speakerName(t.speaker, names)}: ${t.text}`
    )
    .join("\n");
}

/* ---------- storing it -------------------------------------------- */

/**
 * How much transcript goes in one row.
 *
 * A Convex document is capped at 1 MB and a four-hour transcript is
 * comfortably past that, so it is stored in pieces whatever else is
 * true. 48 KB rather than something near the cap because these rows
 * are read by a reactive query: the smaller the row, the less is
 * re-sent when one of them changes.
 */
export const CHUNK_CHARS = 48000;

/**
 * Segments split into storable runs, in order, never splitting one
 * segment across two rows.
 *
 * A segment longer than the budget goes in a row of its own rather
 * than being cut — a phrase is the smallest thing with a timecode, and
 * half a phrase attributed to the wrong second is worse than a fat
 * row. MAX_SEGMENT_TEXT keeps that row well under Convex's limit.
 */
export function chunkSegments<T extends Segment>(
  segments: readonly T[],
  budget = CHUNK_CHARS
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const seg of segments) {
    const cost = seg.text.length + 64;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(seg);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Rows back into one ordered transcript, whatever order they arrived in. */
export function joinChunks<T extends Segment>(
  rows: readonly { index: number; segments: T[] }[]
): T[] {
  return [...rows]
    .sort((a, b) => a.index - b.index)
    .flatMap((r) => r.segments);
}

/* ---------- the notes ---------------------------------------------- */

/**
 * What the summarizer is asked for, and what the screen draws.
 *
 * One list, used at both ends: the prompt is built from it and so are
 * the headings, so a section cannot exist on screen that was never
 * asked for, or be asked for and then have nowhere to go. Adding a
 * section is one entry here.
 */
export const SUMMARY_SECTIONS = [
  {
    key: "recap",
    title: "Recap",
    kind: "prose",
    asked: "a paragraph of six to ten sentences retelling the session as a story, in past tense",
  },
  {
    key: "beats",
    title: "What happened",
    kind: "list",
    asked: "the events of the session in order, one line each",
  },
  {
    key: "decisions",
    title: "Decisions the party made",
    kind: "list",
    asked: "choices the players made that the world should remember",
  },
  {
    key: "npcs",
    title: "Who they met",
    kind: "list",
    asked: "named characters who appeared, each as 'Name — what they did'",
  },
  {
    key: "loot",
    title: "Loot and rewards",
    kind: "list",
    asked: "items, money, favours and titles gained",
  },
  {
    key: "threads",
    title: "Left hanging",
    kind: "list",
    asked: "questions the table raised and did not resolve, and anything set up for next time",
  },
] as const;

export type SummaryKey = (typeof SUMMARY_SECTIONS)[number]["key"];

export interface SessionSummary {
  recap: string;
  beats: string[];
  decisions: string[];
  npcs: string[];
  loot: string[];
  threads: string[];
}

/** Caps, applied to model output rather than trusted from it. */
export const MAX_RECAP = 4000;
export const MAX_LINE = 400;
export const MAX_LINES = 40;

/** One line of a list, or null if there is nothing usable in it. */
function cleanLine(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, MAX_LINE);
}

/**
 * A summary as the model returned it, made safe to render.
 *
 * Returns null when there is nothing worth showing — every section
 * empty — so the caller can say "no summary" rather than draw six
 * empty headings. A section that is missing or the wrong type becomes
 * empty rather than failing the whole parse: five good sections and
 * one the model fumbled is still a useful set of notes.
 *
 * This runs on the way IN, before storage, and again is what the
 * screen reads. That is deliberate duplication — a row written by an
 * older version of this function is still parsed by the current one.
 */
export function cleanSummary(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const recap =
    typeof row.recap === "string"
      ? row.recap.replace(/[ \t]+/g, " ").trim().slice(0, MAX_RECAP)
      : "";

  const list = (key: string): string[] => {
    const value = row[key];
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      if (out.length >= MAX_LINES) break;
      const line = cleanLine(item);
      if (line) out.push(line);
    }
    return out;
  };

  const summary: SessionSummary = {
    recap,
    beats: list("beats"),
    decisions: list("decisions"),
    npcs: list("npcs"),
    loot: list("loot"),
    threads: list("threads"),
  };

  const empty =
    summary.recap === "" &&
    SUMMARY_SECTIONS.every(
      (s) => s.kind !== "list" || summary[s.key as SummaryKey].length === 0
    );
  return empty ? null : summary;
}

/** The notes as text, for pasting into a session's page. */
export function summaryText(summary: SessionSummary): string {
  const parts: string[] = [];
  for (const section of SUMMARY_SECTIONS) {
    if (section.kind === "prose") {
      const value = summary[section.key as SummaryKey];
      if (typeof value === "string" && value) {
        parts.push(`## ${section.title}\n\n${value}`);
      }
      continue;
    }
    const lines = summary[section.key as SummaryKey];
    if (Array.isArray(lines) && lines.length > 0) {
      parts.push(`## ${section.title}\n\n${lines.map((l) => `- ${l}`).join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

/* ---------- titles and names --------------------------------------- */

export const MAX_TITLE = 120;
export const MAX_SPEAKER_NAME = 60;
/** Six players, a GM, and room for the diarizer to over-split. */
export const MAX_SPEAKERS = 24;

export function cleanTitle(raw: unknown, fallback = "Untitled recording"): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, MAX_TITLE) : fallback;
}

/**
 * A speaker map, cleaned: known tags only, trimmed, capped, and
 * blanks dropped rather than stored.
 *
 * Dropping a blank rather than storing "" is what makes clearing a
 * name fall back to "Speaker 3" instead of printing nothing, and it
 * keeps the row from accumulating one key per tag the GM has ever
 * looked at.
 */
export function cleanSpeakers(
  raw: unknown,
  tags: readonly string[]
): Record<string, string> {
  const allowed = new Set(tags.slice(0, MAX_SPEAKERS));
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const row = raw as Record<string, unknown>;
  for (const tag of allowed) {
    if (!Object.prototype.hasOwnProperty.call(row, tag)) continue;
    const value = row[tag];
    if (typeof value !== "string") continue;
    const name = value.replace(/\s+/g, " ").trim();
    if (name) out[tag] = name.slice(0, MAX_SPEAKER_NAME);
  }
  return out;
}

/* ---------- the upload target -------------------------------------- */

/**
 * Whether a configured recorder URL is one this app will post audio to.
 *
 * https only, and no credentials in the URL. The value comes from a
 * Convex environment variable rather than from a person typing, which
 * is exactly why it is checked: an environment variable is edited once,
 * a year ago, by someone who has since forgotten it exists, and a typo
 * that downgrades this to http sends a session's audio across the
 * internet in the clear without anything on screen changing.
 *
 * http://localhost is allowed, because that is how you test the server
 * on the machine it runs on.
 */
export function isUploadUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/** The endpoint for one part of a recording, given the configured base. */
export function chunkUrl(base: string, recordingId: string, seq: number): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/chunk/${encodeURIComponent(recordingId)}/${seq}`;
}

/** And the endpoint that closes it and starts the transcription. */
export function finishUrl(base: string, recordingId: string): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/finish/${encodeURIComponent(recordingId)}`;
}
