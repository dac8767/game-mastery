# Session Recorder — setting up the home server half

Record a session in the browser, transcribe it on the PowerEdge, get
the notes back in Game Mastery.

```
laptop on the table                PowerEdge                     Convex
──────────────────────             ─────────                     ──────
MediaRecorder                      recorder-api
  30s slice ──POST /chunk/…────────► parts/000000.part
  30s slice ──POST /chunk/…────────► parts/000001.part
  …                                       │
  Stop     ──POST /finish/…───────► audio.webm + job.json
                                          │
                                   recorder-worker
                                     ffmpeg → 16 kHz mono
                                     WhisperX + pyannote
                                          │
                                          └──POST /recorder/transcript──►
                                                                    stored
                                                                       │
                                                        "Write the notes"
                                                                       ▼
                                                                    Claude
```

## Why it is arranged this way

**The audio never enters Convex.** The free tier is a gigabyte of file
storage and four hours of a session is about sixty megabytes, so the
seventeenth session would fail — during a game. More to the point,
nothing that takes four hours can run inside a Convex action. The
PowerEdge already has the disk, the tunnel and the uptime.

**Nothing new is exposed to the internet.** The recorder answers behind
the same Cloudflare tunnel that already serves the battle maps. No
router port is opened.

**Two secrets, one per direction.** The browser is given a *ticket* —
an HMAC over one recording id and an expiry — not a password. It grants
uploading and deleting that one recording and stops working the same
night. The transcript coming back is authenticated separately, so a bug
that leaked the upload side would not let anyone write transcripts.

## Setup

### 1. Secrets

On the PowerEdge, beside `docker-compose.yml`:

```bash
cd ~/map-server
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the first into `RECORDER_UPLOAD_SECRET` and the second into
`RECORDER_INGEST_SECRET` in `.env`, then set `CONVEX_SITE_URL` and
`RECORDER_ALLOWED_ORIGINS`.

`CONVEX_SITE_URL` is the **`.convex.site`** host, not the
`.convex.cloud` one the app connects to. It is
`NEXT_PUBLIC_CONVEX_URL` with `.cloud` swapped for `.site`.

### 2. The same values on Convex

In `dnd-app/`, with the **same two strings**:

```bash
npx convex env set RECORDER_UPLOAD_SECRET <the first one>
npx convex env set RECORDER_INGEST_SECRET <the second one>
npx convex env set RECORDER_UPLOAD_URL https://maps.yourdomain.com/recorder
```

`RECORDER_UPLOAD_URL` is the tunnel hostname with `/recorder` on the
end — the path the Caddyfile proxies. It must be `https`; the app
refuses anything else, because a typo that downgraded it would put a
session's audio across the internet in the clear with nothing on screen
changing.

### 3. Speaker labels

WhisperX transcribes on its own. Telling voices apart is a *second*
model — pyannote — with its own licence, and it needs three things:

1. A HuggingFace account and a read token
   (huggingface.co → Settings → Access Tokens).
2. Accepting the terms on **both** model pages while signed in:
   `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0`.
   Skipping the second is the usual cause of a worker that fails at the
   diarization step having transcribed fine.
3. `HF_TOKEN=` in `.env`.

Leave `HF_TOKEN` empty and everything still works — every line simply
arrives as "Unattributed". That is a reasonable place to start, and you
can add the token later and re-run.

### 4. Build and start

```bash
cd ~/map-server
docker compose build recorder-api
docker compose up -d
docker compose logs -f recorder-worker
```

The build pulls PyTorch and takes a while; the image is five or six
gigabytes. The first transcription also downloads the model — another
few gigabytes, into the `recorder_models` volume so it happens once.

On a GPU box, build with:

```bash
docker compose build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124 recorder-api
```

and set `WHISPER_DEVICE=cuda` in `.env`.

### 5. Check it

```bash
curl -s https://maps.yourdomain.com/recorder/health
```

`{"ok":true,...,"configured":true}` — `configured:false` means the
container did not get `RECORDER_UPLOAD_SECRET`.

Then open **Session Recorder** in the app. If it shows setup
instructions instead of a Record button, `RECORDER_UPLOAD_URL` or
`RECORDER_UPLOAD_SECRET` is missing on the Convex side.

## The part that actually decides the quality

Not the model. **The microphone.**

A laptop's built-in mic on one end of a table picks up whoever is
sitting behind it and treats the far end as room noise. No transcriber
recovers what was never captured, and the person you most want
transcribed is always the one furthest away.

The screen has a level meter for exactly this. Before the session
starts, get the person at the far end to talk and watch it move. If it
barely does, move the laptop to the middle of the table — and if that
is not enough, a £40 USB boundary microphone in the centre is the single
biggest improvement available, larger than any change of model.

The recorder also asks for the microphone with echo cancellation and
noise suppression **off**. Both are tuned for one voice close to one
mic and gate out the far side of a room. Gain control stays on.

## Costs

| | |
|---|---|
| Recording, upload, storage | free — your disk |
| Transcription | free — your CPU, a few hours for a four-hour session |
| Session notes | a Claude API call, well under a dollar per session |

The notes are the only paid part and they are opt-in per recording. A
recording with a transcript and no summary is a finished thing; the
button that writes the notes only appears when `ANTHROPIC_API_KEY` is
set on the Convex deployment.

## Where things are

```
/mnt/Media/game-mastery/sessions/<recordingId>/
    parts/000000.part …     while uploading; removed when assembled
    audio.webm              the session
    job.json                queued; the worker deletes it when finished
    claimed/                a worker has it (a lock, broken after 12h)
    done                    transcript delivered, with a timestamp
```

That is the whole queue. `ls` answers every question about what state a
recording is in, which matters at 1am more than a status page would.

**Deleting a campaign in the app does not delete these files.** The
purge sweeps the database, and the audio is on a disk in the basement
that Convex has no reach into. `RECORDER_KEEP_DAYS` is the automatic
answer; `rm -rf` on the folder is the manual one.

## When something goes wrong

**"Waiting to transcribe" for ever** — the worker is not running or
cannot reach Convex. `docker compose logs recorder-worker`.

**"Transcribing" for ever** — check the same log. A crashed worker
leaves a `claimed/` directory, which is broken automatically after
twelve hours; `rm -rf` on it retries sooner.

**Parts waiting to upload, during a session** — the tunnel or the wifi
dropped. The slices are held in the tab's memory and retried; leave the
tab open. Closing it loses whatever has not gone up.

**Nothing uploads and the browser console says CORS** — the app's origin
is not in `RECORDER_ALLOWED_ORIGINS`. It must be the exact origin, with
no trailing slash.

**Everything attributed to one speaker** — either `HF_TOKEN` is unset
(check the worker log for "no HF_TOKEN") or the mic only heard one end
of the table. The percentages beside each speaker in the app tell the
two apart.

## Re-running a transcript

Better model, or a token added after the fact:

```bash
cd /mnt/Media/game-mastery/sessions/<recordingId>
rm -rf claimed done
cat > job.json <<'JSON'
{"recordingId":"<recordingId>","audio":"/data/sessions/<recordingId>/audio.webm","audioKey":"<recordingId>/audio.webm"}
JSON
```

Substitute the real id in all three places, and check the extension
against what is actually in the folder — a browser without WebM leaves
`audio.m4a` there instead. The paths inside `job.json` are the
**container's** (`/data/sessions/...`), not the host's.

The worker picks it up within twenty seconds and **replaces** the
stored transcript rather than appending to it. Speaker names you have
typed are kept only where the new run produces the same tags, so expect
to name them again.
