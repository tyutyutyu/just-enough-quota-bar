import { describe, expect, it } from "vitest";
import { parseBackground, parseColor } from "../../../src/thresholds/style";

describe("parseColor", () => {
  it.each([
    "charts.red",
    "errorForeground",
    "statusBarItem.warningBackground",
    "myExtension.my_color",
    "#a1B2c3",
  ])(
    "accepts %s",
    (color) => {
      expect(parseColor(color)).toEqual({ ok: true, spec: color });
    },
  );

  it.each(["", "#fff", "#12345g", "#1234567", "red color", ".red", "charts.", 7, null, undefined])(
    "rejects %j",
    (color) => {
      expect(parseColor(color)).toMatchObject({ ok: false });
    },
  );
});

describe("parseBackground", () => {
  it.each(["warning", "error"])("accepts %s", (background) => {
    expect(parseBackground(background)).toEqual({ ok: true, spec: background });
  });

  it.each(["info", "Error", "", 1, null])("rejects %j", (background) => {
    expect(parseBackground(background)).toMatchObject({ ok: false });
  });
});
