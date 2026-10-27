/**
 * Lark worker — a WebSocket bridge between the niq event bus and Feishu/Lark,
 * built on `@larksuite/channel` (which wraps the official
 * `@larksuiteoapi/node-sdk`).
 *
 * Flow:
 *   Feishu message ──worker.input──▶ bound reason worker
 *   reason reply   ──lark.send────▶ this worker      ──send──▶ Feishu chat
 *
 * Inbound: every Feishu message is forwarded to a single bound reason worker
 * as a `worker.input` event with `input_mode: "append"`, payload
 * `{ text, chat_id, sender_open_id }`. The text is prefixed with a
 * `<system-reminder>` telling reason this came from Feishu and to reply with
 * the `lark.send` extension targeting the `chat_id`.
 *
 * Outbound: the reason worker replies by calling the `lark.send` extension
 * (exposed by this worker) with `target` (a chat_id / open_id / user_id) and
 * `text`. This worker sends that text to the target Feishu chat. The worker
 * does NOT consume `worker.input` events as replies — `lark.send` is the only
 * inbound path for reason → Feishu output.
 *
 * Credentials come from the environment: `LARK_APP_ID` / `LARK_APP_SECRET`
 * (+ `LARK_DOMAIN`), and the bus via `NIQ_BUS_URL` / `NIQ_WORKER_ID` /
 * `NIQ_WORKER_CREDENTIAL` — the niq project supervisor injects these as launch
 * args (project.json env). The default reason worker id comes from
 * `NIQ_REASON_WORKER`; an initial per-chat override map can come from
 * `LARK_REASON_WORKER_MAPPINGS` (a JSON object of {chat_id: worker_id}).
 * Local-file media sends are default-deny in `@larksuite/channel`; opt in with
 * `LARK_ALLOWED_FILE_DIRS` (comma-separated directories) — see
 * {@link larkConfigFromEnv}. The allowlist can also be widened at runtime with
 * `lark.dirs.add`, which is approval-gated on the configured approver worker
 * (default `webui-hiw`) and persisted alongside the routing state.
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
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createLarkChannel } from "@larksuite/channel";
import { Type } from "@sinclair/typebox";
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
  EventType,
  parseToolCall,
  type Event,
  type ToolCall,
  type WorkerSideChannel,
} from "@niq.run/worker-sdk";

// ── schema fragments ──
//
// Declared once and reused: the media arguments mean the same thing everywhere,
// and a tool that returns a media id reports the same shape. TypeBox schemas are
// plain JSON Schema, so they ride worker.ready unchanged.

const LarkSendTarget = Type.String({
  description: "Feishu chat_id, open_id, or user_id of the recipient",
});
const LarkMediaSource = Type.String({
  description: "http(s) URL or local file path of the media to send",
});
const LarkFileSource = Type.String({
  description: "http(s) URL or local file path to send as a file attachment",
});

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
  send(to: string, input: SendInput): Promise<{ messageId: string }>;
  /** Rewrite an already-sent text message's content in place (Feishu message edit). */
  editMessage(messageId: string, text: string): Promise<void>;
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
  /**
   * Extra options forwarded to the channel (see {@link LarkChannelOptions}).
   * Local file media sends need `outbound.allowedFileDirs` here; the env
   * shortcut is `LARK_ALLOWED_FILE_DIRS`.
   */
  channel?: Omit<LarkChannelOptions, "appId" | "appSecret" | "domain">;
  /**
   * Worker that must approve runtime additions to the local-file allowlist
   * (`lark.dirs.add`). A request from this worker applies directly; any other
   * caller is parked behind an `approval.request` until its `approval.decision`
   * arrives. Defaults to `webui-hiw` (mirroring the workspace worker); an empty
   * string disables gating. Declared here — rather than on the bridge options —
   * so {@link larkConfigFromEnv} can read `LARK_APPROVER` for programmatic use too.
   */
  approver?: string;
  /** Injectable factory — defaults to {@link createLarkChannel}. */
  createChannel?: (opts: LarkChannelOptions) => LarkChannel;
}

/**
 * Parse a comma-separated list of directories (e.g. `LARK_ALLOWED_FILE_DIRS`).
 * Entries are trimmed and blanks dropped; an absent/empty value yields
 * `undefined` so callers can distinguish "not configured" from an empty list.
 */
export function parseDirList(raw: string | undefined): string[] | undefined {
  const dirs = (raw ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  return dirs.length > 0 ? dirs : undefined;
}

/**
 * Normalize a directory for the local-file allowlist: expand a leading `~` and
 * make it absolute (relative entries resolve against the worker's cwd, which is
 * also what `@larksuite/channel` does when it checks containment).
 */
export function normalizeDirPath(raw: string): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/")
      ? homedir() + trimmed.slice(1)
      : trimmed;
  return resolve(expanded);
}

/** Order-preserving deduplication. */
function dedupeDirs(dirs: readonly string[]): string[] {
  return [...new Set(dirs)];
}

/** Build a {@link LarkConfig} from env. Throws naming any missing vars. */
export function larkConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): LarkConfig {
  const appId = env.LARK_APP_ID?.trim() ?? "";
  const appSecret = env.LARK_APP_SECRET?.trim() ?? "";
  const domain = env.LARK_DOMAIN?.trim() || "https://open.feishu.cn";
  const approver = env.LARK_APPROVER?.trim() || DEFAULT_APPROVER;
  const allowedFileDirs = parseDirList(env.LARK_ALLOWED_FILE_DIRS)?.map(
    normalizeDirPath,
  );

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
  // `@larksuite/channel` rejects local file media sources unless
  // `outbound.allowedFileDirs` is configured (default-deny). Only add the
  // channel block when the allowlist is actually set.
  return {
    appId,
    appSecret,
    domain,
    approver,
    ...(allowedFileDirs
      ? { channel: { outbound: { allowedFileDirs } } }
      : {}),
  };
}

const DEFAULT_SYSTEM_REMINDER = `<system-reminder>
This message was sent by a user over Feishu (Lark).
Chat id: {chat_id}
Sender open_id: {sender_open_id}
Reply to the user by calling the lark.send tool with target = "{chat_id}" and
text = your reply. The reply is delivered straight back into the user's Feishu
chat. Several lark.send calls to the same target within one reply are appended
into a single message, so just send your answer — do not number or header each
piece. Keep your answer in the language the user wrote in, and do not preface it
with any system notes.
</system-reminder>`;

/** The agent-facing guide `worker.readme` returns (live state is appended at reply time). */
const LARK_README = `# lark — Feishu / Lark bridge

Bridges the niq event bus to Feishu. Every Feishu message is forwarded to the
chat's bound reason worker as worker.input { text, chat_id, sender_open_id,
input_mode: "append" }, prefixed with a <system-reminder> naming the chat id and
asking reason to answer with lark.send.

## Tools

- lark.send { target?, text? | image | file + file_name | video | audio } — send
  text or media to a Feishu chat/user. target is a chat_id, open_id or user_id;
  without one it falls back to the configured default user. Repeated text sends
  to one target within a turn are appended into a single message.
- lark.reason.set { worker_id, chat_id? } — route a chat to a reason worker, or
  set the default.
- lark.reason.get {} — current routing: default_reason_worker, per_chat.
- lark.dirs.add { path } — allow local file media sends from an extra directory.
  Only the approver's own request applies immediately; anyone else is parked
  behind approval.request / approval.decision.
- lark.dirs.get {} — the local-file allowlist and the configured approver.
- worker.readme {} — this guide.

## Notes

- Local file media is default-deny: a path must resolve inside an allowlisted
  directory (env LARK_ALLOWED_FILE_DIRS, or a runtime, approval-gated
  lark.dirs.add). http(s) URL media needs no allowlist.
- Approved additions persist in the state file and apply to the live channel
  without a reconnect.
- Routing and allowlist changes are persisted; there is no runtime unset.
- Media sends always post a fresh message and reset text appending for that
  target.`;

/** Configuration for the assembled bridge. */
export interface LarkBridgeOptions extends LarkConfig {
  /** Worker-side bus channel. Injected for tests; built from env otherwise. */
  bus: WorkerSideChannel;
  /**
   * The default reason worker Feishu messages are forwarded to when a chat has
   * no per-chat override (see {@link LarkBridgeOptions.reasonWorkerMappings}),
   * unless a persisted state file overrides it. Config only seeds this value.
   */
  reasonWorkerID?: string;
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
   * Default Feishu user (open_id) a `lark.send` call falls back to when the
   * reason worker does not supply an explicit `target` (e.g. a proactive push
   * with no chat context). Without a target and no default user, the call
   * fails with `request.failed`.
   */
  defaultUserOpenId?: string;
  /**
   * When a reason worker makes several `lark.send` calls to the same target
   * within one reply turn, append each piece of text onto the message it last
   * sent to that target (updating it in place via Feishu's message edit) instead
   * of posting a brand-new message per call. Each new inbound Feishu message
   * starts a fresh target message. Defaults to `true`.
   */
  appendOutbound?: boolean;
  /** Where to send diagnostics. Defaults to `console`. */
  logger?: Logger;
}

const NS = "lark";

/**
 * The extension lark exposes to peers (reason) for sending a Feishu message to
 * a user/chat. Advertised so it is discovered by reason and callable.
 */
export const LARK_SEND_EVENT = "lark.send";

/**
 * The group of extensions lark exposes for managing the chat → reason worker
 * routing at runtime. All are advertised so a control plane / admin peer can
 * discover and call them. Each mutation also persists the new routing.
 */

/** Route a Feishu chat (or set the default) to a specific reason worker. */
export const LARK_REASON_SET = "lark.reason.set";
/** Return the current routing (default + per-chat overrides). */
export const LARK_REASON_GET = "lark.reason.get";

/**
 * The runtime local-file allowlist extensions. An addition is approval-gated
 * and persisted, so a reason worker can widen the boundary without a restart.
 * There is deliberately no remove/unset: narrowing stays a deploy-time choice.
 */
export const LARK_DIRS_ADD = "lark.dirs.add";
export const LARK_DIRS_GET = "lark.dirs.get";

/** Default approver for allowlist changes: the WebUI HIW owns approvals. */
export const DEFAULT_APPROVER = "webui-hiw";

/** Core approval protocol pair (mirrors `core/event` in the Go core). */
export const APPROVAL_REQUEST = "approval.request";
export const APPROVAL_DECISION = "approval.decision";

/** The channel's outbound config, as forwarded to `@larksuite/channel`. */
type ChannelOutbound = NonNullable<LarkChannelOptions["outbound"]>;

/** A `lark.dirs.add` call parked behind the approver's decision. */
interface PendingDirApproval {
  path: string;
  /** The caller whose request stays open until the verdict arrives. */
  callerID: string;
  callID: string;
  traceID: string;
}

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
  /** chat_id → reason worker id. Updated by config seed, runtime events, and persisted state. */
  private readonly perChat = new Map<string, string>();
  private readonly stateStore: LarkStateStore;
  private readonly systemReminder: string;
  private readonly echo: boolean;
  private readonly defaultUserOpenId: string;
  private readonly appendMode: boolean;
  /** target → the last outbound message this worker is extending (append mode); text is the in-place accumulated content. */
  private readonly appendTargets = new Map<
    string,
    { messageId: string; text: string }
  >();
  /**
   * The outbound config handed to the channel. Held (and mutated) by reference
   * because the SDK's media uploader reads `allowedFileDirs` from this exact
   * object on every send — a runtime addition then applies to the live channel.
   */
  private readonly outboundConfig: ChannelOutbound;
  /** Directories local file media sends may read from (empty ⇒ SDK rejects them). */
  private allowedFileDirs: string[];
  /** Approver for allowlist changes; "" disables the approval gate. */
  private readonly approver: string;
  /** approval request id → the parked `lark.dirs.add` awaiting a verdict. */
  private readonly pendingDirApprovals = new Map<string, PendingDirApproval>();
  private readonly logger: Logger;
  /** Settled once both the bus and Feishu sides are connected (see connect()). */
  private readonly ready: Promise<void>;
  private readonly markReady: () => void;

  constructor(opts: LarkBridgeOptions) {
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
    this.bus = opts.bus;
    this.workerID = opts.bus.id;
    // Config seeds the routing state; a persisted state file overrides it on load.
    this.defaultReasonWorker = opts.reasonWorkerID ?? "";
    for (const [chat, wid] of Object.entries(opts.reasonWorkerMappings ?? {})) {
      if (wid) this.perChat.set(chat, wid);
    }
    this.stateStore =
      opts.stateStore ??
      new FileLarkStateStore(opts.stateFile ?? defaultStateFile());
    this.systemReminder = opts.systemReminder ?? DEFAULT_SYSTEM_REMINDER;
    this.echo = opts.echo ?? false;
    this.defaultUserOpenId = opts.defaultUserOpenId ?? "";
    this.appendMode = opts.appendOutbound ?? true;
    this.logger = opts.logger ?? DEFAULT_LOGGER;
    this.base = new BaseWorker({
      id: this.workerID,
      subscriptions: [
        { type: EventType.WorkerReadme },
        { type: EventType.WorkerHelp },
        { type: LARK_REASON_SET },
        { type: LARK_REASON_GET },
        { type: LARK_DIRS_ADD },
        { type: LARK_DIRS_GET },
        // A peer (or the WebUI) asking who is online. Presence is live-only and
        // not persisted, so a late subscriber learns the contract by asking.
        { type: EventType.WorkerDiscover },
      ],
      channel: this.bus,
    });

    // Self-description and per-event help from the SDK: worker.readme returns
    // this worker's guide (live, because the text runs per request) and
    // worker.help renders the declared contracts, like a CLI's -h.
    this.base.registerReadme(
      "Read this worker's usage guide: the Feishu bridge, its events, local-file sending and approval gating.",
      () => this.renderReadme(),
    );
    this.base.registerHelp();

    // Expose a peer-callable extension so reason can send Feishu messages with
    // an explicit target (chat_id / open_id / user_id). Advertised so it is
    // discovered by reason and invoked via the tool-name bridge.
    this.base.register(
      {
        event: LARK_SEND_EVENT,
        description:
          "Send a message to a Feishu user or chat. Provide target (chat_id, open_id, or user_id) and either text or a media source (http(s) URL or local file path): image, file (+file_name), video, or audio. Without a media source it sends text (append-merged across repeated sends).",
        parameters: Type.Object({
          target: Type.Optional(LarkSendTarget),
          text: Type.Optional(Type.String({ description: "Message text (used when no media arg is present)" })),
          image: Type.Optional(LarkMediaSource),
          file: Type.Optional(LarkFileSource),
          file_name: Type.Optional(Type.String({ description: "Display file name (defaults to the URL basename)" })),
          video: Type.Optional(LarkMediaSource),
          audio: Type.Optional(LarkMediaSource),
        }),
        response: Type.String({ description: '"sent" once the message was accepted by Feishu' }),
      },
      (evt) => this.handleLarkSend(evt),
    );

    // The lark.reason.* group: manage the chat → reason worker routing at
    // runtime. Every mutation is persisted so the routing survives restarts.
    this.base.register(
      {
        event: LARK_REASON_SET,
        description:
          "Route a Feishu chat to a reason worker, or set the default. " +
          "Provide worker_id. Include chat_id to route only that chat; otherwise the default reason worker is set.",
        parameters: Type.Object({
          chat_id: Type.Optional(Type.String({
            description: "Feishu chat_id to route (omit to set the default)",
          })),
          worker_id: Type.String({
            description: "Reason worker id to route matching messages to",
          }),
        }),
        response: Type.String({ description: '"ok" once the routing change is persisted' }),
      },
      (evt) => this.handleReasonSet(evt),
    );
    this.base.register(
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
      (evt) => this.handleReasonGet(evt),
    );

    // The lark.dirs.* group: extend the local-file allowlist at runtime. An add
    // from anyone other than the approver is parked behind an approval.request;
    // an approved add is persisted and applies to the live channel at once.
    this.base.register(
      {
        event: LARK_DIRS_ADD,
        description:
          "Allow local file media sends from an additional directory (absolute path; ~ expands). " +
          `Requests from the approver (${this.approver || "none — gating disabled"}) apply immediately; ` +
          "any other caller waits for the approver's approval.decision, then receives the updated allowlist.",
        parameters: Type.Object({
          path: Type.String({
            description: "Directory to allow (absolute, or ~-prefixed)",
          }),
        }),
        response: Type.Object({
          dirs: Type.Array(Type.String(), {
            description: "The resulting local-file allowlist",
          }),
          added: Type.String({ description: "The directory just added" }),
        }),
      },
      (evt) => this.handleDirsAdd(evt),
    );
    this.base.register(
      {
        event: LARK_DIRS_GET,
        description: "Return the local-file allowlist and the configured approver.",
        parameters: Type.Object({}),
        response: Type.Object({
          dirs: Type.Array(Type.String(), {
            description: "Current local-file allowlist",
          }),
          approver: Type.String({
            description: "Worker that approves additions (empty = gating disabled)",
          }),
        }),
      },
      (evt) => this.handleDirsGet(evt),
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
      `[${NS}] connected: bus worker_id=${this.workerID} default_reason=${this.defaultReasonWorker || "—"} per_chat=${this.perChat.size} feishu app=${this.lark.constructor.name} local_file_dirs=${this.allowedFileDirs.length ? this.allowedFileDirs.join(",") : "— (local file sends will be rejected)"} approver=${this.approver || "— (allowlist gating disabled)"}`,
    );
    // Presence is live-only (the SDK marks worker.ready transient and excludes
    // this worker from its own broadcast). The SDK also remembers this contract
    // and answers worker.discover with it, so peers and the WebUI can learn the
    // tools on demand.
    await this.base.announceReady("lark", [
      { type: "worker.input", description: "Feishu messages forwarded to reason" },
    ]);
    this.logger.info(`[${NS}] announced worker.ready (transient)`);
  }

  /** Connect and then run the bus event loop (blocks until {@link close}). */
  async run(): Promise<void> {
    await this.connect();
    // The worker never acts on `worker.input` events — reason does not reply
    // to lark that way. Replies arrive only via the `lark.send` extension, and
    // routing/allowlist management via the `lark.reason.*` / `lark.dirs.*`
    // extensions; every other event is dispatched to its registered handler
    // (unknown events are ignored). `worker.discover` is protocol traffic,
    // answered by BaseWorker.
    for await (const evt of this.bus.events()) {
      // An approval.decision — or the bus reporting that an approval request
      // could not be delivered — answers a parked allowlist addition. These are
      // replies, not extensions, so they are resolved before dispatch.
      if (await this.handleApprovalReply(evt)) continue;
      this.base.dispatchExtension(evt);
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

    // A new user message begins a fresh reply: forget any in-progress
    // outbound append so the next lark.send posts a new message instead of
    // extending the previous turn's.
    this.appendTargets.delete(msg.chatId);

    const input = createEvent("worker.input", {
      text: this.renderReminder(msg) + "\n" + msg.content,
      chat_id: msg.chatId,
      sender_open_id: msg.senderId,
      input_mode: "append",
    });
    const reasonWorker = this.reasonWorkerFor(msg.chatId);
    if (!reasonWorker) {
      this.logger.warn(
        `[${NS}] drop feishu message chat=${msg.chatId} msg=${msg.messageId}: no reason worker (no per-chat mapping and no default)`,
      );
      return;
    }
    await this.bus.send(input, reasonWorker);
    this.logger.info(
      `[${NS}] sent worker.input → reason ${reasonWorker} (chat ${msg.chatId})`,
    );
  }

  /**
   * Resolve the reason worker a chat's messages are forwarded to: its per-chat
   * mapping, else the default. Returns "" when neither is configured.
   */
  private reasonWorkerFor(chatId: string): string {
    return this.perChat.get(chatId) || this.defaultReasonWorker;
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

  /** Fill the {chat_id} / {sender_open_id} placeholders in the reminder template. */
  private renderReminder(msg: { chatId: string; senderId: string }): string {
    return this.systemReminder
      .replaceAll("{chat_id}", msg.chatId)
      .replaceAll("{sender_open_id}", msg.senderId);
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

    if (!target) {
      await this.base.replyFailed(
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
              argString(tc.args, "image") ||
                argString(tc.args, "file") ||
                argString(tc.args, "video") ||
                argString(tc.args, "audio"),
            ),
        );
        await this.base.replyCompleted(tc.callerID, tc.callID, "sent", tc.traceID);
      } catch (err) {
        this.logger.error(`[${NS}] lark.send media failed:`, err);
        await this.base.replyFailed(
          tc.callerID,
          tc.callID,
          (err as Error).message,
          tc.traceID,
        );
      }
      return;
    }

    const text = argString(tc.args, "text");
    if (!text) {
      await this.base.replyFailed(
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
      await this.base.replyCompleted(tc.callerID, tc.callID, "sent", tc.traceID);
    } catch (err) {
      // Failed mid-append: drop the half-updated entry so the next send starts
      // a fresh message rather than corrupting the accumulated text.
      this.appendTargets.delete(target);
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
    const merged =
      pending.text.replace(/\s+$/, "") + "\n" + text.replace(/\s+$/, "");
    await this.lark.editMessage(pending.messageId, merged);
    pending.text = merged;
    this.logger.info(
      `[${NS}] lark.append → ${target} (extended ${pending.messageId})`,
    );
  }

  /**
   * Serve the `lark.reason.set` extension: route a chat to a worker (`chat_id`)
   * or set the default. Persists the change so it survives a restart.
   */
  private async handleReasonSet(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    const workerId =
      argString(tc.args, "worker_id") || argString(tc.args, "workerId");
    const chatId = argString(tc.args, "chat_id") || argString(tc.args, "chatId");

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
    } else {
      this.defaultReasonWorker = workerId;
      this.logger.info(`[${NS}] lark.reason.set default → ${workerId}`);
    }
    await this.persistState();
    await this.base.replyCompleted(tc.callerID, tc.callID, "ok", tc.traceID);
  }

  /** Serve the `lark.reason.get` extension: return the current routing as JSON. */
  private async handleReasonGet(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    // Structured reply: the object IS the payload, so a caller (or a PTC script)
    // reads the fields instead of parsing a JSON string.
    await this.base.replyCompleted(
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

  /**
   * Serve `lark.dirs.add`: extend the local-file allowlist. The approver's own
   * request is the consent and applies directly; any other caller is parked
   * behind an `approval.request` and answered when the verdict arrives.
   */
  private async handleDirsAdd(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    const rawPath = argString(tc.args, "path") || argString(tc.args, "dir");
    if (!rawPath.trim()) {
      await this.base.replyFailed(
        tc.callerID,
        tc.callID,
        "path is required",
        tc.traceID,
      );
      return;
    }
    const path = normalizeDirPath(rawPath);

    if (this.approver && tc.callerID !== this.approver) {
      await this.requestDirApproval(tc, path);
      return;
    }
    await this.applyDirAdd(tc, path);
  }

  /** Serve `lark.dirs.get`: the current allowlist plus the configured approver. */
  private async handleDirsGet(evt: Event): Promise<void> {
    const tc = parseToolCall(evt);
    await this.base.replyCompleted(
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
  private async applyDirAdd(tc: ToolCall, path: string): Promise<void> {
    this.setAllowedFileDirs([...this.allowedFileDirs, path]);
    await this.persistState();
    this.logger.info(
      `[${NS}] lark.dirs.add → ${path} (dirs=${this.allowedFileDirs.join(",") || "—"})`,
    );
    await this.base.replyCompleted(
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
   */
  private async requestDirApproval(tc: ToolCall, path: string): Promise<void> {
    let exists = false;
    try {
      exists = (await stat(path)).isDirectory();
    } catch {
      // Existence is context for the approver, not a precondition: the
      // directory may be created after the approval (the SDK's containment
      // check is prefix-based, so a not-yet-existing allowlist entry is fine).
    }

    const approval = createEvent(APPROVAL_REQUEST, {
      origin: tc.callerID,
      requested_by: this.workerID,
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
      await this.bus.send(approval, this.approver);
    } catch (err) {
      this.pendingDirApprovals.delete(approval.id);
      this.logger.error(
        `[${NS}] lark.dirs.add approval request to ${this.approver} failed:`,
        err,
      );
      await this.base.replyFailed(
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
   * Returns true when the event belongs to a pending approval (and so was
   * consumed rather than dispatched as an extension).
   */
  private async handleApprovalReply(evt: Event): Promise<boolean> {
    const isDecision = evt.type === APPROVAL_DECISION;
    const isUndelivered =
      evt.type === EventType.RequestFailed ||
      evt.type === EventType.RequestRejected;
    if (!isDecision && !isUndelivered) return false;

    const id = evt.request_id ?? "";
    if (!id) return false;
    const pending = this.pendingDirApprovals.get(id);
    if (!pending) return false;

    if (isUndelivered) {
      this.pendingDirApprovals.delete(id);
      const reason =
        (typeof evt.payload["error"] === "string" && evt.payload["error"]) ||
        (typeof evt.payload["reason"] === "string" && evt.payload["reason"]) ||
        "not delivered";
      this.logger.warn(
        `[${NS}] approval request ${id} could not reach ${this.approver}: ${reason}`,
      );
      await this.base.replyFailed(
        pending.callerID,
        pending.callID,
        `approval request failed: ${reason}`,
        pending.traceID,
      );
      return true;
    }

    if (this.approver && evt.worker_id !== this.approver) {
      // Only the configured approver may decide; keep the request parked and
      // ignore the event, in case the real approver answers later.
      this.logger.warn(
        `[${NS}] ignoring ${APPROVAL_DECISION} for ${id} from ${evt.worker_id} (expected ${this.approver})`,
      );
      return true;
    }

    this.pendingDirApprovals.delete(id);
    const approved = evt.payload["approved"] === true;
    const note =
      typeof evt.payload["note"] === "string" ? evt.payload["note"] : "";
    if (!approved) {
      const msg = note ? `approval denied: ${note}` : "approval denied";
      this.logger.info(`[${NS}] lark.dirs.add denied: ${pending.path} (${msg})`);
      await this.base.replyFailed(
        pending.callerID,
        pending.callID,
        msg,
        pending.traceID,
      );
      return true;
    }

    this.logger.info(`[${NS}] lark.dirs.add approved: ${pending.path}`);
    await this.applyDirAdd(
      {
        callID: pending.callID,
        name: LARK_DIRS_ADD,
        callerID: pending.callerID,
        args: {},
        traceID: pending.traceID,
      },
      pending.path,
    );
    return true;
  }
}

/**
 * Build a media `SendInput` from a `lark.send` tool call, or `undefined` when
 * no media arg is present (the caller then falls back to text). Priority:
 * image, file, video, audio. A `source` may be an http(s) URL or a local file
 * path — the channel fetches/reads it — and `file` takes a `file_name`.
 */
export function buildSendInput(args: Record<string, unknown>): SendInput | undefined {
  const image = argString(args, "image");
  if (image) return { image: { source: image } };

  const file = argString(args, "file");
  if (file) {
    return {
      file: {
        source: file,
        fileName: argString(args, "file_name") || mediaBaseName(file),
      },
    };
  }

  const video = argString(args, "video");
  if (video) return { video: { source: video } };

  const audio = argString(args, "audio");
  if (audio) return { audio: { source: audio } };

  return undefined;
}

/** Last path segment of a URL or path, as a credible file display name. */
function mediaBaseName(src: string): string {
  const cleaned = src.split("?")[0].split("#")[0];
  const seg = cleaned.split(/[/\\]/).filter(Boolean).pop();
  return seg || "file";
}