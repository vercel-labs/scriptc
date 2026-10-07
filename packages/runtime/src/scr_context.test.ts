import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "concurrent runtime contexts deliver native work and drain cleanup on their owner",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-context-"));
    try {
      const bin = join(dir, "contexts");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-Wno-deprecated-declarations",
        "-pthread",
        "-DSCR_WORKERS",
        "-DSCR_RC_AUDIT",
        "-fsanitize=address,undefined",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_context.test.c"),
        ...EXECUTABLE_RUNTIME_SOURCES.filter((name) => name !== "scr_async.c").map((name) =>
          join(import.meta.dirname, name),
        ),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], {
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe(
        "runtime contexts keep completions, timers, exceptions and cleanup isolated\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
