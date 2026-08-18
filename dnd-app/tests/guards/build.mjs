/**
 * Guard 6 — the app actually builds.
 *
 * Typechecking passes on plenty of code that fails to build: a bad
 * import path, a server/client boundary violation, a page that throws
 * during prerender. This is the guard that proves a clean checkout
 * produces a working app.
 *
 * NEXT_PUBLIC_CONVEX_URL is supplied as a placeholder because the build
 * constructs a ConvexReactClient at prerender time and throws without
 * one. It is never used to reach a real deployment here.
 */

import { spawnSync } from "node:child_process";
import { APP_ROOT } from "./lib.mjs";

export const build = {
  name: "build",
  description: "next build succeeds from the working tree",
  slow: true,
  run() {
    const r = spawnSync("npx", ["next", "build"], {
      cwd: APP_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_CONVEX_URL:
          process.env.NEXT_PUBLIC_CONVEX_URL ??
          "https://placeholder.convex.cloud",
      },
    });
    if (r.status === 0) return [];
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n");
    return out.slice(-25);
  },
};
