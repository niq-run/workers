/**
 * MCP (Model Context Protocol) over stdio — the `mcp` form of the interface
 * worker.
 *
 * Two modes, one binary:
 *
 *   one-shot    every tool call dials the bus, does its thing, and closes.
 *               No state, no presence, nothing left running between calls —
 *               the CLI's model, wearing an MCP hat.
 *
 *   persistent  the server dials once at startup and holds the SSE session
 *               open. Events routed to the identity accumulate in a bounded
 *               in-memory {@link EventInbox}; `niq_inbox` reads it with a
 *               cursor (and can block briefly). That is what lets a client
 *               implement a2a-style "send, then poll for what came back":
 *               `niq_send` returns immediately, `niq_inbox` shows the result.
 *
 * Transport rules (same discipline as the CLI): stdout carries JSON-RPC lines
 * only — anything human goes to stderr. The process never writes a log line to
 * stdout, or it would corrupt the protocol.
 *
 * Server capabilities are tools only; there are no resources or prompts. Every
 * tool is annotated read-only when it is, and errors are tool errors
 * (`isError: true`) rather than protocol errors, so a model can read them.
 */
import {
  DEFAULT_SESSION_CONNECT_TIMEOUT_MS,
  EventType,
  newId,
  s,
  type Event,
  type InterfaceSession,
  type JsonSchema,
} from "@niq.run/worker-sdk";
import { openSession, previewEvent, publish, request, type BusDial } from "./bus.js";
import { resolveDial } from "./config.js";
import { CliError } from "./errors.js";
import {
  DEFAULT_INBOX_SIZE,
  EventInbox,
  MAX_INBOX_LIMIT,
  type InboxQuery,
  type InboxSlice,
} from "./inbox.js";

/** Protocol versions this server can speak, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "niq-interface";

/** Default reply timeout for `niq_request` (matches the CLI's `request`). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Cap on `niq_inbox.wait_ms`. */
const MAX_WAIT_MS = 300_000;

export type McpMode = "one-shot" | "persistent";

export interface McpServerOptions {
  mode: McpMode;
  /** The credential environment (`process.env`). */
  env: Record<string, string | undefined>;
  /** The session's fixed dial. Required for `persistent`; resolved per call otherwise. */
  dial?: BusDial;
  /** Require persistent mode's inbox capacity. Default 500. */
  inboxSize?: number;
  /** Server version reported in `initialize`. */
  version: string;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
}

/** What the server needs from the process: stdin lines, stdout, stderr. */
export interface McpTransport {
  /** One line per element; the stream ends when stdin closes. */
  lines: AsyncIterable<string>;
  /** Write one complete JSON-RPC message (no trailing newline needed). */
  write(line: string): void;
  /** Diagnostics. Never the protocol channel. */
  err(line: string): void;
}

/** Run the server until stdin closes. Returns a process exit code. */
export async function runMcpServer(
  opts: McpServerOptions,
  transport: McpTransport,
): Promise<number> {
  return new McpServer(opts, transport).run();
}

/** A tool failure the model should read (as opposed to a protocol error). */
class ToolError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

class McpServer {
  private readonly io: McpTransport;
  private readonly inbox: EventInbox;
  private readonly startedAt = Date.now();
  private readonly pending = new Set<Promise<void>>();
  private readonly tools: ToolDefinition[];

  /** Persistent mode only. */
  private session?: InterfaceSession;
  private state: "connected" | "closed" | "idle" = "idle";
  private connecting?: Promise<InterfaceSession>;
  private pump?: Promise<void>;
  private lastError?: string;
  private stopping = false;
  private negotiated: string = DEFAULT_PROTOCOL_VERSION;

  constructor(
    private readonly opts: McpServerOptions,
    io: McpTransport,
  ) {
    this.io = io;
    this.inbox = new EventInbox(opts.inboxSize ?? DEFAULT_INBOX_SIZE);
    this.tools = this.buildTools();
  }

  private get persistent(): boolean {
    return this.opts.mode === "persistent";
  }

  // ── Protocol loop ──

  async run(): Promise<number> {
    if (this.persistent) {
      // Dial at startup so the inbox starts filling immediately. A failure is
      // reported but not fatal: the next tool call retries, and an agent that
      // only uses one-shot-ish tools can still work once the bus is back.
      await this.ensureSession().catch((err: unknown) => {
        this.lastError = messageOf(err);
        this.io.err(
          `niq-interface mcp: could not connect at startup (${this.lastError}); ` +
            `will retry on the next tool call`,
        );
      });
    }

    for await (const line of this.io.lines) {
      const text = line.trim();
      if (!text) continue;
      this.track(this.handleLine(text));
    }

    await this.shutdown();
    return 0;
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private async handleLine(text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.fail(null, -32700, "parse error: the line is not valid JSON");
      return;
    }
    if (!isRecord(msg)) {
      this.fail(null, -32600, "invalid request: expected a JSON-RPC object");
      return;
    }

    const method = typeof msg["method"] === "string" ? msg["method"] : undefined;
    const id = msg["id"];
    const hasID = typeof id === "string" || typeof id === "number";

    // A message without a method is a response from the client; a message
    // without an id is a notification. Neither gets a reply.
    if (!method) return;
    if (!hasID) {
      // notifications/initialized, notifications/cancelled: nothing to do.
      return;
    }

    try {
      switch (method) {
        case "initialize":
          this.respond(id, this.initializeResult(msg["params"]));
          return;
        case "ping":
          this.respond(id, {});
          return;
        case "tools/list":
          this.respond(id, { tools: this.tools.map(toolWire) });
          return;
        case "tools/call":
          this.respond(id, await this.callTool(msg["params"]));
          return;
        default:
          this.fail(id, -32601, `method not found: ${method}`);
          return;
      }
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.fail(id, err.code, err.message);
        return;
      }
      this.fail(id, -32603, `internal error: ${messageOf(err)}`);
    }
  }

  private initializeResult(params: unknown): Record<string, unknown> {
    const requested =
      isRecord(params) && typeof params["protocolVersion"] === "string"
        ? params["protocolVersion"]
        : undefined;
    this.negotiated =
      requested && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;

    return {
      protocolVersion: this.negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: this.opts.version },
      instructions: this.instructions(),
    };
  }

  private instructions(): string {
    const common =
      `niq interface worker over MCP (${this.opts.mode}). Sends are directed: ` +
      `there is no broadcast and no implicit target. If the target worker id is ` +
      `unknown, ask the user instead of guessing ("niq" is a common reasoning-` +
      `worker name, but it is not a default). `;
    return this.persistent
      ? common +
          `This server holds one live bus session, so events routed to its ` +
          `identity keep arriving. Use niq_send for fire-and-forget work, then ` +
          `niq_inbox to read what came back: pass the returned next_cursor back ` +
          `as cursor, and use wait_ms to block briefly instead of polling in a ` +
          `tight loop.`
      : common +
          `Every call dials the bus, finishes, and disconnects; for a "send, then ` +
          `observe the reply later" workflow, start the server with the ` +
          `persistent mode instead.`;
  }

  private respond(id: string | number, result: unknown): void {
    this.io.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private fail(id: string | number | null, code: number, message: string): void {
    this.io.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  // ── tools/call ──

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params["name"] !== "string") {
      throw new ProtocolError(-32602, "tools/call needs a tool name");
    }
    const name = params["name"];
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      return errorResult(`unknown tool: ${name}`);
    }
    try {
      const value = await tool.run(args);
      return {
        content: [{ type: "text", text: render(value) }],
        ...(isRecord(value) ? { structuredContent: value } : {}),
      };
    } catch (err) {
      if (err instanceof ToolError) {
        return errorResult(
          err.detail === undefined ? err.message : `${err.message}\n${render(err.detail)}`,
        );
      }
      return errorResult(messageOf(err));
    }
  }

  // ── Tools ──

  private buildTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "niq_send",
        description:
          "Send one directed niq event to a worker and return immediately. " +
          "Fire-and-forget: the reply (if any) arrives as a new event, visible " +
          "with niq_inbox in persistent mode. Requires an explicit target — there " +
          "is no broadcast and no implicit default.",
        inputSchema: s.object({
          target: s.string("Target worker id (ask the user if unknown)"),
          event: s.string("Event type to send, e.g. worker.input"),
          payload: s.optional(s.any("JSON object payload")),
          trace: s.optional(s.string("Trace id to attach")),
          source: s.optional(s.string("Credential source name (default: the resolved one)")),
        }),
        readOnly: false,
        run: (args) => this.toolSend(args),
      },
      {
        name: "niq_request",
        description:
          "Send a directed niq request and wait for the correlated reply " +
          "(request.completed / request.failed / request.rejected). Use this for " +
          "tool-like capabilities. Reason-family workers consume worker.input " +
          "without replying — use niq_say for those.",
        inputSchema: s.object({
          target: s.string("Target worker id"),
          event: s.string("Event type (the capability to invoke)"),
          payload: s.optional(s.any("JSON object payload")),
          timeout_ms: s.optional(s.integer("Reply timeout in ms (default 30000)")),
          trace: s.optional(s.string("Trace id to attach")),
          source: s.optional(s.string("Credential source name")),
        }),
        readOnly: false,
        run: (args) => this.toolRequest(args),
      },
      {
        name: "niq_say",
        description:
          'Send worker.input with {text, input_mode} to one reason worker — the ' +
          "short form for waking it. mode is append (default), schedule or interrupt.",
        inputSchema: s.object({
          target: s.string("Reason worker id"),
          text: s.string("Message text"),
          mode: s.optional(s.enumOf(["append", "schedule", "interrupt"], "Delivery mode")),
          trace: s.optional(s.string("Trace id to attach")),
          source: s.optional(s.string("Credential source name")),
        }),
        readOnly: false,
        run: (args) => this.toolSay(args),
      },
      {
        name: "niq_status",
        description:
          "Report this server's bus connection and, in persistent mode, its inbox " +
          "counters. Does not dial in one-shot mode.",
        inputSchema: s.object({}),
        readOnly: true,
        run: () => this.toolStatus(),
      },
    ];

    if (this.persistent) {
      tools.push({
        name: "niq_inbox",
        description:
          "Read events routed to this worker since a cursor. Returns " +
          "{events, next_cursor, ...}; pass next_cursor back as cursor. " +
          "wait_ms blocks until something arrives (or the timeout), which is " +
          "cheaper than polling in a loop. Reply events to niq_request appear " +
          "here too.",
        inputSchema: s.object({
          cursor: s.optional(s.integer("Last seq already read (default 0)")),
          limit: s.optional(s.integer(`Max events to return (default 50, max ${MAX_INBOX_LIMIT})`)),
          types: s.optional(s.array(s.string(), "Event-type patterns, e.g. reason.*")),
          from: s.optional(s.array(s.string(), "Only these sender worker ids")),
          wait_ms: s.optional(s.integer(`Block up to this long for an event (max ${MAX_WAIT_MS})`)),
        }),
        readOnly: true,
        run: (args) => this.toolInbox(args),
      });
    }

    return tools;
  }

  private async toolSend(args: Record<string, unknown>): Promise<unknown> {
    const target = requireString(args, "target", "the target worker id");
    const event = requireString(args, "event", "the event type");
    const payload = optionalObject(args, "payload") ?? {};
    const traceID = optionalString(args, "trace");

    if (this.persistent) {
      const session = await this.ensureSession();
      this.assertSource(args);
      const evt = previewEvent(this.sessionDial(), { type: event, payload, traceID });
      await session.send(evt, target);
      return { ok: true, mode: this.opts.mode, target, type: evt.type, event_id: evt.id, ...traceField(traceID) };
    }

    const dial = this.resolveForCall(args);
    const outcome = await publish(
      dial,
      { type: event, payload, targets: [target], ...(traceID ? { traceID } : {}) },
      this.busContext(),
    );
    return {
      ok: true,
      mode: this.opts.mode,
      target,
      type: outcome.event.type,
      event_id: outcome.event.id,
      ...traceField(traceID),
      disconnected: true,
    };
  }

  private async toolRequest(args: Record<string, unknown>): Promise<unknown> {
    const target = requireString(args, "target", "the target worker id");
    const event = requireString(args, "event", "the event type");
    const payload = optionalObject(args, "payload") ?? {};
    const traceID = optionalString(args, "trace");
    const timeoutMs = optionalInt(args, "timeout_ms") ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (this.persistent) {
      const session = await this.ensureSession();
      this.assertSource(args);
      const evt = previewEvent(this.sessionDial(), {
        type: event,
        payload,
        traceID: traceID ?? newId(),
      });
      try {
        const reply = await session.request(target, evt, { timeoutMs });
        return {
          ok: true,
          mode: this.opts.mode,
          target,
          request_id: evt.request_id,
          reply,
          ...traceField(traceID),
        };
      } catch (err) {
        throw await this.replyFailure(evt, target, err);
      }
    }

    const dial = this.resolveForCall(args);
    const outcome = await request(
      dial,
      {
        type: event,
        payload,
        target,
        timeoutMs,
        ...(traceID ? { traceID } : {}),
      },
      this.busContext(),
    );
    if (!outcome.ok) {
      throw new ToolError(`request ${event} to ${target} failed: ${outcome.error}`, {
        ok: false,
        mode: this.opts.mode,
        target,
        request_id: outcome.requestID,
        reply: outcome.reply,
      });
    }
    return {
      ok: true,
      mode: this.opts.mode,
      target,
      request_id: outcome.requestID,
      reply: outcome.reply,
      ...traceField(traceID),
      disconnected: true,
    };
  }

  /** Persistent-mode request failures carry the same shape as the one-shot path. */
  private async replyFailure(
    evt: Event,
    target: string,
    err: unknown,
  ): Promise<ToolError> {
    const reply = (err as { reply?: Event }).reply;
    if (reply) {
      return new ToolError(`request ${evt.type} to ${target} failed: ${messageOf(err)}`, {
        ok: false,
        mode: this.opts.mode,
        target,
        request_id: evt.request_id,
        reply,
      });
    }
    return new ToolError(messageOf(err));
  }

  private async toolSay(args: Record<string, unknown>): Promise<unknown> {
    const target = requireString(args, "target", "the reason worker id");
    const text = requireString(args, "text", "the message text");
    const mode = optionalString(args, "mode") ?? "append";
    if (mode !== "append" && mode !== "schedule" && mode !== "interrupt") {
      throw new ToolError(`invalid mode "${mode}": use append, schedule or interrupt`);
    }
    const traceID = optionalString(args, "trace");
    const payload = { text, input_mode: mode };

    if (this.persistent) {
      const session = await this.ensureSession();
      this.assertSource(args);
      const evt = previewEvent(this.sessionDial(), {
        type: EventType.WorkerInput,
        payload,
        traceID,
      });
      await session.send(evt, target);
      return {
        ok: true,
        mode: this.opts.mode,
        target,
        type: evt.type,
        input_mode: mode,
        event_id: evt.id,
        ...traceField(traceID),
      };
    }

    const dial = this.resolveForCall(args);
    const outcome = await publish(
      dial,
      { type: EventType.WorkerInput, payload, targets: [target], ...(traceID ? { traceID } : {}) },
      this.busContext(),
    );
    return {
      ok: true,
      mode: this.opts.mode,
      target,
      type: outcome.event.type,
      input_mode: mode,
      event_id: outcome.event.id,
      ...traceField(traceID),
      disconnected: true,
    };
  }

  private async toolStatus(): Promise<unknown> {
    if (this.persistent) {
      const dial = this.sessionDial();
      return {
        mode: this.opts.mode,
        connected: this.state === "connected",
        session: this.state,
        source: dial.source,
        worker_id: dial.workerID,
        bus_url: dial.busURL,
        credential_configured: true,
        uptime_ms: Date.now() - this.startedAt,
        inbox: {
          buffered: this.inbox.size,
          oldest_cursor: this.inbox.read({ limit: 1 }).oldest_cursor,
          latest_cursor: this.inbox.latestCursor,
          dropped: this.inbox.droppedTotal,
        },
        ...(this.lastError ? { last_error: this.lastError } : {}),
        note:
          "One identity = one live bus session: a CLI command using this same " +
          "source would replace this connection. Give the MCP server its own source.",
      };
    }

    const dial = this.resolveForCall({});
    return {
      mode: this.opts.mode,
      connected: null,
      source: dial.source,
      worker_id: dial.workerID,
      bus_url: dial.busURL,
      credential_configured: true,
      uptime_ms: Date.now() - this.startedAt,
      note:
        "One-shot mode: each tool call dials and disconnects, so there is no " +
        "live session and no inbox. Start with --persistent to hold a session " +
        "and buffer inbound events.",
    };
  }

  private async toolInbox(args: Record<string, unknown>): Promise<unknown> {
    const query: InboxQuery = {};
    const cursor = optionalInt(args, "cursor");
    if (cursor !== undefined) query.cursor = cursor;
    const limit = optionalInt(args, "limit");
    if (limit !== undefined) query.limit = limit;
    const types = optionalStringArray(args, "types");
    if (types) query.types = types;
    const from = optionalStringArray(args, "from");
    if (from) query.from = from;

    const waitMs = Math.min(optionalInt(args, "wait_ms") ?? 0, MAX_WAIT_MS);
    const slice = await this.inbox.readWithWait(
      query,
      waitMs,
      () => this.state !== "connected",
    );
    return { ...slice, session: this.state, ...this.inboxNote(slice) };
  }

  private inboxNote(slice: InboxSlice): Record<string, unknown> {
    if (this.state !== "connected") {
      return {
        note:
          `the bus session is ${this.state}` +
          (this.lastError ? ` (${this.lastError})` : "") +
          "; buffered events are still readable, and the next tool call retries the connection",
      };
    }
    if (slice.gap) {
      return {
        note:
          "events were dropped before oldest_cursor (the inbox is bounded); " +
          "treat this slice as incomplete",
      };
    }
    return {};
  }

  // ── Persistent session ──

  /** Open the session if needed; concurrent callers share one attempt. */
  private async ensureSession(): Promise<InterfaceSession> {
    if (this.session && this.state === "connected") return this.session;
    if (this.connecting) return this.connecting;
    const dial = this.sessionDial();

    const attempt = (async (): Promise<InterfaceSession> => {
      if (this.session) {
        await this.session.close().catch(() => {});
        this.session = undefined;
      }
      const session = await openSession(dial, this.busContext());
      this.session = session;
      this.state = "connected";
      this.lastError = undefined;
      this.startPump(session);
      this.io.err(
        `niq-interface mcp: connected as ${dial.workerID} (source ${dial.source}, bus ${dial.busURL})`,
      );
      return session;
    })();
    this.connecting = attempt;
    try {
      return await attempt;
    } catch (err) {
      this.state = this.session ? this.state : "closed";
      this.lastError = messageOf(err);
      throw err;
    } finally {
      this.connecting = undefined;
    }
  }

  /** Drain the session's events into the inbox until the stream ends. */
  private startPump(session: InterfaceSession): void {
    this.pump = (async (): Promise<void> => {
      try {
        for await (const evt of session.events()) {
          this.inbox.push(evt);
        }
        this.markClosed("the bus closed the event stream");
      } catch (err) {
        this.markClosed(messageOf(err));
      }
    })();
  }

  private markClosed(reason: string): void {
    if (this.stopping) return;
    this.state = "closed";
    this.lastError = reason;
    this.io.err(`niq-interface mcp: session closed (${reason}); will reconnect on demand`);
  }

  private sessionDial(): BusDial {
    if (!this.opts.dial) {
      throw new CliError("persistent mode needs a resolved connection (internal error)");
    }
    return this.opts.dial;
  }

  /** In persistent mode the server holds ONE identity. */
  private assertSource(args: Record<string, unknown>): void {
    const source = optionalString(args, "source");
    const dial = this.sessionDial();
    if (source && source !== dial.source) {
      throw new ToolError(
        `this server holds one session as source "${dial.source}"; ` +
          `restart with --source ${source} to change identity`,
      );
    }
  }

  // ── One-shot dialing ──

  private resolveForCall(args: Record<string, unknown>): BusDial {
    const source = optionalString(args, "source");
    const dial = resolveDial(source ? { source } : {}, this.opts.env);
    for (const warning of dial.warnings) {
      this.io.err(`niq-interface mcp: warning: ${warning}`);
    }
    return dial;
  }

  private busContext(): { fetchImpl?: typeof fetch; connectTimeoutMs?: number } {
    return {
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      connectTimeoutMs: this.opts.connectTimeoutMs ?? DEFAULT_SESSION_CONNECT_TIMEOUT_MS,
    };
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = undefined;
    }
    await this.pump?.catch(() => {});
    this.state = "closed";
  }
}

/** A JSON-RPC error raised while handling a request. */
class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function toolWire(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly },
  };
}

function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function traceField(traceID: string | undefined): Record<string, unknown> {
  return traceID ? { trace_id: traceID } : {};
}

function requireString(args: Record<string, unknown>, key: string, what: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(`${key} is required: ${what}`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return undefined;
}

function optionalObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ToolError(`${key} must be a JSON object`);
  return value;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ToolError(`${key} must be an array of strings`);
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
