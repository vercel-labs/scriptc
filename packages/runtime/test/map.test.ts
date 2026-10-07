import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_map");

// Compiled with ASan + the RC audit: test_map.c asserts SameValueZero
// exactness, RC accounting through set/overwrite/delete/clear/release,
// tombstone compaction bounds under churn, and live-iteration index
// stability — the sanitized run proves no leak/double-free across all of it.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  const args = [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-DSCR_RC_AUDIT",
    "-o",
    bin,
    join(testDir, "test_map.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_cycle.c"),
    // the _v RC adapters (scr_str_retain_v & co.) live with the unions,
    // which pull in the closure/array/box machinery
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_array.c"),
    // Checked-value collection equality shares the native JSON value runtime.
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ];
  await execFileAsync("clang", args);
  // Exercise the wide-table transition without allocating millions of entries.
  const wide = args.map((arg) => (arg === bin ? bin + "-wide" : arg));
  await execFileAsync("clang", [...wide, "-DSCR_MAP_COMPACT_BUCKETS=32"]);
});

test("map runtime: SameValueZero, RC accounting, churn, live iteration", async () => {
  for (const path of [bin, bin + "-wide"]) {
    const { stderr } = await execFileAsync(path, []);
    expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
  }
});
