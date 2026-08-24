import { describe, expect, it, vi } from "vitest";
import { FeishuWorker, type FeishuSender } from "./index.js";

interface RecordedPublish {
  url: string;
  body: {
    worker_id: string;
    type: string;
    events: Array<{ type: string; payload: Record<string, unknown> }>;
  };
}

/** Build a fake fetch that serves one SSE event then closes, recording publishes. */
function fakeBus(eventPayload: Record<string, unknown>, eventType: string) {
  const publishes: RecordedPublish[] = [];

  const sseChunk = new TextEncoder().encode(
    `data: ${JSON.stringify({
      id: "evt-1",
      type: eventType,
      status: "routed",
      payload: eventPayload,
      worker_id: "source@bus",
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

describe("FeishuWorker", () => {
  it("sends payloads to the Feishu sender and publishes a delivered event", async () => {
    const sender: FeishuSender = vi.fn(async () => "msg-42");
    const { fetchImpl, publishes } = fakeBus({ text: "hello" }, "feishu.send");

    const worker = new FeishuWorker({
      baseURL: "http://localhost:8080",
      workerID: "feishu@me",
      credential: "secret",
      fetchImpl,
      sender,
    });

    await worker.run();
    await worker.close();

    expect(sender).toHaveBeenCalledWith({ text: "hello" });

    const broadcast = publishes.filter((p) => p.body.type === "broadcast");
    // worker.ready on connect + feishu.delivered on completion
    expect(broadcast.map((p) => p.body.events[0].type)).toEqual([
      "worker.ready",
      "feishu.delivered",
    ]);
    expect(broadcast[1].body.events[0].payload).toEqual({
      ref: "evt-1",
      message_id: "msg-42",
    });
  });

  it("publishes a failed event when the sender throws", async () => {
    const sender: FeishuSender = vi.fn(async () => {
      throw new Error("feishu api down");
    });
    const { fetchImpl, publishes } = fakeBus({ text: "hi" }, "feishu.send");

    const worker = new FeishuWorker({
      baseURL: "http://localhost:8080",
      workerID: "feishu@me",
      credential: "secret",
      fetchImpl,
      sender,
    });

    await worker.run();
    await worker.close();

    const broadcast = publishes.filter((p) => p.body.type === "broadcast");
    expect(broadcast.map((p) => p.body.events[0].type)).toEqual([
      "worker.ready",
      "feishu.failed",
    ]);
    expect(broadcast[1].body.events[0].payload).toEqual({
      ref: "evt-1",
      error: "feishu api down",
    });
  });
});
