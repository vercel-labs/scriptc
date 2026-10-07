import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "mailboxes coalesce concurrent wakeups and release closed destinations safely",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-mailbox-"));
    try {
      const bin = join(dir, "mailboxes");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-pthread",
        "-DSCR_WORKERS",
        "-DSCR_RC_AUDIT",
        "-fsanitize=address,undefined",
        "-Wno-deprecated-declarations",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_mailbox.test.c"),
        join(import.meta.dirname, "scr_mailbox.c"),
        join(import.meta.dirname, "scr_message.c"),
        ...EXECUTABLE_RUNTIME_SOURCES.map((name) => join(import.meta.dirname, name)),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], {
        timeout: 15000,
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe(
        "mailboxes preserve concurrent FIFO delivery, wakeups and close ownership\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
