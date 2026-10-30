import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

/* The rc word helpers are inline in scr_rc.h, so the test links alone. */
test.skipIf(process.platform === "win32")(
  "the rc word keeps the count, the lifetime and frozen bits and the layout id apart",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-rc-"));
    try {
      const bin = join(dir, "rc");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-g",
        "-fsanitize=address,undefined",
        join(import.meta.dirname, "scr_rc.test.c"),
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], {
        timeout: 60000,
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe("rc word encodings\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
