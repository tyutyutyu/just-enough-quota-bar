import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeThresholds, parseThresholds, resolveThresholds } from "../../../src/thresholds/parse";

const DAY_MS = 86_400_000;

describe("parseThresholds", () => {
  it("parses number, duration and text steps", () => {
    const { thresholds, errors } = parseThresholds({
      "5h.pct": [
        { gte: 70, color: "charts.yellow" },
        { gt: 90, color: "#ff0000", background: "error" },
      ],
      "banked.expires": [{ lte: "3d", color: "charts.orange" }],
      "announced.kind": [{ eq: "estimate", color: "charts.blue" }],
    });

    expect(errors).toEqual([]);
    expect(thresholds.get("5h.pct")).toEqual([
      { operator: "gte", operand: 70, style: { color: "charts.yellow" } },
      { operator: "gt", operand: 90, style: { color: "#ff0000", background: "error" } },
    ]);
    expect(thresholds.get("banked.expires")).toEqual([
      { operator: "lte", operand: 3 * DAY_MS, style: { color: "charts.orange" } },
    ]);
    expect(thresholds.get("announced.kind")).toEqual([
      { operator: "eq", operand: "estimate", style: { color: "charts.blue" } },
    ]);
  });

  it.each([undefined, null])("treats %s as no thresholds", (raw) => {
    expect(parseThresholds(raw)).toEqual({ thresholds: new Map(), errors: [] });
  });

  it.each([[[]], ["text"], [5]])("reports a non-object block %j", (raw) => {
    const { thresholds, errors } = parseThresholds(raw);
    expect(thresholds.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.index).toBeNull();
  });

  it("keeps valid steps and reports the invalid ones with their position", () => {
    const { thresholds, errors } = parseThresholds({
      "5h.pct": [
        { gte: 70, color: "charts.yellow" },
        { gte: 80, color: "charts.red", background: "info" },
        { gte: 90, color: "errorForeground" },
      ],
    });

    expect(thresholds.get("5h.pct")?.map((step) => step.operand)).toEqual([70, 90]);
    expect(errors).toEqual([
      { variable: "5h.pct", index: 1, message: expect.stringContaining("background") },
    ]);
  });

  it("keeps the other variables when one key is invalid", () => {
    const { thresholds, errors } = parseThresholds({
      "nope.pct": [{ gte: 1, color: "charts.red" }],
      "week.pct": "not a list",
      "5h.pct": [{ gte: 70, color: "charts.yellow" }],
    });

    expect([...thresholds.keys()]).toEqual(["5h.pct"]);
    expect(errors.map((error) => [error.variable, error.index])).toEqual([
      ["nope.pct", null],
      ["week.pct", null],
    ]);
  });

  it.each([
    ["a non-object step", "x"],
    ["an array step", []],
    ["a null step", null],
    ["no condition", { color: "charts.red" }],
    ["two conditions", { gte: 1, lte: 2, color: "charts.red" }],
    ["an unknown key", { gte: 1, colour: "charts.red" }],
    ["a missing color", { gte: 1 }],
    ["a bad color", { gte: 1, color: "red!" }],
    ["a text operand on a number variable", { gte: "70", color: "charts.red" }],
    ["a non-finite operand", { gte: Number.POSITIVE_INFINITY, color: "charts.red" }],
    ["eq on a number variable", { eq: 70, color: "charts.red" }],
  ])("rejects %s on a number variable", (_name, step) => {
    const { thresholds, errors } = parseThresholds({ "5h.pct": [step] });
    expect(thresholds.get("5h.pct")).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it.each([
    ["a number", { lte: 3, color: "charts.red" }],
    ["a bad duration", { lte: "3 days", color: "charts.red" }],
    ["eq", { eq: "3d", color: "charts.red" }],
  ])("rejects %s on a time variable", (_name, step) => {
    expect(parseThresholds({ "banked.expires": [step] }).errors).toHaveLength(1);
  });

  it.each([
    ["a relational operator", { gte: "a", color: "charts.red" }],
    ["a non-text value", { eq: 1, color: "charts.red" }],
  ])("rejects %s on a text variable", (_name, step) => {
    expect(parseThresholds({ "announced.kind": [step] }).errors).toHaveLength(1);
  });

  it("ignores an inherited __proto__ key as an unknown variable", () => {
    const raw: unknown = JSON.parse('{"__proto__": [{"gte": 1, "color": "charts.red"}]}');
    const { thresholds, errors } = parseThresholds(raw);
    expect(thresholds.size).toBe(0);
    expect(errors).toHaveLength(1);
  });
});

describe("mergeThresholds and resolveThresholds", () => {
  const global = {
    "5h.pct": [{ gte: 70, color: "charts.yellow" }],
    "week.pct": [{ gte: 70, color: "charts.yellow" }],
  };

  it("lets the provider block replace the global one key by key", () => {
    const { thresholds, errors } = resolveThresholds(global, {
      "5h.pct": [{ gte: 50, color: "charts.red" }],
    });

    expect(errors).toEqual([]);
    expect(thresholds.get("5h.pct")).toEqual([
      { operator: "gte", operand: 50, style: { color: "charts.red" } },
    ]);
    expect(thresholds.get("week.pct")).toEqual([
      { operator: "gte", operand: 70, style: { color: "charts.yellow" } },
    ]);
  });

  it("lets an empty provider list switch a global key off", () => {
    expect(resolveThresholds(global, { "5h.pct": [] }).thresholds.get("5h.pct")).toEqual([]);
  });

  it("falls back to the global key when the provider key is invalid as a whole", () => {
    const { thresholds, errors } = resolveThresholds(global, { "5h.pct": "bad" });
    expect(thresholds.get("5h.pct")).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("collects the errors of both blocks", () => {
    const { errors } = resolveThresholds({ unknown: [] }, { other: [] });
    expect(errors.map((error) => error.variable)).toEqual(["unknown", "other"]);
  });

  it("does not modify its inputs", () => {
    const base = parseThresholds(global).thresholds;
    const override = parseThresholds({ "5h.pct": [] }).thresholds;
    mergeThresholds(base, override);
    expect(base.get("5h.pct")).toHaveLength(1);
  });
});

describe("package.json settings", () => {
  const properties = (
    JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    }
  ).contributes.configuration.properties;

  it("ships default thresholds for 5h.pct, week.pct and banked.expires", () => {
    const { thresholds, errors } = parseThresholds(properties["jeqb.thresholds"]?.default);

    expect(errors).toEqual([]);
    expect([...thresholds.keys()].sort()).toEqual(["5h.pct", "banked.expires", "week.pct"]);
    expect(thresholds.get("5h.pct")?.at(-1)?.style).toEqual({
      color: "errorForeground",
      background: "error",
    });
    expect(thresholds.get("banked.expires")?.map((step) => step.operand)).toEqual([
      3 * DAY_MS,
      DAY_MS,
    ]);
  });

  it.each(["jeqb.claude.thresholds", "jeqb.codex.thresholds"])(
    "declares an empty override block %s",
    (key) => {
      expect(properties[key]?.default).toEqual({});
    },
  );

  it("declares the stale color with a valid default", () => {
    expect(properties["jeqb.staleColor"]?.default).toBe("disabledForeground");
  });
});
