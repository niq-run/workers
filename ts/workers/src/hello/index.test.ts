import { describe, expect, it, vi } from "vitest";
import { HelloWorker } from "./index.js";

interface RecordedPublish {
  url: string;
  body: {
    worker_id: string;
    type: string;
    events: Array<{
      type: string;
      request_id?: string;
      exclude_worker_id?: string;
      payload: Record<string, unknown>;
    }>;
  };
}

/** Build a fake fetch that serves one SSE event then closes, recording publishes. */
function fakeBus(eventPayload: Record<string, unknown>, requestId?: string) {
  const publishes: RecordedPublish[] = [];

  const sseChunk = new TextEncoder().encode(
    `data: ${JSON.stringify({
      id: "evt-1",
      type: "hello.greet",
      status: "routed",
      payload: eventPayload,
      worker_id: "caller@bus",
      request_id: requestId,
      timestamp: Date.now(),
    })}\n\n`,
  );

  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sseChunk);
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (url.includes("/publish")) {
        publishes.push({
          url,
          body: JSON.parse(String(init?.body)) as RecordedPublish["body"],
        });
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  );

  return { fetchImpl, publishes };
}

function makeWorker(fetchImpl: typeof fetch): HelloWorker {
  return new HelloWorker({
    baseURL: "http://localhost:8080",
    workerID: "hello@me",
    credential: "secret",
    fetchImpl,
  });
}

describe("HelloWorker", () => {
  it("reads connection parameters from the environment when not passed explicitly", async () => {
    const { fetchImpl, publishes } = fakeBus({ name: "env" }, "req-env");
    const worker = new HelloWorker({
      fetchImpl,
      env: {
        NIQ_BUS_URL: "http://localhost:8080",
        NIQ_WORKER_ID: "hello@me",
        NIQ_WORKER_CREDENTIAL: "secret",
      },
    });

    await worker.run();
    await worker.close();

    const reply = publishes[1].body.events[0];
    expect(reply.request_id).toBe("req-env");
    expect(reply.payload).toEqual({ name: "greet", result: "hello, env!" });
    // The worker id comes from the environment too.
    expect(publishes[0].body.worker_id).toBe("hello@me");
  });

  it("throws a helpful error when neither options nor env provide the connection", () => {
    expect(() => new HelloWorker({ env: {} })).toThrow(/NIQ_BUS_URL/);
  });

  it("answers a greet request with a request.completed greeting", async () => {
    const { fetchImpl, publishes } = fakeBus({ name: "niq" }, "req-1");
    const worker = makeWorker(fetchImpl);

    await worker.run();
    await worker.close();

    // worker.ready broadcast on connect + directed request.completed reply.
    expect(publishes.map((p) => p.body.type)).toEqual(["broadcast", "send"]);
    expect(publishes[0].body.events[0].type).toBe("worker.ready");

    const reply = publishes[1].body.events[0];
    expect(reply.type).toBe("request.completed");
    expect(reply.request_id).toBe("req-1");
    expect(reply.payload).toEqual({ name: "greet", result: "hello, niq!" });
  });

  it("falls back to 'world' when the payload has no name", async () => {
    const { fetchImpl, publishes } = fakeBus({}, "req-2");
    const worker = makeWorker(fetchImpl);

    await worker.run();
    await worker.close();

    const reply = publishes[1].body.events[0];
    expect(reply.payload).toEqual({ name: "greet", result: "hello, world!" });
  });

  it("does not reply to notifications without a request_id", async () => {
    const { fetchImpl, publishes } = fakeBus({ name: "silent" });
    const worker = makeWorker(fetchImpl);

    await worker.run();
    await worker.close();

    expect(publishes.map((p) => p.body.type)).toEqual(["broadcast"]);
  });

  it("announces itself as type 'hello' with its watch entry, self excluded", async () => {
    const { fetchImpl, publishes } = fakeBus({}, "req-3");
    const worker = makeWorker(fetchImpl);

    await worker.run();
    await worker.close();

    const ready = publishes[0].body.events[0];
    expect(ready.type).toBe("worker.ready");
    expect(ready.exclude_worker_id).toBe("hello@me");
    expect(ready.payload).toEqual({
      worker_id: "hello@me",
      type: "hello",
      watch: [
        {
          event: "hello.greet",
          desc: "Greets the name in the payload (default: world).",
        },
      ],
    });
  });
});
