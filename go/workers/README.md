# Go workers

Go implementations of niq Workers live here.

> **Status: skeleton.** There are no concrete workers yet, and no separate
> `go/sdk` package.

## Plan

- Each worker lives in its own subdirectory as an independent `main` package
  that can be run directly (`go run ./feishu`).
- Go workers **import the core repo module directly** — `github.com/54c1/niq` —
  so no separate SDK is needed:
  - Connect to the bus: `pkg/service/eventbus/transport/httptrans`'s
    `NewWorkerSide(baseURL, workerID, credential)` implements
    `WorkerSideChannel` (HTTP + SSE).
  - Event model: `core/event` (`event.New`, `event.Event`, protocol event types).
  - Identity registration is a control-plane operation (registryapi); the
    data plane only needs `worker_id` + `credential`.
- The `go.mod` is created when the first worker is added (module name such as
  `github.com/niq-run/workers/go`), with a `replace` directive pointing at the
  local core repo for local development.
