import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("promise events retain their roots and fiber stacks preserve suspended frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-fiber-stacks-"));
  try {
    const bin = join(dir, "fiber-stacks");
    await execFileAsync("clang", [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      "-Wno-deprecated-declarations",
      "-pthread",
      ...(sanitize ? ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"] : []),
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
      join(import.meta.dirname, "scr_async.test.c"),
      ...EXECUTABLE_RUNTIME_SOURCES.filter((name) => name !== "scr_async.c").map((name) =>
        join(import.meta.dirname, name),
      ),
      ...(process.platform === "linux" ? ["-lm"] : []),
      "-o",
      bin,
    ]);
    const result = await execFileAsync(bin);
    expect(result.stdout).toBe("fiber stacks stay lazy and preserve large suspended frames\n");
    expect(
      result.stderr.replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
        "",
      ),
    ).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
