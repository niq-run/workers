/**
 * 目录宣告 —— 把节点声明写进共享目录并周期续租（对齐 msp-py 的 DirectoryWrite）。
 *
 * timestamp 是租约：超过对端 staleAfter 未续租的声明会被视为过期，
 * 崩溃的节点因此自动从邻居表消失。写文件用 tmp + rename，避免读到半个 JSON。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { DiscoveredEndpoint } from "../discovery/base.ts";

export class DirectoryPresence {
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly nodesDir: string;
  private readonly nodeId: string;
  private readonly renewIntervalMs: number;

  constructor(nodesDir: string, nodeId: string, renewIntervalMs = 5_000) {
    this.nodesDir = nodesDir;
    this.nodeId = nodeId;
    this.renewIntervalMs = renewIntervalMs;
  }

  private declarationPath(): string {
    return path.join(this.nodesDir, `${this.nodeId}.json`);
  }

  private writeOnce(ep: DiscoveredEndpoint): void {
    const decl = {
      node_id: this.nodeId,
      endpoint: {
        transport_type: ep.transportType,
        address: { host: ep.host, port: ep.port },
      },
      timestamp: Date.now() / 1000,
    };
    const target = this.declarationPath();
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(decl, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  }

  announce(ep: DiscoveredEndpoint): void {
    fs.mkdirSync(this.nodesDir, { recursive: true });
    this.writeOnce(ep);
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        try {
          this.writeOnce(ep);
        } catch {
          /* 目录没了之类的瞬态；下个周期再试 */
        }
      }, this.renewIntervalMs);
      this.renewTimer.unref?.();
    }
  }

  withdraw(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    try {
      fs.unlinkSync(this.declarationPath());
    } catch {
      /* 本来就没有 */
    }
  }
}
