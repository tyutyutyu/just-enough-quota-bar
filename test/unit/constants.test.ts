import { describe, expect, it } from "vitest";
import { COMMAND_REFRESH, PREFIX, qualify } from "../../src/constants";

describe("qualify", () => {
  it("prefixes the name with the extension namespace", () => {
    expect(qualify("refresh")).toBe(`${PREFIX}.refresh`);
  });

  it("trims surrounding whitespace", () => {
    expect(qualify("  refresh ")).toBe("jeqb.refresh");
  });

  it("rejects an empty name", () => {
    expect(() => qualify("  ")).toThrow("name must not be empty");
  });
});

describe("COMMAND_REFRESH", () => {
  it("uses the jeqb prefix", () => {
    expect(COMMAND_REFRESH).toBe("jeqb.refresh");
  });
});
