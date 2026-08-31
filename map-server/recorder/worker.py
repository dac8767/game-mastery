"""Transcribe queued session recordings and post the result to Convex.

Runs beside the upload endpoint, in the same image, on the same volume,
and does the part that takes hours: ffmpeg down to 16 kHz mono, WhisperX
for the words and pyannote for who said them, then one POST back to the
app.

The queue is the filesystem. A recording with a ``job.json`` and no
``done`` marker is work; anything else is not. That survives a restart,
a power cut and a docker pull without a database, and the state is
readable with ``ls`` at three in the morning, which is when it will be
read.

Three properties worth stating because they are the difference between
this and a script that works once:

- **A job is claimed before it is started.** Two workers, or one worker
  restarted mid-job, must not transcribe the same four hours twice.
- **A failure is reported, not swallowed.** The app shows the message
  from here verbatim; a worker that dies quietly leaves a recording
  saying "Transcribing" for ever.
- **The audio is not deleted on success.** Transcripts are wrong
  sometimes, models improve, and the recording is the only copy.
  ``RECORDER_KEEP_DAYS`` is what removes it, on a clock, out loud.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DATA_ROOT = Path(os.environ.get("RECORDER_DATA", "/data/sessions"))
CONVEX_URL = os.environ.get("CONVEX_SITE_URL", "").rstrip("/")
INGEST_SECRET = os.environ.get("RECORDER_INGEST_SECRET", "")

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.environ.get(
    "WHISPER_COMPUTE_TYPE", "int8" if os.environ.get("WHISPER_DEVICE", "cpu") == "cpu" else "float16"
)
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en")
HF_TOKEN = os.environ.get("HF_TOKEN", "")

# How many voices to expect. Bounding it both ways stops the diarizer
# splitting one excited player into three people, which is its most
# common failure at a table where everybody talks over everybody.
MIN_SPEAKERS = int(os.environ.get("RECORDER_MIN_SPEAKERS", "2"))
MAX_SPEAKERS = int(os.environ.get("RECORDER_MAX_SPEAKERS", "8"))

# 0 keeps the audio for ever. Anything else is a nightly sweep.
KEEP_DAYS = int(os.environ.get("RECORDER_KEEP_DAYS", "0"))

POLL_SECONDS = int(os.environ.get("RECORDER_POLL_SECONDS", "20"))


def log(*args: object) -> None:
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), *args, flush=True)


def post(path: str, body: dict) -> None:
    """One POST to the app's ingest routes. Raises on anything but 2xx."""
    if not CONVEX_URL or not INGEST_SECRET:
        raise RuntimeError(
            "CONVEX_SITE_URL and RECORDER_INGEST_SECRET must both be set"
        )
    request = urllib.request.Request(
        f"{CONVEX_URL}{path}",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            # A header, never a query string: a URL ends up in logs.
            "x-recorder-secret": INGEST_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status >= 300:
            raise RuntimeError(f"{path} answered {response.status}")


def to_wav(source: Path, target: Path) -> None:
    """16 kHz mono PCM, which is what the models want anyway.

    Also repairs the container. The uploaded file is a concatenation of
    MediaRecorder slices, and while that is a valid stream, its
    duration header is whatever the first slice claimed. Decoding it
    once here means every timecode downstream is measured rather than
    trusted.
    """
    subprocess.run(
        [
            "ffmpeg", "-nostdin", "-y",
            "-i", str(source),
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            str(target),
        ],
        check=True,
        capture_output=True,
    )


def transcribe(wav: Path, out_dir: Path) -> dict:
    """Run WhisperX and return the JSON it wrote."""
    command = [
        "whisperx", str(wav),
        "--model", WHISPER_MODEL,
        "--device", WHISPER_DEVICE,
        "--compute_type", WHISPER_COMPUTE,
        "--output_format", "json",
        "--output_dir", str(out_dir),
        "--print_progress", "True",
    ]
    if WHISPER_LANGUAGE:
        command += ["--language", WHISPER_LANGUAGE]
    if HF_TOKEN:
        # Diarization is a separate model with its own licence — see
        # RECORDER.md. Without a token WhisperX still transcribes; every
        # segment simply arrives unattributed, which the app draws as
        # "Unattributed" rather than treating as an error.
        command += [
            "--diarize",
            "--hf_token", HF_TOKEN,
            "--min_speakers", str(MIN_SPEAKERS),
            "--max_speakers", str(MAX_SPEAKERS),
        ]
    else:
        log("no HF_TOKEN — transcribing without speaker labels")

    log("running:", " ".join(c for c in command if c != HF_TOKEN))
    subprocess.run(command, check=True)

    written = sorted(out_dir.glob("*.json"))
    if not written:
        raise RuntimeError("WhisperX wrote no JSON")
    return json.loads(written[0].read_text())


def segments_from(result: dict) -> list[dict]:
    """WhisperX's segments, trimmed to the four fields the app stores."""
    out = []
    for segment in result.get("segments", []):
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        row = {
            "start": float(segment.get("start") or 0.0),
            "end": float(segment.get("end") or segment.get("start") or 0.0),
            "text": text,
        }
        speaker = segment.get("speaker")
        if isinstance(speaker, str) and speaker.strip():
            row["speaker"] = speaker.strip()
        out.append(row)
    return out


def run_job(folder: Path) -> None:
    job = json.loads((folder / "job.json").read_text())
    recording_id = job["recordingId"]
    audio = Path(job["audio"])
    log("starting", recording_id, audio.name)

    post("/recorder/begin", {
        "recordingId": recording_id,
        "audioKey": job.get("audioKey"),
    })

    work = folder / "work"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    wav = work / "audio.wav"
    to_wav(audio, wav)
    result = transcribe(wav, work)
    segments = segments_from(result)
    log(recording_id, "->", len(segments), "segments")

    post("/recorder/transcript", {
        "recordingId": recording_id,
        "segments": segments,
        "language": result.get("language") or WHISPER_LANGUAGE,
        "durationSec": segments[-1]["end"] if segments else 0,
        "audioKey": job.get("audioKey"),
    })

    # The wav is the big one — an hour of 16 kHz PCM is 115 MB, and it
    # is derivable from the audio next to it in seconds.
    shutil.rmtree(work, ignore_errors=True)
    (folder / "done").write_text(str(time.time()))
    (folder / "job.json").unlink(missing_ok=True)
    log("finished", recording_id)


def claim(folder: Path) -> bool:
    """Take the job, or report that somebody else already has it.

    ``mkdir`` is the lock: it either creates the directory or raises,
    atomically, on every filesystem this will ever run on. A stale claim
    older than the timeout is broken, because the alternative is a
    crashed worker parking a recording for ever.
    """
    lock = folder / "claimed"
    try:
        lock.mkdir()
        return True
    except FileExistsError:
        stale = time.time() - lock.stat().st_mtime > 12 * 3600
        if stale:
            log("breaking a stale claim on", folder.name)
            # os.utime, not Path.touch: the claim is a DIRECTORY, and
            # touch() on one raises rather than restamping it.
            os.utime(lock, None)
            return True
        return False


def sweep_old_audio() -> None:
    if KEEP_DAYS <= 0:
        return
    cutoff = time.time() - KEEP_DAYS * 86400
    for folder in sorted(p for p in DATA_ROOT.iterdir() if p.is_dir()):
        marker = folder / "done"
        if not marker.exists() or marker.stat().st_mtime > cutoff:
            continue
        for audio in folder.glob("audio.*"):
            log("retention: removing", audio)
            audio.unlink(missing_ok=True)


def main() -> int:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    log("watching", DATA_ROOT, "model", WHISPER_MODEL, "on", WHISPER_DEVICE)
    while True:
        try:
            for job_file in sorted(DATA_ROOT.glob("*/job.json")):
                folder = job_file.parent
                if (folder / "done").exists() or not claim(folder):
                    continue
                try:
                    run_job(folder)
                except Exception as exc:  # noqa: BLE001 — reported, not raised
                    detail = str(exc)
                    if isinstance(exc, subprocess.CalledProcessError):
                        detail = (exc.stderr or b"")[-400:].decode(
                            "utf-8", "replace"
                        ) or f"{exc.cmd[0]} exited {exc.returncode}"
                    log("FAILED", folder.name, detail)
                    try:
                        post("/recorder/failed", {
                            "recordingId": folder.name,
                            "error": detail[:400],
                        })
                    except (urllib.error.URLError, RuntimeError) as post_err:
                        log("could not report the failure:", post_err)
                finally:
                    shutil.rmtree(folder / "claimed", ignore_errors=True)
            sweep_old_audio()
        except Exception as exc:  # noqa: BLE001 — the loop must not die
            log("worker loop error:", exc)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
