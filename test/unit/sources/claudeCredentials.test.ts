import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYCHAIN_MEMO_MS,
  createCredentialReader,
  credentialsFilePath,
  keychainServiceName,
  type CredentialEnvironment,
} from "../../../src/sources/claudeCredentials";

const NOW = 1_800_000_000_000;
const HOME = "/Users/tester";
const USER = "tester";
const FUTURE = NOW + 3_600_000;
const PAST = NOW - 1;

function credential(accessToken: unknown, expiresAt: unknown = FUTURE): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshToken: "never-read" } });
}

interface Fake {
  readonly environment: CredentialEnvironment;
  readonly securityCalls: (readonly string[])[];
  readonly filesRead: string[];
  readonly clock: { now: number };
}

function fake(options: {
  platform?: NodeJS.Platform;
  configDir?: string;
  userName?: string | null;
  files?: Record<string, string>;
  keychain?: string | null;
  /** How far the clock moves while the file is being read. */
  fileReadMs?: number;
  /** How far the clock moves while the Keychain is being asked. */
  keychainReadMs?: number;
}): Fake {
  const securityCalls: (readonly string[])[] = [];
  const filesRead: string[] = [];
  const clock = { now: NOW };
  const environment: CredentialEnvironment = {
    platform: options.platform ?? "darwin",
    configDir: options.configDir,
    homeDir: HOME,
    userName: options.userName === undefined ? USER : options.userName,
    readFile: async (filePath) => {
      filesRead.push(filePath);
      await Promise.resolve();
      clock.now += options.fileReadMs ?? 0;
      return options.files?.[filePath] ?? null;
    },
    runSecurity: async (args) => {
      securityCalls.push(args);
      await Promise.resolve();
      clock.now += options.keychainReadMs ?? 0;
      return options.keychain ?? null;
    },
    now: () => clock.now,
  };
  return { environment, securityCalls, filesRead, clock };
}

// Built with the platform's path rules, as the reader builds them, so the Windows CI matches too.
const DEFAULT_FILE = path.join(HOME, ".claude", ".credentials.json");
const CUSTOM_DIR = "/custom/dir";
const CUSTOM_FILE = path.join(CUSTOM_DIR, ".credentials.json");

describe("keychainServiceName", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["the default directory", `${HOME}/.claude`],
    ["the default directory with a trailing slash", `${HOME}/.claude/`],
  ])("uses the plain name when CLAUDE_CONFIG_DIR is %s", (_label, configDir) => {
    expect(keychainServiceName(configDir, HOME)).toBe("Claude Code-credentials");
  });

  // Reference values from `printf %s <dir> | openssl dgst -sha256`.
  it.each([
    ["/tmp/claude-test", "Claude Code-credentials-9adeedd0"],
    ["/home/user/.claude-alt", "Claude Code-credentials-6695ba7a"],
  ])("adds the first 8 hex of the SHA-256 for %s", (configDir, expected) => {
    expect(keychainServiceName(configDir, HOME)).toBe(expected);
  });

  it("hashes the NFC form, so a decomposed path gets the composed path's suffix", () => {
    const composed = "/Users/josé/.claude-work";
    const decomposed = "/Users/josé/.claude-work";

    expect(keychainServiceName(decomposed, HOME)).toBe("Claude Code-credentials-79ffd7dd");
    expect(keychainServiceName(composed, HOME)).toBe("Claude Code-credentials-79ffd7dd");
  });
});

describe("credentialsFilePath", () => {
  it("uses CLAUDE_CONFIG_DIR when set, otherwise ~/.claude", () => {
    expect(credentialsFilePath(CUSTOM_DIR, HOME)).toBe(CUSTOM_FILE);
    expect(credentialsFilePath(undefined, HOME)).toBe(DEFAULT_FILE);
    expect(credentialsFilePath("", HOME)).toBe(DEFAULT_FILE);
  });
});

describe("the credential file (Linux and Windows)", () => {
  it("reads the token from ~/.claude/.credentials.json and never asks the Keychain", async () => {
    const { environment, securityCalls } = fake({
      platform: "linux",
      files: { [DEFAULT_FILE]: credential("  file-token  ") },
    });

    const result = await createCredentialReader(environment)();

    expect(result).toEqual({ ok: true, accessToken: "file-token" });
    expect(securityCalls).toEqual([]);
  });

  it("reads $CLAUDE_CONFIG_DIR/.credentials.json when it is set", async () => {
    const { environment, filesRead } = fake({
      platform: "win32",
      configDir: CUSTOM_DIR,
      files: { [CUSTOM_FILE]: credential("custom-token") },
    });

    const result = await createCredentialReader(environment)();

    expect(result).toEqual({ ok: true, accessToken: "custom-token" });
    expect(filesRead).toEqual([CUSTOM_FILE]);
  });

  it("reports auth_missing when there is no file", async () => {
    const { environment } = fake({ platform: "linux" });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_missing" });
  });

  it.each([
    ["not JSON", "not json", "auth_invalid"],
    ["JSON without the oauth block", "{}", "auth_invalid"],
    ["an oauth block that is not an object", '{"claudeAiOauth": 5}', "auth_invalid"],
    ["a JSON array", "[]", "auth_invalid"],
    ["no accessToken", '{"claudeAiOauth": {}}', "auth_missing"],
    ["a non-string accessToken", credential(42), "auth_missing"],
    ["an empty accessToken", credential(""), "auth_blank"],
    ["a whitespace accessToken", credential("   "), "auth_blank"],
    ["an empty file", "  \n", "auth_missing"],
  ])("reports a non-sensitive code for %s", async (_label, text, error) => {
    const { environment } = fake({ platform: "linux", files: { [DEFAULT_FILE]: text } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error });
  });

  it("reports auth_expired when expiresAt has passed, also exactly at now", async () => {
    for (const expiresAt of [PAST, NOW]) {
      const { environment } = fake({
        platform: "linux",
        files: { [DEFAULT_FILE]: credential("file-token", expiresAt) },
      });

      expect(await createCredentialReader(environment)()).toEqual({
        ok: false,
        error: "auth_expired",
      });
    }
  });

  it.each([
    ["is missing", undefined],
    ["is unreadable", "soon"],
    ["is a nonpositive number", 0],
  ])("treats the token as usable when expiresAt %s", async (_label, expiresAt) => {
    const { environment } = fake({
      platform: "linux",
      files: { [DEFAULT_FILE]: credential("file-token", expiresAt) },
    });

    expect(await createCredentialReader(environment)()).toEqual({
      ok: true,
      accessToken: "file-token",
    });
  });

  it("understands an expiry given in seconds or as an ISO text", async () => {
    const seconds = fake({
      platform: "linux",
      files: { [DEFAULT_FILE]: credential("t", Math.floor(PAST / 1000)) },
    });
    const iso = fake({
      platform: "linux",
      files: { [DEFAULT_FILE]: credential("t", new Date(PAST).toISOString()) },
    });

    expect(await createCredentialReader(seconds.environment)()).toEqual({ ok: false, error: "auth_expired" });
    expect(await createCredentialReader(iso.environment)()).toEqual({ ok: false, error: "auth_expired" });
  });
});

describe("the macOS Keychain", () => {
  it("calls security without a shell, with the derived service name and the account", async () => {
    const { environment, securityCalls } = fake({ keychain: credential("keychain-token") });

    const result = await createCredentialReader(environment)();

    expect(result).toEqual({ ok: true, accessToken: "keychain-token" });
    expect(securityCalls).toEqual([
      ["find-generic-password", "-a", USER, "-s", "Claude Code-credentials", "-w"],
    ]);
  });

  it("uses the suffixed service name for a non-default CLAUDE_CONFIG_DIR, without a fallback", async () => {
    const { environment, securityCalls } = fake({
      configDir: "/tmp/claude-test",
      keychain: null,
    });

    const result = await createCredentialReader(environment)();

    expect(result).toEqual({ ok: false, error: "auth_missing" });
    expect(securityCalls).toHaveLength(1);
    expect(securityCalls[0]?.[4]).toBe("Claude Code-credentials-9adeedd0");
  });

  it("decodes a hex-encoded value, with the trailing newline of the tool", async () => {
    const hex = Buffer.from(credential("hex-token"), "utf8").toString("hex");
    const { environment } = fake({ keychain: `${hex}\n` });

    expect(await createCredentialReader(environment)()).toEqual({ ok: true, accessToken: "hex-token" });
  });

  it.each([
    ["an odd-length value", "abc"],
    ["a hex value that is not JSON", "6162"],
    ["a value that is not hex", "zz"],
  ])("does not decode %s", async (_label, value) => {
    const { environment } = fake({ keychain: value });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_invalid" });
  });

  it("does not look for the Keychain without an account name", async () => {
    const { environment, securityCalls } = fake({
      userName: null,
      keychain: credential("keychain-token"),
      files: { [DEFAULT_FILE]: credential("file-token") },
    });

    const result = await createCredentialReader(environment)();

    expect(result).toEqual({ ok: true, accessToken: "file-token" });
    expect(securityCalls).toEqual([]);
  });

  it("reports auth_missing when neither the Keychain nor the file has a credential", async () => {
    const { environment } = fake({});

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_missing" });
  });

  it("reports auth_blank for a blank Keychain token", async () => {
    const { environment } = fake({ keychain: credential("") });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_blank" });
  });

  it("memoizes the Keychain read for a few seconds, then asks again", async () => {
    const { environment, securityCalls, clock } = fake({ keychain: credential("keychain-token") });
    const read = createCredentialReader(environment);

    await read();
    clock.now += KEYCHAIN_MEMO_MS - 1;
    await read();
    expect(securityCalls).toHaveLength(1);

    clock.now += 1;
    await read();
    expect(securityCalls).toHaveLength(2);
  });
});

describe("the precedence of the Keychain and the file on macOS", () => {
  const keychainFresh = credential("keychain-token", FUTURE);
  const fileFresh = credential("file-token", FUTURE);
  const keychainExpired = credential("keychain-token", PAST);
  const fileExpired = credential("file-token", PAST);

  it("prefers a live Keychain token to a live file token", async () => {
    const { environment } = fake({ keychain: keychainFresh, files: { [DEFAULT_FILE]: fileFresh } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: true, accessToken: "keychain-token" });
  });

  it("does not let a frozen file token hide a live Keychain token", async () => {
    const { environment } = fake({ keychain: keychainFresh, files: { [DEFAULT_FILE]: fileExpired } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: true, accessToken: "keychain-token" });
  });

  it("falls back to a live file token when the Keychain token expired", async () => {
    const { environment } = fake({ keychain: keychainExpired, files: { [DEFAULT_FILE]: fileFresh } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: true, accessToken: "file-token" });
  });

  it("falls back to the file when the Keychain has nothing", async () => {
    const { environment } = fake({ files: { [DEFAULT_FILE]: fileFresh } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: true, accessToken: "file-token" });
  });

  it("reports auth_expired and sends no token when both tokens expired", async () => {
    const { environment } = fake({ keychain: keychainExpired, files: { [DEFAULT_FILE]: fileExpired } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_expired" });
  });

  it("reports auth_expired when the only token is an expired file token", async () => {
    const { environment } = fake({ files: { [DEFAULT_FILE]: fileExpired } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_expired" });
  });

  it("judges the expiry after the reads, so a token expiring during a slow read is not sent", async () => {
    const { environment } = fake({
      platform: "linux",
      files: { [DEFAULT_FILE]: credential("file-token", NOW + 1000) },
      fileReadMs: 1000,
    });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_expired" });
  });

  it("falls back to the live file token when the Keychain token expires while it is asked", async () => {
    const { environment } = fake({
      keychain: credential("keychain-token", NOW + 1000),
      files: { [DEFAULT_FILE]: fileFresh },
      keychainReadMs: 1000,
    });

    expect(await createCredentialReader(environment)()).toEqual({ ok: true, accessToken: "file-token" });
  });

  it("prefers a specific error over auth_missing from the other source", async () => {
    const { environment } = fake({ files: { [DEFAULT_FILE]: credential("") } });

    expect(await createCredentialReader(environment)()).toEqual({ ok: false, error: "auth_blank" });
  });
});
