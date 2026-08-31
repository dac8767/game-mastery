"""Upload endpoint for the Game Mastery session recorder.

The browser records a session in thirty-second slices and posts each one
here. This process does nothing but receive them, put them in order, and
leave a job on disk for the worker. Transcription is deliberately NOT in
this process: it takes hours, and an upload endpoint that is busy for
hours is an upload endpoint that drops the second half of a session.

Authentication is a ticket, not a password. The app mints one per
recording — ``<recordingId>.<expiry>.<hmac>`` — signed with a secret
this process shares with the Convex deployment and with nothing else.
Verifying it needs no round trip and no state, which matters when a
four-hour session is four hundred and eighty POSTs.

A ticket grants writing and deleting ONE recording, and expires the same
night. Somebody who copies one out of a browser can overwrite the audio
of the session they were already at.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

DATA_ROOT = Path(os.environ.get("RECORDER_DATA", "/data/sessions"))
SECRET = os.environ.get("RECORDER_UPLOAD_SECRET", "")
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("RECORDER_ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]

# A Convex id is lowercase alphanumeric. Pinned with a regex because
# this value becomes a directory name: "../" in a path segment is the
# oldest hole there is, and a whitelist closes it more reliably than
# any amount of normalising afterwards.
ID_RE = re.compile(r"^[a-z0-9]{16,64}$")

# One slice is thirty seconds of 32 kbps Opus, about 120 KB. Ten
# megabytes is a wide margin for a browser that batched a few together,
# and a firm no to anything trying to fill the array.
MAX_SLICE_BYTES = 10 * 1024 * 1024

# Four hours of thirty-second slices is 480. Double it and stop.
MAX_PARTS = 2000

MIME_EXT = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
}

app = FastAPI(title="Game Mastery session recorder")

if ALLOWED_ORIGINS:
    # The ticket travels in a custom header, which makes every upload a
    # preflighted request. Without this the browser never sends the POST
    # at all and the console says "CORS" rather than anything about
    # recording.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["POST", "DELETE", "OPTIONS"],
        allow_headers=["content-type", "x-recorder-ticket"],
        max_age=86400,
    )


def _verify(ticket: str | None, recording_id: str) -> None:
    """Raise unless the ticket is a live signature over this recording."""
    if not SECRET:
        raise HTTPException(503, "RECORDER_UPLOAD_SECRET is not set")
    if not ticket:
        raise HTTPException(401, "no ticket")
    parts = ticket.split(".")
    if len(parts) != 3:
        raise HTTPException(401, "malformed ticket")
    signed_id, expires, signature = parts
    # The id is checked against the PATH as well as the signature. A
    # valid ticket for one recording must not write to another, and
    # signature-only checking would let it.
    if signed_id != recording_id:
        raise HTTPException(403, "ticket is for another recording")
    try:
        if int(expires) < time.time():
            raise HTTPException(401, "ticket expired")
    except ValueError:
        raise HTTPException(401, "malformed ticket") from None
    expected = hmac.new(
        SECRET.encode(), f"{signed_id}.{expires}".encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(403, "bad ticket")


def _dir(recording_id: str) -> Path:
    if not ID_RE.match(recording_id):
        raise HTTPException(400, "bad recording id")
    return DATA_ROOT / recording_id


@app.get("/health")
def health() -> dict:
    return {"ok": True, "root": str(DATA_ROOT), "configured": bool(SECRET)}


@app.post("/chunk/{recording_id}/{seq}")
async def chunk(
    recording_id: str,
    seq: int,
    request: Request,
    x_recorder_ticket: str | None = Header(default=None),
) -> dict:
    _verify(x_recorder_ticket, recording_id)
    if seq < 0 or seq >= MAX_PARTS:
        raise HTTPException(400, "sequence out of range")

    body = await request.body()
    if len(body) > MAX_SLICE_BYTES:
        raise HTTPException(413, "slice too large")

    parts = _dir(recording_id) / "parts"
    parts.mkdir(parents=True, exist_ok=True)

    # Written to a temporary name and renamed, so a slice interrupted
    # halfway can never be picked up as complete. The name is zero
    # padded because assembly sorts by filename and part 10 must not
    # come between 1 and 2.
    target = parts / f"{seq:06d}.part"
    temp = parts / f"{seq:06d}.part.tmp"
    temp.write_bytes(body)
    temp.replace(target)
    return {"ok": True, "bytes": len(body)}


@app.post("/finish/{recording_id}")
async def finish(
    recording_id: str,
    request: Request,
    x_recorder_ticket: str | None = Header(default=None),
) -> dict:
    _verify(x_recorder_ticket, recording_id)
    folder = _dir(recording_id)
    parts = folder / "parts"
    if not parts.is_dir():
        raise HTTPException(404, "nothing was uploaded")

    try:
        body = await request.json()
    except Exception:
        body = {}
    mime = str(body.get("mime") or "audio/webm").split(";")[0].strip()
    ext = MIME_EXT.get(mime, ".webm")

    # Concatenation, in filename order. WebM slices after the first are
    # not standalone files — they are a continuation of one stream — so
    # this is not "merging recordings", it is putting a single stream
    # back together, and the order is not negotiable.
    audio = folder / f"audio{ext}"
    with audio.open("wb") as out:
        for part in sorted(parts.glob("*.part")):
            with part.open("rb") as src:
                shutil.copyfileobj(src, out)

    job = {
        "recordingId": recording_id,
        "audioKey": f"{recording_id}/{audio.name}",
        "audio": str(audio),
        "mime": mime,
        "durationSec": body.get("durationSec"),
        "parts": len(list(parts.glob("*.part"))),
        "queuedAt": time.time(),
    }
    # The job file is what the worker looks for, so it is written LAST
    # and atomically. A worker that finds a job file can rely on the
    # audio beside it being whole.
    tmp = folder / "job.json.tmp"
    tmp.write_text(json.dumps(job))
    tmp.replace(folder / "job.json")

    shutil.rmtree(parts, ignore_errors=True)
    return {"ok": True, "audioKey": job["audioKey"], "bytes": audio.stat().st_size}


@app.delete("/recording/{recording_id}")
def remove(
    recording_id: str,
    x_recorder_ticket: str | None = Header(default=None),
) -> Response:
    _verify(x_recorder_ticket, recording_id)
    shutil.rmtree(_dir(recording_id), ignore_errors=True)
    return Response(status_code=204)
