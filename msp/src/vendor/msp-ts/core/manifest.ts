/**
 * Manifest —— 节点能力清单，握手时交换、变更时推送。
 */

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputTypes?: string[];
  annotations?: Record<string, unknown>;
}

/** 能力清单。版本号在每次变更时 +1，对端靠它判断「清单变没变」。 */
export class Manifest {
  version = 0;
  patterns: string[] = [];
  patternMetadata: Record<string, unknown> = {};
  capabilities: string[] = [];
  signals: { path: string; schema?: Record<string, unknown>; description?: string }[] = [];
  tools: ToolSpec[] = [];
  resources: unknown[] = [];
  prompts: unknown[] = [];
  clientCapabilities = { sampling: false, elicitation: false, roots: false };

  addTool(spec: ToolSpec): void {
    const existing = this.tools.findIndex((t) => t.name === spec.name);
    if (existing >= 0) this.tools[existing] = spec;
    else this.tools.push(spec);
    this.version += 1;
  }

  addSignal(path: string, opts: { schema?: Record<string, unknown>; description?: string } = {}): void {
    if (!this.signals.some((s) => s.path === path)) {
      this.signals.push({ path, schema: opts.schema, description: opts.description });
      this.version += 1;
    }
  }

  toDict(): Record<string, unknown> {
    return {
      version: this.version,
      patterns: [...this.patterns],
      patternMetadata: { ...this.patternMetadata },
      capabilities: [...this.capabilities].sort(),
      signals: this.signals.map((s) => ({
        path: s.path,
        ...(s.schema && Object.keys(s.schema).length > 0 ? { schema: s.schema } : {}),
        ...(s.description ? { description: s.description } : {}),
      })),
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? {},
        outputTypes: t.outputTypes ?? [],
        annotations: t.annotations ?? {},
      })),
      resources: [...this.resources],
      prompts: [...this.prompts],
      clientCapabilities: { ...this.clientCapabilities },
    };
  }
}

// ----------------------------------------------------------------------
