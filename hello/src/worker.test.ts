import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NAME_ENV,
  HELLO_GREET,
  HELLO_GREETED,
  HELLO_SET_DEFAULT,
  HELLO_STATS,
  HelloWorker,
} from "./worker.js";

interface RecordedEvent {
  type: string;
  request_id?: string;
  exclude_worker_id?: string;
  transient?: boolean;
  payload: Record<string, unknown>;
}

interface RecordedPublish {
  url: string;
  body: { worker_id: string; type: "send" | "broadcast"; events: RecordedEvent[] };
}

interface Incoming {
  type: string;
  payload?: Record<string, unknown>;
  /** Present for a request; omit for a notification. */
  requestId?: string;
  /** Stamped by the bus; defaults to `caller@bus`. */
  workerID?: string;
}

interface FakeBusOptions {
  /** Return false to make the bus reject a publish (exercises best-effort paths). */
  accept?: (evt: RecordedEvent) => boolean;
}

/**
 * A fake bus: serves the given events as one SSE stream, then closes it, and
 * records every `/publish`. This exercises the real SDK client end to end
 * without a live bus — the pattern every worker's tests use.
 */
function fakeBus(incoming: Incoming[] = [], opts: FakeBusOptions = {}) {
  const publishes: RecordedPublish[] = [];
  const encoder = new TextEncoder();

  const sse = incoming
    .map((evt, i) =>
      `data: ${JSON.stringify({
        id: `evt-${i + 1}`,
        type: evt.type,
        status: "routed",
        payload: evt.payload ?? {},
        worker_id: evt.workerID ?? "caller@bus",
        ...(evt.requestId ? { request_id: evt.requestId } : {}),
        timestamp: Date.now(),
      })}\n\n`,
    )
    .join("");

  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (url.includes("/publish")) {
        const body = JSON.parse(String(init?.body)) as RecordedPublish["body"];
        const rejected = (opts.accept ? body.events : []).filter((e) => !opts.accept!(e));
        if (rejected.length > 0) {
          return new Response("rejected", { status: 500 });
        }
        publishes.push({ url, body });
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  );

  return { fetchImpl, publishes };
}

function makeWorker(
  fetchImpl: typeof fetch,
  over: Partial<ConstructorParameters<typeof HelloWorker>[0]> = {},
): HelloWorker {
  return new HelloWorker({
    baseURL: "http://localhost:8080",
    workerID: "hello@me",
    credential: "secret",
    env: {},
    fetchImpl,
    ...over,
  });
}

/** All events published with the given kind, in order. */
function published(publishes: RecordedPublish[], kind: "send" | "broadcast"): RecordedEvent[] {
  return publishes.filter((p) => p.body.type === kind).flatMap((p) => p.body.events);
}

/** Run to the end of the stream, then drain handlers. */
async function run(worker: HelloWorker): Promise<void> {
  await worker.run();
  await worker.close();
}

describe("HelloWorker", () => {
  it("reads the connection from the environment when not passed explicitly", async () => {
    const { fetchImpl, publishes } = fakeBus();
    const worker = new HelloWorker({
      env: {
        NIQ_BUS_URL: "http://localhost:8080",
        NIQ_WORKER_ID: "hello@env",
        NIQ_WORKER_CREDENTIAL: "secret",
      },
      fetchImpl,
    });

    await run(worker);

    expect(worker.id).toBe("hello@env");
    expect(publishes[0].body.worker_id).toBe("hello@env");
  });

  it("throws a helpful error when nothing provides the connection", () => {
    expect(() => new HelloWorker({ env: {} })).toThrow(/NIQ_BUS_URL/);
  });

  it("answers hello.greet with a request.completed greeting", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_GREET, payload: { name: "niq" }, requestId: "req-1" },
    ]);

    await run(makeWorker(fetchImpl));

    // Presence first, then the broadcast, then the reply.
    expect(publishes.map((p) => p.body.type)).toEqual(["broadcast", "broadcast", "send"]);
    expect(published(publishes, "broadcast")[0].type).toBe("worker.ready");

    const reply = published(publishes, "send")[0];
    expect(reply.type).toBe("request.completed");
    expect(reply.request_id).toBe("req-1");
    expect(reply.payload).toEqual({ result: "hello, niq!" });
  });

  it("falls back to the configured default name", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_GREET, payload: {}, requestId: "req-1" },
    ]);

    await run(makeWorker(fetchImpl, { defaultName: "ada" }));

    expect(published(publishes, "send")[0].payload).toEqual({ result: "hello, ada!" });
  });

  it("reads the default name from HELLO_DEFAULT_NAME, with the option winning over it", async () => {
    const fromEnv = fakeBus([{ type: HELLO_GREET, payload: {}, requestId: "r" }]);
    await run(makeWorker(fromEnv.fetchImpl, { env: { [DEFAULT_NAME_ENV]: "grace" } }));
    expect(published(fromEnv.publishes, "send")[0].payload).toEqual({
      result: "hello, grace!",
    });

    const fromOption = fakeBus([{ type: HELLO_GREET, payload: {}, requestId: "r" }]);
    await run(
      makeWorker(fromOption.fetchImpl, {
        env: { [DEFAULT_NAME_ENV]: "grace" },
        defaultName: "ada",
      }),
    );
    expect(published(fromOption.publishes, "send")[0].payload).toEqual({
      result: "hello, ada!",
    });
  });

  it("broadcasts hello.greeted for every greeting", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_GREET, payload: { name: "ada" }, requestId: "req-1" },
    ]);

    await run(makeWorker(fetchImpl));

    const greeted = published(publishes, "broadcast").find((e) => e.type === HELLO_GREETED);
    expect(greeted?.payload).toEqual({ name: "ada", greeting: "hello, ada!" });
  });

  it("treats a call without a request id as a notification", async () => {
    const { fetchImpl, publishes } = fakeBus([
      // No requestId: notification — work happens, nobody is answered.
      { type: HELLO_GREET, payload: { name: "silent" } },
      { type: HELLO_STATS, payload: {}, requestId: "req-stats" },
    ]);

    await run(makeWorker(fetchImpl));

    const sends = published(publishes, "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].request_id).toBe("req-stats");
    // The notification still counted.
    expect(sends[0].payload).toMatchObject({ greeted: 1, names: ["silent"] });
  });

  it("answers hello.stats with a structured object reply", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_GREET, payload: { name: "ada" }, requestId: "1" },
      { type: HELLO_GREET, payload: {}, requestId: "2" },
      { type: HELLO_STATS, payload: {}, requestId: "req-stats" },
    ]);

    await run(makeWorker(fetchImpl, { defaultName: "world" }));

    const stats = published(publishes, "send").find((e) => e.request_id === "req-stats");
    expect(stats?.payload).toMatchObject({
      greeted: 2,
      names: ["ada", "world"],
      default_name: "world",
    });
    expect(typeof stats?.payload.uptime_ms).toBe("number");
  });

  it("announces itself as type 'hello' with its contract, self excluded", async () => {
    const { fetchImpl, publishes } = fakeBus();

    await run(makeWorker(fetchImpl));

    const ready = published(publishes, "broadcast")[0];
    expect(ready.type).toBe("worker.ready");
    expect(ready.exclude_worker_id).toBe("hello@me");
    expect(ready.transient).toBe(true);

    const payload = ready.payload as {
      type: string;
      watch: {
        event: string;
        desc: string;
        parameters?: { properties?: Record<string, unknown> };
        response?: { type: string };
      }[];
      publishes: { type: string; description: string }[];
    };
    expect(payload.type).toBe("hello");
    expect(payload.publishes).toEqual([
      { type: HELLO_GREETED, description: "A greeting was produced (broadcast, fire-and-forget)" },
    ]);
    const served = payload.watch.map((w) => w.event);
    expect(served).toContain(HELLO_GREET);
    expect(served).toContain(HELLO_STATS);
    // The watch entry carries the declared schema, so peers see the contract.
    const greet = payload.watch.find((w) => w.event === HELLO_GREET);
    expect(greet?.parameters?.properties).toHaveProperty("name");
    expect(greet?.response?.type).toBe("string");
  });

  it("answers worker.readme with a live usage guide", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: "worker.readme", requestId: "req-readme" },
    ]);

    await run(makeWorker(fetchImpl));

    const reply = published(publishes, "send")[0];
    expect(reply.request_id).toBe("req-readme");
    expect(String(reply.payload.result)).toContain("# hello — a reference niq worker");
    expect(String(reply.payload.result)).toContain(HELLO_GREET);
  });

  it("answers worker.help with the custom guide when its params match", async () => {
    const { fetchImpl, publishes } = fakeBus([
      {
        type: "worker.help",
        payload: { event_name: HELLO_GREET, params: { examples: true } },
        requestId: "req-help",
      },
    ]);

    await run(makeWorker(fetchImpl));

    const reply = published(publishes, "send")[0];
    expect(reply.request_id).toBe("req-help");
    expect(String(reply.payload.result)).toContain("hello.greet examples");
  });

  it("does not let a failed broadcast fail the caller's request", async () => {
    const { fetchImpl, publishes } = fakeBus(
      [{ type: HELLO_GREET, payload: { name: "ada" }, requestId: "req-1" }],
      { accept: (evt) => evt.type !== HELLO_GREETED },
    );

    await run(makeWorker(fetchImpl));

    // The broadcast was rejected, but the reply still went out.
    const sends = published(publishes, "send");
    expect(sends[0].payload).toEqual({ result: "hello, ada!" });
  });
});

describe("durable state", () => {
  it("is memory-only when no state directory is offered", async () => {
    const { fetchImpl, publishes } = fakeBus([{ type: HELLO_STATS, requestId: "s" }]);

    const worker = makeWorker(fetchImpl);
    expect(worker.persistence).toBe("");
    await run(worker);

    expect(published(publishes, "send")[0].payload).toMatchObject({
      greeted: 0,
      state_mode: "memory",
    });
    expect(published(publishes, "send")[0].payload).not.toHaveProperty("state_dir");
  });

  it("restores counters from the directory the caller passed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-state-"));

    const first = fakeBus([
      { type: HELLO_GREET, payload: { name: "ada" }, requestId: "1" },
      { type: HELLO_GREET, payload: { name: "grace" }, requestId: "2" },
    ]);
    await run(makeWorker(first.fetchImpl, { stateDir: dir }));

    // A fresh process (new worker, same directory) picks up where it left off.
    const second = fakeBus([{ type: HELLO_STATS, requestId: "s" }]);
    const restarted = makeWorker(second.fetchImpl, { stateDir: dir });
    expect(restarted.persistence).toBe(dir);
    await run(restarted);

    expect(published(second.publishes, "send")[0].payload).toMatchObject({
      greeted: 2,
      names: ["ada", "grace"],
      state_mode: "persisted",
      state_dir: dir,
    });
  });

  it("reads the directory from NIQ_STATE_DIR when no option is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-env-state-"));

    const first = fakeBus([{ type: HELLO_GREET, payload: { name: "env" }, requestId: "1" }]);
    await run(makeWorker(first.fetchImpl, { env: { NIQ_STATE_DIR: dir } }));

    const second = fakeBus([{ type: HELLO_STATS, requestId: "s" }]);
    await run(makeWorker(second.fetchImpl, { env: { NIQ_STATE_DIR: dir } }));

    expect(published(second.publishes, "send")[0].payload).toMatchObject({
      greeted: 1,
      names: ["env"],
    });
  });

  it("starts fresh, and says so, when the saved snapshot is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-bad-state-"));
    await writeFile(join(dir, "state.json"), "{not json", "utf8");

    const { fetchImpl, publishes } = fakeBus([{ type: HELLO_STATS, requestId: "s" }]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run(makeWorker(fetchImpl, { stateDir: dir }));
      // Assert before restoring: mockRestore() also drops the call history.
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }

    expect(published(publishes, "send")[0].payload).toMatchObject({ greeted: 0 });
  });
});

describe("config patch", () => {
  it("applies the new default name even with no writer, and reports it was not saved", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_SET_DEFAULT, payload: { name: "grace" }, requestId: "set" },
      { type: HELLO_GREET, payload: {}, requestId: "greet" },
    ]);

    await run(makeWorker(fetchImpl));

    const sends = published(publishes, "send");
    const edit = sends.find((e) => e.request_id === "set");
    expect(edit?.payload).toMatchObject({ default_name: "grace", persisted: false });
    expect(String(edit?.payload.note)).toContain("this process only");
    // The change is in effect immediately, regardless of persistence.
    expect(sends.find((e) => e.request_id === "greet")?.payload).toEqual({
      result: "hello, grace!",
    });
  });

  it("forwards a merge patch to the injected writer and reports it was saved", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_SET_DEFAULT, payload: { name: "ada" }, requestId: "set" },
    ]);
    const patches: Record<string, unknown>[] = [];

    await run(
      makeWorker(fetchImpl, {
        configPatcher: (patch) => {
          patches.push(patch as Record<string, unknown>);
        },
      }),
    );

    expect(patches).toEqual([{ default_name: "ada" }]);
    expect(published(publishes, "send")[0].payload).toMatchObject({
      default_name: "ada",
      persisted: true,
    });
  });

  it("reports a writer failure instead of silently keeping the change", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_SET_DEFAULT, payload: { name: "ada" }, requestId: "set" },
    ]);

    await run(
      makeWorker(fetchImpl, {
        configPatcher: () => {
          throw new Error("declaration store is read-only");
        },
      }),
    );

    const reply = published(publishes, "send")[0];
    expect(reply.type).toBe("request.failed");
    expect(JSON.stringify(reply.payload)).toContain("read-only");
  });

  it("rejects an empty name", async () => {
    const { fetchImpl, publishes } = fakeBus([
      { type: HELLO_SET_DEFAULT, payload: {}, requestId: "set" },
    ]);

    await run(makeWorker(fetchImpl));

    expect(published(publishes, "send")[0].type).toBe("request.failed");
  });
});
