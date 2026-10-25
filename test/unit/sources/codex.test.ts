import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_INTERVAL_MS,
  createCodexAppServerSource,
} from "../../../src/sources/codex";
import type { SpawnFunction } from "../../../src/sources/codexAppServer";
import type { BinaryEnvironment } from "../../../src/sources/codexBinary";

const FAKE_SERVER = resolve(__dirname, "fakeAppServer.mjs");
const FIXTURE = resolve(__dirname, "fixtures/accountRateLimits.json");

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jeqb-codex-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function fake(mode: string, resultFile = FIXTURE): SpawnFunction {
  return (_command, _args, options) =>
    spawn(process.execPath, [FAKE_SERVER, mode, resultFile], { ...options, shell: false });
}

function binaries(...files: string[]): BinaryEnvironment {
  return {
    platform: "linux",
    pathVariable: "/bin",
    isExecutable: async (file) => files.includes(file),
  };
}

const signal = (): AbortSignal => new AbortController().signal;
/** Pinned, so a Windows host does not route the stop through the fake spawn as `taskkill`. */
const PLATFORM = "linux";

describe("createCodexAppServerSource", () => {
  it("is the Codex source with a default interval of 2 minutes", () => {
    const source = createCodexAppServerSource();

    expect(source.provider).toBe("codex");
    expect(source.label).toBe("app-server");
    expect(source.definition.id).toBe("codex");
    expect(source.definition.intervalMs).toBe(2 * 60_000);
    expect(CODEX_APP_SERVER_INTERVAL_MS).toBe(2 * 60_000);
    expect(source.minIntervalMs).toBeLessThan(source.definition.intervalMs);
    expect(source.definition.timeoutMs).toBeGreaterThan(source.minIntervalMs / 10);
  });

  it("fetches the snapshot through the app-server", async () => {
    const source = createCodexAppServerSource({
      binaryEnvironment: binaries("/bin/codex"),
      platform: PLATFORM,
      spawnImpl: fake("ok"),
    });

    const result = await source.fetch(signal());

    expect(result).toEqual({
      ok: true,
      snapshot: {
        name: "Codex",
        fiveHour: { usedPercent: 42, resetsAt: 1792954746 * 1000 },
        week: { usedPercent: 67, resetsAt: 1793541546 * 1000 },
        banked: { count: 2, nextExpiresAt: 1793293042 * 1000 },
      },
    });
  });

  it("starts the binary of jeqb.codex.binaryPath, read at every fetch", async () => {
    let configured: string | undefined = "/opt/one/codex";
    const started: string[] = [];
    const source = createCodexAppServerSource({
      readBinaryPath: () => configured,
      binaryEnvironment: binaries("/opt/one/codex", "/opt/two/codex"),
      platform: PLATFORM,
      spawnImpl: (command, args, options) => {
        started.push(command);
        return fake("ok")(command, args, options);
      },
    });

    await source.fetch(signal());
    configured = "/opt/two/codex";
    await source.fetch(signal());

    expect(started).toEqual(["/opt/one/codex", "/opt/two/codex"]);
  });

  it("reports codex_not_found without starting a process when there is no binary", async () => {
    let started = 0;
    const source = createCodexAppServerSource({
      binaryEnvironment: binaries(),
      platform: PLATFORM,
      spawnImpl: (...args) => {
        started += 1;
        return fake("ok")(...args);
      },
    });

    expect(await source.fetch(signal())).toEqual({ ok: false, error: "codex_not_found" });
    expect(started).toBe(0);
  });

  it("passes the failure of the app-server on", async () => {
    const source = createCodexAppServerSource({
      binaryEnvironment: binaries("/bin/codex"),
      platform: PLATFORM,
      spawnImpl: fake("rpc-error"),
    });

    expect(await source.fetch(signal())).toEqual({ ok: false, error: "rpc_error" });
  });

  it("reports an invalid response when the windows are missing", async () => {
    const { writeFile } = await import("node:fs/promises");
    const empty = join(workspace, "empty.json");
    await writeFile(empty, JSON.stringify({ rateLimits: { primary: null, secondary: null } }));
    const source = createCodexAppServerSource({
      binaryEnvironment: binaries("/bin/codex"),
      platform: PLATFORM,
      spawnImpl: fake("ok", empty),
    });

    expect(await source.fetch(signal())).toEqual({
      ok: false,
      error: "invalid_rate_limits_response",
    });
  });

  it("times out on a slow app-server when the fetch is aborted", async () => {
    const source = createCodexAppServerSource({
      binaryEnvironment: binaries("/bin/codex"),
      platform: PLATFORM,
      spawnImpl: fake("slow"),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    expect(await source.fetch(controller.signal)).toEqual({ ok: false, error: "timeout" });
  });
});
