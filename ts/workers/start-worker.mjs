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
//   lark (Feishu long-connection + bus bridge to reason workers):
//     connects to Feishu (LARK_APP_ID / LARK_APP_SECRET) and the bus
//     (NIQ_BUS_URL / NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL); forwards Feishu
//     messages as worker.input to the default worker named by NIQ_REASON_WORKER
//     (overridable per-chat via --reason-mappings / LARK_REASON_WORKER_MAPPINGS,
//     a JSON object of {chat_id: worker_id}). When neither a per-chat mapping
//     nor the default resolves, messages go to the last-resort fallback named by
//     --fallback-reason-worker / LARK_FALLBACK_REASON_WORKER. The chat→worker
//     routing is persisted (--state-file / LARK_STATE_FILE, default
//     ./lark-reason-state.json).
//     Proactive reason→lark messages are sent to --default-user /
//     LARK_DEFAULT_USER_ID (a Feishu open_id) when they carry no chat context.

import { HelloWorker } from "./dist/hello/index.js";
import { LarkWorker, larkConfigFromEnv } from "./dist/lark/index.js";
import { HTTPWorkerClient, readBusEnv } from "@niq.run/worker-sdk";

function connOptsFrom(opts) {
  const busOpts = {};
  for (const [flag, key] of Object.entries(CONN_KEYS)) {
    if (opts[flag] !== undefined) busOpts[key] = opts[flag];
  }
  return busOpts;
}

function buildBus(opts) {
  const overrides = connOptsFrom(opts);
  if (Object.keys(overrides).length === 0) {
    return new HTTPWorkerClient(readBusEnv());
  }
  return new HTTPWorkerClient({ ...readBusEnv(), ...overrides });
}

function usage() {
  console.error(
    "usage: node start-worker.mjs <name> [--key value ...]\n" +
      "  name: hello | lark\n" +
      "  --bus-url <url>      bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>     bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>  bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      "  hello: --greet-event-type <t>, --default-name <n>\n" +
      "  lark: --app-id <id>, --app-secret <secret> (default: LARK_APP_ID / LARK_APP_SECRET), " +
      "--default-user <open_id> (default: LARK_DEFAULT_USER_ID), --reason-worker <id> (default: NIQ_REASON_WORKER), " +
      "--fallback-reason-worker <id> (default: LARK_FALLBACK_REASON_WORKER), " +
      "--reason-mappings <json> (default: LARK_REASON_WORKER_MAPPINGS; {chat_id: worker_id}), " +
      "--state-file <path> (default: LARK_STATE_FILE / ./lark-reason-state.json)",
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
    const helloOpts = connOptsFrom(opts);
    if (opts["greet-event-type"] !== undefined) helloOpts.greetEventType = opts["greet-event-type"];
    if (opts["default-name"] !== undefined) helloOpts.defaultName = opts["default-name"];
    worker = new HelloWorker(helloOpts);
    break;
  }
  case "lark": {
    // Feishu long-connection + bus bridge to reason workers.
    // Env-priority: NIQ_BUS_* / NIQ_WORKER_* (supervisor-injected) + LARK_*
    // / NIQ_REASON_WORKER / LARK_REASON_WORKER; CLI flags override for convenience.
    const bus = buildBus(opts);
    const reasonWorkerID =
      opts["reason-worker"] ??
      process.env.NIQ_REASON_WORKER ??
      process.env.LARK_REASON_WORKER ??
      "";
    const fallbackReasonWorkerID =
      opts["fallback-reason-worker"] ??
      process.env.LARK_FALLBACK_REASON_WORKER ??
      "";
    if (!reasonWorkerID && !fallbackReasonWorkerID) {
      console.error("[start-worker] lark: at least one of NIQ_REASON_WORKER / --reason-worker or LARK_FALLBACK_REASON_WORKER / --fallback-reason-worker must be set (the bound reason worker id; fallback is the last resort)");
      process.exit(1);
    }
    const lark = larkConfigFromEnv();
    if (opts["app-id"] !== undefined) lark.appId = opts["app-id"];
    if (opts["app-secret"] !== undefined) lark.appSecret = opts["app-secret"];
    if (opts["domain"] !== undefined) lark.domain = opts["domain"];
    const defaultUserOpenId =
      opts["default-user"] ?? process.env.LARK_DEFAULT_USER_ID ?? "";

    // Optional initial chat → reason worker routing from config.
    let reasonWorkerMappings;
    const mappingsRaw =
      opts["reason-mappings"] ?? process.env.LARK_REASON_WORKER_MAPPINGS;
    if (mappingsRaw) {
      let parsed;
      try {
        parsed = JSON.parse(mappingsRaw);
      } catch (e) {
        console.error("[start-worker] lark: invalid reason mappings JSON:", e.message);
        process.exit(1);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error("[start-worker] lark: reason mappings must be an object of {chat_id: worker_id}");
        process.exit(1);
      }
      reasonWorkerMappings = parsed;
    }

    const stateFile = opts["state-file"] ?? process.env.LARK_STATE_FILE ?? "";
    worker = new LarkWorker({
      ...lark,
      bus,
      ...(reasonWorkerID ? { reasonWorkerID } : {}),
      ...(fallbackReasonWorkerID ? { fallbackReasonWorkerID } : {}),
      ...(reasonWorkerMappings ? { reasonWorkerMappings } : {}),
      ...(stateFile ? { stateFile } : {}),
      ...(defaultUserOpenId ? { defaultUserOpenId } : {}),
    });
    break;
  }
  default:
    console.error(`[start-worker] unknown worker: ${name} (available: hello, lark)`);
    usage();
    process.exit(1);
}

try {
  await worker.run();
} catch (err) {
  console.error(`[start-worker] ${name} exited:`, err);
  process.exitCode = 1;
}
