import * as assert from "node:assert";
import * as vscode from "vscode";

suite("extension", () => {
  test("registers the jeqb.refresh command", async () => {
    const extension = vscode.extensions.getExtension("tyutyutyu.just-enough-quota-bar");
    assert.ok(extension, "extension must be installed in the test host");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("jeqb.refresh"));
  });

  test("runs locally via extensionKind ui", () => {
    const extension = vscode.extensions.getExtension("tyutyutyu.just-enough-quota-bar");
    assert.ok(extension);
    assert.deepStrictEqual(extension.packageJSON.extensionKind, ["ui"]);
  });
});
