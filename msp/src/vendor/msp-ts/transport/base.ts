/**
 * 传输层契约 —— 协议层只认这两个接口，不认具体实现。
 *
 * TS 是结构类型，`TcpConnection` 不声明 implements 也能满足 `ConnectionLike`；
 * 显式留接口是为了 M5 的浏览器 WS 传输能对着契约实现，而不是对着 TCP 抄。
 */

export interface Endpoint {
  host: string;
  port: number;
}

export interface ConnectionLike {
  readonly peerHost: string;
  readonly isClosed: boolean;
  /** 收帧回调（协议层在每个阶段替换它：握手期 / 正常期）。 */
  onData: (frame: Buffer) => void;
  onClose: () => void;
  send(frame: Buffer): void;
  close(): void;
}

export interface TransportLike {
  listen(opts?: { host?: string; port?: number }): Promise<Endpoint>;
  /** 入站连接分发；handler 到位前抵达的连接由实现自行缓存。 */
  setAcceptHandler(cb: (conn: ConnectionLike) => void): void;
  connect(ep: Endpoint, timeoutMs?: number): Promise<ConnectionLike>;
  close(): void;
}
