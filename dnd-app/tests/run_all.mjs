#!/usr/bin/env node
/**
 * The guard suite. Run it before calling anything done:
 *
 *   npm run guards          all six
 *   npm run guards -- --fast  skip the slow build guard
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
import { build } from "./guards/build.mjs";

const GUARDS = [
  typecheckApp,
  typecheckConvex,
  generatedApi,
  integrity,
  dmVisibility,
  build,
];

const fast = process.argv.includes("--fast");
const selected = fast ? GUARDS.filter((g) => !g.slow) : GUARDS;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

let failed = 0;

console.log(
  `\nRunning ${selected.length} guard${selected.length === 1 ? "" : "s"}${
    fast ? " (fast: build skipped)" : ""
  }\n`
);

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
  console.log(`\n${GREEN}All ${selected.length} guards green.${OFF}\n`);
  process.exit(0);
} else {
  console.log(`\n${RED}${failed} guard(s) failed.${OFF}\n`);
  process.exit(1);
}
