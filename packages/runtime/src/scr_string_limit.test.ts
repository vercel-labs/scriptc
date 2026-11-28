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

/* Every string-growth path checked against Node's maximum string length,
 * forced small (-DSCR_STR_MAX_UNITS=64) so the limits are crossed with a few
 * bytes: concat and its parts/mixed/move forms, the JSON builder, repeat,
 * padStart/padEnd and replace all throw Node's catchable RangeError "Invalid
 * string length" and return the empty string, and none traps. The builders
 * that would fit keep their bytes. */
test.skipIf(process.platform !== "linux" || process.arch !== "x64" || !hasZig())(
  "a string past Node's maximum length throws its RangeError, never a trap",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-string-limit-"));
    try {
      const bin = join(dir, "string-limit");
      await exec("zig", [
        "cc",
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-D_GNU_SOURCE",
        "-DSCR_STR_MAX_UNITS=64",
        ...[
          join(runtime, "scr_string_limit.test.c"),
          ...EXECUTABLE_RUNTIME_SOURCES.map((source) => join(runtime, source)),
        ],
        "-lm",
        "-lunwind",
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], { timeout: 120000 });
      expect(result.stdout).not.toContain("FAILED");
      expect(result.stdout.endsWith("string limit checks passed\n")).toBe(true);
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  300000,
);
