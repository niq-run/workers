import { describe, expect, it, vi } from "vitest";
import {
  LarkWorker,
  larkConfigFromEnv,
  parseDirList,
  LARK_REASON_SET,
  LARK_REASON_GET,
  LARK_DIRS_ADD,
  LARK_DIRS_GET,
  WORKER_README,
  DEFAULT_APPROVER,
  buildSendInput,
  type LarkChannel,
  type LarkStateStore,
} from "./worker.js";
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
    editMessage: vi.fn(async () => {}),
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
  appendOutbound?: boolean;
  allowedFileDirs?: string[];
  approver?: string;
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
    ...(opts.appendOutbound !== undefined
      ? { appendOutbound: opts.appendOutbound }
      : {}),
    ...(opts.allowedFileDirs !== undefined
      ? { channel: { outbound: { allowedFileDirs: opts.allowedFileDirs } } }
      : {}),
    ...(opts.approver !== undefined ? { approver: opts.approver } : {}),
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

  it("forwards LARK_ALLOWED_FILE_DIRS as outbound.allowedFileDirs", () => {
    const cfg = larkConfigFromEnv({
      LARK_APP_ID: "cli_a",
      LARK_APP_SECRET: "secret",
      LARK_ALLOWED_FILE_DIRS: "/var/niq/outbox, /tmp/reports",
    });
    expect(cfg.channel?.outbound?.allowedFileDirs).toEqual([
      "/var/niq/outbox",
      "/tmp/reports",
    ]);
  });

  it("omits the channel block when no local-file dirs are configured", () => {
    expect(
      larkConfigFromEnv({ LARK_APP_ID: "cli_a", LARK_APP_SECRET: "secret" }),
    ).not.toHaveProperty("channel");
  });
});

describe("parseDirList", () => {
  it("splits on commas, trims, and drops blank entries", () => {
    expect(parseDirList(" /a , ,/b ")).toEqual(["/a", "/b"]);
  });

  it("returns undefined for an absent or blank list", () => {
    expect(parseDirList(undefined)).toBeUndefined();
    expect(parseDirList("  ,  ")).toBeUndefined();
  });
});

describe("LarkWorker", () => {
  it("passes the configured local-file allowlist through to the channel", () => {
    const { bus } = fakeBus();
    const { channel } = fakeChannel();
    const createChannel = vi.fn(() => channel);
    new LarkWorker({
      appId: "cli_a",
      appSecret: "secret",
      createChannel,
      channel: { outbound: { allowedFileDirs: ["/var/niq/outbox"] } },
      bus,
      reasonWorkerID: "reason.0",
      stateStore: fakeStateStore().store,
    });
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "cli_a",
        outbound: { allowedFileDirs: ["/var/niq/outbox"] },
      }),
    );
  });

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
    expect(evt.payload).toMatchObject({ input_mode: "append" });
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
      type: "lark",
    });
    expect(ready.exclude_worker_id).toBe("lark@me");

    // The announced contract: every tool with its argument schema, and the
    // reply shape (reason.get's is a structured object, not a JSON string).
    const watch = ready.payload.watch as Array<Record<string, any>>;
    expect(watch.map((w) => w.event)).toEqual([
      "worker.readme",
      "lark.send",
      "lark.reason.set",
      "lark.reason.get",
      "lark.dirs.add",
      "lark.dirs.get",
    ]);
    for (const entry of watch) {
      expect(entry.parameters).toMatchObject({ type: "object" });
      expect(entry.response).toBeDefined();
    }
    const reasonGet = watch.find((w) => w.event === "lark.reason.get")!;
    expect(reasonGet.response).toMatchObject({
      type: "object",
      properties: {
        default_reason_worker: { type: "string" },
        fallback_reason_worker: { type: "string" },
        per_chat: { type: "object" },
      },
    });
  });

  it("answers worker.readme with the guide and live state", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({
      bus,
      allowedFileDirs: ["/data/out"],
      reasonWorkerMappings: { oc_x: "reason.5" },
    });

    const running = worker.run();
    await flush();
    sink.push({
      id: "rd1",
      type: WORKER_README,
      status: "created",
      payload: {},
      worker_id: "reason.0",
      request_id: "call-readme",
      timestamp: Date.now(),
    });
    await flush();

    const reply = sent.at(-1)!;
    expect(reply.evt.type).toBe("request.completed");
    expect(reply.evt.request_id).toBe("call-readme");
    expect(reply.targets).toEqual(["reason.0"]);
    // A string reply travels under `result`, like every non-object reply.
    const text = (reply.evt.payload as any).result as string;
    expect(text).toContain("# lark");
    expect(text).toContain("lark.send");
    expect(text).toContain("lark.dirs.add");
    expect(text).toContain("local-file dirs: /data/out");
    expect(text).toContain("per-chat overrides: 1");
    expect(text).toContain(`approver: ${DEFAULT_APPROVER}`);

    sink.end();
    await running;
  });

  it("answers worker.discover with a directed worker.ready to the asker", async () => {
    const { bus, sink, sent, broadcasts } = fakeBus();
    const { worker } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d1",
      type: "worker.discover",
      status: "created",
      payload: {},
      worker_id: "webui-hiw",
      timestamp: Date.now(),
    });
    await flush();

    const reply = sent.find((s) => s.evt.type === "worker.ready");
    expect(reply).toBeDefined();
    expect(reply!.targets).toEqual(["webui-hiw"]);
    expect(reply!.evt.transient).toBe(true);
    const watch = reply!.evt.payload.watch as Array<Record<string, any>>;
    expect(watch.map((w) => w.event)).toContain("lark.send");
    // Discovery is answered directly; it is not re-broadcast.
    expect(broadcasts.filter((b) => b.type === "worker.ready")).toHaveLength(1);

    sink.end();
    await running;
  });

  it("does not answer its own worker.discover", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d2",
      type: "worker.discover",
      status: "created",
      payload: {},
      worker_id: "lark@me",
      timestamp: Date.now(),
    });
    await flush();

    expect(sent.filter((s) => s.evt.type === "worker.ready")).toHaveLength(0);

    sink.end();
    await running;
  });

  it("delivers a lark.send with no target to the configured default user", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, larkSent } = makeWorker({
      bus,
      defaultUserOpenId: "ou_default_user",
    });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r1",
      type: "lark.send",
      status: "created",
      payload: { text: "scheduled reminder" },
      worker_id: "reason.0",
      request_id: "call-4",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([
      { to: "ou_default_user", input: { text: "scheduled reminder" } },
    ]);
    expect(sent[sent.length - 1].evt.type).toBe("request.completed");
    sink.end();
    await running;
  });

  it("replies request.failed when lark.send has no target and no default user", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r2",
      type: "lark.send",
      status: "created",
      payload: { text: "orphan" },
      worker_id: "reason.0",
      request_id: "call-5",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([]);
    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.failed");
    expect(reply.evt.request_id).toBe("call-5");
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
    	  payload: { target: "oc_group_1", text: "hi from reason" },
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

  it("appends subsequent lark.send calls to the same target into one message", async () => {
    const { bus, sink } = fakeBus();
    const { worker, channel, larkSent } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "a1",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_t", text: "part one" },
      worker_id: "reason.0",
      request_id: "call-1",
      timestamp: Date.now(),
    });
    sink.push({
      id: "a2",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_t", text: "part two" },
      worker_id: "reason.0",
      request_id: "call-2",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([{ to: "oc_t", input: { text: "part one" } }]);
    expect(channel.editMessage).toHaveBeenCalledWith("x", "part one\npart two");

    sink.end();
    await running;
  });

  it("starts a fresh message per inbound Feishu turn (append resets)", async () => {
    const { bus, sink } = fakeBus();
    const { worker, channel, larkSent, getHandler } = makeWorker({ bus });

    const running = worker.run();
    await flush();

    // First user turn.
    await getHandler()({
      chatId: "oc_t",
      messageId: "m1",
      content: "hi",
      senderId: "ou_1",
    });
    sink.push({
      id: "b1",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_t", text: "reply A" },
      worker_id: "reason.0",
      request_id: "call-1",
      timestamp: Date.now(),
    });
    await flush();
    expect(larkSent).toEqual([{ to: "oc_t", input: { text: "reply A" } }]);

    // Second user turn resets the target → next lark.send posts a fresh message.
    await getHandler()({
      chatId: "oc_t",
      messageId: "m2",
      content: "again",
      senderId: "ou_1",
    });
    sink.push({
      id: "b2",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_t", text: "reply B" },
      worker_id: "reason.0",
      request_id: "call-2",
      timestamp: Date.now(),
    });
    await flush();

    expect(larkSent).toEqual([
      { to: "oc_t", input: { text: "reply A" } },
      { to: "oc_t", input: { text: "reply B" } },
    ]);
    expect(channel.editMessage).not.toHaveBeenCalled();

    sink.end();
    await running;
  });

  it("posts a separate message per lark.send when appendOutbound is false", async () => {
    const { bus, sink } = fakeBus();
    const { worker, channel, larkSent } = makeWorker({ bus, appendOutbound: false });

    const running = worker.run();
    await flush();
    for (const [i, text] of ["one", "two"].entries()) {
      sink.push({
        id: `c${i}`,
        type: "lark.send",
        status: "created",
        payload: { target: "oc_t", text },
        worker_id: "reason.0",
        request_id: `call-${i}`,
        timestamp: Date.now(),
      });
    }
    await flush();

    expect(larkSent).toEqual([
      { to: "oc_t", input: { text: "one" } },
      { to: "oc_t", input: { text: "two" } },
    ]);
    expect(channel.editMessage).not.toHaveBeenCalled();

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
    	  payload: { target: "oc_x", text: "" },
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
      payload: { worker_id: "reason.9" },
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
      allowed_file_dirs: [],
    });

    sink.end();
    await running;
  });

  it("maps a chat via lark.reason.set, overriding the default", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, getHandler } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "r2",
      type: LARK_REASON_SET,
      status: "created",
      payload: { chat_id: "oc_a", worker_id: "reason.A" },
      worker_id: "admin.0",
      request_id: "call-set",
      timestamp: Date.now(),
    });
    await flush();

    await getHandler()({ chatId: "oc_a", messageId: "m1", content: "hi", senderId: "ou_1" });
    await getHandler()({ chatId: "oc_b", messageId: "m2", content: "yo", senderId: "ou_1" });
    expect(sent.filter((s) => s.evt.type === "worker.input")[0].targets).toEqual(["reason.A"]);
    expect(sent.filter((s) => s.evt.type === "worker.input")[1].targets).toEqual(["reason.0"]);

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
    	  payload: {},
    	  worker_id: "admin.0",
    	  request_id: "call-get",
      timestamp: Date.now(),
    });
    await flush();

    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.completed");
    // A structured reply IS the payload: no result wrapper, no JSON string.
    expect(reply.evt.payload).toEqual({
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
      payload: { fallback: true, worker_id: "reason.FB" },
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
      allowed_file_dirs: [],
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

describe("lark.dirs.* (runtime allowlist)", () => {
  it("applies an approver's own add directly, persists it, and updates the live channel config", async () => {
    const { bus, sink, sent } = fakeBus();
    const { channel } = fakeChannel();
    const createChannel = vi.fn((_opts: any) => channel);
    const { store, saved } = fakeStateStore();
    const worker = new LarkWorker({
      appId: "cli_a",
      appSecret: "secret",
      createChannel,
      channel: { outbound: { allowedFileDirs: ["/seed"] } },
      bus,
      reasonWorkerID: "reason.0",
      stateStore: store,
    });
    // The very object handed to the channel is what the SDK's uploader reads.
    const channelOpts = createChannel.mock.calls[0][0] as any;

    const running = worker.run();
    await flush();
    sink.push({
      id: "d1",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: { path: "/tmp/new" },
      worker_id: DEFAULT_APPROVER,
      request_id: "call-d1",
      timestamp: Date.now(),
    });
    await flush();

    expect(channelOpts.outbound.allowedFileDirs).toEqual(["/seed", "/tmp/new"]);
    expect(saved.at(-1)!.allowed_file_dirs).toEqual(["/seed", "/tmp/new"]);
    const reply = sent.at(-1)!;
    expect(reply.evt.type).toBe("request.completed");
    expect(reply.evt.request_id).toBe("call-d1");
    expect(reply.targets).toEqual([DEFAULT_APPROVER]);
    expect(reply.evt.payload).toEqual({
      dirs: ["/seed", "/tmp/new"],
      added: "/tmp/new",
    });

    sink.end();
    await running;
  });

  it("parks a non-approver's add behind an approval.request, then applies it on approval", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, stateSaved } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d2",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: { path: "/data/outbox" },
      worker_id: "reason.0",
      request_id: "call-d2",
      trace_id: "trace-7",
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // The call is not answered yet: an approval.request went to the approver.
    expect(sent).toHaveLength(1);
    const approval = sent[0];
    expect(approval.evt.type).toBe("approval.request");
    expect(approval.targets).toEqual([DEFAULT_APPROVER]);
    expect(approval.evt.id).toBe(approval.evt.request_id);
    expect(approval.evt.trace_id).toBe("trace-7");
    expect(approval.evt.payload).toMatchObject({
      origin: "reason.0",
      action: LARK_DIRS_ADD,
      path: "/data/outbox",
      dirs: [],
    });

    sink.push({
      id: "dec1",
      type: "approval.decision",
      status: "routed",
      payload: { approved: true },
      worker_id: DEFAULT_APPROVER,
      request_id: approval.evt.id,
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const reply = sent.at(-1)!;
    expect(reply.evt.type).toBe("request.completed");
    expect(reply.evt.request_id).toBe("call-d2");
    expect(reply.targets).toEqual(["reason.0"]);
    expect(reply.evt.payload).toEqual({
      dirs: ["/data/outbox"],
      added: "/data/outbox",
    });
    expect(stateSaved.at(-1)!.allowed_file_dirs).toEqual(["/data/outbox"]);

    sink.end();
    await running;
  });

  it("fails the caller when the approver denies", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, stateSaved } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d3",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: { path: "/etc/passwd-dir" },
      worker_id: "reason.0",
      request_id: "call-d3",
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const approval = sent[0];

    sink.push({
      id: "dec2",
      type: "approval.decision",
      status: "routed",
      payload: { approved: false, note: "too broad" },
      worker_id: DEFAULT_APPROVER,
      request_id: approval.evt.id,
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const reply = sent.at(-1)!;
    expect(reply.evt.type).toBe("request.failed");
    expect(reply.evt.request_id).toBe("call-d3");
    expect((reply.evt.payload as any).error).toBe("approval denied: too broad");
    expect(stateSaved).toHaveLength(0);

    sink.end();
    await running;
  });

  it("fails the caller when the approval request cannot be delivered", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d4",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: { path: "/data/x" },
      worker_id: "reason.0",
      request_id: "call-d4",
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const approval = sent[0];

    // The bus reports an offline target against the approval's request id.
    sink.push({
      id: "bus-fail",
      type: "request.failed",
      status: "routed",
      payload: { error: "target is not online: webui-hiw" },
      worker_id: DEFAULT_APPROVER,
      request_id: approval.evt.id,
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const reply = sent.at(-1)!;
    expect(reply.evt.type).toBe("request.failed");
    expect(reply.evt.request_id).toBe("call-d4");
    expect((reply.evt.payload as any).error).toBe(
      "approval request failed: target is not online: webui-hiw",
    );

    sink.end();
    await running;
  });

  it("ignores a decision from a worker other than the configured approver", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d5",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: { path: "/data/y" },
      worker_id: "reason.0",
      request_id: "call-d5",
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const approval = sent[0];

    // A non-approver tries to grant it: ignored, and nothing is answered.
    sink.push({
      id: "dec3",
      type: "approval.decision",
      status: "routed",
      payload: { approved: true },
      worker_id: "reason.0",
      request_id: approval.evt.id,
      timestamp: Date.now(),
    });
    await flush();
    expect(sent).toHaveLength(1);

    // The real approver still can.
    sink.push({
      id: "dec4",
      type: "approval.decision",
      status: "routed",
      payload: { approved: true },
      worker_id: DEFAULT_APPROVER,
      request_id: approval.evt.id,
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.at(-1)!.evt.type).toBe("request.completed");
    expect(sent.at(-1)!.evt.request_id).toBe("call-d5");

    sink.end();
    await running;
  });

  it("applies adds directly when no approver is configured", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({ bus, approver: "" });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d6",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: { path: "/data/z" },
      worker_id: "reason.0",
      request_id: "call-d6",
      timestamp: Date.now(),
    });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].evt.type).toBe("request.completed");
    expect(sent[0].evt.payload).toEqual({ dirs: ["/data/z"], added: "/data/z" });

    sink.end();
    await running;
  });

  it("merges persisted allowlist additions onto the env seed on connect", async () => {
    const store: LarkStateStore = {
      load: async () => ({ allowed_file_dirs: ["/persisted/dir"] }),
      save: async () => {},
    };
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({
      bus,
      stateStore: store,
      allowedFileDirs: ["/env/dir"],
    });

    const running = worker.run();
    await flush();
    sink.push({
      id: "g1",
      type: LARK_DIRS_GET,
      status: "created",
      payload: {},
      worker_id: "admin.0",
      request_id: "call-get-dirs",
      timestamp: Date.now(),
    });
    await flush();

    expect(sent.at(-1)!.evt.payload).toEqual({
      dirs: ["/env/dir", "/persisted/dir"],
      approver: DEFAULT_APPROVER,
    });

    sink.end();
    await running;
  });

  it("replies request.failed when path is missing", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker } = makeWorker({ bus });

    const running = worker.run();
    await flush();
    sink.push({
      id: "d7",
      type: LARK_DIRS_ADD,
      status: "created",
      payload: {},
      worker_id: DEFAULT_APPROVER,
      request_id: "call-d7",
      timestamp: Date.now(),
    });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].evt.type).toBe("request.failed");
    expect((sent[0].evt.payload as any).error).toBe("path is required");

    sink.end();
    await running;
  });
});

describe("lark.send media", () => {
  it("sends an image via lark.send and replies request.completed", async () => {
    const { bus, sink, sent } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus });
    const running = worker.run();
    await flush();
    sink.push({
      id: "m1",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_g", image: "https://example.com/a.png" },
      worker_id: "reason.0",
      request_id: "call-m1",
      timestamp: Date.now(),
    });
    await flush();
    expect(larkSent).toEqual([
      { to: "oc_g", input: { image: { source: "https://example.com/a.png" } } },
    ]);
    const reply = sent[sent.length - 1];
    expect(reply.evt.type).toBe("request.completed");
    expect(reply.evt.request_id).toBe("call-m1");
    sink.end();
    await running;
  });

  it("sends a file with an explicit file_name", async () => {
    const { bus, sink } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus });
    const running = worker.run();
    await flush();
    sink.push({
      id: "m2",
      type: "lark.send",
      status: "created",
      payload: {
        target: "ou_u",
        file: "https://example.com/report.pdf",
        file_name: "report.pdf",
      },
      worker_id: "reason.0",
      request_id: "call-m2",
      timestamp: Date.now(),
    });
    await flush();
    expect(larkSent).toEqual([
      {
        to: "ou_u",
        input: { file: { source: "https://example.com/report.pdf", fileName: "report.pdf" } },
      },
    ]);
    sink.end();
    await running;
  });

  it("derives a file display name from the source when file_name is omitted", async () => {
    const { bus, sink } = fakeBus();
    const { worker, larkSent } = makeWorker({ bus });
    const running = worker.run();
    await flush();
    sink.push({
      id: "m3",
      type: "lark.send",
      status: "created",
      payload: { target: "ou_u", file: "https://example.com/notes.txt?v=1" },
      worker_id: "reason.0",
      request_id: "call-m3",
      timestamp: Date.now(),
    });
    await flush();
    expect(larkSent[0].input).toEqual({
      file: { source: "https://example.com/notes.txt?v=1", fileName: "notes.txt" },
    });
    sink.end();
    await running;
  });

  it("media send clears any pending text append and posts a fresh message", async () => {
    const { bus, sink } = fakeBus();
    const { worker, channel, larkSent } = makeWorker({ bus });
    const running = worker.run();
    await flush();
    sink.push({
      id: "t1",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_t", text: "part one" },
      worker_id: "reason.0",
      request_id: "call-t1",
      timestamp: Date.now(),
    });
    await flush();
    // Now a media send to the same target: fresh send, no editMessage.
    sink.push({
      id: "m4",
      type: "lark.send",
      status: "created",
      payload: { target: "oc_t", image: "https://x/y.png" },
      worker_id: "reason.0",
      request_id: "call-m4",
      timestamp: Date.now(),
    });
    await flush();
    expect(larkSent).toEqual([
      { to: "oc_t", input: { text: "part one" } },
      { to: "oc_t", input: { image: { source: "https://x/y.png" } } },
    ]);
    expect(channel.editMessage).not.toHaveBeenCalled();
    sink.end();
    await running;
  });
});

describe("buildSendInput", () => {
  it("maps image/file/video/audio and ignores other args", () => {
    expect(buildSendInput({ image: "https://x/a.png" })).toEqual({
      image: { source: "https://x/a.png" },
    });
    expect(buildSendInput({ file: "/tmp/a.bin", file_name: "a.bin" })).toEqual({
      file: { source: "/tmp/a.bin", fileName: "a.bin" },
    });
    expect(buildSendInput({ video: "v.mp4" })).toEqual({ video: { source: "v.mp4" } });
    expect(buildSendInput({ audio: "a.mp3" })).toEqual({ audio: { source: "a.mp3" } });
  });

  it("prefers image over file/video/audio", () => {
    expect(buildSendInput({ image: "i", file: "f", video: "v", audio: "a" })).toEqual({
      image: { source: "i" },
    });
  });

  it("returns undefined when no media arg is present", () => {
    expect(buildSendInput({ target: "t", text: "hi" })).toBeUndefined();
  });
});

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
