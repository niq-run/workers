/**
 * @niq-ai/workers — a collection of niq Workers.
 *
 * Each worker lives in its own subpath, e.g. `@niq-ai/workers/feishu`.
 * The root module only exposes a registry of available workers so importing
 * the root package does not pull in any worker's dependencies.
 */

/** Metadata describing a worker in this collection. */
export interface WorkerEntry {
  /** Subpath to import this worker from, e.g. `@niq-ai/workers/feishu`. */
  importPath: string;
  /** One-line description of what the worker does. */
  description: string;
}

/** Registry of workers shipped in this package. */
export const WORKERS: WorkerEntry[] = [
  {
    importPath: "@niq-ai/workers/hello",
    description: "Minimal demo worker: answers hello.greet requests with a greeting.",
  },
  {
    importPath: "@niq-ai/workers/lark",
    description: "Feishu WebSocket bridge: relays Feishu messages to a bound reason worker and pushes its replies back.",
  },
];
