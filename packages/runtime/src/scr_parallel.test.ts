import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

/* The parallel-loop unit links alone (the test supplies the exception cell,
 * the trap and the element sizes), so it runs under ThreadSanitizer as well
 * as AddressSanitizer: the pool's publishing handshake is what the race
 * detector has to agree is ordered. */
const lanes = [
  { name: "address", flags: ["-fsanitize=address,undefined"], run: process.platform !== "win32" },
  { name: "thread", flags: ["-fsanitize=thread"], run: process.platform === "linux" },
];

/* One helper thread, and a full pool: the chunks must come out the same. */
const pools = ["1", "8"];

for (const lane of lanes)
  for (const threads of pools)
    test.skipIf(!lane.run)(
      `parallel loops run their chunks once on ${threads} thread${threads === "1" ? "" : "s"} (${lane.name})`,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "scriptc-parallel-"));
        try {
          const bin = join(dir, "parallel");
          await exec("clang", [
            "-std=c11",
            "-O1",
            "-g",
            "-pthread",
            "-DSCR_WORKERS",
            ...lane.flags,
            ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
            join(import.meta.dirname, "scr_parallel.test.c"),
            join(import.meta.dirname, "scr_parallel.c"),
            "-o",
            bin,
          ]);
          const result = await exec(bin, [], {
            timeout: 60000,
            env: {
              ...process.env,
              SCRIPTC_THREADS: threads,
              UBSAN_OPTIONS: "halt_on_error=1",
              TSAN_OPTIONS: "halt_on_error=1",
            },
          });
          expect(result.stdout).toBe(
            "parallel loops run every chunk once, in order, on any pool\n",
          );
          expect(result.stderr).toBe("");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
