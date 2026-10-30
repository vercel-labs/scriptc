import { describe, expect, test } from "vitest";
import { isValidRange, satisfies } from "./semver.js";

describe("satisfies", () => {
  test.each([
    ["15.0.0", "^15.0.0", true],
    ["15.4.2", "^15.0.0", true],
    ["16.0.0", "^15.0.0", false],
    ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.9.0", "~1", true],
    ["2.1.3", "2.1.x", true],
    ["2.2.0", "2.1.x", false],
    ["2.1.3", "2", true],
    ["3.0.0", "2", false],
    ["2.1.3", "*", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "=1.2.3", false],
    ["1.5.0", ">=1.2.0 <2.0.0", true],
    ["2.0.0", ">=1.2.0 <2.0.0", false],
    ["2.0.0", ">= 1.2.0", true],
    ["1.3.0", ">1.2", true],
    ["1.2.9", ">1.2", false],
    ["1.2.9", "<=1.2", true],
    ["1.3.0", "<=1.2", false],
    ["2.3.9", "1.2.3 - 2.3", true],
    ["2.4.0", "1.2.3 - 2.3", false],
    ["3.1.0", "^1.0.0 || ^3.0.0", true],
    ["2.1.0", "^1.0.0 || ^3.0.0", false],
    ["2.0.0-beta.1", "^1.0.0", false],
    ["2.0.0-beta.1", "^2.0.0", false],
    ["2.0.0-beta.2", "^2.0.0-beta.1", true],
    ["2.0.0-alpha", "^2.0.0-beta.1", false],
    ["2.1.0-beta.2", "^2.0.0-beta.1", false],
  ])("%s satisfies %s: %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test("malformed input never satisfies", () => {
    expect(satisfies("not-a-version", "^1.0.0")).toBe(false);
    expect(isValidRange("^banana")).toBe(false);
    expect(isValidRange(">=1 <2 || 3.x")).toBe(true);
  });
});
