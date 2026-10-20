import * as vscode from "vscode";
import { COMMAND_REFRESH } from "./constants";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_REFRESH, () => {
      // Quota sources are added by later tasks.
    }),
  );
}

export function deactivate(): void {
  // Nothing to release: all resources are registered on context.subscriptions.
}
