import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../src/extension";
import type { InspectedItem } from "../../../src/statusbar/vscodeSink";

const EXTENSION_ID = "tyutyutyu.just-enough-quota-bar";
const HOUR_MS = 3_600_000;
const WAIT_MS = 10_000;
const POLL_MS = 50;
const CONFIGURED_KEYS = [
  "alignment",
  "claude.enabled",
  "claude.format",
  "claude.priority",
  "claude.thresholds",
  "claude.announcedSource",
];

async function waitFor<T>(read: () => T, accept: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (accept(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Another fetch in flight (the automatic one after registering) holds the lock; ask again. */
async function refreshUntilFetched(api: ExtensionApi): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while ((await api.refresh("claude")).claude !== "fetched") {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the test source to be fetched");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

suite("status bar", () => {
  let api: ExtensionApi;
  let registration: { dispose(): void };
  let fetches: number;

  const configuration = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("jeqb");
  const claudeItems = (): readonly InspectedItem[] =>
    api.statusBarItems().filter((item) => item.provider === "claude");
  const set = (key: string, value: unknown): Thenable<void> =>
    configuration().update(key, value, vscode.ConfigurationTarget.Global);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
    assert.ok(extension, "extension must be installed in the test host");
    api = await extension.activate();
  });

  setup(async () => {
    fetches = 0;
    registration = api.registerSource({
      provider: "claude",
      label: "test source",
      definition: { id: "claude-integration", intervalMs: 0, timeoutMs: 5000 },
      minIntervalMs: 0,
      fetch: async () => {
        fetches += 1;
        return {
          ok: true,
          snapshot: {
            name: "Claude",
            fiveHour: { usedPercent: 75, resetsAt: Date.now() + 4 * HOUR_MS },
            week: { usedPercent: 95, resetsAt: Date.now() + 48 * HOUR_MS },
          },
        };
      },
    });
    await refreshUntilFetched(api);
    await waitFor(claudeItems, (items) => items.some((item) => item.text === "75"), "the fetched data");
  });

  teardown(async () => {
    registration.dispose();
    for (const key of CONFIGURED_KEYS) {
      await set(key, undefined);
    }
  });

  test("shows a colored item per colored variable, in the order of the format", async () => {
    const items = await waitFor(claudeItems, (current) => current.length === 5, "five items");

    assert.deepStrictEqual(
      items.map((item) => [item.text, item.color, item.background]),
      [
        ["C ", undefined, undefined],
        ["75", "charts.yellow", undefined],
        [items[2]?.text, undefined, undefined],
        ["95", "errorForeground", undefined],
        ["%", undefined, undefined],
      ],
    );
    assert.match(items[2]?.text ?? "", /^% .+ · W $/);
    assert.deepStrictEqual(
      items.map((item) => item.priority),
      [200, 199, 198, 197, 196],
    );
    assert.ok(items.every((item) => item.alignment === "right"));
  });

  test("shows the minimal tooltip on every item", () => {
    const [first, ...rest] = claudeItems();

    assert.ok(first);
    assert.match(first.tooltip, /^Claude · test source\nLast update: \d+m ago$/);
    assert.ok(rest.every((item) => item.tooltip === first.tooltip));
  });

  test("rebuilds the items when the format changes and leaves no orphan", async () => {
    await set("claude.format", "{5h.pct}");
    const single = await waitFor(claudeItems, (items) => items.length === 1, "one item");
    assert.strictEqual(single[0]?.text, "75");
    assert.strictEqual(single[0]?.color, "charts.yellow");

    await set("claude.format", "{week.pct} {5h.pct}");
    const reordered = await waitFor(claudeItems, (items) => items.length === 3, "three items");
    assert.deepStrictEqual(
      reordered.map((item) => item.text),
      ["95", " ", "75"],
    );
  });

  test("recolors when the thresholds change", async () => {
    await set("claude.thresholds", { "5h.pct": [{ gte: 10, color: "#ff0000", background: "warning" }] });

    const items = await waitFor(
      claudeItems,
      (current) => current.some((item) => item.color === "#ff0000"),
      "the new color",
    );

    assert.strictEqual(items.find((item) => item.text === "75")?.background, "statusBarItem.warningBackground");
  });

  test("moves the group when the alignment and the priority change", async () => {
    await set("alignment", "left");
    await set("claude.priority", 50);

    const items = await waitFor(
      claudeItems,
      (current) => current.length === 5 && current.every((item) => item.priority <= 50 && item.alignment === "left"),
      "the moved group",
    );

    assert.deepStrictEqual(
      items.map((item) => item.priority),
      [50, 49, 48, 47, 46],
    );
  });

  test("shows one error item with the details in the tooltip for an invalid format", async () => {
    await set("claude.format", "{nope}");

    const items = await waitFor(
      claudeItems,
      (current) => current.length === 1 && current[0]?.text === "$(warning) Claude",
      "the error item",
    );

    assert.strictEqual(items[0]?.background, "statusBarItem.errorBackground");
    assert.match(items[0]?.tooltip ?? "", /Unknown variable "nope"/);
  });

  test("shows the error item for an invalid threshold", async () => {
    await set("claude.thresholds", { "5h.pct": [{ gte: "high", color: "charts.red" }] });

    const items = await waitFor(claudeItems, (current) => current[0]?.text === "$(warning) Claude", "the error item");

    assert.match(items[0]?.tooltip ?? "", /jeqb\.claude\.thresholds "5h\.pct" step 1/);
  });

  test("removes the group when the provider is disabled", async () => {
    await set("claude.enabled", false);

    await waitFor(claudeItems, (items) => items.length === 0, "no items");
  });

  test("runs the refresh command, which asks the source again", async () => {
    const before = fetches;

    await vscode.commands.executeCommand("jeqb.refresh", "claude");

    assert.ok(fetches > before, "the command must query the source");
    assert.strictEqual(claudeItems().length, 5);
  });

  test("shows the announced values and links the tracker in the tooltip", async () => {
    const tracker = api.registerAnnouncedSource({
      provider: "claude",
      sourceId: "whenreset",
      attribution: { text: "Data: test tracker", url: "https://tracker.example/" },
      definition: { id: "claude-announced-it", intervalMs: 0, timeoutMs: 5000 },
      minIntervalMs: 0,
      fetch: async () => ({
        ok: true,
        snapshot: {
          name: "Claude",
          announced: { next: null, kind: null, last: null, p24: 42, p48: 64 },
        },
      }),
    });
    try {
      await set("claude.format", "{5h.pct}% {announced.p24}%");
      const deadline = Date.now() + WAIT_MS;
      while (claudeItems().map((item) => item.text).join("") !== "75% 42%") {
        assert.ok(Date.now() < deadline, "the announced value must be shown");
        await api.refresh("claude");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }

      const tooltip = claudeItems()[0]?.tooltip ?? "";
      assert.match(tooltip, /\[Data: test tracker\]\(https:\/\/tracker\.example\/\)$/);

      await set("claude.announcedSource", "off");
      await waitFor(
        claudeItems,
        (items) => items.map((item) => item.text).join("") === "75% –%",
        "the announced value to be missing",
      );
    } finally {
      tracker.dispose();
    }
  });
});
