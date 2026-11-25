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
  /**
   * Newline-delimited stdin, for `mcp`. Yields complete lines as they arrive
   * (a stream, not a buffered read), so a JSON-RPC loop can answer while the
   * client keeps sending.
   */
  async *stdinLines(): AsyncIterable<string> {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of process.stdin) {
      buffer += typeof chunk === "string" ? chunk : String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim() !== "") yield buffer;
  },
};

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  io,
});
