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
| **Default reason worker** | `NIQ_REASON_WORKER` | `--reason-worker` | _(required)_ |
| **Per-chat routing** | `LARK_REASON_WORKER_MAPPINGS` | `--reason-mappings` | `{}` |
| Persisted routing state | `LARK_STATE_FILE` | `--state-file` | `./lark-reason-state.json` |
| Local file send allowlist | `LARK_ALLOWED_FILE_DIRS` | `--allowed-file-dirs` | _(none — local file sends rejected)_ |
| Allowlist approver | `LARK_APPROVER` | `--approver` | `webui-hiw` (`""` disables gating) |

The default reason worker (`NIQ_REASON_WORKER`) must be configured.

### Sending local files

`@larksuite/channel` **rejects local file media sources by default** (an
allowlist avoids reading arbitrary files such as `~/.ssh/id_rsa` or `.env`).
To let a reason worker `lark.send` a local path as `image` / `file` / `video` /
`audio`, list the directories it may read from as a comma-separated value:

```sh
LARK_ALLOWED_FILE_DIRS=/var/niq/outbox,/tmp/niq-reports
# or: --allowed-file-dirs /var/niq/outbox,/tmp/niq-reports
```

Requirements enforced by the SDK:

- Each sent path must resolve **inside** one of the listed directories.
- Paths are resolved against the worker process's working directory, so
  **absolute directories are recommended** (relative entries and `~/` are
  normalized to absolute paths at startup).
- Symlinks are re-checked after `realpath`; POSIX system dirs (`/etc/`,
  `/proc/`, `/sys/`, `/dev/`) stay blocked regardless.

`http(s)` URL media and `Buffer` sources work without this setting, and so do
text sends. When unset, a local-path media send fails with
`local file source requires \`outbound.allowedFileDirs\` to be configured`; the
startup log shows `local_file_dirs=…` so you can confirm what took effect.

#### Adding directories at runtime (approval-gated)

The env allowlist is the deploy-time baseline. A peer (typically the reason
worker) can widen it at runtime with `lark.dirs.add`:

```text
lark.dirs.add { path: "/var/niq/outbox2" }
```

- Requests from the **approver** worker (`LARK_APPROVER` / `--approver`, default
  `webui-hiw`) are treated as consent and applied immediately — the approver
  already decided.
- Requests from **any other worker** are parked: lark sends an
  `approval.request` (`{ action: "lark.dirs.add", path, exists, dirs, origin }`)
  to the approver and keeps the caller's request open. The approver's
  `approval.decision` (`{ approved, note? }`, echoing `request_id`) resolves it:
  approval applies and persists the addition, denial answers `request.failed`.
- Approved additions are persisted alongside the routing state in
  `LARK_STATE_FILE`, so they survive a restart and extend the env seed.
- The change takes effect on the **live** channel: the SDK re-reads the
  allowlist on every send, so no reconnect is needed.
- Set `--approver ""` explicitly to disable gating (all adds apply directly).
  An empty `LARK_APPROVER` still means the default `webui-hiw`. There is
  intentionally no remove/unset event — narrowing the allowlist stays a
  deploy-time decision.

## Events

### Handles (subscribes / answers)

| Event | Payload | Reply |
|---|---|---|
| `worker.readme` | `{}` | `request.completed` → the usage guide (including live routing/allowlist state) |
| `worker.help` | `{ event_name?: string, params?: object }` | `request.completed` → the event index (no `event_name`) or that event's help (declared contract, like a CLI's `-h`); `request.failed` for an event lark does not serve |
| `lark.send` | `{ target?, text? }` — or one of `image` / `file` / `video` / `audio` (http(s) URL or local path; `file` takes `file_name`) to send media | `request.completed` → `"sent"`; `request.failed` if no target / no text or media / send error |
| `lark.reason.set` | `{ worker_id: string, chat_id?: string }` | `request.completed` → `"ok"`; `request.failed` on error |
| `lark.reason.get` | `{}` | `request.completed` → `{ default_reason_worker, per_chat }` (a structured object, not a JSON string) |
| `lark.dirs.add` | `{ path: string }` (absolute or `~/`; missing dirs are allowed) | `request.completed` → `{ dirs, added }`; `request.failed` if `path` is missing, the approval is denied, or the approval request could not be delivered |
| `lark.dirs.get` | `{}` | `request.completed` → `{ dirs, approver }` |

Schemas are TypeBox (`@sinclair/typebox`) and are announced in `worker.ready`, so
`parameters` and `response` are visible to peers — `directory.get_worker_info`
shows both, and a PTC script can plan its parse from `response`.

`worker.discover` is protocol traffic rather than a tool: lark answers it with a
directed, transient `worker.ready` carrying this contract. Presence is not
persisted, so a peer that starts later (or the WebUI, which asks on demand) still
learns lark's tools.

### Publishes

| Event | Payload | Destination |
|---|---|---|
| `worker.input` | `{ text, chat_id, sender_open_id, input_mode: "append" }` | bound reason worker (per-chat → default) |
| `worker.ready` | `{ type: "lark", watch, publishes }` | broadcast (transient presence) |
| `approval.request` | `{ origin, requested_by, action: "lark.dirs.add", path, exists, dirs }` | approver (only for a non-approver `lark.dirs.add`) |

Routing resolution for each Feishu message: `per_chat[chat_id] ?? default(reason-worker)`. Routing state and runtime allowlist additions are persisted to `LARK_STATE_FILE` across restarts. lark also **consumes** `approval.decision` (directed from the approver) to resolve a parked `lark.dirs.add`.

## Usage in code

```ts
import { LarkWorker, larkConfigFromEnv } from "@niq.run/lark-worker";
```

## License

MIT