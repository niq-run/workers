# @niq.run/lark-worker

A **Feishu / Lark WebSocket bridge** for [niq](https://github.com/niq-run/niq).
It listens for Feishu messages, forwards them to a bound **reason worker** as
`worker.input` events, and pushes the reason worker's reply back into the
Feishu chat. Chat → worker routing is persistent and reconfigurable at runtime
(per-chat → default → fallback).

Built on [`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk).
It is an out-of-process extension worker: it connects to a niq bus over
HTTP + SSE and is meant to be launched by the niq project supervisor (or by you,
for a standalone bridge).

## Install

```sh
npm install -g @niq.run/lark-worker
```

## Run

The package ships a `niq-lark` bin (compiled app entry `dist/start.js`), so you
can start it directly — with `npx` (no install needed):

```sh
# npx — most convenient for launching, e.g. from a niq project's worker config
npx @niq.run/lark-worker --reason-worker reason.sales

# same thing once installed globally
niq-lark --reason-worker reason.sales

# or run it via node from a checkout
node dist/start.js --reason-worker reason.sales
```

Connection to the bus comes from the environment the supervisor injects
(`NIQ_BUS_URL`, `NIQ_WORKER_ID`, `NIQ_WORKER_CREDENTIAL`), so a niq project can
spawn it with `npx @niq.run/lark-worker` and nothing else. CLI flags override
the env.

## Configuration

| Purpose | Env | Flag |
|---|---|---|
| Feishu app id | `LARK_APP_ID` | `--app-id` |
| Feishu app secret | `LARK_APP_SECRET` | `--app-secret` |
| Feishu/Lark domain | `LARK_DOMAIN` | `--domain` |
| Proactive message recipient | `LARK_DEFAULT_USER_ID` | `--default-user` |
| **Default reason worker** | `NIQ_REASON_WORKER` | `--reason-worker` |
| **Fallback reason worker** | `LARK_FALLBACK_REASON_WORKER` | `--fallback-reason-worker` |
| **Per-chat routing** | `LARK_REASON_WORKER_MAPPINGS` | `--reason-mappings` |
| Persisted routing state | `LARK_STATE_FILE` | `--state-file` |

At least one of the default or fallback reason worker must be configured.
Run `niq-lark --help` for the full flag list.

## Usage in code

```ts
import { LarkWorker, larkConfigFromEnv } from "@niq.run/lark-worker";
```

## Details

The worker exposes a runtime routing API through the `lark.reason.*` extension
group (`lark.reason.set` / `unset` / `get`), and persists its routing state to
`LARK_STATE_FILE` (an atomic temp-file + rename JSON write, restored on start).
The bridge forwards each Feishu message to exactly one reason worker,
resolved per-chat → default → fallback.

## License

MIT