/**
 * One contending VS Code window, run as a separate OS process by
 * concurrency.test.ts. Usage: worker <cacheDir> <counterFile> <startAtMs> <fetchMs>
 * Prints the refresh outcome as the only line of stdout.
 */
import { appendFile } from "node:fs/promises";
import { SharedCache, type SourceDefinition } from "../../../src/cache/sharedCache";

const SOURCE: SourceDefinition = { id: "codex-probe", intervalMs: 10 * 60_000, timeoutMs: 30_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const [cacheDir, counterFile, startAt, fetchMs] = process.argv.slice(2);
  if (!cacheDir || !counterFile || !startAt || !fetchMs) {
    throw new Error("missing arguments");
  }
  // Every contender starts at the same instant, so that their fetches overlap.
  await sleep(Math.max(Number(startAt) - Date.now(), 0));
  const outcome = await new SharedCache(cacheDir).refresh(SOURCE, async () => {
    await appendFile(counterFile, `${process.pid}\n`);
    await sleep(Number(fetchMs));
    return { ok: true, snapshot: { name: "Codex" } };
  });
  process.stdout.write(`${outcome}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "worker failed"}\n`);
  process.exitCode = 1;
});
