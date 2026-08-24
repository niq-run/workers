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
    importPath: "@niq-ai/workers/feishu",
    description: "Bridges events to Feishu (Lark) by sending messages on demand.",
  },
];
