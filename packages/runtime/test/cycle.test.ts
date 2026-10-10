import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

test("cycle traversal preserves counts, deep graphs, configured thresholds and growth caps", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_cycle");
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address,undefined",
    "-o",
    bin,
    join(testDir, "test_cycle.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
  ]);
  const baseEnv = {
    ...process.env,
    ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
    UBSAN_OPTIONS: "halt_on_error=1",
  };
  delete baseEnv.SCR_CYCLE_THRESHOLD;
  delete baseEnv.SCR_CYCLE_GROWTH_CAP;

  for (const [threshold, cap, expected] of [
    [undefined, undefined, "threshold=256 growth_cap=16"],
    ["1", undefined, "threshold=1 growth_cap=16"],
    ["2", undefined, "threshold=2 growth_cap=16"],
    ["7", undefined, "threshold=7 growth_cap=16"],
    [undefined, "1", "threshold=256 growth_cap=1"],
    ["1", "1", "threshold=1 growth_cap=1"],
    [undefined, "3", "threshold=256 growth_cap=2"],
    [undefined, "64", "threshold=256 growth_cap=16"],
  ] as const) {
    const env = { ...baseEnv };
    if (threshold !== undefined) env.SCR_CYCLE_THRESHOLD = threshold;
    if (cap !== undefined) env.SCR_CYCLE_GROWTH_CAP = cap;
    const run = await execFileAsync(bin, [], { env });
    expect(run.stdout).toBe(`cycle collection checks passed: ${expected}\n`);
  }
});
