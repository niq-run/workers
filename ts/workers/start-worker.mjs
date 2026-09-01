// Generic niq worker process launcher for the @niq-ai/workers package.
//
// Usage:
//   node start-worker.mjs <name> [--key value ...]
//   npx --yes @niq-ai/workers <name> [--key value ...]
//
// Connection variables resolve in this order: explicit CLI flags, then the
// environment injected by the niq project supervisor
// (NIQ_BUS_URL / NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL).
//
// Common flags:
//   --bus-url <url>       bus base URL (else NIQ_BUS_URL)
//   --worker-id <id>      bus identity (else NIQ_WORKER_ID)
//   --credential <cred>   bus credential (else NIQ_WORKER_CREDENTIAL)
//
// Worker-specific flags (passed through to the worker's options):
//   hello:
//     --greet-event-type <t>  event type to answer (default: hello.greet)
//     --default-name <n>      name used when the request carries none (default: world)

import { HelloWorker } from "./dist/hello/index.js";

function usage() {
  console.error(
    "usage: node start-worker.mjs <name> [--key value ...]\n" +
      "  name: hello\n" +
      "  --bus-url <url>      bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>     bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>  bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      "  hello: --greet-event-type <t>, --default-name <n>",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }
  const name = args[0] || process.env.NIQ_WORKER_TYPE || "hello";
  const opts = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      console.error(`[start-worker] unexpected argument: ${a}`);
      usage();
      process.exit(1);
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { name, opts };
}

// Connection flags, mapped onto the SDK's option names. Unknown keys are left
// untouched so a worker can consume its own flags below.
const CONN_KEYS = { "bus-url": "baseURL", "worker-id": "workerID", credential: "credential" };

const { name, opts } = parseArgs(process.argv);

let worker;
switch (name) {
  case "hello": {
    const helloOpts = {};
    for (const [flag, key] of Object.entries(CONN_KEYS)) {
      if (opts[flag] !== undefined) helloOpts[key] = opts[flag];
    }
    if (opts["greet-event-type"] !== undefined) helloOpts.greetEventType = opts["greet-event-type"];
    if (opts["default-name"] !== undefined) helloOpts.defaultName = opts["default-name"];
    worker = new HelloWorker(helloOpts);
    break;
  }
  default:
    console.error(`[start-worker] unknown worker: ${name} (available: hello)`);
    usage();
    process.exit(1);
}

try {
  await worker.run();
} catch (err) {
  console.error(`[start-worker] ${name} exited:`, err);
  process.exitCode = 1;
}
