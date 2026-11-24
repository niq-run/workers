/**
 * MSP-specific configuration, layered flags > env > defaults.
 *
 * The bus connection is handled by the SDK (`busConnFromArgs`); this file only
 * owns the MDA world's knobs: the node identity, the shared discovery directory,
 * the TCP bind address, which signals to subscribe to, and where inbound MSP
 * signals go on the niq side.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidNodeId, isValidSignalPath } from "./vendor/msp-ts/index.js";

export interface MspConfig {
  /** MSP node id (`^[a-z0-9_-]+$`); defaults to a sanitized niq worker id. */
  nodeID: string;
  /** Shared discovery directory (the "MSP world" all nodes scan). */
  nodesDir: string;
  /** TCP bind host. Defaults to 127.0.0.1. */
  host: string;
  /** TCP bind port. 0 (default) asks the OS for an ephemeral port. */
  port: number;
  /** Eager = dial discovered peers; lazy = only accept inbound connections. */
  connectPolicy: "eager" | "lazy";
  /** Signal path patterns to bridge into niq. Defaults to `["**"]`. */
  subscribe: string[];
  /** niq event type for inbound MSP signals. Defaults to `msp.signal`. */
  signalEventType: string;
  /** Optional niq worker id; when set, signals are sent to it instead of broadcast. */
  signalTarget?: string;
  /** Default timeout for `msp.call` (ms). */
  callTimeoutMs: number;
  /** Signal paths advertised in this node's manifest. */
  declareSignals: string[];
}

/** Environment variables read by {@link mspConfigFromArgs}. */
export const MSP_ENV = {
  nodeID: "MSP_NODE_ID",
  nodesDir: "MSP_NODES_DIR",
  host: "MSP_HOST",
  port: "MSP_PORT",
  connectPolicy: "MSP_CONNECT_POLICY",
  subscribe: "MSP_SUBSCRIBE",
  signalEventType: "MSP_SIGNAL_EVENT",
  signalTarget: "MSP_SIGNAL_TARGET",
  callTimeoutMs: "MSP_CALL_TIMEOUT_MS",
  declareSignals: "MSP_DECLARE_SIGNALS",
} as const;

/** The default shared discovery directory used by the MSP SDK. */
export const DEFAULT_MSP_NODES_DIR = join(homedir(), ".msp", "nodes");

/** Turn an arbitrary worker id into a legal MSP node id. */
export function sanitizeNodeID(raw: string): string {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "msp-node";
}

/**
 * Resolve the MSP configuration from parsed CLI options, the environment and
 * the niq worker id (used only as the default MSP node id).
 */
export function mspConfigFromArgs(
  opts: Record<string, string | true>,
  env: Record<string, string | undefined> = process.env,
  workerID = "msp",
): MspConfig {
  const nodeIDRaw = readOption(opts, env, "msp-node-id", MSP_ENV.nodeID);
  const nodeID = nodeIDRaw ?? sanitizeNodeID(workerID);
  if (!isValidNodeId(nodeID)) {
    throw new Error(
      `invalid MSP node id ${JSON.stringify(nodeID)}: use lowercase letters, digits, '_' or '-'`,
    );
  }

  const policyRaw = readOption(
    opts,
    env,
    "msp-connect-policy",
    MSP_ENV.connectPolicy,
  );
  const connectPolicy = policyRaw ?? "eager";
  if (connectPolicy !== "eager" && connectPolicy !== "lazy") {
    throw new Error(
      `invalid MSP connect policy ${JSON.stringify(connectPolicy)}: use eager or lazy`,
    );
  }

  const declareRaw = readOption(
    opts,
    env,
    "msp-declare-signals",
    MSP_ENV.declareSignals,
  );
  const declareSignals = splitList(declareRaw).map((path) => {
    if (!isValidSignalPath(path)) {
      throw new Error(
        `invalid MSP signal path ${JSON.stringify(path)}: use dot-separated lowercase names`,
      );
    }
    return path;
  });

  const signalEventType =
    readOption(opts, env, "msp-signal-event", MSP_ENV.signalEventType) ??
    "msp.signal";
  if (!signalEventType.trim()) {
    throw new Error("MSP signal event type must not be empty");
  }

  const subscribeRaw = readOption(
    opts,
    env,
    "msp-subscribe",
    MSP_ENV.subscribe,
  );

  const signalTarget = readOption(
    opts,
    env,
    "msp-signal-target",
    MSP_ENV.signalTarget,
  );

  return {
    nodeID,
    nodesDir:
      readOption(opts, env, "msp-nodes-dir", MSP_ENV.nodesDir) ??
      DEFAULT_MSP_NODES_DIR,
    host: readOption(opts, env, "msp-host", MSP_ENV.host) ?? "127.0.0.1",
    port: parseIntOption(
      readOption(opts, env, "msp-port", MSP_ENV.port),
      "msp-port",
      0,
      0,
      65535,
    ),
    connectPolicy,
    subscribe: subscribeRaw === undefined ? ["**"] : splitList(subscribeRaw),
    signalEventType,
    ...(signalTarget ? { signalTarget } : {}),
    callTimeoutMs: parseIntOption(
      readOption(opts, env, "msp-call-timeout-ms", MSP_ENV.callTimeoutMs),
      "msp-call-timeout-ms",
      5_000,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    declareSignals: unique(declareSignals),
  };
}

function readOption(
  opts: Record<string, string | true>,
  env: Record<string, string | undefined>,
  flag: string,
  envKey: string,
): string | undefined {
  const raw = opts[flag];
  if (raw !== undefined) {
    if (raw === true) throw new Error(`flag --${flag} needs a value`);
    const value = raw.trim();
    if (!value) throw new Error(`flag --${flag} must not be empty`);
    return value;
  }
  const fromEnv = env[envKey]?.trim();
  return fromEnv || undefined;
}

function parseIntOption(
  raw: string | undefined,
  flag: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${flag} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${flag} must be between ${min} and ${max}`);
  }
  return value;
}

function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
