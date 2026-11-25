/**
 * The command-line grammar: `--key value`, `--key=value`, repeatable flags,
 * `--` to end flags, and positional subcommand arguments.
 *
 * The SDK's `parseCliArgs` is deliberately minimal (`--key value` only, no
 * subcommands) — enough for a worker that takes connection flags and runs.
 * This CLI has commands, repeatable flags and stdin values, so it parses its
 * own argv and shares no state with the SDK.
 */
import { usageError } from "./errors.js";

/** Parsed argv: positional words plus every `--flag` occurrence. */
export interface ParsedArgs {
  /** Words that are not flags, in order (command + its arguments). */
  positionals: string[];
  /**
   * Flag values. A flag without a value is `true`; a repeated flag is an
   * array (order preserved). `-h`/`--help`, `-v`/`--version` and `-d` are
   * folded into the long names `help`, `version`, `data`.
   */
  flags: Record<string, string | true | string[]>;
}

/** Parse an argv slice (without `node` and the script path). */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true | string[]> = {};
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (endOfFlags) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }

    let name: string | undefined;
    let inlineValue: string | undefined;
    if (arg === "-h" || arg === "--help") {
      name = "help";
    } else if (arg === "-v" || arg === "--version") {
      name = "version";
    } else if (arg === "-d") {
      name = "data";
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        name = arg.slice(2, eq);
        inlineValue = arg.slice(eq + 1);
      } else {
        name = arg.slice(2);
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      throw usageError(`unknown flag: ${arg} (run 'niq-interface help')`);
    } else {
      positionals.push(arg);
      continue;
    }

    if (inlineValue !== undefined) {
      addFlag(flags, name, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    // `-` is a value (stdin); any other leading dash is the next flag.
    if (next !== undefined && (!next.startsWith("-") || next === "-")) {
      addFlag(flags, name, next);
      i += 1;
    } else {
      addFlag(flags, name, true);
    }
  }

  return { positionals, flags };
}

function addFlag(
  flags: Record<string, string | true | string[]>,
  name: string,
  value: string | true,
): void {
  const prev = flags[name];
  if (prev === undefined) {
    flags[name] = value;
  } else if (Array.isArray(prev)) {
    prev.push(String(value));
  } else {
    flags[name] = [String(prev), String(value)];
  }
}

/** Read a single-valued flag; throws when it was repeated or needs a value. */
export function flag(
  flags: ParsedArgs["flags"],
  name: string,
): string | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    throw usageError(`flag --${name} was given more than once`);
  }
  if (v === true) {
    throw usageError(`flag --${name} needs a value`);
  }
  return v;
}

/** Read a repeatable flag as a list (zero occurrences → empty list). */
export function flagList(
  flags: ParsedArgs["flags"],
  name: string,
): string[] {
  const v = flags[name];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (v === true) {
    throw usageError(`flag --${name} needs a value`);
  }
  return [v];
}

/** Read a boolean flag; a boolean flag given a value is a usage error. */
export function hasFlag(flags: ParsedArgs["flags"], name: string): boolean {
  const v = flags[name];
  if (v === undefined) return false;
  if (v !== true) {
    throw usageError(`flag --${name} does not take a value`);
  }
  return true;
}

/** Reject any flag the command does not understand (typo protection). */
export function assertKnownFlags(
  flags: ParsedArgs["flags"],
  allowed: readonly string[],
): void {
  const global = ["help", "version"];
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name) && !global.includes(name)) {
      throw usageError(`unknown flag --${name} (run 'niq-interface help')`);
    }
  }
}
