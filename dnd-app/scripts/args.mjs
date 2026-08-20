/**
 * Command-line parsing for the scripts, in one place.
 *
 * This exists because of a failure that reached Derek's terminal. Both
 * scripts read a flag's value as `args[args.indexOf("--from") + 1]`, and
 * `indexOf` returns -1 when the flag is ABSENT, so `args[-1 + 1]` —
 * `args[0]`, the export path — was read as the Foundry URL:
 *
 *   Failed to parse URL from
 *   /Users/dcarl/Downloads/foundry-everything.json/ddb-images/...
 *
 * The `?? "http://localhost:30000"` beside it looks like it covers the
 * absent case and cannot: `args[0]` is a string, so the fallback never
 * fires. The same line, with the same shape, was in both scripts.
 *
 * Unknown flags are an error rather than being ignored. The flag these
 * scripts most need to get right is `--dry-run`, and a silently ignored
 * `--dryrun` converts a 130 MB export and writes it to disk.
 */

/**
 * @param argv  process.argv.slice(2)
 * @param spec  { "--flag": {} } for a switch,
 *              { "-o": { value: true, default: "out" } } for one that
 *              takes a value.
 * @returns { positionals, flags } — every flag in the spec is present in
 *          `flags`, so a caller never has to test for undefined.
 */
export function parseArgs(argv, spec) {
  const flags = {};
  for (const [name, def] of Object.entries(spec)) {
    flags[name] = def.value ? (def.default ?? null) : false;
  }

  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // A bare "-" is a filename by convention, not a flag.
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);

    const def = spec[name];
    if (!def) {
      throw new Error(`unknown option: ${name}`);
    }

    if (!def.value) {
      if (inline !== null) throw new Error(`${name} takes no value`);
      flags[name] = true;
      continue;
    }

    const next = inline !== null ? inline : argv[i + 1];
    if (next === undefined) {
      throw new Error(`${name} needs a value`);
    }
    // `--from --force` is a forgotten URL, not a URL called "--force".
    // Catching it here is the difference between a clear message and a
    // thousand requests to a nonsense host.
    if (inline === null && spec[next]) {
      throw new Error(`${name} needs a value, but was followed by ${next}`);
    }

    flags[name] = next;
    if (inline === null) i++;
  }

  return { positionals, flags };
}

/**
 * Parse, or print the usage and stop.
 *
 * Every one of these scripts is run by hand, from a paste, so the useful
 * response to a bad invocation is the usage text — not a stack trace,
 * and not a default quietly standing in for what you meant to type.
 */
export function parseOrExit(argv, spec, usage) {
  try {
    return parseArgs(argv, spec);
  } catch (err) {
    console.error(`${err.message}\n\n${usage}`);
    process.exit(1);
  }
}
