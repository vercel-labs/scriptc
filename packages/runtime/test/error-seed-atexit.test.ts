import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");

// A caught assertion seeds the error view's first extra property, and the
// seed's exit cleanup must be registered once per thread rather than once
// per assertion (worker executables allocate an exit-list entry per
// registration). The fixture seeds a thousand times and reads the count.
test("the AssertionError seed registers one exit cleanup", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_error_seed_atexit");
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-o",
    bin,
    join(testDir, "test_error_seed_atexit.c"),
    join(srcDir, "scr_closure.c"),
    join(srcDir, "scr_string.c"),
    join(srcDir, "scr_array.c"),
    join(srcDir, "scr_arena.c"),
    join(srcDir, "scr_json.c"),
    join(srcDir, "scr_bigint.c"),
    join(srcDir, "scr_map.c"),
    join(srcDir, "scr_union.c"),
    join(srcDir, "scr_number.c"),
    join(srcDir, "scr_cycle.c"),
    join(srcDir, "scr_alloc.c"),
    join(srcDir, "scr_bytes.c"),
    join(srcDir, "scr_shared.c"),
    join(srcDir, "scr_lib.c"),
    join(srcDir, "scr_hash.c"),
    join(srcDir, "scr_console.c"),
    join(srcDir, "scr_path.c"),
    join(srcDir, "scr_url.c"),
    join(srcDir, "scr_url_params.c"),
    join(srcDir, "scr_error.c"),
    join(srcDir, "scr_exception.c"),
    join(srcDir, "scr_object.c"),
    join(srcDir, "scr_context.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
  const { stdout } = await execFileAsync(bin);
  expect(stdout.trim()).toBe("one registration");
});
