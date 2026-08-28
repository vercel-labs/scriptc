import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_array");

// Compiled once with ASan + the RC audit: the assertions in test_array.c
// include recursive-release checks (array of strings, array of arrays), and
// the sanitized run proves no leak/double-free across all of them.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    "-o", bin,
    join(testDir, "test_array.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

test("array runtime: push/pop/set/get, RC recursion, growth", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// JS returns undefined for OOB reads and creates holes for far writes; both
// are unrepresentable, so the runtime must trap (documented divergence).
test.each([
  ["--crash-get-oob", "array index 1 out of bounds (length 1)"],
  ["--crash-get-frac", "array index 0.5 out of bounds (length 1)"],
  ["--crash-set-oob", "array index 2 out of bounds (length 1)"],
  ["--crash-pop-empty", "pop() on an empty array"],
])("trap aborts (%s)", async (mode, message) => {
  const err = await execFileAsync(bin, [mode]).then(
    () => {
      throw new Error(`expected ${mode} to abort`);
    },
    (e: Error & { signal?: string; stderr?: string }) => e,
  );
  expect(err.signal).toBe("SIGABRT");
  expect(err.stderr).toContain(`scriptc: RangeError: ${message}`);
});
