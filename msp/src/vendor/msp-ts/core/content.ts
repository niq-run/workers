/**
 * 工具结果值 —— 错误即值（对齐 msp-py 的 core/content.py）。
 */

/** 工具调用结果：错误即值，不抛异常（对齐 ToolResult 的语义）。 */
export class ToolResult {
  readonly content: unknown[];
  readonly structuredContent?: unknown;
  readonly error?: string;

  constructor(content: unknown[], structuredContent?: unknown, error?: string) {
    this.content = content;
    this.structuredContent = structuredContent;
    this.error = error;
  }

  get is_error(): boolean {
    return typeof this.error === "string" && this.error.length > 0;
  }

  unwrap(): unknown {
    if (this.is_error) {
      throw new Error(this.error);
    }
    return this.structuredContent !== undefined ? this.structuredContent : this.content;
  }
}
