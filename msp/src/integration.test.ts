import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvent,
  type Event,
  type Extension,
  type ExtensionHandler,
  type IfaceHandler,
  type IfaceToolHost,
} from "@niq.run/worker-sdk";
import { MspBackend, MSP_TOOL_CALL } from "./backend.js";
import { MSPNode } from "./vendor/msp-ts/index.js";

const silent = { info() {}, warn() {}, error() {} };

/** The tool calls this test's worker sees, recorded for assertions. */
class RecordingHost implements IfaceToolHost {
  readonly regs = new Map<string, { ext: Extension; handler: ExtensionHandler }>();
  readonly completed: { result: unknown }[] = [];

  register(ext: Extension, handler: ExtensionHandler): void {
    this.regs.set(ext.event, { ext, handler });
  }
  registerReadme(): void {}
  registerHelp(): void {}
  async replyCompleted(
    _callerID: string,
    _callID: string,
    result: unknown,
  ): Promise<void> {
    this.completed.push({ result });
  }
  async replyFailed(): Promise<void> {}

  async invoke(event: string, payload: Record<string, unknown>): Promise<void> {
    const reg = this.regs.get(event);
    if (!reg) throw new Error(`no extension for ${event}`);
    const evt: Event = {
      ...createEvent(event, payload),
      worker_id: "caller",
      request_id: "req-1",
    };
    await reg.handler(evt);
  }
}

class RecordingHandler implements IfaceHandler {
  readonly id = "worker_a";
  readonly sent: { evt: Event; targets: string[] }[] = [];
  readonly broadcasts: Event[] = [];
  readonly requests: { target: string; evt: Event }[] = [];

  async send(evt: Event, ...targets: string[]): Promise<void> {
    this.sent.push({ evt, targets });
  }
  async broadcast(evt: Event): Promise<void> {
    this.broadcasts.push(evt);
  }
  async request(target: string, evt: Event): Promise<Event> {
    this.requests.push({ target, evt });
    return createEvent("request.completed", { result: "pong" });
  }
  onEvent(): () => void {
    return () => {};
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("MspBackend over a real MSP world", () => {
  let dir = "";
  let backend: MspBackend | undefined;
  let peer: MSPNode | undefined;

  afterEach(async () => {
    await backend?.stop();
    peer?.stop();
    backend = undefined;
    peer = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("bridges tools and signals in both directions", async () => {
    dir = mkdtempSync(join(tmpdir(), "msp-worker-"));

    const host = new RecordingHost();
    const handler = new RecordingHandler();
    backend = new MspBackend({
      nodeID: "worker_a",
      nodesDir: dir,
      host: "127.0.0.1",
      port: 0,
      connectPolicy: "eager",
      subscribe: ["**"],
      signalEventType: "msp.signal",
      callTimeoutMs: 2_000,
      declareSignals: ["demo.announce"],
      logger: silent,
    });
    backend.setHandler(handler);
    backend.registerTools(host);
    await backend.start();

    peer = new MSPNode("peer_a", {
      nodesDir: dir,
      host: "127.0.0.1",
      port: 0,
      connectPolicy: "eager",
    });
    peer.tool("echo", "Echo back the arguments", (args) => ({ echo: args }));
    await peer.start();

    await waitFor(() => peer?.connections().includes("worker_a") ?? false);

    // niq → MSP: a caller drives the worker's msp.call tool.
    await host.invoke(MSP_TOOL_CALL, {
      peer: "peer_a",
      tool: "echo",
      args: { hello: "world" },
    });
    expect(host.completed.at(-1)?.result).toEqual({
      peer: "peer_a",
      tool: "echo",
      result: { echo: { hello: "world" } },
    });

    // MSP → niq: the peer calls the worker's niq_call tool.
    const res = await peer.call("worker_a", "niq_call", {
      target: "reason",
      event: "demo.ping",
      payload: { n: 1 },
    });
    expect(res.unwrap()).toBe("pong");
    expect(handler.requests.at(-1)?.target).toBe("reason");
    expect(handler.requests.at(-1)?.evt.type).toBe("demo.ping");

    // MSP → niq: an inbound signal becomes a niq event (broadcast by default).
    peer.publish("demo.tick", { n: 7 });
    await waitFor(() => handler.broadcasts.length > 0);
    expect(handler.broadcasts[0].type).toBe("msp.signal");
    expect(handler.broadcasts[0].payload).toEqual({
      node: "peer_a",
      path: "demo.tick",
      payload: { n: 7 },
      timestamp: expect.any(Number),
    });
  }, 20_000);
});
