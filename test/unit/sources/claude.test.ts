import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_INTERVAL_MS,
  SECURITY_TIMEOUT_MS,
  createClaudeSource,
  createSecurityRunner,
  defaultCredentialEnvironment,
} from "../../../src/sources/claude";
import type { CredentialEnvironment } from "../../../src/sources/claudeCredentials";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const HOME = "/home/tester";
// Built with the platform's path rules, as the reader builds them, so the Windows CI matches too.
const CREDENTIALS_FILE = path.join(HOME, ".claude", ".credentials.json");

const USAGE = {
  five_hour: { utilization: 10, resets_at: "2026-10-24T15:00:00Z" },
  seven_day: { utilization: 20, resets_at: "2026-10-28T00:00:00Z" },
};

function environment(expiresAt: number): CredentialEnvironment {
  return {
    platform: "linux",
    configDir: undefined,
    homeDir: HOME,
    userName: "tester",
    readFile: async (filePath) =>
      filePath === CREDENTIALS_FILE
        ? JSON.stringify({ claudeAiOauth: { accessToken: "secret-token", expiresAt } })
        : null,
    runSecurity: async () => null,
    now: () => NOW,
  };
}

describe("createClaudeSource", () => {
  it("is the Claude source with a default interval of 5 minutes", () => {
    const source = createClaudeSource({ environment: environment(NOW + 1000) });

    expect(source.provider).toBe("claude");
    expect(source.definition.id).toBe("claude");
    expect(source.definition.intervalMs).toBe(5 * 60_000);
    expect(CLAUDE_INTERVAL_MS).toBe(5 * 60_000);
    expect(source.minIntervalMs).toBeLessThan(source.definition.intervalMs);
  });

  it("fetches the usage with the token of the credential file", async () => {
    const requests: string[] = [];
    const source = createClaudeSource({
      environment: environment(NOW + 3_600_000),
      fetchImpl: async (_input, init) => {
        requests.push((init?.headers as Record<string, string>).Authorization ?? "");
        return new Response(JSON.stringify(USAGE), { status: 200 });
      },
    });

    const result = await source.fetch(new AbortController().signal);

    expect(requests).toEqual(["Bearer secret-token"]);
    expect(result).toEqual({
      ok: true,
      snapshot: {
        name: "Claude",
        fiveHour: { usedPercent: 10, resetsAt: Date.parse("2026-10-24T15:00:00Z") },
        week: { usedPercent: 20, resetsAt: Date.parse("2026-10-28T00:00:00Z") },
      },
    });
  });

  it("sends no request and reports auth_expired when the token has expired", async () => {
    let requests = 0;
    const source = createClaudeSource({
      environment: environment(NOW - 1),
      fetchImpl: async () => {
        requests += 1;
        return new Response("{}");
      },
    });

    const result = await source.fetch(new AbortController().signal);

    expect(result).toEqual({ ok: false, error: "auth_expired" });
    expect(requests).toBe(0);
  });

  it("reports auth_missing without a credential", async () => {
    const source = createClaudeSource({
      environment: { ...environment(NOW), readFile: async () => null },
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });

    expect(await source.fetch(new AbortController().signal)).toEqual({ ok: false, error: "auth_missing" });
  });
});

describe("defaultCredentialEnvironment", () => {
  it("describes the real machine", async () => {
    const real = defaultCredentialEnvironment();

    expect(real.platform).toBe(process.platform);
    expect(real.homeDir).not.toBe("");
    expect(await real.readFile("/nonexistent/just-enough-quota-bar/file")).toBeNull();
    expect(Math.abs(real.now() - Date.now())).toBeLessThan(1000);
  });
});

describe("createSecurityRunner", () => {
  type Exec = Parameters<typeof createSecurityRunner>[0];

  function exec(behavior: (callback: (error: Error | null, stdout: string) => void) => void): {
    run: Exec;
    calls: { file: unknown; args: unknown; options: unknown }[];
  } {
    const calls: { file: unknown; args: unknown; options: unknown }[] = [];
    const run = ((file: unknown, args: unknown, options: unknown, callback: never) => {
      calls.push({ file, args, options });
      behavior(callback);
    }) as unknown as Exec;
    return { run, calls };
  }

  it("runs security directly, without a shell, with a timeout, and returns the stdout", async () => {
    const { run, calls } = exec((callback) => callback(null, "output\n"));

    const output = await createSecurityRunner(run)(["find-generic-password", "-w"]);

    expect(output).toBe("output\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("security");
    expect(calls[0]?.args).toEqual(["find-generic-password", "-w"]);
    expect(calls[0]?.options).toMatchObject({ timeout: SECURITY_TIMEOUT_MS, encoding: "utf8" });
    expect(calls[0]?.options).not.toHaveProperty("shell");
  });

  it("returns null for a failure, whose error text may carry the credential", async () => {
    const { run } = exec((callback) => callback(new Error("timed out: secret-token"), "secret-token"));

    expect(await createSecurityRunner(run)(["x"])).toBeNull();
  });

  it("returns null when the process cannot be started", async () => {
    const run = (() => {
      throw new Error("spawn failed");
    }) as unknown as Exec;

    expect(await createSecurityRunner(run)(["x"])).toBeNull();
  });

  it.runIf(process.platform === "darwin")(
    "gets nothing from the real macOS security tool for a service that does not exist",
    async () => {
      const service = `just-enough-quota-bar-test-${process.pid}-${Date.now()}`;

      const output = await createSecurityRunner()(["find-generic-password", "-a", "nobody", "-s", service, "-w"]);

      expect(output).toBeNull();
    },
  );
});
