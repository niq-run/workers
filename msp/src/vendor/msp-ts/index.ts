/**
 * 公开出口。对外只暴露这些名字——内部目录结构可以动，import 路径不必跟着动。
 */

export { MSPNode } from "./node.ts";
export type { MSPNodeOptions } from "./node.ts";

export { Manifest } from "./core/manifest.ts";
export type { ToolSpec } from "./core/manifest.ts";
export { SignalType, encodeSignal, decodeSignal, makeSignal } from "./core/signal.ts";
export type { Signal } from "./core/signal.ts";
export { ToolResult } from "./core/content.ts";
export { isValidNodeId, isValidSignalPath, isValidToolName } from "./core/grammar.ts";

export { patternMatches } from "./protocol/matcher.ts";
export { FrameDecoder, frameMessage } from "./protocol/framing.ts";
export { Protocol } from "./protocol/protocol.ts";
export type { ToolHandler, SignalHandler } from "./protocol/protocol.ts";

export { TcpConnection, TcpTransport } from "./transport/tcp.ts";
export type { ConnectionLike, Endpoint, TransportLike } from "./transport/base.ts";
export { DirectoryDiscovery } from "./discovery/directory.ts";
export { DirectoryPresence } from "./presence/directory.ts";
export type { DiscoveredEndpoint, Discovery } from "./discovery/base.ts";
