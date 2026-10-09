# @niq.run/lark-worker

A **Feishu / Lark WebSocket bridge** for [niq](https://github.com/niq-run/niq).
It listens for Feishu messages, forwards them to a bound **reason worker** as
`worker.input` events, and pushes the reason worker's reply back into the
Feishu chat (`lark.send`). Chat → worker routing is persistent and can be
reconfigured at runtime (`lark.reason.*`). Built on
[`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk).

## Run

```sh
npx @niq.run/lark-worker --reason-worker reason.sales
# once installed: niq-lark --reason-worker reason.sales
```

Bus connection comes from the supervisor-injected environment
(`NIQ_BUS_URL`, `NIQ_WORKER_ID`, `NIQ_WORKER_CREDENTIAL`); the bound reason
worker and per-chat routing come from env or flags (see Config). See
[`start.ts`](src/start.ts) for the full flag list.

## Config

| Purpose | Env | Flag | Default |
|---|---|---|---|
| Bus base URL | `NIQ_BUS_URL` | `--bus-url` | — |
| Bus worker id | `NIQ_WORKER_ID` | `--worker-id` | — |
| Bus credential | `NIQ_WORKER_CREDENTIAL` | `--credential` | — |
| Feishu app id | `LARK_APP_ID` | `--app-id` | _(required)_ |
| Feishu app secret | `LARK_APP_SECRET` | `--app-secret` | _(required)_ |
| Feishu/Lark domain | `LARK_DOMAIN` | `--domain` | `https://open.feishu.cn` |
| Proactive message recipient | `LARK_DEFAULT_USER_ID` | `--default-user` | — |
| **Default reason worker** | `NIQ_REASON_WORKER` | `--reason-worker` | — |
| **Fallback reason worker** | `LARK_FALLBACK_REASON_WORKER` | `--fallback-reason-worker` | — |
| **Per-chat routing** | `LARK_REASON_WORKER_MAPPINGS` | `--reason-mappings` | `{}` |
| Persisted routing state | `LARK_STATE_FILE` | `--state-file` | `./lark-reason-state.json` |

At least one of the default or fallback reason worker must be configured.

## Events

### Handles (subscribes / answers)

| Event | Payload | Reply |
|---|---|---|
| `lark.send` | `{ target?, text? }` — or one of `image` / `file` / `video` / `audio` (http(s) URL or local path; `file` takes `file_name`) to send media | `request.completed` on send; `request.failed` if no target / no text or media / send error |
| `lark.reason.set` | `{ worker_id: string, chat_id?: string, fallback?: boolean }` | `request.completed`; `request.failed` on error |
| `lark.reason.unset` | `{ chat_id?: string, fallback?: boolean }` | `request.completed`; `request.failed` on error |
| `lark.reason.get` | `{}` | `request.completed` → routing JSON (`default`, `fallback`, `per_chat`) |

### Publishes

| Event | Payload | Destination |
|---|---|---|
| `worker.input` | `{ text, chat_id, sender_open_id, input_mode: "append" }` | bound reason worker (per-chat → default → fallback) |
| `worker.ready` | `{ type: "lark", watch, publishes }` | broadcast (transient presence) |

Routing resolution for each Feishu message: `per_chat[chat_id] ?? default(reason-worker) ?? fallback(fallback-reason-worker)`. Routing state is persisted to `LARK_STATE_FILE` across restarts.

## Usage in code

```ts
import { LarkWorker, larkConfigFromEnv } from "@niq.run/lark-worker";
```

## License

MIT