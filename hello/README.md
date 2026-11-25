# @niq.run/hello-worker

**The reference example for writing a niq worker.** Start here.

It is a complete, small worker — not a toy stub: it holds state, serves two
capabilities (one replying with text, one with a structured object), declares a
broadcast it emits, answers `worker.readme` / `worker.help`, layers flags over
env with defaults, drains in-flight work on shutdown, and is tested against a
fake bus. Every pattern you need for a real worker appears here once, in the
order you will need it.

Built on [`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk)
— it has **no other runtime dependency**.

```sh
npx @niq.run/hello-worker          # or: npm install -g @niq.run/hello-worker && niq-hello
```

> This guide describes the version in this repository (0.2.0). Until that is
> published, the npm release still carries the older 0.1.0 worker — install from
> a checkout to follow along: `npm ci -w hello && npm install -g ./hello --install-links`.

---

## 1. What a worker is

A worker is an **actor**: it has an identity on the bus, owns its own state, and
only changes that state while handling a message. It never reaches into another
worker; it sends events and reacts to events.

The bus gives you three things, and everything else is yours:

| The bus does | You do |
|---|---|
| routes events by type (`send` to ids, `broadcast` to subscribers) | decide which event types you serve and declare their schemas |
| correlates a request with its reply (`request_id`) | answer with `request.completed` / `request.failed` |
| delivers presence (`worker.ready`) and discovery (`worker.readme` / `worker.help`) | announce a type and publish the contract |

There is no shared memory, no RPC stub, no framework. A worker is a class with a
loop.

## 2. Anatomy

```
hello/
├── package.json          # name, bin, files, engines, release script
├── tsconfig.json         # extends ../tsconfig.base.json
├── README.md             # this guide
└── src/
    ├── worker.ts         # the worker: state, capabilities, handlers, lifetime
    ├── start.ts          # the `niq-hello` binary: args -> worker -> run
    └── worker.test.ts    # protocol tests against a fake bus
```

Why three source files:

- **`worker.ts` is a library.** No argument parsing, no `process.exit`. It is
  importable in-process (so the runtime can embed it) and testable without a
  bus.
- **`start.ts` is a process.** It is the `bin` target: parse args, build the
  worker, run it. Keeping this thin is what lets the same worker be embedded or
  run standalone.
- **`worker.test.ts` is the contract test.** It drives the real SDK client
  against a fake bus, so it exercises the wire behaviour (reply correlation,
  presence, schemas) without a server.

## 3. The lifecycle contract

```ts
async run(): Promise<void> {
  await this.base.channel.connect();          // 1. open the stream first
  await this.base.announceReady("hello", HELLO_PUBLISHES); // 2. presence
  for await (const evt of this.base.channel.events()) {    // 3. serve
    this.base.dispatchExtension(evt);
  }
}

async close(): Promise<void> {
  await Promise.allSettled([...this.work]);   // 4. drain handlers
  await this.base.channel.close();            // 5. close the stream
}
```

The order is not cosmetic:

1. **Connect before announcing.** The bus only accepts publishes from an open
   session; a `worker.ready` sent too early is dropped.
2. **Announce presence once.** `worker.ready` is how peers and the WebUI learn
   you exist, what type you are, what you serve, and (via `publishes`) what you
   emit. It is transient — live only, never in the event log.
3. **Dispatch everything.** `dispatchExtension` routes an event to the
   extension registered for its type, and answers `worker.discover` from the
   remembered contract.
4. **Drain on shutdown.** The dispatch loop does not await handlers (one slow
   handler must not stall the loop), so the worker tracks its handler promises
   and awaits them in `close()`. Skip this and Ctrl-C can truncate a reply.
5. **Close last**, so nothing is published into a closed channel.

## 4. Capabilities: the extension registry

```ts
this.base.register(
  {
    event: "hello.greet",
    description: "Greet a name and return the greeting text.",
    parameters: s.object({ name: s.optional(s.string("Who to greet.")) }),
    response: s.string('Greeting text, e.g. "hello, world!".'),
  },
  (evt) => this.track(this.handleGreet(evt)),
);
```

`register` is one thing doing two jobs:

- **Declaration** — `description`, `parameters` and `response` are rendered into
  `worker.ready`, so peers and the WebUI see your contract before calling you.
  This is what makes an agent able to plan a call.
- **Dispatch** — the handler is what runs when an event of that type arrives.

Schemas are plain JSON Schema. `s.object` / `s.string` / `s.optional` / `s.array`
/ `s.integer` / `s.enumOf` are a tiny builder in the SDK, so you need no schema
library; passing a hand-written JSON Schema or a zod 4 schema works too.

A few rules that save debugging time:

- **Subscriptions are about broadcasts, not directed calls.** The bus fans a
  broadcast out to online workers whose subscriptions match; a directed send (a
  peer calling this worker by id) is delivered regardless. This worker subscribes
  to the events it serves so a broadcast of them is also handled; a worker that
  only ever answers directed calls does not strictly need them.
- **`internal: true`** marks a capability that is only meaningful to you: it is
  hidden from the peer-facing `worker.ready`, and requests from other workers are
  refused before your handler runs. Use it for self-inspection endpoints.
- **A schema is documentation, not validation.** Nothing on the bus checks the
  payload. Validate in the handler when it matters (this example just trims).

## 5. Replying

```ts
const call = parseToolCall(evt);        // { callID, callerID, args, traceID }

if (!call.callID) return;               // notification: nobody waits
await this.base.replyString(call.callerID, call.callID, "hello!", call.traceID);
```

- **`request_id` present ⇒ answer it. Absent ⇒ notification.** `parseToolCall`
  puts it in `callID`. Never reply to a notification.
- **Text replies** are wrapped as `{ result: "..." }`; **object replies** are
  the payload itself (`replyObject`), which is what makes structured results
  pleasant for a caller to consume.
- **Errors are replies too:** `replyFailed(callerID, callID, "why")` (and
  `replyRejected` for a policy refusal). A handler that throws does not answer
  the caller — they time out. Catch and reply.
- `traceID` is echoed so a multi-worker trace stays connected. Pass it along.

## 6. Presence, discovery, self-description

| Event | Effect |
|---|---|
| `worker.ready` (broadcast, transient) | `{ type, watch: [...schemas], publishes: [...] }`, self-excluded |
| `worker.discover` → directed `worker.ready` | a peer that started later asks for your contract |
| `worker.readme` → text | your usage guide (`registerReadme`) |
| `worker.help { event_name, params? }` → text | the guide for one event (`registerHelp`) |

Register the last two in **every** worker you write. They cost ten lines and
they are how an agent — or a human with the CLI — finds out how to use you
without reading your source. A custom `HelpFunc` may return `null` to fall back
to the generic guide generated from the declared schema.

Declare `publishes` only for your **own** domain events (`hello.greeted`).
Universal protocol replies are implied.

## 7. Config: flags > env > default

Two layers, deliberately separate:

- **Bus connection** — `busConnFromArgs(opts)` layers `--bus-url` /
  `--worker-id` / `--credential` over the supervisor-injected
  `NIQ_BUS_URL` / `NIQ_WORKER_ID` / `NIQ_WORKER_CREDENTIAL`. All three are
  required together; `readBusEnv` names whichever is missing.
- **Worker config** — a flag in `start.ts`, an env fallback in `worker.ts`, a
  literal default last. This example does it for `--default-name` /
  `HELLO_DEFAULT_NAME` / `world`.

Keep the precedence consistent everywhere; an agent told "set the env var" must
not be silently overridden by a stale flag.

| Purpose | Env | Flag | Default |
|---|---|---|---|
| Bus base URL | `NIQ_BUS_URL` | `--bus-url` | — |
| Bus worker id | `NIQ_WORKER_ID` | `--worker-id` | — |
| Bus credential | `NIQ_WORKER_CREDENTIAL` | `--credential` | — |
| Name to greet | `HELLO_DEFAULT_NAME` | `--default-name` | `world` |

## 8. Testing without a bus

`worker.test.ts` builds a fake bus: `/events` returns an SSE `Response` holding
the events you want delivered, then closes; `/publish` records the body. That is
enough to drive the **real** SDK client end to end.

What to assert in a new worker:

- the reply's `type`, `request_id` and `payload` (text vs object shape);
- that a notification (no `request_id`) produces **no** reply;
- the `worker.ready` payload: `type`, `watch` events and schemas, `publishes`,
  `exclude_worker_id`;
- the `worker.readme` / `worker.help` answers;
- the unhappy paths — a failed broadcast must not fail the caller (this example
  makes the fake bus reject a publish to prove it).

## 9. Packaging

```json
{
  "type": "module",
  "main": "./dist/worker.js",
  "types": "./dist/worker.d.ts",
  "bin": { "niq-hello": "./dist/start.js" },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepare": "npm run build"
  }
}
```

- `main`/`types` point at the **library** (the worker class); `bin` points at
  the **process**. Both come from the same build.
- `prepare` builds on install from a checkout/git, so `npm install -g ./hello`
  works without a separate build step.
- Keep `files` tight: `dist` plus the README.

## 10. Create your own worker

1. `cp -R hello my-worker` (or add a new directory), then delete `dist/` and
   `node_modules/`.
2. Rename: `package.json` `name`/`bin`/`description`/`homepage`, and the worker
   class + exported constants. Pick a **worker type** (announced in
   `worker.ready`) and a **namespace** for your event types (`my-worker.*`).
3. Replace the capabilities in `src/worker.ts`: keep the shape, change the
   events, schemas and handlers. Keep `registerReadme` / `registerHelp`.
4. Rewrite `src/worker.test.ts` for your events — keep the fake-bus helper.
5. Update `src/start.ts` flags and this README's tables.
6. Add the directory to the root `workspaces` array in `package.json`.
7. `npm install`, then `npm run typecheck`, `npm test`, `npm run build` from the
   repo root.

## 11. Which base class?

| You are building | Use | Reference |
|---|---|---|
| A worker with a domain of its own (timers, search, a queue…) | `BaseWorker` | **this package** |
| A seam to an outside world — a chat platform, a protocol, a local harness | `InterfaceWorker` + a backend class | [`lark`](../lark), [`msp`](../msp), [`interface`](../interface) |

`BaseWorker` is the raw contract: identity, extensions, replies, presence.
`InterfaceWorker` is the same contract plus the "two halves" split — the niq side
(identity, dispatch, replies, request correlation) stays shared, and a *backend*
class owns the outward side and its lifetime. `lark` bridges Feishu, `msp`
bridges an MSP world, `interface` exposes the bus to a local process (CLI form
today). Start from `hello` for a domain worker; start from `lark` for a bridge.

## 12. Pitfalls

- **One identity = one live session.** The bus keeps one connection per worker
  id; a second connection replaces the first (which then sees its stream close).
  Two processes need two identities.
- **Don't await inside the dispatch loop.** `dispatchExtension` deliberately
  does not await handlers. Track promises and drain them in `close()` instead.
- **A throwing async handler is an unhandled rejection** unless you catch it.
  This example catches in `track()` and reports to stderr.
- **Broadcast is best-effort.** If nobody subscribes, the event vanishes — that
  is normal. Do not make a caller's request fail because a fan-out failed.
- **stdout is for data.** Log to stderr, and never print a credential.
- **Remote identity ≠ local process.** A worker dials in with the credential the
  control plane issued; it never registers itself. See the niq WebUI's remote
  worker block.
- **Presence is transient.** Do not read `worker.ready` from history; it is not
  persisted. Ask `worker.discover` instead.

## 13. This worker's contract

### Serves

| Event | Payload | Reply |
|---|---|---|
| `hello.greet` | `{ name?: string }` | text: `hello, <name \| default>!` |
| `hello.stats` | `{}` | `{ greeted, names, uptime_ms, default_name }` |
| `worker.readme` | `{}` | text: live usage guide |
| `worker.help` | `{ event_name, params? }` | text: per-event guide |

### Publishes

| Event | Payload | Destination |
|---|---|---|
| `worker.ready` | `{ type: "hello", watch, publishes }` | broadcast (presence, transient) |
| `hello.greeted` | `{ name, greeting }` | broadcast (fire-and-forget) |
| `request.completed` | reply payload | request caller |

### Try it

```sh
# with the credential block from the niq WebUI for a remote worker
niq-interface config import hello --from-file ./block.txt
niq-interface request hello.greet --target <this-worker-id> -d '{"name":"ada"}'
niq-interface request hello.stats --target <this-worker-id>
```

## 14. Development

```sh
npm install
npm run typecheck
npm test        # vitest, fake bus, no server needed
npm run build   # tsc -> dist/
node dist/start.js --help
```

## License

MIT
