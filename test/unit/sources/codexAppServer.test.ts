import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ERROR_NOT_FOUND,
  ERROR_PROCESS_EXITED,
  ERROR_RESPONSE_TOO_LARGE,
  ERROR_RPC,
  ERROR_SPAWN_FAILED,
  ERROR_TIMEOUT,
  queryRateLimits,
  type SpawnFunction,
} from "../../../src/sources/codexAppServer";

const FAKE_SERVER = resolve(__dirname, "fakeAppServer.mjs");
const FIXTURE = resolve(__dirname, "fixtures/accountRateLimits.json");

let workspace: string;
let counter = 0;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jeqb-appserver-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface FakeRun {
  readonly spawnImpl: SpawnFunction;
  readonly calls: { command: string; args: readonly string[]; shell: unknown }[];
  readonly pidFile: string;
}

/** Starts the fake server in place of `codex app-server`, keeping the requested stdio. */
function fakeServer(mode: string, resultFile = FIXTURE): FakeRun {
  counter += 1;
  const pidFile = join(workspace, `pid-${counter}`);
  const calls: FakeRun["calls"] = [];
  const spawnImpl: SpawnFunction = (command, args, options) => {
    calls.push({ command, args, shell: options.shell });
    return spawn(process.execPath, [FAKE_SERVER, mode, resultFile, pidFile], {
      ...options,
      shell: false,
    });
  };
  return { spawnImpl, calls, pidFile };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pidFile: string): Promise<void> {
  const pid = Number(await readFile(pidFile, "utf8"));
  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
  expect(isAlive(pid)).toBe(false);
}

function query(run: FakeRun, signal: AbortSignal = new AbortController().signal) {
  return queryRateLimits({ command: "codex", signal, spawnImpl: run.spawnImpl });
}

describe("queryRateLimits", () => {
  it("starts `codex app-server` and returns the account/rateLimits/read result", async () => {
    const run = fakeServer("ok");

    const outcome = await query(run);

    expect(run.calls).toEqual([{ command: "codex", args: ["app-server"], shell: false }]);
    expect(outcome).toEqual({
      ok: true,
      result: JSON.parse(await readFile(FIXTURE, "utf8")),
    });
    await expectProcessGone(run.pidFile);
  });

  it("sends initialize, then initialized and the rate limits read without reset-credit details excluded", async () => {
    const received = join(workspace, "received.log");
    const script = join(workspace, "recorder.mjs");
    await writeFile(
      script,
      `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(received)}, line + "\\n");
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "account/rateLimits/read") send({ id: m.id, result: { ok: 1 } });
});`,
    );

    const outcome = await queryRateLimits({
      command: "codex",
      signal: new AbortController().signal,
      spawnImpl: (_command, _args, options) =>
        spawn(process.execPath, [script], { ...options, shell: false }),
    });

    expect(outcome).toEqual({ ok: true, result: { ok: 1 } });
    const lines = (await readFile(received, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "just-enough-quota-bar", title: null, version: "0.0.1" },
          capabilities: null,
        },
      },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: false } },
    ]);
  });

  it("reports rpc_error for an error answer to the rate limits read, and stops the process", async () => {
    const run = fakeServer("rpc-error");

    expect(await query(run)).toEqual({ ok: false, error: ERROR_RPC });
    await expectProcessGone(run.pidFile);
  });

  it("reports rpc_error for an error answer to initialize", async () => {
    const run = fakeServer("initialize-error");

    expect(await query(run)).toEqual({ ok: false, error: ERROR_RPC });
    await expectProcessGone(run.pidFile);
  });

  it("reports process_exited when the server ends before it answers", async () => {
    expect(await query(fakeServer("exit-at-start"))).toEqual({
      ok: false,
      error: ERROR_PROCESS_EXITED,
    });
  });

  it("times out on a slow server and leaves no process behind", async () => {
    const run = fakeServer("slow");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);

    const outcome = await query(run, controller.signal);

    expect(outcome).toEqual({ ok: false, error: ERROR_TIMEOUT });
    await expectProcessGone(run.pidFile);
  });

  it("kills a server that ignores the polite stop", async () => {
    const run = fakeServer("stubborn");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);

    const outcome = await query(run, controller.signal);

    expect(outcome).toEqual({ ok: false, error: ERROR_TIMEOUT });
    await expectProcessGone(run.pidFile);
  });

  it("does not start a process when the query is already aborted", async () => {
    const run = fakeServer("ok");
    const controller = new AbortController();
    controller.abort();

    const outcome = await query(run, controller.signal);

    expect(outcome).toEqual({ ok: false, error: ERROR_TIMEOUT });
    expect(run.calls).toEqual([]);
  });

  it("gives up on an answer line that is far too long", async () => {
    const run = fakeServer("huge");

    expect(await query(run)).toEqual({ ok: false, error: ERROR_RESPONSE_TOO_LARGE });
    await expectProcessGone(run.pidFile);
  });

  it("reports codex_not_found when the binary cannot be started", async () => {
    const outcome = await queryRateLimits({
      command: join(workspace, "no-such-codex"),
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ ok: false, error: ERROR_NOT_FOUND });
  });

  it("reports spawn_failed for another start error and for a throwing spawn", async () => {
    const failing = (code: string): SpawnFunction => () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: "pipe" });
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("denied"), { code }));
      });
      return child;
    };
    const throwing: SpawnFunction = () => {
      throw new Error("boom");
    };
    const signal = new AbortController().signal;

    expect(await queryRateLimits({ command: "codex", signal, spawnImpl: failing("EACCES") })).toEqual({
      ok: false,
      error: ERROR_SPAWN_FAILED,
    });
    expect(await queryRateLimits({ command: "codex", signal, spawnImpl: throwing })).toEqual({
      ok: false,
      error: ERROR_SPAWN_FAILED,
    });
  });

  it("starts a Windows .cmd through the shell and takes the process tree down with taskkill", async () => {
    const run = fakeServer("slow");
    const taskkills: (readonly string[])[] = [];
    let server: ChildProcess | undefined;
    const spawnImpl: SpawnFunction = (command, args, options) => {
      if (command === "taskkill") {
        taskkills.push(args);
        server?.kill("SIGKILL");
        return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      }
      server = run.spawnImpl(command, args, options);
      return server;
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);

    const outcome = await queryRateLimits({
      command: "C:\\npm\\codex.cmd",
      signal: controller.signal,
      spawnImpl,
      platform: "win32",
    });

    expect(outcome).toEqual({ ok: false, error: ERROR_TIMEOUT });
    expect(run.calls[0]?.shell).toBe(true);
    expect(taskkills).toEqual([["/pid", String(server?.pid), "/T", "/F"]]);
    await expectProcessGone(run.pidFile);
  });

  it("quotes a Windows .cmd path with spaces into one shell command line", async () => {
    const run = fakeServer("ok");
    const spawnImpl: SpawnFunction = (command, args, options) =>
      command === "taskkill"
        ? spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
        : run.spawnImpl(command, args, options);

    const outcome = await queryRateLimits({
      command: "C:\\Program Files\\Codex\\codex.cmd",
      signal: new AbortController().signal,
      spawnImpl,
      platform: "win32",
    });

    expect(outcome.ok).toBe(true);
    expect(run.calls).toEqual([
      { command: '"C:\\Program Files\\Codex\\codex.cmd" app-server', args: [], shell: true },
    ]);
    await expectProcessGone(run.pidFile);
  });

  it.skipIf(process.platform === "win32")(
    "starts a shell-run binary from a directory with a space in its name",
    async () => {
      const pidFile = join(workspace, "pid-spaced");
      const directory = join(workspace, "dir with space");
      const binary = join(directory, "codex.cmd");
      await mkdir(directory);
      await writeFile(
        binary,
        `#!/bin/sh\nexec ${[process.execPath, FAKE_SERVER, "ok", FIXTURE, pidFile]
          .map((part) => JSON.stringify(part))
          .join(" ")}\n`,
      );
      await chmod(binary, 0o755);
      const spawnImpl: SpawnFunction = (command, args, options) =>
        command === "taskkill"
          ? spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
          : spawn(command, args, options);

      const outcome = await queryRateLimits({
        command: binary,
        signal: new AbortController().signal,
        spawnImpl,
        platform: "win32",
      });

      expect(outcome).toEqual({ ok: true, result: JSON.parse(await readFile(FIXTURE, "utf8")) });
      await expectProcessGone(pidFile);
    },
  );

  it("kills the process directly when taskkill itself cannot start", async () => {
    const run = fakeServer("slow");
    let server: ChildProcess | undefined;
    const spawnImpl: SpawnFunction = (command, args, options) => {
      if (command === "taskkill") {
        const broken = spawn(join(workspace, "no-taskkill"), [], { stdio: "ignore" });
        broken.on("error", () => undefined);
        return broken;
      }
      server = run.spawnImpl(command, args, options);
      return server;
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);

    await queryRateLimits({
      command: "C:\\npm\\codex.exe",
      signal: controller.signal,
      spawnImpl,
      platform: "win32",
    });

    await expectProcessGone(run.pidFile);
  });
});
