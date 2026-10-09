#!/usr/bin/env node
/**
 * Shipped as the binary `niq-hello` (@niq-ai/hello-worker). Entry point for
 * running the hello worker as its own process (the "worker as an app" model):
 *
 *   node dist/start.js [--key value ...]
 *
 * Connection params come from explicit flags or the supervisor-injected env
 * (NIQ_BUS_URL / NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL), merged by the SDK
 * helper `busConnFromArgs`.
 *
 * Flags:
 *   --bus-url <url>        bus base URL (else NIQ_BUS_URL)
 *   --worker-id <id>       bus identity (else NIQ_WORKER_ID)
 *   --credential <cred>    bus credential (else NIQ_WORKER_CREDENTIAL)
 *   --greet-event-type <t> event type to answer (default: hello.greet)
 *   --default-name <n>     name used when the request carries none (default: world)
 */
import { busConnFromArgs, parseCliArgs, runWorkerApp } from "@niq.run/worker-sdk";
import { HelloWorker } from "./worker.js";

function usage(): void {
  console.error(
    "usage: niq-hello [--key value ...]\n" +
      "  --bus-url <url>        bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>       bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>    bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      "  --greet-event-type <t> event type to answer (default: hello.greet)\n" +
      "  --default-name <n>     name used when the request carries none (default: world)",
  );
}

const { help, opts } = parseCliArgs(process.argv);
if (help) {
  usage();
  process.exit(0);
}

await runWorkerApp(async () => {
  const conn = busConnFromArgs(opts);
  const worker = new HelloWorker({
    baseURL: conn.baseURL,
    workerID: conn.workerID,
    credential: conn.credential,
    ...(opts["greet-event-type"] !== undefined ? { greetEventType: String(opts["greet-event-type"]) } : {}),
    ...(opts["default-name"] !== undefined ? { defaultName: String(opts["default-name"]) } : {}),
  });
  await worker.run();
});