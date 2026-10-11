/**
 * Tavily worker — a web-search bridge for niq. It subscribes to `tavily.search`
 * requests, runs the query through the Tavily API, and answers with the answer
 * + top sources. Built on `@niq.run/worker-sdk`.
 *
 * Flow:
 *   reason worker ── tavily.search ──▶ this worker ── Tavily API ──▶ reply
 *     (request.completed: answer + top sources / request.failed on error)
 *
 * Connection comes from explicit options or the `NIQ_BUS_*` environment
 * (supervisor-injected); the Tavily API key comes from `TAVILY_API_KEY`.
 */
import {
  BaseWorker,
  HTTPWorkerClient,
  readBusEnv,
  type Event,
  type HTTPWorkerClientOptions,
} from "@niq.run/worker-sdk";
import { tavily, type TavilyClient, type TavilyExtractOptions, type TavilySearchOptions } from "@tavily/core";

export interface TavilyWorkerOptions
  extends Omit<HTTPWorkerClientOptions, "baseURL" | "workerID" | "credential"> {
  /** Bus base URL. Optional — falls back to `NIQ_BUS_URL`. */
  baseURL?: string;
  /** Worker identity registered on the bus. Optional — falls back to `NIQ_WORKER_ID`. */
  workerID?: string;
  /** Credential for this worker. Optional — falls back to `NIQ_WORKER_CREDENTIAL`. */
  credential?: string;
  /** Tavily API key. Optional — falls back to the `TAVILY_API_KEY` env var. */
  apiKey?: string;
  /** Event type this worker answers. Defaults to `tavily.search`. */
  searchEventType?: string;
  /** Event type this worker answers for URL extraction. Defaults to `tavily.extract`. */
  extractEventType?: string;
  /** Default search options, merged under the per-request payload options. */
  defaultSearchOptions?: TavilySearchOptions;
  /** Injectable Tavily client (for tests / custom transport). Defaults to `tavily({ apiKey })`. */
  client?: TavilyClient;
  /** Environment to consult for connection + API key. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Map a `tavily.search` request payload to the Tavily search options we forward. */
export function searchOptionsFrom(
  payload: Record<string, unknown>,
): TavilySearchOptions {
  const out: Record<string, unknown> = {};
  for (const k of ["maxResults", "days", "maxTokens", "maxAgeHours"] as const) {
    const v = payload[k];
    if (typeof v === "number") out[k] = v;
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
      out[k] = Number(v);
  }
  for (const k of ["searchDepth", "topic", "timeRange", "country", "language"] as const) {
    const v = payload[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  for (const k of ["includeAnswer", "includeImages", "includeRawContent"] as const) {
    const v = payload[k];
    if (typeof v === "boolean") out[k] = v;
  }
  for (const k of ["includeDomains", "excludeDomains"] as const) {
    const v = payload[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
  }
  return out as TavilySearchOptions;
}

/** Map an `tavily.extract` request payload to the Tavily extract options we forward. */
export function extractOptionsFrom(
  payload: Record<string, unknown>,
): TavilyExtractOptions {
  const out: Record<string, unknown> = {};
  for (const k of ["format", "extractDepth"] as const) {
    const v = payload[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  for (const k of ["includeImages", "includeFavicon", "includeUsage"] as const) {
    const v = payload[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out as TavilyExtractOptions;
}

export class TavilyWorker {
  private readonly base: BaseWorker;
  private readonly tvly: TavilyClient;
  private readonly searchType: string;
  private readonly extractType: string;
  private readonly defaults: TavilySearchOptions;

  constructor(opts: TavilyWorkerOptions) {
    // Explicit options win; env is consulted only for the fields not provided.
    const needsEnv = !opts.baseURL || !opts.workerID || !opts.credential;
    const env = {
      ...(needsEnv ? readBusEnv(opts.env) : {}),
      ...nonEmpty(opts),
    } as Required<Pick<HTTPWorkerClientOptions, "baseURL" | "workerID" | "credential">>;

    const apiKey = opts.apiKey ?? opts.env?.TAVILY_API_KEY ?? process.env.TAVILY_API_KEY;
    this.tvly =
      opts.client ??
      (() => {
        if (!apiKey) {
          throw new Error("niq tavily: TAVILY_API_KEY is required (set env or pass apiKey)");
        }
        return tavily({ apiKey });
      })();

    this.base = new BaseWorker({
      id: env.workerID,
      subscriptions: [{ type: opts.searchEventType ?? "tavily.search" }],
      channel: new HTTPWorkerClient({
        baseURL: env.baseURL,
        workerID: env.workerID,
        credential: env.credential,
        fetchImpl: opts.fetchImpl,
        logger: opts.logger,
      }),
    });
    this.searchType = opts.searchEventType ?? "tavily.search";
    this.extractType = opts.extractEventType ?? "tavily.extract";
    this.defaults = opts.defaultSearchOptions ?? {};
    this.base.register(
      {
        event: this.searchType,
        description:
          "Runs a Tavily web search for the payload's query and replies with the answer + top sources.",
      },
      (evt) => this.handleSearch(evt),
    );
    this.base.register(
      {
        event: this.extractType,
        description:
          "Extracts the readable content from the payload's url (and returns the title + page content).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "http(s) URL to extract" },
            format: { type: "string", description: "markdown | text" },
            extractDepth: { type: "string", description: "basic | advanced" },
            includeImages: { type: "boolean" },
          },
        },
      },
      (evt) => this.handleExtract(evt),
    );
  }

  async run(): Promise<void> {
    await this.base.channel.connect();
    await this.base.announceReady("tavily");

    for await (const evt of this.base.channel.events()) {
      this.base.dispatchExtension(evt);
    }
  }

  async close(): Promise<void> {
    await this.base.channel.close();
  }

  private async handleSearch(evt: Event): Promise<void> {
    // A notification (no request_id) expects no reply.
    if (!evt.request_id) return;

    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    if (!query) {
      await this.base.replyFailed(
        evt.worker_id,
        evt.request_id,
        "tavily: payload.query is required",
        evt.trace_id,
      );
      return;
    }

    const options: TavilySearchOptions = {
      ...this.defaults,
      ...searchOptionsFrom(payload),
    };

    try {
      const res = await this.tvly.search(query, options);
      const lines: string[] = [];
      if (typeof res.answer === "string" && res.answer !== "") {
        lines.push(res.answer, "");
      }
      lines.push(`Sources (${res.results.length}):`);
      for (const r of res.results.slice(0, this.defaults.maxResults ?? 5)) {
        lines.push(`- ${r.title}\n  ${r.url}`);
      }
      await this.base.replyCompleted(
        evt.worker_id,
        evt.request_id,
        lines.join("\n"),
        evt.trace_id,
      );
    } catch (err) {
      await this.base.replyFailed(
        evt.worker_id,
        evt.request_id,
        `tavily: ${(err as Error).message}`,
        evt.trace_id,
      );
    }
  }

  private async handleExtract(evt: Event): Promise<void> {
    // A notification (no request_id) expects no reply.
    if (!evt.request_id) return;

    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    const url = typeof payload.url === "string" ? payload.url.trim() : "";
    if (!url) {
      await this.base.replyFailed(
        evt.worker_id,
        evt.request_id,
        "tavily: payload.url is required",
        evt.trace_id,
      );
      return;
    }

    const options = extractOptionsFrom(payload);
    try {
      const res = await this.tvly.extract([url], options);
      const parts: string[] = [];
      for (const r of res.results ?? []) {
        const title = r.title || r.url;
        const raw = r.rawContent ?? "";
        const truncated = raw.length > MAX_EXTRACT_LEN;
        parts.push(
          `## ${title}\n\n${raw.slice(0, MAX_EXTRACT_LEN)}${truncated ? "\n\n[content truncated]" : ""}`,
        );
      }
      const failed = res.failedResults ?? [];
      if (failed.length > 0) {
        parts.push(`Failed: ${failed.map((f) => `${f.url} (${f.error})`).join(", ")}`);
      }
      await this.base.replyCompleted(
        evt.worker_id,
        evt.request_id,
        parts.join("\n\n---\n\n") || "tavily: no content extracted",
        evt.trace_id,
      );
    } catch (err) {
      await this.base.replyFailed(
        evt.worker_id,
        evt.request_id,
        `tavily: ${(err as Error).message}`,
        evt.trace_id,
      );
    }
  }
}

/** Cap on the extracted page content included in one reply. */
/** Cap on the extracted page content included in one reply. */
const MAX_EXTRACT_LEN = 16000;

/** Pick the explicitly-provided connection fields (non-empty wins over env). */
function nonEmpty(opts: TavilyWorkerOptions): Partial<HTTPWorkerClientOptions> {
  const out: Partial<HTTPWorkerClientOptions> = {};
  if (opts.baseURL) out.baseURL = opts.baseURL;
  if (opts.workerID) out.workerID = opts.workerID;
  if (opts.credential) out.credential = opts.credential;
  return out;
}