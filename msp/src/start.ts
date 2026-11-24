#!/usr/bin/env node
/**
 * Shipped as the binary `niq-msp` (@niq.run/msp-worker). Entry point for
 * running the MSP interface worker as its own process:
 *
 *   node dist/start.js [--key value ...]
 *
 * The worker is an interface worker (the niq side — identity, presence, tool
 * dispatch, replies — comes from the shared SDK base) whose backend is an MSP
 * node built on the vendored MSP TypeScript SDK.
 *
 * Bus connection comes from `busConnFromArgs` (flags `--bus-url` / `--worker-id`
 * / `--credential` layered over `NIQ_BUS_URL` / `NIQ_WORKER_ID` /
 * `NIQ_WORKER_CREDENTIAL`).
 *
 * The MSP side: `MSP_NODE_ID` (default: niq worker id, sanitized), `MSP_NODES_DIR`
 * (the shared discovery directory), `MSP_HOST` / `MSP_PORT` (the TCP bind),
 * `MSP_CONNECT_POLICY` (eager / lazy), `MSP_SUBSCRIBE` (signal patterns to
 * forward to niq), `MSP_SIGNAL_EVENT` (the niq event type inbound signals
 * become), `MSP_SIGNAL_TARGET` (a niq worker to direct them to; default
 * broadcast), and `MSP_DECLARE_SIGNALS` (paths advertised in the manifest).
 *
 * MSP runs over plain TCP with no TLS and no authentication: only use it on a
 * trusted local host or LAN, and keep `MSP_HOST` on the loopback interface
 * unless you really mean to expose it.
 */
import { busConnFromArgs, parseCliArgs, runWorkerApp } from "@niq.run/worker-sdk";
import { mspConfigFromArgs } from "./config.js";
import { MspWorker } from "./worker.js";

function usage(): void {
  console.error(
    "usage: niq-msp [--key value ...]\n" +
      "  --bus-url <url>          bus base URL (else NIQ_BUS_URL)\n" +
      "  --worker-id <id>         bus identity (else NIQ_WORKER_ID)\n" +
      "  --credential <cred>      bus credential (else NIQ_WORKER_CREDENTIAL)\n" +
      "  msp:\n" +
      "  --msp-node-id <id>       MSP node id, ^[a-z0-9_-]+$ (else MSP_NODE_ID; default: worker id)\n" +
      "  --msp-nodes-dir <dir>    shared discovery directory (else MSP_NODES_DIR; default ~/.msp/nodes)\n" +
      "  --msp-host <host>        TCP bind host (else MSP_HOST; default 127.0.0.1)\n" +
      "  --msp-port <port>        TCP bind port, 0 = ephemeral (else MSP_PORT; default 0)\n" +
      "  --msp-connect-policy <p> eager | lazy (else MSP_CONNECT_POLICY; default eager)\n" +
      "  --msp-subscribe <list>   comma-separated signal patterns to forward (else MSP_SUBSCRIBE; default **)\n" +
      "  --msp-signal-event <evt> niq event type for inbound signals (else MSP_SIGNAL_EVENT; default msp.signal)\n" +
      "  --msp-signal-target <id> niq worker to direct signals to (else MSP_SIGNAL_TARGET; default broadcast)\n" +
      "  --msp-call-timeout-ms <n> default msp.call timeout (else MSP_CALL_TIMEOUT_MS; default 5000)\n" +
      "  --msp-declare-signals <list> comma-separated signal paths to advertise (else MSP_DECLARE_SIGNALS)",
  );
}

const { help, opts } = parseCliArgs(process.argv);
if (help) {
  usage();
  process.exit(0);
}

await runWorkerApp(async () => {
  const conn = busConnFromArgs(opts);
  const msp = mspConfigFromArgs(opts, process.env, conn.workerID);
  const worker = new MspWorker({ ...conn, ...msp, logger: console });

  // Withdraw the MSP presence entry on Ctrl-C / SIGTERM instead of leaving a
  // dead endpoint in the shared discovery directory for peers to dial.
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
  // The bus stream ended (bus restart / shutdown): release the MSP node too.
  await worker.close().catch(() => {});
});
