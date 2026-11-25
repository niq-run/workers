import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event } from "@niq.run/worker-sdk";
import { runCli, type CliContext } from "./cli.js";

const temps: string[] = [];

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "niq-interface-"));
  temps.push(dir);
  return join(dir, "interface.json");
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  ctx: CliContext;
  stdout(): string;
  stderr(): string;
  json(): unknown;
}

function harness(opts: {
  env?: Record<string, string | undefined>;
  stdin?: string;
  fetchImpl?: typeof fetch;
} = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: opts.env ?? {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      readStdin: async () => opts.stdin ?? "",
    },
  };
  return {
    ctx,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    json: () => JSON.parse(out.join("\n")) as unknown,
  };
}

/** Minimal fake bus for command-level tests. */
function fakeBus(opts: {
  onPublish?: (body: { events: Event[] }, emit: (evt: Event) => void) => void;
} = {}) {
  const publishes: Array<{ type: string; targets?: string[]; events: Event[] }> =
    [];
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let done = false;

  const emit = (evt: Event): void => {
    if (done) return;
    controller?.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/events")) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
        if (done) return;
        done = true;
        controller?.error(new DOMException("aborted", "AbortError"));
      });
      return new Response(stream, { status: 200 });
    }
    if (url.includes("/publish")) {
      const body = JSON.parse(String(init?.body)) as {
        type: string;
        targets?: string[];
        events: Event[];
      };
      publishes.push(body);
      opts.onPublish?.(body, emit);
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }) as typeof fetch;

  return { fetchImpl, publishes };
}

function event(type: string, payload: Record<string, unknown>, extra: Partial<Event> = {}): Event {
  return {
    id: `e-${Math.random().toString(16).slice(2)}`,
    type,
    status: "routed",
    payload,
    worker_id: "peer",
    timestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

const DIAL_FLAGS = ["--bus-url", "http://bus:1", "--worker-id", "cli.test", "--credential", "tok"];

describe("discovery and usage", () => {
  it("prints help with no arguments", async () => {
    const h = harness();
    expect(await runCli([], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("niq-interface");
    expect(h.stdout()).toContain("send <event-type>");
  });

  it("prints the version", async () => {
    const h = harness();
    expect(await runCli(["--version"], h.ctx)).toBe(0);
    expect(h.stdout()).toMatch(
      /^@niq\.run\/interface-worker \d+\.\d+\.\d+/,
    );
  });

  it("prints per-command help", async () => {
    const h = harness();
    expect(await runCli(["help", "request"], h.ctx)).toBe(0);
    expect(h.stdout()).toContain("request <event-type> --target <id>");
  });

  it("rejects unknown commands and flags with exit 2", async () => {
    const unknownCommand = harness();
    expect(await runCli(["nope"], unknownCommand.ctx)).toBe(2);
    expect(unknownCommand.stderr()).toContain("unknown command");

    const unknownFlag = harness();
    expect(await runCli(["info", "--wat"], unknownFlag.ctx)).toBe(2);
    expect(unknownFlag.stderr()).toContain("unknown flag --wat");
  });
});

describe("send and say", () => {
  it("prints the event in --dry-run and does not dial", async () => {
    const h = harness({
      fetchImpl: (() => {
        throw new Error("must not dial");
      }) as unknown as typeof fetch,
    });
    expect(
      await runCli(
        [
          "send", "hello.greet", "-d", '{"name":"niq"}',
          "--target", "niq", "--dry-run", ...DIAL_FLAGS,
        ],
        h.ctx,
      ),
    ).toBe(0);

    const out = h.json() as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.source).toBe("flags");
    expect(out.targets).toEqual(["niq"]);
    expect((out.event as Event).type).toBe("hello.greet");
    expect((out.event as Event).payload).toEqual({ name: "niq" });
  });

  it("refuses a send without a target and points at the user", async () => {
    const h = harness();
    expect(
      await runCli(["send", "x.y", "-d", "{}", ...DIAL_FLAGS], h.ctx),
    ).toBe(2);
    expect(h.stderr()).toContain("broadcast is disabled");
    expect(h.stderr()).toContain('"niq"');
    expect(h.stderr()).toContain("--target");
  });

  it("publishes a directed send", async () => {
    const bus = fakeBus();
    const h = harness({ fetchImpl: bus.fetchImpl });
    expect(
      await runCli(
        ["send", "worker.input", "-d", '{"text":"hi"}', "--target", "reason.0", ...DIAL_FLAGS],
        h.ctx,
      ),
    ).toBe(0);

    expect(bus.publishes).toHaveLength(1);
    expect(bus.publishes[0].type).toBe("send");
    expect(bus.publishes[0].targets).toEqual(["reason.0"]);
    expect((h.json() as { ok: boolean }).ok).toBe(true);
  });

  it("builds the reason worker.input payload in say", async () => {
    const bus = fakeBus();
    const h = harness({ fetchImpl: bus.fetchImpl });
    expect(
      await runCli(
        ["say", "hello", "there", "--target", "reason.0", "--mode", "interrupt", ...DIAL_FLAGS],
        h.ctx,
      ),
    ).toBe(0);

    const published = bus.publishes[0].events[0];
    expect(published.type).toBe("worker.input");
    expect(published.payload).toEqual({
      text: "hello there",
      input_mode: "interrupt",
    });
  });

  it("reads the payload from stdin with -d -", async () => {
    const bus = fakeBus();
    const h = harness({
      fetchImpl: bus.fetchImpl,
      stdin: '{"n":1}',
    });
    expect(
      await runCli(
        ["send", "x.y", "-d", "-", "--target", "niq", ...DIAL_FLAGS],
        h.ctx,
      ),
    ).toBe(0);
    expect(bus.publishes[0].events[0].payload).toEqual({ n: 1 });
  });

  it("rejects a non-object payload and a bad duration with exit 2", async () => {
    const array = harness();
    expect(
      await runCli(["send", "x.y", "-d", "[1]", ...DIAL_FLAGS], array.ctx),
    ).toBe(2);
    expect(array.stderr()).toContain("must be a JSON object");

    const badTimeout = harness();
    expect(
      await runCli(
        ["request", "x.y", "--target", "t", "--timeout", "soon", ...DIAL_FLAGS],
        badTimeout.ctx,
      ),
    ).toBe(2);
    expect(badTimeout.stderr()).toContain("invalid duration");
  });
});

describe("request", () => {
  it("prints the correlated reply", async () => {
    const bus = fakeBus({
      onPublish: (body, emit) => {
        emit(
          event(
            "request.completed",
            { result: "pong" },
            { request_id: body.events[0].request_id, worker_id: "peer" },
          ),
        );
      },
    });
    const h = harness({ fetchImpl: bus.fetchImpl });
    expect(
      await runCli(["request", "ping.tool", "--target", "peer", ...DIAL_FLAGS], h.ctx),
    ).toBe(0);

    const out = h.json() as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.target).toBe("peer");
    expect(out.request_id).toBe(bus.publishes[0].events[0].request_id);
    expect((out.reply as Event).payload).toEqual({ result: "pong" });
  });

  it("exits 1 but still prints the failed reply as JSON", async () => {
    const bus = fakeBus({
      onPublish: (body, emit) => {
        emit(
          event(
            "request.failed",
            { error: "no such tool" },
            { request_id: body.events[0].request_id },
          ),
        );
      },
    });
    const h = harness({ fetchImpl: bus.fetchImpl });
    expect(
      await runCli(["request", "missing.tool", "--target", "peer", ...DIAL_FLAGS], h.ctx),
    ).toBe(1);

    const out = h.json() as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no such tool");
    expect(h.stderr()).toContain("no such tool");
  });

  it("requires exactly one target", async () => {
    const h = harness();
    expect(await runCli(["request", "x.y", ...DIAL_FLAGS], h.ctx)).toBe(2);
    expect(h.stderr()).toContain("exactly one --target");
  });
});

describe("config", () => {
  const block = [
    "NIQ_BUS_URL=http://192.168.1.20:7801",
    "NIQ_WORKER_ID=agent.laptop",
    "NIQ_WORKER_CREDENTIAL=secret",
    "# type=agent",
  ].join("\n");

  it("imports the WebUI block, lists it, and redacts secrets", async () => {
    const path = tempConfigPath();
    const imported = harness({ stdin: block });
    expect(
      await runCli(["config", "import", "home", "--config", path], imported.ctx),
    ).toBe(0);

    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      default_source: string;
      sources: Record<string, Record<string, string>>;
    };
    expect(saved.default_source).toBe("home");
    expect(saved.sources.home.worker_id).toBe("agent.laptop");

    const listed = harness();
    expect(await runCli(["config", "list", "--config", path], listed.ctx)).toBe(0);
    const list = listed.json() as { sources: Array<Record<string, unknown>> };
    expect(list.sources[0]).toMatchObject({
      name: "home",
      default: true,
      credential_configured: true,
    });
    expect(list.sources[0].credential).toBeUndefined();
    expect(listed.stdout()).not.toContain("secret");

    const shown = harness();
    expect(
      await runCli(
        ["config", "show", "home", "--show-credential", "--config", path],
        shown.ctx,
      ),
    ).toBe(0);
    expect((shown.json() as { source: { credential: string } }).source.credential).toBe(
      "secret",
    );
  });

  it("uses the imported source for info without exposing the secret", async () => {
    const path = tempConfigPath();
    const imported = harness({ stdin: block });
    await runCli(["config", "import", "home", "--config", path], imported.ctx);

    const info = harness();
    expect(await runCli(["info", "--config", path], info.ctx)).toBe(0);
    const out = info.json() as Record<string, unknown>;
    expect(out).toMatchObject({
      ok: true,
      source: "home",
      bus_url: "http://192.168.1.20:7801",
      worker_id: "agent.laptop",
      type: "agent",
      credential_configured: true,
    });
    expect(out.credential).toBeUndefined();
  });

  it("refuses to overwrite without --force, then overwrites with it", async () => {
    const path = tempConfigPath();
    const first = harness({ stdin: block });
    await runCli(["config", "import", "home", "--config", path], first.ctx);

    const again = harness({ stdin: block });
    expect(
      await runCli(["config", "import", "home", "--config", path], again.ctx),
    ).toBe(1);
    expect(again.stderr()).toContain("--force");

    const forced = harness({ stdin: block });
    expect(
      await runCli(
        ["config", "import", "home", "--force", "--config", path],
        forced.ctx,
      ),
    ).toBe(0);
  });

  it("adds a source from flags and sets/removes the default", async () => {
    const path = tempConfigPath();
    const added = harness();
    expect(
      await runCli(
        [
          "config", "add", "work",
          "--bus-url", "work.example:7801",
          "--worker-id", "agent.work",
          "--credential", "c",
          "--config", path,
        ],
        added.ctx,
      ),
    ).toBe(0);
    expect((added.json() as { source: { bus_url: string } }).source.bus_url).toBe(
      "http://work.example:7801",
    );

    const second = harness();
    await runCli(
      [
        "config", "add", "other",
        "--bus-url", "http://other:1",
        "--worker-id", "id.other",
        "--credential", "c2",
        "--config", path,
      ],
      second.ctx,
    );

    const setDefault = harness();
    expect(
      await runCli(["config", "default", "other", "--config", path], setDefault.ctx),
    ).toBe(0);

    const removed = harness();
    expect(
      await runCli(["config", "remove", "other", "--config", path], removed.ctx),
    ).toBe(0);
    expect((removed.json() as { default_source: string | null }).default_source).toBeNull();
  });

  it("requires the three connection flags for add", async () => {
    const h = harness();
    expect(
      await runCli(["config", "add", "x", "--config", tempConfigPath()], h.ctx),
    ).toBe(2);
    expect(h.stderr()).toContain("--bus-url");
  });

  it("says where the file is", async () => {
    const path = tempConfigPath();
    const h = harness();
    expect(await runCli(["config", "path", "--config", path], h.ctx)).toBe(0);
    expect(h.json()).toEqual({ path, exists: false });
  });
});

describe("config import (interface-worker JSON)", () => {
  const configJSON = JSON.stringify(
    {
      version: 1,
      default_source: "11",
      sources: {
        "11": {
          bus_url: "http://localhost:52217",
          worker_id: "11",
          credential: "niq1.abc",
          type: "test",
        },
      },
    },
    null,
    2,
  );

  function jsonFile(body = configJSON): string {
    const dir = mkdtempSync(join(tmpdir(), "niq-json-"));
    temps.push(dir);
    const file = join(dir, "niq-interface-11.json");
    writeFileSync(file, body);
    return file;
  }

  it("imports a full config without a name", async () => {
    const path = tempConfigPath();
    const h = harness();
    expect(
      await runCli(
        ["config", "import", "--from-file", jsonFile(), "--config", path],
        h.ctx,
      ),
    ).toBe(0);

    const out = h.json() as { imported: string[]; default_source: string };
    expect(out.imported).toEqual(["11"]);
    expect(out.default_source).toBe("11");

    const info = harness();
    expect(await runCli(["info", "--config", path], info.ctx)).toBe(0);
    expect(info.json()).toMatchObject({
      source: "11",
      bus_url: "http://localhost:52217",
      worker_id: "11",
      type: "test",
    });
  });

  it("merges without stealing an existing default", async () => {
    const path = tempConfigPath();
    const homeBlock = [
      "NIQ_BUS_URL=http://home:1",
      "NIQ_WORKER_ID=home.cli",
      "NIQ_WORKER_CREDENTIAL=home-cred",
    ].join("\n");
    const first = harness({ stdin: homeBlock });
    await runCli(["config", "import", "home", "--config", path], first.ctx);

    const merged = harness();
    expect(
      await runCli(
        ["config", "import", "--from-file", jsonFile(), "--config", path],
        merged.ctx,
      ),
    ).toBe(0);
    expect((merged.json() as { default_source: string }).default_source).toBe(
      "home",
    );

    const listed = harness();
    await runCli(["config", "list", "--config", path], listed.ctx);
    const names = (listed.json() as { sources: Array<{ name: string }> }).sources.map(
      (s) => s.name,
    );
    expect(names).toEqual(["11", "home"]);
  });

  it("requires --force to replace a source and rejects a name with a full config", async () => {
    const path = tempConfigPath();
    const file = jsonFile();
    const first = harness();
    expect(
      await runCli(["config", "import", "--from-file", file, "--config", path], first.ctx),
    ).toBe(0);

    const again = harness();
    expect(
      await runCli(["config", "import", "--from-file", file, "--config", path], again.ctx),
    ).toBe(1);
    expect(again.stderr()).toContain("--force");

    const forced = harness();
    expect(
      await runCli(
        ["config", "import", "--from-file", file, "--force", "--config", path],
        forced.ctx,
      ),
    ).toBe(0);

    const named = harness();
    expect(
      await runCli(
        ["config", "import", "11", "--from-file", file, "--force", "--config", path],
        named.ctx,
      ),
    ).toBe(2);
    expect(named.stderr()).toContain("carries its own source names");
  });
});

describe("skill", () => {
  it("reports where the bundled skill lives and prints it", async () => {
    const path = harness();
    expect(await runCli(["skill", "path"], path.ctx)).toBe(0);
    const info = path.json() as { dir: string; file: string; exists: boolean };
    expect(info.file.endsWith("skills/niq-interface/SKILL.md")).toBe(true);
    expect(info.exists).toBe(true);

    const printed = harness();
    expect(await runCli(["skill", "print"], printed.ctx)).toBe(0);
    expect(printed.stdout()).toContain("name: niq-interface");
  });

  it("installs into --dest and refuses to overwrite without --force", async () => {
    const dest = mkdtempSync(join(tmpdir(), "niq-skill-dest-"));
    temps.push(dest);

    const first = harness();
    expect(
      await runCli(["skill", "install", "--dest", dest], first.ctx),
    ).toBe(0);
    const installed = (first.json() as { installed: string }).installed;
    expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain(
      "name: niq-interface",
    );

    const again = harness();
    expect(
      await runCli(["skill", "install", "--dest", dest], again.ctx),
    ).toBe(1);
    expect(again.stderr()).toContain("--force");

    const forced = harness();
    expect(
      await runCli(["skill", "install", "--dest", dest, "--force"], forced.ctx),
    ).toBe(0);
  });
});

describe("environment dial", () => {
  it("dials from NIQ_BUS_* when no file/source is used", async () => {
    const h = harness({
      env: {
        NIQ_BUS_URL: "http://env:1",
        NIQ_WORKER_ID: "id.env",
        NIQ_WORKER_CREDENTIAL: "ce",
      },
    });
    expect(await runCli(["info"], h.ctx)).toBe(0);
    expect(h.json()).toMatchObject({
      source: "env",
      bus_url: "http://env:1",
      worker_id: "id.env",
    });
  });

  it("reports an incomplete environment instead of silently falling back", async () => {
    const h = harness({ env: { NIQ_BUS_URL: "http://env:1" } });
    expect(await runCli(["info"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("incomplete environment");
  });
});
