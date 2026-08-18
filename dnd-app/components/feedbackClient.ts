/**
 * Submitting into Derek's shared Supabase feedback table.
 *
 * Three apps write to one table, so `app` identifies which. It is a
 * CONSTANT, never a setting: anything that could make it wrong — a stale
 * preference, a copied config — files bugs under the wrong product and
 * nobody notices for weeks. A CHECK constraint on the column refuses
 * anything but the three exact strings.
 *
 * The publishable key ships in the bundle by design. It is Supabase's
 * replacement for the legacy anon key, and row-level security is what
 * protects the data, not the secrecy of the string: with this key the
 * table reads back empty, updates affect zero rows, and only inserts
 * work. The *secret* key must never appear here.
 *
 * Order matters. Attachments upload first, so a row can never point at a
 * file that failed to arrive; and `status` is never sent, because that's
 * Derek's triage state and a form that sets its own status is a form
 * marking its own homework.
 */

const BACKEND = {
  url: "https://agfdfkpoxnmmisifbrdj.supabase.co",
  publishableKey: "sb_publishable_7scoOBRcdzyGS8YVIVCtVA_Z1i5X4cA",
  bucket: "feedback-shots",
};

/** This app's row in the shared table. Never make this configurable. */
export const FEEDBACK_APP = "Game Mastery";

/**
 * The only three categories. Free text let ScriptCraft's table drift
 * into holding both "Bug" and "Bug Report"; a fixed list is the cheap
 * half of the fix.
 */
export const CATEGORIES = ["Bug Report", "Suggestion", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

export type FeedbackPayload = {
  category: Category;
  message: string;
  name: string;
  email: string;
};

const QUEUE_KEY = "gm-feedback-queue";
const QUEUE_MAX = 10;

const keyHeaders = () => ({ apikey: BACKEND.publishableKey });

/** Storage-path extension from the blob's MIME type. */
function extFromType(type: string): string {
  const sub = /^image\/([a-z0-9.+-]+)$/i.exec(type)?.[1]?.toLowerCase() ?? "";
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return sub.replace(/[^a-z0-9]/g, "") || "png";
}

/** Supabase puts the useful sentence in one of several fields. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const b = await res.json();
    return (
      b.error_description ?? b.msg ?? b.message ?? b.error ?? fallback
    );
  } catch {
    return fallback;
  }
}

/** Tauri sets this global; the web build never does. */
function isDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI__" in (window as unknown as Record<string, unknown>)
  );
}

async function uploadShot(shot: Blob): Promise<string> {
  const path = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${extFromType(shot.type)}`;

  const up = await fetch(
    `${BACKEND.url}/storage/v1/object/${BACKEND.bucket}/${path}`,
    {
      method: "POST",
      headers: { ...keyHeaders(), "Content-Type": shot.type || "image/png" },
      body: shot,
    }
  );
  if (!up.ok) throw new Error(await readError(up, "The image upload failed."));
  return path;
}

async function insertRow(
  payload: FeedbackPayload,
  attachmentPaths: string[]
): Promise<void> {
  const res = await fetch(`${BACKEND.url}/rest/v1/feedback`, {
    method: "POST",
    headers: {
      ...keyHeaders(),
      "Content-Type": "application/json",
      // RLS won't let us read the row back, so asking for it just
      // produces a confusing empty array.
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      app: FEEDBACK_APP,
      name: payload.name,
      email: payload.email,
      category: payload.category,
      message: payload.message,
      app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
      platform: isDesktop() ? "desktop" : "browser",
      attachments: attachmentPaths.length
        ? attachmentPaths.join(",")
        : null,
      // never send `status`
    }),
  });
  if (!res.ok) {
    throw new Error(
      await readError(res, "The feedback table refused the submission.")
    );
  }
}

// ---- the local retry queue ------------------------------------------
// Feedback is written at the exact moment someone is annoyed; losing it
// to a dropped connection is the worst possible time to fail. Failed
// submissions are queued with attachments as data URLs so they survive a
// restart, and drained on next launch.

type QueuedItem = {
  payload: FeedbackPayload;
  shots: string[]; // data URLs
  queuedAt: number;
};

function readQueue(): QueuedItem[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedItem[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedItem[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Quota or private browsing — the submission is already lost, and
    // throwing here would replace one failure with two.
  }
}

export function queuedCount(): number {
  if (typeof window === "undefined") return 0;
  return readQueue().length;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the attachment."));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function enqueue(
  payload: FeedbackPayload,
  shots: Blob[]
): Promise<void> {
  const encoded: string[] = [];
  for (const shot of shots) {
    try {
      encoded.push(await blobToDataUrl(shot));
    } catch {
      // Drop an unreadable attachment rather than the whole report.
    }
  }
  const items = [...readQueue(), { payload, shots: encoded, queuedAt: 0 }];
  // Oldest out, so a long offline stretch can't grow without bound.
  writeQueue(items.slice(-QUEUE_MAX));
}

/**
 * Submit one report. Attachments upload first; on any failure the whole
 * thing is queued locally and retried later rather than lost.
 *
 * Returns "sent" or "queued" so the UI can be honest about which.
 */
export async function submitFeedback(
  payload: FeedbackPayload,
  shots: Blob[]
): Promise<"sent" | "queued"> {
  try {
    const paths: string[] = [];
    for (const shot of shots) paths.push(await uploadShot(shot));
    await insertRow(payload, paths);
    return "sent";
  } catch (err) {
    await enqueue(payload, shots);
    throw err instanceof Error ? err : new Error("The submission failed.");
  }
}

/**
 * Retry everything queued. Stops at the first failure and keeps the
 * rest — if the network is still down, draining the whole queue just
 * burns it.
 */
export async function drainQueue(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const items = readQueue();
  if (items.length === 0) return 0;

  let sent = 0;
  for (const item of items) {
    try {
      const blobs = await Promise.all(item.shots.map(dataUrlToBlob));
      const paths: string[] = [];
      for (const blob of blobs) paths.push(await uploadShot(blob));
      await insertRow(item.payload, paths);
      sent++;
    } catch {
      break;
    }
  }

  if (sent > 0) writeQueue(items.slice(sent));
  return sent;
}
