/**
 * Lark worker — a WebSocket bridge between the niq event bus and Feishu/Lark,
 * built on `@larksuite/channel` (which wraps the official
 * `@larksuiteoapi/node-sdk`).
 *
 * Flow:
 *   Feishu message ──worker.input──▶ bound reason worker
 *   reason reply   ──worker.input──▶ this worker      ──send──▶ Feishu chat
 *
 * Inbound: every Feishu message is forwarded to a single bound reason worker
 * as a `worker.input` event (hiw-style), payload `{ text, input_mode }`, with
 * a `trace_id` this worker generates and remembers. The text is prefixed with
 * a `<system-reminder>` telling reason this came from Feishu and to answer
 * with its `send_message` tool.
 *
 * Outbound: the reason worker's `send_message` tool replies by sending a
 * `worker.input` back *directed to this worker*, reusing the same `trace_id`
 * (niq's default reason worker propagates it). This worker looks up the
 * trace_id → Feishu chat context and pushes the reply text to that chat.
 *
 * Credentials come from the environment: `LARK_APP_ID` / `LARK_APP_SECRET`
 * (+ `LARK_DOMAIN`), and the bus via `NIQ_BUS_URL` / `NIQ_WORKER_ID` /
 * `NIQ_WORKER_CREDENTIAL` — the niq project supervisor injects these as launch
 * args (project.json env). The default reason worker id comes from
 * `NIQ_REASON_WORKER`; an initial per-chat override map can come from
 * `LARK_REASON_WORKER_MAPPINGS` (a JSON object of {chat_id: worker_id}).
 *
 * Routing (which reason worker a Feishu chat is forwarded to) is a mutable,
 * persisted property: configured on startup, updated at runtime via the
 * `lark.reason.*` extension group, and saved to a state file so it survives
 * restarts. The runtime saves it via an injectable {@link LarkStateStore}.
 * (Third-party process snapshot/restore is not implemented yet; the worker
 * persists its own state for now.)
 *
 * Both external sides sit behind narrow interfaces so tests run without real
 * Feishu credentials or a live bus.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLarkChannel } from "@larksuite/channel";
import type {
  LarkChannelOptions,
  NormalizedMessage,
  RejectEvent,
  SendInput,
} from "@larksuite/channel";
import {
  BaseWorker,
  argString,
  createEvent,
  parseToolCall,
  type Event,
  type WorkerSideChannel,
} from "@niq.run/worker-sdk";

/** Minimal surface of `@larksuite/channel` this worker uses. Injectable for tests. */
export interface LarkChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(
    name: "message",
    handler: (msg: NormalizedMessage) => void | Promise<void>,
  ): () => void;
  on(
    name: "error",
    handler: (err: unknown) => void | Promise<void>,
  ): () => void;
  on(
    name: "reject",
    handler: (evt: RejectEvent) => void | Promise<void>,
  ): () => void;
  on(
    name: "reconnecting" | "reconnected",
    handler: () => void | Promise<void>,
  ): () => void;
  onRawEvent(
    type: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): () => void;
  send(to: string, input: SendInput): Promise<unknown>;
}

/** A minimal logger interface, satisfied by `console`. */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Wrap a logger so every line is prefixed with an ISO timestamp. */
export function withTimestamps<T extends Logger>(base: T): T {
  const ts = () => new Date().toISOString();
  for (const m of ["info", "warn", "error"] as const) {
    const orig = base[m].bind(base);
    (base as any)[m] = (...args: unknown[]) => orig(`[${ts()}]`, ...args);
  }
  return base;
}

const DEFAULT_LOGGER: Logger = withTimestamps(console);

/** The subset of the `fs/promises` API the file state store uses. Injectable. */
export interface StateFileFs {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<string | undefined>;
  readFile(file: string, enc: "utf8"): Promise<string>;
  writeFile(file: string, data: string, enc: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/**
 * Persistence for the reason-routing state. Injected for tests; the default
 * is {@link FileLarkStateStore}. This is the seam a future snapshot/restore
 * implementation can plug into without touching the worker's logic.
 */
export interface LarkStateStore {
  load(): Promise<Record<string, unknown>>;
  save(state: Record<string, unknown>): Promise<void>;
}

/**
 * A {@link LarkStateStore} backed by a local JSON file, written atomically
 * (temp file + rename) so a crash mid-write cannot corrupt the saved state.
 * A missing file loads as an empty state.
 */
export class FileLarkStateStore implements LarkStateStore {
  private readonly file: string;
  private readonly fs: StateFileFs;

  constructor(file: string, fsImpl: StateFileFs = { mkdir, readFile, writeFile, rename }) {
    this.file = file;
    this.fs = fsImpl;
  }

  async load(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.file, "utf8");
    } catch (err) {
      // First run: no state file yet — start from config defaults.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  async save(state: Record<string, unknown>): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await this.fs.mkdir(dirname(this.file), { recursive: true });
    await this.fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await this.fs.rename(tmp, this.file);
  }
}

/** The default state file path when none is configured. */
export function defaultStateFile(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.LARK_STATE_FILE?.trim() || "lark-reason-state.json";
}

/** Connection settings for the Lark side, read from the environment by default. */
export interface LarkConfig {
  appId: string;
  appSecret: string;
  /** Request domain, e.g. `https://open.feishu.cn` (default) or a Lark domain. */
  domain?: string;
  /** Extra options forwarded to the channel (see {@link LarkChannelOptions}). */
  channel?: Omit<LarkChannelOptions, "appId" | "appSecret" | "domain">;
  /** Injectable factory — defaults to {@link createLarkChannel}. */
  createChannel?: (opts: LarkChannelOptions) => LarkChannel;
}

/** Build a {@link LarkConfig} from env. Throws naming any missing vars. */
export function larkConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): LarkConfig {
  const appId = env.LARK_APP_ID?.trim() ?? "";
  const appSecret = env.LARK_APP_SECRET?.trim() ?? "";
  const domain = env.LARK_DOMAIN?.trim() || "https://open.feishu.cn";

  const missing: string[] = [];
  if (!appId) missing.push("LARK_APP_ID");
  if (!appSecret) missing.push("LARK_APP_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `niq: missing environment variable(s): ${missing.join(", ")}. ` +
        `Provide them as launch args (project.json env) when the worker is ` +
        `started by the niq project supervisor.`,
    );
  }
  return { appId, appSecret, domain };
}

const DEFAULT_SYSTEM_REMINDER = `<system-reminder>
This message was sent by a user over Feishu (Lark).
Chat id: {chat_id}
Sender open_id: {sender_open_id}
Reply to the user by calling the lark.send tool with target = "{chat_id}" and
text = your reply. The reply is delivered straight back into the user's Feishu
chat. Keep your answer in the language the user wrote in, and do not preface it
with any system notes.
</system-reminder>`;

/** Configuration for the assembled bridge. */
export interface LarkBridgeOptions extends LarkConfig {
  /** Worker-side bus channel. Injected for tests; built from env otherwise. */
  bus: WorkerSideChannel;
  /**
   * The default reason worker Feishu messages are forwarded to when a chat has
   * no per-chat override (see {@link LarkBridgeOptions.reasonWorkerMappings}),
   * unless a persisted state file overrides it. Optional: when unset, routing
   * falls through to {@link LarkBridgeOptions.fallbackReasonWorkerID}. Config
   * only seeds this value.
   */
  reasonWorkerID?: string;
  /**
   * The last-resort reason worker used when neither a per-chat mapping nor the
   * default resolves. Optional; config only seeds it (mutable at runtime and
   * persisted like the rest of the routing).
   */
  fallbackReasonWorkerID?: string;
  /**
   * Initial chat_id → reason worker id routing. Config only seeds the runtime
   * map; it is updateable at runtime via the `lark.reason.*` extensions and
   * persisted (see {@link LarkBridgeOptions.stateStore}).
   */
  reasonWorkerMappings?: Record<string, string>;
  /**
   * Persistence backend for the reason-routing state. Defaults to a local JSON
   * file at {@link LarkBridgeOptions.stateFile}. Inject for tests to avoid I/O.
   * This is the seam a future snapshot/restore implementation plugs into.
   */
  stateStore?: LarkStateStore;
  /**
   * Path for the default file state store (ignored when `stateStore` is given).
   * Falls back to `LARK_STATE_FILE`, then `./lark-reason-state.json`.
   */
  stateFile?: string;
  /**
   * Optional replacement for the default `<system-reminder>` prepended to
   * outbound worker.input text.
   */
  systemReminder?: string;
  /** When set, echo Feishu messages back instead of forwarding (connectivity check). */
  echo?: boolean;
  /**
   * Default Feishu user (open_id) to deliver proactive messages to — when a
   * reason worker sends this worker a worker.input that has no Feishu chat
   * context (i.e. not a reply to an inbound Feishu message), the text is sent
   * here instead of being dropped.
   */
  defaultUserOpenId?: string;
  /** Where to send diagnostics. Defaults to `console`. */
  logger?: Logger;
}

const NS = "lark";

/**
 * The extension lark exposes to peers (reason) for sending a Feishu message to
 * a user/chat. Non-SelfOnly so it is discovered by reason and callable.
 */
export const LARK_SEND_EVENT = "lark.send";

/**
 * The group of extensions lark exposes for managing the chat → reason worker
 * routing at runtime. All are non-SelfOnly so a control plane / admin peer can
 * discover and call them. Each mutation also persists the new routing.
 */

/** Route a Feishu chat (or set the default) to a specific reason worker. */
export const LARK_REASON_SET = "lark.reason.set";
/** Stop routing a chat to its own worker; fall back to the default. */
export const LARK_REASON_UNSET = "lark.reason.unset";
/** Return the current routing (default + per-chat overrides). */
export const LARK_REASON_GET = "lark.reason.get";

/**
 * The Feishu ⇄ reason bridge. Connect both sides, then forward Feishu
 * messages to the bound reason worker and push its replies back to Feishu.
 */
export class LarkWorker {
  private readonly lark: LarkChannel;
  private readonly bus: WorkerSideChannel;
  private readonly base: BaseWorker;
  private readonly workerID: string;
  /** Default reason worker; overridden per-chat by {@link perChat}. Mutable at runtime. */
  private defaultReasonWorker: string;
  /** Last-resort worker used when neither per-chat nor default resolves. Mutable at runtime. */
  private fallbackReasonWorker: string;
  /** chat_id → reason worker id. Updated by config seed, runtime events, and persisted state. */
  private readonly perChat = new Map<string, string>();
  private readonly stateStore: LarkStateStore;
  private readonly systemReminder: string;
  private readonly echo: boolean;
  private readonly defaultUserOpenId: string;
  private readonly logger: Logger;
  /** Settled once both the bus and Feishu sides are connected (see connect()). */
  private readonly ready: Promise<void>;
  private readonly markReady: () => void;

  /** trace_id (from the worker.input we send to reason) → Feishu chat context. */
  private readonly pending = new Map<
    string,
    { chatId: string; messageId: string }
  >();

  constructor(opts: LarkBridgeOptions) {
    const create = opts.createChannel ?? createLarkChannel;
    this.lark = create({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain,
      ...opts.channel,
    });
    this.bus = opts.bus;
    this.workerID = opts.bus.id;
    // Config seeds the routing state; a persisted state file overrides it on load.
    this.defaultReasonWorker = opts.reasonWorkerID ?? "";
    this.fallbackReasonWorker = opts.fallbackReasonWorkerID ?? "";
    for (const [chat, wid] of Object.entries(opts.reasonWorkerMappings ?? {})) {
      if (wid) this.perChat.set(chat, wid);
    }
    this.stateStore =
      opts.stateStore ??
      new FileLarkStateStore(opts.stateFile ?? defaultStateFile());
    this.systemReminder = opts.systemReminder ?? DEFAULT_SYSTEM_REMINDER;
    this.echo = opts.echo ?? false;
    this.defaultUserOpenId = opts.defaultUserOpenId ?? "";
    this.logger = opts.logger ?? DEFAULT_LOGGER;
    this.base = new BaseWorker({
      id: this.workerID,
      subscriptions: [
        { type: LARK_REASON_SET },
        { type: LARK_REASON_UNSET },
        { type: LARK_REASON_GET },
      ],
      channel: this.bus,
    });

    // Expose a peer-callable extension so reason can send Feishu messages with
    // an explicit target (chat_id / open_id / user_id). Non-SelfOnly so it is
    // discovered by reason and invoked via the tool-name bridge.
    this.base.register(
      {
        event: LARK_SEND_EVENT,
        description:
          "Send a message to a Feishu user or chat. Provide target (chat_id, open_id, or user_id) and text.",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Feishu chat_id, open_id, or user_id of the recipient",
            },
            text: { type: "string", description: "Message text" },
          },
        },
      },
      (evt) => this.handleLarkSend(evt),
    );

    // The lark.reason.* group: manage the chat → reason worker routing at
    // runtime. Every mutation is persisted so the routing survives restarts.
    this.base.register(
      {
        event: LARK_REASON_SET,
        description:
          "Route a Feishu chat to a reason worker, set the default, or set the fallback. " +
          "Provide worker_id. Include chat_id to route only that chat; include fallback=true " +
          "(no chat_id) to set the last-resort fallback; otherwise the default reason worker is set.",
        parameters: {
          type: "object",
          properties: {
            chat_id: {
              type: "string",
              description: "Feishu chat_id to route (omit to set the default or fallback)",
            },
            worker_id: {
              type: "string",
              description: "Reason worker id to route matching messages to",
            },
            fallback: {
              type: "boolean",
              description: "Set the last-resort fallback reason worker instead of the default (ignored when chat_id is given)",
            },
          },
        },
      },
      (evt) => this.handleReasonSet(evt),
    );
    this.base.register(
      {
        event: LARK_REASON_UNSET,
        description:
          "Stop routing a Feishu chat to its own reason worker and fall back to the default, " +
          "or clear the fallback. Provide chat_id to drop a chat override; include fallback=true " +
          "(chat_id optional) to clear the fallback.",
        parameters: {
          type: "object",
          properties: {
            chat_id: {
              type: "string",
              description: "Feishu chat_id to stop overriding, falling back to the default",
            },
            fallback: {
              type: "boolean",
              description: "Clear the fallback reason worker",
            },
          },
        },
      },
      (evt) => this.handleReasonUnset(evt),
    );
    this.base.register(
      {
        event: LARK_REASON_GET,
        description:
          "Return the current chat → reason worker routing (default + per-chat overrides).",
      },
      (evt) => this.handleReasonGet(evt),
    );

    let markReady!: () => void;
    this.ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    this.markReady = markReady;

    // The message handler is registered once, in the constructor, so a Feishu
    // message can never be missed due to connect() ordering. handleFeishuMessage
    // awaits this.ready before touching the bus, which preserves the original
    // guarantee: we never publish to the bus before it is connected (the WS can
    // be live before the bus SSE is ready).
    this.lark.on("message", (msg) => this.handleFeishuMessage(msg));
    this.lark.on("error", (err) =>
      this.logger.error(`[${NS}] feishu error:`, err),
    );
    this.lark.on("reject", (evt) =>
      this.logger.warn(
        `[${NS}] feishu message REJECTED by policy: ${JSON.stringify(evt)}`,
      ),
    );
    // Lowest-level probe: logs any im.message.receive_v1 the WS actually
    // delivers, before normalization / policy. If this fires but the
    // normalized 'message' event does not, the drop is in the channel's
    // normalization or policy layer, not in Feishu delivery.
    this.lark.onRawEvent("im.message.receive_v1", () =>
      this.logger.info(`[${NS}] raw im.message.receive_v1 received on WS`),
    );
    this.lark.on("reconnecting", () =>
      this.logger.warn(`[${NS}] feishu websocket reconnecting`),
    );
    this.lark.on("reconnected", () =>
      this.logger.info(`[${NS}] feishu websocket reconnected`),
    );
  }

  /** Connect both the Feishu long connection and the bus; announce presence. */
  async connect(): Promise<void> {
    await Promise.all([
      this.bus.connect().catch((err) => {
        this.logger.error(`[${NS}] bus connect failed:`, err);
        throw err;
      }),
      this.lark.connect().catch((err) => {
        this.logger.error(`[${NS}] feishu connect failed:`, err);
        throw err;
      }),
    ]);
    // Restore persisted routing before being ready, so the first Feishu message
    // already uses the saved chat → reason worker mapping.
    await this.loadState();
    this.markReady();
    this.logger.info(
      `[${NS}] connected: bus worker_id=${this.workerID} default_reason=${this.defaultReasonWorker || "—"} fallback=${this.fallbackReasonWorker || "—"} per_chat=${this.perChat.size} feishu app=${this.lark.constructor.name}`,
    );
    await this.base.announceReady("lark", [
      { type: "worker.input", description: "Feishu messages forwarded to reason" },
    ]);
    this.logger.info(`[${NS}] announced worker.ready`);
  }

  /** Connect and then run the bus event loop (blocks until {@link close}). */
  async run(): Promise<void> {
    await this.connect();
    for await (const evt of this.bus.events()) {
      if (evt.type === "worker.input") {
        // Backward path: reason used send_message→worker.input (trace or default user).
        await this.handleReasonReply(evt);
      } else {
        // Peer tool calls (e.g. the lark.send extension), own-tool events, etc.
        this.base.dispatchExtension(evt);
      }
    }
  }

  /** Close both sides. */
  async close(): Promise<void> {
    await Promise.all([
      this.bus.close().catch(() => {}),
      this.lark.disconnect().catch(() => {}),
    ]);
  }

  private async handleFeishuMessage(msg: NormalizedMessage): Promise<void> {
    // Wait until the bus is connected before doing anything, so we never
    // publish before the bus is up. The handler is registered in the
    // constructor, so a message arriving during connect() simply waits here.
    await this.ready;

    // Don't relay the bot's own outbound messages if Feishu delivers them.
    if (msg.senderType === "bot") {
      this.logger.info(
        `[${NS}] skip bot-originated message chat=${msg.chatId} msg=${msg.messageId}`,
      );
      return;
    }
    this.logger.info(
      `[${NS}] feishu message chat=${msg.chatId} msg=${msg.messageId} sender=${msg.senderId} type=${msg.senderType ?? "na"} text=${JSON.stringify(msg.content)}`,
    );

    if (this.echo) {
      await this.lark.send(msg.chatId, { text: "echo: " + msg.content });
      return;
    }

    const traceId = `feishu-${msg.chatId}-${msg.messageId}`;
    this.pending.set(traceId, { chatId: msg.chatId, messageId: msg.messageId });

    const input = createEvent("worker.input", {
      text: this.renderReminder(msg) + "\n" + msg.content,
      chat_id: msg.chatId,
      sender_open_id: msg.senderId,
      input_mode: "interrupt",
    });
    input.trace_id = traceId;
    const reasonWorker = this.reasonWorkerFor(msg.chatId);
    if (!reasonWorker) {
      this.logger.warn(
        `[${NS}] drop feishu message chat=${msg.chatId} msg=${msg.messageId}: no reason worker (no per-chat mapping, default, or fallback)`,
      );
      return;
    }
    await this.bus.send(input, reasonWorker);
    this.logger.info(
      `[${NS}] sent worker.input trace=${traceId} → reason ${reasonWorker} (chat ${msg.chatId})`,
    );
  }

  /**
   * Resolve the reason worker a chat's messages are forwarded to: per-chat
   * mapping, else the default, else the last-resort fallback. Returns "" when
   * none is configured.
   */
  private reasonWorkerFor(chatId: string): string {
    const perChat = this.perChat.get(chatId);
    if (perChat) return perChat;
    if (this.defaultReasonWorker) return this.defaultReasonWorker;
    return this.fallbackReasonWorker;
  }

  /**
   * Restore persisted routing on top of the config seed. A persisted value wins
   * over config because it is the most recent state (last write wins).
   */
  private async loadState(): Promise<void> {
    let state: Record<string, unknown>;
    try {
      state = await this.stateStore.load();
    } catch (err) {
      this.logger.error(`[${NS}] failed to load reason state:`, err);
      return;
    }
    if (typeof state["default_reason_worker"] === "string" && state["default_reason_worker"]) {
      this.defaultReasonWorker = state["default_reason_worker"] as string;
    }
    if (typeof state["fallback_reason_worker"] === "string" && state["fallback_reason_worker"]) {
      this.fallbackReasonWorker = state["fallback_reason_worker"] as string;
    }
    const perChat = state["per_chat"];
    if (perChat && typeof perChat === "object" && !Array.isArray(perChat)) {
      this.perChat.clear();
      for (const [chat, wid] of Object.entries(perChat as Record<string, unknown>)) {
        if (typeof wid === "string" && wid) this.perChat.set(chat, wid);
      }
    }
    this.logger.info(
      `[${NS}] loaded reason state: default=${this.defaultReasonWorker || "—"} fallback=${this.fallbackReasonWorker || "—"} per_chat=${this.perChat.size}`,
    );
  }

  /** Persist the current routing. Best-effort: a failed write is logged, not thrown. */
  private async persistState(): Promise<void> {
    try {
      await this.stateStore.save({
        default_reason_worker: this.defaultReasonWorker,
        fallback_reason_worker: this.fallbackReasonWorker,
        per_chat: Object.fromEntries(this.perChat),
      });
    } catch (err) {
      this.logger.error(`[${NS}] failed to persist reason state:`, err);
    }
  }

  /** Fill the {chat_id} / {sender_open_id} placeholders in the reminder template. */
  private renderReminder(msg: { chatId: string; senderId: string }): string {
    return this.systemReminder
      .replaceAll("{chat_id}", msg.chatId)
      .replaceAll("{sender_open_id}", msg.senderId);
  }

  private async handleReasonReply(evt: Event): Promise<void> {
    const ctx = evt.trace_id ? this.pending.get(evt.trace_id) : undefined;
    const text =
      typeof evt.payload?.text === "string"
        ? evt.payload.text
        : JSON.stringify(evt.payload ?? {});

    // Reactive: this is the reply to an inbound Feishu message → deliver to its chat.
    if (ctx) {
      await this.lark.send(ctx.chatId, { text });
      this.logger.info(
        `[${NS}] → feishu chat=${ctx.chatId} reply=${JSON.stringify(text)}`,
      );
      this.pending.delete(evt.trace_id as string);
      return;
    }

    // Proactive: reason initiated (no inbound Feishu context). Deliver to an
    // explicit recipient in the payload if present, else the default user.
    const explicit =
      (typeof evt.payload?.open_id === "string" && evt.payload.open_id) ||
      (typeof evt.payload?.user_open_id === "string" && evt.payload.user_open_id) ||
      (typeof evt.payload?.chat_id === "string" && evt.payload.chat_id) ||
      "";
    const to = explicit || this.defaultUserOpenId;
    if (!to) {
      this.logger.info(
        `[${NS}] received proactive worker.input with no recipient (trace=${evt.trace_id ?? "none"}); no default user open_id configured`,
      );
      return;
    }
    await this.lark.send(to, { text });
    this.logger.info(
      `[${NS}] proactive → ${
        explicit ? "payload recipient" : "default user"
      } ${to} text=${JSON.stringify(text)}`,
    );
  }

  /**
   * Serve the peer-callable lark.send extension: a tool invocation from reason
   * (via the discovery/tool bridge) carrying `target` (chat_id / open_id /
   * user_id, falling back to the default user) and `text`. Replied with a
   * request.completed / request.failed echoing the call id.
   */
  private async handleLarkSend(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    const target =
      argString(tc.args, "target") ||
      argString(tc.args, "chat_id") ||
      argString(tc.args, "open_id") ||
      argString(tc.args, "user_id") ||
      this.defaultUserOpenId;
    const text = argString(tc.args, "text");

    if (!text) {
      await this.base.replyFailed(
        tc.callerID,
        tc.callID,
        "text is required",
        tc.traceID,
      );
      return;
    }
    if (!target) {
      await this.base.replyFailed(
        tc.callerID,
        tc.callID,
        "no target given and no default user open_id configured",
        tc.traceID,
      );
      return;
    }

    try {
      await this.lark.send(target, { text });
      this.logger.info(`[${NS}] lark.send → ${target} text=${JSON.stringify(text)}`);
      await this.base.replyCompleted(tc.callerID, tc.callID, "sent", tc.traceID);
    } catch (err) {
      this.logger.error(`[${NS}] lark.send failed:`, err);
      await this.base.replyFailed(
        tc.callerID,
        tc.callID,
        (err as Error).message,
        tc.traceID,
      );
    }
  }

  /**
   * Serve the `lark.reason.set` extension: route a chat to a worker (`chat_id`),
   * set the default (neither `chat_id` nor `fallback`), or set the last-resort
   * fallback (`fallback: true`). Persists the change so it survives a restart.
   */
  private async handleReasonSet(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    const workerId =
      argString(tc.args, "worker_id") || argString(tc.args, "workerId");
    const chatId = argString(tc.args, "chat_id") || argString(tc.args, "chatId");
    const isFallback = tc.args["fallback"] === true;

    if (!workerId) {
      await this.base.replyFailed(
        tc.callerID,
        tc.callID,
        "worker_id is required",
        tc.traceID,
      );
      return;
    }
    if (chatId) {
      this.perChat.set(chatId, workerId);
      this.logger.info(`[${NS}] lark.reason.set chat=${chatId} → ${workerId}`);
    } else if (isFallback) {
      this.fallbackReasonWorker = workerId;
      this.logger.info(`[${NS}] lark.reason.set fallback → ${workerId}`);
    } else {
      this.defaultReasonWorker = workerId;
      this.logger.info(`[${NS}] lark.reason.set default → ${workerId}`);
    }
    await this.persistState();
    await this.base.replyCompleted(tc.callerID, tc.callID, "ok", tc.traceID);
  }

  /** Serve the `lark.reason.unset` extension: drop a chat override or clear the fallback. */
  private async handleReasonUnset(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    const chatId = argString(tc.args, "chat_id") || argString(tc.args, "chatId");
    const isFallback = tc.args["fallback"] === true;

    if (isFallback) {
      this.fallbackReasonWorker = "";
      await this.persistState();
      await this.base.replyCompleted(tc.callerID, tc.callID, "ok", tc.traceID);
      this.logger.info(`[${NS}] lark.reason.unset fallback cleared`);
      return;
    }
    if (!chatId) {
      await this.base.replyFailed(
        tc.callerID,
        tc.callID,
        "chat_id is required (or set fallback=true to clear the fallback)",
        tc.traceID,
      );
      return;
    }
    this.perChat.delete(chatId);
    await this.persistState();
    await this.base.replyCompleted(tc.callerID, tc.callID, "ok", tc.traceID);
    this.logger.info(`[${NS}] lark.reason.unset chat=${chatId} → default ${this.defaultReasonWorker}`);
  }

  /** Serve the `lark.reason.get` extension: return the current routing as JSON. */
  private async handleReasonGet(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    const result = JSON.stringify({
      default_reason_worker: this.defaultReasonWorker,
      fallback_reason_worker: this.fallbackReasonWorker,
      per_chat: Object.fromEntries(this.perChat),
    });
    await this.base.replyCompleted(tc.callerID, tc.callID, result, tc.traceID);
    this.logger.info(
      `[${NS}] lark.reason.get default=${this.defaultReasonWorker || "—"} fallback=${this.fallbackReasonWorker || "—"} per_chat=${this.perChat.size}`,
    );
  }
}