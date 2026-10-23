import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedCache } from "../../../src/cache/sharedCache";

const run = promisify(execFile);
// Vitest runs from the repository root.
const WORKER_SOURCE = resolve("test/unit/cache/contenderWorker.ts");
const FETCH_MS = 1500;
const START_DELAY_MS = 2500;

let workspace: string;
let workerScript: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jeqb-race-"));
  workerScript = join(workspace, "worker.cjs");
  await build({
    entryPoints: [WORKER_SOURCE],
    outfile: workerScript,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function race(contenders: number): Promise<{ outcomes: string[]; fetches: number; dir: string }> {
  const dir = await mkdtemp(join(workspace, "run-"));
  const counterFile = join(dir, "fetches.log");
  const startAt = Date.now() + START_DELAY_MS;
  const results = await Promise.all(
    Array.from({ length: contenders }, () =>
      run(process.execPath, [workerScript, dir, counterFile, String(startAt), String(FETCH_MS)]),
    ),
  );
  const log = await readFile(counterFile, "utf8").catch(() => "");
  return {
    outcomes: results.map((result) => result.stdout.trim()),
    fetches: log.split("\n").filter(Boolean).length,
    dir,
  };
}

describe("two windows racing for the same source", () => {
  it("lets only one of two writers query the source", async () => {
    const { outcomes, fetches } = await race(2);

    expect(fetches).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "fetched")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "locked" || outcome === "fresh")).toHaveLength(1);
  }, 60_000);

  it("keeps it to one query with more contenders", async () => {
    const { outcomes, fetches } = await race(5);

    expect(fetches).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "fetched")).toHaveLength(1);
  }, 60_000);

  it("leaves the winner's answer in the shared cache", async () => {
    const { dir } = await race(2);

    const entry = (await new SharedCache(dir).read()).entries["codex-probe"];
    expect(entry?.snapshot?.name).toBe("Codex");
    expect(entry?.error).toBeNull();
  }, 60_000);
});
