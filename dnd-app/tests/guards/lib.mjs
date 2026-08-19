/**
 * Shared helpers for the guards.
 *
 * The guards read source files and assert things TypeScript can't. A
 * guard that quietly matches nothing is worse than no guard at all — it
 * reports green while checking air — so every extractor here throws when
 * it finds nothing, and the runner treats that as a failure.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** dnd-app/ — the app root, two levels up from tests/guards/. */
export const APP_ROOT = resolve(here, "..", "..");

export function appPath(...parts) {
  return join(APP_ROOT, ...parts);
}

export function read(...parts) {
  const p = appPath(...parts);
  if (!existsSync(p)) {
    throw new Error(`expected file is missing: ${parts.join("/")}`);
  }
  return readFileSync(p, "utf8");
}

export function exists(...parts) {
  return existsSync(appPath(...parts));
}

/**
 * Extract the balanced `{ ... }` block that follows `startPattern`.
 * Brace-counting rather than regex, so nested objects don't truncate it.
 */
export function blockAfter(source, startPattern, label) {
  const m = source.match(startPattern);
  if (!m) {
    throw new Error(`could not locate ${label} — has it been renamed?`);
  }
  const open = source.indexOf("{", m.index);
  if (open === -1) throw new Error(`no object literal after ${label}`);

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${label}`);
}

/**
 * Top-level `key:` names inside an object-literal body. Nested objects
 * are skipped so only the fields of the block itself come back.
 */
export function topLevelKeys(body, label) {
  const keys = [];
  let depth = 0;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // Only lines that start at the block's own nesting level declare
    // fields of this block; anything deeper belongs to a nested object.
    if (depth === 0 && !line.startsWith("//")) {
      // `key: value` and ES6 shorthand `key,` both declare a field.
      const m = line.match(/^([A-Za-z_$][\w$]*)\s*(?::|,\s*$)/);
      if (m) keys.push(m[1]);
    }
    const code = line.replace(/\/\/.*$/, "");
    for (const c of code) {
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth--;
    }
  }

  if (keys.length === 0) {
    throw new Error(`extracted no keys from ${label} — parser out of date?`);
  }
  return keys;
}

/** All `key: "value"` string literals for a given property name. */
export function stringProps(source, prop, label) {
  const out = [];
  const re = new RegExp(`\\b${prop}\\s*:\\s*"([^"]+)"`, "g");
    let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  if (out.length === 0) {
    throw new Error(`no \`${prop}: "…"\` entries found in ${label}`);
  }
  return out;
}

/** Bare string literals inside a named `as const` array. */
export function constArrayStrings(source, name, label) {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`could not find array ${name} in ${label}`);
  const out = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (out.length === 0) {
    throw new Error(`array ${name} in ${label} is empty`);
  }
  return out;
}

/**
 * Every .tsx/.ts file under the given directories, as [relPath, source].
 *
 * For the checks that are about ABSENCE — "this must be rendered in
 * exactly one place" — which cannot be written by reading only the files
 * you already thought of.
 */
export function sourceFiles(...dirs) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(appPath(rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name)) out.push([child, read(child)]);
    }
  };
  for (const dir of dirs) walk(dir);
  if (out.length === 0) {
    throw new Error(`no source files found under ${dirs.join(", ")}`);
  }
  return out;
}

/**
 * Source with its comments removed.
 *
 * Guards that forbid a call have to read code only: a comment saying
 * "never call document.execCommand directly" is the guard working, and
 * failing on it would punish the file for explaining itself.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Leave `https://` alone — only a `//` not preceded by a colon opens
    // a line comment in any code this reads.
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Assert `pattern` appears in `source`, else record a problem. */
export function requirePattern(problems, source, pattern, description) {
  if (!pattern.test(source)) {
    problems.push(`missing: ${description}`);
  }
}
