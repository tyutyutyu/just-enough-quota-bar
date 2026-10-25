// A stand-in for `codex app-server`: JSON lines on stdio, like the real one.
// Usage: node fakeAppServer.mjs <mode> [resultFile] [pidFile]
import { readFileSync, writeFileSync } from "node:fs";
import { setInterval } from "node:timers";
import { createInterface } from "node:readline";

const [mode, resultFile, pidFile] = process.argv.slice(2);
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = () => JSON.parse(readFileSync(resultFile, "utf8"));
const initialized = { userAgent: "fake/0.0.0", codexHome: "/home/fake/.codex", platformFamily: "unix", platformOs: "linux" };

if (mode === "exit-at-start") {
  process.exit(3);
}
if (mode === "stubborn") {
  // Ignores the polite stop, so only the kill ends it.
  process.on("SIGTERM", () => undefined);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "initialize-error") {
      write({ id: message.id, error: { code: -32600, message: "not allowed" } });
      return;
    }
    write({ method: "configWarning", params: { summary: "noise", details: null } });
    process.stdout.write("this line is not json\n");
    write({ id: message.id, result: initialized });
  } else if (message.method === "account/rateLimits/read") {
    if (mode === "rpc-error") {
      write({ id: message.id, error: { code: -32603, message: "backend down" } });
    } else if (mode === "slow" || mode === "stubborn") {
      // Never answers: the caller has to stop the process.
    } else if (mode === "huge") {
      process.stdout.write("x".repeat(5 * 1024 * 1024));
    } else {
      write({ id: message.id, result: result() });
    }
  }
});
// Like the real server, stop when the input is closed.
lines.on("close", () => {
  if (mode !== "slow" && mode !== "stubborn") {
    process.exit(0);
  }
});
if (mode === "slow" || mode === "stubborn") {
  setInterval(() => undefined, 1000);
}
