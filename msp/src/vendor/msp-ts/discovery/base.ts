/**
 * 发现层契约 —— 产出 Endpoint，不关心传输与协议。
 *
 * 与 msp-py 的 discovery/base.py 对应：`DiscoveredEndpoint` 是 discovery 与
 * transport 之间的统一货币（transport_type + address + node_id）。
 */

export interface DiscoveredEndpoint {
  transportType: string;
  host: string;
  port: number;
  nodeId: string;
}

export interface Discovery {
  /** 开始监听（目录实现里是轮询）。立即扫一次，不等第一个周期。 */
  start(): void;
  stop(): void;
  onAdd: (ep: DiscoveredEndpoint) => void;
  onRemove: (nodeId: string) => void;
}
