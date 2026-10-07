import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "message data outlives its sender and decodes into a separate runtime heap",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-message-"));
    try {
      const bin = join(dir, "messages");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-pthread",
        "-DSCR_WORKERS",
        "-DSCR_RC_AUDIT",
        "-fsanitize=address,undefined",
        "-Wno-deprecated-declarations",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_message.test.c"),
        join(import.meta.dirname, "scr_message.c"),
        ...EXECUTABLE_RUNTIME_SOURCES.map((name) => join(import.meta.dirname, name)),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], {
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe(
        "message graphs preserve identity, sparse values, byte aliases and getter order\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
