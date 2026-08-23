#!/usr/bin/env node
/**
 * Download the screenshots attached to Game Mastery feedback.
 *
 *   export SUPABASE_SECRET_KEY='sb_secret_…'
 *   node scripts/feedback-shots.mjs <filename> [<filename> …]
 *   node scripts/feedback-shots.mjs --all     every incomplete report's
 *
 * A report that says "see attached" or "remove the items in the
 * screenshot" is unreadable without the image, and guessing at it wastes
 * a round trip. This is the other half of `npm run feedback`.
 *
 * The secret key is read from the environment and never written down —
 * same rule as feedback.mjs, and the same reason: the publishable key
 * that ships in the app is insert-only, so reading needs the secret one
 * and the secret one must never reach a repo or a chat log.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const URL_BASE = "https://agfdfkpoxnmmisifbrdj.supabase.co";
const BUCKET = "feedback-shots";
const OUT = process.env.FEEDBACK_SHOT_DIR ?? "feedback-shots";

const key = process.env.SUPABASE_SECRET_KEY;
if (!key) {
  console.error(
    "SUPABASE_SECRET_KEY is not set. Export it in your shell first —\n" +
      "it must not be written into this repo or pasted into a chat."
  );
  process.exit(1);
}

const args = process.argv.slice(2);

/** Attachment filenames on every incomplete Game Mastery report. */
async function allPending() {
  const res = await fetch(
    `${URL_BASE}/rest/v1/feedback` +
      `?select=attachments&app=eq.Game%20Mastery&attachments=not.is.null`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) {
    throw new Error(`could not list feedback: ${res.status} ${res.statusText}`);
  }
  const rows = await res.json();
  return rows
    .flatMap((r) => String(r.attachments ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

const names = args.includes("--all")
  ? await allPending()
  : args.filter((a) => !a.startsWith("--"));

if (names.length === 0) {
  console.error("Nothing to fetch. Pass filenames, or --all.");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

let ok = 0;
for (const name of names) {
  const res = await fetch(
    `${URL_BASE}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) {
    console.error(`${name}: ${res.status} ${res.statusText}`);
    continue;
  }
  const path = join(OUT, name);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(path);
  ok++;
}

console.log(`\n${ok} of ${names.length} downloaded into ${OUT}/`);
