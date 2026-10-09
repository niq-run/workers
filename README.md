# workers

This repository hosts **niq extension workers** — interesting and useful workers
that don't belong in the core niq runtime but are fine to ship on their own.
Each worker is an **independent project** (own package, own launcher).

> **Status: early, moving fast.** Like niq itself, this is early-stage and APIs
> may change without notice.

## What is a Worker

In niq, a **Worker** is the single extension concept: an actor-like unit that
holds its own state and communicates only by sending and reacting to messages
over an event bus. Every worker in this repo is such a unit, implemented in
TypeScript and connecting to the bus over the bus protocol (HTTP + SSE) with the
TypeScript SDK.

## Repository layout

Flat, one directory per worker:

```
workers/
├── package.json     # npm workspace root — an entry exists for each worker below
├── tsconfig.base.json
├── hello/           # @niq-run/hello-worker — minimal demo (bin: niq-hello)
└── lark/            # @niq-run/lark-worker  — Feishu WebSocket bridge (bin: niq-lark)
```

- Each worker is an independent npm package with its own `bin`, e.g.
  `niq-hello`, `niq-lark`. The `bin` targets a compiled app entry
  (`dist/start.js`, built from `src/start.ts`), so each worker runs as a
  standalone app with one command — the MCP-server style.
- Workers depend on the **`@niq.run/worker-sdk` npm package** (published from the
  [niq core repo](https://github.com/niq-run/niq), under `niq/sdk/ts`). The
  `start.ts` entrypoints reuse the SDK's CLI helpers (`parseCliArgs`,
  `busConnFromArgs`, `runWorkerApp`) so connection bootstrap and arg parsing
  aren't re-implemented per worker.

## Install

```sh
npm install -g @niq-run/hello-worker
npm install -g @niq-run/lark-worker
```

Then run each worker's own launcher, or import it in code:

```ts
import { LarkWorker, larkConfigFromEnv } from "@niq-run/lark-worker";
```

## Current workers

| Package | Launcher | Description |
|---|---|---|
| `@niq-run/hello-worker` | `niq-hello` | Minimal demo worker: answers `hello.greet` requests with a `request.completed` greeting |
| `@niq-run/lark-worker` | `niq-lark` | Feishu long-connection bridge: connects to Lark over WebSocket and forwards inbound messages to a reason worker, selected per-chat via a persistent routing map (per-chat → default → fallback), pushing the reason reply (its `send_message` → `worker.input`) back to the Feishu chat. See [`lark/src/README.md`](lark/src/README.md) |

## Add a worker

1. Create the worker as its own package under this repo: `src/worker.ts` (the worker
   class + config helpers, importable in-process or by tests) plus `src/start.ts`
   (the `#!/usr/bin/env node` entrypoint compiled to `dist/start.js`, which is what
   the package `bin` points at — this is what makes the worker usable as a standalone
   app run with one command). Add a `package.json` with the `bin` field, and a
   `tsconfig.json` extending `../tsconfig.base.json`.
2. Register it in the `workspaces` array of the root `package.json`.
3. Add tests, then run `npm test`, `npm run typecheck`, and `npm run build` from
   the repo root.

## Development

```sh
npm install        # one npm workspace per worker
npm run typecheck
npm test           # vitest (each workspace)
npm run build      # tsc -> dist/
```

Workers resolve `@niq.run/worker-sdk` from npm. When `start.ts` relies on a
**new** SDK feature, publish the SDK first (from `niq/sdk/ts`, `npm run
release`) so the published version carries it; until then the local
`typecheck` will report the un-exported helpers. To verify against an
unpublished SDK locally, point `@niq.run/worker-sdk` in the worker's
`package.json` at `file:../../niq/sdk/ts`.

## SDK CLI helpers used by `start.ts`

Out-of-process workers share launch plumbing via `@niq.run/worker-sdk`:

- `parseCliArgs(argv)` — parse `--key value` / `--key`, flag `--help`/`-h`.
- `busConnFromArgs(opts)` — layer `--bus-url` / `--worker-id` / `--credential`
  over the supervisor-injected env (`NIQ_BUS_URL` / `NIQ_WORKER_ID` /
  `NIQ_WORKER_CREDENTIAL`) into bus connection params.
- `runWorkerApp(main)` — run the app body, log + set `exitCode = 1` on failure.


## Related

- **niq core** — <https://github.com/niq-run/niq>: the event-driven,
  decentralized agent runtime (the event bus, the worker swarm, and the
  in-process workers). The TypeScript worker SDK (`@niq.run/worker-sdk`) lives
  here under `niq/sdk/ts`.
- **This repo** (`niq-run/workers`): standalone (out-of-process) workers built
  on that SDK.

## License

MIT