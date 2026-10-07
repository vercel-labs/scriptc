import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "native workers own their data and finish all message exchanges before exit",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-workers-"));
    try {
      const bin = join(dir, "workers");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-pthread",
        "-DSCR_WORKERS",
        "-DSCR_RC_AUDIT",
        "-fsanitize=address,undefined",
        "-Wno-deprecated-declarations",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        ...[
          "scr_worker.test.c",
          "scr_worker.c",
          "scr_mailbox.c",
          "scr_message.c",
          ...EXECUTABLE_RUNTIME_SOURCES,
        ].map((name) => join(import.meta.dirname, name)),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], {
        timeout: 10000,
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe(
        "worker threads isolate heaps, exchange messages and publish ordered exits\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
