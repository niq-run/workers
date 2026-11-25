#!/usr/bin/env node
/**
 * Shipped as the binary `niq-hello` (@niq.run/hello-worker). This is the
 * "worker as an app" entrypoint:
 *
 *   node dist/start.js [--key value ...]
 *
 * It is deliberately thin: parse flags, build the worker, run it. Parsing,
 * connection layering and failure handling come from the SDK so every worker's
 * launcher looks the same:
 *
 *   parseCliArgs     map `--key value` / `--key` into an object, flag `--help`
 *   busConnFromArgs  layer --bus-url / --worker-id / --credential over the
 *                    supervisor-injected env (NIQ_BUS_URL / NIQ_WORKER_ID /
 *                    NIQ_WORKER_CREDENTIAL)
 *   runWorkerApp     run the body; on failure log and set exit code 1
 *
 * Config precedence in this worker is flags > env > default; see worker.ts.
 */
import { busConnFromArgs, parseCliArgs, runWorkerApp } from "@niq.run/worker-sdk";
import { DEFAULT_NAME_ENV, HelloWorker } from "./worker.js";

function usage(): void {
  console.error(
    "usage: niq-hello [--key value ...]\n" +
      "  --bus-url <url>        bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>       bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>    bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      `  --default-name <name>  name used when a request carries none (else ${DEFAULT_NAME_ENV}; default: world)\n` +
      "  --help                 print this help",
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
    ...conn,
    ...(opts["default-name"] !== undefined
      ? { defaultName: String(opts["default-name"]) }
      : {}),
  });

  // Diagnostics go to stderr; stdout stays free for anything the worker might
  // print for a caller. Log only non-secret facts.
  console.error(
    `[hello] ${worker.id} connecting to ${conn.baseURL} (serve hello.greet, hello.stats)`,
  );

  // Stop on Ctrl-C / SIGTERM instead of dying mid-handler. `close()` drains
  // in-flight work before closing the stream.
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await worker.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await worker.run();
  // The bus closed the stream (shutdown or restart): release the connection.
  await worker.close().catch(() => {});
});
