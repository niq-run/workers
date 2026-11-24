import { describe, expect, it } from "vitest";
import { matchesType, type Event } from "@niq.run/worker-sdk";
import {
  listen,
  ping,
  previewEvent,
  publish,
  request,
  type BusDial,
} from "./bus.js";

const dial: BusDial = {
  source: "test",
  busURL: "http://bus:1",
  workerID: "cli.test",
  credential: "tok",
};

interface RecordedPublish {
  worker_id: string;
  credential: string;
  type: "send" | "broadcast";
  events: Event[];
  targets?: string[];
}

interface FakeBusOptions {
  events?: Event[];
  keepOpen?: boolean;
  eventsStatus?: number;
  eventsBody?: string;
  publishStatus?: number;
  onPublish?: (body: RecordedPublish, emit: (evt: Event) => void) => void;
}

/** A fake HTTP bus: SSE stream plus recording /publish endpoint. */
function fakeBus(opts: FakeBusOptions = {}) {
  const publishes: RecordedPublish[] = [];
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamDone = false;

  const emit = (evt: Event): void => {
    if (streamDone) return;
    try {
      controller?.enqueue(
        encoder.encode(`data: ${JSON.stringify(evt)}\n\n`),
      );
    } catch {
      // stream already closed/errored
    }
  };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);

    if (url.includes("/events")) {
      if (opts.eventsStatus && opts.eventsStatus !== 200) {
        return new Response(opts.eventsBody ?? "no", {
          status: opts.eventsStatus,
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const evt of opts.events ?? []) emit(evt);
          if (!opts.keepOpen) {
            streamDone = true;
            c.close();
          }
        },
      });
      init?.signal?.addEventListener("abort", () => {
        if (streamDone) return;
        streamDone = true;
        try {
          controller?.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      });
      return new Response(stream, { status: 200 });
    }

    if (url.includes("/publish")) {
      const body = JSON.parse(String(init?.body)) as RecordedPublish;
      publishes.push(body);
      if (opts.publishStatus && opts.publishStatus !== 200) {
        return new Response("denied", { status: opts.publishStatus });
      }
      opts.onPublish?.(body, emit);
      return new Response("ok", { status: 200 });
    }

    throw new Error(`unexpected url: ${url}`);
  }) as typeof fetch;

  return { fetchImpl, publishes };
}

function event(
  type: string,
  payload: Record<string, unknown> = {},
  extra: Partial<Event> = {},
): Event {
  return {
    id: `evt-${Math.random().toString(16).slice(2)}`,
    type,
    status: "routed",
    payload,
    worker_id: "peer",
    timestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

describe("publish", () => {
  it("refuses to publish without a target (broadcast is disabled)", async () => {
    const { fetchImpl, publishes } = fakeBus();

    await expect(
      publish(
        dial,
        { type: "stats.heartbeat", payload: { uptime: 42 }, targets: [] },
        { fetchImpl },
      ),
    ).rejects.toThrow(/broadcast is disabled|at least one target/);

    expect(publishes).toHaveLength(0);
  });

  it("sends directed with targets and a trace id", async () => {
    const { fetchImpl, publishes } = fakeBus();
    const out = await publish(
      dial,
      {
        type: "worker.input",
        payload: { text: "hi" },
        targets: ["reason.0", "reason.0"],
        traceID: "tr-1",
      },
      { fetchImpl },
    );

    expect(out.targets).toEqual(["reason.0"]);
    expect(publishes[0].type).toBe("send");
    expect(publishes[0].targets).toEqual(["reason.0"]);
    expect(publishes[0].events[0].trace_id).toBe("tr-1");
  });

  it("explains a 401 handshake with the bus error body", async () => {
    const { fetchImpl } = fakeBus({
      eventsStatus: 401,
      eventsBody: JSON.stringify({ error: "expired", message: "token expired" }),
    });

    await expect(
      publish(dial, { type: "x", payload: {}, targets: ["peer"] }, { fetchImpl }),
    ).rejects.toThrow(/authentication.*token expired/s);
  });

  it("explains a publish ACL rejection", async () => {
    const { fetchImpl } = fakeBus({ publishStatus: 403 });
    await expect(
      publish(
        dial,
        { type: "secret.event", payload: {}, targets: ["peer"] },
        { fetchImpl },
      ),
    ).rejects.toThrow(/refused publishing secret\.event.*publish permission/s);
  });
});

describe("previewEvent", () => {
  it("stamps the identity without dialling", () => {
    const evt = previewEvent(dial, {
      type: "x.y",
      payload: { a: 1 },
      traceID: "t",
    });
    expect(evt.worker_id).toBe("cli.test");
    expect(evt.trace_id).toBe("t");
    expect(evt.payload).toEqual({ a: 1 });
    expect(evt.id).toBeTruthy();
    expect(evt.timestamp).toBeGreaterThan(0);
  });
});

describe("request", () => {
  it("correlates the matching reply and ignores unrelated events", async () => {
    const { fetchImpl, publishes } = fakeBus({
      keepOpen: true,
      onPublish: (body, emit) => {
        const requestID = body.events[0].request_id;
        emit(event("request.completed", { result: "wrong" }, { request_id: "other" }));
        emit(event("reason.response", { text: "chatter" }));
        emit(
          event(
            "request.completed",
            { result: "hello, niq!" },
            { request_id: requestID, worker_id: "hello@bus" },
          ),
        );
      },
    });

    const outcome = await request(
      dial,
      {
        type: "hello.greet",
        payload: { name: "niq" },
        target: "hello@bus",
        timeoutMs: 1000,
      },
      { fetchImpl },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.reply.payload).toEqual({ result: "hello, niq!" });
    expect(outcome.requestID).toBe(publishes[0].events[0].request_id);
    expect(publishes[0].type).toBe("send");
    expect(publishes[0].targets).toEqual(["hello@bus"]);
    expect(publishes[0].events[0].trace_id).toBeTruthy();
  });

  it("returns request.failed as a non-ok outcome with its message", async () => {
    const { fetchImpl } = fakeBus({
      keepOpen: true,
      onPublish: (body, emit) => {
        emit(
          event(
            "request.failed",
            { error: "no such tool" },
            { request_id: body.events[0].request_id },
          ),
        );
      },
    });

    const outcome = await request(
      dial,
      { type: "tool.invoke", payload: {}, target: "peer", timeoutMs: 1000 },
      { fetchImpl },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("no such tool");
  });

  it("times out when no reply arrives, after publishing", async () => {
    const { fetchImpl, publishes } = fakeBus({ keepOpen: true });

    await expect(
      request(
        dial,
        { type: "slow.tool", payload: {}, target: "peer", timeoutMs: 40 },
        { fetchImpl },
      ),
    ).rejects.toThrow(/timed out after 40ms waiting for peer/);

    expect(publishes).toHaveLength(1);
  });
});

describe("listen", () => {
  it("streams matching events and stops at --max", async () => {
    const { fetchImpl } = fakeBus({
      keepOpen: true,
      events: [
        event("worker.ready", {}, { worker_id: "reason.0" }),
        event("other.event", {}, { worker_id: "x" }),
        event("reason.response", { text: "hi" }, { worker_id: "reason.0" }),
        event("reason.response", { text: "again" }, { worker_id: "reason.0" }),
      ],
    });

    const seen: Event[] = [];
    let ready = false;
    const outcome = await listen(
      dial,
      {
        types: ["reason.*"],
        from: ["reason.0"],
        max: 2,
        onReady: () => {
          ready = true;
        },
        onEvent: (evt) => seen.push(evt),
      },
      { fetchImpl },
    );

    expect(ready).toBe(true);
    expect(outcome).toEqual({ received: 2, stop: "max" });
    expect(seen.map((e) => e.payload.text)).toEqual(["hi", "again"]);
  });

  it("stops on timeout", async () => {
    const { fetchImpl } = fakeBus({ keepOpen: true });
    const outcome = await listen(
      dial,
      { timeoutMs: 30, onEvent: () => {} },
      { fetchImpl },
    );
    expect(outcome).toEqual({ received: 0, stop: "timeout" });
  });

  it("stops on an abort signal", async () => {
    const { fetchImpl } = fakeBus({ keepOpen: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const outcome = await listen(
      dial,
      { signal: ac.signal, onEvent: () => {} },
      { fetchImpl },
    );
    expect(outcome).toEqual({ received: 0, stop: "abort" });
  });
});

describe("matchesType", () => {
  it("mirrors the bus's exact / * / prefix.* semantics", () => {
    expect(matchesType("*", "anything")).toBe(true);
    expect(matchesType("worker.input", "worker.input")).toBe(true);
    expect(matchesType("worker.input", "worker.input.x")).toBe(false);
    expect(matchesType("reason.*", "reason.response")).toBe(true);
    expect(matchesType("reason.*", "reason")).toBe(true);
    expect(matchesType("reason.*", "reasons.other")).toBe(false);
  });
});

describe("ping", () => {
  it("opens and closes one stream", async () => {
    const { fetchImpl } = fakeBus({ keepOpen: true });
    await expect(ping(dial, { fetchImpl })).resolves.toBeGreaterThanOrEqual(0);
  });

  it("times out a handshake that never resolves", async () => {
    const fetchImpl = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof fetch;

    await expect(
      ping(dial, { fetchImpl, connectTimeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});
