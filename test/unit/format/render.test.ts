import { describe, expect, it } from "vitest";
import { parseFormat } from "../../../src/format/parser";
import { render } from "../../../src/format/render";
import { VARIABLES, isVariableName } from "../../../src/format/variables";
import type { QuotaSnapshot } from "../../../src/model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 12, 10, 0);
const MISSING = "–";

const FULL: QuotaSnapshot = {
  name: "Claude",
  fiveHour: { usedPct: 42.4, resetsAt: NOW + HOUR + 12 * MINUTE },
  week: { usedPct: 67, resetsAt: NOW + 2 * DAY + 3 * HOUR },
  banked: { count: 2, nextExpiresAt: NOW + 5 * DAY },
  announced: { next: NOW + 20 * HOUR, kind: "announced", last: NOW - 3 * DAY, p24: 12.5, p48: 60 },
};

function segments(format: string, snapshot: QuotaSnapshot = FULL, missing = MISSING) {
  const parsed = parseFormat(format);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.errors));
  }
  return render(parsed.tokens, snapshot, NOW, missing);
}

function texts(format: string, snapshot: QuotaSnapshot = FULL): string[] {
  return segments(format, snapshot).map((segment) => segment.text);
}

describe("render segments", () => {
  it("returns no segments for an empty format", () => {
    expect(segments("")).toEqual([]);
  });

  it("returns literal and variable segments in format order", () => {
    expect(segments("C {5h.pct}% {5h.reset}")).toEqual([
      { type: "literal", text: "C " },
      { type: "variable", variable: "5h.pct", valueKind: "number", text: "42", raw: 42.4 },
      { type: "literal", text: "% " },
      { type: "variable", variable: "5h.reset", valueKind: "time", text: "1h12m", raw: NOW + HOUR + 12 * MINUTE },
    ]);
  });

  it("gives the default example of the spec", () => {
    expect(texts("C {5h.pct}% {5h.reset:rel} · W {week.pct}%").join("")).toBe("C 42% 1h12m · W 67%");
  });

  it("gives one segment per use of a repeated variable", () => {
    expect(texts("{name}{name}")).toEqual(["Claude", "Claude"]);
  });

  it("passes codicons and escaped braces through as literals", () => {
    expect(texts("$(sync) {{{5h.pct}}}")).toEqual(["$(sync) {", "42", "}"]);
  });
});

describe("render variables", () => {
  it.each([
    ["5h.pct", "42", 42.4],
    ["5h.left", "58", 57.6],
    ["week.pct", "67", 67],
    ["week.left", "33", 33],
    ["banked.count", "2", 2],
    ["announced.p24", "13", 12.5],
    ["announced.p48", "60", 60],
  ])("renders the number variable %s", (variable, text, raw) => {
    const [segment] = segments(`{${variable}}`);

    expect(segment).toMatchObject({ variable, valueKind: "number", text, raw });
  });

  it.each([
    ["5h.reset", "1h12m", FULL.fiveHour?.resetsAt],
    ["week.reset", "2d3h", FULL.week?.resetsAt],
    ["banked.expires", "5d", FULL.banked?.nextExpiresAt],
    ["announced.next", "20h", FULL.announced?.next],
    ["announced.last", "0m", FULL.announced?.last],
  ])("renders the time variable %s", (variable, text, raw) => {
    const [segment] = segments(`{${variable}}`);

    expect(segment).toMatchObject({ variable, valueKind: "time", text, raw });
  });

  it.each([
    ["announced.kind", "announced"],
    ["name", "Claude"],
  ])("renders the text variable %s", (variable, text) => {
    const [segment] = segments(`{${variable}}`);

    expect(segment).toMatchObject({ variable, valueKind: "text", text, raw: text });
  });

  it("lists every registered variable in the tests above", () => {
    expect(Object.keys(VARIABLES)).toHaveLength(14);
    expect(isVariableName("5h.pct")).toBe(true);
    expect(isVariableName("5h")).toBe(false);
  });

  it("applies specs to number, time and text values", () => {
    expect(texts("{5h.pct:0>4.1}|{announced.p24:.1}|{name:>8}|{week.reset:iso}")).toEqual([
      "42.4".padStart(4, "0"),
      "|",
      "12.5",
      "|",
      "  Claude",
      "|",
      new Date(NOW + 2 * DAY + 3 * HOUR).toISOString().replace(".000Z", "Z"),
    ]);
  });

  it("renders the estimate kind as padded text", () => {
    const announced = { next: null, kind: "estimate" as const, last: null, p24: null, p48: null };

    expect(texts("{announced.kind:^10}", { ...FULL, announced })).toEqual([" estimate "]);
  });
});

describe("render edge cases", () => {
  it("renders 0% used as 0 used and 100 left", () => {
    const snapshot = { ...FULL, fiveHour: { usedPct: 0, resetsAt: NOW + HOUR } };

    expect(texts("{5h.pct}/{5h.left}", snapshot)).toEqual(["0", "/", "100"]);
  });

  it("renders 100% used as 100 used and 0 left", () => {
    const snapshot = { ...FULL, fiveHour: { usedPct: 100, resetsAt: NOW + HOUR } };

    expect(texts("{5h.pct}/{5h.left}", snapshot)).toEqual(["100", "/", "0"]);
  });

  it("clamps the remaining share of an out-of-range percentage", () => {
    const over = { ...FULL, week: { usedPct: 104, resetsAt: null } };
    const under = { ...FULL, week: { usedPct: -3, resetsAt: null } };

    expect(texts("{week.left}", over)).toEqual(["0"]);
    expect(texts("{week.left}", under)).toEqual(["100"]);
  });

  it("renders a reset in the past as 0m and keeps the raw timestamp", () => {
    const past = NOW - 2 * HOUR;
    const snapshot = { ...FULL, fiveHour: { usedPct: 10, resetsAt: past } };

    expect(segments("{5h.reset}", snapshot)).toMatchObject([{ text: "0m", raw: past }]);
  });

  it("renders a reset in the past in strftime and iso styles", () => {
    const past = Date.UTC(2020, 0, 2, 3, 4);
    const snapshot = { ...FULL, fiveHour: { usedPct: 10, resetsAt: past } };
    const originalTz = process.env.TZ;
    process.env.TZ = "Europe/Budapest";

    try {
      // 03:04 UTC in January is 04:04 in Budapest (CET, UTC+1).
      expect(texts("{5h.reset:%Y-%m-%d %H:%M}", snapshot)).toEqual(["2020-01-02 04:04"]);
      expect(texts("{5h.reset:iso}", snapshot)).toEqual(["2020-01-02T03:04:00Z"]);
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it("shows missingValue for every variable when the snapshot has no blocks", () => {
    const empty: QuotaSnapshot = { name: "Codex" };
    const names = Object.keys(VARIABLES).filter((name) => name !== "name");
    const format = names.map((name) => `{${name}}`).join(" ");

    const rendered = segments(format, empty);
    const variables = rendered.filter((segment) => segment.type === "variable");

    expect(variables).toHaveLength(names.length);
    for (const segment of variables) {
      expect(segment).toMatchObject({ text: MISSING, raw: null });
    }
  });

  it("shows missingValue for a null field inside a present block", () => {
    const snapshot: QuotaSnapshot = {
      name: "Codex",
      fiveHour: { usedPct: 30, resetsAt: null },
      banked: { count: 0, nextExpiresAt: null },
      announced: { next: null, kind: null, last: null, p24: null, p48: null },
    };

    expect(texts("{5h.pct} {5h.reset} {banked.count} {banked.expires} {announced.kind}", snapshot)).toEqual([
      "30", " ", MISSING, " ", "0", " ", MISSING, " ", MISSING,
    ]);
  });

  it("uses the configured missingValue and ignores the spec of a missing value", () => {
    const [segment] = segments("{5h.pct:0>5.2}", { name: "Claude" }, "n/a");

    expect(segment).toMatchObject({ text: "n/a", raw: null, valueKind: "number" });
  });

  it("allows an empty missingValue", () => {
    expect(segments("{week.reset}", { name: "Claude" }, "")).toMatchObject([{ text: "" }]);
  });

  it("treats non-finite numbers and unrepresentable times as missing", () => {
    const snapshot: QuotaSnapshot = {
      name: "Claude",
      fiveHour: { usedPct: Number.NaN, resetsAt: Number.POSITIVE_INFINITY },
      week: { usedPct: Number.POSITIVE_INFINITY, resetsAt: 9e15 },
    };

    expect(texts("{5h.pct} {5h.left} {5h.reset} {week.pct} {week.reset}", snapshot)).toEqual([
      MISSING, " ", MISSING, " ", MISSING, " ", MISSING, " ", MISSING,
    ]);
  });

  it("does not mutate the snapshot", () => {
    const frozen = structuredClone(FULL);

    segments("{5h.pct} {week.reset} {name}");

    expect(FULL).toEqual(frozen);
  });
});
