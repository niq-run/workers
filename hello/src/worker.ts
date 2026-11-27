/**
 * Hello worker — the reference example for writing a niq worker.
 *
 * It is deliberately plain: a `BaseWorker` (identity, extensions, replies,
 * presence) plus a few lines of your own. Everything here is the contract every
 * worker follows, in miniature:
 *
 *   - state that lives in the worker (not in the bus), persisted when — and only
 *     when — the caller offers a state directory;
 *   - three served events: text reply, object reply, and a config edit;
 *   - an event it *publishes* (broadcast) and declares in `worker.ready`;
 *   - the generic `worker.readme` / `worker.help` capabilities peers can ask for;
 *   - config layered flags > env > default, plus a runtime config edit that asks
 *     the composing layer to persist it (`patchConfig`) and degrades to
 *     process-only when nothing is injected;
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
  ConfigUnavailableError,
  createEvent,
  HTTPWorkerClient,
  parseToolCall,
  readBusEnv,
  readStateDir,
  s,
  type BusEnv,
  type ConfigPatch,
  type Event,
  type HTTPWorkerClientOptions,
} from "@niq.run/worker-sdk";

/** The worker type announced in `worker.ready` (the roster's "type"). */
export const HELLO_WORKER_TYPE = "hello";

/** Served: greet a name and get the greeting back. */
export const HELLO_GREET = "hello.greet";
/** Served: read this worker's own counters. */
export const HELLO_STATS = "hello.stats";
/** Served: change the default name this worker greets with. */
export const HELLO_SET_DEFAULT = "hello.set-default-name";
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

/** What this worker saves between runs. Counters only — config is not state. */
interface PersistedState {
  greeted: number;
  recent_names: string[];
}

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
  /**
   * Where to keep durable state. Falls back to the injected `NIQ_STATE_DIR`.
   * With neither, the worker keeps state in memory only — it never invents a
   * directory, and a restart starts from zero.
   */
  stateDir?: string;
  /**
   * Injected by whoever composes this worker (an embedder, a host): persist a
   * patch to this worker's declaration. Absent means config edits are
   * process-only, which is the honest default — this worker does not go looking
   * for a host worker to write its config.
   */
  configPatcher?: (patch: ConfigPatch) => Promise<void> | void;
  /** Environment to consult for the connection and config. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export class HelloWorker {
  private readonly base: BaseWorker;
  private readonly stateDir: string;
  private readonly startedAt = Date.now();

  // ── State ──
  //
  // A worker is an actor: it owns state and only changes it while handling a
  // message. Keeping it as plain fields is enough; there is no shared store.
  // What survives a restart is decided by the caller: with a state directory the
  // counters are restored on start, without one they die with the process.
  private greeted = 0;
  private readonly recentNames: string[] = [];

  /** Config, not state: a declaration edit applies on the next start. */
  private defaultName: string;

  /** Handler promises, drained by {@link close} so shutdown is graceful. */
  private readonly work = new Set<Promise<void>>();

  /**
   * Tail of the state write chain. The store guarantees each write is atomic;
   * ORDER is the worker's job. Two greetings handled back to back would
   * otherwise race, and a slower older write could land last and roll the
   * counters back.
   */
  private persistTail: Promise<void> = Promise.resolve();

  constructor(opts: HelloWorkerOptions) {
    const env = opts.env ?? process.env;
    const conn = resolveConnection(opts, env);

    this.defaultName =
      opts.defaultName?.trim() || env[DEFAULT_NAME_ENV]?.trim() || "world";
    this.stateDir = opts.stateDir?.trim() || readStateDir(env);

    this.base = new BaseWorker({
      id: conn.workerID,
      // Subscriptions control BROADCAST delivery: the bus fans a broadcast out
      // to online workers whose subscriptions match. Directed sends (a peer
      // calling this worker by id) arrive regardless. Declaring the served
      // events here means a broadcast of `hello.greet` is handled too.
      subscriptions: [
        { type: HELLO_GREET },
        { type: HELLO_STATS },
        { type: HELLO_SET_DEFAULT },
      ],
      channel: new HTTPWorkerClient({
        baseURL: conn.baseURL,
        workerID: conn.workerID,
        credential: conn.credential,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
      // No directory and no NIQ_STATE_DIR means memory only: the SDK does not
      // pick a location on the worker's behalf.
      ...(this.stateDir ? { durableDir: this.stateDir } : {}),
    });

    // Config writes are the composing layer's job. An embedder can hand us one;
    // without it `patchConfig` reports ConfigUnavailable and we keep the change
    // for this process only.
    if (opts.configPatcher) this.base.setConfigPatcher(opts.configPatcher);

    this.registerCapabilities();
  }

  /** The bus identity this worker speaks as. */
  get id(): string {
    return this.base.id;
  }

  /** Where state is persisted, or `""` when this worker is memory-only. */
  get persistence(): string {
    return this.stateDir;
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
          state_mode: s.enumOf(
            ["persisted", "memory"],
            "Whether the counters survive a restart",
          ),
          state_dir: s.optional(
            s.string("Directory holding state.json; absent when memory-only"),
          ),
        }),
      },
      (evt) => this.track(this.handleStats(evt)),
    );

    // A config edit: change the default name. The declaration is not ours to
    // write — `patchConfig` forwards to whatever the composing layer injected,
    // and without one the change is process-only. Either way the caller is told
    // which happened, instead of the worker pretending it persisted something.
    this.base.register(
      {
        event: HELLO_SET_DEFAULT,
        description:
          "Change the name this worker greets with. Persists through the composing layer when one is present; otherwise it lasts for this process only.",
        parameters: s.object({
          name: s.string("New default name sent to nobody but this worker."),
        }),
        response: s.object({
          default_name: s.string("The name now in effect"),
          persisted: s.boolean(
            "True when a declaration writer saved it (applies on the next start)",
          ),
          note: s.string("What actually happened, in one sentence"),
        }),
      },
      (evt) => this.track(this.handleSetDefaultName(evt)),
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

    // Persist in the background: a slow disk must not delay the reply, and a
    // failed write must not fail the caller's request.
    this.track(this.persistState());

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
        // Whether those counters outlive this process. The directory rides along
        // only when there is one, so "memory" reads as a single fact.
        state_mode: this.base.hasDurableStore() ? "persisted" : "memory",
        ...(this.stateDir ? { state_dir: this.stateDir } : {}),
      },
      call.traceID,
    );
  }

  /**
   * Change the default name: apply it now, then ask the composing layer to save
   * it. Applying first is deliberate — a caller that just set a name expects the
   * next greeting to use it, whether or not a declaration store exists.
   */
  private async handleSetDefaultName(evt: Event): Promise<void> {
    const call = parseToolCall(evt);
    const name = argString(call.args, "name").trim();
    if (!name) {
      if (call.callID) {
        await this.base.replyFailed(call.callerID, call.callID, "name is required", call.traceID);
      }
      return;
    }

    this.defaultName = name;

    let persisted = false;
    let note: string;
    try {
      // MERGE patch: only this key changes; `null` would clear it instead.
      await this.base.patchConfig({ default_name: name });
      persisted = true;
      note = "saved to the declaration; applies on the next start (already in effect here)";
    } catch (err) {
      if (!(err instanceof ConfigUnavailableError)) {
        if (call.callID) {
          await this.base.replyFailed(
            call.callerID,
            call.callID,
            `could not save the new default name: ${(err as Error).message}`,
            call.traceID,
          );
        }
        return;
      }
      // No declaration writer was injected: keep the edit for this process and
      // say so. This is the same degradation a niq worker's `dial` performs.
      note = "no declaration writer was injected; this change lives in this process only";
    }

    if (call.callID) {
      await this.base.replyObject(
        call.callerID,
        call.callID,
        { default_name: name, persisted, note },
        call.traceID,
      );
    }
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
    // Restore before announcing, so the first `hello.stats` already reports the
    // counters that survived the last run.
    await this.restoreState();
    await this.base.channel.connect();
    await this.base.announceReady(HELLO_WORKER_TYPE, HELLO_PUBLISHES);

    for await (const evt of this.base.channel.events()) {
      this.base.dispatchExtension(evt);
    }
  }

  /** Drain in-flight handlers, then close the connection. */
  async close(): Promise<void> {
    // Handlers can schedule more work (a state write, for instance), so drain
    // until the set is empty instead of awaiting one snapshot of it.
    while (this.work.size > 0) {
      await Promise.allSettled([...this.work]);
    }
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

  // ── State ──
  //
  // Two lines of policy, spelled out because both are decisions rather than
  // mechanics: an unreadable snapshot is reported and then discarded (a worker
  // that refuses to start because of its own counters is worse than one that
  // starts from zero), and persistence is skipped silently when no store exists.

  private async restoreState(): Promise<void> {
    if (!this.base.hasDurableStore()) return;
    try {
      const st = await this.base.loadState<PersistedState>();
      if (!st) return;
      this.greeted = Number.isFinite(st.greeted) ? Math.max(0, st.greeted) : 0;
      const names = Array.isArray(st.recent_names) ? st.recent_names : [];
      this.recentNames.push(...names.slice(-RECENT_LIMIT).map(String));
    } catch (err) {
      console.error(`[hello] could not read saved state, starting fresh:`, err);
    }
  }

  private persistState(): Promise<void> {
    if (!this.base.hasDurableStore()) return Promise.resolve();
    // Snapshot now, write in order: the queued write must store the values as
    // they were when the event was handled, not whatever they became later.
    const snapshot: PersistedState = {
      greeted: this.greeted,
      recent_names: [...this.recentNames],
    };
    const write = this.persistTail.then(() => this.base.saveState(snapshot));
    this.persistTail = write.catch(() => {});
    return write;
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
      `Serves: \`${HELLO_GREET}\`, \`${HELLO_STATS}\`, \`${HELLO_SET_DEFAULT}\``,
      `Publishes: \`${HELLO_GREETED}\``,
      `Default name: \`${this.defaultName}\``,
      `Greeted so far: ${this.greeted}`,
      `State: ${this.base.hasDurableStore() ? `persisted in \`${this.stateDir}\`` : "in memory only (no state directory was offered)"}`,
      ``,
      `Try: \`hello.greet\` with \`{"name":"ada"}\`, then \`hello.stats\`,`,
      `then \`${HELLO_SET_DEFAULT}\` with \`{"name":"grace"}\`.`,
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
