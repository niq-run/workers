# @niq.run/tavily-worker

A **web-search Worker** for [niq](https://github.com/niq-run/niq). It subscribes
to `tavily.search` requests, runs the query through the
[Tavily](https://tavily.com) API, and answers with a synthesized answer plus the
top matching sources. Built on [`@niq.run/worker-sdk`](https://www.npmjs.com/package/@niq.run/worker-sdk).

It is an out-of-process extension worker: it connects to a niq bus over
HTTP + SSE and is meant to be launched by the niq project supervisor (or by you,
for a standalone bridge).

## Install

```sh
npm install -g @niq.run/tavily-worker
```

## Run

The package ships a `niq-tavily` bin (compiled app entry `dist/start.js`), so
you can start it directly — with `npx` (no install needed):

```sh
# npx — convenient for launching, e.g. from a niq project's worker config
npx @niq.run/tavily-worker

# same thing once installed globally
niq-tavily
```

The Tavily API key comes from `TAVILY_API_KEY`, and the bus connection from the
supervisor-injected environment (`NIQ_BUS_URL`, `NIQ_WORKER_ID`,
`NIQ_WORKER_CREDENTIAL`) — so a niq project can spawn it with just
`npx @niq.run/tavily-worker`. CLI flags override env.

## Configuration

| Purpose | Env | Flag |
|---|---|---|
| Tavily API key | `TAVILY_API_KEY` | `--api-key` |
| Event type to answer | — | `--search-event-type` (default `tavily.search`) |
| Default max results | — | `--max-results` (default `5`) |

Run `niq-tavily --help` for the full flag list.

## Usage

Send a `tavily.search` request to the worker's id (`tavily` by convention):

```jsonc
{
  "type": "tavily.search",
  "request_id": "call-1",
  "payload": {
    "query": "Who is Leo Messi?",
    "maxResults": 5,
    "topic": "general"
  }
}
```

The worker replies with `request.completed` carrying the answer + top sources,
or `request.failed` on a missing query or a Tavily error. Payload fields mapped
to Tavily search options: `maxResults`, `days`, `maxTokens`, `maxAgeHours`,
`searchDepth`, `topic`, `timeRange`, `country`, `language`, `includeAnswer`,
`includeImages`, `includeRawContent`, `includeDomains`, `excludeDomains`.

## Usage in code

```ts
import { TavilyWorker } from "@niq.run/tavily-worker";
```

## Related

- Tavily JS client: [`@tavily/core`](https://www.npmjs.com/package/@tavily/core)

## License

MIT