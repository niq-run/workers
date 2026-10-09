# @niq.run/tavily-worker

A **web-search Worker** for [niq](https://github.com/niq-run/niq). It subscribes
to `tavily.search` requests, runs the query through the
[Tavily](https://tavily.com) API, and answers with a synthesized answer plus the
top matching sources. Built on
[`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk) and
[`@tavily/core`](https://www.npmjs.com/package/@tavily/core).

## Run

```sh
TAVILY_API_KEY=tvly-xxx npx @niq.run/tavily-worker
# once installed: niq-tavily
```

Bus connection comes from the supervisor-injected environment
(`NIQ_BUS_URL`, `NIQ_WORKER_ID`, `NIQ_WORKER_CREDENTIAL`); the Tavily API key
comes from `TAVILY_API_KEY`. CLI flags override env. See
[`start.ts`](src/start.ts) for the full flag list.

## Config

| Purpose | Env | Flag | Default |
|---|---|---|---|
| Bus base URL | `NIQ_BUS_URL` | `--bus-url` | — |
| Bus worker id | `NIQ_WORKER_ID` | `--worker-id` | — |
| Bus credential | `NIQ_WORKER_CREDENTIAL` | `--credential` | — |
| Tavily API key | `TAVILY_API_KEY` | `--api-key` | _(required)_ |
| Event type to answer | — | `--search-event-type` | `tavily.search` |
| Default max results | — | `--max-results` | `5` |

## Events

### Handles (subscribes / answers)

| Event | Payload | Reply |
|---|---|---|
| `tavily.search` | `{ query: string, ...options }` | `request.completed` → `{ result: "answer + top sources" }`; `request.failed` if `query` missing or Tavily errors |

Payload fields mapped to Tavily search options: `maxResults`, `days`,
`maxTokens`, `maxAgeHours`, `searchDepth`, `topic`, `timeRange`, `country`,
`language`, `includeAnswer`, `includeImages`, `includeRawContent`,
`includeDomains`, `excludeDomains`.

### Publishes

| Event | Payload | Destination |
|---|---|---|
| `worker.ready` | `{ type: "tavily", watch }` | broadcast (presence) |
| `request.completed` | `{ result }` | request caller (reply) |
| `request.failed` | `{ error }` | request caller (reply) |

## Usage in code

```ts
import { TavilyWorker, searchOptionsFrom } from "@niq.run/tavily-worker";
```

## License

MIT