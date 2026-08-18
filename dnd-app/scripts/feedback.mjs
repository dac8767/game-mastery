#!/usr/bin/env node
/**
 * Print Game Mastery feedback from the shared Supabase table.
 *
 *   export SUPABASE_SECRET_KEY='sb_secret_…'      # keep it in your shell
 *   npm run feedback            # incomplete only (the default)
 *   npm run feedback -- --all   # including Complete
 *   npm run feedback -- --json  # raw, for piping
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
 */

const URL_BASE = "https://agfdfkpoxnmmisifbrdj.supabase.co";
const APP = "Game Mastery";

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

const wantAll = process.argv.includes("--all");
const asJson = process.argv.includes("--json");

const params = new URLSearchParams({
  select:
    "created,status,category,name,email,message,app_version,platform,attachments",
  app: `eq.${APP}`,
  order: "created.desc",
});
// NULL status = never triaged, which is still incomplete.
if (!wantAll) params.set("or", "(status.is.null,status.neq.Complete)");

const res = await fetch(`${URL_BASE}/rest/v1/feedback?${params}`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Read failed — HTTP ${res.status}\n${body}`);
  process.exit(1);
}

const rows = await res.json();

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log(
    wantAll
      ? `No ${APP} feedback at all yet.`
      : `No incomplete ${APP} feedback. (Run with --all to include Complete.)`
  );
  process.exit(0);
}

console.log(
  `${rows.length} ${wantAll ? "" : "incomplete "}${APP} report${
    rows.length === 1 ? "" : "s"
  }\n`
);

for (const r of rows) {
  const when = String(r.created ?? "").replace("T", " ").slice(0, 16);
  console.log("─".repeat(72));
  console.log(
    `${r.category ?? "—"}   ${r.status ?? "(untriaged)"}   ${when}`
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
