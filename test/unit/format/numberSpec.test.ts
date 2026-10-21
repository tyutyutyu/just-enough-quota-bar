import { describe, expect, it } from "vitest";
import { formatNumber, parseNumberSpec, type NumberSpec } from "../../../src/format/numberSpec";
import { MAX_PRECISION, MAX_WIDTH } from "../../../src/format/pad";

function format(value: number, spec: string): string {
  const parsed = parseNumberSpec(spec);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return formatNumber(value, parsed.spec);
}

describe("parseNumberSpec", () => {
  it("defaults to a right-aligned integer without width", () => {
    expect(parseNumberSpec("")).toEqual({
      ok: true,
      spec: { pad: { fill: " ", align: ">", width: 0 }, precision: 0 },
    } satisfies { ok: true; spec: NumberSpec });
  });

  it("parses fill, align, width and precision together", () => {
    expect(parseNumberSpec("0>5.2")).toEqual({
      ok: true,
      spec: { pad: { fill: "0", align: ">", width: 5 }, precision: 2 },
    });
  });

  it("accepts an alignment character as the fill", () => {
    expect(parseNumberSpec(">>4")).toMatchObject({ ok: true, spec: { pad: { fill: ">", align: ">", width: 4 } } });
    expect(parseNumberSpec("<5")).toMatchObject({ ok: true, spec: { pad: { fill: " ", align: "<", width: 5 } } });
  });

  it("accepts a multi-byte fill character", () => {
    expect(parseNumberSpec("·^6")).toMatchObject({ ok: true, spec: { pad: { fill: "·", align: "^" } } });
  });

  it.each(["rel", "x", "3x", ".", "5.", "05", "0", "%d", "<<<5"])("rejects %j", (spec) => {
    const result = parseNumberSpec(spec);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("expected [[fill]align][width][.precision]");
  });

  it("rejects an excessive width and precision", () => {
    const wide = parseNumberSpec(`${MAX_WIDTH + 1}`);
    const precise = parseNumberSpec(`.${MAX_PRECISION + 1}`);

    expect(!wide.ok && wide.message).toContain("Width");
    expect(!precise.ok && precise.message).toContain("Precision");
  });

  it("accepts the maximum width and precision", () => {
    expect(parseNumberSpec(`${MAX_WIDTH}.${MAX_PRECISION}`).ok).toBe(true);
  });
});

describe("formatNumber", () => {
  it("rounds to an integer by default", () => {
    expect(format(42.4, "")).toBe("42");
    expect(format(42.5, "")).toBe("43");
  });

  it("formats the 0% and 100% boundaries", () => {
    expect(format(0, "")).toBe("0");
    expect(format(100, "")).toBe("100");
    expect(format(0, ".1")).toBe("0.0");
    expect(format(100, ".1")).toBe("100.0");
  });

  it("applies the precision", () => {
    expect(format(66.666, ".1")).toBe("66.7");
    expect(format(5, ".2")).toBe("5.00");
  });

  it("does not print a negative zero", () => {
    expect(format(-0.4, "")).toBe("0");
    expect(format(-0.04, ".1")).toBe("0.0");
    expect(format(-1.5, "")).toBe("-2");
  });

  it("right-aligns by default when a width is given", () => {
    expect(format(7, "3")).toBe("  7");
  });

  it("supports every alignment and fill", () => {
    expect(format(7, "<3")).toBe("7  ");
    expect(format(7, ">3")).toBe("  7");
    expect(format(7, "^4")).toBe(" 7  ");
    expect(format(7, "0>3")).toBe("007");
    expect(format(7, "*^5")).toBe("**7**");
  });

  it("does not truncate a value wider than the width", () => {
    expect(format(100, ">2")).toBe("100");
  });

  it("combines width and precision", () => {
    expect(format(3.14159, "8.3")).toBe("   3.142");
  });
});
