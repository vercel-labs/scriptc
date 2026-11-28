import { expect, test } from "vitest";
import { parseUnitsMode, unitsModeRefusal } from "./mode.js";

test("only observe and split parse as modes", () => {
  expect(parseUnitsMode("observe")).toBe("observe");
  expect(parseUnitsMode("split")).toBe("split");
  expect(parseUnitsMode("")).toBeNull();
  expect(parseUnitsMode("something")).toBeNull();
  expect(parseUnitsMode(undefined)).toBeNull();
});

test("a mode is refused in a release build and split is refused everywhere", () => {
  const env = (value: string): NodeJS.ProcessEnv => ({ SCRIPTC_UNITS: value });
  expect(unitsModeRefusal("dev", env("observe"))).toBeNull();
  expect(unitsModeRefusal("speed", env("observe"))).toBeNull();
  expect(unitsModeRefusal(undefined, env("observe"))?.message).toContain("development-build");
  expect(unitsModeRefusal("release", env("observe"))?.message).toContain("development-build");
  expect(unitsModeRefusal("dev", env("split"))?.message).toContain("not implemented");
  expect(unitsModeRefusal("dev", env("bogus"))?.message).toContain("not a mode");
  expect(unitsModeRefusal("release", env("bogus"))?.message).toContain("not a mode");
  expect(unitsModeRefusal("dev", {})).toBeNull();
});
