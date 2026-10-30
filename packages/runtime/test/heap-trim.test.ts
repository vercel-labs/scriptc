import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// scr_heap_trim returns the size-class pages that hold only free blocks, in
// the single-threaded allocator and in the per-thread arenas of worker
// runtimes while another thread allocates.
test.runIf(process.platform === "linux")(
  "heap trim returns free pages and keeps live blocks",
  async () => {
    const buildDir = join(testDir, "build");
    await mkdir(buildDir, { recursive: true });
    for (const [name, flags] of [
      ["test_heap_trim", []],
      ["test_heap_trim_workers", ["-DSCR_WORKERS", "-pthread"]],
    ] as const) {
      const bin = join(buildDir, name);
      await execFileAsync("clang", [
        "-std=c11",
        "-D_GNU_SOURCE",
        "-O1",
        "-Wall",
        "-Wextra",
        "-fsanitize=undefined",
        ...flags,
        "-o",
        bin,
        join(testDir, "test_heap_trim.c"),
        join(testDir, "../src/scr_alloc.c"),
      ]);
      const run = await execFileAsync(bin, [], {
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(run.stdout).toBe("heap trim checks passed\n");
    }
  },
  120_000,
);
