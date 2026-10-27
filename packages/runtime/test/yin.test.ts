import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// The young-in nursery variant of the collector (SCR_YIN), with the RC
// audit's membership and count checks, at nursery sizes from one object
// (a collection at every allocation) to the default.
test("young-in nursery collects young cycles at every nursery size", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_yin");
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address,undefined",
    "-DSCR_CYC_TESTING",
    "-DSCR_YIN",
    "-DSCR_RC_AUDIT",
    "-o",
    bin,
    join(testDir, "test_yin.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
  ]);
  const baseEnv = {
    ...process.env,
    ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
    UBSAN_OPTIONS: "halt_on_error=1",
  };
  delete baseEnv.SCR_YOUNG_NURSERY_SIZE;
  delete baseEnv.SCR_CYCLE_THRESHOLD;
  for (const [size, threshold] of [
    [undefined, undefined],
    ["1", undefined],
    ["2", undefined],
    ["7", undefined],
    ["64", "1"],
    ["1", "1"],
  ] as const) {
    const env = { ...baseEnv };
    if (size !== undefined) env.SCR_YOUNG_NURSERY_SIZE = size;
    if (threshold !== undefined) env.SCR_CYCLE_THRESHOLD = threshold;
    const run = await execFileAsync(bin, [], { env });
    expect(run.stdout).toBe(`young nursery checks passed: size=${size ?? "default"}\n`);
  }
});

// Trial deletion is unchanged in the young-nursery build: the whole cycle
// suite passes against it (it allocates no young objects).
test("trial deletion checks pass against the young-nursery collector", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_cycle_yin");
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address,undefined",
    "-DSCR_CYC_TESTING",
    "-DSCR_YIN",
    "-o",
    bin,
    join(testDir, "test_cycle.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
  ]);
  const env = { ...process.env, ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1" };
  delete env.SCR_CYCLE_THRESHOLD;
  delete env.SCR_CYCLE_GROWTH_CAP;
  const run = await execFileAsync(bin, [], { env });
  expect(run.stdout).toBe("cycle collection checks passed: threshold=256 growth_cap=16\n");
});
