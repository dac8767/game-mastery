#!/usr/bin/env node
/**
 * Read Game Mastery feedback from the shared Supabase table, and close
 * the reports whose work is done.
 *
 *   export SUPABASE_SECRET_KEY='sb_secret_…'      in your shell
 *   npm run feedback                  incomplete only (the default)
 *   npm run feedback -- --all         including Complete
 *   npm run feedback -- --json        raw, for piping
 *   npm run feedback -- --complete <uuid> <uuid>   mark those Complete
 *   npm run feedback -- --complete <uuid> --dry-run  say what it would do
 *
 * The secret key is read from the environment and never written down:
 * not in this repo, not in a config file, not in a chat log. Reading the
 * table requires it because the publishable key that ships in the app is
 * insert-only — RLS returns an empty array for reads, which is a filter
 * doing its job, not an empty table.
 *
 * "Incomplete" deliberately includes rows whose status is NULL. A
 * brand-new submission has no triage state yet, and PostgREST's
 * `status=neq.Complete` drops NULLs (SQL three-valued logic), so the
 * newest feedback — the reason you ran this — would be exactly what went
 * missing.
 *
 * On closing reports
 * ------------------
 * Status used to be Derek's alone, set in the dashboard. He asked for
 * this instead: say "feedback", and the items he filed get worked and
 * then closed. So the write lives here, deliberately narrow:
 *
 *   - Ids are named explicitly. There is no "close everything you just
 *     listed" — the listing and the closing are separate decisions, and
 *     conflating them is how a report nobody read gets marked done.
 *   - Every id is fetched and PRINTED before anything is written, so a
 *     mistyped id is a visible mismatch rather than a silent no-op.
 *   - The update is scoped to app=Game Mastery as well as to the id. A
 *     wrong id cannot reach ScriptCraft's or Fear the Reaper's feedback
 *     from this script, whatever it addresses.
 *   - Anything already Complete is left alone and said out loud, so
 *     re-running a block is safe and honest about what it did.
 */

import { parseOrExit } from "./args.mjs";

const URL_BASE = "https://agfdfkpoxnmmisifbrdj.supabase.co";
const APP = "Game Mastery";
const DONE = "Complete";

const USAGE = `Usage: npm run feedback [-- options]

  --all               include reports already marked Complete
  --json              print the raw rows instead of the report
  --complete <id...>  mark the named ids Complete (ids are positionals)
  --dry-run           with --complete, show the change without making it`;

const { positionals, flags } = parseOrExit(
  process.argv.slice(2),
  {
    "--all": {},
    "--json": {},
    "--complete": {},
    "--dry-run": {},
  },
  USAGE
);

const key = process.env.SUPABASE_SECRET_KEY;
if (!key) {
  console.error(
    "SUPABASE_SECRET_KEY is not set.\n\n" +
      "  export SUPABASE_SECRET_KEY='sb_secret_…'\n\n" +
      "Get it from the Supabase dashboard (Project Settings → API keys).\n" +
      "Keep it in your shell — never commit it, and never paste it into a chat."
  );
  process.exit(1);
}

const auth = { apikey: key, Authorization: `Bearer ${key}` };

async function api(path, init) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...auth, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} on ${path}\n${body}`);
  }
  return res;
}

/** One line of provenance, so a report is recognisable before it changes. */
function summarize(r) {
  const when = String(r.created ?? "").replace("T", " ").slice(0, 16);
  const first = String(r.message ?? "")
    .trim()
    .split("\n")[0];
  const clipped = first.length > 64 ? `${first.slice(0, 61)}…` : first;
  return `${String(r.id).slice(0, 8)}  ${when}  ${r.status ?? "(untriaged)"}  ${clipped}`;
}

// ---------------------------------------------------------------------
// --complete
// ---------------------------------------------------------------------

if (flags["--complete"]) {
  // Ids are UUIDs. Validated rather than passed through, because these
  // go into a PostgREST `in.(…)` list: a value with a comma or a paren
  // in it would change the shape of the filter rather than fail it.
  const isId = (p) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p);
  const ids = positionals.filter(isId);
  const junk = positionals.filter((p) => !isId(p));

  if (junk.length > 0) {
    console.error(`Not an id: ${junk.join(", ")}\n\n${USAGE}`);
    process.exit(1);
  }
  if (ids.length === 0) {
    console.error(`--complete needs at least one id.\n\n${USAGE}`);
    process.exit(1);
  }

  // Read first. An id that matches nothing is a typo, and finding that
  // out from a PATCH that quietly affected zero rows is finding it out
  // too late to know which one you meant.
  const params = new URLSearchParams({
    select: "id,created,status,message",
    app: `eq.${APP}`,
    id: `in.(${ids.join(",")})`,
  });
  const found = await (await api(`feedback?${params}`)).json();

  const foundIds = new Set(found.map((r) => String(r.id)));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    console.error(
      `No ${APP} report with id ${missing.join(", ")}. Nothing was changed.`
    );
    process.exit(1);
  }

  const already = found.filter((r) => r.status === DONE);
  const todo = found.filter((r) => r.status !== DONE);

  for (const r of already) {
    console.log(`already ${DONE}: ${summarize(r)}`);
  }

  if (todo.length === 0) {
    console.log(`\nNothing to do — all ${found.length} already ${DONE}.`);
    process.exit(0);
  }

  console.log(`\nMarking ${DONE}:`);
  for (const r of todo) console.log(`  ${summarize(r)}`);

  if (flags["--dry-run"]) {
    console.log("\n--dry-run: nothing was written.");
    process.exit(0);
  }

  const patch = new URLSearchParams({
    app: `eq.${APP}`,
    id: `in.(${todo.map((r) => r.id).join(",")})`,
  });
  const res = await api(`feedback?${patch}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      // Ask for the updated rows back rather than trusting a 204: the
      // report is what actually changed, not what was requested.
      Prefer: "return=representation",
    },
    body: JSON.stringify({ status: DONE }),
  });

  const updated = await res.json();
  console.log(`\n${updated.length} marked ${DONE}.`);
  const stillOpen = updated.filter((r) => r.status !== DONE);
  if (stillOpen.length > 0) {
    console.error(
      `But ${stillOpen.length} came back not ${DONE} — check the dashboard.`
    );
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------

const params = new URLSearchParams({
  select:
    "id,created,status,category,name,email,message,app_version,platform,attachments",
  app: `eq.${APP}`,
  order: "created.desc",
});
// NULL status = never triaged, which is still incomplete.
if (!flags["--all"]) params.set("or", "(status.is.null,status.neq.Complete)");

const rows = await (await api(`feedback?${params}`)).json();

if (flags["--json"]) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log(
    flags["--all"]
      ? `No ${APP} feedback at all yet.`
      : `No incomplete ${APP} feedback. (Run with --all to include Complete.)`
  );
  process.exit(0);
}

console.log(
  `${rows.length} ${flags["--all"] ? "" : "incomplete "}${APP} report${
    rows.length === 1 ? "" : "s"
  }\n`
);

for (const r of rows) {
  const when = String(r.created ?? "").replace("T", " ").slice(0, 16);
  console.log("─".repeat(72));
  // The id leads the line because it is what --complete takes.
  console.log(
    `#${r.id}   ${r.category ?? "—"}   ${r.status ?? "(untriaged)"}   ${when}`
  );
  console.log(
    `${r.name ?? "—"} <${r.email ?? "—"}>   v${r.app_version ?? "?"} ${
      r.platform ?? ""
    }`
  );
  if (r.attachments) console.log(`attachments: ${r.attachments}`);
  console.log("");
  console.log(String(r.message ?? "").trim());
  console.log("");
}
