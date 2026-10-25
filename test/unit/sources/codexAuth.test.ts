import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexAuthPath,
  readCodexAuth,
  type CodexAuthEnvironment,
} from "../../../src/sources/codexAuth";

const FIXTURE = readFileSync(resolve(__dirname, "fixtures/codexAuth.json"), "utf8");
const HOME = "/home/tester";

function environment(
  files: Record<string, string>,
  codexHome?: string,
  failure?: { code?: string },
): CodexAuthEnvironment {
  return {
    codexHome,
    homeDir: HOME,
    readFile: async (filePath) => {
      if (failure !== undefined) {
        throw Object.assign(new Error(`secret path ${filePath}`), failure);
      }
      const content = files[filePath];
      if (content === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return content;
    },
  };
}

const DEFAULT_PATH = path.join(HOME, ".codex", "auth.json");

describe("codexAuthPath", () => {
  it("is ~/.codex/auth.json without CODEX_HOME", () => {
    expect(codexAuthPath(environment({}))).toBe(DEFAULT_PATH);
  });

  it("is $CODEX_HOME/auth.json when CODEX_HOME is set", () => {
    expect(codexAuthPath(environment({}, "/data/codex"))).toBe(path.join("/data/codex", "auth.json"));
  });

  it("ignores a blank CODEX_HOME", () => {
    expect(codexAuthPath(environment({}, "  "))).toBe(DEFAULT_PATH);
  });
});

describe("readCodexAuth", () => {
  it("reads tokens.access_token and tokens.account_id", async () => {
    const result = await readCodexAuth(environment({ [DEFAULT_PATH]: FIXTURE }));

    expect(result).toEqual({
      ok: true,
      accessToken: "fixture-access-token",
      accountId: "fixture-account-id",
    });
  });

  it("reads the file of CODEX_HOME instead of the default one", async () => {
    const custom = path.join("/data/codex", "auth.json");

    const result = await readCodexAuth(environment({ [custom]: FIXTURE }, "/data/codex"));

    expect(result.ok).toBe(true);
  });

  it("reports auth_missing when the file does not exist", async () => {
    expect(await readCodexAuth(environment({}))).toEqual({ ok: false, error: "auth_missing" });
  });

  it("reports auth_invalid, without the error text, when the file cannot be read", async () => {
    const result = await readCodexAuth(environment({}, undefined, { code: "EACCES" }));

    expect(result).toEqual({ ok: false, error: "auth_invalid" });
  });

  it("reports auth_invalid for text that is not JSON", async () => {
    const result = await readCodexAuth(environment({ [DEFAULT_PATH]: "{not json" }));

    expect(result).toEqual({ ok: false, error: "auth_invalid" });
  });

  it.each([["null"], ["[]"], ['{"tokens": "x"}'], ['{"tokens": null}'], ["{}"]])(
    "reports auth_invalid when tokens is not an object: %s",
    async (content) => {
      const result = await readCodexAuth(environment({ [DEFAULT_PATH]: content }));

      expect(result).toEqual({ ok: false, error: "auth_invalid" });
    },
  );

  it.each([
    [{ account_id: "a" }],
    [{ access_token: "t" }],
    [{ access_token: "  ", account_id: "a" }],
    [{ access_token: "t", account_id: "" }],
    [{ access_token: 5, account_id: "a" }],
  ])("reports auth_missing when a field is missing or blank: %j", async (tokens) => {
    const result = await readCodexAuth(
      environment({ [DEFAULT_PATH]: JSON.stringify({ tokens }) }),
    );

    expect(result).toEqual({ ok: false, error: "auth_missing" });
  });
});
