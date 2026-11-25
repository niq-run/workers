/**
 * Exit codes and the one error type the CLI uses.
 *
 * Everything a command can fail with is a {@link CliError}: `message` is the
 * human line written to stderr, `detail` is an optional structured payload
 * written to stdout (so a caller that parses JSON still gets the reply of a
 * failed request, not just a string), and `exitCode` is what the process
 * returns. Keeping all three together is what lets `runCli` report failures
 * uniformly without each command knowing about stderr or process.exitCode.
 */

/** The command succeeded. */
export const EXIT_OK = 0;
/** The command could not do what was asked (network, auth, ACL, timeout, …). */
export const EXIT_FAILURE = 1;
/** The invocation itself was wrong (unknown command/flag, bad argument). */
export const EXIT_USAGE = 2;

export interface CliErrorOptions {
  /** Process exit code. Defaults to {@link EXIT_FAILURE}. */
  exitCode?: number;
  /** Structured value printed to stdout before the stderr message. */
  detail?: unknown;
  /** Underlying error, kept for programmatic callers/tests. */
  cause?: unknown;
}

/** An error meant to reach the user as a one-line message (plus optional JSON). */
export class CliError extends Error {
  readonly exitCode: number;
  readonly detail?: unknown;

  constructor(message: string, opts: CliErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? EXIT_FAILURE;
    this.detail = opts.detail;
  }
}

/** A wrong invocation: reported before any config or network work happens. */
export function usageError(message: string): CliError {
  return new CliError(message, { exitCode: EXIT_USAGE });
}
