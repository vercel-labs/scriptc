import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

// The size-class allocator is compiled out under AddressSanitizer, so the
// UBSan-only build is the one that exercises it; the ASan build pins the
// system-allocator bypass the sanitizer lane relies on.
test.each([
  ["size-class", ["-fsanitize=undefined"]],
  ["system", ["-fsanitize=address,undefined"]],
])("small-object allocator contracts hold (%s)", async (mode, sanitize) => {
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-alloc-"));
  try {
    const binary = join(scratch, "alloc");
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      ...sanitize,
      join(import.meta.dirname, "scr_alloc.test.c"),
      join(import.meta.dirname, "scr_alloc.c"),
      "-o",
      binary,
    ]);
    const result = await exec(binary, [], {
      env: {
        ...process.env,
        ASAN_OPTIONS: "halt_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1",
      },
    });
    expect(result.stdout).toBe(`allocator checks passed: ${mode}\n`);
    expect(result.stderr).toBe("");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
