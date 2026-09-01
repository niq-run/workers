/**
 * Hello worker — a minimal niq Worker built on {@link BaseWorker}.
 *
 * It subscribes to `hello.greet` events and answers each request with a
 * `request.completed` carrying a greeting. It doubles as a living example of
 * the extension registry + reply plumbing pattern: register what you respond
 * to, announce yourself, dispatch the event loop.
 */
import {
  BaseWorker,
  EventType,
  HTTPWorkerClient,
  readBusEnv,
  type Event,
  type HTTPWorkerClientOptions,
} from "@niq.run/worker-sdk";

export interface HelloWorkerOptions
  extends Omit<HTTPWorkerClientOptions, "baseURL" | "workerID" | "credential"> {
  /**
   * Bus base URL. Optional — falls back to `NIQ_BUS_URL` from the
   * environment (injected by the niq project supervisor).
   */
  baseURL?: string;
  /**
   * Worker identity registered on the bus. Optional — falls back to
   * `NIQ_WORKER_ID`.
   */
  workerID?: string;
  /**
   * Credential for this worker. Optional — falls back to
   * `NIQ_WORKER_CREDENTIAL`.
   */
  credential?: string;
  /** Event type that triggers a greeting. Defaults to `hello.greet`. */
  greetEventType?: string;
  /** Name used when the request does not carry one. Defaults to `world`. */
  defaultName?: string;
  /**
   * Environment to consult for the connection variables. Defaults to
   * `process.env`; injectable for tests.
   */
  env?: Record<string, string | undefined>;
}

export class HelloWorker {
  private readonly base: BaseWorker;
  private readonly greetType: string;
  private readonly defaultName: string;

  constructor(opts: HelloWorkerOptions) {
    // Explicit options win; env is consulted only for the fields not provided.
    const needsEnv = !opts.baseURL || !opts.workerID || !opts.credential;
    const env = {
      ...(needsEnv ? readBusEnv(opts.env) : {}),
      ...nonEmpty(opts),
    } as Required<Pick<HTTPWorkerClientOptions, "baseURL" | "workerID" | "credential">>;
    this.base = new BaseWorker({
      id: env.workerID,
      subscriptions: [{ type: opts.greetEventType ?? "hello.greet" }],
      channel: new HTTPWorkerClient({
        baseURL: env.baseURL,
        workerID: env.workerID,
        credential: env.credential,
        fetchImpl: opts.fetchImpl,
      }),
    });
    this.greetType = opts.greetEventType ?? "hello.greet";
    this.defaultName = opts.defaultName ?? "world";

    this.base.register(
      {
        event: this.greetType,
        description: "Greets the name in the payload (default: world).",
      },
      (evt) => this.handleGreet(evt),
    );
  }

  async run(): Promise<void> {
    await this.base.channel.connect();
    await this.base.announceReady("hello");

    for await (const evt of this.base.channel.events()) {
      this.base.dispatchExtension(evt);
    }
  }

  async close(): Promise<void> {
    await this.base.channel.close();
  }

  private async handleGreet(evt: Event): Promise<void> {
    // A notification (no request_id) expects no reply.
    if (!evt.request_id) return;
    const name =
      typeof evt.payload["name"] === "string"
        ? evt.payload["name"]
        : this.defaultName;
    await this.base.replyCompleted(
      evt.worker_id,
      evt.request_id,
      "greet",
      `hello, ${name}!`,
      evt.trace_id,
    );
  }
}

/** Event types the hello worker publishes, for its worker.ready announcement. */
export const HELLO_PUBLISHES = [{ event: EventType.RequestCompleted }];

/** Pick the explicitly-provided connection fields (non-empty wins over env). */
function nonEmpty(opts: HelloWorkerOptions): Partial<HTTPWorkerClientOptions> {
  const out: Partial<HTTPWorkerClientOptions> = {};
  if (opts.baseURL) out.baseURL = opts.baseURL;
  if (opts.workerID) out.workerID = opts.workerID;
  if (opts.credential) out.credential = opts.credential;
  return out;
}
