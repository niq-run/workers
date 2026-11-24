import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyConfig,
  loadConfig,
  normalizeBusURL,
  parseConnectBlock,
  parseImportText,
  removeSource,
  resolveDial,
  saveConfig,
  upsertSource,
  defaultSourceName,
  type ConfigFile,
} from "./config.js";

const temps: string[] = [];

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "niq-agent-"));
  temps.push(dir);
  return join(dir, "interface.json");
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WEBUI_BLOCK = [
  "NIQ_BUS_URL=http://192.168.1.20:7801",
  "NIQ_WORKER_ID=agent.laptop",
  "NIQ_WORKER_CREDENTIAL=eyJhbGciOi.payload.sig",
  "# type=agent",
].join("\n");

describe("parseConnectBlock", () => {
  it("imports the WebUI's copyable block, including the type comment", () => {
    const { source, warnings } = parseConnectBlock(WEBUI_BLOCK);
    expect(warnings).toEqual([]);
    expect(source).toEqual({
      bus_url: "http://192.168.1.20:7801",
      worker_id: "agent.laptop",
      credential: "eyJhbGciOi.payload.sig",
      type: "agent",
    });
  });

  it("tolerates quotes, export prefixes, snake_case keys and blank lines", () => {
    const { source } = parseConnectBlock(
      [
        "",
        'export NIQ_BUS_URL="http://localhost:9000/"',
        "worker_id = 'dev.cli'",
        "NIQ_WORKER_CREDENTIAL=tok",
        "# type: interface",
      ].join("\n"),
    );
    expect(source.bus_url).toBe("http://localhost:9000");
    expect(source.worker_id).toBe("dev.cli");
    expect(source.credential).toBe("tok");
    expect(source.type).toBe("interface");
  });

  it("warns about unknown keys instead of silently dropping them", () => {
    const { warnings } = parseConnectBlock(
      `${WEBUI_BLOCK}\nNIQ_WORKER_CREDENTAIL=typo`,
    );
    expect(warnings.join("\n")).toContain("NIQ_WORKER_CREDENTAIL");
  });

  it("names the missing variables", () => {
    expect(() => parseConnectBlock("NIQ_BUS_URL=http://x:1")).toThrow(
      /missing NIQ_WORKER_ID, NIQ_WORKER_CREDENTIAL/,
    );
  });
});

describe("parseImportText", () => {
  it("reads an env block as one source", () => {
    const parsed = parseImportText(WEBUI_BLOCK);
    expect(parsed.kind).toBe("source");
    if (parsed.kind === "source") {
      expect(parsed.source.worker_id).toBe("agent.laptop");
    }
  });

  it("reads a full agent-interface config", () => {
    const parsed = parseImportText(
      JSON.stringify({
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
      }),
    );
    expect(parsed.kind).toBe("config");
    if (parsed.kind === "config") {
      expect(parsed.config.default_source).toBe("11");
      expect(parsed.config.sources["11"].credential).toBe("niq1.abc");
      expect(parsed.config.sources["11"].type).toBe("test");
    }
  });

  it("reads a bare single-source JSON object", () => {
    const parsed = parseImportText(
      JSON.stringify({
        NIQ_BUS_URL: "http://localhost:52217",
        NIQ_WORKER_ID: "11",
        NIQ_WORKER_CREDENTIAL: "niq1.abc",
      }),
    );
    expect(parsed.kind).toBe("source");
    if (parsed.kind === "source") {
      expect(parsed.source.worker_id).toBe("11");
    }
  });

  it("rejects malformed JSON with a useful error", () => {
    expect(() => parseImportText("{ nope")).toThrow(/not valid JSON/);
    expect(() => parseImportText("{}\n")).toThrow(/missing bus_url/);
  });
});

describe("normalizeBusURL", () => {
  it("adds http:// when the scheme is omitted and strips trailing slashes", () => {
    expect(normalizeBusURL("192.168.1.20:7801/")).toBe(
      "http://192.168.1.20:7801",
    );
  });

  it("rejects non-http schemes", () => {
    expect(() => normalizeBusURL("ftp://example.com")).toThrow(/http\/https/);
  });
});

describe("config file", () => {
  it("round-trips sources and writes owner-only permissions", () => {
    const path = tempConfigPath();
    const config = emptyConfig();
    upsertSource(config, "home", {
      bus_url: "http://localhost:7801",
      worker_id: "dev.cli",
      credential: "secret",
      type: "agent",
    });
    saveConfig(path, config);

    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    const loaded = loadConfig(path, true);
    expect(loaded.exists).toBe(true);
    expect(loaded.config.default_source).toBe("home");
    expect(loaded.config.sources.home).toEqual({
      bus_url: "http://localhost:7801",
      worker_id: "dev.cli",
      credential: "secret",
      type: "agent",
    });
  });

  it("requires --force to overwrite and clears the default on removal", () => {
    const config: ConfigFile = emptyConfig();
    upsertSource(config, "a", {
      bus_url: "http://a:1",
      worker_id: "a",
      credential: "ca",
    });
    expect(() =>
      upsertSource(config, "a", {
        bus_url: "http://b:1",
        worker_id: "b",
        credential: "cb",
      }),
    ).toThrow(/already exists/);

    upsertSource(
      config,
      "a",
      { bus_url: "http://b:1", worker_id: "b", credential: "cb" },
      { force: true },
    );
    expect(config.sources.a.bus_url).toBe("http://b:1");
    expect(config.default_source).toBe("a");

    removeSource(config, "a");
    expect(config.sources).toEqual({});
    expect(config.default_source).toBeUndefined();
  });

  it("reports a source-name error and keeps other sources intact", () => {
    const path = tempConfigPath();
    const config = emptyConfig();
    upsertSource(config, "a", {
      bus_url: "http://a:1",
      worker_id: "a",
      credential: "ca",
    });
    saveConfig(path, config);
    const loaded = loadConfig(path, true);
    expect(() => removeSource(loaded.config, "nope")).toThrow(/does not exist/);
    expect(loaded.config.sources.a).toBeDefined();
  });
});

describe("resolveDial", () => {
  function writeTwoSources(): string {
    const path = tempConfigPath();
    const config = emptyConfig();
    upsertSource(config, "alpha", {
      bus_url: "http://alpha:1",
      worker_id: "id.alpha",
      credential: "ca",
      type: "agent",
    });
    upsertSource(config, "beta", {
      bus_url: "http://beta:2",
      worker_id: "id.beta",
      credential: "cb",
    });
    config.default_source = "alpha";
    saveConfig(path, config);
    return path;
  }

  it("uses an explicit --source over the environment and the default", () => {
    const path = writeTwoSources();
    const dial = resolveDial(
      { configPath: path, source: "beta" },
      {
        NIQ_BUS_URL: "http://env:3",
        NIQ_WORKER_ID: "id.env",
        NIQ_WORKER_CREDENTIAL: "ce",
      },
    );
    expect(dial.source).toBe("beta");
    expect(dial.busURL).toBe("http://beta:2");
    expect(dial.workerID).toBe("id.beta");
  });

  it("honours NIQ_INTERFACE_SOURCE", () => {
    const path = writeTwoSources();
    const dial = resolveDial(
      { configPath: path },
      { NIQ_INTERFACE_SOURCE: "beta" },
    );
    expect(dial.source).toBe("beta");
  });

  it("prefers a complete environment trio over the config default", () => {
    const path = writeTwoSources();
    const dial = resolveDial(
      { configPath: path },
      {
        NIQ_BUS_URL: "http://env:3",
        NIQ_WORKER_ID: "id.env",
        NIQ_WORKER_CREDENTIAL: "ce",
      },
    );
    expect(dial.source).toBe("env");
    expect(dial.busURL).toBe("http://env:3");
  });

  it("rejects an incomplete environment instead of silently falling back", () => {
    const path = writeTwoSources();
    expect(() =>
      resolveDial({ configPath: path }, { NIQ_BUS_URL: "http://env:3" }),
    ).toThrow(/incomplete environment/);
  });

  it("uses the default source, and the only source when there is no default", () => {
    const path = writeTwoSources();
    expect(resolveDial({ configPath: path }, {}).source).toBe("alpha");

    const single = tempConfigPath();
    const cfg = emptyConfig();
    upsertSource(cfg, "only", {
      bus_url: "http://only:9",
      worker_id: "only",
      credential: "c",
    });
    cfg.default_source = undefined;
    saveConfig(single, cfg);
    expect(resolveDial({ configPath: single }, {}).source).toBe("only");
  });

  it("asks for --source when several sources exist and none is default", () => {
    const path = writeTwoSources();
    const loaded = loadConfig(path, true);
    loaded.config.default_source = undefined;
    saveConfig(path, loaded.config);

    expect(() => resolveDial({ configPath: path }, {})).toThrow(
      /no default source.*--source/,
    );
  });

  it("lets flags supply the whole connection without a config file", () => {
    const dial = resolveDial(
      {
        configPath: join(tmpdir(), "does-not-exist", "interface.json"),
        busURL: "http://flag:7",
        workerID: "id.flag",
        credential: "cf",
      },
      {},
    );
    expect(dial.source).toBe("flags");
    expect(dial.busURL).toBe("http://flag:7");
  });

  it("overlays a flag on the chosen source", () => {
    const path = writeTwoSources();
    const dial = resolveDial({ configPath: path, source: "alpha", workerID: "other" }, {});
    expect(dial.busURL).toBe("http://alpha:1");
    expect(dial.workerID).toBe("other");
  });

  it("errors with guidance when nothing is configured", () => {
    const path = join(tmpdir(), "niq-empty", "interface.json");
    expect(() => resolveDial({ configPath: path }, {})).toThrow(
      /no bus connection configured/,
    );
  });
});

describe("defaultSourceName", () => {
  it("returns the default, or the only source, and errors otherwise", () => {
    const cfg = emptyConfig();
    upsertSource(cfg, "a", {
      bus_url: "http://a:1",
      worker_id: "a",
      credential: "c",
    });
    expect(defaultSourceName(cfg)).toBe("a");
    cfg.default_source = "a";
    upsertSource(cfg, "b", {
      bus_url: "http://b:1",
      worker_id: "b",
      credential: "c",
    });
    expect(defaultSourceName(cfg)).toBe("a");

    cfg.default_source = undefined;
    expect(() => defaultSourceName(cfg)).toThrow(/no default source/);
  });
});
