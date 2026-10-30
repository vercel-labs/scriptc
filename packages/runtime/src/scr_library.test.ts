import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { executableSectionEliminationFlags } from "../../compiler/src/backend/native/driver.js";
import { LIB_RUNTIME_SOURCES } from "../../compiler/src/backend/native/runtime-inputs.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32").each([false, true])(
  "library integrity follows session and instance lifetime (threaded=%s)",
  async (threaded) => {
    const directory = await mkdtemp(join(tmpdir(), "scriptc-library-integrity-"));
    try {
      const binary = join(directory, "integrity");
      const sections = executableSectionEliminationFlags(process.platform);
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-pthread",
        "-Wno-deprecated-declarations",
        "-DSCR_LIB",
        "-DSCR_RC_AUDIT",
        "-fsanitize=address,undefined",
        ...sections.compile,
        ...(threaded ? ["-DSCR_THREAD_INSTANCES"] : []),
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        ...["scr_library.test.c", "scr_dyn_invoke.c", "scr_symbol.c", ...LIB_RUNTIME_SOURCES].map(
          (name) => join(import.meta.dirname, name),
        ),
        ...(process.platform === "linux" ? ["-lm"] : []),
        ...sections.link,
        "-o",
        binary,
      ]);
      const result = await exec(binary, [], {
        env: {
          ...process.env,
          // Keep the callback's dropped cycle for reset's final collection.
          SCR_CYCLE_THRESHOLD: "256",
          // Thread instances retain reusable caches through thread exit;
          // match library-multi's M8 LSan exception while keeping the RC audit.
          ASAN_OPTIONS:
            threaded && process.platform === "linux"
              ? "detect_leaks=0:halt_on_error=1"
              : "halt_on_error=1",
          UBSAN_OPTIONS: "halt_on_error=1",
        },
      });
      expect(result.stdout).toBe(
        "library integrity survives collection and resets with its instance\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
