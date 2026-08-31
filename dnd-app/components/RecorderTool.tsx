"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  RECORDER_STAGES,
  SUMMARY_SECTIONS,
  STATUS_LABEL,
  STATUS_NOTE,
  type SessionSummary,
  type Segment,
  type SummaryKey,
  type Turn,
  formatBytes,
  formatClock,
  stageIndex,
  isRecorderStatus,
  isServerBusy,
  searchTurns,
  speakerName,
  speakerTags,
  speakingTime,
  summaryText,
  toTurns,
  transcriptText,
} from "@/components/recorderModel";
import { isRetryable, useRecorder } from "@/components/useRecorder";

/**
 * Session Recorder — record the night, read it back, summarize it.
 *
 * GM-only, and more strongly so than most of this app. A transcript of
 * a session contains the table's whole evening: the aside to one
 * player while the others were getting food, the argument about a
 * ruling, whatever anybody said believing the laptop was only there
 * for the battle map. There is no redacted version of that to show a
 * player, so there is no player-facing version of this screen and no
 * query behind it that a player can call.
 *
 * The screen is arranged around the two questions a GM actually has,
 * in the order they have them. During the session: **is it hearing
 * us** — which is the level meter, and is the reason the meter is the
 * biggest thing on the capture bar rather than a nicety in a corner.
 * Afterwards: **what happened** — the summary first, the transcript
 * under it for when the summary is not enough.
 */

function useRunner() {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "That didn't work.")
    );
  };
  return { error, run, setError };
}

/** A date, the way the rest of the app writes them. */
function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The default title: the night it was recorded. */
function defaultTitle(now: Date): string {
  return `Session — ${now.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })}`;
}

/* ---------------------------------------------------------------- */
/* The capture bar                                                    */
/* ---------------------------------------------------------------- */

/**
 * The level meter.
 *
 * Twenty segments and a peak hold. The specific failure this exists to
 * prevent: a laptop on one end of a table, the two players at the far
 * end inaudible to it, and nobody finding out until the transcript
 * comes back four hours later with half the group missing. A meter
 * that visibly moves when the far end speaks is the check, and it has
 * to be readable from across the room, which is why it is a row of
 * blocks rather than a thin bar.
 */
function LevelMeter({ level, live }: { level: number; live: boolean }) {
  const segments = 20;
  const lit = Math.round(Math.min(1, Math.max(0, level)) * segments);
  return (
    <div
      className="rec-meter"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, level)) * 100)}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`rec-seg${i < lit && live ? " is-lit" : ""}${
            i > segments - 4 ? " is-hot" : ""
          }`}
        />
      ))}
    </div>
  );
}

function CaptureBar({
  campaignId,
  onStarted,
}: {
  campaignId: Id<"campaigns">;
  onStarted: (id: Id<"recordings">) => void;
}) {
  const config = useQuery(api.recorder.getConfig, { campaignId });
  const startRecording = useAction(api.recorder.startRecording);
  const finishUpload = useMutation(api.recorder.finishUpload);
  const markFailed = useMutation(api.recorder.markFailed);
  const rec = useRecorder();
  const { error, run, setError } = useRunner();

  const [title, setTitle] = useState("");
  const currentRef = useRef<Id<"recordings"> | null>(null);

  const live = rec.state === "recording";
  // Stopped, but the last slices never made it. The button has to stay
  // a way to finish rather than reverting to Record, or the only copy
  // of the end of the session sits in a tab with nothing to press.
  const unsent = !live && rec.state === "idle" && rec.pending > 0;

  if (config === undefined) {
    return <p className="centered-note">Checking the recorder…</p>;
  }

  if (!config.uploadReady) {
    return (
      <div className="rec-setup">
        <h3>The recorder is not connected yet</h3>
        <p>
          Audio does not go into this app&apos;s database — a four-hour
          session is about 60 MB and the free tier is a gigabyte, so
          seventeen of them would fill it mid-game. It goes to the home
          server instead, beside the battle maps, which is also the
          machine that does the transcribing.
        </p>
        {config.uploadUrlBad ? (
          <p className="rec-warn">
            <code>RECORDER_UPLOAD_URL</code> is set but was rejected. It has to
            be an <code>https://</code> address with no username or password in
            it.
          </p>
        ) : null}
        <p>
          Set these on the Convex deployment, then reload:{" "}
          <code>RECORDER_UPLOAD_URL</code>, <code>RECORDER_UPLOAD_SECRET</code>{" "}
          and <code>RECORDER_INGEST_SECRET</code>.{" "}
          <code>map-server/RECORDER.md</code> is the whole setup.
        </p>
      </div>
    );
  }

  const begin = () =>
    run(async () => {
      const target = await startRecording({
        campaignId,
        title: title.trim() || defaultTitle(new Date()),
      });
      currentRef.current = target.recordingId;
      onStarted(target.recordingId);
      try {
        await rec.start({
          recordingId: String(target.recordingId),
          uploadUrl: target.uploadUrl,
          ticket: target.ticket,
        });
      } catch (e) {
        // The row exists and nothing will ever arrive for it, so it is
        // marked failed rather than left saying "recording" for ever.
        await markFailed({
          campaignId,
          recordingId: target.recordingId,
          error: e instanceof Error ? e.message : String(e),
        });
        currentRef.current = null;
        throw e;
      }
    });

  const end = () =>
    run(async () => {
      const id = currentRef.current;
      try {
        const result = await rec.stop();
        if (id && result) {
          await finishUpload({
            campaignId,
            recordingId: id,
            durationSec: result.durationSec,
            bytes: result.bytes,
          });
        }
        currentRef.current = null;
        setTitle("");
      } catch (e) {
        // Only give up on the row when the audio is actually gone. A
        // retryable failure leaves slices in this tab that pressing
        // the button again will still send, and marking it failed is
        // how a recoverable session gets abandoned.
        if (id && !isRetryable(e)) {
          await markFailed({
            campaignId,
            recordingId: id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        throw e;
      }
    });

  return (
    <div
      className={`rec-bar${live ? " is-live" : unsent ? " is-unsent" : ""}`}
    >
      <div className="rec-bar-main">
        <button
          type="button"
          className={live || unsent ? "rec-stop" : "rec-go"}
          onClick={live || unsent ? end : begin}
          disabled={rec.state === "starting" || rec.state === "stopping"}
        >
          {rec.state === "starting"
            ? "Starting…"
            : rec.state === "stopping"
              ? "Finishing…"
              : live
                ? "Stop"
                : unsent
                  ? "Finish upload"
                  : "Record"}
        </button>

        <div className="rec-bar-mid">
          {live || unsent ? (
            <div className="rec-clock">
              {live ? <span className="rec-dot" aria-hidden="true" /> : null}
              {formatClock(rec.elapsed)}
              <span className="rec-size">{formatBytes(rec.bytes)}</span>
              {rec.pending > 0 ? (
                <span className="rec-pending">
                  {rec.pending} part{rec.pending === 1 ? "" : "s"} waiting to
                  upload
                </span>
              ) : null}
            </div>
          ) : (
            <input
              className="rec-title-field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={defaultTitle(new Date())}
              aria-label="What to call this recording"
            />
          )}
          <LevelMeter level={rec.level} live={live} />
        </div>

        <label className="rec-device">
          <span>Microphone</span>
          <select
            value={rec.deviceId ?? ""}
            onChange={(e) => rec.setDeviceId(e.target.value)}
            disabled={live}
          >
            {rec.devices.length === 0 ? (
              <option value="">Default</option>
            ) : (
              rec.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      {live ? (
        <p className="rec-hint">
          Watch the meter while the far end of the table talks. If it barely
          moves for them, the microphone is too close to you — that is the one
          thing you cannot fix afterwards.
        </p>
      ) : null}

      {rec.error ? <p className="rec-warn">{rec.error}</p> : null}
      {error ? (
        <p className="rec-warn" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Status                                                             */
/* ---------------------------------------------------------------- */

/**
 * Where a recording is up to, and whether to worry.
 *
 * The rail is not decoration. Between pressing Stop and reading the
 * notes there are five states in which nothing is on screen and
 * nothing is wrong, and "processing…" held for forty minutes is
 * indistinguishable from a hang. Five ticks with the fourth lit says
 * which of the five, at a glance, from across a room.
 *
 * The spinner turns for `isServerBusy` rather than for "not settled":
 * recording and uploading are the browser's own states and are already
 * on the capture bar with a clock beside them. Spinning here as well
 * would say the home server was working when it has not been handed
 * anything yet.
 */
function StatusLine({
  status,
  error,
}: {
  status: string;
  error: string | null;
}) {
  const known = isRecorderStatus(status);
  const at = stageIndex(status);
  return (
    <div className={`rec-status is-${known ? status : "unknown"}`}>
      <span className="rec-status-name">
        {known ? STATUS_LABEL[status] : "Unknown state"}
        {isServerBusy(status) ? <span className="rec-spin" /> : null}
        {known && status !== "failed" ? (
          <span className="rec-rail" aria-hidden="true">
            {RECORDER_STAGES.filter((s) => s !== "failed").map((s, i) => (
              <span
                key={s}
                className={`rec-tick${i <= at ? " is-past" : ""}${
                  i === at ? " is-now" : ""
                }`}
              />
            ))}
          </span>
        ) : null}
      </span>
      <span className="rec-status-note">
        {known
          ? STATUS_NOTE[status]
          : `The server reported "${status}", which this version of the app does not know about.`}
      </span>
      {error ? <span className="rec-status-error">{error}</span> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Who was speaking                                                   */
/* ---------------------------------------------------------------- */

/**
 * Putting names to WhisperX's voices.
 *
 * Ordered by how long each one held the floor, which at a D&D table
 * puts the GM first and is the order you can actually name them in.
 * The share of talking is printed beside each because it is also the
 * diagnosis: one voice at 90% means the diarizer merged the table, and
 * six voices at 2% each below the real ones means it split somebody up.
 */
function SpeakerForm({
  campaignId,
  recordingId,
  segments,
  speakers,
}: {
  campaignId: Id<"campaigns">;
  recordingId: Id<"recordings">;
  segments: Segment[];
  speakers: Record<string, string>;
}) {
  const setSpeakers = useMutation(api.recorder.setSpeakers);
  const { error, run } = useRunner();
  const [draft, setDraft] = useState<Record<string, string>>(speakers);

  // The stored map is the truth; a fresh one arriving replaces the
  // draft. Without this, saving leaves the form showing what was typed
  // rather than what was kept, and the two differ whenever cleanSpeakers
  // trimmed something.
  //
  // Keyed on the serialised map rather than the object, deliberately.
  // `speakers` comes out of a live query, so its identity can change on
  // a render that changed nothing about it — and an effect that reset
  // the draft on identity would clear the field being typed into, once,
  // unpredictably, which is the worst kind of form bug to reproduce.
  const stored = JSON.stringify(speakers);
  useEffect(() => setDraft(JSON.parse(stored) as Record<string, string>), [stored]);

  const talk = useMemo(() => speakingTime(segments), [segments]);
  const total = useMemo(
    () => Array.from(talk.values()).reduce((a, b) => a + b, 0),
    [talk]
  );
  const tags = useMemo(
    () =>
      speakerTags(segments).sort((a, b) => (talk.get(b) ?? 0) - (talk.get(a) ?? 0)),
    [segments, talk]
  );

  // What the diarizer could not attribute. Shown because it is the
  // clearest read on microphone placement there is: a third of the
  // evening unattributed is a room problem, not a model problem.
  const unnamed = total > 0 ? (talk.get("") ?? 0) / total : 0;

  if (tags.length === 0) return null;

  return (
    <section className="rec-cast">
      <h3>Who was talking</h3>
      <p className="rec-cast-note">
        The software labels voices, not people. Name them once and every line
        below — and the session notes — uses the name.
        {unnamed > 0.02 ? (
          <>
            {" "}
            <strong>{Math.round(unnamed * 100)}%</strong> of the talking could
            not be pinned to anyone — usually the end of the table furthest
            from the microphone.
          </>
        ) : null}
      </p>
      <div className="rec-cast-rows">
        {tags.map((tag) => {
          const share = total > 0 ? (talk.get(tag) ?? 0) / total : 0;
          return (
            <label key={tag} className="rec-cast-row">
              <span className="rec-cast-tag">
                {speakerName(tag, {})}
                <span className="rec-cast-share">
                  {Math.round(share * 100)}%
                </span>
              </span>
              <input
                value={draft[tag] ?? ""}
                placeholder="Name"
                maxLength={60}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [tag]: e.target.value }))
                }
                onBlur={() =>
                  run(() =>
                    setSpeakers({ campaignId, recordingId, speakers: draft })
                  )
                }
              />
            </label>
          );
        })}
      </div>
      {error ? <p className="rec-warn">{error}</p> : null}
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* The notes                                                          */
/* ---------------------------------------------------------------- */

function SummaryPanel({
  campaignId,
  recordingId,
  summary,
  status,
  canSummarize,
  model,
  summarizedAt,
  hasTranscript,
}: {
  campaignId: Id<"campaigns">;
  recordingId: Id<"recordings">;
  summary: SessionSummary | null;
  status: string;
  canSummarize: boolean;
  model: string;
  summarizedAt: number | null;
  hasTranscript: boolean;
}) {
  const requestSummary = useMutation(api.recorder.requestSummary);
  const { error, run } = useRunner();
  const [copied, setCopied] = useState(false);

  const busy = status === "summarizing";

  return (
    <section className="rec-summary">
      <div className="rec-summary-head">
        <h3>Session notes</h3>
        <div className="rec-summary-actions">
          {summary ? (
            <button
              type="button"
              className="rec-ghost"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(summaryText(summary))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          {hasTranscript && canSummarize ? (
            <button
              type="button"
              className="rec-ghost"
              disabled={busy}
              onClick={() =>
                run(() => requestSummary({ campaignId, recordingId }))
              }
            >
              {busy ? "Writing…" : summary ? "Write again" : "Write the notes"}
            </button>
          ) : null}
        </div>
      </div>

      {!canSummarize ? (
        <p className="rec-empty">
          The transcript is free — it is made on your own hardware. Writing the
          notes is a call to the Claude API and needs a key:{" "}
          <code>ANTHROPIC_API_KEY</code> on the Convex deployment. Roughly a
          session&apos;s worth of transcript costs well under a dollar to
          summarize.
        </p>
      ) : !hasTranscript ? (
        <p className="rec-empty">
          Nothing to summarize until the transcript arrives.
        </p>
      ) : !summary ? (
        <p className="rec-empty">
          {busy
            ? "Reading the transcript…"
            : "No notes yet. The transcript below is the whole session; this turns it into something you can send the table."}
        </p>
      ) : (
        <>
          {SUMMARY_SECTIONS.map((section) => {
            if (section.kind === "prose") {
              const text = summary[section.key as SummaryKey] as string;
              if (!text) return null;
              return (
                <div key={section.key} className="rec-sec">
                  <h4>{section.title}</h4>
                  <p>{text}</p>
                </div>
              );
            }
            const lines = summary[section.key as SummaryKey] as string[];
            if (!lines || lines.length === 0) return null;
            return (
              <div key={section.key} className="rec-sec">
                <h4>{section.title}</h4>
                <ul>
                  {lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="rec-credit">
            Written by {model}
            {summarizedAt ? ` on ${stamp(summarizedAt)}` : ""}. Automatic notes
            get things wrong — read them before you send them.
          </p>
        </>
      )}

      {error ? <p className="rec-warn">{error}</p> : null}
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* The transcript                                                     */
/* ---------------------------------------------------------------- */

function TranscriptPanel({
  turns,
  speakers,
}: {
  turns: Turn[];
  speakers: Record<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const shown = useMemo(
    () => searchTurns(turns, query, speakers),
    [turns, query, speakers]
  );

  if (turns.length === 0) return null;

  return (
    <section className="rec-transcript">
      <div className="rec-transcript-head">
        <h3>Transcript</h3>
        <input
          className="rec-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search what was said…"
          aria-label="Search the transcript"
        />
        <span className="rec-count">
          {query.trim()
            ? `${shown.length} of ${turns.length}`
            : `${turns.length} turns`}
        </span>
        <button
          type="button"
          className="rec-ghost"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(transcriptText(turns, speakers))
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy all"}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="rec-empty">Nothing in the transcript says that.</p>
      ) : (
        <ol className="rec-turns">
          {shown.map((turn, i) => (
            <li key={`${turn.start}-${i}`} className="rec-turn">
              <span className="rec-turn-meta">
                <span className="rec-turn-who">
                  {speakerName(turn.speaker, speakers)}
                </span>
                <span className="rec-turn-at">{formatClock(turn.start)}</span>
              </span>
              <span className="rec-turn-text">{turn.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* One recording                                                      */
/* ---------------------------------------------------------------- */

function RecordingDetail({
  campaignId,
  recordingId,
  canSummarize,
  model,
  onDeleted,
}: {
  campaignId: Id<"campaigns">;
  recordingId: Id<"recordings">;
  canSummarize: boolean;
  model: string;
  onDeleted: () => void;
}) {
  const data = useQuery(api.recorder.getRecording, { campaignId, recordingId });
  const sessions = useQuery(api.sessions.listForCampaign, { campaignId });
  const rename = useMutation(api.recorder.rename);
  const linkSession = useMutation(api.recorder.linkSession);
  const deleteRecording = useAction(api.recorder.deleteRecording);
  const { error, run } = useRunner();
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);

  const rec = data?.recording ?? null;
  useEffect(() => {
    if (rec) setTitle(rec.title);
  }, [rec?._id, rec?.title]);

  const turns = useMemo(() => toTurns(data?.segments ?? []), [data?.segments]);

  if (data === undefined) {
    return <p className="centered-note">Opening the recording…</p>;
  }
  // null, not undefined: the query ran and this campaign has no such
  // recording — deleted in another tab, or an id from somewhere else.
  if (data === null || !rec) {
    return <p className="centered-note">That recording is gone.</p>;
  }

  return (
    <div className="rec-detail">
      <div className="rec-detail-head">
        <input
          className="rec-detail-title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => run(() => rename({ campaignId, recordingId, title }))}
          aria-label="Recording title"
        />
        <div className="rec-detail-facts">
          <span>{stamp(rec.startedAt)}</span>
          {rec.durationSec ? <span>{formatClock(rec.durationSec)}</span> : null}
          {rec.bytes ? <span>{formatBytes(rec.bytes)}</span> : null}
          {rec.segmentCount ? <span>{rec.segmentCount} segments</span> : null}
          {rec.language ? <span>{rec.language}</span> : null}
        </div>
      </div>

      <StatusLine status={rec.status} error={rec.error} />

      <div className="rec-detail-row">
        <label className="rec-link">
          <span>Session</span>
          <select
            value={rec.sessionId ? String(rec.sessionId) : ""}
            onChange={(e) =>
              run(() =>
                linkSession({
                  campaignId,
                  recordingId,
                  sessionId: e.target.value
                    ? (e.target.value as Id<"sessions">)
                    : null,
                })
              )
            }
          >
            <option value="">Not linked</option>
            {(sessions?.sessions ?? []).map((s) => (
              <option key={String(s._id)} value={String(s._id)}>
                Session {s.number}
                {s.date ? ` — ${s.date}` : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="rec-danger"
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            run(async () => {
              await deleteRecording({ campaignId, recordingId });
              onDeleted();
            });
          }}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? "Delete it — audio too" : "Delete"}
        </button>
      </div>

      <SummaryPanel
        campaignId={campaignId}
        recordingId={recordingId}
        summary={rec.summary}
        status={rec.status}
        canSummarize={canSummarize}
        model={model}
        summarizedAt={rec.summarizedAt}
        hasTranscript={turns.length > 0}
      />

      <SpeakerForm
        campaignId={campaignId}
        recordingId={recordingId}
        segments={data.segments}
        speakers={rec.speakers}
      />

      <TranscriptPanel turns={turns} speakers={rec.speakers} />

      {error ? <p className="rec-warn">{error}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* The tool                                                           */
/* ---------------------------------------------------------------- */

export function RecorderTool({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const config = useQuery(api.recorder.getConfig, { campaignId });
  const list = useQuery(api.recorder.listRecordings, { campaignId });
  const [selected, setSelected] = useState<Id<"recordings"> | null>(null);

  // The newest recording is the one you want open — you have just made
  // it. Only until you pick another: `selected` sticking is what makes
  // reading an old session survive the list re-sorting under it.
  const newest = list?.[0]?._id ?? null;
  useEffect(() => {
    setSelected((current) => {
      if (current && list?.some((r) => r._id === current)) return current;
      return newest;
    });
  }, [newest, list]);

  return (
    <div className="rec">
      <CaptureBar campaignId={campaignId} onStarted={setSelected} />

      {list === undefined ? (
        <p className="centered-note">Opening the recordings…</p>
      ) : list.length === 0 ? (
        <p className="rec-empty rec-empty-all">
          Nothing recorded yet. Put the laptop in the middle of the table, press
          Record, and check the meter moves when the far end talks.
        </p>
      ) : (
        <div className="rec-body">
          <ul className="rec-list">
            {list.map((row) => (
              <li key={String(row._id)}>
                <button
                  type="button"
                  className={`rec-list-row${
                    row._id === selected ? " is-open" : ""
                  }`}
                  onClick={() => setSelected(row._id)}
                >
                  <span className="rec-list-title">{row.title}</span>
                  <span className="rec-list-facts">
                    <span>{stamp(row.startedAt)}</span>
                    {row.durationSec ? (
                      <span>{formatClock(row.durationSec)}</span>
                    ) : null}
                  </span>
                  <span
                    className={`rec-chip is-${
                      isRecorderStatus(row.status) ? row.status : "unknown"
                    }`}
                  >
                    {isRecorderStatus(row.status)
                      ? STATUS_LABEL[row.status]
                      : row.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="rec-pane">
            {selected ? (
              <RecordingDetail
                campaignId={campaignId}
                recordingId={selected}
                canSummarize={config?.summaryReady ?? false}
                model={config?.summaryModel ?? "Claude"}
                onDeleted={() => setSelected(null)}
              />
            ) : (
              <p className="centered-note">Pick a recording.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
