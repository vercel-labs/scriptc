import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

/* The Linux poller links alone (it needs only libc), under AddressSanitizer
 * and UndefinedBehaviorSanitizer. */
test.skipIf(process.platform !== "linux")(
  "the epoll poller's timer heap fires each armed key once, in deadline order",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-epoll-"));
    try {
      const bin = join(dir, "epoll");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-g",
        "-fsanitize=address,undefined",
        join(import.meta.dirname, "scr_loop_epoll.test.c"),
        join(import.meta.dirname, "scr_loop_epoll.c"),
        "-lm",
        "-o",
        bin,
      ]);
      const result = await exec(bin, [], {
        timeout: 60000,
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe(
        "epoll timers fire once each, in deadline order, never when cancelled\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
