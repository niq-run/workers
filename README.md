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
├── package.json       # npm workspace root — an entry exists for each worker below
├── tsconfig.base.json
├── hello/             # @niq.run/hello-worker     — reference example (bin: niq-hello)
├── interface/         # @niq.run/interface-worker — generic interface worker, CLI form (bin: niq-interface)
├── lark/              # @niq.run/lark-worker      — Feishu WebSocket bridge (bin: niq-lark)
└── msp/               # @niq.run/msp-worker       — MSP world bridge (bin: niq-msp)
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
npm install -g @niq.run/hello-worker
npm install -g @niq.run/lark-worker
```

Install the interface worker from npm:

```sh
npm install -g @niq.run/interface-worker
```

> The rename from `@niq.run/agent-interface-worker` lives in this repo but is not
> published yet. Until `@niq.run/interface-worker` is on npm, install from this
> checkout, or use the old package name (identical CLI, bin `niq-agent`).

`@niq.run/msp-worker` is not on npm yet (its MSP SDK is vendored): install it
from this checkout.

```sh
npm ci -w msp
npm install -g ./msp --install-links
```

Or build any worker from this checkout:

```sh
npm ci -w interface
npm install -g ./interface --install-links
```

Then run each worker's own launcher, or import it in code:

```ts
import { LarkWorker, larkConfigFromEnv } from "@niq.run/lark-worker";
```

## Current workers

| Package | Launcher | Description |
|---|---|---|
| `@niq.run/hello-worker` | `niq-hello` | **Reference example — start here to build a worker.** A complete, small worker that demonstrates every part of the contract: state, two tool-shaped extensions (text reply + object reply), a declared broadcast, `worker.readme` / `worker.help`, flag > env > default config, graceful shutdown, and fake-bus tests |
| `@niq.run/interface-worker` | `niq-interface` | Generic out-of-process interface worker (CLI form today): dials a niq bus from the shell (multi-source credential file matching the WebUI's remote-worker connect block), sends directed events, requests a reply, streams events. The remote counterpart of the built-in interface worker; ships a companion agent skill (`niq-interface skill install`) |
| `@niq.run/lark-worker` | `niq-lark` | Feishu long-connection bridge: connects to Lark over WebSocket and forwards inbound messages to a reason worker, selected per-chat via a persistent routing map (per-chat → default → fallback), pushing the reason reply (its `send_message` → `worker.input`) back to the Feishu chat |
| `@niq.run/msp-worker` | `niq-msp` | MSP world bridge: joins an MSP world through the vendored MSP TypeScript SDK, serves `msp.nodes` / `msp.call` / `msp.publish` / `msp.manifest` to niq, exposes `niq_call` / `niq_send` to MSP peers, and forwards inbound MSP signals as niq events |

## Agent bootstrap: interface worker from a repo URL

Given only this repository's URL, an agent can install the interface worker CLI
and its skill, then dial a niq bus:

```sh
git clone https://github.com/niq-run/workers.git
cd workers
npm ci -w interface
npm install -g ./interface --install-links
niq-interface skill install

# with the connect block copied from the niq WebUI for a remote worker:
niq-interface config import 11 --from-file ./block.txt
niq-interface ping --source 11
niq-interface say "hello" --target reason.0 --source 11
```

The skill is also readable without installing:
[`interface/skills/niq-interface/SKILL.md`](interface/skills/niq-interface/SKILL.md).
Full details: [`interface/README.md`](interface/README.md).

Sends are directed only and there is no implicit target: if the id is unknown,
the agent must ask the user. In many projects the main reason worker is named
`niq` — a common candidate, not a default.

## Add a worker

`hello/` is the canonical example: copy it, rename the package, and replace the
capabilities. Its guide — [`hello/README.md`](hello/README.md) — walks through the
file layout, the lifecycle contract, the extension registry, replies, presence,
config layering, tests and packaging, and ends with a copy-and-rename checklist.

In short, a worker is a small package:

1. `src/worker.ts` — the worker class: connection options, state, extensions
   (`register` with a schema), handlers, `run()` / `close()`. Importable in
   process and by tests.
2. `src/start.ts` — the `#!/usr/bin/env node` entrypoint compiled to
   `dist/start.js`; the package `bin` points here, so the worker runs as a
   standalone app with one command. It reuses the SDK's `parseCliArgs`,
   `busConnFromArgs` and `runWorkerApp` instead of re-implementing bootstrap.
3. `src/worker.test.ts` — protocol-level tests against a fake bus (no live bus).
4. `package.json` with `bin`, plus a `tsconfig.json` extending
   `../tsconfig.base.json`.

Then register the package in the root `workspaces` array and run `npm test`,
`npm run typecheck` and `npm run build` from the repo root.

If the worker's job is to be a **seam to an outside world** (a chat platform, a
protocol, a local harness) rather than a domain of its own, build it the way
`lark`, `msp` and `interface` are built: the SDK's `InterfaceWorker` for the niq
side plus a *backend* class for the outward side. `hello` is deliberately a plain
`BaseWorker` so it shows the raw contract; the interface workers show the same
contract with that extra split.

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