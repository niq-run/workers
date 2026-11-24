/**
 * The MSP backend — the capability half of the worker.
 *
 * An *interface worker* (`InterfaceWorker` from `@niq.run/worker-sdk`) faces the
 * bus; a *backend* implements its capability. Here the capability is "reach an
 * MSP world", so this file holds everything about MSP rather than about niq:
 * the node identity, the shared discovery directory, the TCP endpoint, and the
 * tool/signal bridge in both directions.
 *
 *   niq  ── msp.nodes / msp.call / msp.publish / msp.manifest ──▶  MSP node
 *   MSP  ── niq_call / niq_send (tools on the MSP node) ────────▶  niq bus
 *   MSP  ── inbound signals ───────────────────────────────────▶  niq event
 *
 * The backend never touches the bus channel directly: it publishes through the
 * handler the interface worker injects, and it is handed the worker's tool host
 * by the assembly (`registerTools`). That is the same split as the lark worker.
 */
import {
  argInt,
  argString,
  createEvent,
  parseToolCall,
  replyValue,
  type Event,
  type IfaceBackend,
  type IfaceHandler,
  type IfaceRunnable,
  type IfaceToolHost,
} from "@niq.run/worker-sdk";
import { Type } from "@sinclair/typebox";
import {
  isValidSignalPath,
  MSPNode,
  type Signal,
  type ToolResult,
} from "./vendor/msp-ts/index.js";
import type { MspConfig } from "./config.js";

export const NS = "msp";

/** The niq tools this worker serves. */
export const MSP_TOOL_NODES = "msp.nodes";
export const MSP_TOOL_CALL = "msp.call";
export const MSP_TOOL_PUBLISH = "msp.publish";
export const MSP_TOOL_MANIFEST = "msp.manifest";

/** The tools this worker adds to its MSP node, so MSP peers can reach niq. */
export const MSP_NIQ_CALL = "niq_call";
export const MSP_NIQ_SEND = "niq_send";

const NodesRequest = Type.Object({});
const CallRequest = Type.Object({
  peer: Type.String({ description: "MSP node id (see msp.nodes)" }),
  tool: Type.String({ description: "MSP tool name on that node" }),
  args: Type.Optional(Type.Object({}, { additionalProperties: true })),
  timeout_ms: Type.Optional(
    Type.Integer({ minimum: 1, description: "Call timeout in milliseconds" }),
  ),
});
const PublishRequest = Type.Object({
  path: Type.String({ description: "Signal path, e.g. device.temp" }),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
});
const ManifestRequest = Type.Object({
  peer: Type.String({ description: "MSP node id" }),
});

const NiqCallRequest = Type.Object({
  target: Type.String({ description: "niq worker id to call" }),
  event: Type.String({ description: "niq event/tool name" }),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
});
const NiqSendRequest = Type.Object({
  target: Type.String({ description: "niq worker id to send to" }),
  event: Type.String({ description: "niq event name" }),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

/** Where diagnostics go. Matches the shape the other workers use. */
export interface MspLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const DEFAULT_MSP_LOGGER: MspLogger = {
  info: (...args) => console.error(`[${NS}]`, ...args),
  warn: (...args) => console.error(`[${NS}]`, ...args),
  error: (...args) => console.error(`[${NS}]`, ...args),
};

/**
 * The subset of `MSPNode` this backend uses. Declared structurally so tests can
 * substitute a fake node without the real TCP/discovery stack.
 */
export interface MspNodeLike {
  readonly nodeId: string;
  tool(
    name: string,
    description: string,
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
    inputSchema?: Record<string, unknown>,
  ): unknown;
  declareSignal(path: string, description?: string): unknown;
  on(pattern: string, cb: (sig: Signal) => void): unknown;
  start(): Promise<{ host: string; port: number }>;
  stop(): void;
  call(
    peerId: string,
    tool: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResult>;
  publish(path: string, payload: Record<string, unknown>): void;
  connections(): string[];
  peerManifest(peerId: string): Record<string, unknown> | undefined;
}

/** What the assembly can pass the backend: MSP config plus test seams. */
export interface MspBackendOptions extends MspConfig {
  /** Replace the MSP node construction (tests inject a fake). */
  nodeFactory?: (nodeID: string, opts: MspNodeOptionsLike) => MspNodeLike;
  /** Where to log. Defaults to console (stderr). */
  logger?: MspLogger;
}

/** The constructor options forwarded to {@link MSPNode}. */
export interface MspNodeOptionsLike {
  nodesDir: string;
  host: string;
  port: number;
  connectPolicy: "eager" | "lazy";
}

function defaultNodeFactory(nodeID: string, opts: MspNodeOptionsLike): MspNodeLike {
  return new MSPNode(nodeID, opts);
}

/**
 * The MSP ⇄ niq bridge, as a backend.
 *
 * It serves four niq tools (inspect the world, call a peer, publish a signal,
 * inspect a manifest), exposes two tools on the MSP node so peers can call back
 * into niq, and forwards inbound MSP signals as a niq event.
 */
export class MspBackend implements IfaceBackend, IfaceRunnable {
  private readonly nodeID: string;
  private readonly nodesDir: string;
  private readonly host: string;
  private readonly port: number;
  private readonly connectPolicy: "eager" | "lazy";
  private readonly subscribe: string[];
  private readonly signalEventType: string;
  private readonly signalTarget?: string;
  private readonly callTimeoutMs: number;
  private readonly declareSignals: string[];
  private readonly nodeFactory: (id: string, opts: MspNodeOptionsLike) => MspNodeLike;
  private readonly logger: MspLogger;

  /** The handles into niq; injected by the interface worker before start. */
  private h?: IfaceHandler;
  /** The worker that serves this backend's tools; set by {@link registerTools}. */
  private host_?: IfaceToolHost;
  private node?: MspNodeLike;
  /** In-flight signal forwardings, awaited on stop. */
  private readonly work = new Set<Promise<void>>();

  constructor(opts: MspBackendOptions) {
    this.nodeID = opts.nodeID;
    this.nodesDir = opts.nodesDir;
    this.host = opts.host;
    this.port = opts.port;
    this.connectPolicy = opts.connectPolicy;
    this.subscribe = [...opts.subscribe];
    this.signalEventType = opts.signalEventType;
    this.signalTarget = opts.signalTarget;
    this.callTimeoutMs = opts.callTimeoutMs;
    this.declareSignals = [...opts.declareSignals];
    this.nodeFactory = opts.nodeFactory ?? defaultNodeFactory;
    this.logger = opts.logger ?? DEFAULT_MSP_LOGGER;
  }

  // ── Backend: injection ──

  /**
   * Receive the bus handles. Called once, before the worker's loop starts.
   *
   * The backend registers no inbound interest: everything niq → MSP arrives as
   * a served tool, and everything MSP → niq is pushed (send/broadcast). A future
   * subscription-style feature would be an ordinary `onEvent` registration here.
   */
  setHandler(h: IfaceHandler): void {
    this.h = h;
  }

  /** The handles, or an error when the backend is used before injection. */
  private handler(): IfaceHandler {
    if (!this.h) throw new Error(`[${NS}] backend used before setHandler`);
    return this.h;
  }

  /** The tool host, or an error when tools were not registered. */
  private toolHost(): IfaceToolHost {
    if (!this.host_) throw new Error(`[${NS}] backend used before registerTools`);
    return this.host_;
  }

  private requireNode(): MspNodeLike {
    if (!this.node) throw new Error(`[${NS}] MSP node is not running`);
    return this.node;
  }

  // ── Runnable: lifetime ──

  /** Create the MSP node, wire both bridge directions, then join the world. */
  async start(): Promise<void> {
    const node = this.nodeFactory(this.nodeID, {
      nodesDir: this.nodesDir,
      host: this.host,
      port: this.port,
      connectPolicy: this.connectPolicy,
    });
    this.node = node;
    try {
      this.registerMspTools(node);
      for (const path of this.declareSignals) node.declareSignal(path);
      for (const pattern of this.subscribe) {
        node.on(pattern, (sig) => this.forwardSignal(sig));
      }
      const ep = await node.start();
      this.logger.info(
        `node=${node.nodeId} endpoint=${ep.host}:${ep.port} nodes_dir=${this.nodesDir} ` +
          `subscribe=${this.subscribe.join(",") || "—"} declared=${this.declareSignals.length} ` +
          `signals_to=${this.signalTarget ?? "(broadcast)"} event=${this.signalEventType}`,
      );
    } catch (err) {
      this.node = undefined;
      try {
        node.stop();
      } catch {
        /* already failed; nothing to release */
      }
      throw err;
    }
  }

  /** Leave the MSP world and wait for in-flight signal forwarding. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.work]);
    const node = this.node;
    this.node = undefined;
    node?.stop();
  }

  // ── Tools: niq → MSP ──

  /**
   * Register this backend's tools on the worker that serves them. The assembly
   * calls this because it is the only place that knows both halves.
   */
  registerTools(host: IfaceToolHost): void {
    this.host_ = host;

    host.registerReadme(
      "Read this worker's usage guide: the MSP world bridge, its tools, and how MSP signals reach niq.",
      () => this.renderReadme(),
    );

    host.register(
      {
        event: MSP_TOOL_NODES,
        description:
          "List the MSP node this worker runs as, the peers it is connected to, and each peer's tools/signals/skills.",
        parameters: NodesRequest,
      },
      (evt) => this.handleNodes(evt),
    );

    host.register(
      {
        event: MSP_TOOL_CALL,
        description:
          "Call a tool on an MSP peer node and return its result. Use msp.nodes first to see who is reachable.",
        parameters: CallRequest,
      },
      (evt) => this.handleCall(evt),
    );

    host.register(
      {
        event: MSP_TOOL_PUBLISH,
        description:
          "Publish a signal into the MSP world. Every connected peer subscribed to the path receives it.",
        parameters: PublishRequest,
      },
      (evt) => this.handlePublish(evt),
    );

    host.register(
      {
        event: MSP_TOOL_MANIFEST,
        description:
          "Return the raw manifest a connected MSP peer advertised (tools, signals, skills, patterns, capabilities).",
        parameters: ManifestRequest,
      },
      (evt) => this.handleManifest(evt),
    );
  }

  private async handleNodes(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    if (!tc.callID) return;
    try {
      const node = this.requireNode();
      const connections = node.connections();
      const peers = connections.map((id) => {
        const manifest = node.peerManifest(id) ?? {};
        return {
          id,
          tools: names(manifest.tools),
          signals: paths(manifest.signals),
          skills: names(manifest.skills),
          patterns: strings(manifest.patterns),
          capabilities: strings(manifest.capabilities),
        };
      });
      await this.toolHost().replyCompleted(
        tc.callerID,
        tc.callID,
        { node_id: node.nodeId, connections, peers },
        tc.traceID,
      );
    } catch (err) {
      await this.replyError(tc.callerID, tc.callID, err, tc.traceID);
    }
  }

  private async handleCall(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    if (!tc.callID) return;
    try {
      const peer = argString(tc.args, "peer");
      if (!peer) {
        throw new Error("peer is required: an MSP node id from msp.nodes");
      }
      const tool = argString(tc.args, "tool");
      if (!tool) throw new Error("tool is required: the MSP tool name to call");
      const args = optionalObject(tc.args, "args") ?? {};
      const timeoutMs = argInt(tc.args, "timeout_ms", this.callTimeoutMs);

      const result = await this.requireNode().call(peer, tool, args, timeoutMs);
      if (result.is_error) {
        throw new Error(result.error || "MSP tool call failed");
      }
      await this.toolHost().replyCompleted(
        tc.callerID,
        tc.callID,
        { peer, tool, result: result.unwrap() ?? null },
        tc.traceID,
      );
    } catch (err) {
      await this.replyError(tc.callerID, tc.callID, err, tc.traceID);
    }
  }

  private async handlePublish(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    if (!tc.callID) return;
    try {
      const path = argString(tc.args, "path");
      if (!path) throw new Error("path is required: a dotted signal path");
      if (!isValidSignalPath(path)) {
        throw new Error(
          `invalid signal path ${JSON.stringify(path)}: use dot-separated lowercase names`,
        );
      }
      const payload = optionalObject(tc.args, "payload") ?? {};
      this.requireNode().publish(path, payload);
      await this.toolHost().replyCompleted(
        tc.callerID,
        tc.callID,
        { ok: true, path },
        tc.traceID,
      );
    } catch (err) {
      await this.replyError(tc.callerID, tc.callID, err, tc.traceID);
    }
  }

  private async handleManifest(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    if (!tc.callID) return;
    try {
      const peer = argString(tc.args, "peer");
      if (!peer) throw new Error("peer is required: an MSP node id");
      const manifest = this.requireNode().peerManifest(peer) ?? {};
      await this.toolHost().replyCompleted(
        tc.callerID,
        tc.callID,
        { peer, manifest },
        tc.traceID,
      );
    } catch (err) {
      await this.replyError(tc.callerID, tc.callID, err, tc.traceID);
    }
  }

  private async replyError(
    callerID: string,
    callID: string,
    err: unknown,
    traceID: string,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.toolHost().replyFailed(callerID, callID, message, traceID);
  }

  // ── Tools: MSP → niq ──

  /**
   * Register the callback tools on the MSP node. A peer calls them by name
   * (`niq_call` / `niq_send`) through ordinary MSP tool calls.
   *
   * Errors become MSP error results (the SDK turns a throw into `error`), which
   * is the right shape: the caller's `ToolResult.unwrap()` then throws locally.
   */
  private registerMspTools(node: MspNodeLike): void {
    node.tool(
      MSP_NIQ_CALL,
      "Call a niq worker tool and return its reply.",
      async (args) => {
        const target = stringArg(args, "target");
        if (!target) throw new Error("target is required: the niq worker id to call");
        const event = stringArg(args, "event");
        if (!event) throw new Error("event is required: the niq event/tool name");
        const payload = optionalObject(args, "payload") ?? {};
        const timeoutMs = positiveInt(args.timeout_ms) ?? this.callTimeoutMs;

        const reply = await this.handler().request(
          target,
          createEvent(event, payload),
          { timeoutMs },
        );
        return replyValue(reply.payload) ?? null;
      },
      NiqCallRequest,
    );

    node.tool(
      MSP_NIQ_SEND,
      "Send a niq event to a worker without waiting for a reply.",
      async (args) => {
        const target = stringArg(args, "target");
        if (!target) throw new Error("target is required: the niq worker id");
        const event = stringArg(args, "event");
        if (!event) throw new Error("event is required: the niq event name");
        const payload = optionalObject(args, "payload") ?? {};

        await this.handler().send(createEvent(event, payload), target);
        return { ok: true, target, event };
      },
      NiqSendRequest,
    );
  }

  // ── Signals: MSP → niq ──

  /**
   * Forward one inbound MSP signal as a niq event.
   *
   * A signal this node published itself is skipped: MSP fans a publish to every
   * *other* connection, but a loopback via a peer still comes back, and echoing
   * our own signal into niq would look like a second, spurious origin.
   */
  private forwardSignal(sig: Signal): void {
    if (sig.source === this.nodeID) return;
    const work = this.deliverSignal(sig).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`failed to forward signal ${sig.path ?? "?"}: ${message}`);
    });
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
  }

  private async deliverSignal(sig: Signal): Promise<void> {
    const h = this.h;
    if (!h) return;
    const evt = createEvent(this.signalEventType, {
      node: sig.source,
      path: sig.path,
      payload: sig.payload,
      timestamp: sig.timestamp,
    });
    if (this.signalTarget) {
      await h.send(evt, this.signalTarget);
    } else {
      await h.broadcast(evt);
    }
  }

  // ── Readme ──

  private renderReadme(): string {
    const node = this.node;
    const lines = [
      `# msp — MSP world bridge`,
      ``,
      `MSP node: \`${node?.nodeId ?? this.nodeID}\`${node ? ` (${node.connections().length} peers)` : ""}`,
      `Discovery dir: \`${this.nodesDir}\``,
      ``,
      `## niq tools`,
      ``,
      `- \`${MSP_TOOL_NODES}\` — this node, its connections, and each peer's tools/signals/skills.`,
      `- \`${MSP_TOOL_CALL}\` — \`{ peer, tool, args?, timeout_ms? }\` → \`{ peer, tool, result }\`.`,
      `- \`${MSP_TOOL_PUBLISH}\` — \`{ path, payload? }\` → \`{ ok, path }\`.`,
      `- \`${MSP_TOOL_MANIFEST}\` — \`{ peer }\` → \`{ peer, manifest }\`.`,
      ``,
      `## MSP tools (callable by peers)`,
      ``,
      `- \`${MSP_NIQ_CALL}\` — \`{ target, event, payload?, timeout_ms? }\` → the niq reply value.`,
      `- \`${MSP_NIQ_SEND}\` — \`{ target, event, payload? }\` → \`{ ok, target, event }\`.`,
      ``,
      `## Inbound signals`,
      ``,
      `Signals matching \`${this.subscribe.join(", ") || "(none)"}\` are forwarded to niq as \`${this.signalEventType}\` ` +
        `${this.signalTarget ? `(directed to \`${this.signalTarget}\`)` : "(broadcast)"}.`,
      `Each event's payload is \`{ node, path, payload, timestamp }\`.`,
    ];
    return lines.join("\n");
  }
}

// ── Argument helpers ──

function stringArg(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function optionalObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function positiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.trunc(raw);
  }
  return undefined;
}

// ── Manifest helpers ──

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined))
    .filter((v): v is string => typeof v === "string");
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined))
    .filter((v): v is string => typeof v === "string");
}
