import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import type { Fetcher } from "../cache/sharedCache";
import { PROVIDER_NAMES } from "../constants";
import type { QuotaSource } from "../statusbar/source";
import {
  createCredentialReader,
  type CredentialEnvironment,
} from "./claudeCredentials";
import { fetchUsage } from "./claudeUsage";

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/** Default interval of the Claude source. */
export const CLAUDE_INTERVAL_MS = 5 * MINUTE_MS;
/** Shortest time between two fetches, also for a click on the status bar. */
export const CLAUDE_MIN_INTERVAL_MS = MINUTE_MS;
export const CLAUDE_TIMEOUT_MS = 20 * SECOND_MS;
export const SECURITY_TIMEOUT_MS = 5 * SECOND_MS;
const SECURITY_MAX_BUFFER = 64 * 1024;

type ExecFile = typeof execFile;

/**
 * Runs the macOS `security` tool without a shell. A failure, including the
 * timeout whose error would carry the output, is reduced to `null`; neither
 * the error nor stderr is ever kept or logged.
 */
export function createSecurityRunner(
  exec: ExecFile = execFile,
): (args: readonly string[]) => Promise<string | null> {
  return (args) =>
    new Promise((resolve) => {
      try {
        exec(
          "security",
          [...args],
          { timeout: SECURITY_TIMEOUT_MS, maxBuffer: SECURITY_MAX_BUFFER, encoding: "utf8" },
          (error, stdout) => resolve(error === null ? stdout : null),
        );
      } catch {
        resolve(null);
      }
    });
}

function currentUserName(): string | null {
  const fromEnvironment = process.env.USER;
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return fromEnvironment;
  }
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function defaultCredentialEnvironment(): CredentialEnvironment {
  return {
    platform: process.platform,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    homeDir: os.homedir(),
    userName: currentUserName(),
    readFile: readTextOrNull,
    runSecurity: createSecurityRunner(),
    now: Date.now,
  };
}

export interface ClaudeSourceOptions {
  readonly environment?: CredentialEnvironment;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The Claude source: the Claude Code OAuth token is read (never written or
 * refreshed), and an expired one sends no request at all.
 */
export function createClaudeSource(options: ClaudeSourceOptions = {}): QuotaSource {
  const environment = options.environment ?? defaultCredentialEnvironment();
  const fetchImpl = options.fetchImpl ?? fetch;
  const readCredential = createCredentialReader(environment);
  const fetcher: Fetcher = async (signal) => {
    const credential = await readCredential();
    if (!credential.ok) {
      return { ok: false, error: credential.error };
    }
    return fetchUsage(
      { accessToken: credential.accessToken, fetchImpl, signal },
      PROVIDER_NAMES.claude,
      environment.now,
    );
  };
  return {
    provider: "claude",
    label: "OAuth usage",
    definition: { id: "claude", intervalMs: CLAUDE_INTERVAL_MS, timeoutMs: CLAUDE_TIMEOUT_MS },
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    fetch: fetcher,
  };
}
