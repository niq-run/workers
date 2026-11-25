#!/usr/bin/env node
/**
 * Shipped as the binary `niq-interface` (@niq.run/interface-worker).
 *
 *   niq-interface <command> [options]
 *
 * The process is a thin shell around {@link runCli}: it supplies the real
 * stdout/stderr/stdin and the environment, and turns the returned code into the
 * process exit code. All logic lives in `cli.ts` so it can be tested without
 * spawning a process.
 */
import { runCli } from "./cli.js";

// A pipeline consumer that exits early (`| head`) closes stdout; that is a
// normal end of output, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});

const io = {
  out(text: string): void {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },
  err(text: string): void {
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  },
  async readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
};

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  io,
});
