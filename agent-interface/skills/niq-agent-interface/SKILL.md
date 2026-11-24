---
name: niq-agent-interface
description: Reach a niq event bus from the shell with the `niq-agent` CLI — send an event to a worker, invoke a capability and wait for its reply, or stream bus events. Use when an agent must talk to a niq instance (wake a reason worker with worker.input, call a worker tool, observe traffic) and a remote-worker credential is available.
---

# niq-agent-interface

`niq-agent` is the CLI form of the **agent interface worker**: the seam between
a niq bus and an AI agent. The bus sees an ordinary remote-worker identity;
each invocation dials as that identity, does one thing, and exits.

## End-to-end flow (user → agent)

When a user gives you this skill (or the package README URL), the full handoff
is:

1. **Ensure the CLI exists** — `niq-agent --version`. If missing, install
   from the repository (see Prerequisites).
2. **Ensure this skill is active** — `niq-agent skill install`, or read
   `agent-interface/skills/niq-agent-interface/SKILL.md` directly from a checkout.
3. **Ask the user for a credential** — they create a **remote (dial-in)**
   worker in the niq WebUI, then paste its `NIQ_*` env block or the
   agent-interface JSON config.
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

1. The CLI is on `PATH` (`niq-agent --version`). If not, install it from npm:

   ```sh
   npm install -g @niq.run/agent-interface-worker
   ```

   Or from the repository:

   ```sh
   # from the repository root
   npm ci -w agent-interface
   npm install -g ./agent-interface --install-links
   ```

   Without a global install, the workspace install links the CLI into
   `node_modules/.bin`:

   ```sh
   export PATH="$PWD/node_modules/.bin:$PATH"
   ```

   (or run `node agent-interface/dist/start.js` in place of `niq-agent`).
2. A reachable niq bus and a **remote (dial-in) worker identity**. In the niq
   WebUI create a worker with remote placement; it shows the connect info as a
   `NIQ_*` env block and as an agent-interface JSON config (both copyable, the
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

- the **agent-interface JSON config** (copy or download), which is a complete
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
   niq-agent config import 11 --from-file /tmp/niq-connect-block
   rm -f /tmp/niq-connect-block
   ```

   Piping stdin also works: `niq-agent config import 11 < /tmp/niq-connect-block`.
3. Verify. `info` is offline; `ping` actually dials:

   ```sh
   niq-agent info --source 11       # bus_url / worker_id / credential_configured
   niq-agent ping --source 11       # exit 0 = the credential works
   ```

4. If the source already exists: same identity with a re-issued credential →
   `--force`; a different identity → choose another name instead of overwriting.

A malformed block fails loudly, naming the missing variable.

### From an agent-interface JSON file

A full config file carries its own source names, so omit the name:

```sh
niq-agent config import --from-file ~/Downloads/niq-agent-11.json
```

This **merges**: other sources survive, replacing an existing source needs
`--force`, and the current default is kept unless the file is the first config
or you pass `--default`. If the JSON is only a single source object (no
`sources` map), pass a name: `config import 11 --from-file source.json`.

### Use it

```sh
niq-agent ping --source 11
niq-agent say "hello" --target reason.0 --source 11
niq-agent config default 11      # optional: make it the implicit source
```

One file holds many sources, so several buses/identities can coexist:

```sh
niq-agent config list
niq-agent config show 11
niq-agent config default 11
niq-agent config remove 11
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
| `config <sub>` | `path`, `list`, `show`, `add`, `import`, `remove`, `default`. `import` takes the WebUI env block (named) or agent-interface JSON (merged). |
| `skill <sub>` | `path`, `print`, `install [--dest <dir>]` — the companion skill. |

Payload input: `-d '<json-object>'`, `-d -` (stdin), or `--data-file <path>`.
`--dry-run` prints the event without dialing. Durations accept `500ms`, `30s`,
`5m`, `1h`; a bare number means seconds.

## Recipes

Wake a reason worker:

```sh
niq-agent say "Summarise today's notes" --target reason.0 --source home
```

Call a capability and read the reply:

```sh
niq-agent request hello.greet --target hello@bus -d '{"name":"niq"}'
# { "ok": true, "request_id": "…", "reply": { "type": "request.completed", "payload": { "result": "hello, niq!" } } }
```

Observe traffic for a bounded window:

```sh
niq-agent listen --type 'reason.*' --type 'worker.*' --max 20 --timeout 30s --source watch
```

The listener writes a readiness line to **stderr** after the stream is
established; a caller that starts it in the background can wait for that before
publishing.

Notify a worker directly:

```sh
niq-agent send ops.notice --target niq -d '{"text":"deploy done"}'
```

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

## Give another agent this skill

```sh
niq-agent skill install            # copies to ~/.agents/skills/niq-agent-interface
niq-agent skill print              # print SKILL.md to stdout
niq-agent skill path               # where it lives in the installed package
```
