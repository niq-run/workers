/**
 * Hello worker — the reference example for writing a niq worker.
 *
 * It is deliberately plain: a `BaseWorker` (identity, extensions, replies,
 * presence) plus a few lines of your own. Everything here is the contract every
 * worker follows, in miniature:
 *
 *   - state that lives in the worker (not in the bus);
 *   - two served events, one replying with text and one with an object;
 *   - an event it *publishes* (broadcast) and declares in `worker.ready`;
 *   - the generic `worker.readme` / `worker.help` capabilities peers can ask for;
 *   - config layered flags > env > default;
 *   - a lifetime of connect → announce → dispatch loop → drain → close.
 *
 * File layout of a worker (see README.md for the full guide):
 *
 *   src/worker.ts      this file — importable in-process, testable without a bus
 *   src/start.ts       the `niq-hello` binary (arg parsing + runWorkerApp)
 *   src/worker.test.ts protocol-level tests against a fake bus
 */
import {
  argString,
  BaseWorker,
  createEvent,
  HTTPWorkerClient,
  parseToolCall,
  readBusEnv,
  s,
  type BusEnv,
  type Event,
  type HTTPWorkerClientOptions,
} from "@niq.run/worker-sdk";

/** The worker type announced in `worker.ready` (the roster's "type"). */
export const HELLO_WORKER_TYPE = "hello";

/** Served: greet a name and get the greeting back. */
export const HELLO_GREET = "hello.greet";
/** Served: read this worker's own counters. */
export const HELLO_STATS = "hello.stats";
/** Published: every greeting, broadcast for anyone interested. */
export const HELLO_GREETED = "hello.greeted";

/** Env var read when no `--default-name` / option is given. */
export const DEFAULT_NAME_ENV = "HELLO_DEFAULT_NAME";

/**
 * Events this worker declares it emits, in the wire form the roster reads.
 * Universal protocol events (`request.completed`, `worker.ready`) are implied;
 * this list is for the worker's *own* domain events, so peers can find them.
 */
export const HELLO_PUBLISHES = [
  {
    type: HELLO_GREETED,
    description: "A greeting was produced (broadcast, fire-and-forget)",
  },
];

/** How many recent names `hello.stats` remembers. */
const RECENT_LIMIT = 10;

export interface HelloWorkerOptions
  extends Omit<HTTPWorkerClientOptions, "baseURL" | "workerID" | "credential"> {
  /** Bus base URL. Optional — falls back to `NIQ_BUS_URL`. */
  baseURL?: string;
  /** Worker identity on the bus. Optional — falls back to `NIQ_WORKER_ID`. */
  workerID?: string;
  /** Credential for this identity. Optional — falls back to `NIQ_WORKER_CREDENTIAL`. */
  credential?: string;
  /** Name to greet when a request carries none. Falls back to `HELLO_DEFAULT_NAME`, then `world`. */
  defaultName?: string;
  /** Environment to consult for the connection and config. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export class HelloWorker {
  private readonly base: BaseWorker;
  private readonly defaultName: string;
  private readonly startedAt = Date.now();

  // ── State ──
  //
  // A worker is an actor: it owns state and only changes it while handling a
  // message. Keeping it as plain fields is enough; there is no shared store.
  private greeted = 0;
  private readonly recentNames: string[] = [];

  /** Handler promises, drained by {@link close} so shutdown is graceful. */
  private readonly work = new Set<Promise<void>>();

  constructor(opts: HelloWorkerOptions) {
    const env = opts.env ?? process.env;
    const conn = resolveConnection(opts, env);

    this.defaultName =
      opts.defaultName?.trim() || env[DEFAULT_NAME_ENV]?.trim() || "world";

    this.base = new BaseWorker({
      id: conn.workerID,
      // Subscriptions control BROADCAST delivery: the bus fans a broadcast out
      // to online workers whose subscriptions match. Directed sends (a peer
      // calling this worker by id) arrive regardless. Declaring the served
      // events here means a broadcast of `hello.greet` is handled too.
      subscriptions: [{ type: HELLO_GREET }, { type: HELLO_STATS }],
      channel: new HTTPWorkerClient({
        baseURL: conn.baseURL,
        workerID: conn.workerID,
        credential: conn.credential,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    });

    this.registerCapabilities();
  }

  /** The bus identity this worker speaks as. */
  get id(): string {
    return this.base.id;
  }

  // ── Capabilities ──

  /**
   * Declare what this worker serves.
   *
   * `register` is both documentation and dispatch: `parameters` / `response`
   * ride `worker.ready` (so peers and the WebUI can see the contract), and the
   * handler is what runs when the event arrives. Schemas are plain JSON Schema;
   * `s.*` is the SDK's small builder, so no extra dependency is needed.
   */
  private registerCapabilities(): void {
    this.base.register(
      {
        event: HELLO_GREET,
        description: "Greet a name and return the greeting text.",
        parameters: s.object({
          name: s.optional(
            s.string("Who to greet. Defaults to the worker's configured name."),
          ),
        }),
        response: s.string('Greeting text, e.g. "hello, world!".'),
      },
      // Handlers are async but the dispatch loop does not await them, so track
      // each promise: `close()` drains them, and a throw cannot go unhandled.
      (evt) => this.track(this.handleGreet(evt)),
    );

    this.base.register(
      {
        event: HELLO_STATS,
        description: "Return this worker's greeting counters.",
        parameters: s.object({}),
        response: s.object({
          greeted: s.integer("Greetings produced since start"),
          names: s.array(s.string(), "Most recent names, oldest first"),
          uptime_ms: s.integer("Uptime in milliseconds"),
          default_name: s.string("The name used when a request carries none"),
        }),
      },
      (evt) => this.track(this.handleStats(evt)),
    );

    // Every well-behaved worker can say what it is and how to use it. Both are
    // generic protocol events, so no custom event names are involved:
    //   worker.readme -> this guide
    //   worker.help { event_name } -> the guide for one served event
    this.base.registerReadme(
      "Read this worker's usage guide: the events it serves, its config and its state.",
      () => this.renderReadme(),
    );
    this.base.registerHelp({
      // A custom guide may return null to fall back to the generic one rendered
      // from the declared schema — that is why `params` is always an object.
      [HELLO_GREET]: (params) => {
        if (params["examples"] === undefined) return null;
        return (
          `hello.greet examples:\n` +
          `  {}                      -> "hello, ${this.defaultName}!"\n` +
          `  {"name":"ada"}          -> "hello, ada!"`
        );
      },
    });
  }

  // ── Handlers ──

  /**
   * A request/reply capability: read the args, do the work, answer the caller.
   *
   * `parseToolCall` extracts the common envelope (`callID`, `callerID`, `args`,
   * `traceID`) so handlers never re-implement request-id plumbing. A call with
   * no `callID` is a notification: do the work, reply to nobody.
   */
  private async handleGreet(evt: Event): Promise<void> {
    const call = parseToolCall(evt);
    const name = argString(call.args, "name").trim() || this.defaultName;
    const greeting = `hello, ${name}!`;

    this.greeted += 1;
    this.recentNames.push(name);
    if (this.recentNames.length > RECENT_LIMIT) this.recentNames.shift();

    // Broadcast the domain event. It is best-effort: a failed broadcast must
    // not fail the caller's request.
    await this.safeBroadcast(
      createEvent(HELLO_GREETED, { name, greeting }),
    );

    if (call.callID) {
      await this.base.replyString(call.callerID, call.callID, greeting, call.traceID);
    }
  }

  /**
   * A capability that replies with an object instead of text.
   *
   * An object reply IS the payload (no `{result}` wrapper), which is what makes
   * structured replies pleasant to consume on the other end.
   */
  private async handleStats(evt: Event): Promise<void> {
    const call = parseToolCall(evt);
    if (!call.callID) return; // notification: nothing to report back
    await this.base.replyObject(
      call.callerID,
      call.callID,
      {
        greeted: this.greeted,
        names: [...this.recentNames],
        uptime_ms: Date.now() - this.startedAt,
        default_name: this.defaultName,
      },
      call.traceID,
    );
  }

  // ── Lifetime ──

  /**
   * Connect, announce presence, then serve until the bus closes the stream.
   *
   * The order matters: connect first (a broadcast before the stream is open is
   * not accepted by the bus), then announce so peers can discover this worker,
   * then dispatch every event routed to this identity.
   */
  async run(): Promise<void> {
    await this.base.channel.connect();
    await this.base.announceReady(HELLO_WORKER_TYPE, HELLO_PUBLISHES);

    for await (const evt of this.base.channel.events()) {
      this.base.dispatchExtension(evt);
    }
  }

  /** Drain in-flight handlers, then close the connection. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.work]);
    await this.base.channel.close();
  }

  // ── Internals ──

  private track(promise: Promise<void>): void {
    const wrapped = promise.catch((err: unknown) => {
      console.error(`[hello] handler failed:`, err);
    });
    this.work.add(wrapped);
    void wrapped.finally(() => this.work.delete(wrapped));
  }

  private async safeBroadcast(evt: Event): Promise<void> {
    try {
      await this.base.channel.broadcast(evt);
    } catch (err) {
      console.error(`[hello] broadcast ${evt.type} failed:`, err);
    }
  }

  private renderReadme(): string {
    return [
      `# hello — a reference niq worker`,
      ``,
      `Identity: \`${this.base.id}\` (type \`${HELLO_WORKER_TYPE}\`)`,
      `Serves: \`${HELLO_GREET}\`, \`${HELLO_STATS}\``,
      `Publishes: \`${HELLO_GREETED}\``,
      `Default name: \`${this.defaultName}\``,
      `Greeted so far: ${this.greeted}`,
      ``,
      `Try: \`hello.greet\` with \`{"name":"ada"}\`, then \`hello.stats\`.`,
    ].join("\n");
  }
}

/**
 * Resolve the bus connection: explicit options first, then the supervisor's env
 * for whatever is missing. All three variables are required together, so
 * `readBusEnv` (which names every missing one) reports what is absent.
 */
function resolveConnection(
  opts: HelloWorkerOptions,
  env: Record<string, string | undefined>,
): BusEnv {
  if (opts.baseURL && opts.workerID && opts.credential) {
    return { baseURL: opts.baseURL, workerID: opts.workerID, credential: opts.credential };
  }
  const fromEnv = readBusEnv(env);
  return {
    baseURL: opts.baseURL ?? fromEnv.baseURL,
    workerID: opts.workerID ?? fromEnv.workerID,
    credential: opts.credential ?? fromEnv.credential,
  };
}
