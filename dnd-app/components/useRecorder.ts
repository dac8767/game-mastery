"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chunkUrl, finishUrl } from "@/components/recorderModel";

/**
 * Capturing a session in the browser, and getting it to the home server.
 *
 * All of this is browser API and network, which is why it is a hook in
 * its own file rather than part of the screen: none of it can be unit
 * tested here, so the parts that CAN be — clock formatting, the URL
 * builders, everything the transcript does — live in recorderModel.ts
 * instead, and this file is kept to the things that genuinely need a
 * MediaRecorder.
 *
 * Three decisions worth knowing about, all of them about a four-hour
 * recording rather than a four-minute one:
 *
 * - **It uploads while it records.** A thirty-second slice goes to the
 *   server as it is produced. The alternative — one blob at the end —
 *   means holding four hours of audio in a tab's memory and then a
 *   single sixty-megabyte POST that either works or loses the night.
 * - **A failed slice is retried, not dropped.** The wifi in a house
 *   with six people on it drops for ten seconds fairly often. Slices
 *   queue in memory and go when it comes back, and the screen says how
 *   many are waiting.
 * - **Order is the server's problem, not ours.** Each slice is posted
 *   with its sequence number and the server reassembles by number.
 *   WebM slices after the first are not independently playable, so the
 *   order genuinely matters — making it explicit is safer than making
 *   it depend on which POST finished first.
 */

/** Thirty seconds: small enough to lose little, large enough to be rare. */
const SLICE_MS = 30000;

/**
 * What the microphone is asked for.
 *
 * Echo cancellation and noise suppression OFF, which is the opposite of
 * what a video call wants and the right answer for a room. Both are
 * tuned for one voice close to one mic; pointed at a table of six they
 * treat the far end as noise and gate it out, and the person you most
 * need transcribed is always the one furthest from the laptop.
 *
 * Gain control stays ON — it is the one that helps, pulling a quiet
 * player up rather than deciding they are not there.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
};

/**
 * Opus first, and 32 kbps of it.
 *
 * Speech at 32 kbps mono is transparent enough for transcription and
 * comes to about 60 MB for four hours — an amount of disk and of
 * upload that a house connection does not notice. The fallbacks are
 * for Safari, which has no WebM.
 */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const BITS_PER_SECOND = 32000;

/** Retry a slice this many times before it counts as the upload failing. */
const MAX_ATTEMPTS = 6;

export type CaptureState = "idle" | "starting" | "recording" | "stopping";

export interface CaptureDevice {
  deviceId: string;
  label: string;
}

export interface RecorderHandle {
  state: CaptureState;
  /** Seconds since the recording started. */
  elapsed: number;
  /** 0..1, the loudest recent sample — the level meter. */
  level: number;
  /** Bytes handed to the uploader so far. */
  bytes: number;
  /** Slices waiting to go up. Above zero for long means trouble. */
  pending: number;
  error: string | null;
  devices: CaptureDevice[];
  deviceId: string | null;
  setDeviceId: (id: string) => void;
  start: (target: {
    recordingId: string;
    uploadUrl: string;
    ticket: string;
  }) => Promise<void>;
  stop: () => Promise<{ durationSec: number; bytes: number } | null>;
  refreshDevices: () => Promise<void>;
}

/**
 * An error the caller must not treat as the end of the recording.
 *
 * The distinction it carries: the audio is still recoverable — in this
 * tab's memory or already on the server — so the row stays as it is and
 * the button says try again, rather than the recording being marked
 * failed while the night is still there to be saved.
 */
export type RetryableError = Error & { retryable: true };

export function isRetryable(e: unknown): boolean {
  return e instanceof Error && (e as Partial<RetryableError>).retryable === true;
}

function retryable(message: string): RetryableError {
  const error = new Error(message) as RetryableError;
  error.retryable = true;
  return error;
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export function useRecorder(): RecorderHandle {
  const [state, setState] = useState<CaptureState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  /** Set at the first stop, so a retry does not re-measure the night. */
  const durationRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const bytesRef = useRef(0);
  const targetRef = useRef<{
    recordingId: string;
    uploadUrl: string;
    ticket: string;
  } | null>(null);

  /** Slices waiting, and whether the drain loop is already running. */
  const queueRef = useRef<{ seq: number; blob: Blob }[]>([]);
  const drainingRef = useRef(false);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          // Labels are blank until the microphone has been allowed
          // once. Numbering them keeps the picker usable before that
          // instead of showing four identical empty rows.
          label: d.label || `Microphone ${i + 1}`,
        }));
      setDevices(inputs);
      setDeviceId((current) =>
        current && inputs.some((d) => d.deviceId === current)
          ? current
          : (inputs[0]?.deviceId ?? null)
      );
    } catch {
      /* An enumerate that fails leaves the default device, which works. */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  /**
   * Send whatever is queued, oldest first, retrying with backoff.
   *
   * One loop at a time — `drainingRef` — so a slice arriving mid-drain
   * joins the queue rather than starting a second uploader and racing
   * it. A slice that will not go after six tries is left at the head of
   * the queue and reported: it is still in memory, and stopping will
   * try again.
   */
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const target = targetRef.current;
        if (!target) break;
        const item = queueRef.current[0];
        let sent = false;
        for (let attempt = 0; attempt < MAX_ATTEMPTS && !sent; attempt++) {
          try {
            const res = await fetch(
              chunkUrl(target.uploadUrl, target.recordingId, item.seq),
              {
                method: "POST",
                headers: {
                  "content-type": "application/octet-stream",
                  "x-recorder-ticket": target.ticket,
                },
                body: item.blob,
              }
            );
            if (!res.ok) throw new Error(`the server answered ${res.status}`);
            sent = true;
          } catch (e) {
            if (attempt === MAX_ATTEMPTS - 1) {
              setError(
                `Could not upload part ${item.seq} — ${
                  e instanceof Error ? e.message : String(e)
                }. It is still here and will be retried.`
              );
            } else {
              await new Promise((r) =>
                setTimeout(r, Math.min(30000, 1000 * 2 ** attempt))
              );
            }
          }
        }
        if (!sent) break;
        queueRef.current.shift();
        setPending(queueRef.current.length);
        setError(null);
      }
    } finally {
      drainingRef.current = false;
    }
  }, []);

  /** Everything the browser is holding open, released. */
  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Stopping the tracks is what turns the tab's recording indicator
    // off. Leaving them live is how a browser sits there with the
    // microphone hot after the GM thinks they have stopped.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    // recorderRef is deliberately NOT cleared here. If stop() fails —
    // the tunnel is down for the thirty seconds you press Stop — the
    // slices are still in the queue and pressing Stop again has to be
    // able to try the whole close again. Clearing it made the second
    // press a no-op and stranded the session's last minutes with
    // nothing on screen to press. start() is where it is replaced.
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(
    async (target: {
      recordingId: string;
      uploadUrl: string;
      ticket: string;
    }) => {
      setError(null);
      setState("starting");
      seqRef.current = 0;
      bytesRef.current = 0;
      setBytes(0);
      setElapsed(0);
      queueRef.current = [];
      setPending(0);
      targetRef.current = target;
      recorderRef.current = null;
      durationRef.current = null;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId
            ? { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } }
            : AUDIO_CONSTRAINTS,
        });
        streamRef.current = stream;
        // Labels only exist once permission has been given, so the
        // picker is worth rebuilding now that it has been.
        void refreshDevices();

        const mimeType = pickMime();
        const recorder = new MediaRecorder(
          stream,
          mimeType
            ? { mimeType, audioBitsPerSecond: BITS_PER_SECOND }
            : { audioBitsPerSecond: BITS_PER_SECOND }
        );
        recorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) return;
          bytesRef.current += event.data.size;
          setBytes(bytesRef.current);
          queueRef.current.push({ seq: seqRef.current++, blob: event.data });
          setPending(queueRef.current.length);
          void drain();
        };

        /* The level meter. An analyser on the same stream, read on
           animation frames — it is the only way to know from across
           the room that the far end of the table is reaching the mic,
           and finding that out afterwards is finding it out too late. */
        const AudioCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtor) {
          const ctx = new AudioCtor();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          const buffer = new Uint8Array(analyser.fftSize);
          const tick = () => {
            analyser.getByteTimeDomainData(buffer);
            let peak = 0;
            for (const sample of buffer) {
              const v = Math.abs(sample - 128) / 128;
              if (v > peak) peak = v;
            }
            setLevel(peak);
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        }

        startedAtRef.current = Date.now();
        recorder.start(SLICE_MS);
        setState("recording");
      } catch (e) {
        teardown();
        targetRef.current = null;
        setState("idle");
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    [deviceId, drain, refreshDevices, teardown]
  );

  /** The clock, ticking only while something is being recorded. */
  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(
      () => setElapsed((Date.now() - startedAtRef.current) / 1000),
      500
    );
    return () => clearInterval(id);
  }, [state]);

  /**
   * A tab closed mid-session takes the queue with it.
   *
   * The browser will only show its own generic wording, but the prompt
   * is the point: the difference between "are you sure" and no prompt
   * at all is a session that survives a stray Cmd-W.
   */
  useEffect(() => {
    // Also while parts are still queued after a failed stop: at that
    // point the state has gone back to idle but the only copy of the
    // last few minutes is in this tab.
    if (state === "idle" && pending === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state, pending]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    const target = targetRef.current;
    if (!recorder || !target) return null;
    setState("stopping");

    // The last slice arrives through ondataavailable AFTER stop() is
    // called, so the recorder's own onstop is what says the audio is
    // all here. Waiting on a timer instead would sometimes cut the last
    // thirty seconds, which is where the session's cliffhanger is.
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    teardown();

    // Measured at the FIRST stop and kept. A second attempt after a
    // failed upload happens minutes later, and re-measuring would
    // report a four-hour session as four hours and six minutes.
    if (durationRef.current === null) {
      durationRef.current = (Date.now() - startedAtRef.current) / 1000;
    }
    const durationSec = durationRef.current;
    await drain();

    if (queueRef.current.length > 0) {
      setState("idle");
      // Flagged retryable, and that flag is load-bearing: the slices
      // are still in memory and pressing Finish again re-sends them,
      // so the caller must NOT mark the recording failed. A row that
      // says "failed" is a row that tells the GM to stop trying, with
      // the last minutes of the session still in the tab.
      throw retryable(
        `${queueRef.current.length} part(s) of the recording have not uploaded yet. Leave this tab open and press Finish upload again.`
      );
    }

    const res = await fetch(finishUrl(target.uploadUrl, target.recordingId), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-recorder-ticket": target.ticket,
      },
      body: JSON.stringify({
        mime: recorder.mimeType || pickMime() || "audio/webm",
        durationSec,
        parts: seqRef.current,
      }),
    });
    if (!res.ok) {
      setState("idle");
      throw retryable(
        `The home server would not close the recording (${res.status}). The audio is there; press Finish upload again.`
      );
    }

    targetRef.current = null;
    recorderRef.current = null;
    durationRef.current = null;
    setState("idle");
    return { durationSec, bytes: bytesRef.current };
  }, [drain, teardown]);

  return {
    state,
    elapsed,
    level,
    bytes,
    pending,
    error,
    devices,
    deviceId,
    setDeviceId,
    start,
    stop,
    refreshDevices,
  };
}
