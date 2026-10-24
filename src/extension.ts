import * as vscode from "vscode";
import { SharedCache } from "./cache/sharedCache";
import type { Disposable } from "./cache/watcher";
import { COMMAND_REFRESH, PREFIX, PROVIDER_IDS, type ProviderId } from "./constants";
import { QuotaController, type RefreshOutcomes } from "./statusbar/controller";
import { readSettings } from "./statusbar/settings";
import type { QuotaSource } from "./statusbar/source";
import { VscodeStatusBarSink, type InspectedItem } from "./statusbar/vscodeSink";

/** What `activate` returns: how the quota sources connect, and a view for the integration test. */
export interface ExtensionApi {
  /** Connects `source` to its provider's status bar group, replacing the previous source. */
  registerSource(source: QuotaSource): Disposable;
  /** Asks for fresh data now, for every provider or just one. */
  refresh(provider?: ProviderId): Promise<RefreshOutcomes>;
  /** The status bar items as they are shown right now. */
  statusBarItems(): readonly InspectedItem[];
}

function isProviderId(value: unknown): value is ProviderId {
  return PROVIDER_IDS.some((provider) => provider === value);
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel("Just Enough Quota Bar");
  const sink = new VscodeStatusBarSink();
  const controller = new QuotaController({
    cache: new SharedCache(context.globalStorageUri.fsPath),
    sink,
    readSettings: () => {
      const configuration = vscode.workspace.getConfiguration(PREFIX);
      return readSettings((name) => configuration.get(name));
    },
    onError: (error) => output.appendLine(error instanceof Error ? error.message : "Unknown error"),
  });

  context.subscriptions.push(
    output,
    controller,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(PREFIX)) {
        controller.render();
      }
    }),
    vscode.commands.registerCommand(COMMAND_REFRESH, (provider?: unknown) =>
      controller.refresh(isProviderId(provider) ? provider : undefined),
    ),
  );
  await controller.start();

  return {
    registerSource: (source) => controller.registerSource(source),
    refresh: (provider) => controller.refresh(provider),
    statusBarItems: () => sink.inspect(),
  };
}

export function deactivate(): void {
  // Nothing to release: all resources are registered on context.subscriptions.
}
