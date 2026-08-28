import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_map");

// Compiled once with ASan + the RC audit: test_map.c asserts SameValueZero
// exactness, RC accounting through set/overwrite/delete/clear/release,
// tombstone compaction bounds under churn, and live-iteration index
// stability — the sanitized run proves no leak/double-free across all of it.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    "-o", bin,
    join(testDir, "test_map.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_cycle.c"),
    // the _v RC adapters (scr_str_retain_v & co.) live with the unions,
    // which pull in the closure/array/box machinery
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

test("map runtime: SameValueZero, RC accounting, churn, live iteration", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});
