/**
 * The bus side: one-shot dial operations on top of the SDK's
 * `InterfaceSession` — the stateless half of the interface worker.
 *
 * Every CLI invocation is short-lived: connect, do one thing, close. The
 * session owns the read loop, request correlation, timeouts and event delivery;
 * this file only adds what is specific to the CLI form: credential resolution
 * happens above, and here we keep the friendly 401/403 diagnostics, the
 * directed-only publish policy, and the bounded listen loop.
 */
import {
  HTTPWorkerClient,
  InterfaceSession,
  ReplyError,
  createEvent,
  matchesType,
  newId,
  type Event,
} from "@niq.run/worker-sdk";
import { CliError, usageError } from "./errors.js";

/** The connection a command dials with (resolved by `config.resolveDial`). */
export interface BusDial {
  /** Source name, or `env`/`flags` — reported in output. */
  readonly source: string;
  readonly busURL: string;
  readonly workerID: string;
  readonly credential: string;
}

/** Injectable dependencies (tests pass a fake `fetch`). */
export interface BusContext {
  fetchImpl?: typeof fetch;
  /** Override the SSE handshake timeout (default 15s; tests use a small value). */
  connectTimeoutMs?: number;
}

/** How long to wait for the SSE handshake before giving up. */
const CONNECT_TIMEOUT_MS = 15_000;

/** One event to send. Sends are directed: at least one target is required. */
export interface PublishRequest {
  type: string;
  payload: Record<string, unknown>;
  /** Recipients. Non-empty — this CLI never broadcasts. */
  targets: string[];
  traceID?: string;
}

/** What a publish did, for the command's JSON output. */
export interface PublishOutcome {
  event: Event;
  targets: string[];
}

/** A directed request awaiting a correlated reply. */
export interface RequestRequest {
  type: string;
  payload: Record<string, unknown>;
  target: string;
  timeoutMs: number;
  traceID?: string;
}

/** The result of {@link request}: a reply plus whether it was a success. */
export interface RequestOutcome {
  requestID: string;
  reply: Event;
  ok: boolean;
  error?: string;
}

/** Options for {@link listen}. */
export interface ListenOptions {
  /** Client-side type filter: exact, `*`, or `prefix.*` (repeatable). */
  types?: string[];
  /** Client-side sender filter (worker ids). */
  from?: string[];
  /** Stop after this many matching events. */
  max?: number;
  /** Stop after this long. */
  timeoutMs?: number;
  /** Abort (e.g. SIGINT). */
  signal?: AbortSignal;
  /** Called once the stream is established, before any event. */
  onReady?: () => void;
  /** Called for every matching event, in arrival order. */
  onEvent: (evt: Event) => void;
}

/** Why a listen loop ended. */
export interface ListenOutcome {
  received: number;
  stop: "max" | "timeout" | "abort" | "end";
}

/**
 * Build the event a publish would send, without connecting. Used by
 * `--dry-run`; the identity is stamped the same way the client stamps it.
 */
export function previewEvent(
  dial: BusDial,
  req: Pick<PublishRequest, "type" | "payload" | "traceID">,
): Event {
  const evt = createEvent(req.type, req.payload);
  evt.worker_id = dial.workerID;
  if (req.traceID) evt.trace_id = req.traceID;
  return evt;
}

/** Publish one directed event. Broadcast is intentionally not supported. */
export async function publish(
  dial: BusDial,
  req: PublishRequest,
  ctx: BusContext = {},
): Promise<PublishOutcome> {
  const targets = dedupe(req.targets);
  if (targets.length === 0) {
    throw usageError(
      "publish needs at least one target: this CLI sends directed events only " +
        "(broadcast is disabled)",
    );
  }
  const event = previewEvent(dial, req);
  const session = await open(dial, ctx);
  try {
    await session.send(event, ...targets);
  } catch (err) {
    throw publishError(err, dial, req.type);
  } finally {
    await session.close().catch(() => {});
  }
  return { event, targets };
}

/**
 * Send a request and wait for the correlated reply. A failed/rejected reply is
 * returned (not thrown) so the command can print the reply and still exit
 * non-zero; a timeout or transport failure is a `CliError`.
 */
export async function request(
  dial: BusDial,
  req: RequestRequest,
  ctx: BusContext = {},
): Promise<RequestOutcome> {
  if (!req.target) throw new CliError("request needs a target worker id");

  const event = previewEvent(dial, {
    type: req.type,
    payload: req.payload,
    traceID: req.traceID ?? newId(),
  });
  const requestID = newId();
  event.request_id = requestID;

  const session = await open(dial, ctx);
  try {
    const reply = await session.request(req.target, event, {
      timeoutMs: req.timeoutMs,
    });
    return { requestID, reply, ok: true };
  } catch (err) {
    if (err instanceof ReplyError) {
      return {
        requestID,
        reply: err.reply,
        ok: false,
        error: err.message,
      };
    }
    throw err instanceof CliError
      ? err
      : new CliError(messageOf(err), { cause: err });
  } finally {
    await session.close().catch(() => {});
  }
}

/** Stream events routed to this identity until a stop condition. */
export async function listen(
  dial: BusDial,
  opts: ListenOptions,
  ctx: BusContext = {},
): Promise<ListenOutcome> {
  const session = await open(dial, ctx);

  let stopped = false;
  let timedOut = false;
  const stopNow = (): void => {
    if (stopped) return;
    stopped = true;
    void session.close().catch(() => {});
  };

  const onAbort = (): void => stopNow();
  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) stopNow();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      stopNow();
    }, opts.timeoutMs);
  }

  opts.onReady?.();

  let received = 0;
  let stop: ListenOutcome["stop"] = "end";
  try {
    for await (const evt of session.events()) {
      if (stopped) break;
      if (!matchesAnyType(opts.types ?? [], evt.type)) continue;
      if (opts.from && opts.from.length > 0 && !opts.from.includes(evt.worker_id)) {
        continue;
      }
      opts.onEvent(evt);
      received += 1;
      if (opts.max !== undefined && received >= opts.max) {
        stop = "max";
        break;
      }
    }
  } catch (err) {
    if (!stopped) {
      throw new CliError(`event stream failed: ${messageOf(err)}`, {
        cause: err,
      });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await session.close().catch(() => {});
  }

  if (timedOut) stop = "timeout";
  else if (signal?.aborted) stop = "abort";
  return { received, stop };
}

/** Open the SSE stream and return a session whose publish path is live. */
export async function ping(
  dial: BusDial,
  ctx: BusContext = {},
): Promise<number> {
  const started = Date.now();
  const session = await open(dial, ctx);
  await session.close().catch(() => {});
  return Date.now() - started;
}

async function open(
  dial: BusDial,
  ctx: BusContext,
): Promise<InterfaceSession> {
  const client = new HTTPWorkerClient({
    baseURL: dial.busURL,
    workerID: dial.workerID,
    credential: dial.credential,
    fetchImpl: diagnosticFetch(ctx.fetchImpl ?? fetch),
  });
  const session = new InterfaceSession({
    channel: client,
    connectTimeoutMs: ctx.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
  });

  try {
    await session.connect();
    return session;
  } catch (err) {
    await session.close().catch(() => {});
    throw connectError(err, dial);
  }
}

/**
 * The SDK surfaces a failed handshake as `status 401` without the bus's error
 * body, which is where the actionable part lives ("expired", "revoked",
 * "not remote-connectable"). Read that body for `/events` and rethrow, so the
 * message reaches the user. `/publish` is left untouched: the SDK inspects
 * non-OK publish replies itself to decide whether to reconnect.
 */
function diagnosticFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    const resp = await inner(input, init);
    if (resp.ok || !url.includes("/events")) return resp;

    const text = await resp.text().catch(() => "");
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
      else if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // not JSON: keep the raw body
    }
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
  };
}

function connectError(err: unknown, dial: BusDial): CliError {
  if (err instanceof CliError) return err;
  const raw = messageOf(err);

  if (raw.includes("HTTP 401")) {
    return new CliError(
      `authentication to ${dial.busURL} failed: ${raw}. ` +
        `The credential may be expired or revoked, or "${dial.workerID}" may not ` +
        `be a remote (dial-in) worker. Re-copy the connect block in the niq WebUI ` +
        `and re-import it ('niq-agent config import <name> --force').`,
      { cause: err },
    );
  }
  if (raw.includes("HTTP 403")) {
    return new CliError(
      `the bus at ${dial.busURL} refused "${dial.workerID}" (HTTP 403): ${raw}`,
      { cause: err },
    );
  }
  return new CliError(
    `cannot connect to ${dial.busURL} as ${dial.workerID}: ${raw}`,
    { cause: err },
  );
}

function publishError(err: unknown, dial: BusDial, type: string): CliError {
  if (err instanceof CliError) return err;
  const raw = messageOf(err);

  if (raw.includes("403")) {
    return new CliError(
      `the bus refused publishing ${type} as ${dial.workerID} (HTTP 403): ${raw}. ` +
        `Check this worker's publish permission for "${type}" in the niq WebUI.`,
      { cause: err },
    );
  }
  if (raw.includes("worker not connected")) {
    return new CliError(
      `the bus has no live session for ${dial.workerID} even after reconnecting: ${raw}`,
      { cause: err },
    );
  }
  return new CliError(
    `publishing ${type} to ${dial.busURL} as ${dial.workerID} failed: ${raw}`,
    { cause: err },
  );
}

function matchesAnyType(patterns: string[], type: string): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => matchesType(p, type));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
