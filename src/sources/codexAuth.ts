import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const ERROR_AUTH_MISSING = "auth_missing";
export const ERROR_AUTH_INVALID = "auth_invalid";

const AUTH_FILE = "auth.json";
const DEFAULT_CODEX_DIRECTORY = ".codex";

export interface CodexAuthEnvironment {
  /** The `CODEX_HOME` variable; `undefined` or empty when unset. */
  readonly codexHome: string | undefined;
  readonly homeDir: string;
  /** Reads a text file; rejects with the Node error (`ENOENT` for a missing file). */
  readonly readFile: (filePath: string) => Promise<string>;
}

export type CodexAuthResult =
  | { readonly ok: true; readonly accessToken: string; readonly accountId: string }
  | {
      readonly ok: false;
      /** Non-sensitive code: `auth_missing` or `auth_invalid`. */
      readonly error: string;
    };

export function defaultCodexAuthEnvironment(): CodexAuthEnvironment {
  return {
    codexHome: process.env.CODEX_HOME,
    homeDir: os.homedir(),
    readFile: (filePath) => readFile(filePath, "utf8"),
  };
}

/** `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is not set. */
export function codexAuthPath(environment: CodexAuthEnvironment): string {
  const home = environment.codexHome?.trim() ?? "";
  return home === ""
    ? path.join(environment.homeDir, DEFAULT_CODEX_DIRECTORY, AUTH_FILE)
    : path.join(home, AUTH_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * Reads `tokens.access_token` and `tokens.account_id` of the Codex `auth.json`.
 * The file is only read, never written. A missing file or field is
 * `auth_missing`; unreadable or malformed content is `auth_invalid`. Neither
 * the content nor the error text is kept.
 */
export async function readCodexAuth(
  environment: CodexAuthEnvironment = defaultCodexAuthEnvironment(),
): Promise<CodexAuthResult> {
  let text: string;
  try {
    text = await environment.readFile(codexAuthPath(environment));
  } catch (error) {
    return { ok: false, error: isMissingFile(error) ? ERROR_AUTH_MISSING : ERROR_AUTH_INVALID };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: ERROR_AUTH_INVALID };
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) {
    return { ok: false, error: ERROR_AUTH_INVALID };
  }
  const accessToken = nonBlankText(parsed.tokens.access_token);
  const accountId = nonBlankText(parsed.tokens.account_id);
  return accessToken === null || accountId === null
    ? { ok: false, error: ERROR_AUTH_MISSING }
    : { ok: true, accessToken, accountId };
}
