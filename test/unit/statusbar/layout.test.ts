import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../../../src/model";
import { layoutProvider, type LayoutInput } from "../../../src/statusbar/layout";
import { readSettings, type Settings } from "../../../src/statusbar/settings";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DEFAULT_THRESHOLDS = {
  "5h.pct": [
    { gte: 70, color: "charts.yellow" },
    { gte: 90, color: "errorForeground", background: "error" },
  ],
  "week.pct": [{ gte: 70, color: "charts.yellow" }],
};

function settingsWith(values: Record<string, unknown> = {}): Settings {
  return readSettings((name) => ({ thresholds: DEFAULT_THRESHOLDS, ...values })[name]);
}

const snapshot = (fiveHour: number, week: number): QuotaSnapshot => ({
  name: "Claude",
  fiveHour: { usedPercent: fiveHour, resetsAt: NOW + 2 * HOUR },
  week: { usedPercent: week, resetsAt: NOW + 48 * HOUR },
  fetchedAt: NOW - 60_000,
});

function input(overrides: Partial<LayoutInput> = {}): LayoutInput {
  return {
    provider: "claude",
    settings: settingsWith(),
    source: { label: "OAuth usage" },
    snapshot: snapshot(75, 20),
    errorCode: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("layoutProvider", () => {
  it("gives every colored variable its own item and joins the text between them", () => {
    const items = layoutProvider(input());

    expect(items.map((item) => item.text)).toEqual(["C ", "75", "% 2h · W 20%"]);
    expect(items.map((item) => item.color)).toEqual([null, "charts.yellow", null]);
  });

  it("keeps the order of the format with a priority that drops by one per item", () => {
    const items = layoutProvider(
      input({ settings: settingsWith({ "claude.priority": 50 }), snapshot: snapshot(75, 80) }),
    );

    expect(items.map((item) => item.text)).toEqual(["C ", "75", "% 2h · W ", "80", "%"]);
    expect(items.map((item) => item.priority)).toEqual([50, 49, 48, 47, 46]);
  });

  it("uses the default priority of the provider", () => {
    const [first] = layoutProvider(input({ provider: "codex" }));

    expect(first?.priority).toBe(100);
  });

  it("paints the background of the matching step", () => {
    const items = layoutProvider(input({ snapshot: snapshot(95, 20) }));

    expect(items.find((item) => item.text === "95")).toMatchObject({
      color: "errorForeground",
      background: "error",
    });
    expect(items.filter((item) => item.background !== null)).toHaveLength(1);
  });

  it("applies the alignment to every item", () => {
    const items = layoutProvider(input({ settings: settingsWith({ alignment: "left" }) }));

    expect(new Set(items.map((item) => item.alignment))).toEqual(new Set(["left"]));
  });

  it("lets the provider thresholds replace the global ones key by key", () => {
    const items = layoutProvider(
      input({
        settings: settingsWith({ "claude.thresholds": { "5h.pct": [{ gte: 10, color: "charts.blue" }] } }),
        snapshot: snapshot(75, 80),
      }),
    );

    expect(items.map((item) => item.color)).toEqual([null, "charts.blue", null, "charts.yellow", null]);
  });

  it("dims every value with the stale color, not the literals", () => {
    const items = layoutProvider(
      input({ snapshot: { ...snapshot(75, 80), stale: true }, errorCode: "upstream_429" }),
    );

    expect(items.filter((item) => item.color !== null).map((item) => item.color)).toEqual([
      "disabledForeground",
      "disabledForeground",
      "disabledForeground",
    ]);
    expect(items[0]?.tooltip).toContain("Stale: upstream_429");
  });

  it("shows the missing value without color when there is no data", () => {
    const items = layoutProvider(input({ snapshot: null, source: null }));

    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("C –% – · W –%");
    expect(items[0]?.color).toBeNull();
    expect(items[0]?.tooltip).toBe("Claude · no source\nLast update: never");
  });

  it("shows a reached reset as 0% and stale", () => {
    const expired: QuotaSnapshot = {
      ...snapshot(95, 20),
      fiveHour: { usedPercent: 95, resetsAt: NOW - 1 },
    };

    const items = layoutProvider(input({ snapshot: expired }));

    expect(items.map((item) => item.text).join("")).toBe("C 0% 0m · W 20%");
    expect(items[0]?.tooltip).toContain("Stale");
  });

  describe("announced provider", () => {
    const attribution = { text: "Data: whenreset.app", url: "https://whenreset.app/" };
    const values = { next: NOW + 5 * HOUR, kind: "announced" as const, last: NOW - 48 * HOUR, p24: 12.96, p48: 29.63 };
    const announcedFormat = settingsWith({
      "claude.format": "{5h.pct}% ⚡{announced.next:rel} {announced.kind} {announced.p24}%",
    });

    it("credits the provider, with its link, only when the format uses an announced variable", () => {
      const plain = layoutProvider(input({ announced: { attribution, values } }));
      const shown = layoutProvider(input({ settings: announcedFormat, announced: { attribution, values } }));

      expect(plain.every((item) => item.attribution === null)).toBe(true);
      expect(shown.every((item) => item.attribution === attribution)).toBe(true);
    });

    it("shows the announced values next to the quota", () => {
      const items = layoutProvider(input({ settings: announcedFormat, announced: { attribution, values } }));

      expect(items.map((item) => item.text).join("")).toBe("75% ⚡5h announced 13%");
    });

    it("leaves only the announced variables missing when the provider has no usable answer", () => {
      const items = layoutProvider(
        input({
          settings: announcedFormat,
          snapshot: { ...snapshot(75, 20), announced: values },
          announced: { attribution, values: null },
        }),
      );

      expect(items.map((item) => item.text).join("")).toBe("75% ⚡– – –%");
      expect(items[0]?.attribution).toBe(attribution);
      expect(items[0]?.tooltip).not.toContain("Stale");
    });

    describe("estimate", () => {
      const DAY = 24 * HOUR;
      const estimated = { ...values, next: null, kind: null, estimate: NOW + 2 * DAY };
      const withEstimates = (include: boolean) =>
        settingsWith({
          "claude.format": "{announced.next:rel} {announced.kind}",
          "announced.includeEstimates": include,
        });

      it("is shown only with jeqb.announced.includeEstimates", () => {
        const off = layoutProvider(input({ settings: withEstimates(false), announced: { attribution, values: estimated } }));
        const on = layoutProvider(input({ settings: withEstimates(true), announced: { attribution, values: estimated } }));

        expect(off.map((item) => item.text).join("")).toBe("– –");
        expect(on.map((item) => item.text).join("")).toBe("2d estimate");
      });

      it("still counts on its own day, and is missing once that day is over", () => {
        const today = { ...estimated, estimate: NOW - HOUR };
        const past = { ...estimated, estimate: NOW - DAY };

        const onItsDay = layoutProvider(input({ settings: withEstimates(true), announced: { attribution, values: today } }));
        const after = layoutProvider(input({ settings: withEstimates(true), announced: { attribution, values: past } }));

        expect(onItsDay.map((item) => item.text).join("")).toBe("0m estimate");
        expect(after.map((item) => item.text).join("")).toBe("– –");
      });

      it("never replaces an announced reset", () => {
        const both = { ...values, estimate: NOW + 2 * DAY };
        const items = layoutProvider(input({ settings: withEstimates(true), announced: { attribution, values: both } }));

        expect(items.map((item) => item.text).join("")).toBe("5h announced");
      });
    });
  });

  describe("invalid configuration", () => {
    it("shows one error item with the format problem in the tooltip", () => {
      const items = layoutProvider(
        input({ settings: settingsWith({ "claude.format": "{5h.pct} {nope}" }), snapshot: snapshot(95, 95) }),
      );

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        text: "$(warning) Claude",
        background: "error",
        color: null,
        priority: 200,
      });
      expect(items[0]?.tooltip).toContain('jeqb.claude.format, position 10: Unknown variable "nope"');
    });

    it("shows the threshold problem of the global and the provider block", () => {
      const items = layoutProvider(
        input({
          settings: settingsWith({
            thresholds: { "5h.pct": [{ gte: "high", color: "charts.red" }], bogus: [] },
            "claude.thresholds": { "week.pct": [{ color: "charts.red" }] },
          }),
        }),
      );

      expect(items).toHaveLength(1);
      const tooltip = items[0]?.tooltip ?? "";
      expect(tooltip).toContain('jeqb.thresholds "5h.pct" step 1:');
      expect(tooltip).toContain('jeqb.thresholds "bogus": Unknown variable "bogus"');
      expect(tooltip).toContain('jeqb.claude.thresholds "week.pct" step 1:');
    });

    it("reports a thresholds value that is not an object", () => {
      const items = layoutProvider(input({ settings: settingsWith({ thresholds: [] }) }));

      expect(items[0]?.tooltip).toContain("jeqb.thresholds: Thresholds must be an object");
    });

    it("reports an invalid stale color and a setting of the wrong type", () => {
      const items = layoutProvider(
        input({ settings: settingsWith({ staleColor: "not a color", alignment: 5 }) }),
      );

      expect(items[0]?.tooltip).toContain("jeqb.staleColor: Invalid color");
      expect(items[0]?.tooltip).toContain("jeqb.alignment has an invalid value");
    });

    it("keeps working for the other provider", () => {
      const settings = settingsWith({ "claude.format": "{" });

      expect(layoutProvider(input({ settings, provider: "codex" }))[0]?.text).toBe("X ");
    });
  });
});
