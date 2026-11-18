/**
 * The lark worker, assembled.
 *
 * Two halves, deliberately different owners:
 *
 *   `InterfaceWorker` (from @niq.run/worker-sdk) — the niq side: identity, ACL,
 *   presence, discover, tool dispatch, replies, request correlation. Shared with
 *   every other interface worker (the WebUI, a TUI, another chat bridge).
 *
 *   `LarkBackend` (./backend.js) — the Feishu side: the long connection, the
 *   chat → reason routing, the local-file allowlist, append-to-one-message.
 *
 * This module is only the wiring between them, plus the factory a CLI uses. It
 * exists (rather than a single class) so the two halves can be tested apart and
 * so the same niq side serves any other outward surface unchanged.
 *
 * Flow:
 *   Feishu message ──worker.input──▶ bound reason worker
 *   reason calls lark.send ──▶ this worker ──send──▶ Feishu chat
 *
 * A reason worker never "replies to lark": everything outbound is a `lark.send`
 * tool call. Routing and allowlist management are the `lark.reason.*` /
 * `lark.dirs.*` tools; an allowlist addition from anyone but the approver is
 * parked behind an `approval.request`.
 */
import { InterfaceWorker, type WorkerSideChannel } from "@niq.run/worker-sdk";
import { LarkBackend, type LarkBackendOptions } from "./backend.js";

export { LarkBackend } from "./backend.js";
export type { LarkBackendOptions } from "./backend.js";

/**
 * Everything the assembled worker needs: the backend's own options plus the bus
 * channel. The channel is the worker's side of the connection; the backend
 * never sees it (it talks through the injected handler).
 */
export interface LarkWorkerOptions extends LarkBackendOptions {
  /** Worker-side bus channel. Built from env/args by the CLI. */
  bus: WorkerSideChannel;
}

/** The worker type announced to peers (`worker.ready` "type"). */
export const LARK_WORKER_TYPE = "lark";

/**
 * The events this worker declares it emits, shown to peers via the roster.
 * A Feishu message is delivered as a directed `worker.input`, not a lark-domain
 * event, so that is what is advertised.
 */
export const LARK_PUBLISHES = [
  { type: "worker.input", description: "Feishu messages forwarded to reason" },
];

/** The assembled lark worker: an interface worker over the Feishu backend. */
export class LarkWorker {
  readonly backend: LarkBackend;
  readonly worker: InterfaceWorker;

  constructor(opts: LarkWorkerOptions) {
    const { bus, ...backendOpts } = opts;
    this.backend = new LarkBackend(backendOpts);
    this.worker = new InterfaceWorker({
      id: bus.id,
      channel: bus,
      type: LARK_WORKER_TYPE,
      publishes: LARK_PUBLISHES,
      backends: [this.backend],
    });
    // The assembly is the one place that knows both halves, so it is where a
    // backend's tools get attached to the worker that serves them (mirrors Go's
    // `niq.Backend.RegisterTools`).
    this.backend.registerTools(this.worker);
  }

  /**
   * Join the bus: connect, inject the handler into the backend, connect Feishu,
   * load the persisted routing, announce presence, then serve.
   *
   * The order is the contract: `setHandler` before any backend lifetime, the
   * backend's state loaded before the first message is forwarded, presence
   * announced last.
   */
  async connect(): Promise<void> {
    await this.worker.start();
  }

  /** Connect, then serve until the bus stream ends or {@link close}. */
  async run(): Promise<void> {
    await this.connect();
    await this.worker.done();
  }

  /** Leave the bus and disconnect Feishu. */
  async close(): Promise<void> {
    await this.worker.stop();
  }
}

// ── Re-exports ──
//
// The Feishu-side primitives keep their historical import path (`./worker.js`)
// so a caller never has to know the module split.

export {
  APPROVAL_DECISION,
  APPROVAL_REQUEST,
  DEFAULT_APPROVER,
  DEFAULT_LOGGER,
  DEFAULT_SYSTEM_REMINDER,
  FileLarkStateStore,
  LARK_README,
  LARK_DIRS_ADD,
  LARK_DIRS_GET,
  LARK_REASON_GET,
  LARK_REASON_SET,
  LARK_SEND_EVENT,
  argStr,
  buildSendInput,
  defaultStateFile,
  larkConfigFromEnv,
  normalizeDirPath,
  parseDirList,
  withTimestamps,
} from "./feishu.js";
export type { LarkChannel, LarkConfig, LarkStateStore, Logger } from "./feishu.js";
