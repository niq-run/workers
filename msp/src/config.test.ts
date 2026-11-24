import { describe, expect, it } from "vitest";
import { DEFAULT_MSP_NODES_DIR, mspConfigFromArgs, sanitizeNodeID } from "./config.js";

const env = (over: Record<string, string | undefined>) => over;

describe("sanitizeNodeID", () => {
  it("lowercases and collapses illegal characters", () => {
    expect(sanitizeNodeID("Reason Worker #3")).toBe("reason-worker-3");
    expect(sanitizeNodeID("__a__b__")).toBe("__a__b__");
    expect(sanitizeNodeID("  --x--  ")).toBe("x");
  });

  it("falls back when nothing usable is left", () => {
    expect(sanitizeNodeID("!!!")).toBe("msp-node");
    expect(sanitizeNodeID("")).toBe("msp-node");
  });
});

describe("mspConfigFromArgs", () => {
  it("derives defaults from the worker id", () => {
    const cfg = mspConfigFromArgs({}, env({}), "Reason Worker");
    expect(cfg).toEqual({
      nodeID: "reason-worker",
      nodesDir: DEFAULT_MSP_NODES_DIR,
      host: "127.0.0.1",
      port: 0,
      connectPolicy: "eager",
      subscribe: ["**"],
      signalEventType: "msp.signal",
      callTimeoutMs: 5_000,
      declareSignals: [],
    });
  });

  it("lets flags win over the environment", () => {
    const cfg = mspConfigFromArgs(
      { "msp-node-id": "flag-node", "msp-port": "7000" },
      env({ MSP_NODE_ID: "env-node", MSP_PORT: "7001", MSP_HOST: "0.0.0.0" }),
      "worker",
    );
    expect(cfg.nodeID).toBe("flag-node");
    expect(cfg.port).toBe(7000);
    expect(cfg.host).toBe("0.0.0.0");
  });

  it("reads every knob from the environment", () => {
    const cfg = mspConfigFromArgs(
      {},
      env({
        MSP_NODE_ID: "env-node",
        MSP_NODES_DIR: "/tmp/nodes",
        MSP_HOST: "0.0.0.0",
        MSP_PORT: "6000",
        MSP_CONNECT_POLICY: "lazy",
        MSP_SUBSCRIBE: "demo.**, other.tick",
        MSP_SIGNAL_EVENT: "world.signal",
        MSP_SIGNAL_TARGET: "reason",
        MSP_CALL_TIMEOUT_MS: "1234",
        MSP_DECLARE_SIGNALS: "demo.tick, demo.tick, demo.state",
      }),
      "worker",
    );
    expect(cfg.nodeID).toBe("env-node");
    expect(cfg.nodesDir).toBe("/tmp/nodes");
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(6000);
    expect(cfg.connectPolicy).toBe("lazy");
    expect(cfg.subscribe).toEqual(["demo.**", "other.tick"]);
    expect(cfg.signalEventType).toBe("world.signal");
    expect(cfg.signalTarget).toBe("reason");
    expect(cfg.callTimeoutMs).toBe(1234);
    expect(cfg.declareSignals).toEqual(["demo.tick", "demo.state"]);
  });

  it("leaves signalTarget unset when empty", () => {
    const cfg = mspConfigFromArgs({}, env({ MSP_SIGNAL_TARGET: "   " }), "worker");
    expect(cfg.signalTarget).toBeUndefined();
    expect("signalTarget" in cfg).toBe(false);
  });

  it("rejects an illegal node id", () => {
    expect(() =>
      mspConfigFromArgs({ "msp-node-id": "Bad.Node" }, env({}), "worker"),
    ).toThrow(/invalid MSP node id/);
  });

  it("rejects an unknown connect policy", () => {
    expect(() =>
      mspConfigFromArgs({ "msp-connect-policy": "sometimes" }, env({}), "worker"),
    ).toThrow(/eager or lazy/);
  });

  it("rejects a non-integer port", () => {
    expect(() => mspConfigFromArgs({ "msp-port": "abc" }, env({}), "worker")).toThrow(
      /must be an integer/,
    );
  });

  it("rejects an out-of-range port", () => {
    expect(() => mspConfigFromArgs({ "msp-port": "70000" }, env({}), "worker")).toThrow(
      /between 0 and 65535/,
    );
  });

  it("rejects a zero call timeout", () => {
    expect(() =>
      mspConfigFromArgs({ "msp-call-timeout-ms": "0" }, env({}), "worker"),
    ).toThrow(/between 1 and/);
  });

  it("rejects an invalid declared signal path", () => {
    expect(() =>
      mspConfigFromArgs({ "msp-declare-signals": "Demo.Tick" }, env({}), "worker"),
    ).toThrow(/invalid MSP signal path/);
  });

  it("rejects a flag given without a value", () => {
    expect(() => mspConfigFromArgs({ "msp-node-id": true }, env({}), "worker")).toThrow(
      /needs a value/,
    );
  });

  it("rejects a blank flag value", () => {
    expect(() => mspConfigFromArgs({ "msp-node-id": "  " }, env({}), "worker")).toThrow(
      /must not be empty/,
    );
  });
});
