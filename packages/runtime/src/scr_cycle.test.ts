import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "SCR_CYC_MAX_TYPES shrinks the cycle-type registry and traps past its capacity",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cycle-"));
    try {
      const bin = join(dir, "cycle");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-Wno-deprecated-declarations",
        "-pthread",
        "-DSCR_CYC_MAX_TYPES=4",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_cycle.test.c"),
        ...EXECUTABLE_RUNTIME_SOURCES.map((name) => join(import.meta.dirname, name)),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);
      const failure = await exec(bin, []).then(
        () => null,
        (error: { stdout: string; stderr: string; signal: string | null }) => error,
      );
      expect(failure).not.toBeNull();
      expect(failure?.signal).toBe("SIGABRT");
      expect(failure?.stdout).toBe("registered 3 cycle types in a table of 4\n");
      expect(failure?.stderr).toContain("scriptc: too many cycle-collected types");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
