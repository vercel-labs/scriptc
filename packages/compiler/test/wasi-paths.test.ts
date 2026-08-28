import { expect, test } from "vitest";
import { wasiGuestPath } from "../src/wasi-paths.js";

test("WASI guest paths follow the cwd and temp preopens", () => {
  expect(wasiGuestPath("/work/repo/tests/main.cjs", "/work/repo", "/host/tmp", "posix"))
    .toBe("/tests/main.cjs");
  expect(wasiGuestPath("/host/tmp/build/main.cjs", "/work/repo", "/host/tmp", "posix"))
    .toBe("/tmp/build/main.cjs");
  expect(wasiGuestPath("/opt/source/main.cjs", "/work/repo", "/host/tmp", "posix"))
    .toBeNull();
});

test("WASI guest paths normalize Windows host separators", () => {
  expect(wasiGuestPath(
    "C:\\work\\repo\\tests\\main.cjs",
    "C:\\work\\repo",
    "C:\\Users\\runner\\Temp",
    "win32",
  )).toBe("/tests/main.cjs");
  expect(wasiGuestPath(
    "C:\\Users\\runner\\Temp\\build\\main.cjs",
    "C:\\work\\repo",
    "C:\\Users\\runner\\Temp",
    "win32",
  )).toBe("/tmp/build/main.cjs");
});
