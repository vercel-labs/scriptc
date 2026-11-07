import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

/* The whole C unit's stdout, in order. The corpus cannot observe when the
 * heap frees a target, so the clearing itself is pinned here: the kept
 * list's end-of-job clear, the dispose hook a freed dyn node and a freed
 * native record reach, and the collector pass that flushes a parked
 * capsule. */
const STDOUT = [
  "ok the constructor answers a WeakRef handle",
  "ok a plain object is not a WeakRef",
  "ok deref answers the target while the heap keeps it",
  "ok deref answers undefined once the target is freed",
  "ok deref rebuilds the capsule, not a snapshot",
  "ok the rebuilt capsule unboxes to the same record",
  "ok deref answers undefined once the record is freed",
  "ok the capsule is gone and the record is not",
  "ok deref builds a capsule over the living record",
  "ok the new capsule has the target's class binding",
  "ok and unboxes to the same record",
  "ok deref answers undefined once that record is freed",
  "ok cleared cells leave the table",
  "ok a fresh object is not a WeakRef",
];

// scr_weakref.c is an optional runtime unit, so the executable lane's source
// list does not carry it; the unit's own test adds it and its feature macro.
describe.skipIf(process.platform === "win32")("WeakRef", () => {
  const build = async (dir: string, name: string, flags: string[]): Promise<string> => {
    const bin = join(dir, name);
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-pthread",
      "-Wno-deprecated-declarations",
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
      ...flags,
      ...[
        "scr_weakref.test.c",
        "scr_weakref.c",
        // The registry check the WeakRef unit calls, and the unit that
        // unit's equality message assemblers live in.
        "scr_symbol.c",
        "scr_assert.c",
        ...EXECUTABLE_RUNTIME_SOURCES,
      ].map((source) => join(import.meta.dirname, source)),
      ...(process.platform === "linux" ? ["-lm"] : []),
      "-o",
      bin,
    ]);
    return bin;
  };
  const run = (bin: string) =>
    exec(bin, {
      timeout: 60000,
      env: {
        ...process.env,
        ASAN_OPTIONS: "halt_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1",
      },
    });

  test.each([
    ["plain", []],
    ["sanitized", ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"]],
  ])("clears on the dispose hook and keeps through the job (%s)", async (lane, flags) => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-weakref-"));
    try {
      const bin = await build(dir, `weakref-${lane}`, ["-DSCR_WEAK_REF", ...flags]);
      const result = await run(bin);
      expect(result.stdout.trim().split("\n")).toEqual(STDOUT);
      // The sanitized lane's RC audit proves every object and record the
      // test made was freed, and that no access outlived one.
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
