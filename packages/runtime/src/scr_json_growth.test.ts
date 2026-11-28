import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);
const runtime = fileURLToPath(new URL(".", import.meta.url));

function hasZig(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* The JSON builder's growth policy (doubling below the policy bound, fixed
 * steps above it) and a string's escape from the allocator window. Forced
 * small: a one-chunk window (4 MiB) and a 4 KiB policy bound, so a few
 * megabytes cross both. A program that requires the window
 * (scr_sa_require_window, a compact-reference program) still builds a
 * string past it — a string is never a 32-bit reference field's target —
 * with its block outside the window and every byte kept. Before the fix the
 * allocation ended the process at the window limit. */
test.skipIf(process.platform !== "linux" || process.arch !== "x64" || !hasZig())(
  "the JSON builder grows in doubling then fixed steps, and a string leaves a full window",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-json-growth-"));
    try {
      const bin = join(dir, "json-growth");
      await exec("zig", [
        "cc",
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-D_GNU_SOURCE",
        "-DSCR_SA_WINDOW_TEST_CHUNKS=1",
        "-DSCR_JB_GEOMETRIC_MAX=4096",
        "-DSCR_JB_STEP=4096",
        ...[
          join(runtime, "scr_json_growth.test.c"),
          ...EXECUTABLE_RUNTIME_SOURCES.map((source) => join(runtime, source)),
        ],
        "-lm",
        "-lunwind",
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], { timeout: 120000 });
      expect(result.stdout).not.toContain("FAILED");
      expect(result.stdout.endsWith("json growth checks passed\n")).toBe(true);
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  300000,
);
