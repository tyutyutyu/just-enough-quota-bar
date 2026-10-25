import { describe, expect, it } from "vitest";
import type { FetchResult } from "../../../src/cache/sharedCache";
import { createCodexSource, toCodexSourceMode } from "../../../src/sources/codexSelect";
import type { BinaryEnvironment } from "../../../src/sources/codexBinary";
import type { CodexAuthEnvironment } from "../../../src/sources/codexAuth";
import type { SpawnFunction } from "../../../src/sources/codexAppServer";

const MINUTE_MS = 60_000;

function binaries(...files: string[]): BinaryEnvironment {
  return { platform: "linux", pathVariable: "/bin", isExecutable: async (file) => files.includes(file) };
}

const NO_AUTH: CodexAuthEnvironment = {
  codexHome: undefined,
  homeDir: "/home/tester",
  readFile: async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
};

const signal = (): AbortSignal => new AbortController().signal;

interface Harness {
  readonly source: ReturnType<typeof createCodexSource>;
  readonly spawned: string[];
  setMode(mode: unknown): void;
}

function harness(mode: unknown, binary: string[]): Harness {
  let current = mode;
  const spawned: string[] = [];
  // A spawn that fails at once: the test only needs to know that it was asked for.
  const spawnImpl: SpawnFunction = (command) => {
    spawned.push(command);
    throw new Error("spawn refused");
  };
  const source = createCodexSource({
    readSourceMode: () => current,
    appServer: { binaryEnvironment: binaries(...binary), spawnImpl, platform: "linux" },
    probe: { authEnvironment: NO_AUTH, readIntervalMinutes: () => 10 },
  });
  return { source, spawned, setMode: (next) => void (current = next) };
}

async function error(result: Promise<FetchResult>): Promise<string | null> {
  const outcome = await result;
  return outcome.ok ? null : outcome.error;
}

describe("toCodexSourceMode", () => {
  it.each(["auto", "appServer", "probe"])("accepts %s", (mode) => {
    expect(toCodexSourceMode(mode)).toBe(mode);
  });

  it.each([[undefined], [null], ["AppServer"], [3], [""]])("falls back to auto for %j", (value) => {
    expect(toCodexSourceMode(value)).toBe("auto");
  });
});

describe("createCodexSource", () => {
  it("runs the app-server in auto mode when the binary exists", async () => {
    const { source, spawned } = harness("auto", ["/bin/codex"]);

    await source.fetch(signal());

    expect(spawned).toEqual(["/bin/codex"]);
    expect(source.label).toBe("app-server");
    expect(source.definition.intervalMs).toBe(2 * MINUTE_MS);
  });

  it("runs the probe in auto mode when there is no binary", async () => {
    const { source, spawned } = harness("auto", []);

    expect(await error(source.fetch(signal()))).toBe("auth_missing");

    expect(spawned).toEqual([]);
    expect(source.label).toBe("probe");
    expect(source.definition.intervalMs).toBe(10 * MINUTE_MS);
    expect(source.minIntervalMs).toBe(10 * MINUTE_MS);
  });

  it("waits the probe's interval until auto has chosen a source", () => {
    const { source } = harness("auto", ["/bin/codex"]);

    expect(source.definition.intervalMs).toBe(10 * MINUTE_MS);
  });

  it("does not fall back to the probe when the app-server fails", async () => {
    const { source } = harness("auto", ["/bin/codex"]);

    expect(await error(source.fetch(signal()))).toBe("spawn_failed");
  });

  it("always runs the probe for probe, even with a binary", async () => {
    const { source, spawned } = harness("probe", ["/bin/codex"]);

    expect(await error(source.fetch(signal()))).toBe("auth_missing");

    expect(spawned).toEqual([]);
    expect(source.label).toBe("probe");
  });

  it("never runs the probe for appServer, and reports a missing binary", async () => {
    const { source } = harness("appServer", []);

    expect(await error(source.fetch(signal()))).toBe("codex_not_found");
    expect(source.label).toBe("app-server");
    expect(source.definition.intervalMs).toBe(2 * MINUTE_MS);
  });

  it("follows a changed setting at the next fetch", async () => {
    const { source, setMode } = harness("probe", ["/bin/codex"]);
    await source.fetch(signal());

    setMode("appServer");

    expect(await error(source.fetch(signal()))).toBe("spawn_failed");
    expect(source.label).toBe("app-server");
  });

  it("treats an unknown setting value as auto", async () => {
    const { source } = harness("nonsense", []);

    expect(await error(source.fetch(signal()))).toBe("auth_missing");
  });

  it("gives auto the longer of the two timeouts", () => {
    const { source } = harness("auto", ["/bin/codex"]);

    expect(source.definition.timeoutMs).toBeGreaterThanOrEqual(45_000);
  });
});
