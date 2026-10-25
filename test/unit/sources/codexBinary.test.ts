import { describe, expect, it } from "vitest";
import {
  isExecutableFile,
  needsShell,
  resolveCodexBinary,
  type BinaryEnvironment,
} from "../../../src/sources/codexBinary";

function environment(
  platform: NodeJS.Platform,
  pathVariable: string | undefined,
  files: readonly string[],
): BinaryEnvironment {
  return { platform, pathVariable, isExecutable: async (file) => files.includes(file) };
}

describe("resolveCodexBinary", () => {
  it("prefers the configured path over the PATH", async () => {
    const env = environment("linux", "/usr/bin", ["/opt/codex/bin/codex", "/usr/bin/codex"]);

    expect(await resolveCodexBinary("/opt/codex/bin/codex", env)).toBe("/opt/codex/bin/codex");
  });

  it("does not fall back to the PATH when the configured path does not exist", async () => {
    const env = environment("linux", "/usr/bin", ["/usr/bin/codex"]);

    expect(await resolveCodexBinary("/opt/missing/codex", env)).toBeNull();
  });

  it("treats a blank setting as unset", async () => {
    const env = environment("linux", "/usr/bin", ["/usr/bin/codex"]);

    expect(await resolveCodexBinary("   ", env)).toBe("/usr/bin/codex");
    expect(await resolveCodexBinary(undefined, env)).toBe("/usr/bin/codex");
  });

  it("finds the first codex on the PATH, skipping empty entries", async () => {
    const env = environment("linux", ":/a::/b:/c", ["/b/codex", "/c/codex"]);

    expect(await resolveCodexBinary(undefined, env)).toBe("/b/codex");
  });

  it("returns null when the PATH has none or is unset", async () => {
    expect(await resolveCodexBinary(undefined, environment("linux", "/a:/b", []))).toBeNull();
    expect(await resolveCodexBinary(undefined, environment("linux", undefined, []))).toBeNull();
  });

  it("finds codex.cmd on the Windows PATH", async () => {
    const env = environment("win32", "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm", [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    ]);

    expect(await resolveCodexBinary(undefined, env)).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    );
  });

  it("finds codex.exe on the Windows PATH, and prefers it to codex.cmd in the same directory", async () => {
    const env = environment("win32", '"C:\\Program Files\\Codex"', [
      "C:\\Program Files\\Codex\\codex.cmd",
      "C:\\Program Files\\Codex\\codex.exe",
    ]);

    expect(await resolveCodexBinary(undefined, env)).toBe("C:\\Program Files\\Codex\\codex.exe");
  });

  it("completes a configured Windows path without extension", async () => {
    const env = environment("win32", undefined, ["D:\\tools\\codex.cmd"]);

    expect(await resolveCodexBinary("D:\\tools\\codex", env)).toBe("D:\\tools\\codex.cmd");
  });

  it("keeps a configured Windows path that has the extension", async () => {
    const env = environment("win32", undefined, ["D:\\tools\\CODEX.EXE"]);

    expect(await resolveCodexBinary("D:\\tools\\CODEX.EXE", env)).toBe("D:\\tools\\CODEX.EXE");
  });
});

describe("isExecutableFile", () => {
  it("accepts a real executable and rejects a directory and a missing file", async () => {
    expect(await isExecutableFile(process.execPath)).toBe(true);
    expect(await isExecutableFile(__dirname)).toBe(false);
    expect(await isExecutableFile(`${__dirname}/does-not-exist`)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("rejects a file without the executable bit", async () => {
    expect(await isExecutableFile(`${__dirname}/fixtures/accountRateLimits.json`)).toBe(false);
  });
});

describe("needsShell", () => {
  it("is true only for a .cmd or .bat file on Windows", () => {
    expect(needsShell("C:\\npm\\codex.cmd", "win32")).toBe(true);
    expect(needsShell("C:\\npm\\codex.BAT", "win32")).toBe(true);
    expect(needsShell("C:\\npm\\codex.exe", "win32")).toBe(false);
    expect(needsShell("/usr/bin/codex.cmd", "linux")).toBe(false);
  });
});
