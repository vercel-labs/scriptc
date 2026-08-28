import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// Compiles and runs the C-side oracle test against the committed case file
// (generated once from Node via gen-number-cases.mjs — see that file to
// regenerate or fuzz).
test("scr_f64_to_str matches Node String(x) on committed oracle cases", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_number");
  await execFileAsync("clang", [
    "-std=c11", "-O2", "-Wall", "-Wextra",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-o", bin,
    join(testDir, "test_number.c"),
    join(testDir, "../src/scr_number.c"),
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
  const { stderr } = await execFileAsync(bin, [join(testDir, "number-cases.txt")]);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});
