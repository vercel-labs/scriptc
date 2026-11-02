import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_string_spare");

// Builds the spare test without -DSCR_RC_AUDIT, which compiles the spares
// out. ASan covers the reused and freed blocks.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-DSCR_STR_TEST",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-o",
    bin,
    join(testDir, "test_string_spare.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_arena.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_closure.c"),
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
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
});

// A large released block is reused by the next allocation of about its
// size, and freed by an allocation the small spare satisfies instead of
// staying resident behind a run of small-block allocations.
test("a small-spare reuse frees the large spare", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr).toContain("string spare checks passed");
  expect(stderr).not.toContain("string spare test failed");
});

// The spares of a thread that ends are handed back by the runtime's exit
// cleanup; the test's own exit handler, registered first, runs after it and
// checks that nothing is left.
test("the exit cleanup frees the spares", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr).toContain("exit cleanup freed the spares");
  expect(stderr).not.toContain("string spare test failed");
});

// Cleanup is the thread's last drain. A string released after it runs is
// freed outright rather than parked behind a drain that never comes.
test("a release after the exit cleanup frees its block", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr).toContain("a release after the exit cleanup frees its block");
  expect(stderr).not.toContain("string spare test failed");
});
