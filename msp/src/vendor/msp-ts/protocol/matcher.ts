/**
 * 通配符匹配（对齐 msp-py 的 protocol/matcher.py）：
 *   精确      `ai.state` 只匹配自己
 *   `*` 末尾  `ai.*` 恰好一段
 *   `**` 末尾 `system.**` 零或多段（连 `system` 本身也匹配）
 */

/**
 * 通配符匹配（与 `protocol/matcher.py` 同语义）：
 *   精确        `ai.state` 只匹配 `ai.state`
 *   `*` 末尾    `ai.*` 匹配 `ai.state`，不匹配 `ai.state.sub`（恰好一段）
 *   `**` 末尾   `system.**` 匹配 `system` 及其下任意层（零或多段）
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  // 本仓库补丁：裸 `**` 视为“全匹配”（零或多段，从根开始）。上游只实现
  // `base.**`，`**` 本身不命中任何路径，导致默认订阅（全部信号）失效。
  if (pattern === "**") return true;
  if (pattern.endsWith(".**")) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(base + ".");
  }
  if (pattern.endsWith(".*")) {
    const base = pattern.slice(0, -2);
    const rest = path.startsWith(base + ".") ? path.slice(base.length + 1) : null;
    return rest !== null && rest.length > 0 && !rest.includes(".");
  }
  return false;
}

// ----------------------------------------------------------------------
