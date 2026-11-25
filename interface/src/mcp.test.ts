import { describe, expect, it } from "vitest";
import type { Event } from "@niq.run/worker-sdk";
import { runMcpServer, type McpServerOptions } from "./mcp.js";

const ENV = {
  NIQ_BUS_URL: "http://localhost:8080",
  NIQ_WORKER_ID: "mcp@test",
  NIQ_WORKER_CREDENTIAL: "secret",
};

function event(
  type: string,
  payload: Record<string, unknown> = {},
  extra: Partial<Event> = {},
): Event {
  return {
    id: `e-${Math.random().toString(16).slice(2)}`,
    type,
    status: "delivered",
    payload,
    worker_id: "peer",
    timestamp: Date.now(),
    ...extra,
  };
}

interface RecordedPublish {
  type: "send" | "broadcast";
  targets?: string[];
  events: Event[];
}

/** A fake bus: keeps the SSE open, records publishes, can emit on demand. */
function fakeBus(
  onPublish?: (body: RecordedPublish, emit: (evt: Event) => void) => void,
) {
  const publishes: RecordedPublish[] = [];
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let opened = 0;

  const emit = (evt: Event): void => {
    try {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
    } catch {
      /* stream already closed */
    }
  };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes("/events")) {
      opened += 1;
      let done = false;
      let local: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          local = c;
          controller = c;
        },
      });
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
        if (done) return;
        done = true;
        try {
          local?.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* already errored */
        }
      });
      return new Response(stream, { status: 200 });
    }
    if (url.includes("/publish")) {
      const body = JSON.parse(String(init?.body)) as RecordedPublish;
      publishes.push(body);
      onPublish?.(body, emit);
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }) as typeof fetch;

  return { fetchImpl, publishes, emit, opened: () => opened };
}

/** A controllable stream of stdin lines. */
function channel() {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  const wake = (): void => {
    const n = notify;
    notify = undefined;
    n?.();
  };

  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<string>> {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) return { value: next, done: false };
          if (ended) return { value: undefined as never, done: true };
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    }),
  };

  return {
    lines,
    push: (msg: unknown): void => {
      queue.push(typeof msg === "string" ? msg : JSON.stringify(msg));
      wake();
    },
    end: (): void => {
      ended = true;
      wake();
    },
  };
}

function harness(opts: { persistent?: boolean; bus?: ReturnType<typeof fakeBus> } = {}) {
  const bus = opts.bus ?? fakeBus();
  const ch = channel();
  const out: Record<string, any>[] = [];
  const err: string[] = [];

  const serverOpts: McpServerOptions = {
    mode: opts.persistent ? "persistent" : "one-shot",
    env: ENV,
    version: "9.9.9",
    fetchImpl: bus.fetchImpl,
    ...(opts.persistent
      ? {
          dial: {
            source: "test",
            busURL: ENV.NIQ_BUS_URL,
            workerID: ENV.NIQ_WORKER_ID,
            credential: ENV.NIQ_WORKER_CREDENTIAL,
          },
        }
      : {}),
  };

  const run = runMcpServer(serverOpts, {
    lines: ch.lines,
    write: (line) => out.push(JSON.parse(line) as Record<string, any>),
    err: (line) => err.push(line),
  });

  return {
    bus,
    ch,
    out,
    err,
    run,
    async finish(): Promise<void> {
      ch.end();
      await run;
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function call(
  h: ReturnType<typeof harness>,
  id: number,
  method: string,
  params?: unknown,
): Promise<Record<string, any>> {
  h.ch.push({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  await waitFor(() => h.out.some((r) => r.id === id));
  return h.out.find((r) => r.id === id)!;
}

async function tool(
  h: ReturnType<typeof harness>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const res = await call(h, id, "tools/call", { name, arguments: args });
  const result = res.result as Record<string, any>;
  // A successful object result carries the value in structuredContent; an error
  // result is just {content, isError}. Return the value when there is one.
  return (result.structuredContent as Record<string, any> | undefined) ?? result;
}

/**
 * Poll niq_status until the inbox cursor reaches `expected`. Events reach the
 * inbox asynchronously (SSE → session loop → pump), so a test that just emitted
 * one has to wait for that path rather than for the emit call.
 */
async function waitForCursor(
  h: ReturnType<typeof harness>,
  id: number,
  expected: number,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await tool(h, id + attempt, "niq_status", {});
    if ((status.inbox?.latest_cursor ?? 0) >= expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`inbox cursor did not reach ${expected}`);
}

describe("mcp: protocol", () => {
  it("answers initialize with tools capability and instructions", async () => {
    const h = harness();
    const res = await call(h, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });

    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result.serverInfo).toEqual({ name: "niq-interface", version: "9.9.9" });
    expect(String(res.result.instructions)).toContain("directed");
    await h.finish();
  });

  it("falls back to its own version when the client asks for an unknown one", async () => {
    const h = harness();
    const res = await call(h, 1, "initialize", { protocolVersion: "1999-01-01" });
    expect(res.result.protocolVersion).toBe("2025-06-18");
    await h.finish();
  });

  it("reports protocol errors for unknown methods, bad JSON and bad requests", async () => {
    const h = harness();
    h.ch.push("this is not json");
    const unknown = await call(h, 2, "resources/list");
    const bad = await call(h, 3, "tools/call", {});

    await waitFor(() => h.out.length >= 3);
    expect(h.out.find((r) => r.id === null)).toMatchObject({
      error: { code: -32700 },
    });
    expect(unknown.error.code).toBe(-32601);
    expect(bad.error.code).toBe(-32602);
    await h.finish();
  });

  it("ignores notifications (no id) and client responses", async () => {
    const h = harness();
    h.ch.push({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.ch.push({ jsonrpc: "2.0", id: 99, result: {} });
    // A real request proves the loop is alive and produced exactly one reply.
    const res = await call(h, 1, "ping");

    expect(res.result).toEqual({});
    await waitFor(() => h.out.length >= 1);
    expect(h.out).toHaveLength(1);
    await h.finish();
  });
});

describe("mcp: one-shot mode", () => {
  it("lists the one-shot tools and not the inbox", async () => {
    const h = harness();
    const res = await call(h, 1, "tools/list");

    const names = (res.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["niq_request", "niq_say", "niq_send", "niq_status"]);

    const status = (res.result.tools as any[]).find((t) => t.name === "niq_status");
    expect(status.annotations.readOnlyHint).toBe(true);
    await h.finish();
  });

  it("publishes a directed event and disconnects", async () => {
    const h = harness();
    const result = await tool(h, 1, "niq_send", {
      target: "reason.0",
      event: "ops.notice",
      payload: { text: "deploy done" },
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("one-shot");
    expect(result.disconnected).toBe(true);
    expect(h.bus.publishes).toHaveLength(1);
    expect(h.bus.publishes[0].type).toBe("send");
    expect(h.bus.publishes[0].targets).toEqual(["reason.0"]);
    expect(h.bus.publishes[0].events[0]).toMatchObject({
      type: "ops.notice",
      payload: { text: "deploy done" },
    });
    await h.finish();
  });

  it("rejects a send without a target as a tool error", async () => {
    const h = harness();
    const result = await tool(h, 1, "niq_send", { event: "ops.notice" });

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("target is required");
    expect(h.bus.publishes).toEqual([]);
    await h.finish();
  });

  it("waits for the correlated reply on niq_request", async () => {
    const bus = fakeBus((body, emit) => {
      emit(
        event(
          "request.completed",
          { result: "pong" },
          { worker_id: "peer", request_id: body.events[0].request_id },
        ),
      );
    });
    const h = harness({ bus });

    const result = await tool(h, 1, "niq_request", {
      target: "peer",
      event: "ping.tool",
      timeout_ms: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.request_id).toBeTruthy();
    expect(result.reply.payload).toEqual({ result: "pong" });
    await h.finish();
  });

  it("surfaces a failed reply as a tool error carrying the reply", async () => {
    const bus = fakeBus((body, emit) => {
      emit(
        event(
          "request.failed",
          { error: "no such tool" },
          { worker_id: "peer", request_id: body.events[0].request_id },
        ),
      );
    });
    const h = harness({ bus });

    const result = await tool(h, 1, "niq_request", {
      target: "peer",
      event: "missing.tool",
      timeout_ms: 1_000,
    });

    expect(result.isError).toBe(true);
    const text = String(result.content[0].text);
    expect(text).toContain("no such tool");
    expect(text).toContain("request.failed");
    await h.finish();
  });

  it("rejects an unknown tool without crashing the loop", async () => {
    const h = harness();
    const result = await tool(h, 1, "niq_inbox");
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("unknown tool");

    // The loop still answers.
    expect((await call(h, 2, "ping")).result).toEqual({});
    await h.finish();
  });
});

describe("mcp: persistent mode", () => {
  it("lists niq_inbox and explains the polling contract", async () => {
    const h = harness({ persistent: true });
    const init = await call(h, 1, "initialize", { protocolVersion: "2025-06-18" });
    const list = await call(h, 2, "tools/list");

    expect(String(init.result.instructions)).toContain("next_cursor");
    const names = (list.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("niq_inbox");
    await h.finish();
  });

  it("holds one session across calls and buffers inbound events", async () => {
    const h = harness({ persistent: true });
    await call(h, 1, "initialize", {});

    await tool(h, 2, "niq_send", { target: "peer", event: "ops.notice" });
    await tool(h, 3, "niq_send", { target: "peer", event: "ops.notice" });
    // Two sends, still a single dial: the session is reused.
    expect(h.bus.opened()).toBe(1);

    h.bus.emit(event("reason.delta", { text: "hi" }, { worker_id: "reason.0" }));
    await waitFor(() => h.bus.publishes.length === 2);
    await waitForCursor(h, 40, 1);

    const inbox = await tool(h, 4, "niq_inbox", {});
    expect(inbox.session).toBe("connected");
    expect(inbox.events).toHaveLength(1);
    expect(inbox.events[0]).toMatchObject({
      type: "reason.delta",
      worker_id: "reason.0",
    });
    expect(inbox.next_cursor).toBe(1);

    // Reading again from the returned cursor yields nothing new.
    const again = await tool(h, 5, "niq_inbox", { cursor: inbox.next_cursor });
    expect(again.events).toEqual([]);
    expect(again.next_cursor).toBe(1);
    await h.finish();
  });

  it("blocks in niq_inbox until an event arrives", async () => {
    const h = harness({ persistent: true });
    await call(h, 1, "initialize", {});

    h.ch.push({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "niq_inbox", arguments: { wait_ms: 2_000 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.bus.emit(event("late.event"));

    await waitFor(() => h.out.some((r) => r.id === 2));
    const envelope = h.out.find((r) => r.id === 2)!.result;
    const result = envelope.structuredContent ?? envelope;
    expect(result.events.map((e: Event) => e.type)).toEqual(["late.event"]);
    await h.finish();
  });

  it("filters the inbox by type and reports status", async () => {
    const h = harness({ persistent: true });
    await call(h, 1, "initialize", {});

    h.bus.emit(event("reason.delta", {}, { worker_id: "reason.0" }));
    h.bus.emit(event("worker.ready", {}, { worker_id: "other" }));
    await waitForCursor(h, 40, 2);

    const filtered = await tool(h, 2, "niq_inbox", { types: ["reason.*"] });
    expect(filtered.events.map((e: Event) => e.type)).toEqual(["reason.delta"]);

    const status = await tool(h, 3, "niq_status", {});
    expect(status).toMatchObject({
      mode: "persistent",
      connected: true,
      source: "test",
      worker_id: "mcp@test",
    });
    expect(status.inbox.latest_cursor).toBe(2);
    await h.finish();
  });

  it("refuses a call that asks for a different identity", async () => {
    const h = harness({ persistent: true });
    await call(h, 1, "initialize", {});

    const result = await tool(h, 2, "niq_send", {
      target: "peer",
      event: "ops.notice",
      source: "another",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("holds one session");
    await h.finish();
  });
});
