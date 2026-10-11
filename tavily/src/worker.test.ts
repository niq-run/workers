import { describe, expect, it, vi } from "vitest";
import type { TavilyClient, TavilyExtractOptions, TavilyExtractResponse, TavilySearchOptions, TavilySearchResponse } from "@tavily/core";
import { extractOptionsFrom, searchOptionsFrom, TavilyWorker } from "./worker.js";

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

const baseResp: TavilySearchResponse = {
  answer: "Answer text",
  query: "q",
  responseTime: 1,
  images: [],
  results: [
    { title: "A", url: "https://a", content: "c", score: 0.9, publishedDate: "", id: "1" },
    { title: "B", url: "https://b", content: "c", score: 0.8, publishedDate: "", id: "2" },
  ],
  requestId: "r1",
};

/** Fake Tavily client whose search() records calls and returns a controllable result. */
function stubClient(
  resp: Partial<TavilySearchResponse> = {},
  error?: Error,
): TavilyClient & { search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async (_query: string, _opts?: TavilySearchOptions) => {
    if (error) throw error;
    return { ...baseResp, ...resp };
  });
  return { search } as unknown as TavilyClient & { search: ReturnType<typeof vi.fn> };
}

const baseExtractResp: TavilyExtractResponse = {
  results: [{ url: "https://u", title: "Article Title", rawContent: "Extracted body text." }],
  failedResults: [],
  responseTime: 1,
  requestId: "e1",
};

/** Stub Tavily client for tests exercising extract(). */
function stubExtractClient(
  resp: Partial<TavilyExtractResponse> = {},
  error?: Error,
): TavilyClient & { extract: ReturnType<typeof vi.fn> } {
  const extract = vi.fn(async (_urls: string[], _opts?: TavilyExtractOptions) => {
    if (error) throw error;
    return { ...baseExtractResp, ...resp };
  });
  return { extract } as unknown as TavilyClient & { extract: ReturnType<typeof vi.fn> };
}

/** Build a fake fetch that serves one SSE event then closes, recording publishes. */
function fakeBus(eventType: string, eventPayload: Record<string, unknown>, requestId?: string) {
  const publishes: RecordedPublish[] = [];

  const sseChunk = new TextEncoder().encode(
    `data: ${JSON.stringify({
      id: "evt-1",
      type: eventType,
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

function makeWorker(
  fetchImpl: typeof fetch,
  client: TavilyClient,
): TavilyWorker {
  return new TavilyWorker({
    baseURL: "http://localhost:8080",
    workerID: "tavily@me",
    credential: "secret",
    client,
    fetchImpl,
  });
}

describe("TavilyWorker", () => {
  it("answers a tavily.search request with the answer + sources", async () => {
    const client = stubClient();
    const { fetchImpl, publishes } = fakeBus(
      "tavily.search",
      { query: "Who is Leo Messi?" },
      "req-1",
    );
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    expect(client.search).toHaveBeenCalledWith("Who is Leo Messi?", expect.anything());

    const reply = publishes.find((p) => p.body.type === "send")?.body.events[0];
    expect(reply?.type).toBe("request.completed");
    expect(reply?.request_id).toBe("req-1");
    expect(String(reply?.payload.result)).toContain("Answer text");
    expect(String(reply?.payload.result)).toContain("https://a");
    expect(String(reply?.payload.result)).toContain("https://b");
  });

  it("replies request.failed when the query is missing", async () => {
    const client = stubClient();
    const { fetchImpl, publishes } = fakeBus("tavily.search", {}, "req-2");
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    expect(client.search).not.toHaveBeenCalled();
    const reply = publishes.find((p) => p.body.type === "send")?.body.events[0];
    expect(reply?.type).toBe("request.failed");
    expect(String(reply?.payload.error)).toContain("query is required");
  });

  it("replies request.failed when the Tavily call errors", async () => {
    const client = stubClient({}, new Error("rate limited"));
    const { fetchImpl, publishes } = fakeBus(
      "tavily.search",
      { query: "q" },
      "req-3",
    );
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    const reply = publishes.find((p) => p.body.type === "send")?.body.events[0];
    expect(reply?.type).toBe("request.failed");
    expect(String(reply?.payload.error)).toContain("rate limited");
  });

  it("announces itself as type 'tavily' with its search entry", async () => {
    const client = stubClient();
    const { fetchImpl, publishes } = fakeBus("tavily.search", { query: "q" }, "req-4");
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    const ready = publishes[0].body.events[0];
    expect(ready.type).toBe("worker.ready");
    expect(ready.exclude_worker_id).toBe("tavily@me");
    const payload = ready.payload as unknown as Record<string, unknown>;
    expect(payload.type).toBe("tavily");
    const watch = payload.watch as Array<{ event: string }>;
    expect(watch[0].event).toBe("tavily.search");
  });

  it("requires TAVILY_API_KEY when no client is injected", () => {
    expect(
      () => new TavilyWorker({ baseURL: "x", workerID: "w", credential: "c", env: {} }),
    ).toThrow(/TAVILY_API_KEY/);
  });
});

describe("searchOptionsFrom", () => {
  it("maps numeric, string, boolean and array payload fields", () => {
    const opts = searchOptionsFrom({
      maxResults: 3,
      days: "7",
      topic: "news",
      includeAnswer: true,
      includeDomains: ["example.com"],
      bogus: 12,
    });
    expect(opts.maxResults).toBe(3);
    expect(opts.days).toBe(7);
    expect(opts.topic).toBe("news");
    expect(opts.includeAnswer).toBe(true);
    expect(opts.includeDomains).toEqual(["example.com"]);
    expect((opts as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe("TavilyWorker extract", () => {
  it("answers a tavily.extract request with title + content", async () => {
    const client = stubExtractClient() as TavilyClient;
    const { fetchImpl, publishes } = fakeBus("tavily.extract", { url: "https://u" }, "req-x1");
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    expect(client.extract).toHaveBeenCalledWith(["https://u"], expect.anything());
    const reply = publishes.find((p) => p.body.type === "send")?.body.events[0];
    expect(reply?.type).toBe("request.completed");
    expect(String(reply?.payload.result)).toContain("Article Title");
    expect(String(reply?.payload.result)).toContain("Extracted body");
  });

  it("replies request.failed when url is missing", async () => {
    const client = stubExtractClient() as TavilyClient;
    const { fetchImpl, publishes } = fakeBus("tavily.extract", {}, "req-x2");
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    expect(client.extract).not.toHaveBeenCalled();
    const reply = publishes.find((p) => p.body.type === "send")?.body.events[0];
    expect(reply?.type).toBe("request.failed");
    expect(String(reply?.payload.error)).toContain("url is required");
  });

  it("replies request.failed when the Tavily extract errors", async () => {
    const client = stubExtractClient({}, new Error("extract boom")) as TavilyClient;
    const { fetchImpl, publishes } = fakeBus("tavily.extract", { url: "https://u" }, "req-x3");
    const worker = makeWorker(fetchImpl, client);

    await worker.run();
    await worker.close();

    const reply = publishes.find((p) => p.body.type === "send")?.body.events[0];
    expect(reply?.type).toBe("request.failed");
    expect(String(reply?.payload.error)).toContain("extract boom");
  });
});

describe("extractOptionsFrom", () => {
  it("maps format/extractDepth strings and the includeImages boolean", () => {
    const opts = extractOptionsFrom({
      format: "markdown",
      extractDepth: "advanced",
      includeImages: true,
      bogus: 1,
    });
    expect(opts.format).toBe("markdown");
    expect(opts.extractDepth).toBe("advanced");
    expect(opts.includeImages).toBe(true);
    expect((opts as Record<string, unknown>).bogus).toBeUndefined();
  });
});