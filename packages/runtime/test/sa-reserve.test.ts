import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// Under a limited address space, as under valgrind, worker runtimes reserve
// fewer arenas, down to four, before smaller class slices.
test.runIf(process.platform === "linux" && process.arch === "x64")(
  "a limited address space reserves fewer arenas before smaller class slices",
  async () => {
    const buildDir = join(testDir, "build");
    await mkdir(buildDir, { recursive: true });
    const bin = join(buildDir, "test_sa_reserve");
    await execFileAsync("clang", [
      "-std=c11",
      "-D_GNU_SOURCE",
      "-O1",
      "-Wall",
      "-Wextra",
      "-fsanitize=undefined",
      "-DSCR_WORKERS",
      "-pthread",
      "-o",
      bin,
      join(testDir, "test_sa_reserve.c"),
      join(testDir, "../src/scr_alloc.c"),
    ]);
    const run = await execFileAsync(bin, [], {
      env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
    });
    expect(run.stdout).toBe("reservation checks passed\n");
  },
  120_000,
);
