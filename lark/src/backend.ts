/**
 * The Lark backend — the capability half of the worker.
 *
 * An *interface worker* (`InterfaceWorker` from `@niq.run/worker-sdk`) faces the
 * bus; a *backend* implements its capability. Here the capability is "reach
 * Feishu", so this file holds everything that is about Feishu rather than about
 * niq: the long connection, the chat → reason routing, the append-to-one-message
 * behaviour, and the approval-gated local-file allowlist.
 *
 * It gets the bus handles through `setHandler` and publishes/receives through
 * them; it never touches the channel directly. That is the same split as Go's
 * `core/impl/workers/niq` (an `iface.Worker` plus a `niq.Backend`).
 */
import {
  createEvent,
  EventType,
  type Event,
  type IfaceHandler,
  type IfaceToolHost,
} from "@niq.run/worker-sdk";
import { Type } from "@sinclair/typebox";
import {
  APPROVAL_DECISION,
  APPROVAL_REQUEST,
  DEFAULT_APPROVER,
  DEFAULT_LOGGER,
  DEFAULT_SYSTEM_REMINDER,
  FileLarkStateStore,
  LARK_DIRS_ADD,
  LARK_DIRS_GET,
  LARK_README,
  LARK_REASON_GET,
  LARK_REASON_SET,
  LARK_SEND_EVENT,
  argStr,
  buildSendInput,
  dedupeDirs,
  defaultStateFile,
  isDirectory,
  normalizeDirPath,
  type ChannelOutbound,
  type LarkChannel,
  type LarkConfig,
  type LarkStateStore,
  type Logger,
} from "./feishu.js";
import { createLarkChannel } from "@larksuite/channel";
import type { NormalizedMessage } from "@larksuite/channel";


/**
 * Constructor options for the backend: the Feishu side plus the seeds for its
 * own state. The bus is NOT here — it arrives through {@link setHandler}.
 */
export interface LarkBackendOptions extends LarkConfig {
  /** Default reason worker Feishu messages are forwarded to (config seed). */
  reasonWorkerID?: string;
  /** Initial chat_id → reason worker routing (config seed). */
  reasonWorkerMappings?: Record<string, string>;
  /** Persistence backend for the routing/allowlist state. */
  stateStore?: LarkStateStore;
  /** Path for the default file state store (ignored when `stateStore` is given). */
  stateFile?: string;
  /** Replacement for the `<system-reminder>` prepended to forwarded text. */
  systemReminder?: string;
  /** Echo Feishu messages back instead of forwarding (connectivity check). */
  echo?: boolean;
  /** Default Feishu user a `lark.send` falls back to when no target is given. */
  defaultUserOpenId?: string;
  /** Merge repeated `lark.send` texts to one target into one message (default true). */
  appendOutbound?: boolean;
  /** Where to send diagnostics. Defaults to console. */
  logger?: Logger;
}

/** A `lark.dirs.add` call parked behind the approver's decision. */
interface PendingDirApproval {
  path: string;
  /** The caller whose request stays open until the verdict arrives. */
  callerID: string;
  callID: string;
  traceID: string;
}

const NS = "lark";

/**
 * The Feishu ⇄ reason bridge, as a backend.
 *
 * It does three things:
 *
 *   - Feishu message → `worker.input` to the chat's bound reason worker;
 *   - `lark.send` (a tool it serves) → a Feishu message;
 *   - `lark.reason.*` / `lark.dirs.*` (tools it serves) → its own routing and
 *     allowlist, persisted in a state file.
 *
 * A reason worker never replies "to lark": everything outbound is a `lark.send`
 * call. Inbound `approval.decision` events are ordinary interest, registered on
 * the handler in {@link setHandler}.
 */
export class LarkBackend {
  private readonly lark: LarkChannel;
  private readonly systemReminder: string;
  private readonly echo: boolean;
  private readonly defaultUserOpenId: string;
  private readonly appendMode: boolean;
  private readonly stateStore: LarkStateStore;
  private readonly logger: Logger;
  private readonly approver: string;

  /** The handles into niq; injected by the interface worker before it starts. */
  private h?: IfaceHandler;
  /** The worker that serves this backend's tools; set by {@link registerTools}. */
  private host?: IfaceToolHost;
  /** Resolves once the bus is connected AND persisted state is loaded. */
  private ready!: Promise<void>;
  private markReady!: () => void;

  /** Default reason worker; overridden per-chat by {@link perChat}. Mutable at runtime. */
  private defaultReasonWorker: string;
  /** chat_id → reason worker id. */
  private readonly perChat = new Map<string, string>();

  /**
   * target → the last outbound message this worker is extending (append mode);
   * messageId is what gets edited, text is the accumulated content.
   */
  private readonly appendTargets = new Map<string, { messageId: string; text: string }>();

  /**
   * The outbound config handed to the channel. Held (and mutated) by reference
   * because the SDK's media uploader reads `allowedFileDirs` from this exact
   * object on every send — a runtime addition then applies to the live channel.
   */
  private readonly outboundConfig: ChannelOutbound;
  /** Directories local file media sends may read from (empty ⇒ SDK rejects them). */
  private allowedFileDirs: string[];

  /** approval request id → the parked `lark.dirs.add` awaiting a verdict. */
  private readonly pendingDirApprovals = new Map<string, PendingDirApproval>();
  private readonly work = new Set<Promise<void>>();

  constructor(opts: LarkBackendOptions) {
    const create = opts.createChannel ?? createLarkChannel;
    // Own the outbound config and pass this instance to the channel: mutating
    // `allowedFileDirs` later is how a runtime `lark.dirs.add` reaches the
    // already-connected channel's media uploader.
    const outboundConfig: ChannelOutbound = { ...opts.channel?.outbound };
    const seededDirs = dedupeDirs(
      (outboundConfig.allowedFileDirs ?? []).map(normalizeDirPath),
    );
    outboundConfig.allowedFileDirs = seededDirs;
    this.outboundConfig = outboundConfig;
    this.allowedFileDirs = seededDirs;
    this.approver = opts.approver ?? DEFAULT_APPROVER;
    this.lark = create({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain,
      ...opts.channel,
      outbound: outboundConfig,
    });
    // Config seeds the routing state; a persisted state file overrides it on load.
    this.defaultReasonWorker = opts.reasonWorkerID ?? "";
    for (const [chat, wid] of Object.entries(opts.reasonWorkerMappings ?? {})) {
      if (wid) this.perChat.set(chat, wid);
    }
    this.stateStore = opts.stateStore ?? new FileLarkStateStore(opts.stateFile ?? defaultStateFile());
    this.systemReminder = opts.systemReminder ?? DEFAULT_SYSTEM_REMINDER;
    this.echo = opts.echo ?? false;
    this.defaultUserOpenId = opts.defaultUserOpenId ?? "";
    this.appendMode = opts.appendOutbound ?? true;
    this.logger = opts.logger ?? DEFAULT_LOGGER;

    let markReady!: () => void;
    this.ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    this.markReady = markReady;

    // The message handler is registered once, in the constructor, so a Feishu
    // message can never be missed due to start() ordering. handleFeishuMessage
    // awaits this.ready before touching the bus, which preserves the original
    // guarantee: we never publish to the bus before it is connected (the WS can
    // be live before the bus SSE is ready).
    this.lark.on("message", (msg) => this.handleFeishuMessage(msg));
    this.lark.on("error", (err) => this.logger.error(`[${NS}] feishu error:`, err));
    this.lark.on("reject", (evt) =>
      this.logger.warn(`[${NS}] feishu message REJECTED by policy: ${JSON.stringify(evt)}`),
    );
    // Lowest-level probe: logs any im.message.receive_v1 the WS actually delivers,
    // before normalization / policy. If this fires but the normalized 'message'
    // event does not, the drop is in the channel's normalization or policy layer,
    // not in Feishu delivery.
    this.lark.onRawEvent("im.message.receive_v1", () =>
      this.logger.info(`[${NS}] raw im.message.receive_v1 received on WS`),
    );
    this.lark.on("reconnecting", () => this.logger.warn(`[${NS}] feishu websocket reconnecting`));
    this.lark.on("reconnected", () => this.logger.info(`[${NS}] feishu websocket reconnected`));
  }

  // ── Backend: injection ──

  /**
   * Receive the bus handles. Called once, before the worker's loop starts.
   *
   * Only two inbound kinds matter here: a decision on a parked allowlist
   * addition, and the bus telling us an approval request could not be delivered.
   * Both are ordinary events addressed to this worker, so they are interest
   * registrations, not tools.
   */
  setHandler(h: IfaceHandler): void {
    this.h = h;
    h.onEvent((evt) => this.handleApprovalReply(evt), [
      APPROVAL_DECISION,
      EventType.RequestFailed,
      EventType.RequestRejected,
    ]);
  }

  /** The handles, or an error when the backend is used before injection. */
  private bus(): IfaceHandler {
    if (!this.h) throw new Error(`[${NS}] backend used before setHandler`);
    return this.h;
  }

  // ── Runnable: lifetime ──

  /** Connect the Feishu long connection, then load persisted state. */
  async start(): Promise<void> {
    await this.lark.connect();
    await this.loadState();
    this.markReady();
    const h = this.h;
    this.logger.info(
      `[${NS}] connected: bus worker_id=${h?.id ?? "—"} default_reason=${this.defaultReasonWorker || "—"} per_chat=${this.perChat.size} feishu app=${this.lark.constructor.name} local_file_dirs=${this.allowedFileDirs.length ? this.allowedFileDirs.join(",") : "— (local file sends will be rejected)"} approver=${this.approver || "— (allowlist gating disabled)"}`,
    );
  }

  /** Disconnect Feishu and wait for in-flight work. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.work]);
    await this.lark.disconnect().catch(() => {});
  }

  // ── Tools ──

  /**
   * Register this backend's tools on the worker that serves them. The assembly
   * calls this because it is the only place that knows both halves (mirrors Go's
   * `niq.Backend.RegisterTools`).
   */
  registerTools(host: IfaceToolHost): void {
    this.host = host;
    // Guide and per-event help first, so the announced contract reads
    // readme, help, then the capabilities (matching every other niq worker).
    host.registerReadme(
      "Read this worker's usage guide: the Feishu bridge, its events, local-file sending and approval gating.",
      () => this.renderReadme(),
    );
    host.registerHelp();

    // A peer-callable extension so reason can send Feishu messages with an
    // explicit target (chat_id / open_id / user_id).
    host.register(
      {
        event: LARK_SEND_EVENT,
        description:
          "Send a message to a Feishu user or chat. Provide target (chat_id, open_id, or user_id) and either text or a media source (http(s) URL or local file path): image, file (+file_name), video, or audio. Without a media source it sends text (append-merged across repeated sends).",
        parameters: Type.Object({
          target: Type.Optional(
            Type.String({ description: "Feishu chat_id, open_id, or user_id of the recipient" }),
          ),
          text: Type.Optional(
            Type.String({ description: "Message text (used when no media arg is present)" }),
          ),
          image: Type.Optional(
            Type.String({ description: "http(s) URL or local file path of the media to send" }),
          ),
          file: Type.Optional(
            Type.String({ description: "http(s) URL or local file path to send as a file attachment" }),
          ),
          file_name: Type.Optional(
            Type.String({ description: "Display file name (defaults to the URL basename)" }),
          ),
          video: Type.Optional(
            Type.String({ description: "http(s) URL or local file path of the media to send" }),
          ),
          audio: Type.Optional(
            Type.String({ description: "http(s) URL or local file path of the media to send" }),
          ),
        }),
        response: Type.String({ description: '"sent" once the message was accepted by Feishu' }),
      },
      (evt) => this.handleLarkSend(evt, host),
    );

    // The lark.reason.* group: manage the chat → reason worker routing at
    // runtime. Every mutation is persisted so the routing survives restarts.
    host.register(
      {
        event: LARK_REASON_SET,
        description:
          "Route a Feishu chat to a reason worker, or set the default. " +
          "Provide worker_id. Include chat_id to route only that chat; otherwise the default reason worker is set.",
        parameters: Type.Object({
          chat_id: Type.Optional(
            Type.String({ description: "Feishu chat_id to route (omit to set the default)" }),
          ),
          worker_id: Type.String({ description: "Reason worker id to route matching messages to" }),
        }),
        response: Type.String({ description: '"ok" once the routing change is persisted' }),
      },
      (evt) => this.handleReasonSet(evt, host),
    );
    host.register(
      {
        event: LARK_REASON_GET,
        description:
          "Return the current chat → reason worker routing (default + per-chat overrides).",
        parameters: Type.Object({}),
        response: Type.Object({
          default_reason_worker: Type.String(),
          per_chat: Type.Record(Type.String(), Type.String(), {
            description: "chat_id → reason worker id overrides",
          }),
        }),
      },
      (evt) => this.handleReasonGet(evt, host),
    );

    // The lark.dirs.* group: extend the local-file allowlist at runtime. An add
    // from anyone other than the approver is parked behind an approval.request;
    // an approved add is persisted and applies to the live channel at once.
    host.register(
      {
        event: LARK_DIRS_ADD,
        description:
          "Allow local file media sends from an additional directory (absolute path; ~ expands). " +
          `Requests from the approver (${this.approver || "none — gating disabled"}) apply immediately; ` +
          "any other caller waits for the approver's approval.decision, then receives the updated allowlist.",
        parameters: Type.Object({
          path: Type.String({ description: "Directory to allow (absolute, or ~-prefixed)" }),
        }),
        response: Type.Object({
          dirs: Type.Array(Type.String(), { description: "The resulting local-file allowlist" }),
          added: Type.String({ description: "The directory just added" }),
        }),
      },
      (evt) => this.handleDirsAdd(evt, host),
    );
    host.register(
      {
        event: LARK_DIRS_GET,
        description: "Return the local-file allowlist and the configured approver.",
        parameters: Type.Object({}),
        response: Type.Object({
          dirs: Type.Array(Type.String(), { description: "Current local-file allowlist" }),
          approver: Type.String({
            description: "Worker that approves additions (empty = gating disabled)",
          }),
        }),
      },
      (evt) => this.handleDirsGet(evt, host),
    );
  }

  // ── Inbound: Feishu ──

  private track<T>(p: Promise<T>): void {
    const wrapped = p.then(
      () => {},
      (err) => this.logger.error(`[${NS}] feishu handler failed:`, err),
    );
    this.work.add(wrapped);
    void wrapped.finally(() => this.work.delete(wrapped));
  }

  private async handleFeishuMessage(msg: NormalizedMessage): Promise<void> {
    // Wait until the bus is connected and state is loaded before doing anything,
    // so we never publish early and the first message already uses the saved
    // routing. The handler is registered in the constructor, so a message
    // arriving during start() simply waits here.
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

    // A new user message begins a fresh reply: forget any in-progress outbound
    // append so the next lark.send posts a new message instead of extending the
    // previous turn's.
    this.appendTargets.delete(msg.chatId);

    const reasonWorker = this.reasonWorkerFor(msg.chatId);
    if (!reasonWorker) {
      this.logger.warn(
        `[${NS}] drop feishu message chat=${msg.chatId} msg=${msg.messageId}: no reason worker (no per-chat mapping and no default)`,
      );
      return;
    }
    const input = createEvent("worker.input", {
      text: this.renderReminder(msg) + "\n" + msg.content,
      chat_id: msg.chatId,
      sender_open_id: msg.senderId,
      input_mode: "append",
    });
    try {
      await this.bus().send(input, reasonWorker);
      this.logger.info(`[${NS}] sent worker.input → reason ${reasonWorker} (chat ${msg.chatId})`);
    } catch (err) {
      this.logger.error(`[${NS}] forward to ${reasonWorker} failed:`, err);
    }
  }

  /**
   * Resolve the reason worker a chat's messages are forwarded to: its per-chat
   * mapping, else the default. Returns "" when neither is configured.
   */
  private reasonWorkerFor(chatId: string): string {
    return this.perChat.get(chatId) || this.defaultReasonWorker;
  }

  /** Fill the {chat_id} / {sender_open_id} placeholders in the reminder template. */
  private renderReminder(msg: { chatId: string; senderId: string }): string {
    return this.systemReminder
      .replaceAll("{chat_id}", msg.chatId)
      .replaceAll("{sender_open_id}", msg.senderId);
  }

  // ── State ──

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
    const perChat = state["per_chat"];
    if (perChat && typeof perChat === "object" && !Array.isArray(perChat)) {
      this.perChat.clear();
      for (const [chat, wid] of Object.entries(perChat as Record<string, unknown>)) {
        if (typeof wid === "string" && wid) this.perChat.set(chat, wid);
      }
    }
    // Persisted allowlist additions extend the env seed (the seed is the
    // deploy-time baseline; runtime additions must survive a restart).
    const persistedDirs = Array.isArray(state["allowed_file_dirs"])
      ? (state["allowed_file_dirs"] as unknown[]).filter(
          (d): d is string => typeof d === "string" && d.trim() !== "",
        )
      : [];
    if (persistedDirs.length > 0) {
      this.setAllowedFileDirs([...this.allowedFileDirs, ...persistedDirs]);
    }
    this.logger.info(
      `[${NS}] loaded reason state: default=${this.defaultReasonWorker || "—"} per_chat=${this.perChat.size} local_file_dirs=${this.allowedFileDirs.length ? this.allowedFileDirs.join(",") : "—"}`,
    );
  }

  /** Persist the current routing and allowlist. Best-effort: a failed write is logged, not thrown. */
  private async persistState(): Promise<void> {
    try {
      await this.stateStore.save({
        default_reason_worker: this.defaultReasonWorker,
        per_chat: Object.fromEntries(this.perChat),
        allowed_file_dirs: [...this.allowedFileDirs],
      });
    } catch (err) {
      this.logger.error(`[${NS}] failed to persist reason state:`, err);
    }
  }

  /**
   * Replace the local-file allowlist. `outboundConfig` is the object handed to
   * the channel, so assigning the new array here is what makes the change
   * visible to the media uploader on the next send; the entries are persisted
   * by the caller.
   */
  private setAllowedFileDirs(dirs: readonly string[]): void {
    this.allowedFileDirs = dedupeDirs(dirs.map(normalizeDirPath));
    this.outboundConfig.allowedFileDirs = this.allowedFileDirs;
  }

  // ── Tools: lark.send ──

  /**
   * Serve `lark.send`: a tool call from reason (via the discovery/tool bridge)
   * carrying `target` (chat_id / open_id / user_id, falling back to the default
   * user) and either text or a media source.
   */
  private async handleLarkSend(evt: Event, host: IfaceToolHost): Promise<void> {
    const tc = toolCall(evt);
    const target =
      argStr(tc.args, "target") ||
      argStr(tc.args, "chat_id") ||
      argStr(tc.args, "open_id") ||
      argStr(tc.args, "user_id") ||
      this.defaultUserOpenId;

    if (!target) {
      await host.replyFailed(
        tc.callerID,
        tc.callID,
        "no target given and no default user open_id configured",
        tc.traceID,
      );
      return;
    }

    const media = buildSendInput(tc.args);
    if (media) {
      // A media send always posts a fresh message and clears any pending text
      // append for this target (Feishu can't edit arbitrary media messages).
      this.appendTargets.delete(target);
      try {
        await this.lark.send(target, media);
        this.logger.info(
          `[${NS}] lark.send → ${target} media src=` +
            JSON.stringify(
              argStr(tc.args, "image") ||
                argStr(tc.args, "file") ||
                argStr(tc.args, "video") ||
                argStr(tc.args, "audio"),
            ),
        );
        await host.replyCompleted(tc.callerID, tc.callID, "sent", tc.traceID);
      } catch (err) {
        this.logger.error(`[${NS}] lark.send media failed:`, err);
        await host.replyFailed(tc.callerID, tc.callID, (err as Error).message, tc.traceID);
      }
      return;
    }

    const text = argStr(tc.args, "text");
    if (!text) {
      await host.replyFailed(
        tc.callerID,
        tc.callID,
        "text is required (or provide image/file/video/audio)",
        tc.traceID,
      );
      return;
    }

    try {
      if (this.appendMode) {
        await this.sendAppended(target, text);
      } else {
        await this.lark.send(target, { text });
        this.logger.info(`[${NS}] lark.send → ${target} text=${JSON.stringify(text)}`);
      }
      await host.replyCompleted(tc.callerID, tc.callID, "sent", tc.traceID);
    } catch (err) {
      // Failed mid-append: drop the half-updated entry so the next send starts
      // a fresh message rather than corrupting the accumulated text.
      this.appendTargets.delete(target);
      this.logger.error(`[${NS}] lark.send failed:`, err);
      await host.replyFailed(tc.callerID, tc.callID, (err as Error).message, tc.traceID);
    }
  }

  /**
   * Append-mode send: if this target already has an in-progress message from
   * this turn, extend it in place; otherwise post a fresh message and remember
   * it. Repeated `lark.send` calls to the same target therefore assemble into
   * one message instead of flooding the Feishu chat.
   */
  private async sendAppended(target: string, text: string): Promise<void> {
    const pending = this.appendTargets.get(target);
    if (!pending) {
      const res = await this.lark.send(target, { text });
      this.appendTargets.set(target, { messageId: res.messageId, text });
      this.logger.info(`[${NS}] lark.send → ${target} text=${JSON.stringify(text)}`);
      return;
    }
    // Join segments with a single newline so separate sends read as distinct
    // parts, not run-on text.
    const merged = pending.text.replace(/\s+$/, "") + "\n" + text.replace(/\s+$/, "");
    await this.lark.editMessage(pending.messageId, merged);
    pending.text = merged;
    this.logger.info(`[${NS}] lark.append → ${target} (extended ${pending.messageId})`);
  }

  // ── Tools: routing ──

  /**
   * Serve `lark.reason.set`: route a chat to a worker (`chat_id`) or set the
   * default. Persists the change so it survives a restart.
   */
  private async handleReasonSet(evt: Event, host: IfaceToolHost): Promise<void> {
    const tc = toolCall(evt);
    const workerId = argStr(tc.args, "worker_id") || argStr(tc.args, "workerId");
    const chatId = argStr(tc.args, "chat_id") || argStr(tc.args, "chatId");

    if (!workerId) {
      await host.replyFailed(tc.callerID, tc.callID, "worker_id is required", tc.traceID);
      return;
    }
    if (chatId) {
      this.perChat.set(chatId, workerId);
      this.logger.info(`[${NS}] lark.reason.set chat=${chatId} → ${workerId}`);
    } else {
      this.defaultReasonWorker = workerId;
      this.logger.info(`[${NS}] lark.reason.set default → ${workerId}`);
    }
    await this.persistState();
    await host.replyCompleted(tc.callerID, tc.callID, "ok", tc.traceID);
  }

  /** Serve `lark.reason.get`: return the current routing as a structured reply. */
  private async handleReasonGet(evt: Event, host: IfaceToolHost): Promise<void> {
    const tc = toolCall(evt);
    // Structured reply: the object IS the payload, so a caller (or a PTC script)
    // reads the fields instead of parsing a JSON string.
    await host.replyCompleted(
      tc.callerID,
      tc.callID,
      {
        default_reason_worker: this.defaultReasonWorker,
        per_chat: Object.fromEntries(this.perChat),
      },
      tc.traceID,
    );
    this.logger.info(
      `[${NS}] lark.reason.get default=${this.defaultReasonWorker || "—"} per_chat=${this.perChat.size}`,
    );
  }

  // ── Tools: allowlist ──

  /**
   * Serve `lark.dirs.add`: extend the local-file allowlist. The approver's own
   * request is the consent and applies directly; any other caller is parked
   * behind an `approval.request` and answered when the verdict arrives.
   */
  private async handleDirsAdd(evt: Event, host: IfaceToolHost): Promise<void> {
    const tc = toolCall(evt);
    const rawPath = argStr(tc.args, "path") || argStr(tc.args, "dir");
    if (!rawPath.trim()) {
      await host.replyFailed(tc.callerID, tc.callID, "path is required", tc.traceID);
      return;
    }
    const path = normalizeDirPath(rawPath);

    if (this.approver && tc.callerID !== this.approver) {
      await this.requestDirApproval(tc, path, host);
      return;
    }
    await this.applyDirAdd(tc, path, host);
  }

  /** Serve `lark.dirs.get`: the current allowlist plus the configured approver. */
  private async handleDirsGet(evt: Event, host: IfaceToolHost): Promise<void> {
    const tc = toolCall(evt);
    await host.replyCompleted(
      tc.callerID,
      tc.callID,
      { dirs: [...this.allowedFileDirs], approver: this.approver },
      tc.traceID,
    );
    this.logger.info(
      `[${NS}] lark.dirs.get dirs=${this.allowedFileDirs.join(",") || "—"} approver=${this.approver || "—"}`,
    );
  }

  /** Add one directory to the allowlist, persist it, and answer the caller. */
  private async applyDirAdd(
    tc: { callID: string; callerID: string; traceID: string },
    path: string,
    host: IfaceToolHost,
  ): Promise<void> {
    this.setAllowedFileDirs([...this.allowedFileDirs, path]);
    await this.persistState();
    this.logger.info(
      `[${NS}] lark.dirs.add → ${path} (dirs=${this.allowedFileDirs.join(",") || "—"})`,
    );
    await host.replyCompleted(
      tc.callerID,
      tc.callID,
      { dirs: [...this.allowedFileDirs], added: path },
      tc.traceID,
    );
  }

  /**
   * Park a non-approver `lark.dirs.add` behind the approver's decision. The
   * request is not answered here — the caller stays open until
   * {@link handleApprovalReply} applies or rejects it.
   *
   * The parked entry also carries the tool host, so the reply goes through the
   * same worker that dispatched the call.
   */
  private async requestDirApproval(
    tc: { callID: string; callerID: string; traceID: string; args: Record<string, unknown> },
    path: string,
    host: IfaceToolHost,
  ): Promise<void> {
    const exists = await isDirectory(path);

    const approval = createEvent(APPROVAL_REQUEST, {
      origin: tc.callerID,
      requested_by: this.bus().id,
      action: LARK_DIRS_ADD,
      path,
      exists,
      dirs: [...this.allowedFileDirs],
    });
    approval.request_id = approval.id;
    if (tc.traceID) approval.trace_id = tc.traceID;

    // Park BEFORE sending: a decision can arrive while the send is in flight,
    // and it would be dropped as unknown without the pending entry.
    this.pendingDirApprovals.set(approval.id, {
      path,
      callerID: tc.callerID,
      callID: tc.callID,
      traceID: tc.traceID,
    });

    try {
      await this.bus().send(approval, this.approver);
    } catch (err) {
      this.pendingDirApprovals.delete(approval.id);
      this.logger.error(
        `[${NS}] lark.dirs.add approval request to ${this.approver} failed:`,
        err,
      );
      await host.replyFailed(
        tc.callerID,
        tc.callID,
        `approval request failed: ${(err as Error).message}`,
        tc.traceID,
      );
      return;
    }
    this.logger.info(
      `[${NS}] lark.dirs.add approval requested from ${this.approver}: ${path} (requested by ${tc.callerID}, parked ${approval.id})`,
    );
  }

  /**
   * Resolve a parked allowlist addition from the approver's verdict — or from
   * the bus reporting that the approval request could not be delivered.
   *
   * Registered as inbound interest, so the worker's dispatch does not treat the
   * decision as an unserved tool and answer it with request.failed.
   */
  private handleApprovalReply(evt: Event): void {
    const isDecision = evt.type === APPROVAL_DECISION;
    const isUndelivered =
      evt.type === EventType.RequestFailed || evt.type === EventType.RequestRejected;
    if (!isDecision && !isUndelivered) return;

    const id = evt.request_id ?? "";
    if (!id) return;
    const pending = this.pendingDirApprovals.get(id);
    if (!pending) return;

    if (isUndelivered) {
      this.pendingDirApprovals.delete(id);
      const reason =
        (typeof evt.payload["error"] === "string" && evt.payload["error"]) ||
        (typeof evt.payload["reason"] === "string" && evt.payload["reason"]) ||
        "not delivered";
      this.logger.warn(
        `[${NS}] approval request ${id} could not reach ${this.approver}: ${reason}`,
      );
      this.track(
        this.host!.replyFailed(
          pending.callerID,
          pending.callID,
          `approval request failed: ${reason}`,
          pending.traceID,
        ),
      );
      return;
    }

    if (this.approver && evt.worker_id !== this.approver) {
      // Only the configured approver may decide; keep the request parked and
      // ignore the event, in case the real approver answers later.
      this.logger.warn(
        `[${NS}] ignoring ${APPROVAL_DECISION} for ${id} from ${evt.worker_id} (expected ${this.approver})`,
      );
      return;
    }

    this.pendingDirApprovals.delete(id);
    const approved = evt.payload["approved"] === true;
    const note = typeof evt.payload["note"] === "string" ? evt.payload["note"] : "";
    if (!approved) {
      const msg = note ? `approval denied: ${note}` : "approval denied";
      this.logger.info(`[${NS}] lark.dirs.add denied: ${pending.path} (${msg})`);
      this.track(this.host!.replyFailed(pending.callerID, pending.callID, msg, pending.traceID));
      return;
    }

    this.logger.info(`[${NS}] lark.dirs.add approved: ${pending.path}`);
    this.track(
      this.applyDirAdd(
        { callID: pending.callID, callerID: pending.callerID, traceID: pending.traceID },
        pending.path,
        this.host!,
      ),
    );
  }

  // ── Readme ──

  /**
   * The guide `worker.readme` returns (the SDK's registerReadme calls this per
   * request): the static guide plus live state — routing, allowlist, approver.
   */
  private renderReadme(): string {
    const dirs = this.allowedFileDirs.length
      ? this.allowedFileDirs.join(", ")
      : "(none — local file sends are rejected)";
    return (
      `${LARK_README}\n\n## Current\n\n` +
      `- default reason worker: ${this.defaultReasonWorker || "—"}\n` +
      `- per-chat overrides: ${this.perChat.size}\n` +
      `- local-file dirs: ${dirs}\n` +
      `- approver: ${this.approver || "— (gating disabled)"}\n`
    );
  }
}

/** The parsed tool call fields a handler needs. */
function toolCall(evt: Event): {
  callID: string;
  callName: string;
  callerID: string;
  args: Record<string, unknown>;
  traceID: string;
} {
  return {
    callID: evt.request_id ?? "",
    callName: evt.type,
    callerID: evt.worker_id,
    args: evt.payload ?? {},
    traceID: evt.trace_id ?? "",
  };
}
