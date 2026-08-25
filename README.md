# workers

This repository hosts both the **worker SDK** (`@niq-ai/worker-sdk`) and a
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
│   ├── sdk/             # @niq-ai/worker-sdk — the TS worker SDK
│   └── workers/         # @niq-ai/workers — TS worker collection (subpath exports)
└── go/                  # Go
    └── workers/         # Go worker directory (skeleton, no concrete workers yet)
```

- **TS SDK** (`@niq-ai/worker-sdk`): a convenience layer for connecting to the
  bus (HTTP + SSE), maintained independently of the niq core repo.
- **TS workers** (`@niq-ai/workers`): imported by subpath, e.g.
  `@niq-ai/workers/feishu`.
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

Each TS worker is imported by subpath, e.g. the feishu worker:

```ts
import { FeishuWorker } from "@niq-ai/workers/feishu";

const worker = new FeishuWorker({
  baseURL: "http://localhost:8080",
  workerID: "feishu@me",
  credential: "the-credential-issued-at-registration",
  sender: async (payload) => {
    // Call the Feishu API to send a message, return the message id.
    return "msg-123";
  },
});

await worker.run();
```

## Current workers

| Subpath | Description |
|---|---|
| `@niq-ai/workers/feishu` | Bridges events to Feishu (Lark): subscribes to `feishu.send`, publishes the delivery result as `feishu.delivered` / `feishu.failed` |

## Add a TS worker

1. Create the worker module under `ts/workers/src/<name>/` (see `ts/workers/src/feishu/`).
2. Add the matching subpath to the `exports` map in `ts/workers/package.json`.
3. Register an entry in the `WORKERS` registry in `ts/workers/src/index.ts`.
4. Add tests, then run `npm test` and `npm run typecheck`.

## Development

```sh
npm install
npm run typecheck
npm test        # vitest
npm run build   # tsc -> dist/
```

The root is an npm workspace. The commands above run across both `ts/sdk` and
`ts/workers`; you can also `cd ts/workers` to run a single package.

## License

MIT
