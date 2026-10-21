import { describe, expect, it } from "vitest";
import { parseFormat, type ParseResult } from "../../../src/format/parser";

function tokensOf(format: string) {
  const result = parseFormat(format);
  if (!result.ok) {
    throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
  }
  return result.tokens;
}

function errorsOf(format: string) {
  const result: ParseResult = parseFormat(format);
  if (result.ok) {
    throw new Error("expected errors");
  }
  return result.errors;
}

describe("parseFormat syntax", () => {
  it("returns no tokens for an empty format", () => {
    expect(tokensOf("")).toEqual([]);
  });

  it("keeps plain text as one literal", () => {
    expect(tokensOf("C 42% ·")).toEqual([{ type: "literal", text: "C 42% ·" }]);
  });

  it("parses a bare variable", () => {
    const [token] = tokensOf("{5h.pct}");

    expect(token).toMatchObject({ type: "field", variable: "5h.pct", kind: "number", position: 0 });
  });

  it("parses a variable with a spec", () => {
    const [token] = tokensOf("{5h.pct:>3}");

    expect(token).toMatchObject({
      kind: "number",
      spec: { pad: { fill: " ", align: ">", width: 3 }, precision: 0 },
    });
  });

  it("treats an empty spec as the default", () => {
    expect(tokensOf("{5h.pct:}")).toEqual(tokensOf("{5h.pct}"));
  });

  it("splits the spec at the first colon only", () => {
    const [token] = tokensOf("{week.reset:%a %H:%M}");

    expect(token).toMatchObject({ kind: "time", spec: { style: "strftime" } });
  });

  it("interleaves literals and fields in order and records positions", () => {
    const tokens = tokensOf("C {5h.pct}% · {name}");

    expect(tokens.map((token) => token.type)).toEqual(["literal", "field", "literal", "field"]);
    expect(tokens[1]).toMatchObject({ variable: "5h.pct", position: 2 });
    expect(tokens[3]).toMatchObject({ variable: "name", kind: "text", position: 14 });
  });

  it("turns doubled braces into literal braces merged with the surrounding text", () => {
    expect(tokensOf("a{{b}}c")).toEqual([{ type: "literal", text: "a{b}c" }]);
  });

  it("keeps escaped braces next to a field", () => {
    expect(tokensOf("{{{name}}}")).toMatchObject([
      { type: "literal", text: "{" },
      { type: "field", variable: "name" },
      { type: "literal", text: "}" },
    ]);
  });

  it("leaves $(codicon) text unchanged", () => {
    expect(tokensOf("$(sync~spin) {5h.pct}% $(warning)")).toMatchObject([
      { type: "literal", text: "$(sync~spin) " },
      { type: "field" },
      { type: "literal", text: "% $(warning)" },
    ]);
  });

  it("resolves every registered variable name", () => {
    const names = [
      "5h.pct", "5h.left", "5h.reset", "week.pct", "week.left", "week.reset",
      "banked.count", "banked.expires", "announced.next", "announced.kind",
      "announced.last", "announced.p24", "announced.p48", "name",
    ];

    const parsed = names.map((name) => tokensOf(`{${name}}`)[0]);

    expect(parsed.map((token) => token?.type === "field" && token.variable)).toEqual(names);
  });
});

describe("parseFormat errors", () => {
  it("reports an unknown variable with its position", () => {
    expect(errorsOf("ab {nope}")).toEqual([{ position: 4, message: 'Unknown variable "nope"' }]);
  });

  it("does not resolve inherited object keys as variables", () => {
    expect(errorsOf("{constructor}")[0]?.message).toBe('Unknown variable "constructor"');
    expect(errorsOf("{__proto__}")[0]?.message).toBe('Unknown variable "__proto__"');
  });

  it("reports a missing variable name", () => {
    expect(errorsOf("{}")).toEqual([{ position: 1, message: "Missing variable name" }]);
    expect(errorsOf("{:>3}")).toEqual([{ position: 1, message: "Missing variable name" }]);
  });

  it("reports a spec that does not fit a number variable", () => {
    const [error] = errorsOf("{5h.pct:rel}");

    expect(error?.position).toBe(8);
    expect(error?.message).toContain('Invalid format spec "rel"');
    expect(error?.message).toContain('variable "5h.pct" is number');
  });

  it("reports a spec that does not fit a time variable", () => {
    const [error] = errorsOf("x {5h.reset:>3}");

    expect(error?.position).toBe(12);
    expect(error?.message).toContain('Invalid format spec ">3"');
    expect(error?.message).toContain('variable "5h.reset" is time');
  });

  it("reports a spec that does not fit a text variable", () => {
    const [error] = errorsOf("{name:rel}");

    expect(error?.message).toContain('Invalid format spec "rel"');
    expect(error?.message).toContain('variable "name" is text');
  });

  it("reports an unsupported strftime directive", () => {
    expect(errorsOf("{week.reset:%Z}")[0]?.message).toContain('Unsupported time directive "%Z"');
  });

  it("reports an unclosed brace at its position", () => {
    expect(errorsOf("ab {5h.pct")).toEqual([
      { position: 3, message: 'Unclosed "{"; use "{{" for a literal brace' },
    ]);
  });

  it("reports a single closing brace", () => {
    expect(errorsOf("a}b")).toEqual([
      { position: 1, message: 'Single "}" is not allowed; use "}}" for a literal brace' },
    ]);
  });

  it("reports a nested opening brace and resumes parsing there", () => {
    expect(errorsOf("{5h.pct:{name}")).toEqual([
      { position: 8, message: 'Unexpected "{" inside a field; nested fields are not supported' },
    ]);
  });

  it("collects every problem instead of stopping at the first", () => {
    const errors = errorsOf("{a} {5h.pct:rel} } {name");

    expect(errors.map((error) => error.position)).toEqual([1, 12, 17, 19]);
  });

  it("never throws, whatever the input", () => {
    for (const format of ["{", "}", "{{{", "}}}", "{:", "{a:", "{5h.pct:%", "\u0000{", "{\u{1F600}}"]) {
      expect(() => parseFormat(format)).not.toThrow();
    }
  });
});
