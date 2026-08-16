import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");

const RUNTIME_SOURCES = ["scr_number.c", "scr_string.c", "scr_array.c", "scr_bytes.c", "scr_map.c", "scr_closure.c", "scr_ffi.c", "scr_object.c", "scr_union.c", "scr_exception.c", "scr_error.c", "scr_console.c", "scr_lib.c", "scr_json.c", "scr_async.c", "scr_child.c", "scr_cycle.c"].map(
  (f) => join(srcDir, f),
);

// Full runtime smoke under ASan + the RC audit: proves the API works and the
// hand-modeled ownership discipline (the same one emit-c.ts generates) is
// leak- and double-free-clean.
test("runtime smoke.c: output exact, ASan and RC audit clean", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "smoke");
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-o", bin,
    join(testDir, "smoke.c"),
    ...RUNTIME_SOURCES,
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
  const { stdout } = await execFileAsync(bin);
  expect(stdout).toBe(
    "hello world\n" +
      "n = 0.30000000000000004 flag = true\n" +
      "hellohello 10\n" +
      "true\n",
  );
});
