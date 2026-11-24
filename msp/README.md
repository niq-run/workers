# @niq.run/msp-worker

An **MSP world bridge** for [niq](https://github.com/niq-run/niq). It runs as a
node in an [MSP](https://github.com/msp-world/msp-ts) world — discovering peers
through a shared directory, speaking MSP's tool/signal protocol over TCP — and
makes that world reachable from niq (and niq reachable from it).

Built on [`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk).
The MSP TypeScript SDK is **vendored** (it is not published to npm yet); see
[`VENDORED.md`](VENDORED.md).

## Shape: an interface worker with an MSP backend

| Half | Owns | Where |
|---|---|---|
| `InterfaceWorker` (SDK) | the **niq side**: identity, ACL, presence, `worker.discover`, tool dispatch, replies, request correlation | `@niq.run/worker-sdk` |
| `MspBackend` | the **MSP side**: the node, its TCP endpoint, the discovery directory, and the tool/signal bridge in both directions | `src/backend.ts` |

Assembled in `src/worker.ts`, exactly like the lark worker:

```ts
const backend = new MspBackend(mspConfig);        // capability
const worker = new InterfaceWorker({              // bus participation
  id: bus.id, channel: bus, type: "msp",
  backends: [backend],
});
backend.registerTools(worker);
await worker.start();                              // connect bus → inject → create node → announce → serve
```

## Quick start

The package is not published to npm yet — install it from this repository:

```sh
git clone https://github.com/niq-run/workers.git
cd workers
npm ci -w msp
npm install -g ./msp --install-links
```

Then run it as a process, either with the worker connection from the
supervisor-injected environment or explicit flags:

```sh
# the niq supervisor injects NIQ_BUS_URL / NIQ_WORKER_ID / NIQ_WORKER_CREDENTIAL
niq-msp

# or point it at a bus yourself, and give it its own MSP node id
niq-msp --bus-url http://localhost:8080 \
        --worker-id msp@world \
        --credential "$NIQ_WORKER_CREDENTIAL" \
        --msp-node-id msp-bridge
```

Once published, `npm install -g @niq.run/msp-worker` will provide the same
`niq-msp` binary. Requires Node **≥ 22.6** (the vendored SDK uses `.ts` import
specifiers internally, which this package compiles away).

## What it connects to

MSP has no central broker: nodes announce themselves in a **shared directory**
(`~/.msp/nodes` by default) and then talk to each other over TCP. Two nodes that
share a directory and a reachable host:port form a world. So "connecting to an
MSP world" means:

- joining the same `nodesDir` as the peers you care about (same machine, or a
  synced/shared path), and
- binding on a host/port those peers can reach.

Discovery is automatic; with `MSP_CONNECT_POLICY=eager` the node dials every
peer it discovers, so `msp.nodes` usually shows peers as soon as they start.

## Config

| Purpose | Env | Flag | Default |
|---|---|---|---|
| Bus base URL | `NIQ_BUS_URL` | `--bus-url` | — |
| Bus worker id | `NIQ_WORKER_ID` | `--worker-id` | — |
| Bus credential | `NIQ_WORKER_CREDENTIAL` | `--credential` | — |
| MSP node id | `MSP_NODE_ID` | `--msp-node-id` | sanitized worker id |
| Shared discovery dir | `MSP_NODES_DIR` | `--msp-nodes-dir` | `~/.msp/nodes` |
| TCP bind host | `MSP_HOST` | `--msp-host` | `127.0.0.1` |
| TCP bind port | `MSP_PORT` | `--msp-port` | `0` (ephemeral) |
| Dial discovered peers | `MSP_CONNECT_POLICY` | `--msp-connect-policy` | `eager` (`lazy` = accept only) |
| Signals to forward to niq | `MSP_SUBSCRIBE` | `--msp-subscribe` | `**` (all) |
| niq event type for signals | `MSP_SIGNAL_EVENT` | `--msp-signal-event` | `msp.signal` |
| Direct signals to one worker | `MSP_SIGNAL_TARGET` | `--msp-signal-target` | _(unset — broadcast)_ |
| Default `msp.call` timeout | `MSP_CALL_TIMEOUT_MS` | `--msp-call-timeout-ms` | `5000` |
| Signal paths to advertise | `MSP_DECLARE_SIGNALS` | `--msp-declare-signals` | _(none)_ |

Flags win over the environment. `MSP_SUBSCRIBE` and `MSP_DECLARE_SIGNALS` are
comma-separated lists. A node id must match `^[a-z0-9_-]+$`; the default is the
niq worker id lowercased with everything else replaced by `-`.

## niq tools (what niq callers use)

All four are ordinary niq tools: call them as `msp.nodes` etc. from a reason
worker or any bus client.

| Tool | Request | Reply |
|---|---|---|
| `msp.nodes` | `{}` | `{ node_id, connections, peers: [{ id, tools, signals, skills, patterns, capabilities }] }` |
| `msp.call` | `{ peer, tool, args?, timeout_ms? }` | `{ peer, tool, result }` |
| `msp.publish` | `{ path, payload? }` | `{ ok, path }` |
| `msp.manifest` | `{ peer }` | `{ peer, manifest }` |

`msp.call` is a request/reply: it calls the MSP tool, unwraps the result, and
fails the niq request when the peer returned an error. `msp.publish` fans a
signal out to every connected MSP peer subscribed to the path.

Example — call an MSP peer from niq:

```
msp.nodes                                   # → who is connected, and what they offer
msp.call { peer: "device_gw", tool: "read_temp", args: { zone: "a" } }
msp.publish { path: "demo.tick", payload: { n: 1 } }
```

## MSP tools (what MSP peers can call)

Two tools are registered on the MSP node, so a peer on the MSP side can reach
back into niq:

| Tool | Args | Result |
|---|---|---|
| `niq_call` | `{ target, event, payload?, timeout_ms? }` | the niq reply value |
| `niq_send` | `{ target, event, payload? }` | `{ ok, target, event }` |

`niq_call` uses niq's request/reply: the peer gets the callee's reply value, or
an MSP tool error when the niq request fails. `niq_send` is fire-and-forget.

## Signals: MSP → niq

Every inbound MSP signal matching `MSP_SUBSCRIBE` is forwarded as a niq event of
type `MSP_SIGNAL_EVENT` (default `msp.signal`), with payload:

```json
{ "node": "<msp peer id>", "path": "demo.tick", "payload": { "n": 1 }, "timestamp": 1730000000.123 }
```

It is **broadcast** by default (whoever subscribes on the bus sees it). Set
`MSP_SIGNAL_TARGET` to deliver it to one worker instead. Signals this node
published itself are not echoed back.

The worker advertises the event type in its `worker.ready` presence, so a peer
that asks `worker.discover` sees that it publishes `msp.signal`.

## Security

MSP is designed for a **trusted local host or LAN**: plain TCP, no TLS, no
authentication, no per-peer ACL. Anyone who can reach the port can call the
`niq_call` / `niq_send` tools this worker exposes, and publish signals.

- Keep `MSP_HOST=127.0.0.1` unless you really mean to expose the node.
- On a shared network, treat the node id as public and the endpoint as open.
- The niq side is still gated by the bus: `niq_call` / `niq_send` act as this
  worker's identity, so the bus ACL decides what it may reach.

## Development

```sh
cd msp
npm run typecheck
npm test            # config, backend, and a real two-node integration test
npm run build       # tsc -> dist/
node dist/start.js --help
```

- `src/config.ts` — flag/env/default resolution.
- `src/backend.ts` — the bridge (niq tools, MSP tools, signal forwarding).
- `src/worker.ts` — assembly (backend + `InterfaceWorker`).
- `src/start.ts` — the `niq-msp` binary.
- `src/vendor/msp-ts/` — vendored MSP SDK, pinned and patched; see
  [`VENDORED.md`](VENDORED.md).

## License

MIT. The vendored MSP SDK is MIT, copyright hxh230802 — see
[`VENDORED-MSP-TS-LICENSE`](VENDORED-MSP-TS-LICENSE).
