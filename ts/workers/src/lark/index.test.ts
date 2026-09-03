import { describe, expect, it, vi } from "vitest";
import {
  LarkWorker,
  larkConfigFromEnv,
  LARK_REASON_SET,
  LARK_REASON_UNSET,
  LARK_REASON_GET,
  type LarkChannel,
  type LarkStateStore,
} from "./index.js";
import type { Event, WorkerSideChannel } from "@niq.run/worker-sdk";

function eventSink() {
  const queue: Event[] = [];
  let done = false;
  let waiting: (() => void) | null = null;
  const push = (e: Event) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      queue.push(e);
      w();
    } else {
      queue.push(e);
    }
  };
  const end = () => {
    done = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w();
    }
  };
  const gen = async function* (): AsyncGenerator<Event> {
    while (true) {
      if (queue.length) {
        yield queue.shift() as Event;
      } else if (done) {
        return;
      } else {
        await new Promise<void>((r) => {
          waiting = r;
        });
      }
    }
  };
  return { push, end, gen };
}

function fakeBus() {
  const sink = eventSink();
  const sent: Array<{ evt: Event; targets: string[] }> = [];
  const broadcasts: Event[] = [];
  const bus: WorkerSideChannel = {
    id: "lark@me",
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    send: vi.fn(async (evt: Event, ...targets: string[]) => {
      sent.push({ evt, targets });
    }),
    broadcast: vi.fn(async (evt: Event) => {
      broadcasts.push(evt);
    }),
    events: () => sink.gen(),
  };
  return { bus, sink, sent, broadcasts };
}

function fakeChannel() {
  const sent: Array<{ to: string; input: any }> = [];
  const handlers = new Map<
    string,
    (msg: any) => void | Promise<void>
  >();
  const channel: LarkChannel = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn((name: string, h: any) => {
      handlers.set(name, h);
      return () => handlers.delete(name);
    }),
    onRawEvent: vi.fn(() => () => {}),
    send: vi.fn(async (to: string, input: any) => {
      sent.push({ to, input });
      return { messageId: "x" };
    }),
  };
  return {
    channel,
    getHandler: () => handlers.get("message") as (msg: any) => void | Promise<void>,
    sent,
  };
}

function fakeStateStore(initial: Record<string, unknown> = {}) {
  let state = { ...initial };
  const saved: Record<string, unknown>[] = [];
  const store = {
    load: vi.fn(async () => ({ ...state })),
    save: vi.fn(async (s: Record<string, unknown>) => {
      state = { ...s };
      saved.push({ ...s });
    }),
  };
  return { store, saved };
}

function makeWorker(opts: {
  bus: WorkerSideChannel;
  reasonWorkerID?: string;
  fallbackReasonWorkerID?: string;
  reasonWorkerMappings?: Record<string, string>;
  stateStore?: any;
  echo?: boolean;
  defaultUserOpenId?: string;
}) {
  const { channel, sent, getHandler } = fakeChannel();
  const { store, saved } = fakeStateStore();
  const worker = new LarkWorker({
    appId: "cli_a",
    appSecret: "secret",
    createChannel: () => channel,
    bus: opts.bus,
    reasonWorkerID: opts.reasonWorkerID ?? "reason.0",
    ...(opts.fallbackReasonWorkerID !== undefined
      ? { fallbackReasonWorkerID: opts.fallbackReasonWorkerID }
      : {}),
    stateStore: opts.stateStore ?? store,
    ...(opts.reasonWorkerMappings !== undefined
      ? { reasonWorkerMappings: opts.reasonWorkerMappings }
      : {}),
    ...(opts.echo !== undefined ? { echo: opts.echo } : {}),
    ...(opts.defaultUserOpenId !== undefined
      ? { defaultUserOpenId: opts.defaultUserOpenId }
      : {}),
  });
  return { worker, channel, larkSent: sent, getHandler, stateSaved: saved };
}

describe("larkConfigFromEnv", () => {
  it("reads app id/secret and defaults the domain", () => {
    expect(
      larkConfigFromEnv({ LARK_APP_ID: "cli_abc", LARK_APP_SECRET: "seg" }),
    ).toEqual({ appId: "cli_abc", appSecret: "seg", domain: "https://open.feishu.cn" });
  });

  it("honors an explicit domain", () => {
    expect(
      larkConfigFromEnv({
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        LARK_DOMAIN: "https://open.larksuite.com",
      }).domain,
    ).toBe("https://open.larksuite.com");
  });

  it("throws listing the missing variable(s)", () => {
    expect(() => larkConfigFromEnv({ LARK_APP_ID: "cli_abc" })).toThrow(
      /LARK_APP_SECRET/,
    );
  });
});

describe("LarkWorker", () => {
  it("forwards a Feishu message to the bound reason worker with a system reminder", async () => {
    const { bus, sent } = fakeBus();
    const { worker, getHandler } = makeWorker({ bus });

    await worker.connect();
    await getHandler()({
      chatId: "oc_1",
      messageId: "om_1",
      content: "hello feishu",
      senderId: "ou_1",
    });

    expect(sent).toHaveLength(1);
    const { evt, targets } = sent[0];
    expect(targets).toEqual(["reason.0"]);
    expect(evt.type).toBe("worker.input");
    expect(evt.trace_id).toBe("feishu-oc_1-om_1");
    expect(evt.payload).toMatchObject({ input_mode: "interrupt" });
    expect(typeof evt.payload.text).toBe("string");
    expect((evt.payload.text as string).includes("<system-reminder>")).toBe(
      true,
    );
    expect((evt.payload.text as string).includes("hello feishu")).toBe(true);
    expect((evt.payload.text as string).includes("lark.send")).toBe(true);
    expect((evt.payload.text as string).includes("Chat id: oc_1")).toBe(true);
    expect((evt.payload.text as string).includes("Sender open_id: ou_1")).toBe(true);
  });

  it("announces worker.ready with its own id excluded", async () => {
    const { bus, broadcasts } = fakeBus();
    const { worker } = makeWorker({ bus });
    await worker.connect();

    expect(broadcasts).toHaveLength(1);
    const ready = broadcasts[0];
    expect(ready.type).toBe("worker.ready");
    expect(ready.payload).toMatchObject({
      worker_id: "lark@me",
      type: "lark",
    });
    expect(ready.exclude_worker_id).toBe("lark@me");
  });

  it("pushes a reason reply (worker.input) to the matching Feishu chat", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, larkSent, getHandler } = makeWorker({ bus });

    const running = worker.run(); // connects + starts the bus event loop
    // Wait until connect() has run (both fakes resolve immediately), then feed the Feishu message.
    await flush();

    await getHandler()({
      chatId: "oc_9",
      messageId: "om_9",
      content: "user msg",
      senderId: "ou_9",
    });
    expect(sent[0].evt.trace_id).toBe("feishu-oc_9-om_9");

    // reason replies with a worker.input on the same trace (via send_message).
    sink.push({
      id: "r1",
      type: "worker.input",
      status: "created",
      payload: { text: "hello user!" },
      worker_id: "reason.0",
      trace_id: "feishu-oc_9-om_9",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([{ to: "oc_9", input: { text: "hello user!" } }]);

    sink.end();
    await running;
  });

  it("drops proactive replies with no recipient and no default user", async () => {
    const { bus, sink } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r1",
      type: "worker.input",
      status: "created",
      payload: { text: "orphan" },
      worker_id: "reason.0",
      trace_id: "unknown-trace",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([]);
    sink.end();
    await running;
  });

  it("delivers a proactive reason message to the configured default user", async () => {
    const { bus, sink } = fakeBus();
    const { worker, larkSent } = makeWorker({
      bus,
      defaultUserOpenId: "ou_default_user",
    });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r1",
      type: "worker.input",
      status: "created",
      payload: { text: "scheduled reminder" },
      worker_id: "reason.0",
      trace_id: "reason-uuid-1",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([
      { to: "ou_default_user", input: { text: "scheduled reminder" } },
    ]);
    sink.end();
    await running;
  });

  it("prefers an explicit payload recipient over the default user", async () => {
    const { bus, sink } = fakeBus();
    const { worker, larkSent } = makeWorker({
      bus,
      defaultUserOpenId: "ou_default_user",
    });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r1",
      type: "worker.input",
      status: "created",
      payload: { text: "msg", open_id: "ou_specific" },
      worker_id: "reason.0",
      trace_id: "reason-uuid-2",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent[0].to).toBe("ou_specific");
    sink.end();
    await running;
  });

  it("does not forward the bot's own messages", async () => {
    const { bus, sent } = fakeBus();
    const { worker, getHandler } = makeWorker({ bus });

    await worker.connect();
    await getHandler()({
      chatId: "oc_1",
      messageId: "om_1",
      content: "from bot",
      senderId: "ou_1",
      senderType: "bot",
    });

    expect(sent).toEqual([]);
  });

  it("serves a lark.send tool call and replies with a request.completed", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus, defaultUserOpenId: "ou_default" });

    const running = worker.run();
    await flush();
    sink.push({
      id: "e1",
      type: "lark.send",
      status: "created",
      payload: {
        worker_id: "reason.0",
        arguments: { target: "oc_group_1", text: "hi from reason" },
      },
      worker_id: "reason.0",
      request_id: "call-1",
      trace_id: "reason-uuid-3",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([
      { to: "oc_group_1", input: { text: "hi from reason" } },
    ]);
    // Reply is a directed request.completed to the caller.
    const reply = sent[sent.length - 1];
    expect(reply.targets).toEqual(["reason.0"]);
    expect(reply.evt.type).toBe("request.completed");
    expect(reply.evt.request_id).toBe("call-1");
    expect(reply.evt.trace_id).toBe("reason-uuid-3");

    sink.end();
    await running;
  });

  it("replies request.failed when lark.send has no text", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "e2",
      type: "lark.send",
      status: "created",
      payload: {
        worker_id: "reason.0",
        arguments: { target: "oc_x", text: "" },
      },
      worker_id: "reason.0",
      request_id: "call-2",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([]);
    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.failed");
    expect(reply.evt.request_id).toBe("call-2");

    sink.end();
    await running;
  });

  it("routes a Feishu chat to its configured reason worker, others to default", async () => {
    const { bus, sent } = fakeBus();
    const { worker, getHandler } = makeWorker({
      bus,
      reasonWorkerMappings: { oc_special: "reason.7" },
    });

    await worker.connect();
    await getHandler()({ chatId: "oc_special", messageId: "m1", content: "hi", senderId: "ou_1" });
    await getHandler()({ chatId: "oc_other", messageId: "m2", content: "yo", senderId: "ou_1" });

    expect(sent[0].targets).toEqual(["reason.7"]);
    expect(sent[1].targets).toEqual(["reason.0"]);
  });

  it("updates default routing via lark.reason.set and persists it", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, getHandler, stateSaved } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r1",
      type: LARK_REASON_SET,
      status: "created",
      payload: {
        worker_id: "admin.0",
        arguments: { worker_id: "reason.9" },
      },
      worker_id: "admin.0",
      request_id: "call-set",
      timestamp: Date.now(),
    });
    await flush();

    // Mutation acknowledged.
    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.completed");
    expect(reply.evt.request_id).toBe("call-set");

    // Forwarding now uses the new default, and it was persisted.
    await getHandler()({ chatId: "oc_1", messageId: "m1", content: "hi", senderId: "ou_1" });
    const forwarded = sent.find((s) => s.evt.type === "worker.input");
    expect(forwarded!.targets).toEqual(["reason.9"]);
    expect(stateSaved.at(-1)).toEqual({
      default_reason_worker: "reason.9",
      fallback_reason_worker: "",
      per_chat: {},
    });

    sink.end();
    await running;
  });

  it("maps a chat via lark.reason.set, overrides default, unset falls back", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, getHandler, stateSaved } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r2",
      type: LARK_REASON_SET,
      status: "created",
      payload: { worker_id: "admin.0", arguments: { chat_id: "oc_a", worker_id: "reason.A" } },
      worker_id: "admin.0",
      request_id: "call-set",
      timestamp: Date.now(),
    });
    await flush();

    await getHandler()({ chatId: "oc_a", messageId: "m1", content: "hi", senderId: "ou_1" });
    await getHandler()({ chatId: "oc_b", messageId: "m2", content: "yo", senderId: "ou_1" });
    expect(sent.filter((s) => s.evt.type === "worker.input")[0].targets).toEqual(["reason.A"]);
    expect(sent.filter((s) => s.evt.type === "worker.input")[1].targets).toEqual(["reason.0"]);

    // Unset the override → back to default.
    sink.push({
      id: "r3",
      type: LARK_REASON_UNSET,
      status: "created",
      payload: { worker_id: "admin.0", arguments: { chat_id: "oc_a" } },
      worker_id: "admin.0",
      request_id: "call-unset",
      timestamp: Date.now(),
    });
    await flush();
    await getHandler()({ chatId: "oc_a", messageId: "m3", content: "hi", senderId: "ou_1" });
    expect(sent.filter((s) => s.evt.type === "worker.input").at(-1)!.targets).toEqual(["reason.0"]);
    expect(stateSaved.at(-1)).toEqual({ default_reason_worker: "reason.0", fallback_reason_worker: "", per_chat: {} });

    sink.end();
    await running;
  });

  it("restores persisted routing state on connect", async () => {
    const store: LarkStateStore = {
      load: async () => ({ default_reason_worker: "reason.Z", per_chat: { oc_persisted: "reason.Y" } }),
      save: async () => {},
    };
    const { bus, sent } = fakeBus();
    const { worker, getHandler } = makeWorker({ bus, stateStore: store });

    await worker.connect();
    await getHandler()({ chatId: "oc_persisted", messageId: "m1", content: "hi", senderId: "ou_1" });
    await getHandler()({ chatId: "oc_plain", messageId: "m2", content: "yo", senderId: "ou_1" });

    expect(sent[0].targets).toEqual(["reason.Y"]);
    expect(sent[1].targets).toEqual(["reason.Z"]);
  });

  it("lark.reason.get returns the current routing", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({ bus, reasonWorkerMappings: { oc_x: "reason.5" } });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r4",
      type: LARK_REASON_GET,
      status: "created",
      payload: { worker_id: "admin.0", arguments: {} },
      worker_id: "admin.0",
      request_id: "call-get",
      timestamp: Date.now(),
    });
    await flush();

    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.completed");
    expect(JSON.parse(reply.evt.payload.result as string)).toEqual({
      default_reason_worker: "reason.0",
      fallback_reason_worker: "",
      per_chat: { oc_x: "reason.5" },
    });

    sink.end();
    await running;
  });

  it("falls back when there is no per-chat mapping or default", async () => {
    const { bus, sent } = fakeBus();
    // Explicitly empty default → routing must fall through to the fallback.
    const { worker, getHandler } = makeWorker({
      bus,
      reasonWorkerID: "",
      fallbackReasonWorkerID: "reason.FB",
    });

    await worker.connect();
    await getHandler()({ chatId: "oc_1", messageId: "m1", content: "hi", senderId: "ou_1" });
    expect(sent[0].targets).toEqual(["reason.FB"]);
  });

  it("sets the fallback via lark.reason.set and persists it", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, getHandler, stateSaved } = makeWorker({ bus, reasonWorkerID: "" });

    const running = worker.run();
    await flush();
    sink.push({
      id: "rf1",
      type: LARK_REASON_SET,
      status: "created",
      payload: { worker_id: "admin.0", arguments: { fallback: true, worker_id: "reason.FB" } },
      worker_id: "admin.0",
      request_id: "call-set-fb",
      timestamp: Date.now(),
    });
    await flush();

    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.completed");
    await getHandler()({ chatId: "oc_1", messageId: "m1", content: "hi", senderId: "ou_1" });
    const forwarded = sent.find((s) => s.evt.type === "worker.input");
    expect(forwarded!.targets).toEqual(["reason.FB"]);
    expect(stateSaved.at(-1)).toEqual({
      default_reason_worker: "",
      fallback_reason_worker: "reason.FB",
      per_chat: {},
    });

    sink.end();
    await running;
  });

  it("restores a persisted fallback worker on connect", async () => {
    const store: LarkStateStore = {
      load: async () => ({ fallback_reason_worker: "reason.FB", per_chat: {} }),
      save: async () => {},
    };
    const { bus, sent } = fakeBus();
    // No default from config; the persisted state only carries a fallback → it must be used.
    const { worker, getHandler } = makeWorker({
      bus,
      reasonWorkerID: "",
      stateStore: store,
    });

    await worker.connect();
    await getHandler()({ chatId: "oc_1", messageId: "m1", content: "hi", senderId: "ou_1" });
    expect(sent[0].targets).toEqual(["reason.FB"]);
  });
});

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
