import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

function hasZig(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const runtime = fileURLToPath(new URL(".", import.meta.url));

/* A linux-x64 musl build of the runtime (zig cc, as the musl pack uses)
 * has no malloc_usable_size: scr_mem_block_size answers 0 for the system
 * allocator's blocks, so growing one must go through libc realloc. The
 * window is one chunk, which the check's blocks and the JSON buffer's
 * growth leave. */
test.skipIf(process.platform !== "linux" || process.arch !== "x64" || !hasZig())(
  "strings grown past the window keep their bytes in the musl lane",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-json-grow-"));
    try {
      const bin = join(dir, "json-grow");
      await exec("zig", [
        "cc",
        "-target",
        "x86_64-linux-musl",
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-D_GNU_SOURCE",
        "-DSCR_MUSL",
        "-DSCR_SA_WINDOW_TEST_CHUNKS=1",
        ...["scr_json_grow.test.c", ...EXECUTABLE_RUNTIME_SOURCES, "scr_musl.c"].map((source) =>
          join(runtime, source),
        ),
        "-lm",
        "-lunwind",
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], { timeout: 120000 });
      expect(result.stdout).toBe(
        [
          "block source: system",
          "grown block kept: yes",
          "json output: 10485760 bytes, intact",
          "",
        ].join("\n"),
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  300000,
);
