import { createHash } from "node:crypto";
import * as path from "node:path";

export const ERROR_AUTH_MISSING = "auth_missing";
export const ERROR_AUTH_BLANK = "auth_blank";
export const ERROR_AUTH_INVALID = "auth_invalid";
export const ERROR_AUTH_EXPIRED = "auth_expired";

const CREDENTIALS_FILE_NAME = ".credentials.json";
const DEFAULT_CONFIG_DIR_NAME = ".claude";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SERVICE_SUFFIX_LENGTH = 8;

/** The Keychain is asked at most this often; one refresh cycle must not start several processes. */
export const KEYCHAIN_MEMO_MS = 5_000;

/** The outside world of the credential reader, injected so that it is testable without it. */
export interface CredentialEnvironment {
  readonly platform: NodeJS.Platform;
  /** `$CLAUDE_CONFIG_DIR`. */
  readonly configDir: string | undefined;
  readonly homeDir: string;
  /** The account name passed to the Keychain; `null` when it cannot be determined. */
  readonly userName: string | null;
  /** The text of a file, or `null` when it does not exist or cannot be read. */
  readFile(filePath: string): Promise<string | null>;
  /**
   * Runs `security` with `args`, without a shell, and returns its stdout, or
   * `null` on any failure. It must never log or expose the failure: a timeout
   * error carries the output, which is the credential.
   */
  runSecurity(args: readonly string[]): Promise<string | null>;
  now(): number;
}

export type CredentialResult =
  | { readonly ok: true; readonly accessToken: string }
  | {
      readonly ok: false;
      /** Non-sensitive code: `auth_missing`, `auth_blank`, `auth_invalid` or `auth_expired`. */
      readonly error: string;
    };

type Candidate =
  | { readonly kind: "token"; readonly accessToken: string; readonly expired: boolean }
  | { readonly kind: "error"; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefaultConfigDir(configDir: string | undefined, homeDir: string): boolean {
  return (
    configDir === undefined ||
    configDir === "" ||
    path.resolve(configDir) === path.resolve(homeDir, DEFAULT_CONFIG_DIR_NAME)
  );
}

/**
 * The Keychain service name of the Claude Code installation that uses `configDir`.
 * It is derived, never searched for: a search could match a foreign item.
 */
export function keychainServiceName(configDir: string | undefined, homeDir: string): string {
  if (configDir === undefined || isDefaultConfigDir(configDir, homeDir)) {
    return KEYCHAIN_SERVICE;
  }
  const digest = createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `${KEYCHAIN_SERVICE}-${digest.slice(0, SERVICE_SUFFIX_LENGTH)}`;
}

export function credentialsFilePath(configDir: string | undefined, homeDir: string): string {
  const directory =
    configDir === undefined || configDir === ""
      ? path.join(homeDir, DEFAULT_CONFIG_DIR_NAME)
      : configDir;
  return path.join(directory, CREDENTIALS_FILE_NAME);
}

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** A value that does not start with `{` but is hex of a JSON text is decoded; anything else stays. */
function decodeHexJson(value: string): string {
  if (value.startsWith("{") || value.length % 2 !== 0 || !HEX_PATTERN.test(value)) {
    return value;
  }
  const decoded = Buffer.from(value, "hex").toString("utf8");
  try {
    JSON.parse(decoded);
    return decoded;
  } catch {
    return value;
  }
}

/** Seconds are told from milliseconds by magnitude, as the sample does. */
const MILLISECONDS_THRESHOLD = 1e11;

function expiryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > MILLISECONDS_THRESHOLD ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseCandidate(text: string | null, nowMs: number): Candidate {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") {
    return { kind: "error", error: ERROR_AUTH_MISSING };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeHexJson(trimmed));
  } catch {
    return { kind: "error", error: ERROR_AUTH_INVALID };
  }
  const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
  if (!isRecord(oauth)) {
    return { kind: "error", error: ERROR_AUTH_INVALID };
  }
  if (typeof oauth.accessToken !== "string") {
    return { kind: "error", error: ERROR_AUTH_MISSING };
  }
  const accessToken = oauth.accessToken.trim();
  if (accessToken === "") {
    return { kind: "error", error: ERROR_AUTH_BLANK };
  }
  const expiresAt = expiryMs(oauth.expiresAt);
  return { kind: "token", accessToken, expired: expiresAt !== null && expiresAt <= nowMs };
}

/**
 * A usable token beats an expired one; among the usable ones the first (the
 * Keychain, which holds the live token of a native install) wins. Without any
 * token, a malformed credential is reported rather than a missing one.
 */
function choose(candidates: readonly Candidate[]): CredentialResult {
  const tokens = candidates.filter((candidate) => candidate.kind === "token");
  const live = tokens.find((candidate) => !candidate.expired);
  if (live !== undefined) {
    return { ok: true, accessToken: live.accessToken };
  }
  if (tokens.length > 0) {
    return { ok: false, error: ERROR_AUTH_EXPIRED };
  }
  const errors = candidates.flatMap((candidate) =>
    candidate.kind === "error" ? [candidate.error] : [],
  );
  return {
    ok: false,
    error: errors.find((error) => error !== ERROR_AUTH_MISSING) ?? ERROR_AUTH_MISSING,
  };
}

/**
 * Creates the credential reader. It only reads: the credential is never
 * written, refreshed, cached on disk or logged.
 */
export function createCredentialReader(
  environment: CredentialEnvironment,
): () => Promise<CredentialResult> {
  let memo: { readonly at: number; readonly value: Promise<string | null> } | null = null;

  const readKeychain = (): Promise<string | null> => {
    if (environment.userName === null) {
      return Promise.resolve(null);
    }
    const nowMs = environment.now();
    if (memo !== null && nowMs - memo.at < KEYCHAIN_MEMO_MS) {
      return memo.value;
    }
    const value = environment.runSecurity([
      "find-generic-password",
      "-a",
      environment.userName,
      "-s",
      keychainServiceName(environment.configDir, environment.homeDir),
      "-w",
    ]);
    memo = { at: nowMs, value };
    return value;
  };

  return async () => {
    const fileRead = environment.readFile(
      credentialsFilePath(environment.configDir, environment.homeDir),
    );
    const keychainRead = environment.platform === "darwin" ? readKeychain() : null;
    const [fileText, keychainText] = await Promise.all([fileRead, keychainRead]);
    // The expiry is judged only after both reads have finished: a token that
    // expires while the Keychain is being asked must not be sent.
    const nowMs = environment.now();
    const candidates = [
      ...(keychainRead === null ? [] : [parseCandidate(keychainText, nowMs)]),
      parseCandidate(fileText, nowMs),
    ];
    return choose(candidates);
  };
}
