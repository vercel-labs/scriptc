import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

const EXPECTED = [
  "current while open: yes",
  "objects start zeroed: yes",
  "objects without headers: yes",
  "outer current after inner close: yes",
  "inner drop disposed 10 (sum 1000)",
  "current after close: none",
  "drop disposed 100001 (sum 100001), list cleared",
  "closed arena held 3000000, disposed 0, current none",
  "cap refused: yes, all disposed: yes",
  "target after dropping an open arena: outer",
  "target while suspended: none",
  "target after resume: outer",
];

// The size-class allocator build (chunks, the inline bump's fields), and
// the sanitized lane's build (a block per object, freed by the drop).
describe.skipIf(process.platform === "win32")("group arenas", () => {
  test.each([
    ["size-class", ["-fsanitize=undefined"]],
    ["sanitized", ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"]],
  ])(
    "open, allocate, close and drop (%s)",
    async (_lane, flags) => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-arena-"));
      try {
        const bin = join(dir, "arena");
        await exec("clang", [
          "-std=c11",
          "-O1",
          "-pthread",
          "-Wno-deprecated-declarations",
          ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
          ...flags,
          ...["scr_arena.test.c", ...EXECUTABLE_RUNTIME_SOURCES].map((source) =>
            join(import.meta.dirname, source),
          ),
          ...(process.platform === "linux" ? ["-lm"] : []),
          "-o",
          bin,
        ]);
        const { stdout } = await exec(bin, [], {
          timeout: 60000,
          env: {
            ...process.env,
            ASAN_OPTIONS: "halt_on_error=1",
            UBSAN_OPTIONS: "halt_on_error=1",
          },
        });
        expect(stdout.trim().split("\n")).toEqual(EXPECTED);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    300000,
  );
});
