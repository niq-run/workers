---
name: niq-interface
description: Reach a niq event bus from the shell with the `niq-interface` CLI, or as MCP tools via `niq-interface mcp` — send an event to a worker, invoke a capability and wait for its reply, stream or poll bus events. Use when an agent must talk to a niq instance (wake a reason worker with worker.input, call a worker tool, observe traffic) and a remote-worker credential is available.
---

# niq-interface

`niq-interface` is the CLI form of the **interface worker** — the generic,
out-of-process counterpart of niq's built-in interface worker. The bus sees an
ordinary remote-worker identity; each invocation dials as that identity, does one
thing, and exits. Other forms (stdio MCP, TUI, minimal web UI) are planned behind
the same binary; this skill covers the CLI form.

> Renamed from `@niq.run/agent-interface-worker` in 0.3.0. The `niq-agent` bin is
> a deprecated alias for one release; use `niq-interface`.

## End-to-end flow (user → agent)

When a user gives you this skill (or the package README URL), the full handoff
is:

1. **Ensure the CLI exists** — `niq-interface --version`. If missing, install
   from the repository (see Prerequisites).
2. **Ensure this skill is active** — `niq-interface skill install`, or read
   `interface/skills/niq-interface/SKILL.md` directly from a checkout.
3. **Ask the user for a credential** — they create a **remote (dial-in)**
   worker in the niq WebUI, then paste its `NIQ_*` env block or the
   interface-worker JSON config.
4. **Store it without echoing it** — write the block to a private temp file and
   run `config import` (see below), then delete the temp file.
5. **Verify** — `info --source <name>`, then `ping --source <name>`. Stop and
   report on failure (401 → re-issue the credential; 403 → ACL/grants).
6. **Choose the target** — sends are directed only; omitting `--target` is an
   error, never an implicit `niq`. In many projects the main reason worker is
   named `niq`, so it is a common candidate. Ask the user: “Should I send to
   `niq`, your main reason worker, or a different worker id?” Never guess
   silently. To discover live ids, listen for `worker.ready`.
7. **Do the work** — `say` for a reason worker, `request` for a capability,
   `send --target` for a specific event type, `listen` to observe.
8. **Report and clean up** — summarize what was sent/received, remove temp
   files, and keep the credential in `~/.niq/interface.json` (mode `0600`).

## Prerequisites

1. The CLI is on `PATH` (`niq-interface --version`). If not, install it from npm:

   ```sh
   npm install -g @niq.run/interface-worker
   ```

   Or from the repository:

   ```sh
   # from the repository root
   npm ci -w interface
   npm install -g ./interface --install-links
   ```

   Without a global install, the workspace install links the CLI into
   `node_modules/.bin`:

   ```sh
   export PATH="$PWD/node_modules/.bin:$PATH"
   ```

   (or run `node interface/dist/start.js` in place of `niq-interface`).
2. A reachable niq bus and a **remote (dial-in) worker identity**. In the niq
   WebUI create a worker with remote placement; it shows the connect info as a
   `NIQ_*` env block and as an interface-worker JSON config (both copyable, the
   JSON also downloadable).

   Remote workers default to publish `*` / subscribe `*`. If the ACL was
   tightened, only the permitted event types can be sent (or received). A remote
   worker created with type `niq` gets the narrow niq-bridge grant
   (`worker.input` / `request.*`) rather than `*`, so use a different type for a
   general-purpose CLI identity.

## Set up a source

The WebUI can give you the connect info in two shapes:

- the **niw / env block** (also what the supervisor injects):

  ```
  NIQ_BUS_URL=http://localhost:52217
  NIQ_WORKER_ID=11
  NIQ_WORKER_CREDENTIAL=niq1.eyJ...
  # type=test
  ```

- the **interface-worker JSON config** (copy or download), which is a complete
  credential file:

  ```json
  {
    "version": 1,
    "default_source": "11",
    "sources": {
      "11": {
        "bus_url": "http://localhost:52217",
        "worker_id": "11",
        "credential": "niq1.eyJ...",
        "type": "test"
      }
    }
  }
  ```

### From an env block (the common case)

The user may paste the block into the conversation. Store it with the CLI; never
retype the credential into a repository file or print it back.

1. Pick the source name. Use the worker id (`11` above) unless the user asks for
   another name; it is a valid source name.
2. Write the block to a private temp file and import it:

   ```sh
   umask 077
   cat > /tmp/niq-connect-block <<'EOF'
   NIQ_BUS_URL=http://localhost:52217
   NIQ_WORKER_ID=11
   NIQ_WORKER_CREDENTIAL=niq1.eyJ...
   # type=test
   EOF
   niq-interface config import 11 --from-file /tmp/niq-connect-block
   rm -f /tmp/niq-connect-block
   ```

   Piping stdin also works: `niq-interface config import 11 < /tmp/niq-connect-block`.
3. Verify. `info` is offline; `ping` actually dials:

   ```sh
   niq-interface info --source 11       # bus_url / worker_id / credential_configured
   niq-interface ping --source 11       # exit 0 = the credential works
   ```

4. If the source already exists: same identity with a re-issued credential →
   `--force`; a different identity → choose another name instead of overwriting.

A malformed block fails loudly, naming the missing variable.

### From an interface-worker JSON file

A full config file carries its own source names, so omit the name:

```sh
niq-interface config import --from-file ~/Downloads/niq-interface-11.json
```

This **merges**: other sources survive, replacing an existing source needs
`--force`, and the current default is kept unless the file is the first config
or you pass `--default`. If the JSON is only a single source object (no
`sources` map), pass a name: `config import 11 --from-file source.json`.

### Use it

```sh
niq-interface ping --source 11
niq-interface say "hello" --target reason.0 --source 11
niq-interface config default 11      # optional: make it the implicit source
```

One file holds many sources, so several buses/identities can coexist:

```sh
niq-interface config list
niq-interface config show 11
niq-interface config default 11
niq-interface config remove 11
```

- File: `~/.niq/interface.json` by default; `--config <path>` or
  `NIQ_INTERFACE_CONFIG` overrides it. The CLI writes it `0600`; never commit it.
- Resolution: `--source` (or `NIQ_INTERFACE_SOURCE`) > the three
  `NIQ_BUS_URL` / `NIQ_WORKER_ID` / `NIQ_WORKER_CREDENTIAL` env vars > the
  file's `default_source` (or its only source) > error.
- `--bus-url` / `--worker-id` / `--credential` override or, on their own,
  supply a connection for one command.

## Commands

All data goes to stdout as JSON (NDJSON for `listen`). Diagnostics go to
stderr. Exit codes: `0` ok, `1` failure, `2` usage error.

| Command | What it does |
|---|---|
| `send <type> --target <id>… [-d <json>]` | Publish one **directed** event. At least one `--target` is required; broadcast is intentionally disabled. |
| `request <type> --target <id> [-d <json>] [--timeout 30s]` | Send and wait for the matching `request.completed` / `request.failed` / `request.rejected`. |
| `say <text> --target <id> [--mode append\|schedule\|interrupt]` | Send `worker.input` with `{text, input_mode}` — the short form for waking a reason worker. |
| `listen [--type <pattern>]… [--from <id>]… [--max n] [--timeout <dur>]` | Stream events routed to this identity, one JSON object per line. |
| `ping` | Open the SSE stream once and close it; reports handshake latency. |
| `info` | Show the resolved connection offline (credential redacted). |
| `config <sub>` | `path`, `list`, `show`, `add`, `import`, `remove`, `default`. `import` takes the WebUI env block (named) or interface-worker JSON (merged). |
| `skill <sub>` | `path`, `print`, `install [--dest <dir>]` — the companion skill. |

Payload input: `-d '<json-object>'`, `-d -` (stdin), or `--data-file <path>`.
`--dry-run` prints the event without dialing. Durations accept `500ms`, `30s`,
`5m`, `1h`; a bare number means seconds.

## Recipes

Wake a reason worker:

```sh
niq-interface say "Summarise today's notes" --target reason.0 --source home
```

Call a capability and read the reply:

```sh
niq-interface request hello.greet --target hello@bus -d '{"name":"niq"}'
# { "ok": true, "request_id": "…", "reply": { "type": "request.completed", "payload": { "result": "hello, niq!" } } }
```

Observe traffic for a bounded window:

```sh
niq-interface listen --type 'reason.*' --type 'worker.*' --max 20 --timeout 30s --source watch
```

The listener writes a readiness line to **stderr** after the stream is
established; a caller that starts it in the background can wait for that before
publishing.

Notify a worker directly:

```sh
niq-interface send ops.notice --target niq -d '{"text":"deploy done"}'
```

## MCP mode (tools instead of shell)

If the harness supports MCP, prefer it over shelling out: the same capabilities
arrive as tools, and with `--persistent` you can send and then poll.

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

| Tool | Notes |
|---|---|
| `niq_send {target, event, payload?}` | Directed, fire-and-forget |
| `niq_request {target, event, payload?, timeout_ms?}` | Waits for the correlated reply |
| `niq_say {target, text, mode?}` | `worker.input` to a reason worker |
| `niq_status` | Connection + inbox counters |
| `niq_inbox {cursor?, wait_ms?, types?, from?, limit?}` | Persistent mode only |

Without `--persistent` each tool call dials and disconnects (the CLI model);
there is no inbox.

**Send-then-poll (a2a style), persistent mode:**

1. `niq_send` → returns immediately.
2. `niq_inbox {cursor: 0, wait_ms: 30000}` → blocks until something arrives;
   returns `{events, next_cursor}`.
3. Reuse `next_cursor` as `cursor` — no duplicates.

Caveats: the persistent server **owns the identity**, so do not run CLI commands
with the same `--source` (they would replace its connection); give the server its
own source. The inbox is bounded (default 500), and `gap: true` means events were
dropped before the oldest one still held. The server is a client: it does not
announce `worker.ready`, so peers need its worker id to reach it.

## Rules and pitfalls

- **Never print a credential.** `info` and `config list/show` redact it;
  `--show-credential` is for a deliberate human check only.
- **One identity = one live session.** The bus keeps one connection per
  worker id. A `send`/`request` using the same source while `listen` is running
  replaces the listener (which then exits with "the bus closed the event
  stream"). Give a long-lived listener its own source.
- **Every send is directed; there is no broadcast and no implicit target.**
  `send` needs `--target`. If you do not know the id, ask the user. In many
  projects the main reason worker is named `niq` (a common candidate, not a
  default); confirm it or another id explicitly. Watch `worker.ready` presence
  to discover ids, or read them from the WebUI.
- **`request` needs a replying target.** Reason-family workers consume
  `worker.input` without a `request.completed`; use `say` for them and `request`
  for tool-like capabilities.
- If `publish` is rejected (403), check that worker's publish permission for the
  event type in the WebUI. On 401, the credential is expired/revoked or the
  identity is not remote-connectable: re-copy the block and re-import it with
  `config import <name> --force`.
- Event streams are NDJSON: parse line by line, and do not expect a JSON array.
- **One-shot commands do not wait.** `send`, `say` and `request` push the event
  (for `request`, also read the one correlated reply), print the JSON result and
  exit — the session closes with the process. There is no follow-up output and
  nothing to keep open or poll: once stdout has the result, the work is done.
  `listen` is the only command that stays connected.

## Give another agent this skill

```sh
niq-interface skill install            # copies to ~/.agents/skills/niq-interface
niq-interface skill print              # print SKILL.md to stdout
niq-interface skill path               # where it lives in the installed package
```
