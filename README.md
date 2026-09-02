# workers

This repository hosts both the **worker SDK** (`@niq.run/worker-sdk`) and a
collection of **workers** — interesting and useful workers that don't belong in
the core niq runtime but are fine to ship on their own.

> **Status: early, moving fast.** Like niq itself, this is early-stage and APIs
> may change without notice.

## What is a Worker

In niq, a **Worker** is the single extension concept: an actor-like unit that
holds its own state and communicates only by sending and reacting to messages
over an event bus. Every worker in this repo is such a unit, implemented in
different languages, connecting to the bus over the bus protocol (HTTP + SSE).

## Repository layout

Organized by language:

```
workers/
├── ts/                  # TypeScript
│   ├── sdk/             # @niq.run/worker-sdk — the TS worker SDK
│   └── workers/         # @niq-ai/workers — TS worker collection (subpath exports)
└── go/                  # Go
    └── workers/         # Go worker directory (skeleton, no concrete workers yet)
```

- **TS SDK** (`@niq.run/worker-sdk`): a convenience layer for connecting to the
  bus (HTTP + SSE), maintained independently of the niq core repo.
- **TS workers** (`@niq-ai/workers`): imported by subpath, e.g.
  `@niq-ai/workers/lark`.
- **Go workers** (planned): Go workers will import the core repo module
  `github.com/54c1/niq` directly (e.g. `httptrans.WorkerSide`) to connect to
  the bus — no separate SDK needed. See `go/workers/README.md`.

## Core repository

This repo is complementary to the niq core runtime:

- **niq core** — <https://github.com/niq-run/niq>: the event-driven,
  decentralized agent runtime (the event bus, the worker swarm, and the
  in-process workers).
- **This repo** (`niq-run/workers`): the worker SDK plus out-of-process /
  standalone workers built on top of it.

## Install

```sh
npm install @niq-ai/workers
```

## Usage

Each TS worker is imported by subpath, e.g. the Lark (Feishu) bridge:

```ts
import { LarkEchoWorker, larkConfigFromEnv } from "@niq-ai/workers/lark";

// Reads LARK_APP_ID / LARK_APP_SECRET from the environment.
const worker = new LarkEchoWorker(larkConfigFromEnv());

await worker.run(); // connects to Lark and stays alive until SIGINT
```

## Current workers

| Subpath | Description |
|---|---|
| `@niq-ai/workers/hello` | Minimal demo worker: answers `hello.greet` requests with a `request.completed` greeting |
| `@niq-ai/workers/lark` | Feishu long-connection bridge: connects to Lark over WebSocket, forwards inbound messages to a bound reason worker (via `worker.input` + `<system-reminder>`), and pushes the reason reply (its `send_message` → `worker.input`) back to the Feishu chat |

## Add a TS worker

1. Create the worker module under `ts/workers/src/<name>/` (see `ts/workers/src/hello/`).
2. Add the matching subpath to the `exports` map in `ts/workers/package.json`.
3. Register an entry in the `WORKERS` registry in `ts/workers/src/index.ts`.
4. Add tests, then run `npm test` and `npm run typecheck`.

## Development

```sh
cd ts             # npm workspace root (SDK + TS workers; go/ is not npm-managed)
npm install
npm run typecheck
npm test        # vitest
npm run build   # tsc -> dist/
```

`ts/` is the npm workspace root, covering `ts/sdk` and `ts/workers`; you can
also `cd ts/workers` to run a single package.

## License

MIT
