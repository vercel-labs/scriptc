import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_sort");

// Compiled once with ASan and the SCR_SORT_TEST entry points: test_sort.c
// runs TimSort's gallops and merges on work arrays indexed past 2^32, and
// the sanitized run proves none of them reads or copies outside its buffer.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-DSCR_SORT_TEST",
    "-o",
    bin,
    join(testDir, "test_sort.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_arena.c"),
    // Checked-value collection equality shares the native JSON value runtime.
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_hash.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    join(testDir, "../src/scr_copying.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

test("comparator sort: gallops and merges at indices past 2^32", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// A gallop result outside its run is an internal error, never a copy.
test("an out-of-range gallop result traps", async () => {
  const err = await execFileAsync(bin, ["--crash-gallop-range"]).then(
    () => {
      throw new Error("expected --crash-gallop-range to abort");
    },
    (e: Error & { signal?: string; stderr?: string }) => e,
  );
  expect(err.signal).toBe("SIGABRT");
  expect(err.stderr).toContain("scriptc: internal error: sort gallop out of range");
});
