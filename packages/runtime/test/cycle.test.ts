import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

test("scheduled collection eventually visits sparse mature roots", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_cycle");
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address,undefined",
    "-o", bin,
    join(testDir, "test_cycle.c"),
    join(testDir, "../src/scr_cycle.c"),
  ]);
  const baseEnv = {
    ...process.env,
    ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
    UBSAN_OPTIONS: "halt_on_error=1",
  };
  delete baseEnv.SCR_CYCLE_THRESHOLD;

  for (const [configured, expected] of [
    [undefined, "256"],
    ["1", "1"],
    ["2", "2"],
    ["7", "7"],
  ] as const) {
    const env = { ...baseEnv };
    if (configured !== undefined) env.SCR_CYCLE_THRESHOLD = configured;
    const run = await execFileAsync(bin, [], { env });
    expect(run.stdout).toBe(
      `scheduled mature cycles collected: 129 threshold=${expected}\n`,
    );
  }
});
