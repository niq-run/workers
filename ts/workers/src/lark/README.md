# Lark worker

A Feishu/Lark WebSocket bridge for niq. It listens for Feishu messages, forwards
them to a bound reason worker as `worker.input` events (`input_mode: "append"`),
and pushes the reason worker's reply back into the Feishu chat.

```
Feishu message ──worker.input──▶ reason worker
reason reply   ──lark.send────▶ lark worker  ──send──▶ Feishu chat
```

The reason worker replies by calling the `lark.send` extension (exposed by this
worker) with `target` (chat_id / open_id / user_id) and `text`. The lark worker
does **not** consume `worker.input` events as replies — `lark.send` is the only
inbound path for reason → Feishu output.

Built on `@larksuite/channel`. It is a **third-party process worker**: launched
out-of-process by the niq project supervisor (via `start-worker.mjs`), not
managed in the niq main repo.

## Build & run

```sh
# from the npm workspace root
cd ts
npm install
npm run build

# launch the lark worker
node ts/workers/start-worker.mjs lark
```

All config comes from environment variables (set them in the worker's `env`
block in `project.json`) or CLI flags (which override env).

| Purpose | Env | Flag | Default |
|---|---|---|---|
| Feishu app id | `LARK_APP_ID` | `--app-id` | _(required)_ |
| Feishu app secret | `LARK_APP_SECRET` | `--app-secret` | _(required)_ |
| Feishu/Lark domain | `LARK_DOMAIN` | `--domain` | `https://open.feishu.cn` |
| Proactive message recipient | `LARK_DEFAULT_USER_ID` | `--default-user` | — |
| **Default reason worker** | `NIQ_REASON_WORKER` | `--reason-worker` | — |
| **Fallback reason worker** | `LARK_FALLBACK_REASON_WORKER` | `--fallback-reason-worker` | — |
| **Per-chat routing** | `LARK_REASON_WORKER_MAPPINGS` | `--reason-mappings` | `{}` |
| Persisted routing state | `LARK_STATE_FILE` | `--state-file` | `./lark-reason-state.json` |

At least one of the default or fallback reason worker must be configured.

## Routing: which reason worker gets a chat

Each Feishu message goes to exactly one reason worker, resolved in this order —
per-chat mapping → default → fallback:

```
per_chat[chat_id]  ??  default(reason-worker)  ??  fallback(fallback-reason-worker)
```

- **Per-chat mapping** — `LARK_REASON_WORKER_MAPPINGS`, a JSON object of
  `{ chat_id: worker_id }`. Overrides the default for specific chats.
- **Default** — `NIQ_REASON_WORKER` / `--reason-worker`. Used when a chat has no
  per-chat entry.
- **Fallback** — `LARK_FALLBACK_REASON_WORKER` / `--fallback-reason-worker`. The
  last resort, used when neither a per-chat mapping nor the default is set.

If no worker resolves, the message is dropped and logged (a `warn`).

## Runtime routing management (`lark.reason.*`)

The routing is also a live, mutable property. A control plane / admin peer can
reconfigure it at runtime through the `lark.reason.*` extension group (each is an
ordinary tool-style invocation answered with `request.completed` / `request.failed`):

| Event | Behaviour |
|---|---|
| `lark.reason.set` | With `worker_id` + `chat_id`: route that chat. With `worker_id` + `fallback: true`: set the fallback. With just `worker_id`: set the default. |
| `lark.reason.unset` | With `chat_id`: drop a chat's override (falls back). With `fallback: true`: clear the fallback. |
| `lark.reason.get` | Return current routing as JSON (`default`, `fallback`, `per_chat`). |

Example `lark.reason.set`:

```jsonc
{
  "type": "lark.reason.set",
  "request_id": "call-1",
  "payload": { "worker_id": "caller", "arguments": { "chat_id": "oc_abc123", "worker_id": "reason.sales" } }
}
```

## Persistence

Because the lark worker is a third-party process and niq's own snapshot/restore
for out-of-process workers is not implemented yet, it persists its own routing
state. Every routing change (config seed at startup, or a runtime
`lark.reason.*` mutation) is written to a JSON state file and restored on the
next start, so the mapping survives restarts.

The state is read/written through an injectable `LarkStateStore` (default:
`FileLarkStateStore`, an atomic temp-file + rename write). This is the seam a
future snapshot/restore implementation can plug into without changing the
worker's logic.

```jsonc
// lark-reason-state.json
{
  "default_reason_worker": "niq",
  "fallback_reason_worker": "",
  "per_chat": {
    "oc_abc123": "reason.sales"
  }
}
```