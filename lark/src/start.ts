#!/usr/bin/env node
/**
 * Shipped as the binary `niq-lark` (@niq-ai/lark-worker). Entry point for
 * running the Lark/Feishu worker as its own process (the "worker as an app"
 * model):
 *
 *   node dist/start.js [--key value ...]
 *
 * Feishu long-connection + bus bridge to reason workers. Connects to Feishu
 * (LARK_APP_ID / LARK_APP_SECRET) and the bus (NIQ_BUS_URL /
 * NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL, merged by the SDK helper
 * `busConnFromArgs`); forwards Feishu messages as worker.input to the default
 * worker named by NIQ_REASON_WORKER (overridable per-chat via --reason-mappings
 * / LARK_REASON_WORKER_MAPPINGS, a JSON object of {chat_id: worker_id}). When
 * neither a per-chat mapping nor the default resolves, messages go to the
 * last-resort fallback named by --fallback-reason-worker /
 * LARK_FALLBACK_REASON_WORKER. The chat→worker routing is persisted
 * (--state-file / LARK_STATE_FILE, default ./lark-reason-state.json).
 *
 * Proactive reason→lark messages use lark.send with no target and fall back to
 * --default-user / LARK_DEFAULT_USER_ID (a Feishu open_id) when the reason
 * worker supplies no explicit target.
 */
import {
  HTTPWorkerClient,
  busConnFromArgs,
  parseCliArgs,
  runWorkerApp,
} from "@niq.run/worker-sdk";
import { LarkWorker, larkConfigFromEnv, type LarkBridgeOptions } from "./worker.js";

function usage(): void {
  console.error(
    "usage: niq-lark [--key value ...]\n" +
      "  --bus-url <url>      bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>     bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>  bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      "  lark: --app-id <id>, --app-secret <secret> (default: LARK_APP_ID / LARK_APP_SECRET), " +
      "--default-user <open_id> (default: LARK_DEFAULT_USER_ID), --reason-worker <id> (default: NIQ_REASON_WORKER), " +
      "--fallback-reason-worker <id> (default: LARK_FALLBACK_REASON_WORKER), " +
      "--reason-mappings <json> (default: LARK_REASON_WORKER_MAPPINGS; {chat_id: worker_id}), " +
      "--state-file <path> (default: LARK_STATE_FILE / ./lark-reason-state.json)",
  );
}

const { help, opts } = parseCliArgs(process.argv);
if (help) {
  usage();
  process.exit(0);
}

await runWorkerApp(async () => {
  const bus = new HTTPWorkerClient(busConnFromArgs(opts));

  const reasonWorkerID = String(
    opts["reason-worker"] ?? process.env.NIQ_REASON_WORKER ?? process.env.LARK_REASON_WORKER ?? "",
  );
  const fallbackReasonWorkerID = String(
    opts["fallback-reason-worker"] ?? process.env.LARK_FALLBACK_REASON_WORKER ?? "",
  );
  if (!reasonWorkerID && !fallbackReasonWorkerID) {
    throw new Error(
      "at least one of NIQ_REASON_WORKER / --reason-worker or LARK_FALLBACK_REASON_WORKER / --fallback-reason-worker must be set (bound reason worker id; fallback is the last resort)",
    );
  }

  const lark = larkConfigFromEnv();
  if (opts["app-id"] !== undefined) lark.appId = String(opts["app-id"]);
  if (opts["app-secret"] !== undefined) lark.appSecret = String(opts["app-secret"]);
  if (opts["domain"] !== undefined) lark.domain = String(opts["domain"]);
  const defaultUserOpenId = String(opts["default-user"] ?? process.env.LARK_DEFAULT_USER_ID ?? "");

  // Optional initial chat → reason worker routing from config.
  let reasonWorkerMappings: Record<string, string> | undefined;
  const mappingsRaw = opts["reason-mappings"] ?? process.env.LARK_REASON_WORKER_MAPPINGS;
  if (mappingsRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(mappingsRaw));
    } catch (err) {
      throw new Error(`invalid reason mappings JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("reason mappings must be an object of {chat_id: worker_id}");
    }
    reasonWorkerMappings = parsed as Record<string, string>;
  }

  const stateFile = String(opts["state-file"] ?? process.env.LARK_STATE_FILE ?? "");

  const workerOpts: LarkBridgeOptions = {
    ...lark,
    bus,
    ...(reasonWorkerID ? { reasonWorkerID } : {}),
    ...(fallbackReasonWorkerID ? { fallbackReasonWorkerID } : {}),
    ...(reasonWorkerMappings ? { reasonWorkerMappings } : {}),
    ...(stateFile ? { stateFile } : {}),
    ...(defaultUserOpenId ? { defaultUserOpenId } : {}),
  };

  const worker = new LarkWorker(workerOpts);
  await worker.run();
});