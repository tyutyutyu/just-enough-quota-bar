import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // Set by VS Code terminals; it would make the downloaded VS Code run as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index");
  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}

main().catch((error: unknown) => {
  console.error("Integration tests failed:", error);
  process.exit(1);
});
