import * as vscode from "vscode";
import { COMMAND_REFRESH, PROVIDER_NAMES, type ProviderId } from "../constants";
import type { ThresholdBackground } from "../thresholds/style";
import type { StatusBarSink } from "./controller";
import type { ItemSpec } from "./layout";
import { tooltipMarkdown } from "./tooltip";

const BACKGROUND_COLORS: Readonly<Record<ThresholdBackground, string>> = {
  warning: "statusBarItem.warningBackground",
  error: "statusBarItem.errorBackground",
};

/** What a live status bar item shows; read back from the item itself. */
export interface InspectedItem {
  readonly provider: ProviderId;
  readonly text: string;
  /** Theme color ID or `#rrggbb`; `undefined` for the default foreground. */
  readonly color: string | undefined;
  /** Theme color ID of the background; `undefined` for none. */
  readonly background: string | undefined;
  readonly alignment: "left" | "right";
  readonly priority: number;
  readonly tooltip: string;
}

function toForeground(color: string | null): string | vscode.ThemeColor | undefined {
  if (color === null) {
    return undefined;
  }
  return color.startsWith("#") ? color : new vscode.ThemeColor(color);
}

function colorId(color: string | vscode.ThemeColor | undefined): string | undefined {
  return color instanceof vscode.ThemeColor ? color.id : color;
}

function toAlignment(alignment: "left" | "right"): vscode.StatusBarAlignment {
  return alignment === "left" ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
}

/**
 * The status bar items of every provider. An item is reused while its
 * alignment and priority stay, which VS Code only accepts at creation; extra
 * items are disposed, so a changed layout never leaves one behind.
 */
export class VscodeStatusBarSink implements StatusBarSink {
  private readonly groups = new Map<ProviderId, vscode.StatusBarItem[]>();

  update(provider: ProviderId, specs: readonly ItemSpec[]): void {
    const items = [...(this.groups.get(provider) ?? [])];
    specs.forEach((spec, index) => {
      const existing = items[index];
      const item =
        existing !== undefined &&
        existing.alignment === toAlignment(spec.alignment) &&
        existing.priority === spec.priority
          ? existing
          : this.replace(provider, existing, spec);
      items[index] = item;
      this.apply(item, provider, spec);
    });
    items.splice(specs.length).forEach((extra) => extra.dispose());
    this.groups.set(provider, items);
  }

  /** The live items, in display order per provider. */
  inspect(): readonly InspectedItem[] {
    return [...this.groups.entries()].flatMap(([provider, items]) =>
      items.map((item) => ({
        provider,
        text: item.text,
        color: colorId(item.color),
        background: colorId(item.backgroundColor),
        alignment: item.alignment === vscode.StatusBarAlignment.Left ? "left" : "right",
        priority: item.priority ?? 0,
        tooltip: typeof item.tooltip === "string" ? item.tooltip : (item.tooltip?.value ?? ""),
      })),
    );
  }

  dispose(): void {
    this.groups.forEach((items) => items.forEach((item) => item.dispose()));
    this.groups.clear();
  }

  private replace(
    provider: ProviderId,
    existing: vscode.StatusBarItem | undefined,
    spec: ItemSpec,
  ): vscode.StatusBarItem {
    existing?.dispose();
    // No id: VS Code remembers the alignment and priority of an id, even after
    // its item is disposed, and would give a recreated item the old ones back.
    const item = vscode.window.createStatusBarItem(toAlignment(spec.alignment), spec.priority);
    item.name = `Just Enough Quota Bar: ${PROVIDER_NAMES[provider]}`;
    return item;
  }

  private apply(item: vscode.StatusBarItem, provider: ProviderId, spec: ItemSpec): void {
    item.text = spec.text;
    item.tooltip =
      spec.attribution === null
        ? spec.tooltip
        : new vscode.MarkdownString(tooltipMarkdown(spec.tooltip, spec.attribution));
    item.color = toForeground(spec.color);
    item.backgroundColor =
      spec.background === null ? undefined : new vscode.ThemeColor(BACKGROUND_COLORS[spec.background]);
    item.command = { command: COMMAND_REFRESH, title: "Refresh quota", arguments: [provider] };
    item.show();
  }
}
