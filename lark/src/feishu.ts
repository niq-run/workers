/**
 * The Feishu/Lark side of the worker: everything that talks to the outside.
 *
 * This module is deliberately free of niq plumbing — no bus, no events, no tool
 * registry. It owns the Feishu channel, the chat → reason routing, the local-file
 * allowlist and the outbound append state, and exposes them as plain methods the
 * backend calls. Keeping it separate is what lets the backend be a thin adapter
 * and this half be testable without a bus.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  LarkChannelOptions,
  NormalizedMessage,
  RejectEvent,
  SendInput,
} from "@larksuite/channel";

// ── schema fragments ──
//
// Declared once and reused: the media arguments mean the same thing everywhere,
// and a tool that returns a media id reports the same shape. TypeBox schemas are
// plain JSON Schema, so they ride worker.ready unchanged.

export const LarkSendTarget = Type.String({
  description: "Feishu chat_id, open_id, or user_id of the recipient",
});
export const LarkMediaSource = Type.String({
  description: "http(s) URL or local file path of the media to send",
});
export const LarkFileSource = Type.String({
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

export const DEFAULT_LOGGER: Logger = withTimestamps(console);

/** The subset of the `fs/promises` API the file state store uses. Injectable. */
export interface StateFileFs {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<string | undefined>;
  readFile(file: string, enc: "utf8"): Promise<string>;
  writeFile(file: string, data: string, enc: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/**
 * Persistence for the worker's own state (routing + allowlist). Injected for
 * tests; the default is {@link FileLarkStateStore}.
 *
 * This worker is launched as a managed-process worker, so it persists its own
 * state file — the niq supervisor hands it `NIQ_STATE_DIR` for exactly that
 * (see {@link defaultStateFile}). An in-process worker would leave this to the
 * host's snapshot instead.
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

/**
 * The default state file path: `LARK_STATE_FILE` when set, else
 * `<NIQ_STATE_DIR>/lark-state.json` (the directory the niq supervisor gives every
 * managed-process worker), else `./lark-state.json` when launched by hand.
 */
export function defaultStateFile(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.LARK_STATE_FILE?.trim();
  if (explicit) return explicit;
  const stateDir = env.NIQ_STATE_DIR?.trim();
  if (stateDir) return resolve(stateDir, "lark-state.json");
  return "lark-state.json";
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
   * arrives. Defaults to `webui` (the interface worker's id); an empty string
   * disables gating.
   */
  approver?: string;
  /** Injectable factory — defaults to the real `@larksuite/channel`. */
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
export function dedupeDirs(dirs: readonly string[]): string[] {
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
        `Provide them as launch args (declaration params) when the worker is ` +
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

export const DEFAULT_SYSTEM_REMINDER = `<system-reminder>
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

/** The channel's outbound config, as forwarded to `@larksuite/channel`. */
export type ChannelOutbound = NonNullable<LarkChannelOptions["outbound"]>;

/**
 * Build a media `SendInput` from a `lark.send` tool call, or `undefined` when
 * no media arg is present (the caller then falls back to text). Priority:
 * image, file, video, audio. A `source` may be an http(s) URL or a local file
 * path — the channel fetches/reads it — and `file` takes a `file_name`.
 */
export function buildSendInput(args: Record<string, unknown>): SendInput | undefined {
  const image = argStr(args, "image");
  if (image) return { image: { source: image } };

  const file = argStr(args, "file");
  if (file) {
    return {
      file: {
        source: file,
        fileName: argStr(args, "file_name") || mediaBaseName(file),
      },
    };
  }

  const video = argStr(args, "video");
  if (video) return { video: { source: video } };

  const audio = argStr(args, "audio");
  if (audio) return { audio: { source: audio } };

  return undefined;
}

/** Read a string field, or "" when absent/not a string. */
export function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Last path segment of a URL or path, as a credible file display name. */
function mediaBaseName(src: string): string {
  const cleaned = src.split("?")[0].split("#")[0];
  const seg = cleaned.split(/[/\\]/).filter(Boolean).pop();
  return seg || "file";
}

/** `stat` as a "is this an existing directory" probe, swallowing errors. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// ── Protocol ──

/** The extension this worker exposes so a peer (reason) can send Feishu messages. */
export const LARK_SEND_EVENT = "lark.send";

/** Runtime routing: which reason worker a chat's messages go to. */
export const LARK_REASON_SET = "lark.reason.set";
export const LARK_REASON_GET = "lark.reason.get";

/** Runtime local-file allowlist. Additions are approval-gated and persisted. */
export const LARK_DIRS_ADD = "lark.dirs.add";
export const LARK_DIRS_GET = "lark.dirs.get";

/** Default approver for allowlist changes: the human interface worker owns approvals. */
export const DEFAULT_APPROVER = "webui";

/** Core approval protocol pair (mirrors `core/itfs/event` in the niq core). */
export const APPROVAL_REQUEST = "approval.request";
export const APPROVAL_DECISION = "approval.decision";

/** The agent-facing guide `worker.readme` returns; live state is appended at reply time. */
export const LARK_README = `# lark — Feishu / Lark bridge

Bridges the niq event bus to Feishu. Every Feishu message is forwarded to the
chat's bound reason worker as worker.input { text, chat_id, sender_open_id,
input_mode: "append" }, prefixed with a <system-reminder> naming the chat id and
asking reason to answer with lark.send.

This worker is an *interface worker*: the niq side of it (identity, presence,
tool dispatch, replies) comes from the shared InterfaceWorker base, and the
Feishu side is its backend. A reason worker never "replies to lark" — outbound
messages are always lark.send calls.

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
