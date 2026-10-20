import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 20_000 });
  for (const file of fs.readdirSync(__dirname)) {
    if (file.endsWith(".test.js")) {
      mocha.addFile(path.resolve(__dirname, file));
    }
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve(),
    );
  });
}
