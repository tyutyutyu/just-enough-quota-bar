import type { Fetcher } from "../cache/sharedCache";
import { PROVIDER_NAMES } from "../constants";
import type { QuotaSource } from "../statusbar/source";
import { queryRateLimits, ERROR_NOT_FOUND, type SpawnFunction } from "./codexAppServer";
import { resolveCodexBinary, type BinaryEnvironment } from "./codexBinary";
import { parseRateLimits } from "./codexRateLimits";

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/** Default interval of the Codex app-server source. */
export const CODEX_APP_SERVER_INTERVAL_MS = 2 * MINUTE_MS;
/** Shortest time between two fetches, also for a click on the status bar. */
export const CODEX_APP_SERVER_MIN_INTERVAL_MS = 30 * SECOND_MS;
export const CODEX_APP_SERVER_TIMEOUT_MS = 20 * SECOND_MS;

export interface CodexAppServerSourceOptions {
  /** The current `jeqb.codex.binaryPath`; read at every fetch, so a change applies at once. */
  readonly readBinaryPath?: () => string | undefined;
  readonly binaryEnvironment?: BinaryEnvironment;
  readonly spawnImpl?: SpawnFunction;
  readonly platform?: NodeJS.Platform;
}

/**
 * The Codex source that asks the official `codex app-server`. The call does
 * not use quota, and the authentication stays with Codex: no token is read.
 */
export function createCodexAppServerSource(options: CodexAppServerSourceOptions = {}): QuotaSource {
  const fetcher: Fetcher = async (signal) => {
    const command = await resolveCodexBinary(options.readBinaryPath?.(), options.binaryEnvironment);
    if (command === null) {
      return { ok: false, error: ERROR_NOT_FOUND };
    }
    const outcome = await queryRateLimits({
      command,
      signal,
      spawnImpl: options.spawnImpl,
      platform: options.platform,
    });
    return outcome.ok
      ? parseRateLimits(outcome.result, PROVIDER_NAMES.codex)
      : { ok: false, error: outcome.error };
  };
  return {
    provider: "codex",
    label: "app-server",
    definition: {
      id: "codex",
      intervalMs: CODEX_APP_SERVER_INTERVAL_MS,
      timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS,
    },
    minIntervalMs: CODEX_APP_SERVER_MIN_INTERVAL_MS,
    fetch: fetcher,
  };
}
