import { expect, test } from "vitest";
import {
  NATIVE_OPTIMIZATIONS,
  isNativeOptimization,
  optimizationClass,
  optimizationField,
  optimizationKeyParts,
} from "./optimization.js";

test("postures parse exactly and speed shares release's optimization class", () => {
  expect(NATIVE_OPTIMIZATIONS).toEqual(["release", "dev", "speed"]);
  for (const value of NATIVE_OPTIMIZATIONS) expect(isNativeOptimization(value)).toBe(true);
  for (const value of ["Release", "fast", "O2", "", undefined, null, 2])
    expect(isNativeOptimization(value)).toBe(false);
  expect(optimizationClass(undefined)).toBe("release");
  expect(optimizationClass("release")).toBe("release");
  expect(optimizationClass("speed")).toBe("release");
  expect(optimizationClass("dev")).toBe("dev");
});

test("release keeps historical key shapes while dev and speed are keyed apart", () => {
  expect(optimizationKeyParts(undefined)).toEqual([]);
  expect(optimizationKeyParts("release")).toEqual([]);
  expect(optimizationKeyParts("dev")).toEqual(["optimization-dev"]);
  expect(optimizationKeyParts("speed")).toEqual(["optimization-speed"]);
  expect(optimizationField("release")).toEqual({});
  expect(optimizationField(undefined)).toEqual({});
  expect(optimizationField("dev")).toEqual({ optimization: "dev" });
  expect(optimizationField("speed")).toEqual({ optimization: "speed" });
});
