import { describe, expect, it } from "vitest";
import {
  createEvent,
  type Event,
  type Extension,
  type ExtensionHandler,
  type IfaceHandler,
  type IfaceToolHost,
} from "@niq.run/worker-sdk";
import {
  MSP_NIQ_CALL,
  MSP_NIQ_SEND,
  MSP_TOOL_CALL,
  MSP_TOOL_MANIFEST,
  MSP_TOOL_NODES,
  MSP_TOOL_PUBLISH,
  MspBackend,
  type MspBackendOptions,
  type MspNodeLike,
} from "./backend.js";
import {
  makeSignal,
  patternMatches,
  SignalType,
  ToolResult,
  type Signal,
} from "./vendor/msp-ts/index.js";

const silent = { info() {}, warn() {}, error() {} };

/** A structural stand-in for `MSPNode`, recording everything it is told. */
class FakeNode implements MspNodeLike {
  readonly nodeId: string;
  readonly tools = new Map<string, (args: Record<string, unknown>) => unknown>();
  readonly declared: string[] = [];
  readonly subs: { pattern: string; cb: (sig: Signal) => void }[] = [];
  readonly published: { path: string; payload: Record<string, unknown> }[] = [];
  readonly calls: {
    peer: string;
    tool: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }[] = [];
  readonly manifests = new Map<string, Record<string, unknown>>();
  connectionsList: string[] = [];
  started = false;
  stopped = false;
  startImpl: () => Promise<{ host: string; port: number }> = async () => ({
    host: "127.0.0.1",
    port: 4321,
  });
  callImpl: () => Promise<ToolResult> = async () => new ToolResult([], { ok: true });

  constructor(nodeId = "worker_a") {
    this.nodeId = nodeId;
  }

  tool(
    name: string,
    _description: string,
    handler: (args: Record<string, unknown>) => unknown,
  ): this {
    this.tools.set(name, handler);
    return this;
  }

  declareSignal(path: string): this {
    this.declared.push(path);
    return this;
  }

  on(pattern: string, cb: (sig: Signal) => void): this {
    this.subs.push({ pattern, cb });
    return this;
  }

  async start(): Promise<{ host: string; port: number }> {
    this.started = true;
    return this.startImpl();
  }

  stop(): void {
    this.stopped = true;
  }

  async call(
    peer: string,
    tool: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<ToolResult> {
    this.calls.push({ peer, tool, args, timeoutMs });
    return this.callImpl();
  }

  publish(path: string, payload: Record<string, unknown>): void {
    this.published.push({ path, payload });
  }

  connections(): string[] {
    return this.connectionsList;
  }

  peerManifest(peer: string): Record<string, unknown> | undefined {
    return this.manifests.get(peer);
  }

  /** Deliver a signal through the subscriptions, like the protocol would. */
  emit(sig: Signal): void {
    for (const sub of this.subs) {
      if (sig.path && patternMatches(sub.pattern, sig.path)) sub.cb(sig);
    }
  }
}

class FakeHost implements IfaceToolHost {
  readonly regs = new Map<string, { ext: Extension; handler: ExtensionHandler }>();
  readonly completed: {
    callerID: string;
    callID: string;
    result: unknown;
    traceID?: string;
  }[] = [];
  readonly failed: {
    callerID: string;
    callID: string;
    error: string;
    traceID?: string;
  }[] = [];
  readme = "";

  register(ext: Extension, handler: ExtensionHandler): void {
    this.regs.set(ext.event, { ext, handler });
  }

  registerReadme(_description: string, text: () => string): void {
    this.readme = text();
  }

  registerHelp(): void {}

  async replyCompleted(
    callerID: string,
    callID: string,
    result: unknown,
    traceID?: string,
  ): Promise<void> {
    this.completed.push({ callerID, callID, result, traceID });
  }

  async replyFailed(
    callerID: string,
    callID: string,
    error: string,
    traceID?: string,
  ): Promise<void> {
    this.failed.push({ callerID, callID, error, traceID });
  }

  /** Invoke a served niq tool as a caller would. */
  async invoke(event: string, payload: Record<string, unknown>): Promise<void> {
    const reg = this.regs.get(event);
    if (!reg) throw new Error(`no extension registered for ${event}`);
    await reg.handler(toolEvent(event, payload));
  }
}

class FakeHandler implements IfaceHandler {
  readonly id = "worker_a";
  readonly sent: { evt: Event; targets: string[] }[] = [];
  readonly broadcasts: Event[] = [];
  readonly requests: { target: string; evt: Event; timeoutMs?: number }[] = [];
  reply: Event = createEvent("request.completed", { result: "pong" });

  async send(evt: Event, ...targets: string[]): Promise<void> {
    this.sent.push({ evt, targets });
  }

  async broadcast(evt: Event): Promise<void> {
    this.broadcasts.push(evt);
  }

  async request(
    target: string,
    evt: Event,
    opts?: { timeoutMs?: number },
  ): Promise<Event> {
    this.requests.push({ target, evt, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    return this.reply;
  }

  onEvent(): () => void {
    return () => {};
  }
}

function toolEvent(type: string, payload: Record<string, unknown>): Event {
  return {
    ...createEvent(type, payload),
    worker_id: "caller",
    request_id: "req-1",
    trace_id: "trace-1",
  };
}

function setup(overrides: Partial<MspBackendOptions> = {}) {
  const node = new FakeNode();
  const host = new FakeHost();
  const handler = new FakeHandler();
  const backend = new MspBackend({
    nodeID: "worker_a",
    nodesDir: "/tmp/msp-test",
    host: "127.0.0.1",
    port: 0,
    connectPolicy: "eager",
    subscribe: ["**"],
    signalEventType: "msp.signal",
    callTimeoutMs: 5_000,
    declareSignals: [],
    nodeFactory: () => node,
    logger: silent,
    ...overrides,
  });
  backend.setHandler(handler);
  backend.registerTools(host);
  return { backend, node, host, handler };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("MspBackend", () => {
  it("wires both halves on start", async () => {
    const { backend, node, host } = setup({ declareSignals: ["demo.announce"] });
    await backend.start();

    expect(node.started).toBe(true);
    expect([...node.tools.keys()].sort()).toEqual([MSP_NIQ_CALL, MSP_NIQ_SEND]);
    expect(node.declared).toEqual(["demo.announce"]);
    expect(node.subs.map((s) => s.pattern)).toEqual(["**"]);
    expect([...host.regs.keys()].sort()).toEqual(
      [MSP_TOOL_CALL, MSP_TOOL_MANIFEST, MSP_TOOL_NODES, MSP_TOOL_PUBLISH].sort(),
    );
    expect(host.readme).toContain("MSP world bridge");

    await backend.stop();
    expect(node.stopped).toBe(true);
  });

  it("reports the node, its connections, and each peer's capabilities", async () => {
    const { backend, node, host } = setup();
    node.connectionsList = ["peer_a"];
    node.manifests.set("peer_a", {
      tools: [{ name: "echo", description: "echo" }],
      signals: [{ path: "demo.tick" }],
      skills: [{ name: "weather" }],
      patterns: ["msp/request-reply"],
      capabilities: ["pub", "rep"],
    });
    await backend.start();

    await host.invoke(MSP_TOOL_NODES, {});

    expect(host.completed).toHaveLength(1);
    expect(host.completed[0].result).toEqual({
      node_id: "worker_a",
      connections: ["peer_a"],
      peers: [
        {
          id: "peer_a",
          tools: ["echo"],
          signals: ["demo.tick"],
          skills: ["weather"],
          patterns: ["msp/request-reply"],
          capabilities: ["pub", "rep"],
        },
      ],
    });
  });

  it("calls a peer tool and returns its result", async () => {
    const { backend, node, host } = setup();
    node.callImpl = async () => new ToolResult([], { sum: 3 });
    await backend.start();

    await host.invoke(MSP_TOOL_CALL, {
      peer: "peer_a",
      tool: "add",
      args: { a: 1, b: 2 },
      timeout_ms: 750,
    });

    expect(node.calls[0]).toEqual({
      peer: "peer_a",
      tool: "add",
      args: { a: 1, b: 2 },
      timeoutMs: 750,
    });
    expect(host.completed[0].result).toEqual({
      peer: "peer_a",
      tool: "add",
      result: { sum: 3 },
    });
  });

  it("surfaces an MSP tool error as a failed reply", async () => {
    const { backend, node, host } = setup();
    node.callImpl = async () => new ToolResult([], undefined, "peer exploded");
    await backend.start();

    await host.invoke(MSP_TOOL_CALL, { peer: "peer_a", tool: "boom" });

    expect(host.completed).toHaveLength(0);
    expect(host.failed[0].error).toBe("peer exploded");
    expect(host.failed[0].callID).toBe("req-1");
    expect(host.failed[0].traceID).toBe("trace-1");
  });

  it("fails fast when msp.call has no peer", async () => {
    const { backend, host } = setup();
    await backend.start();

    await host.invoke(MSP_TOOL_CALL, { tool: "add" });

    expect(host.failed[0].error).toMatch(/peer is required/);
  });

  it("publishes a signal into the world", async () => {
    const { backend, node, host } = setup();
    await backend.start();

    await host.invoke(MSP_TOOL_PUBLISH, { path: "demo.tick", payload: { n: 1 } });

    expect(node.published).toEqual([{ path: "demo.tick", payload: { n: 1 } }]);
    expect(host.completed[0].result).toEqual({ ok: true, path: "demo.tick" });
  });

  it("rejects an invalid signal path on publish", async () => {
    const { backend, node, host } = setup();
    await backend.start();

    await host.invoke(MSP_TOOL_PUBLISH, { path: "Demo.Tick" });

    expect(node.published).toEqual([]);
    expect(host.failed[0].error).toMatch(/invalid signal path/);
  });

  it("returns a peer manifest, empty when unknown", async () => {
    const { backend, node, host } = setup();
    node.manifests.set("peer_a", { tools: [{ name: "echo" }] });
    await backend.start();

    await host.invoke(MSP_TOOL_MANIFEST, { peer: "peer_a" });
    await host.invoke(MSP_TOOL_MANIFEST, { peer: "ghost" });

    expect(host.completed[0].result).toEqual({
      peer: "peer_a",
      manifest: { tools: [{ name: "echo" }] },
    });
    expect(host.completed[1].result).toEqual({ peer: "ghost", manifest: {} });
  });

  it("does not reply to notifications without a request id", async () => {
    const { backend, host } = setup();
    await backend.start();

    const reg = host.regs.get(MSP_TOOL_NODES);
    await reg?.handler({ ...toolEvent(MSP_TOOL_NODES, {}), request_id: undefined });

    expect(host.completed).toHaveLength(0);
    expect(host.failed).toHaveLength(0);
  });

  it("exposes niq_call on the MSP node and correlates the reply", async () => {
    const { backend, node, handler } = setup();
    await backend.start();

    const call = node.tools.get(MSP_NIQ_CALL);
    const result = await call?.({
      target: "reason",
      event: "demo.ping",
      payload: { n: 1 },
      timeout_ms: 900,
    });

    expect(result).toBe("pong");
    expect(handler.requests[0].target).toBe("reason");
    expect(handler.requests[0].evt.type).toBe("demo.ping");
    expect(handler.requests[0].evt.payload).toEqual({ n: 1 });
    expect(handler.requests[0].timeoutMs).toBe(900);
  });

  it("requires a target on niq_call", async () => {
    const { backend, node } = setup();
    await backend.start();

    await expect(node.tools.get(MSP_NIQ_CALL)?.({ event: "demo.ping" })).rejects.toThrow(
      /target is required/,
    );
  });

  it("exposes niq_send on the MSP node", async () => {
    const { backend, node, handler } = setup();
    await backend.start();

    const result = await node.tools.get(MSP_NIQ_SEND)?.({
      target: "reason",
      event: "demo.note",
      payload: { text: "hi" },
    });

    expect(result).toEqual({ ok: true, target: "reason", event: "demo.note" });
    expect(handler.sent[0].targets).toEqual(["reason"]);
    expect(handler.sent[0].evt.type).toBe("demo.note");
    expect(handler.sent[0].evt.payload).toEqual({ text: "hi" });
  });

  it("forwards inbound signals to the bus as a broadcast by default", async () => {
    const { backend, node, handler } = setup();
    await backend.start();

    node.emit(makeSignal(SignalType.SIGNAL, "peer_a", { path: "demo.tick", payload: { n: 1 } }));
    await flush();

    expect(handler.broadcasts).toHaveLength(1);
    const evt = handler.broadcasts[0];
    expect(evt.type).toBe("msp.signal");
    expect(evt.payload).toEqual({
      node: "peer_a",
      path: "demo.tick",
      payload: { n: 1 },
      timestamp: expect.any(Number),
    });
  });

  it("skips its own signals", async () => {
    const { backend, node, handler } = setup();
    await backend.start();

    node.emit(makeSignal(SignalType.SIGNAL, "worker_a", { path: "demo.tick" }));
    await flush();

    expect(handler.broadcasts).toHaveLength(0);
  });

  it("directs signals to the configured niq worker", async () => {
    const { backend, node, handler } = setup({ signalTarget: "reason" });
    await backend.start();

    node.emit(makeSignal(SignalType.SIGNAL, "peer_a", { path: "demo.tick" }));
    await flush();

    expect(handler.broadcasts).toHaveLength(0);
    expect(handler.sent[0].targets).toEqual(["reason"]);
  });

  it("only forwards signals matching the subscription", async () => {
    const { backend, node, handler } = setup({ subscribe: ["demo.**"] });
    await backend.start();

    node.emit(makeSignal(SignalType.SIGNAL, "peer_a", { path: "demo.tick" }));
    node.emit(makeSignal(SignalType.SIGNAL, "peer_a", { path: "other.tick" }));
    await flush();

    expect(handler.broadcasts).toHaveLength(1);
    expect(handler.broadcasts[0].payload).toMatchObject({ path: "demo.tick" });
  });

  it("releases the node and rethrows when start fails", async () => {
    const { backend, node } = setup();
    node.startImpl = async () => {
      throw new Error("port in use");
    };

    await expect(backend.start()).rejects.toThrow(/port in use/);
    expect(node.stopped).toBe(true);
  });
});
