import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { needsShell } from "./codexBinary";

export const ERROR_SPAWN_FAILED = "spawn_failed";
export const ERROR_NOT_FOUND = "codex_not_found";
export const ERROR_PROCESS_EXITED = "process_exited";
export const ERROR_RPC = "rpc_error";
export const ERROR_RESPONSE_TOO_LARGE = "response_too_large";
export const ERROR_TIMEOUT = "timeout";

export const CLIENT_NAME = "just-enough-quota-bar";
export const CLIENT_VERSION = "0.0.1";

/** A line longer than this is not a JSON-RPC message the extension expects. */
export const MAX_LINE_LENGTH = 4 * 1024 * 1024;
/** After a polite stop the process gets this long before it is killed. */
export const KILL_GRACE_MS = 1_000;

const APP_SERVER_ARG = "app-server";
const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type AppServerOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

export interface AppServerRequest {
  /** Path of the `codex` binary. */
  readonly command: string;
  /** Aborting stops the process and ends the query with `timeout`. */
  readonly signal: AbortSignal;
  readonly spawnImpl?: SpawnFunction;
  readonly platform?: NodeJS.Platform;
}

function failure(error: string): AppServerOutcome {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const message: unknown = JSON.parse(line);
    return isRecord(message) ? message : null;
  } catch {
    return null;
  }
}

/**
 * Stops the process: its input is closed (a shim hands that on to the real
 * server), it is asked to end, and killed when it ignores that. A Windows
 * `.cmd` runs under a shell, so the whole process tree is taken down.
 */
function terminate(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawnImpl: SpawnFunction,
): void {
  child.stdin?.destroy();
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (platform === "win32" && child.pid !== undefined) {
    const taskkill = spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  killer.unref();
  child.once("exit", () => clearTimeout(killer));
}

/**
 * One short-lived `codex app-server`: `initialize`, the `initialized`
 * notification and `account/rateLimits/read` over stdio, then the process is
 * stopped. Every outcome is a result with a non-sensitive code; nothing is
 * thrown, and neither the output nor stderr is kept.
 */
export function queryRateLimits(request: AppServerRequest): Promise<AppServerOutcome> {
  const spawnImpl = request.spawnImpl ?? (spawn as SpawnFunction);
  const platform = request.platform ?? process.platform;
  const { signal } = request;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(failure(ERROR_TIMEOUT));
      return;
    }
    let child: ChildProcess;
    try {
      const shell = needsShell(request.command, platform);
      const options: SpawnOptions = { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell };
      // The shell gets one command line, so a path with spaces is quoted there.
      child = shell
        ? spawnImpl(`"${request.command}" ${APP_SERVER_ARG}`, [], options)
        : spawnImpl(request.command, [APP_SERVER_ARG], options);
    } catch {
      resolve(failure(ERROR_SPAWN_FAILED));
      return;
    }

    let settled = false;
    let buffer = "";
    const finish = (outcome: AppServerOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      terminate(child, platform, spawnImpl);
      resolve(outcome);
    };
    const onAbort = (): void => finish(failure(ERROR_TIMEOUT));
    const send = (message: Record<string, unknown>): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    const onMessage = (message: Record<string, unknown>): void => {
      if ("error" in message && (message.id === INITIALIZE_ID || message.id === RATE_LIMITS_ID)) {
        finish(failure(ERROR_RPC));
      } else if (message.id === INITIALIZE_ID && "result" in message) {
        send({ method: "initialized" });
        send({
          id: RATE_LIMITS_ID,
          method: "account/rateLimits/read",
          params: { excludeResetCreditDetails: false },
        });
      } else if (message.id === RATE_LIMITS_ID && "result" in message) {
        finish({ ok: true, result: message.result });
      }
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !settled) {
        const message = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message !== null) {
          onMessage(message);
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_LENGTH) {
        finish(failure(ERROR_RESPONSE_TOO_LARGE));
      }
    };

    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(failure(error.code === "ENOENT" ? ERROR_NOT_FOUND : ERROR_SPAWN_FAILED)),
    );
    child.once("close", () => finish(failure(ERROR_PROCESS_EXITED)));
    // A server that exits early breaks the pipe; the exit above reports it.
    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    signal.addEventListener("abort", onAbort, { once: true });
    send({
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        clientInfo: { name: CLIENT_NAME, title: null, version: CLIENT_VERSION },
        capabilities: null,
      },
    });
  });
}
