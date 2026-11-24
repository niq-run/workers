# @niq.run/agent-interface-worker

An **agent interface worker** for niq: the seam between a
[niq](https://github.com/niq-run/niq) event bus and an AI agent. The bus sees an
ordinary remote-worker identity; the current form is a CLI, and the process
shape is an implementation detail — the audience is what names it.

Use it from a shell to send directed events, call a capability and wait for its
reply, or stream traffic — without writing SDK code.

Every invocation is short-lived: it opens the bus's SSE session as one remote
worker identity, does one thing, and exits. Credentials live in a local
multi-source file whose format is exactly the block the niq WebUI shows after
creating a **remote** worker.

The bus operations are built on the SDK's `InterfaceSession` — the stateless
half of the TypeScript interface worker. Stateful forms (a bridge, a daemon)
use `InterfaceWorker` and keep presence, backends and tools; this CLI does not.

## Quick start (from this repository)

An agent given the repository URL (`https://github.com/niq-run/workers`) can
install from a checkout and run this end to end. The package is also published
as `@niq.run/agent-interface-worker`, so
`npm install -g @niq.run/agent-interface-worker` is the shorter path (see
[Install](#install)).

```sh
# 1. install the CLI (Node 18+)
git clone https://github.com/niq-run/workers.git
cd workers
npm ci -w agent-interface                  # deps + `prepare` builds agent-interface/dist
npm install -g ./agent-interface --install-links
niq-agent --version

# 2. install the companion skill for the agent harness
niq-agent skill install              # -> ~/.agents/skills/niq-agent-interface

# 3. connect with the block the niq WebUI shows for a remote worker
#    (save the copied block as block.txt, or drop --from-file and paste it)
niq-agent config import 11 --from-file ./block.txt
niq-agent ping --source 11

# 4. use it
niq-agent say "summarise today's notes" --target reason.0 --source 11
niq-agent listen --type 'reason.*' --max 10 --timeout 30s --source 11
```

An agent that only has the repository can read the skill before installing
anything: [`skills/niq-agent-interface/SKILL.md`](skills/niq-agent-interface/SKILL.md)
(or `niq-agent skill print` after installing).

If the global npm prefix is not writable, skip the `npm install -g` line and
add the workspace bin to PATH instead (the workspace install links it there):
`export PATH="$PWD/node_modules/.bin:$PATH"`.

## End-to-end flow (user → agent)

When a user gives an agent this README's URL, the handoff is:

1. **Agent installs the CLI** — clone, `npm ci -w agent-interface`,
   `npm install -g ./agent-interface --install-links` (see [Install](#install)).
2. **Agent installs the skill** — `niq-agent skill install`, or reads
   `skills/niq-agent-interface/SKILL.md` directly.
3. **User issues a credential** — in the niq WebUI create a **remote
   (dial-in)** worker, choose its id, then copy the `NIQ_*` env block (or the
   agent-interface JSON) and hand it to the agent.
4. **Agent stores it** — `niq-agent config import <id> --from-file <file>`
   (a full JSON config omits `<id>`); never echo the credential back.
5. **Agent verifies** — `niq-agent info --source <id>`, then
   `niq-agent ping --source <id>`. `401` means re-issue the credential;
   `403` means an ACL/publish-permission problem.
6. **Agent resolves the target** — sends are directed only; there is no
   implicit target. Ask the user. In many projects the main reason worker is
   named `niq`, a common candidate — confirm it (or a different id) explicitly.
   If unsure, list live ids with
   `niq-agent listen --type worker.ready --max 20 --timeout 10s --source <id>`.
7. **Agent works** — `say` / `send --target` / `request --target` / `listen`,
   then reports the result (or the failure) to the user.
8. **Cleanup** — remove any temp block file; the credential file stays at
   `~/.niq/interface.json` with mode `0600`.

## Install

Node **18+** (uses global `fetch`, `ReadableStream`, `AbortSignal`).

### From npm

```sh
npm install -g @niq.run/agent-interface-worker   # gives the `niq-agent` command
npx -y @niq.run/agent-interface-worker --help    # or run without installing
```

### From this repository

```sh
git clone https://github.com/niq-run/workers.git
cd workers
npm ci -w agent-interface
npm install -g ./agent-interface --install-links
```

- `npm ci -w agent-interface` installs only this workspace's dependencies and runs
  the package's `prepare`, which builds `dist/`. Do not skip it: a bare clone has
  no `tsc`, so `--install-links` would fail in `prepare` with
  `tsc: command not found`.
- In an existing checkout where dependencies are already installed, use
  `npm install -w agent-interface` instead of `npm ci` (which resets
  `node_modules`).
- `--install-links` packs the package and installs its
  `@niq.run/worker-sdk` dependency, instead of symlinking the source tree.
- No permission for the global npm prefix? Install into a user prefix:

  ```sh
  npm install -g ./agent-interface --install-links --prefix "$HOME/.local"
  export PATH="$HOME/.local/bin:$PATH"
  ```

- Prefer no global install (and no writes to a global prefix)? The workspace
  install already links the CLI into `node_modules/.bin`:

  ```sh
  export PATH="$PWD/node_modules/.bin:$PATH"
  niq-agent --version
  ```

  The skill's examples then work unchanged (they assume `niq-agent` on
  PATH). The alternative is `node agent-interface/dist/start.js ...`.

### Install the skill

```sh
niq-agent skill install                          # ~/.agents/skills/niq-agent-interface
niq-agent skill install --dest .agents/skills    # project-local
niq-agent skill install --force                  # overwrite an older copy
niq-agent skill print                            # print SKILL.md to stdout
```

`npm install` does **not** install the skill: agent harnesses use different
skill directories, and install scripts are frequently disabled. The copy is
explicit so you choose the destination; to uninstall, remove
`<dest>/niq-agent-interface`.

## How it connects

A niq bus only lets **registered** identities connect: create a worker in the
WebUI with remote (dial-in) placement, and it hands you a connect block:

```
NIQ_BUS_URL=http://192.168.1.20:7801
NIQ_WORKER_ID=agent.laptop
NIQ_WORKER_CREDENTIAL=eyJ...
# type=agent
```

Import it verbatim:

```sh
niq-agent config import home          # stdin
niq-agent config import home --from-file ./block.txt
```

The WebUI can hand this out in two shapes: the `NIQ_*` **env block** above (for
niw / supervisor-launched workers) and a ready-to-use **agent-interface JSON
config** (copy or download). `config import` accepts both — an env block adds
one source under the name you pass; a full JSON file merges all of its sources
and takes no name:

```sh
niq-agent config import home --from-file block.env
niq-agent config import --from-file ~/Downloads/niq-agent-11.json
```

A full-file import merges (it never deletes other sources), refuses to replace
an existing source without `--force`, and keeps your current `default_source`
unless the file is the first config or you pass `--default`.

The CLI never registers identities — it only dials with one the bus already
issued. Remote workers default to publish `*` / subscribe `*`; if the worker's
permissions were tightened in the WebUI, the event types you use must be on its
allow lists. Note that a remote worker created with type `niq` gets the narrow
niq-bridge grant (`worker.input` / `request.*`), not the `*` third-party
default — pick another type for a general-purpose CLI identity.

## Credential file

Default path: **`~/.niq/interface.json`** (override with `--config <path>` or
`NIQ_INTERFACE_CONFIG`). It is created with mode `0600`; the loader warns if it
is readable by other users.

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
    "work": {
      "bus_url": "http://10.0.0.5:7801",
      "worker_id": "agent.work",
      "credential": "eyJ...",
      "type": "agent"
    }
  }
}
```

One file, many buses/identities. `type` is informational (copied from the
WebUI's `# type=` comment).

**Resolution order** when a command dials:

1. `--source <name>` (or `NIQ_INTERFACE_SOURCE`) — that source must exist.
2. `NIQ_BUS_URL` + `NIQ_WORKER_ID` + `NIQ_WORKER_CREDENTIAL` — the supervisor
   convention; all three are required together.
3. The file's `default_source`, or its only source if there is exactly one.
4. Otherwise a guiding error.

`--bus-url` / `--worker-id` / `--credential` overlay the chosen base, and can
supply a one-off connection on their own.

> **One identity = one live session.** The bus keeps a single SSE connection per
> worker id. Running `send`/`request` with the same source while `listen` is
> running replaces the listener (which then exits). Give a long-lived listener
> its own source — a second remote worker in the WebUI.

## Commands

stdout carries data only (JSON; NDJSON for `listen`); warnings and readiness go
to stderr. Exit codes: `0` ok, `1` failure, `2` usage error.

| Command | Description |
|---|---|
| `send <event-type> --target <id>… [-d <json>]` | Publish one **directed** event. At least one `--target` is required; broadcast is intentionally disabled. |
| `request <event-type> --target <id> [-d <json>] [--timeout 30s]` | Send with a fresh `request_id` and wait for the correlated `request.completed` / `request.failed` / `request.rejected`. |
| `say <text> --target <id> [--mode append\|schedule\|interrupt]` | Send `worker.input` as `{text, input_mode}` — the short form for a reason-family worker. |
| `listen [--type <pattern>]… [--from <id>]… [--max <n>] [--timeout <dur>]` | Stream events routed to this identity as NDJSON. |
| `ping` | Open the SSE session once, close it, report the handshake latency. |
| `info` | Show the resolved connection offline (credential redacted). |
| `config <sub>` | `path`, `list`, `show`, `add`, `import`, `remove`, `default`. `import` takes the WebUI's env block (named) or agent-interface JSON (merged). |
| `skill <sub>` | `path`, `print`, `install [--dest <dir>]` — the companion agent skill. |
| `help [command]` | Usage. |

Options shared by the bus commands:

| Flag | Meaning |
|---|---|
| `--source <name>` | Named source (else `NIQ_INTERFACE_SOURCE`) |
| `--config <path>` | Credential file (else `NIQ_INTERFACE_CONFIG`) |
| `--bus-url` / `--worker-id` / `--credential` | Per-command overrides |
| `-d, --data <json>` | Payload object; `-` reads stdin |
| `--data-file <path>` | Payload from a file |
| `--target <id>` | Target worker id (repeatable; `send` needs at least one, `request`/`say` exactly one) |
| `--trace <id>` | Attach a trace id |
| `--timeout <dur>` | `request`: reply timeout (default `30s`); `listen`: stop after |
| `--dry-run` | Print the event without dialing (`send`/`request`/`say`) |

Durations accept `500ms`, `30s`, `5m`, `1h`; a bare number means seconds.

**Sends are directed only.** There is no broadcast: `send` without `--target`
fails, and there is no implicit target. If the caller does not know the id, it
must ask the user. In many niq projects the main reason worker is named `niq`,
so that is a common candidate — not a default. `listen` can reveal live ids via
`worker.ready` presence (`niq-agent listen --type worker.ready --max 20 --timeout 10s`).

### Examples

```sh
# Directed message into a reason worker
niq-agent say "review the 2026-10 budget" --target reason.0

# Call a capability and read its structured reply
niq-agent request hello.greet --target hello@bus -d '{"name":"niq"}'
# → { "ok": true, "request_id": "…", "reply": { …, "payload": { "result": "hello, niq!" } } }

# Directed notification
niq-agent send ops.notice --target niq -d '{"text":"deploy done"}'

# Watch a bounded window (readiness line on stderr, events on stdout)
niq-agent listen --type 'reason.*' --type 'worker.*' --max 20 --timeout 30s

# Stream and pipe each event through jq
niq-agent listen | jq -c 'select(.type == "worker.ready") | .payload'
```

`request` exits `1` when the reply is `request.failed`/`request.rejected`, but
still prints the reply JSON on stdout. `listen` exits `0` at `--max`, on
timeout, or on Ctrl-C; it exits `1` if the bus closes the stream unexpectedly
(usually because another command replaced the identity).

## Companion skill

The agent-facing guide lives at
[`skills/niq-agent-interface/SKILL.md`](skills/niq-agent-interface/SKILL.md) and is
shipped inside the package. `niq-agent skill install` copies it into a
harness's skills directory (see [Install the skill](#install-the-skill));
`niq-agent skill print` writes it to stdout.

## Security notes

- Credentials are bearer tokens: anyone holding one can act as that identity
  until it expires. The file is written `0600`, and it is excluded from output
  by default. Prefer `config import` (stdin) over `--credential` on the command
  line, which can leak into shell history and process listings.
- If a token is exposed, revoke/re-issue the identity in the WebUI and re-import
  the new block with `--force`.
- The CLI does not verify bus TLS beyond Node's defaults; use `https://` when
  the bus is not on a trusted network.

## Development

```sh
npm install
npm run typecheck
npm test        # vitest: config resolution, bus protocol (fake bus), CLI
npm run build   # tsc → dist/
```

The bus tests use a fake `fetch` (an SSE `Response` plus a recording
`/publish`), so they exercise the real SDK client without a live bus.

## Limits of this first version

- Sends are directed only: there is no broadcast, and `send` requires a target.
- One-shot commands only; there is no daemon/multiplexing, so concurrent
  long-lived listeners need distinct identities.
- No catch-up/replay: `listen` sees live traffic routed to the identity, not
  history.
- No automatic `worker.ready` announcement, so other workers do not discover the
  CLI as a capability provider (it is a client, not a service).

## License

MIT
