/**
 * 协议层 —— 握手、连接去重、信号分发、reqid 关联、广播扇出、探活。
 *
 * 与 msp-py 的 MSPProtocol 逐条对齐，包括它最微妙的一条：
 *
 *   连接去重仲裁。两端同时拨号时会有两条 TCP；规范方向由 node_id 字典序决定
 *   ——较小一方作为 outbound。非规范方向那条在握手完成时被关闭
 *   （入站侧甚至不回 ACK，让拨号方立刻感知）。
 */

import { decodeSignal, encodeSignal, makeSignal, SignalType } from "../core/signal.ts";
import type { Signal } from "../core/signal.ts";
import type { Manifest } from "../core/manifest.ts";
import { ToolResult } from "../core/content.ts";
import { patternMatches } from "./matcher.ts";
import type { ConnectionLike, Endpoint, TransportLike } from "../transport/base.ts";

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;
export type SignalHandler = (sig: Signal) => void;

interface PendingCall {
  resolve: (r: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProtocolOptions {
  nodeId: string;
  manifest: Manifest;
  /** 传输层由外部注入：协议层不认识 TCP，只认识 ConnectionLike。 */
  transport: TransportLike;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export class Protocol {
  readonly nodeId: string;
  private readonly manifest: Manifest;
  private readonly transport: TransportLike;
  private readonly handshakeTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;

  readonly connections = new Map<string, ConnectionLike>();
  readonly peerManifests = new Map<string, Record<string, unknown>>();
  private readonly lastSeen = new Map<string, number>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly tools = new Map<string, ToolHandler>();
  private readonly handlers: { pattern: string; cb: SignalHandler }[] = [];
  private reqCounter = 0;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly connMeta = new Map<ConnectionLike, { peerId: string }>();

  onPeerConnected: (peerId: string, manifest: Record<string, unknown>) => void = () => {};
  onPeerDisconnected: (peerId: string) => void = () => {};

  constructor(opts: ProtocolOptions) {
    this.nodeId = opts.nodeId;
    this.manifest = opts.manifest;
    this.transport = opts.transport;
    this.handshakeTimeout = opts.handshakeTimeoutMs ?? 10_000;
    this.heartbeatInterval = opts.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? 45_000;
  }

  tool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  on(pattern: string, cb: SignalHandler): void {
    this.handlers.push({ pattern, cb });
  }

  /** 开始监听，返回绑定端点。入站分发在后台跑。 */
  async listenAndServe(opts: { host?: string; port?: number } = {}): Promise<Endpoint> {
    const ep = await this.transport.listen(opts);
    this.transport.setAcceptHandler((conn) => void this.handleInbound(conn));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatInterval);
    this.heartbeatTimer.unref?.();
    return ep;
  }

  /** 主动拨号 + 出站握手。失败返回 null（不致命：对端可能也在拨我们）。 */
  async dial(ep: Endpoint): Promise<string | null> {
    let conn: ConnectionLike;
    try {
      conn = await this.transport.connect(ep);
    } catch {
      return null;
    }
    try {
      return await this.handshakeOutbound(conn);
    } catch {
      conn.close();
      return null;
    }
  }

  private async handleInbound(conn: ConnectionLike): Promise<void> {
    try {
      await this.handshakeInbound(conn);
    } catch {
      conn.close();
    }
  }

  private waitFrame(conn: ConnectionLike, timeoutMs: number): Promise<Signal> {
    return new Promise((resolve, reject) => {
      const prev = conn.onData;
      const timer = setTimeout(() => {
        conn.onData = prev;
        reject(new Error("握手超时"));
      }, timeoutMs);
      conn.onData = (frame) => {
        clearTimeout(timer);
        try {
          resolve(decodeSignal(frame));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
    });
  }

  private async handshakeOutbound(conn: ConnectionLike): Promise<string> {
    conn.send(encodeSignal(makeSignal(SignalType.HELLO, this.nodeId, {
      payload: { manifest: this.manifest.toDict() },
    })));

    // 宽容握手：参考实现（以及照抄它的实现）会在发 ACK **之前**触发
    // on_connected 回调，回调里若 call() 就会先收到 tool_call。严格只认 ACK
    // 会让双方死锁（我方等 ACK，对方等工具结果，直到超时）。
    // 所以：收到非 ACK 帧就临时登记该连接并立即处理，让对端能继续走到发 ACK。
    let ack: Signal;
    for (;;) {
      const sig = await this.waitFrame(conn, this.handshakeTimeout);
      if (sig.type === SignalType.ACK) {
        ack = sig;
        break;
      }
      if (!this.connections.has(sig.source)) {
        this.register(conn, sig.source, {});
      }
      this.dispatch(sig.source, sig);
    }
    const peerId = ack.source;
    const peerManifest = (ack.payload.manifest as Record<string, unknown>) ?? {};
    if (!this.finishHandshake(conn, peerId, peerManifest, true)) {
      throw new Error(`与 ${peerId} 的非规范连接被去重关闭`);
    }
    return peerId;
  }

  private async handshakeInbound(conn: ConnectionLike): Promise<void> {
    const hello = await this.waitFrame(conn, this.handshakeTimeout);
    if (hello.type !== SignalType.HELLO) {
      throw new Error(`握手失败，收到 ${hello.type}`);
    }
    const peerId = hello.source;
    const peerManifest = (hello.payload.manifest as Record<string, unknown>) ?? {};
    if (!this.finishHandshake(conn, peerId, peerManifest, false)) {
      return; // 非规范方向：关闭、不回 ACK（对端拨号方立刻感知）
    }
    conn.send(encodeSignal(makeSignal(SignalType.ACK, this.nodeId, {
      target: peerId,
      payload: { manifest: this.manifest.toDict() },
    })));
  }

  /** 去重仲裁：返回本条连接是否保留。规范方向 = node_id 较小一方 outbound。 */
  private finishHandshake(
    conn: ConnectionLike,
    peerId: string,
    peerManifest: Record<string, unknown>,
    outbound: boolean,
  ): boolean {
    const existing = this.connections.get(peerId);
    if (!existing) {
      this.register(conn, peerId, peerManifest);
      return true;
    }
    if (existing === conn) {
      // 握手期间已临时登记（对端在 ACK 前说过话）：补上清单即可
      this.peerManifests.set(peerId, peerManifest);
      return true;
    }
    const canonicalIsOutbound = this.nodeId < peerId;
    if (outbound === canonicalIsOutbound) {
      // 本条才是规范方向：顶掉旧的。旧连接的 onClose 看到 peerId 已指向新连接，不会误删。
      this.connMeta.delete(existing);
      existing.close();
      this.register(conn, peerId, peerManifest);
      return true;
    }
    conn.close();
    return false;
  }

  private register(conn: ConnectionLike, peerId: string, peerManifest: Record<string, unknown>): void {
    this.connections.set(peerId, conn);
    this.peerManifests.set(peerId, peerManifest);
    this.lastSeen.set(peerId, Date.now() / 1000);
    this.connMeta.set(conn, { peerId });

    conn.onData = (frame) => {
      try {
        this.dispatch(peerId, decodeSignal(frame));
      } catch {
        /* 单帧损坏不撕连接 */
      }
    };
    conn.onClose = () => {
      if (this.connMeta.get(conn)?.peerId === peerId && this.connections.get(peerId) === conn) {
        this.connections.delete(peerId);
        this.peerManifests.delete(peerId);
        this.lastSeen.delete(peerId);
        this.connMeta.delete(conn);
        // 唤醒该对端上所有挂起的调用（对齐参考实现：连接断开 → 错误即值）
        for (const [reqid, p] of [...this.pending]) {
          if (reqid.startsWith(peerId + "|")) {
            clearTimeout(p.timer);
            this.pending.delete(reqid);
            p.resolve(new ToolResult([], undefined, "连接断开"));
          }
        }
        this.onPeerDisconnected(peerId);
      }
    };
    this.onPeerConnected(peerId, peerManifest);
  }

  private dispatch(peerId: string, msg: Signal): void {
    this.lastSeen.set(peerId, Date.now() / 1000);
    switch (msg.type) {
      case SignalType.SIGNAL:
        for (const h of this.handlers) {
          if (msg.path && patternMatches(h.pattern, msg.path)) {
            try {
              h.cb(msg);
            } catch {
              /* 用户回调异常不撕连接 */
            }
          }
        }
        break;

      case SignalType.TOOL_CALL:
        void this.runTool(peerId, msg);
        break;

      case SignalType.TOOL_RESULT:
      case SignalType.ERROR: {
        if (!msg.reqid) break;
        const entry = this.pending.get(msg.reqid);
        if (!entry) break;
        this.pending.delete(msg.reqid);
        clearTimeout(entry.timer);
        if (msg.type === SignalType.TOOL_RESULT) {
          entry.resolve(new ToolResult(
            (msg.payload.content as unknown[]) ?? [],
            msg.payload.structuredContent,
            typeof msg.payload.error === "string" ? msg.payload.error : undefined,
          ));
        } else {
          const m = typeof msg.payload.message === "string" ? msg.payload.message : "对端报错";
          entry.resolve(new ToolResult([], undefined, m));
        }
        break;
      }

      case SignalType.MANIFEST_UPDATE:
        this.peerManifests.set(peerId, (msg.payload.manifest as Record<string, unknown>) ?? {});
        break;

      case SignalType.PING:
        this.send(peerId, makeSignal(SignalType.PONG, this.nodeId, { target: peerId }));
        break;

      case SignalType.PONG:
        break;

      default:
        this.send(peerId, makeSignal(SignalType.ERROR, this.nodeId, {
          target: peerId,
          reqid: msg.reqid,
          payload: { code: -32600, message: `未知信号类型: ${msg.type}` },
        }));
    }
  }

  private async runTool(peerId: string, msg: Signal): Promise<void> {
    const name = msg.payload.tool as string;
    const args = (msg.payload.args as Record<string, unknown>) ?? {};
    let payload: Record<string, unknown>;
    const handler = this.tools.get(name);
    if (!handler) {
      payload = { content: [], error: `未知工具: ${name}` };
    } else {
      try {
        const value = await handler(args);
        payload = { content: [], structuredContent: value ?? null };
      } catch (err) {
        payload = { content: [], error: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      this.send(peerId, makeSignal(SignalType.TOOL_RESULT, this.nodeId, {
        target: peerId,
        reqid: msg.reqid,
        payload,
      }));
    } catch {
      /* 对端已断 */
    }
  }

  send(peerId: string, sig: Signal): void {
    const conn = this.connections.get(peerId);
    if (!conn) throw new Error(`未连接: ${peerId}`);
    conn.send(encodeSignal(sig));
  }

  /** 调用对端工具。错误即值：任何失败都返回 ToolResult(error=...)，不抛异常。 */
  call(peerId: string, tool: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<ToolResult> {
    const conn = this.connections.get(peerId);
    if (!conn) {
      return Promise.resolve(new ToolResult([], undefined, `未连接: ${peerId}`));
    }
    const reqid = `${peerId}|ts-${this.reqCounter++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqid);
        resolve(new ToolResult([], undefined, `调用 ${tool} 超时`));
      }, timeoutMs);
      this.pending.set(reqid, { resolve, timer });
      try {
        conn.send(encodeSignal(makeSignal(SignalType.TOOL_CALL, this.nodeId, {
          target: peerId,
          reqid,
          payload: { tool, args },
        })));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqid);
        resolve(new ToolResult([], undefined, err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /** 广播：发给所有已连接对端（接收方本地 on() 过滤，无订阅表）。 */
  publish(path: string, payload: Record<string, unknown>): void {
    const sig = makeSignal(SignalType.SIGNAL, this.nodeId, { path, payload });
    for (const [, conn] of this.connections) {
      try {
        conn.send(encodeSignal(sig));
      } catch {
        /* 该连接已断，读循环负责清理 */
      }
    }
  }

  /** 清单变更后推送给所有对端。 */
  pushManifest(): void {
    const sig = makeSignal(SignalType.MANIFEST_UPDATE, this.nodeId, {
      payload: { manifest: this.manifest.toDict() },
    });
    for (const [, conn] of this.connections) {
      try {
        conn.send(encodeSignal(sig));
      } catch {
        /* 同上 */
      }
    }
  }

  private heartbeat(): void {
    if (this.stopped) return;
    const now = Date.now() / 1000;
    for (const [peerId, ts] of [...this.lastSeen]) {
      if (now - ts > this.heartbeatTimeout / 1000) {
        this.connections.get(peerId)?.close();
        continue;
      }
      try {
        this.send(peerId, makeSignal(SignalType.PING, this.nodeId, { target: peerId }));
      } catch {
        /* 已断 */
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(new ToolResult([], undefined, "节点已停止"));
    }
    this.pending.clear();
    for (const [, conn] of this.connections) conn.close();
    this.connections.clear();
    this.transport.close();
  }
}
