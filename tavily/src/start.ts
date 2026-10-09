#!/usr/bin/env node
/**
 * Shipped as the binary `niq-tavily` (@niq.run/tavily-worker). Entry point for
 * running the tavily worker as its own process (the "worker as an app" model):
 *
 *   node dist/start.js [--key value ...]
 *
 * Connection params come from explicit flags or the supervisor-injected env
 * (NIQ_BUS_URL / NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL), merged by the SDK
 * helper `busConnFromArgs`. The Tavily API key comes from `TAVILY_API_KEY`.
 *
 * Flags:
 *   --bus-url <url>         bus base URL (else NIQ_BUS_URL)
 *   --worker-id <id>        bus identity (else NIQ_WORKER_ID)
 *   --credential <cred>     bus credential (else NIQ_WORKER_CREDENTIAL)
 *   --api-key <key>         Tavily API key (else TAVILY_API_KEY)
 *   --search-event-type <t> event type to answer (default: tavily.search)
 *   --max-results <n>       default max results (default: 5)
 */
import { busConnFromArgs, parseCliArgs, runWorkerApp } from "@niq.run/worker-sdk";
import { TavilyWorker } from "./worker.js";

function usage(): void {
  console.error(
    "usage: niq-tavily [--key value ...]\n" +
      "  --bus-url <url>         bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>        bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>     bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      "  --api-key <key>         Tavily API key (else TAVILY_API_KEY)\n" +
      "  --search-event-type <t> event type to answer (default: tavily.search)\n" +
      "  --max-results <n>       default max results (default: 5)",
  );
}

const { help, opts } = parseCliArgs(process.argv);
if (help) {
  usage();
  process.exit(0);
}

await runWorkerApp(async () => {
  const conn = busConnFromArgs(opts);
  const maxResults =
    opts["max-results"] !== undefined ? Number(opts["max-results"]) : undefined;

  const worker = new TavilyWorker({
    baseURL: conn.baseURL,
    workerID: conn.workerID,
    credential: conn.credential,
    ...(opts["api-key"] !== undefined ? { apiKey: String(opts["api-key"]) } : {}),
    ...(opts["search-event-type"] !== undefined
      ? { searchEventType: String(opts["search-event-type"]) }
      : {}),
    ...(maxResults !== undefined && Number.isFinite(maxResults)
      ? { defaultSearchOptions: { maxResults } }
      : {}),
  });
  await worker.run();
});