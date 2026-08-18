/**
 * Guard 3 — convex/_generated/api.d.ts lists every function module.
 *
 * The generated API is an explicit module list. Add a file under
 * convex/ without regenerating and `api.<module>` simply doesn't exist:
 * the app stops typechecking, or worse, a stale entry lingers pointing
 * at a module that was deleted. Codegen needs network access, so the
 * file is committed and can drift — this catches the drift.
 */

import { readdirSync } from "node:fs";
import { appPath, read } from "./lib.mjs";

/** convex/ files that are config or schema, not function modules. */
const NOT_MODULES = new Set(["schema.ts", "auth.config.ts", "convex.config.ts"]);

export const generatedApi = {
  name: "generated-api",
  description: "every convex/ module appears in _generated/api.d.ts",
  run() {
    const problems = [];
    const api = read("convex", "_generated", "api.d.ts");

    const modules = readdirSync(appPath("convex"))
      .filter((f) => f.endsWith(".ts") && !NOT_MODULES.has(f))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();

    if (modules.length === 0) {
      problems.push("found no function modules under convex/ — parser broken?");
      return problems;
    }

    for (const m of modules) {
      if (!api.includes(`import type * as ${m} from "../${m}.js";`)) {
        problems.push(`api.d.ts is missing the import for convex/${m}.ts`);
      }
      if (!new RegExp(`^\\s*${m}:\\s*typeof ${m};`, "m").test(api)) {
        problems.push(`api.d.ts fullApi is missing \`${m}\``);
      }
    }

    // The reverse direction: an entry with no file behind it.
    for (const [, listed] of api.matchAll(
      /import type \* as (\w+) from "\.\.\/(\w+)\.js";/g
    )) {
      if (!modules.includes(listed)) {
        problems.push(
          `api.d.ts references convex/${listed}.ts, which does not exist`
        );
      }
    }

    if (problems.length > 0) {
      problems.push("fix: run `npx convex dev` to regenerate api.d.ts");
    }
    return problems;
  },
};
