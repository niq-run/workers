import { describe, expect, it, vi } from "vitest";
import {
  LarkWorker,
  larkConfigFromEnv,
  type LarkChannel,
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

function makeWorker(opts: {
  bus: WorkerSideChannel;
  reasonWorkerID?: string;
  echo?: boolean;
  defaultUserOpenId?: string;
}) {
  const { channel, sent, getHandler } = fakeChannel();
  const worker = new LarkWorker({
    appId: "cli_a",
    appSecret: "secret",
    createChannel: () => channel,
    bus: opts.bus,
    reasonWorkerID: opts.reasonWorkerID ?? "reason.0",
    ...(opts.echo !== undefined ? { echo: opts.echo } : {}),
    ...(opts.defaultUserOpenId !== undefined
      ? { defaultUserOpenId: opts.defaultUserOpenId }
      : {}),
  });
  return { worker, channel, larkSent: sent, getHandler };
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
});

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}