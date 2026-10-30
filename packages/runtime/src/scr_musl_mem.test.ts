import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

/* The x86_64 musl lane's memory and string routines are header functions,
 * so the test compiles them with the host's clang on any x86_64 Linux host:
 * optimized, and with AddressSanitizer and UndefinedBehaviorSanitizer. */
const lanes = [
  { name: "optimized", flags: ["-O2"] },
  { name: "sanitized", flags: ["-O1", "-g", "-fsanitize=address,undefined"] },
];

for (const lane of lanes)
  test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    `musl lane memset, memcpy, memmove, memcmp and strlen match byte loops (${lane.name})`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-musl-mem-"));
      try {
        const bin = join(dir, "musl-mem");
        await exec("clang", [
          "-std=c11",
          "-D_GNU_SOURCE",
          "-Wall",
          "-Wextra",
          "-Werror",
          ...lane.flags,
          join(import.meta.dirname, "scr_musl_mem.test.c"),
          "-o",
          bin,
        ]);
        const result = await exec(bin, [], {
          timeout: 120000,
          env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
        });
        expect(result.stdout).toBe("ok\n");
        expect(result.stderr).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
