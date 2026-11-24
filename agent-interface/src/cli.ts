/**
 * The CLI: argument grammar, command dispatch, and the JSON output contract.
 *
 * Design rules
 * - stdout carries data only (JSON, or one JSON event per line for `listen`);
 *   diagnostics, warnings and readiness all go to stderr. A caller can pipe
 *   stdout into `jq` without stripping human text.
 * - One invocation = one short-lived bus connection. Nothing is left running
 *   except `listen`, which is meant to be long-lived.
 * - Every failure is a {@link CliError}; `runCli` turns it into an exit code
 *   (0 ok / 1 failure / 2 usage) plus an optional structured detail on stdout.
 */
import { cpSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@niq.run/worker-sdk";
import {
  assertKnownFlags,
  flag,
  flagList,
  hasFlag,
  parseArgs,
  type ParsedArgs,
} from "./args.js";
import { listen, ping, previewEvent, publish, request } from "./bus.js";
import {
  CONFIG_PATH_ENV,
  SOURCE_ENV,
  configExists,
  defaultSourceName,
  loadConfig,
  parseImportText,
  removeSource,
  resolveConfigPath,
  resolveDial,
  saveConfig,
  upsertSource,
  type BusSource,
  type ConfigFile,
  type DialRequest,
  type ResolvedDial,
} from "./config.js";
import { CliError, EXIT_OK, usageError } from "./errors.js";

/** The package name, used in `--version` and error prefixes. */
export const PACKAGE_NAME = "@niq.run/agent-interface-worker";

/** The companion skill's directory name (matches its frontmatter `name`). */
const SKILL_NAME = "niq-agent-interface";

/** Commands that only dial the bus take these. */
const DIAL_FLAGS = [
  "source",
  "config",
  "bus-url",
  "worker-id",
  "credential",
] as const;

/**
 * Every send is directed. A caller that does not know the id must ask the
 * human. `niq` is a common candidate because many projects name their main
 * reason worker `niq`, but it is not an implicit default and must be confirmed.
 */
const TARGET_GUIDE =
  'broadcast is disabled: ask the user which worker should receive it. In many ' +
  'niq projects the main reason worker is named "niq", so that is a common ' +
  'candidate — but it is not an implicit default. Confirm the exact id with the ' +
  'user, then pass --target <worker-id>.';

/** Write results somewhere; `start.ts` backs this with the real process. */
export interface CliIO {
  /** Write one piece of data (a newline is appended when missing). */
  out(text: string): void;
  /** Write a diagnostic line to stderr. */
  err(text: string): void;
  /** Read all of stdin (used by `--data -` and `config import`). */
  readStdin(): Promise<string>;
}

/** Everything a command needs from the outside world. */
export interface CliContext {
  env: Record<string, string | undefined>;
  io: CliIO;
  /** Injectable for tests / proxies; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Run one CLI invocation. Returns the process exit code instead of exiting, so
 * tests can call it directly.
 */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const { io } = ctx;
  try {
    const parsed = parseArgs(argv);

    if (hasFlag(parsed.flags, "version")) {
      io.out(`${PACKAGE_NAME} ${version()}`);
      return EXIT_OK;
    }

    const [command, ...rest] = parsed.positionals;
    if (!command) {
      io.out(ROOT_HELP);
      return EXIT_OK;
    }
    if (command === "help") {
      io.out(commandHelp(rest[0]));
      return EXIT_OK;
    }
    if (hasFlag(parsed.flags, "help")) {
      io.out(commandHelp(command));
      return EXIT_OK;
    }

    switch (command) {
      case "send":
        return await cmdSend(rest, parsed.flags, ctx);
      case "request":
        return await cmdRequest(rest, parsed.flags, ctx);
      case "say":
        return await cmdSay(rest, parsed.flags, ctx);
      case "listen":
        return await cmdListen(rest, parsed.flags, ctx);
      case "ping":
        return await cmdPing(rest, parsed.flags, ctx);
      case "info":
        return await cmdInfo(rest, parsed.flags, ctx);
      case "config":
        return await cmdConfig(rest, parsed.flags, ctx);
      case "skill":
        return await cmdSkill(rest, parsed.flags, ctx);
      default:
        throw usageError(
          `unknown command: ${command} (run 'niq-agent help')`,
        );
    }
  } catch (err) {
    const e =
      err instanceof CliError
        ? err
        : new CliError(err instanceof Error ? err.message : String(err), {
            cause: err,
          });
    if (e.detail !== undefined) io.out(JSON.stringify(e.detail, null, 2));
    io.err(`niq-agent: ${e.message}`);
    return e.exitCode;
  }
}

// ── Commands ──

async function cmdSend(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  assertKnownFlags(flags, [...DIAL_FLAGS, "data", "data-file", "target", "trace", "dry-run"]);
  const [type, ...extra] = rest;
  if (!type) {
    throw usageError(
      "send needs an event type: niq-agent send <event-type> [--target <id>] [-d <json>]",
    );
  }
  if (extra.length > 0) throw usageError(`unexpected argument: ${extra[0]}`);

  const targets = unique(flagList(flags, "target"));
  const payload = await readPayload(flags, ctx);
  if (targets.length === 0) {
    throw usageError(`send needs at least one --target <worker-id>: ${TARGET_GUIDE}`);
  }
  const traceID = flag(flags, "trace");
  const dial = resolveDialFor(flags, ctx);

  if (hasFlag(flags, "dry-run")) {
    const event = previewEvent(toBusDial(dial), { type, payload, traceID });
    emit(ctx, {
      ok: true,
      dry_run: true,
      ...dialFields(dial),
      targets,
      event,
    });
    return EXIT_OK;
  }

  const outcome = await publish(
    toBusDial(dial),
    { type, payload, targets, traceID },
    { fetchImpl: ctx.fetchImpl },
  );
  emit(ctx, {
    ok: true,
    ...dialFields(dial),
    targets: outcome.targets,
    event: outcome.event,
  });
  return EXIT_OK;
}

async function cmdRequest(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  assertKnownFlags(flags, [
    ...DIAL_FLAGS,
    "data",
    "data-file",
    "target",
    "trace",
    "timeout",
    "dry-run",
  ]);
  const [type, ...extra] = rest;
  if (!type) {
    throw usageError(
      "request needs an event type: niq-agent request <event-type> --target <id> [-d <json>]",
    );
  }
  if (extra.length > 0) throw usageError(`unexpected argument: ${extra[0]}`);

  const targets = unique(flagList(flags, "target"));
  if (targets.length !== 1) {
    throw usageError(`request needs exactly one --target <worker-id>: ${TARGET_GUIDE}`);
  }
  const target = targets[0];
  const payload = await readPayload(flags, ctx);
  const traceID = flag(flags, "trace");
  const timeoutMs = parseTimeout(flag(flags, "timeout")) ?? 30_000;
  const dial = resolveDialFor(flags, ctx);

  if (hasFlag(flags, "dry-run")) {
    const event = previewEvent(toBusDial(dial), { type, payload, traceID });
    emit(ctx, {
      ok: true,
      dry_run: true,
      ...dialFields(dial),
      target,
      event,
    });
    return EXIT_OK;
  }

  const outcome = await request(
    toBusDial(dial),
    { type, payload, target, timeoutMs, traceID },
    { fetchImpl: ctx.fetchImpl },
  );

  const detail = {
    ...dialFields(dial),
    target,
    request_id: outcome.requestID,
    reply: outcome.reply,
  };
  if (outcome.ok) {
    emit(ctx, { ok: true, ...detail });
    return EXIT_OK;
  }
  throw new CliError(`request ${type} to ${target} failed: ${outcome.error}`, {
    detail: { ok: false, ...detail, error: outcome.error },
  });
}

async function cmdSay(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  assertKnownFlags(flags, [...DIAL_FLAGS, "target", "mode", "trace", "dry-run"]);
  const text = rest.join(" ").trim();
  if (!text) {
    throw usageError(
      "say needs text: niq-agent say <text> --target <worker-id>",
    );
  }
  const targets = unique(flagList(flags, "target"));
  if (targets.length !== 1) {
    throw usageError(`say needs exactly one --target <worker-id>: ${TARGET_GUIDE}`);
  }
  const mode = flag(flags, "mode") ?? "append";
  if (mode !== "append" && mode !== "schedule" && mode !== "interrupt") {
    throw usageError(
      `invalid --mode "${mode}": use append (default), schedule or interrupt`,
    );
  }

  // The reason family reads worker.input as {text, input_mode}; append is its
  // gentle default (see niq/core/impl/reason/process.go handleInput).
  const payload = { text, input_mode: mode };
  const traceID = flag(flags, "trace");
  const dial = resolveDialFor(flags, ctx);

  if (hasFlag(flags, "dry-run")) {
    const event = previewEvent(toBusDial(dial), {
      type: EventType.WorkerInput,
      payload,
      traceID,
    });
    emit(ctx, {
      ok: true,
      dry_run: true,
      ...dialFields(dial),
      targets,
      event,
    });
    return EXIT_OK;
  }

  const outcome = await publish(
    toBusDial(dial),
    { type: EventType.WorkerInput, payload, targets, traceID },
    { fetchImpl: ctx.fetchImpl },
  );
  emit(ctx, {
    ok: true,
    ...dialFields(dial),
    targets: outcome.targets,
    event: outcome.event,
  });
  return EXIT_OK;
}

async function cmdListen(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  assertKnownFlags(flags, [...DIAL_FLAGS, "type", "from", "max", "timeout"]);
  if (rest.length > 0) throw usageError(`unexpected argument: ${rest[0]}`);

  const types = flagList(flags, "type");
  const from = flagList(flags, "from");
  const max = parseMax(flag(flags, "max"));
  const timeoutMs = parseTimeout(flag(flags, "timeout"));
  const dial = resolveDialFor(flags, ctx);

  const abort = new AbortController();
  const onSigint = (): void => {
    ctx.io.err("");
    abort.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const outcome = await listen(
      toBusDial(dial),
      {
        types,
        from,
        max,
        timeoutMs,
        signal: abort.signal,
        onReady: () => {
          // A stderr readiness line is the synchronisation point for a caller
          // that starts this in the background and then publishes.
          ctx.io.err(
            `niq-agent: listening on ${dial.source} as ${dial.workerID} ` +
              `(types: ${types.length > 0 ? types.join(", ") : "*"})`,
          );
        },
        onEvent: (evt) => ctx.io.out(JSON.stringify(evt)),
      },
      { fetchImpl: ctx.fetchImpl },
    );

    if (outcome.stop === "end") {
      throw new CliError(
        "the bus closed the event stream (another connection may have replaced " +
          `this identity; use a distinct --source for a long-lived listener)`,
      );
    }
    return EXIT_OK;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function cmdPing(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  assertKnownFlags(flags, DIAL_FLAGS);
  if (rest.length > 0) throw usageError(`unexpected argument: ${rest[0]}`);

  const dial = resolveDialFor(flags, ctx);
  const latency = await ping(toBusDial(dial), { fetchImpl: ctx.fetchImpl });
  emit(ctx, { ok: true, ...dialFields(dial), latency_ms: latency });
  return EXIT_OK;
}

async function cmdInfo(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  assertKnownFlags(flags, [...DIAL_FLAGS, "show-credential"]);
  if (rest.length > 0) throw usageError(`unexpected argument: ${rest[0]}`);

  const dial = resolveDialFor(flags, ctx);
  emit(ctx, {
    ok: true,
    source: dial.source,
    config_path: dial.configPath,
    bus_url: dial.busURL,
    worker_id: dial.workerID,
    ...(dial.type ? { type: dial.type } : {}),
    credential_configured: Boolean(dial.credential),
    ...(hasFlag(flags, "show-credential")
      ? { credential: dial.credential }
      : {}),
  });
  return EXIT_OK;
}

// ── config ──

async function cmdConfig(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  const [sub, ...args] = rest;
  const env = ctx.env;

  switch (sub) {
    case "path": {
      assertKnownFlags(flags, ["config"]);
      const path = resolveConfigPath(flag(flags, "config"), env);
      emit(ctx, { path, exists: configExists(path) });
      return EXIT_OK;
    }

    case "list": {
      assertKnownFlags(flags, ["config"]);
      const path = resolveConfigPath(flag(flags, "config"), env);
      const loaded = loadConfig(path, false);
      warn(ctx, loaded.warnings);
      emit(ctx, {
        config_path: path,
        exists: loaded.exists,
        default_source: loaded.config.default_source ?? null,
        sources: Object.entries(loaded.config.sources).map(([name, src]) =>
          viewSource(name, src, loaded.config.default_source === name, false),
        ),
      });
      return EXIT_OK;
    }

    case "show": {
      assertKnownFlags(flags, ["config", "show-credential"]);
      if (args.length > 1) throw usageError(`unexpected argument: ${args[1]}`);
      const path = resolveConfigPath(flag(flags, "config"), env);
      const loaded = loadConfig(path, true);
      const name = args[0] ?? defaultSourceName(loaded.config);
      const src = loaded.config.sources[name];
      if (!src) {
        throw new CliError(
          `source "${name}" does not exist in ${path}`,
        );
      }
      emit(ctx, {
        config_path: path,
        source: viewSource(
          name,
          src,
          loaded.config.default_source === name,
          hasFlag(flags, "show-credential"),
        ),
      });
      return EXIT_OK;
    }

    case "add": {
      assertKnownFlags(flags, [
        "config",
        "bus-url",
        "worker-id",
        "credential",
        "type",
        "force",
        "default",
      ]);
      const [name, ...extra] = args;
      if (!name) {
        throw usageError(
          "config add needs a name: niq-agent config add <name> --bus-url <url> --worker-id <id> --credential <cred>",
        );
      }
      if (extra.length > 0) throw usageError(`unexpected argument: ${extra[0]}`);

      const busURL = flag(flags, "bus-url");
      const workerID = flag(flags, "worker-id");
      const credential = flag(flags, "credential");
      const type = flag(flags, "type");
      if (!busURL || !workerID || !credential) {
        throw usageError(
          "config add needs --bus-url, --worker-id and --credential " +
            "(or use 'config import' with the block the niq WebUI copies)",
        );
      }

      const path = resolveConfigPath(flag(flags, "config"), env);
      const loaded = loadConfig(path, false);
      const config = loaded.config;
      upsertSource(
        config,
        name,
        {
          bus_url: busURL,
          worker_id: workerID,
          credential,
          ...(type ? { type } : {}),
        },
        { force: hasFlag(flags, "force"), makeDefault: hasFlag(flags, "default") },
      );
      saveConfig(path, config);
      emitSourceSaved(ctx, path, name, config);
      return EXIT_OK;
    }

    case "import": {
      assertKnownFlags(flags, [
        "config",
        "from-file",
        "force",
        "default",
      ]);
      const [name, ...extra] = args;
      if (extra.length > 0) throw usageError(`unexpected argument: ${extra[0]}`);

      const fromFile = flag(flags, "from-file");
      let text: string;
      if (fromFile) {
        try {
          text = readFileSync(fromFile, "utf8");
        } catch (err) {
          throw new CliError(
            `cannot read ${fromFile}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      } else {
        if (!name) {
          throw usageError(
            "config import needs a name when reading a connect block from stdin " +
              "(or pass --from-file <path> with a full agent-interface JSON config)",
          );
        }
        ctx.io.err(
          "niq-agent: reading the connect block or config JSON from stdin (end with Ctrl-D)",
        );
        text = await ctx.io.readStdin();
      }

      const parsed = parseImportText(text);
      warn(ctx, parsed.warnings);

      const path = resolveConfigPath(flag(flags, "config"), env);
      const loaded = loadConfig(path, false);
      const config = loaded.config;
      const hadDefault = Boolean(config.default_source);
      const force = hasFlag(flags, "force");
      const makeDefault = hasFlag(flags, "default");

      if (parsed.kind === "source") {
        if (!name) {
          throw usageError(
            "config import needs a name for a single connect block: " +
              "niq-agent config import <name> --from-file <path>",
          );
        }
        upsertSource(config, name, parsed.source, { force, makeDefault });
        saveConfig(path, config);
        emitSourceSaved(ctx, path, name, config);
        return EXIT_OK;
      }

      // A whole credential file carries its own source names: importing it is
      // a merge, so a name argument would be ambiguous.
      if (name) {
        throw usageError(
          "a full config file carries its own source names; omit <name> " +
            "(niq-agent config import --from-file <path>)",
        );
      }
      const imported = Object.keys(parsed.config.sources).sort();
      for (const [sourceName, source] of Object.entries(parsed.config.sources)) {
        upsertSource(config, sourceName, source, { force });
      }
      // The incoming default only wins when there was none, or when asked. A
      // downloaded file's default (its own worker id) must not steal the
      // default from the machine's existing sources.
      const incomingDefault = parsed.config.default_source;
      if (makeDefault) {
        const next = incomingDefault ?? imported[0];
        if (next && config.sources[next]) config.default_source = next;
      } else if (!hadDefault && incomingDefault && config.sources[incomingDefault]) {
        config.default_source = incomingDefault;
      }
      saveConfig(path, config);
      emit(ctx, {
        ok: true,
        config_path: path,
        imported,
        default_source: config.default_source ?? null,
      });
      return EXIT_OK;
    }

    case "remove": {
      assertKnownFlags(flags, ["config"]);
      const [name, ...extra] = args;
      if (!name) {
        throw usageError("config remove needs a name");
      }
      if (extra.length > 0) throw usageError(`unexpected argument: ${extra[0]}`);

      const path = resolveConfigPath(flag(flags, "config"), env);
      const loaded = loadConfig(path, true);
      removeSource(loaded.config, name);
      saveConfig(path, loaded.config);
      emit(ctx, {
        ok: true,
        config_path: path,
        removed: name,
        default_source: loaded.config.default_source ?? null,
      });
      return EXIT_OK;
    }

    case "default": {
      assertKnownFlags(flags, ["config"]);
      const [name, ...extra] = args;
      if (!name) throw usageError("config default needs a name");
      if (extra.length > 0) throw usageError(`unexpected argument: ${extra[0]}`);

      const path = resolveConfigPath(flag(flags, "config"), env);
      const loaded = loadConfig(path, true);
      if (!loaded.config.sources[name]) {
        throw new CliError(`source "${name}" does not exist in ${path}`);
      }
      loaded.config.default_source = name;
      saveConfig(path, loaded.config);
      emit(ctx, { ok: true, config_path: path, default_source: name });
      return EXIT_OK;
    }

    case undefined:
      throw usageError(
        "config needs a subcommand: path | list | show | add | import | remove | default",
      );
    default:
      throw usageError(
        `unknown config subcommand: ${sub} (use path | list | show | add | import | remove | default)`,
      );
  }
}

// ── skill ──

/**
 * The companion skill ships inside the package (`skills/niq-agent-interface`).
 * These subcommands make it reachable after a global install: print it, find
 * it, or copy it into an agent's skills directory.
 */
async function cmdSkill(
  rest: string[],
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<number> {
  const [sub = "path", ...args] = rest;
  if (args.length > 0) throw usageError(`unexpected argument: ${args[0]}`);

  switch (sub) {
    case "path": {
      assertKnownFlags(flags, []);
      const dir = skillDir();
      const file = join(dir, "SKILL.md");
      emit(ctx, { name: SKILL_NAME, dir, file, exists: existsSync(file) });
      return EXIT_OK;
    }

    case "print": {
      assertKnownFlags(flags, []);
      const file = join(skillDir(), "SKILL.md");
      try {
        ctx.io.out(readFileSync(file, "utf8"));
      } catch (err) {
        throw new CliError(`cannot read the bundled skill at ${file}`, {
          cause: err,
        });
      }
      return EXIT_OK;
    }

    case "install": {
      assertKnownFlags(flags, ["dest", "force"]);
      const dir = skillDir();
      if (!existsSync(join(dir, "SKILL.md"))) {
        throw new CliError(
          `the bundled skill is missing at ${dir} (reinstall the package)`,
        );
      }
      const destRoot = expandHome(flag(flags, "dest") ?? "~/.agents/skills");
      const target = join(destRoot, SKILL_NAME);
      if (existsSync(target) && !hasFlag(flags, "force")) {
        throw new CliError(
          `skill already installed at ${target}; pass --force to overwrite`,
        );
      }
      cpSync(dir, target, { recursive: true, force: true });
      emit(ctx, { ok: true, installed: target, source: dir });
      return EXIT_OK;
    }

    default:
      throw usageError(
        `unknown skill subcommand: ${sub} (use path | print | install)`,
      );
  }
}

/** The skill's package-relative directory (works from src/ and dist/). */
function skillDir(): string {
  return fileURLToPath(new URL(`../skills/${SKILL_NAME}`, import.meta.url));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// ── helpers ──

function dialRequestFrom(flags: ParsedArgs["flags"]): DialRequest {
  return {
    configPath: flag(flags, "config"),
    source: flag(flags, "source"),
    busURL: flag(flags, "bus-url"),
    workerID: flag(flags, "worker-id"),
    credential: flag(flags, "credential"),
  };
}

function resolveDialFor(
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): ResolvedDial {
  const dial = resolveDial(dialRequestFrom(flags), ctx.env);
  warn(ctx, dial.warnings);
  return dial;
}

function toBusDial(dial: ResolvedDial): {
  source: string;
  busURL: string;
  workerID: string;
  credential: string;
} {
  return {
    source: dial.source,
    busURL: dial.busURL,
    workerID: dial.workerID,
    credential: dial.credential,
  };
}

function dialFields(dial: ResolvedDial): {
  source: string;
  bus_url: string;
  worker_id: string;
} {
  return {
    source: dial.source,
    bus_url: dial.busURL,
    worker_id: dial.workerID,
  };
}

function emitSourceSaved(
  ctx: CliContext,
  path: string,
  name: string,
  config: ConfigFile,
): void {
  const src = config.sources[name];
  emit(ctx, {
    ok: true,
    config_path: path,
    source: viewSource(name, src, config.default_source === name, false),
  });
}

function viewSource(
  name: string,
  src: BusSource,
  isDefault: boolean,
  showCredential: boolean,
): Record<string, unknown> {
  return {
    name,
    bus_url: src.bus_url,
    worker_id: src.worker_id,
    ...(src.type ? { type: src.type } : {}),
    default: isDefault,
    credential_configured: Boolean(src.credential),
    ...(showCredential ? { credential: src.credential } : {}),
  };
}

function warn(ctx: CliContext, warnings: string[]): void {
  for (const w of warnings) ctx.io.err(`niq-agent: warning: ${w}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function emit(ctx: CliContext, value: unknown): void {
  ctx.io.out(JSON.stringify(value, null, 2));
}

async function readPayload(
  flags: ParsedArgs["flags"],
  ctx: CliContext,
): Promise<Record<string, unknown>> {
  const data = flag(flags, "data");
  const file = flag(flags, "data-file");
  if (data !== undefined && file !== undefined) {
    throw usageError("use either --data or --data-file, not both");
  }

  let text: string | undefined;
  if (data === "-") {
    text = await ctx.io.readStdin();
  } else if (data !== undefined) {
    text = data;
  } else if (file) {
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new CliError(
        `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  if (text === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usageError(
      `payload is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError("payload must be a JSON object (e.g. '{\"text\":\"hi\"}')");
  }
  return parsed as Record<string, unknown>;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) {
    throw usageError(
      `invalid duration "${raw}": use 500ms, 30s, 5m or 1h (a bare number means seconds)`,
    );
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const factor =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(n * factor);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw usageError(`invalid duration "${raw}": must be greater than 0`);
  }
  return ms;
}

function parseMax(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw usageError(`invalid --max "${raw}": expected a positive integer`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw usageError(`invalid --max "${raw}": expected a positive integer`);
  }
  return n;
}

function version(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // a missing/unreadable package.json must not break --version
  }
  return "0.0.0";
}

// ── help ──

function commandHelp(name: string | undefined): string {
  switch (name) {
    case "send":
      return SEND_HELP;
    case "request":
      return REQUEST_HELP;
    case "say":
      return SAY_HELP;
    case "listen":
      return LISTEN_HELP;
    case "ping":
      return PING_HELP;
    case "info":
      return INFO_HELP;
    case "config":
      return CONFIG_HELP;
    case "skill":
      return SKILL_HELP;
    default:
      return ROOT_HELP;
  }
}

const ROOT_HELP = `niq-agent — a command-line worker that talks to a niq event bus

Usage:
  niq-agent <command> [arguments] [options]

Commands:
  send <event-type>       Publish one directed event (--target required)
  request <event-type>    Send an event and wait for its correlated reply
  say <text>              Send a worker.input text message to one worker
  listen                  Stream events routed to this identity (NDJSON)
  ping                    Connect to the bus and disconnect (connectivity check)
  info                    Show the resolved connection without dialling
  config <subcommand>     Manage bus credential sources
  skill <subcommand>      Print or install the companion agent skill
  help [command]          Show help for a command

Dial options (every bus command):
  --source <name>         Named source from the credential file
                          (else ${SOURCE_ENV})
  --config <path>         Credential file (else ${CONFIG_PATH_ENV};
                          default ~/.niq/interface.json)
  --bus-url <url>         Override the bus URL
  --worker-id <id>        Override the worker id
  --credential <cred>     Override the credential

Resolution order: --source > NIQ_BUS_URL/NIQ_WORKER_ID/NIQ_WORKER_CREDENTIAL
> the file's default_source (or its only source) > error.

Output: JSON on stdout (NDJSON for listen); diagnostics on stderr.
Exit codes: 0 ok, 1 failure, 2 usage error.

Run 'niq-agent help <command>' for command details.`;

const SEND_HELP = `Usage: niq-agent send <event-type> --target <id>… [options]

Publish one directed event. Broadcast is intentionally disabled: every send
needs at least one --target. If the caller does not know the id, ask the user.
In many projects the main reason worker is named "niq" — a common candidate,
not an implicit default.

Options:
  -d, --data <json>       Payload as a JSON object; '-' reads stdin
  --data-file <path>      Read the payload JSON from a file
  --target <id>           Target worker id (repeatable; at least one required)
  --trace <id>            Attach a trace id
  --dry-run               Print the event without publishing
  plus the dial options.

Example:
  niq-agent send ops.notice --target niq -d '{"text":"deploy done"}'
  niq-agent send worker.input --target reason.0 -d '{"text":"hi"}'`;

const REQUEST_HELP = `Usage: niq-agent request <event-type> --target <id> [options]

Send a directed event carrying a fresh request_id and wait for the matching
request.completed / request.failed / request.rejected. Prints the reply.
Broadcast is disabled; if the caller does not know the target id, ask the user.
In many projects the main reason worker is named "niq" — a common candidate,
not an implicit default.

Options:
  -d, --data <json>       Payload as a JSON object; '-' reads stdin
  --data-file <path>      Read the payload JSON from a file
  --target <id>           Target worker id (exactly one, required)
  --timeout <duration>    Reply timeout (default 30s; e.g. 500ms, 2m)
  --trace <id>            Attach a trace id
  --dry-run               Print the event without dialling
  plus the dial options.

Exit code is 1 when the reply is request.failed/rejected (the reply JSON is
still printed on stdout).`;

const SAY_HELP = `Usage: niq-agent say <text> --target <worker-id> [options]

Send a worker.input event with {text, input_mode} to one worker — the short
form for waking a reason-family worker. If the caller does not know the target
id, ask the user. In many projects the main reason worker is named "niq" — a
common candidate, not an implicit default.

Options:
  --target <id>           Target worker id (exactly one, required)
  --mode <mode>           append (default), schedule or interrupt
  --trace <id>            Attach a trace id
  --dry-run               Print the event without publishing
  plus the dial options.

Example:
  niq-agent say "summarise today's notes" --target reason.0 --source home`;

const LISTEN_HELP = `Usage: niq-agent listen [options]

Stream events routed to this identity, one JSON object per line on stdout.
The first line on stderr announces that the stream is ready.

Options:
  --type <pattern>        Only events of this type (repeatable; '*' and 'x.*')
  --from <id>             Only events from this worker id (repeatable)
  --max <n>               Stop after n events
  --timeout <duration>    Stop after the duration
  plus the dial options.

A bus keeps one live session per identity: a concurrent send/request using the
same source replaces the listener. Use a distinct --source for long-lived
listening.`;

const PING_HELP = `Usage: niq-agent ping [options]

Open the SSE stream once, close it, and report the handshake latency. Exercises
the credential and reachability without publishing anything.
Options: the dial options.`;

const INFO_HELP = `Usage: niq-agent info [options]

Show the connection the other commands would use (offline; no dial). The
credential is redacted unless --show-credential is passed.
Options: the dial options, --show-credential.`;

const CONFIG_HELP = `Usage: niq-agent config <subcommand> [options]

Manage credential sources in the credential file.

Subcommands:
  path                    Print the file path and whether it exists
  list                    List sources (credentials redacted)
  show [name]             Show one source (credentials redacted)
  add <name>              Add a source from flags:
                          --bus-url <url> --worker-id <id> --credential <cred> [--type <t>]
  import [name]           Add a source from the WebUI's KEY=value block, or
                          merge a full agent-interface JSON config (name omitted)
  remove <name>           Delete a source
  default <name>          Set the default source

Common options: --config <path>, --force (overwrite an existing source),
--default (also make it the default), --show-credential (show only).

Example:
  niq-agent config import laptop        # paste, then Ctrl-D
  niq-agent config import --from-file ~/Downloads/niq-agent-11.json
  niq-agent ping --source laptop`;

const SKILL_HELP = `Usage: niq-agent skill [path|print|install] [options]

The companion agent skill ships inside the package. Without a subcommand,
'path' is used.

Subcommands:
  path                    Print the skill directory and SKILL.md path
  print                   Print SKILL.md to stdout
  install                 Copy the skill into ~/.agents/skills/niq-agent-interface
                          (--dest <dir> changes the root, --force overwrites)`;
