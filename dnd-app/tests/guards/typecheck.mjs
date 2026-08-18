/**
 * Guards 1 & 2 — the type system, run over both halves of the app.
 *
 * `convex/` has its own tsconfig and is NOT covered by the app's
 * typecheck, so a backend-only break passes the frontend check. Both
 * have to run.
 */

import { spawnSync } from "node:child_process";
import { APP_ROOT } from "./lib.mjs";

function tsc(args) {
  const r = spawnSync("npx", ["tsc", "--noEmit", ...args], {
    cwd: APP_ROOT,
    encoding: "utf8",
  });
  if (r.status === 0) return [];
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return out ? out.split("\n").slice(0, 30) : ["tsc failed with no output"];
}

export const typecheckApp = {
  name: "typecheck-app",
  description: "tsc --noEmit over the Next.js app",
  run: () => tsc([]),
};

export const typecheckConvex = {
  name: "typecheck-convex",
  description: "tsc --noEmit -p convex over the backend",
  run: () => tsc(["-p", "convex"]),
};
