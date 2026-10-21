import { describe, expect, it } from "vitest";
import { formatText, parseTextSpec } from "../../../src/format/textSpec";

function format(value: string, spec: string): string {
  const parsed = parseTextSpec(spec);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return formatText(value, parsed.spec);
}

describe("parseTextSpec", () => {
  it("defaults to a left-aligned text without width", () => {
    expect(parseTextSpec("")).toEqual({
      ok: true,
      spec: { pad: { fill: " ", align: "<", width: 0 } },
    });
  });

  it("parses fill, align and width", () => {
    expect(parseTextSpec("-^9")).toEqual({
      ok: true,
      spec: { pad: { fill: "-", align: "^", width: 9 } },
    });
  });

  it("rejects a precision", () => {
    const result = parseTextSpec("5.2");

    expect(!result.ok && result.message).toContain("text has no precision");
  });

  it.each(["rel", "x", "%a", "0"])("rejects %j", (spec) => {
    const result = parseTextSpec(spec);

    expect(!result.ok && result.message).toContain("expected [[fill]align][width] for text");
  });
});

describe("formatText", () => {
  it("leaves the text alone without a width", () => {
    expect(format("Claude", "")).toBe("Claude");
  });

  it("left-aligns by default", () => {
    expect(format("Codex", "8")).toBe("Codex   ");
  });

  it("supports every alignment and fill", () => {
    expect(format("ab", ">5")).toBe("   ab");
    expect(format("ab", "<5")).toBe("ab   ");
    expect(format("ab", ".^6")).toBe("..ab..");
    expect(format("abc", "-^6")).toBe("-abc--");
  });

  it("does not truncate text wider than the width", () => {
    expect(format("announced", "3")).toBe("announced");
  });

  it("counts characters, not UTF-16 units", () => {
    expect(format("😀", "3")).toBe("😀  ");
  });
});
