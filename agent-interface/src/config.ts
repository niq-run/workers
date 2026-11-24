/**
 * Credential sources: the local file this CLI dials from.
 *
 * A niq bus issues each remote (dial-in) worker an identity plus a credential.
 * The WebUI shows the connect block for a freshly created remote worker:
 *
 *   NIQ_BUS_URL=http://192.168.1.20:7801
 *   NIQ_WORKER_ID=agent.laptop
 *   NIQ_WORKER_CREDENTIAL=eyJ...
 *   # type=agent
 *
 * That is the exact shape {@link parseConnectBlock} imports. One file holds
 * many such sources, so one machine can reach several remote buses (or use
 * several identities on one bus — the bus keeps one live connection per
 * identity, so concurrent long-lived commands need distinct sources).
 *
 * File: `~/.niq/interface.json` by default, overridable with
 * `NIQ_INTERFACE_CONFIG` or `--config`.
 *
 *   {
 *     "version": 1,
 *     "default_source": "home",
 *     "sources": {
 *       "home": { "bus_url": "http://…", "worker_id": "…", "credential": "…", "type": "agent" }
 *     }
 *   }
 *
 * Resolution order for a command (explicit source > environment > default):
 *   1. `--source` / `NIQ_INTERFACE_SOURCE` — that named source, required.
 *   2. `NIQ_BUS_URL` + `NIQ_WORKER_ID` + `NIQ_WORKER_CREDENTIAL` — the
 *      supervisor convention, used when all three are set.
 *   3. The config's `default_source`, or its only source if there is exactly
 *      one.
 *   4. Nothing → a guiding error. `--bus-url`/`--worker-id`/`--credential`
 *      overlay (or, on their own, supply) the connection.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUS_ENV_VARS } from "@niq.run/worker-sdk";
import { CliError } from "./errors.js";

/** Overrides the credential file path. */
export const CONFIG_PATH_ENV = "NIQ_INTERFACE_CONFIG";
/** Selects a named source when no `--source` flag is given. */
export const SOURCE_ENV = "NIQ_INTERFACE_SOURCE";

/** One bus identity this CLI can dial as. Keys mirror the wire/env names. */
export interface BusSource {
  /** Bus base URL, e.g. `http://192.168.1.20:7801` (no trailing slash after load). */
  bus_url: string;
  /** The identity registered on the bus (a remote/unmanaged worker). */
  worker_id: string;
  /** The signed credential the bus issued for that identity. */
  credential: string;
  /** Optional worker type label copied from the WebUI block (`# type=…`). */
  type?: string;
}

/** The whole credential file. `version` is 1 today; unknown fields are ignored. */
export interface ConfigFile {
  version: number;
  default_source?: string;
  sources: Record<string, BusSource>;
}

/** A parsed file plus what the caller needs to report (permissions, etc.). */
export interface LoadedConfig {
  config: ConfigFile;
  exists: boolean;
  warnings: string[];
}

/** Explicit connection inputs from flags, for {@link resolveDial}. */
export interface DialRequest {
  configPath?: string;
  source?: string;
  busURL?: string;
  workerID?: string;
  credential?: string;
}

/** A resolved connection, ready to construct the SDK client with. */
export interface ResolvedDial {
  /** Path of the credential file consulted (whether or not it exists). */
  configPath: string;
  /** Where the connection came from: a source name, `env`, or `flags`. */
  source: string;
  busURL: string;
  workerID: string;
  credential: string;
  type?: string;
  warnings: string[];
}

/** The default credential file: `~/.niq/interface.json`. */
export function defaultConfigPath(): string {
  return join(homedir(), ".niq", "interface.json");
}

/** Resolve the file path: flag > env > default. Expands a leading `~`. */
export function resolveConfigPath(
  flagPath?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = flagPath?.trim() || env[CONFIG_PATH_ENV]?.trim() || "";
  return explicit ? expandHome(explicit) : defaultConfigPath();
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** An empty, valid config file. */
export function emptyConfig(): ConfigFile {
  return { version: 1, sources: {} };
}

/**
 * Read and validate the credential file.
 *
 * `required` controls a missing file: for connection use it stays optional
 * (the environment may supply everything), while `--source`, `--config` and
 * the `config` subcommands treat the file as required so a typo is loud.
 */
export function loadConfig(path: string, required: boolean): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (required) {
        throw new CliError(
          `credential file not found: ${path}. Create a source with ` +
            `'niq-agent config import <name>' (paste the block the niq WebUI ` +
            `shows for a remote worker), or pass --bus-url/--worker-id/--credential.`,
          { cause: err },
        );
      }
      return { config: emptyConfig(), exists: false, warnings: [] };
    }
    throw new CliError(`cannot read ${path}: ${messageOf(err)}`, { cause: err });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${messageOf(err)}`, {
      cause: err,
    });
  }

  const warnings: string[] = [];
  const perm = permissionWarning(path);
  if (perm) warnings.push(perm);
  return { config: parseConfig(raw, path), exists: true, warnings };
}

function parseConfig(raw: unknown, path: string): ConfigFile {
  if (!isRecord(raw)) {
    throw new CliError(`${path}: expected a JSON object at the top level`);
  }

  const sourcesRaw = raw["sources"];
  if (sourcesRaw !== undefined && !isRecord(sourcesRaw)) {
    throw new CliError(`${path}: "sources" must be an object of named sources`);
  }

  const sources: Record<string, BusSource> = {};
  for (const [name, value] of Object.entries(sourcesRaw ?? {})) {
    sources[name] = parseSource(value, `${path}: source "${name}"`);
  }

  const def = raw["default_source"];
  if (def !== undefined && typeof def !== "string") {
    throw new CliError(`${path}: "default_source" must be a string`);
  }
  const defaultSource = typeof def === "string" ? def.trim() : "";
  if (defaultSource && !sources[defaultSource]) {
    throw new CliError(
      `${path}: default_source "${defaultSource}" does not name a source`,
    );
  }

  const version = typeof raw["version"] === "number" ? raw["version"] : 1;
  return {
    version,
    ...(defaultSource ? { default_source: defaultSource } : {}),
    sources,
  };
}

/** Parse one source object, naming it in any error (a file path or "imported"). */
function parseSource(value: unknown, label: string): BusSource {
  if (!isRecord(value)) {
    throw new CliError(`${label} must be an object`);
  }
  const busURL = stringField(value, "bus_url", "NIQ_BUS_URL").trim();
  const workerID = stringField(value, "worker_id", "NIQ_WORKER_ID").trim();
  const credential = stringField(
    value,
    "credential",
    "NIQ_WORKER_CREDENTIAL",
  ).trim();
  const missing = [
    busURL ? "" : "bus_url",
    workerID ? "" : "worker_id",
    credential ? "" : "credential",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new CliError(`${label} is missing ${missing.join(", ")}`);
  }
  const type = stringField(value, "type");
  return {
    bus_url: normalizeBusURL(busURL),
    worker_id: workerID,
    credential,
    ...(type.trim() ? { type: type.trim() } : {}),
  };
}

/** Accept either the schema key or the env-style key a pasted block uses. */
function stringField(
  record: Record<string, unknown>,
  key: string,
  envKey?: string,
): string {
  for (const k of envKey ? [key, envKey] : [key]) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * Write the file atomically with owner-only permissions: the directory is
 * created 0700 and the file 0600. A credential file readable by other users is
 * a real leak, so this is enforced rather than documented.
 */
export function saveConfig(path: string, config: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const sortedNames = Object.keys(config.sources).sort();
  const out: ConfigFile = {
    version: 1,
    ...(config.default_source ? { default_source: config.default_source } : {}),
    sources: Object.fromEntries(sortedNames.map((n) => [n, config.sources[n]])),
  };

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows / filesystems without POSIX modes: nothing to enforce.
  }
  renameSync(tmp, path);
}

/** Apply a parsed source to a config, with the same validation as a load. */
export function upsertSource(
  config: ConfigFile,
  name: string,
  source: BusSource,
  opts: { force?: boolean; makeDefault?: boolean } = {},
): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new CliError(
      `invalid source name "${name}": use letters, digits, '.', '_' or '-'`,
    );
  }
  if (config.sources[name] && !opts.force) {
    throw new CliError(
      `source "${name}" already exists; pass --force to overwrite it`,
    );
  }
  const normalized: BusSource = {
    bus_url: normalizeBusURL(source.bus_url),
    worker_id: requireText(source.worker_id, "worker_id"),
    credential: requireText(source.credential, "credential"),
    ...(source.type?.trim() ? { type: source.type.trim() } : {}),
  };
  config.sources[name] = normalized;
  if (opts.makeDefault || !config.default_source) {
    config.default_source = name;
  }
}

/** Remove a source; removing the default clears the default. */
export function removeSource(config: ConfigFile, name: string): void {
  if (!config.sources[name]) {
    throw new CliError(
      `source "${name}" does not exist (have: ${namesOf(config) || "none"})`,
    );
  }
  delete config.sources[name];
  if (config.default_source === name) {
    delete config.default_source;
  }
}

/** The source a `show`/`import` without a name resolves to. */
export function defaultSourceName(config: ConfigFile): string {
  if (config.default_source) return config.default_source;
  const names = Object.keys(config.sources);
  if (names.length === 1) return names[0];
  if (names.length === 0) {
    throw new CliError("no sources configured yet");
  }
  throw new CliError(
    `no default source set and ${names.length} sources exist; name one (${names.join(", ")}) ` +
      `or run 'niq-agent config default <name>'`,
  );
}

/**
 * Parse the WebUI's copyable connect block (`KEY=value` lines, `# type=…`).
 * Also accepts the snake_case schema keys and a leading `export `.
 */
export function parseConnectBlock(text: string): {
  source: BusSource;
  warnings: string[];
} {
  const values: Partial<Record<keyof BusSource, string>> = {};
  const warnings: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      const m = /^#\s*type\s*[:=]\s*(.*)$/i.exec(line);
      if (m && m[1].trim()) values.type = unquote(m[1].trim());
      continue;
    }

    const cleaned = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) {
      warnings.push(`ignored line (not KEY=value): ${line}`);
      continue;
    }
    const key = cleaned.slice(0, eq).trim();
    const value = unquote(cleaned.slice(eq + 1).trim());
    const mapped = CONNECT_KEYS[key];
    if (!mapped) {
      warnings.push(`ignored unknown key: ${key}`);
      continue;
    }
    values[mapped] = value;
  }

  const missing = (["bus_url", "worker_id", "credential"] as const).filter(
    (k) => !values[k]?.trim(),
  );
  if (missing.length > 0) {
    throw new CliError(
      `connect block is missing ${missing
        .map((k) => CONNECT_KEYS_LABEL[k])
        .join(", ")}. Paste the whole block the niq WebUI shows for a remote ` +
        `worker (NIQ_BUS_URL / NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL).`,
    );
  }

  const type = values.type?.trim();
  return {
    source: {
      bus_url: normalizeBusURL(values.bus_url!),
      worker_id: values.worker_id!.trim(),
      credential: values.credential!.trim(),
      ...(type ? { type } : {}),
    },
    warnings,
  };
}

const CONNECT_KEYS: Record<string, keyof BusSource | undefined> = {
  NIQ_BUS_URL: "bus_url",
  NIQ_WORKER_ID: "worker_id",
  NIQ_WORKER_CREDENTIAL: "credential",
  NIQ_WORKER_TYPE: "type",
  bus_url: "bus_url",
  worker_id: "worker_id",
  credential: "credential",
  type: "type",
};

const CONNECT_KEYS_LABEL: Record<string, string> = {
  bus_url: "NIQ_BUS_URL",
  worker_id: "NIQ_WORKER_ID",
  credential: "NIQ_WORKER_CREDENTIAL",
};

/** What `config import` read: one source, or a whole credential file. */
export type ParsedImport =
  | { kind: "source"; source: BusSource; warnings: string[] }
  | { kind: "config"; config: ConfigFile; warnings: string[] };

/**
 * Parse either shape the WebUI hands out:
 *
 *   - the niw/supervisor `KEY=value` connect block (one source);
 *   - an agent-interface credential file, i.e. JSON with a `sources` map;
 *   - a bare single-source JSON object (the same fields as one `sources` entry).
 *
 * JSON is detected by the first non-space character, so a block with a stray
 * `{` keeps its own error instead of being misread as JSON.
 */
export function parseImportText(text: string): ParsedImport {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    const { source, warnings } = parseConnectBlock(text);
    return { kind: "source", source, warnings };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new CliError(`imported JSON is not valid JSON: ${messageOf(err)}`, {
      cause: err,
    });
  }
  if (!isRecord(raw)) {
    throw new CliError("imported JSON must be a JSON object");
  }

  if (raw["sources"] !== undefined) {
    return {
      kind: "config",
      config: parseConfig(raw, "imported config"),
      warnings: [],
    };
  }
  return {
    kind: "source",
    source: parseSource(raw, "imported source"),
    warnings: [],
  };
}

/**
 * Resolve the connection a command should dial.
 *
 * Flags always overlay the chosen base, so `--source home --bus-url …` works
 * for a one-off redirect. See the module comment for the full order.
 */
export function resolveDial(
  req: DialRequest = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedDial {
  const configPath = resolveConfigPath(req.configPath, env);
  const envSource = env[SOURCE_ENV]?.trim() || "";
  const sourceName = req.source?.trim() || envSource;
  // `--source`, NIQ_INTERFACE_SOURCE or `--config` all express "use the file".
  const wantsFile = Boolean(sourceName) || Boolean(req.configPath);

  const envBusURL = (env[BUS_ENV_VARS.busURL] ?? "").trim();
  const envWorkerID = (env[BUS_ENV_VARS.workerID] ?? "").trim();
  const envCredential = (env[BUS_ENV_VARS.credential] ?? "").trim();
  const envPresent = [envBusURL, envWorkerID, envCredential].filter(Boolean);
  const flagsComplete = Boolean(req.busURL && req.workerID && req.credential);

  // Read the file only when it can matter: an explicit source/--config, or a
  // connection that the environment/flags do not already supply in full. A
  // broken file must not block a command that dials purely from the env.
  // Only `--source` makes the file required — `--config` picks a file, but
  // complete flags/env still make it optional.
  const needConfig = wantsFile || (!flagsComplete && envPresent.length !== 3);
  const loaded = needConfig
    ? loadConfig(configPath, Boolean(sourceName))
    : { config: emptyConfig(), exists: false, warnings: [] };

  const warnings = [...loaded.warnings];
  let base: { name: string; source: BusSource } | undefined;

  if (sourceName) {
    const source = loaded.config.sources[sourceName];
    if (!source) {
      throw new CliError(
        `source "${sourceName}" not found in ${configPath} ` +
          `(${namesOf(loaded.config) || "no sources yet"}). ` +
          `Import one with 'niq-agent config import ${sourceName}'.`,
      );
    }
    base = { name: sourceName, source };
  } else if (envPresent.length === 3) {
    base = {
      name: "env",
      source: {
        bus_url: envBusURL,
        worker_id: envWorkerID,
        credential: envCredential,
      },
    };
  } else if (envPresent.length > 0) {
    const missing = [
      envBusURL ? "" : BUS_ENV_VARS.busURL,
      envWorkerID ? "" : BUS_ENV_VARS.workerID,
      envCredential ? "" : BUS_ENV_VARS.credential,
    ].filter(Boolean);
    throw new CliError(
      `incomplete environment: set all three of ${BUS_ENV_VARS.busURL} / ` +
        `${BUS_ENV_VARS.workerID} / ${BUS_ENV_VARS.credential} (missing ${missing.join(", ")}), ` +
        `or use --source / a credential file.`,
    );
  } else if (!flagsComplete) {
    const def = loaded.config.default_source;
    if (def) {
      base = { name: def, source: loaded.config.sources[def] };
    } else {
      const names = Object.keys(loaded.config.sources);
      if (names.length === 1) {
        base = { name: names[0], source: loaded.config.sources[names[0]] };
      } else if (names.length > 1) {
        throw new CliError(
          `no default source and ${names.length} sources exist in ${configPath}; ` +
            `pass --source <name> (${names.join(", ")}) or run ` +
            `'niq-agent config default <name>'.`,
        );
      }
    }
  }

  const busURL = (req.busURL ?? base?.source.bus_url ?? "").trim();
  const workerID = (req.workerID ?? base?.source.worker_id ?? "").trim();
  const credential = (req.credential ?? base?.source.credential ?? "").trim();
  const type = base?.source.type;

  const missing = [
    busURL ? "" : "bus URL",
    workerID ? "" : "worker id",
    credential ? "" : "credential",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new CliError(
      `no bus connection configured (missing ${missing.join(", ")}). ` +
        `Create a remote worker in the niq WebUI, then run ` +
        `'niq-agent config import <name>' and paste its connect block; ` +
        `or set ${BUS_ENV_VARS.busURL} / ${BUS_ENV_VARS.workerID} / ` +
        `${BUS_ENV_VARS.credential}.`,
    );
  }

  return {
    configPath,
    source: base?.name ?? "flags",
    busURL: normalizeBusURL(busURL),
    workerID,
    credential,
    ...(type ? { type } : {}),
    warnings,
  };
}

/** Normalize a bus URL: require http(s), add `http://` if the scheme is missing. */
export function normalizeBusURL(raw: string): string {
  const trimmed = requireText(raw, "bus_url").replace(/\/+$/, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(
      `invalid bus URL ${JSON.stringify(raw)} (expected http://host:port)`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(
      `invalid bus URL ${JSON.stringify(raw)}: only http/https are supported`,
    );
  }
  return withScheme;
}

/** Names in a config, for error messages. */
export function namesOf(config: ConfigFile): string {
  return Object.keys(config.sources).sort().join(", ");
}

function requireText(value: string, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new CliError(`${field} must not be empty`);
  return trimmed;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function permissionWarning(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
      return `${path} is accessible by other users (mode ${mode}); run 'chmod 600 ${path}'`;
    }
  } catch {
    // best-effort: a stat failure must not block a working config
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a path exists (used by `config path`). */
export function configExists(path: string): boolean {
  return existsSync(path);
}
