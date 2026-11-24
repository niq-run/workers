/**
 * Signal —— 唯一的信封结构。
 *
 * 序列化契约（来自对 Python 参考实现的逐行核对）：**恒输出全部 8 个顶层字段**，
 * None 写成 null；读取时未知顶层键收进 extras 并原样回带。
 */

export const SignalType = {
  HELLO: "hello",
  ACK: "ack",
  SIGNAL: "signal",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  MANIFEST_UPDATE: "manifest_update",
  PING: "ping",
  PONG: "pong",
  ERROR: "error",
} as const;

export type SignalTypeValue = (typeof SignalType)[keyof typeof SignalType];

/** MSP 的统一信号结构。extras 收留线上未知顶层键，编码时原样带回。 */
export interface Signal {
  type: string;
  source: string;
  pattern: string | null;
  target: string | null;
  path: string | null;
  reqid: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
  extras: Record<string, unknown>;
}

export function makeSignal(
  type: string,
  source: string,
  opts: {
    target?: string | null;
    path?: string | null;
    reqid?: string | null;
    payload?: Record<string, unknown>;
  } = {},
): Signal {
  return {
    type,
    source,
    pattern: null,
    target: opts.target ?? null,
    path: opts.path ?? null,
    reqid: opts.reqid ?? null,
    payload: opts.payload ?? {},
    timestamp: Date.now() / 1000,
    extras: {},
  };
}

/** 固定键序只为日志可读；JSON 解析方本不关心键序。 */
export function encodeSignal(sig: Signal): Buffer {
  const out: Record<string, unknown> = {
    type: sig.type,
    source: sig.source,
    pattern: sig.pattern,
    target: sig.target,
    path: sig.path,
    reqid: sig.reqid,
    payload: sig.payload,
    timestamp: sig.timestamp,
    ...sig.extras,
  };
  return Buffer.from(JSON.stringify(out), "utf-8");
}

export function decodeSignal(data: Buffer | Uint8Array): Signal {
  const raw = JSON.parse(Buffer.from(data).toString("utf-8")) as Record<string, unknown>;
  if (typeof raw.type !== "string" || typeof raw.source !== "string") {
    throw new Error("非法 Signal：缺少 type / source");
  }
  // timestamp 仅接受数值，坏类型退回当前时间（对齐 Python 的宽容读取）
  const ts = typeof raw.timestamp === "number" ? raw.timestamp : Date.now() / 1000;
  const payload =
    raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  const known = new Set([
    "type", "source", "pattern", "target", "path", "reqid", "payload", "timestamp",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) extras[k] = v;
  }
  return {
    type: raw.type,
    source: raw.source,
    pattern: (raw.pattern as string | null) ?? null,
    target: (raw.target as string | null) ?? null,
    path: (raw.path as string | null) ?? null,
    reqid: (raw.reqid as string | null) ?? null,
    payload,
    timestamp: ts,
    extras,
  };
}

// ----------------------------------------------------------------------
