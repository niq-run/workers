/**
 * The msp worker, assembled.
 *
 * Two halves, deliberately different owners:
 *
 *   `InterfaceWorker` (from @niq.run/worker-sdk) — the niq side: identity, ACL,
 *   presence, discover, tool dispatch, replies, request correlation.
 *
 *   `MspBackend` (./backend.js) — the MSP side: the node, the TCP endpoint, the
 *   discovery directory, and the tool/signal bridge in both directions.
 *
 * This module is only the wiring between them, plus the factory a CLI uses. It
 * exists (rather than a single class) so the two halves can be tested apart and
 * so the same niq side serves any other outward surface unchanged.
 *
 * Flow:
 *   niq caller ── msp.call ──▶ this worker ──▶ MSP peer tool
 *   MSP peer ── niq_call ──▶ this worker ──▶ niq worker tool
 *   MSP signal ──▶ this worker ──▶ niq event (broadcast or directed)
 */
import {
  HTTPWorkerClient,
  InterfaceWorker,
  type WorkerSideChannel,
} from "@niq.run/worker-sdk";
import { MspBackend, type MspBackendOptions } from "./backend.js";

export { MspBackend } from "./backend.js";
export type { MspBackendOptions, MspLogger, MspNodeLike } from "./backend.js";
export {
  MSP_NIQ_CALL,
  MSP_NIQ_SEND,
  MSP_TOOL_CALL,
  MSP_TOOL_MANIFEST,
  MSP_TOOL_NODES,
  MSP_TOOL_PUBLISH,
  NS as MSP_NS,
} from "./backend.js";
export {
  DEFAULT_MSP_NODES_DIR,
  MSP_ENV,
  mspConfigFromArgs,
  sanitizeNodeID,
  type MspConfig,
} from "./config.js";

/** The worker type announced to peers (`worker.ready` "type"). */
export const MSP_WORKER_TYPE = "msp";

/** Everything the assembled worker needs. */
export interface MspWorkerOptions extends MspBackendOptions {
  /** Bus base URL, e.g. `http://localhost:8080`. */
  baseURL: string;
  /** Bus identity. */
  workerID: string;
  /** Bus credential. */
  credential: string;
  /** Injectable fetch (tests / proxies). */
  fetchImpl?: typeof fetch;
}

/** The assembled msp worker: an interface worker over an MSP backend. */
export class MspWorker {
  readonly backend: MspBackend;
  readonly worker: InterfaceWorker;

  constructor(opts: MspWorkerOptions) {
    const { baseURL, workerID, credential, fetchImpl, ...backendOpts } = opts;
    const channel = new HTTPWorkerClient({
      baseURL,
      workerID,
      credential,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    this.backend = new MspBackend(backendOpts);
    this.worker = new InterfaceWorker({
      id: workerID,
      channel,
      type: MSP_WORKER_TYPE,
      publishes: [
        {
          type: backendOpts.signalEventType,
          description: "MSP signals forwarded from the connected MSP world",
        },
      ],
      backends: [this.backend],
    });
    // The assembly is the one place that knows both halves, so it is where a
    // backend's tools get attached to the worker that serves them.
    this.backend.registerTools(this.worker);
  }

  /** The bus channel this worker dials (exposed for tests and callers). */
  get channel(): WorkerSideChannel {
    return this.worker.channel;
  }

  /**
   * Join both worlds: connect the bus, inject the handler into the backend,
   * create the MSP node, announce presence, then serve.
   */
  async connect(): Promise<void> {
    await this.worker.start();
  }

  /** Connect, then serve until the bus stream ends or {@link close}. */
  async run(): Promise<void> {
    await this.connect();
    await this.worker.done();
  }

  /** Leave both worlds. */
  async close(): Promise<void> {
    await this.worker.stop();
  }
}
