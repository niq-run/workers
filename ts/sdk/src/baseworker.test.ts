import { describe, expect, it } from "vitest";
import { BaseWorker, argInt, argString, parseToolCall } from "./baseworker.js";
import type { Event, WorkerSideChannel } from "./types/index.js";
import { EventType } from "./types/index.js";

class FakeChannel implements WorkerSideChannel {
  readonly id = "fake";
  sent: Array<{ evt: Event; targets: string[] }> = [];
  broadcasts: Event[] = [];

  async connect(): Promise<void> {}
  async send(evt: Event, ...targets: string[]): Promise<void> {
    this.sent.push({ evt, targets });
  }
  async broadcast(evt: Event): Promise<void> {
    this.broadcasts.push(evt);
  }
  // eslint-disable-next-line require-yield
  async *events(): AsyncIterable<Event> {}
  async close(): Promise<void> {}
}

function makeEvent(overrides: Partial<Event>): Event {
  return {
    id: "evt-1",
    type: "tool.invoke",
    status: "created",
    payload: {},
    worker_id: "caller.0",
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function makeWorker(channel: FakeChannel): BaseWorker {
  return new BaseWorker({
    id: "echo.0",
    subscriptions: [{ type: "tool.invoke" }],
    channel,
  });
}

describe("extension registry", () => {
  it("dispatches by event type", async () => {
    const w = makeWorker(new FakeChannel());
    const seen: Event[] = [];
    w.register({ event: "tool.invoke" }, (evt) => {
      seen.push(evt);
    });

    const evt = makeEvent({});
    expect(w.dispatchExtension(evt)).toBe(true);
    expect(seen).toEqual([evt]);
  });

  it("multiplexes on keyField and replaces same-key registrations", () => {
    const w = makeWorker(new FakeChannel());
    const hits: string[] = [];
    w.register(
      { event: "tool.invoke", keyField: "name", key: "upper" },
      () => {
        hits.push("upper");
      },
    );
    w.register(
      { event: "tool.invoke", keyField: "name", key: "lower" },
      () => {
        hits.push("lower");
      },
    );
    // Re-registering the same (event, keyField, key) replaces it.
    w.register(
      { event: "tool.invoke", keyField: "name", key: "upper" },
      () => {
        hits.push("upper-2");
      },
    );

    expect(w.dispatchExtension(makeEvent({ payload: { name: "lower" } }))).toBe(
      true,
    );
    expect(w.dispatchExtension(makeEvent({ payload: { name: "upper" } }))).toBe(
      true,
    );
    // Wrong discriminator value: no handler matches.
    expect(
      w.dispatchExtension(makeEvent({ payload: { name: "other" } })),
    ).toBe(false);
    // Non-string discriminator value: no match.
    expect(w.dispatchExtension(makeEvent({ payload: { name: 42 } }))).toBe(
      false,
    );
    expect(hits).toEqual(["lower", "upper-2"]);
  });

  it("returns false when nothing matches", () => {
    const w = makeWorker(new FakeChannel());
    expect(w.dispatchExtension(makeEvent({ type: "other.event" }))).toBe(false);
  });

  it("renders watch entries, omitting selfOnly for peers", () => {
    const w = makeWorker(new FakeChannel());
    w.register(
      {
        event: "tool.invoke",
        keyField: "name",
        key: "echo",
        description: "Echo a message",
        parameters: { prefix: "..." },
      },
      () => {},
    );
    w.register(
      { event: "self.list_workers", selfOnly: true, description: "my view" },
      () => {},
    );

    expect(w.watchEntries(false)).toEqual([
      {
        event: "tool.invoke",
        desc: "Echo a message",
        parameters: { prefix: "...", name: "echo" },
      },
    ]);
    expect(w.watchEntries(true)).toHaveLength(2);
  });
});

describe("tool call parsing", () => {
  it("extracts common fields and defaults args to an empty object", () => {
    const evt = makeEvent({
      request_id: "req-7",
      trace_id: "trace-1",
      payload: { name: "echo", arguments: { text: "hi" } },
    });
    expect(parseToolCall(evt)).toEqual({
      callID: "req-7",
      name: "echo",
      callerID: "caller.0",
      args: { text: "hi" },
      traceID: "trace-1",
    });

    const bare = parseToolCall(makeEvent({ payload: {} }));
    expect(bare.callID).toBe("");
    expect(bare.name).toBe("");
    expect(bare.args).toEqual({});
  });

  it("reads scalar args with defaults", () => {
    const args = { s: "x", n: 2.9, gone: undefined } as Record<
      string,
      unknown
    >;
    expect(argString(args, "s")).toBe("x");
    expect(argString(args, "missing")).toBe("");
    expect(argInt(args, "n", 0)).toBe(2);
    expect(argInt(args, "gone", 5)).toBe(5);
  });
});

describe("replies", () => {
  it("replyCompleted sends request.completed echoing the request id", async () => {
    const ch = new FakeChannel();
    const w = makeWorker(ch);
    await w.replyCompleted("caller.0", "req-7", "echo", "ok", "trace-1");

    expect(ch.sent).toHaveLength(1);
    const { evt, targets } = ch.sent[0];
    expect(targets).toEqual(["caller.0"]);
    expect(evt.type).toBe(EventType.RequestCompleted);
    expect(evt.request_id).toBe("req-7");
    expect(evt.trace_id).toBe("trace-1");
    expect(evt.payload).toEqual({ name: "echo", result: "ok" });
  });

  it("replyFailed and replyRejected carry error / reason", async () => {
    const ch = new FakeChannel();
    const w = makeWorker(ch);
    await w.replyFailed("caller.0", "r", "echo", "boom");
    await w.replyRejected("caller.0", "r", "echo", "unsafe");

    expect(ch.sent.map((s) => s.evt.type)).toEqual([
      EventType.RequestFailed,
      EventType.RequestRejected,
    ]);
    expect(ch.sent[0].evt.payload).toEqual({ name: "echo", error: "boom" });
    expect(ch.sent[1].evt.payload).toEqual({ name: "echo", reason: "unsafe" });
  });

  it("replyUnknownTool answers with a request.failed naming the tool", async () => {
    const ch = new FakeChannel();
    const w = makeWorker(ch);
    await w.replyUnknownTool(parseToolCall(makeEvent({
      request_id: "req-9",
      trace_id: "t",
      payload: { name: "nope" },
    })));

    const { evt } = ch.sent[0];
    expect(evt.type).toBe(EventType.RequestFailed);
    expect(evt.request_id).toBe("req-9");
    expect(evt.payload).toEqual({ name: "nope", error: "unknown tool: nope" });
  });
});

describe("announceReady", () => {
  it("broadcasts worker.ready with the peer-facing contract, self excluded", async () => {
    const ch = new FakeChannel();
    const w = makeWorker(ch);
    w.register(
      { event: "tool.invoke", keyField: "name", key: "echo", description: "Echo" },
      () => {},
    );
    w.register(
      { event: "self.x", selfOnly: true, description: "hidden" },
      () => {},
    );

    await w.announceReady("echo", [{ event: "echo.done" }]);

    expect(ch.broadcasts).toHaveLength(1);
    const presence = ch.broadcasts[0];
    expect(presence.type).toBe(EventType.WorkerReady);
    expect(presence.exclude_worker_id).toBe("echo.0");
    expect(presence.payload).toEqual({
      worker_id: "echo.0",
      type: "echo",
      watch: [
        { event: "tool.invoke", desc: "Echo", parameters: { name: "echo" } },
      ],
      publishes: [{ event: "echo.done" }],
    });
  });

  it("omits publishes when empty", async () => {
    const ch = new FakeChannel();
    const w = makeWorker(ch);
    await w.announceReady("echo");
    expect("publishes" in ch.broadcasts[0].payload).toBe(false);
  });
});
