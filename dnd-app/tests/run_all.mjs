#!/usr/bin/env node
/**
 * The guard suite. Run it before calling anything done:
 *
 *   npm run guards               all seven
 *   npm run guards -- --fast     skip the slow build guard
 *   npm run guards -- --only unit,integrity   just those two
 *
 * --only is the only supported way to run one guard. The guard files
 * themselves EXPORT a { name, run } object and do nothing when executed
 * directly, so `node tests/guards/unit.mjs` imports the module, checks
 * nothing, and exits 0 — which is a green run that tested nothing, the
 * exact failure this suite exists to prevent. An --only name that
 * matches no guard is an error rather than an empty run, for the same
 * reason.
 *
 * Why this exists: the failure mode that costs the most is not a crash,
 * it's a silent one — a reference that no longer resolves, a visibility
 * rule that quietly stopped applying. Those survive review and survive
 * "it looked fine when I clicked around". Each guard below encodes one
 * such invariant so it fails loudly instead.
 *
 * A guard that cannot find what it is meant to inspect FAILS rather than
 * passing quietly; a green run that checked nothing is the exact thing
 * this suite exists to prevent.
 */

import { typecheckApp, typecheckConvex } from "./guards/typecheck.mjs";
import { generatedApi } from "./guards/generated_api.mjs";
import { integrity } from "./guards/integrity.mjs";
import { dmVisibility } from "./guards/dm_visibility.mjs";
import { unit } from "./guards/unit.mjs";
import { build } from "./guards/build.mjs";

const GUARDS = [
  typecheckApp,
  typecheckConvex,
  generatedApi,
  integrity,
  dmVisibility,
  unit,
  build,
];

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

const args = process.argv.slice(2);
const fast = args.includes("--fast");

/** Names given as `--only unit,build` or `--only unit --only build`. */
const only = args.flatMap((arg, i) =>
  args[i - 1] === "--only" ? arg.split(",").map((n) => n.trim()) : []
);

const unknown = only.filter((n) => !GUARDS.some((g) => g.name === n));
if (unknown.length > 0) {
  console.log(
    `\n${RED}No guard named ${unknown.join(", ")}.${OFF} ` +
      `Available: ${GUARDS.map((g) => g.name).join(", ")}\n`
  );
  process.exit(2);
}

const selected = GUARDS.filter(
  (g) => (only.length === 0 || only.includes(g.name)) && !(fast && g.slow)
);

if (selected.length === 0) {
  console.log(`\n${RED}Nothing selected to run.${OFF}\n`);
  process.exit(2);
}

console.log(
  `\nRunning ${selected.length} guard${selected.length === 1 ? "" : "s"}${
    fast && only.length === 0 ? " (fast: build skipped)" : ""
  }\n`
);

let failed = 0;

for (const guard of selected) {
  process.stdout.write(`  ${guard.name.padEnd(18)} `);
  let problems;
  try {
    problems = await guard.run();
  } catch (err) {
    // A thrown error means the guard could not inspect what it targets
    // — treat that as a failure, never as a pass.
    problems = [`guard could not run: ${err.message}`];
  }

  if (problems.length === 0) {
    console.log(`${GREEN}ok${OFF}  ${DIM}${guard.description}${OFF}`);
  } else {
    failed++;
    console.log(`${RED}FAIL${OFF}  ${DIM}${guard.description}${OFF}`);
    for (const p of problems) console.log(`      ${RED}·${OFF} ${p}`);
  }
}

if (failed === 0) {
  console.log(
    `\n${GREEN}All ${selected.length} guard${
      selected.length === 1 ? "" : "s"
    } green.${OFF}\n`
  );
  process.exit(0);
} else {
  console.log(`\n${RED}${failed} guard(s) failed.${OFF}\n`);
  process.exit(1);
}
