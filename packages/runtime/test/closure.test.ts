import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");

test("closure/box runtime: RC cascades clean under ASan + audit", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_closure");
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    "-o", bin,
    join(testDir, "test_closure.c"),
    join(srcDir, "scr_closure.c"),
    join(srcDir, "scr_string.c"),
    join(srcDir, "scr_array.c"),
    join(srcDir, "scr_map.c"),
    join(srcDir, "scr_number.c"),
    join(srcDir, "scr_cycle.c"),
    join(srcDir, "scr_bytes.c"),
    join(srcDir, "scr_error.c"),
    join(srcDir, "scr_exception.c"),
    join(srcDir, "scr_object.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
  const { stderr } = await execFileAsync(bin);
  expect(stderr.trim()).toBe("all closure tests passed");
});
