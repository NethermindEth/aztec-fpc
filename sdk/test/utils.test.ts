import { describe, expect, it } from "vitest";

import { parseJsonArray, parsePositiveInt, sameAddress } from "../src/utils";

describe("utils", () => {
  it("parses positive integers", () => {
    expect(parsePositiveInt("x", "1")).toBe(1);
    expect(parsePositiveInt("x", "1000000")).toBe(1_000_000);
  });

  it("rejects invalid positive integers", () => {
    expect(() => parsePositiveInt("x", "0")).toThrow();
    expect(() => parsePositiveInt("x", "-1")).toThrow();
    expect(() => parsePositiveInt("x", "1.1")).toThrow();
  });

  it("parses json arrays", () => {
    expect(parseJsonArray("ARR", '["a",1,true]')).toEqual(["a", 1, true]);
  });

  it("rejects non-array json", () => {
    expect(() => parseJsonArray("ARR", '{"a":1}')).toThrow();
    expect(() => parseJsonArray("ARR", "bad-json")).toThrow();
  });

  it("compares addresses case-insensitively", () => {
    expect(sameAddress({ toString: () => "0xAbcDEF" }, { toString: () => "0xabcdef" })).toBe(true);
  });
});
