# @niq.run/hello-worker

A minimal demo **niq Worker**: it subscribes to `hello.greet` requests and
answers each with a `request.completed` greeting. It doubles as a reference
example of the extension-registry + reply plumbing pattern. Built on
[`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk).

## Run

```sh
npx @niq.run/hello-worker
# once installed: niq-hello
```

Bus connection comes from the supervisor-injected environment
(`NIQ_BUS_URL`, `NIQ_WORKER_ID`, `NIQ_WORKER_CREDENTIAL`); CLI flags override
env. See [`start.ts`](src/start.ts) for the full flag list.

## Config

| Purpose | Env | Flag | Default |
|---|---|---|---|
| Bus base URL | `NIQ_BUS_URL` | `--bus-url` | — |
| Bus worker id | `NIQ_WORKER_ID` | `--worker-id` | — |
| Bus credential | `NIQ_WORKER_CREDENTIAL` | `--credential` | — |
| Event type to answer | — | `--greet-event-type` | `hello.greet` |
| Name when payload has none | — | `--default-name` | `world` |

## Events

### Handles (subscribes / answers)

| Event | Payload | Reply |
|---|---|---|
| `hello.greet` | `{ name?: string }` | `request.completed` → `{ result: "hello, <name \| world>!" }` |

### Publishes

| Event | Payload | Destination |
|---|---|---|
| `worker.ready` | `{ type: "hello", watch }` | broadcast (presence) |
| `request.completed` | `{ result }` | request caller (reply) |

## Usage in code

```ts
import { HelloWorker } from "@niq.run/hello-worker";
```

## License

MIT