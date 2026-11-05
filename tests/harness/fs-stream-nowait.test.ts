/* fs streams read a regular file with RWF_NOWAIT on the loop thread first
 * (scr_fs_stream.c). Linux 5.9 and 5.10 answer 0 instead of EAGAIN for
 * an uncached RWF_NOWAIT read; a preloaded preadv2 shim reproduces that
 * answer, and the stream must still read the whole file, as Node does. */
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(process.platform !== "linux" || sanitize)("fs stream RWF_NOWAIT reads", () => {
  test("a zero from an RWF_NOWAIT read is not taken as EOF", async () => {
    const outDir = join(cacheDir, "fs-stream-nowait");
    const result = await compile(join(repoRoot, "tests/fixtures/fs-stream-nowait-read.ts"), {
      outPath: join(outDir, "read"),
      outDir,
      backend: "llvm",
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const shim = join(outDir, "nowait-zero.so");
    execFileSync("clang", [
      "-shared",
      "-fPIC",
      join(repoRoot, "tests/fixtures/fs-stream-nowait-zero.c"),
      "-o",
      shim,
      "-ldl",
    ]);
    const expected = "bytes=300000 sum=50681\n";
    const plain = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(plain.stdout).toBe(expected);
    const shimmed = spawnSync(result.binaryPath, [], {
      encoding: "utf8",
      env: { ...process.env, LD_PRELOAD: shim },
    });
    expect(shimmed.status).toBe(0);
    expect(shimmed.stdout).toBe(expected);
  });
});
