# @niq.run/interface-worker

The **generic, out-of-process interface worker** for niq: it puts a niq bus
within reach of a local process — a shell, a CI step, an AI agent, an MCP
client — without writing SDK code.

```sh
npm install -g @niq.run/interface-worker     # provides `niq-interface`
niq-interface say "review the budget" --target reason.0
niq-interface mcp --persistent --source laptop   # or serve the bus as MCP tools
```

Built on [`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk);
its only runtime dependency.

---

## 1. The concept

niq is an event bus with identities. A **worker** is an actor on that bus: it has
an id, owns state, and only changes it while handling a message.

An **interface worker** is a worker whose job is not a domain of its own but a
*seam*: one side faces the bus, the other faces some outside world.

```
       niq bus  ── routing, identity, ACL, persistence
          ▲  │
  publish │  │ events
          │  ▼
   ┌──────────────────────────────────────────────┐
   │ interface seam (SDK)                         │
   │ identity · subscribe · dispatch · reply      │
   │ request/reply correlation · timeouts         │
   └──────────────────────────────────────────────┘
          ▲  │
          │  ▼
   ┌──────────────────────────────────────────────┐
   │ outward form (this package)                  │
   │ CLI one-shot · MCP stdio · (tui, web)        │
   └──────────────────────────────────────────────┘
          ▲  │
   argv/stdin│ │stdout/tool results
          │  ▼
     whatever is driving it: your shell, an agent, an MCP client
```

The name is about **which side it faces**: the bus, from the outside. The
**form** is the outward shape, and it is a separate axis — the same seam can be
driven from a shell or from an MCP client.

### Where this sits

| Worker | Faces | Built on |
|---|---|---|
| built-in interface worker (WebUI) | a human in a browser | Go `core/impl/iface` |
| [`lark`](../lark) | Feishu | `InterfaceWorker` + a Feishu backend |
| [`msp`](../msp) | an MSP world | `InterfaceWorker` + an MSP backend |
| **this package** | **whatever process drives it** | **`InterfaceSession`** |
| [`hello`](../hello) | nothing (it is a domain) | `BaseWorker` |

`lark` and `msp` are interface workers with a *fixed* external product, so they
implement a backend for it. This package has no product behind it — the outside
world is the process invoking it — which is why it can carry several forms.

### Stateless vs stateful seam

The SDK offers two halves, and the choice is about **who owns presence**:

- `InterfaceSession` — dial, work, close. No `worker.ready`, no tools registered,
  no claim to be callable. A **client** of the bus.
- `InterfaceWorker` — connect, announce presence, serve tools, run backends. A
  **service** on the bus.

Every shipped form here uses `InterfaceSession`, including the persistent MCP
mode: the server holds a session open, but it is still a client — peers cannot
call it. That is deliberate (see [§7](#7-operational-rules)). A form that should
be callable from the bus would use `InterfaceWorker` instead, like `lark`.

### How a call works

- **Directed only.** There is no broadcast here: every send names its targets.
  If the target is unknown, ask the user — `niq` is a common reasoning-worker
  name, not a default.
- **Request/reply** adds a `request_id`; the reply is an ordinary
  `request.completed` / `request.failed` / `request.rejected` event addressed to
  the caller. Without a `request_id`, an event is a notification: no reply.
- **One identity = one live session.** The bus keeps a single SSE connection per
  worker id; a second connection replaces the first.

## 2. Forms

| Form | Command | Lifetime | Inbox |
|---|---|---|---|
| CLI, one-shot | `niq-interface <command>` | dial → do one thing → exit | — |
| MCP, one-shot | `niq-interface mcp` | one dial per tool call | — |
| MCP, persistent | `niq-interface mcp --persistent` | dial once, hold the session | yes |
| TUI | `niq-interface tui` | planned | planned |
| minimal web UI | `niq-interface serve` | planned | planned |

Pick by what is driving you:

- **A shell, a script, CI** → the CLI. Nothing left running, JSON on stdout.
- **An agent with MCP support** (Claude Code, IDE assistants) → `mcp
  --persistent`. Tools instead of shell quoting, plus an inbox so "send, then
  poll the answer" works without holding a call open.
- **An agent that can only run commands** → the CLI (same capabilities, one
  process per call).
- **Watching traffic for a while** → `listen` (bounded by `--max`/`--timeout`) or
  the persistent MCP inbox.

## 3. Install

Node **18+** (uses global `fetch`, `ReadableStream`, `AbortSignal`).

```sh
npm install -g @niq.run/interface-worker   # gives the `niq-interface` command
npx -y @niq.run/interface-worker --help    # or run without installing
```

`niq-agent` is a deprecated alias bin (the package's old name,
`@niq.run/agent-interface-worker`, is deprecated on npm and points here).

From this repository:

```sh
git clone https://github.com/niq-run/workers.git
cd workers
npm ci -w interface                  # deps + `prepare` builds interface/dist
npm install -g ./interface --install-links
```

- Do not skip `npm ci -w interface`: a bare clone has no `tsc`, so
  `--install-links` fails in `prepare`.
- `--install-links` packs the package (and installs its SDK dependency) instead
  of symlinking the source tree.
- No permission for the global prefix? Install into a user prefix:
  `npm install -g ./interface --install-links --prefix "$HOME/.local"`, then add
  `$HOME/.local/bin` to `PATH`.
- Or skip the global install — the workspace install links the CLI into
  `node_modules/.bin` (`export PATH="$PWD/node_modules/.bin:$PATH"`).

### Install the agent skill

```sh
niq-interface skill install                          # ~/.agents/skills/niq-interface
niq-interface skill install --dest .agents/skills    # project-local
niq-interface skill install --force                  # overwrite an older copy
niq-interface skill print                            # print SKILL.md to stdout
```

`npm install` does **not** install the skill: harnesses use different skill
directories, and install scripts are frequently disabled. The copy is explicit so
you choose the destination; uninstall by removing `<dest>/niq-interface`.

> Renamed skill. Earlier versions installed `niq-agent-interface`; remove it with
> `rm -rf ~/.agents/skills/niq-agent-interface` so an agent does not follow two
> copies of the same instructions.

## 4. Credentials

The bus only lets **registered** identities connect. In the niq WebUI create a
worker with **remote (dial-in)** placement; it hands you a connect block:

```
NIQ_BUS_URL=http://192.168.1.20:7801
NIQ_WORKER_ID=agent.laptop
NIQ_WORKER_CREDENTIAL=eyJ...
# type=agent
```

The WebUI can give it in two shapes — that env block (what `niw` and the
supervisor consume) and a ready-to-use **interface-worker JSON** (copy or
download). Both are accepted:

```sh
niq-interface config import home --from-file ./block.txt          # env block, named
niq-interface config import --from-file ~/Downloads/niq-interface-11.json   # JSON, merged
```

A full-file import **merges** (it never deletes other sources), refuses to replace
an existing source without `--force`, and keeps the current `default_source`
unless the file is the first config or you pass `--default`.

### The credential file

Default: **`~/.niq/interface.json`** (`--config <path>` or `NIQ_INTERFACE_CONFIG`
overrides). Created with mode `0600`; the loader warns if others can read it.

```json
{
  "version": 1,
  "default_source": "home",
  "sources": {
    "home": {
      "bus_url": "http://192.168.1.20:7801",
      "worker_id": "agent.laptop",
      "credential": "eyJ...",
      "type": "agent"
    },
    "work": { "bus_url": "http://10.0.0.5:7801", "worker_id": "agent.work", "credential": "eyJ..." }
  }
}
```

One file, many buses and identities. `type` is informational (from the WebUI's
`# type=` comment).

**Resolution order** when a command dials:

1. `--source <name>` (or `NIQ_INTERFACE_SOURCE`) — that source must exist.
2. `NIQ_BUS_URL` + `NIQ_WORKER_ID` + `NIQ_WORKER_CREDENTIAL` — the supervisor
   convention; all three together.
3. The file's `default_source`, or its only source.
4. Otherwise a guiding error.

`--bus-url` / `--worker-id` / `--credential` overlay the chosen base and, on
their own, supply a one-off connection.

The CLI never registers identities — it only dials with one the bus issued.
Remote workers default to publish `*` / subscribe `*`; if the ACL was tightened,
the event types you use must be on its lists. A remote worker created with type
`niq` gets the narrow niq-bridge grant (`worker.input` / `request.*`) rather than
`*` — pick another type for a general-purpose identity.

## 5. CLI usage

stdout carries data only (JSON; NDJSON for `listen`); warnings and readiness go
to stderr. Exit codes: `0` ok, `1` failure, `2` usage error.

| Command | What it does |
|---|---|
| `send <type> --target <id>… [-d <json>]` | Publish one **directed** event. At least one target; broadcast is disabled. |
| `request <type> --target <id> [-d <json>] [--timeout 30s]` | Send with a fresh `request_id`, wait for the correlated reply. |
| `say <text> --target <id> [--mode append\|schedule\|interrupt]` | Send `worker.input` as `{text, input_mode}` — the short form for a reason worker. |
| `listen [--type <p>]… [--from <id>]… [--max <n>] [--timeout <dur>]` | Stream events routed to this identity as NDJSON. |
| `ping` | Open the session once, close it, report handshake latency. |
| `info` | Show the resolved connection offline (credential redacted). |
| `config <sub>` | `path`, `list`, `show`, `add`, `import`, `remove`, `default`. |
| `skill <sub>` | `path`, `print`, `install [--dest <dir>]`. |
| `mcp [--persistent]` | Serve the same capabilities over stdio — see [§6](#6-mcp-stdio). |
| `help [command]` | Usage. |

Shared flags: `--source`, `--config`, `--bus-url`, `--worker-id`,
`--credential`, `-d/--data` (`-` reads stdin), `--data-file`, `--target`
(repeatable), `--trace`, `--timeout`, `--dry-run`. Durations accept `500ms`,
`30s`, `5m`, `1h`; a bare number means seconds.

### Examples

```sh
# Wake a reason worker
niq-interface say "review the 2026-10 budget" --target reason.0

# Call a capability and read its structured reply
niq-interface request hello.greet --target hello@bus -d '{"name":"niq"}'
# { "ok": true, "request_id": "…", "reply": { …, "payload": { "result": "hello, niq!" } } }

# Directed notification
niq-interface send ops.notice --target niq -d '{"text":"deploy done"}'

# Bounded watch (readiness on stderr, events on stdout)
niq-interface listen --type 'reason.*' --max 20 --timeout 30s

# Compose with jq
niq-interface listen | jq -c 'select(.type == "worker.ready") | .payload'
```

`request` exits `1` when the reply is `request.failed`/`request.rejected`, but
still prints the reply JSON on stdout. `listen` exits `0` at `--max`, on timeout
or Ctrl-C, and `1` if the bus closes the stream unexpectedly (usually because
another connection replaced the identity).

**Every command is one session.** A successful one-shot command prints its JSON
and exits; there is no daemon and nothing to keep open. `listen` (CLI) and
`mcp --persistent` are the two long-lived shapes.

### End-to-end handoff (user → agent)

When a user gives an agent this package (or its README/skill):

1. **Install** — `npm i -g @niq.run/interface-worker` (or the checkout flow), then
   `niq-interface skill install` so the harness has the guide.
2. **Get a credential** — the user creates a remote (dial-in) worker in the WebUI
   and hands over the env block or the JSON.
3. **Store it** — `config import` (temp file, then delete it). Never echo it.
4. **Verify** — `info --source <id>`, then `ping --source <id>`.
5. **Resolve the target** — ask the user; never guess. `niq` is a common
   candidate, not a default. `listen --type worker.ready` can list live ids.
6. **Work** — `say` / `send` / `request` / `listen`, then report the result.

## 6. MCP (stdio)

`niq-interface mcp` speaks the Model Context Protocol over stdin/stdout, so an MCP
client gets the bus as tools. stdout is the protocol channel (newline-delimited
JSON-RPC); every diagnostic goes to stderr, so nothing corrupts the stream.

| Mode | Dial | Inbox | Use when |
|---|---|---|---|
| `niq-interface mcp` | one session per tool call | none | send / request / say is all you need |
| `niq-interface mcp --persistent` | one session at startup | yes | you need "send, then poll for what came back" |

Client config:

```json
{
  "mcpServers": {
    "niq": {
      "command": "niq-interface",
      "args": ["mcp", "--persistent", "--source", "laptop"]
    }
  }
}
```

`--source` pins a credential source (give the server its **own** source; see
[§7](#7-operational-rules)). `--inbox-size <n>` changes the buffer (default 500).

| Tool | Modes | What it does |
|---|---|---|
| `niq_send {target, event, payload?, trace?}` | both | Directed event, fire-and-forget → `{ok, target, event_id}` |
| `niq_request {target, event, payload?, timeout_ms?}` | both | Directed request, waits for the correlated reply |
| `niq_say {target, text, mode?}` | both | `worker.input {text, input_mode}` to one reason worker |
| `niq_status` | both | Connection state (+ inbox counters when persistent) |
| `niq_inbox {cursor?, limit?, types?, from?, wait_ms?}` | persistent | Buffered events since a cursor; `wait_ms` blocks briefly |

Sends are directed only, exactly like the CLI: no broadcast, no implicit target.

### Send, then poll (a2a style)

The persistent server dials once and keeps reading, so events keep arriving while
the client is thinking. That makes an asynchronous exchange work without holding
a tool call open:

1. `niq_send {target, event, payload}` → returns immediately.
2. `niq_inbox {cursor: 0, wait_ms: 30000}` → blocks until something arrives,
   returns `{events, next_cursor, oldest_cursor, latest_cursor, dropped, gap}`.
3. Pass `next_cursor` back as `cursor` next time — nothing is delivered twice.

`niq_request` remains the simplest option when a tool-like reply is expected; its
reply event also appears in the inbox.

### MCP caveats

- **The server owns the identity.** A CLI command using the same source replaces
  its connection.
- **The inbox is bounded.** After a wrap, replies report `gap: true` and a
  `dropped` count.
- **It is a client, not a service.** No `worker.ready`, so peers need its worker
  id to reach it.
- **A dropped session is not fatal.** The server reports `session: "closed"` and
  `last_error`, keeps serving buffered events, and re-dials on the next tool
  call; events that arrived while disconnected are lost.

## 7. Operational rules

- **One identity = one live session.** A long-lived `listen` or `mcp
  --persistent` owns its identity; a `send`/`request` with the same source
  replaces it. Give long-lived things their own source (another remote worker in
  the WebUI).
- **Directed only.** There is no broadcast and no implicit target. If the id is
  unknown, ask.
- **stdout is the data channel.** JSON in the CLI, JSON-RPC in MCP. Diagnostics go
  to stderr, so `| jq` and MCP clients both work.
- **No presence.** The identity is online while a session is open, but nothing
  announces `worker.ready`, so the roster does not list it. That is the client
  role, not a bug.
- **Security.** Credentials are bearer tokens; the file is `0600` and redacted
  from output. Prefer `config import` over `--credential` (shell history). If a
  token leaks, revoke and re-import with `--force`. TLS is Node's default — use
  `https://` off a trusted network.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` on connect | credential expired/revoked, or the worker is not remote-connectable | issue a new credential in the WebUI, `config import --force` |
| `403` on publish | the identity's publish allow list excludes the event type | widen the ACL, or use a general-purpose `type` |
| `the bus closed the event stream` | another connection took the identity | use a distinct `--source` |
| `send needs at least one --target` | broadcast is disabled by design | ask the user for the worker id |
| `source "x" not found` | typo, or the file was never imported | `config list`, then import |
| MCP client shows no tools | the server wrote to stdout, or the config lacks `mcp` | keep stdout clean; `args: ["mcp", …]` |
| `niq_inbox` reports `session: "closed"` | the identity was replaced, or the bus restarted | buffered events stay readable; the next tool call re-dials (use a dedicated source) |

## 9. Development

```sh
npm install
npm run typecheck
npm test        # vitest: config, bus protocol (fake bus), CLI, MCP, inbox
npm run build   # tsc → dist/
```

The tests drive the **real** SDK client against a fake `fetch` (an SSE `Response`
plus a recording `/publish`), so protocol behaviour — reply correlation, presence
payloads, MCP framing, inbox cursors — is exercised without a live bus.

| File | Role |
|---|---|
| `src/cli.ts` | argument grammar, command dispatch, the JSON output contract |
| `src/bus.ts` | one-shot bus operations on top of `InterfaceSession` |
| `src/config.ts` | credential file, source resolution, WebUI block import |
| `src/mcp.ts` | the MCP stdio server (protocol loop, tools) |
| `src/inbox.ts` | bounded event buffer with cursors, for persistent MCP |
| `src/start.ts` | the `niq-interface` binary (stdin lines, stdout, exit code) |

## 10. Limits and roadmap

- CLI and MCP (one-shot and persistent) ship; `tui` and `serve` are planned.
- Sends are directed only — no broadcast.
- No catch-up/replay: `listen` and the inbox see live traffic, not history.
- No `worker.ready` announcement (client identity, not a service).
- One session per process: concurrent long-lived consumers need distinct
  identities.

## License

MIT
