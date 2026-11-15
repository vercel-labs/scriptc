/* A corked chunked response leaves in one write at end() (scr_http.c's
 * scr_http_res_end_raw), as Node sends it. A preloaded shim counts the
 * write calls on each accepted socket of tests/corpus/http-write-end-syscalls.ts;
 * the expected counts are the ones Node 24.22 makes for the same program
 * (strace: one writev per response, and a writev plus a write when an
 * await separates write() and end()). */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(process.platform !== "linux" || sanitize)("http write coalescing", () => {
  test("a corked chunked response and its terminator leave in one write", async () => {
    const outDir = join(cacheDir, "http-write-end-syscalls");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/corpus/http-write-end-syscalls.ts"), {
      outPath: join(outDir, "server"),
      outDir,
      backend: "llvm",
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const shim = join(outDir, "count-writes.so");
    execFileSync("clang", [
      "-shared",
      "-fPIC",
      join(repoRoot, "tests/fixtures/http-write-end-syscalls.c"),
      "-o",
      shim,
      "-ldl",
    ]);
    const countFile = join(outDir, "writes.txt");
    rmSync(countFile, { force: true });
    const run = spawnSync(result.binaryPath, [], {
      encoding: "utf8",
      env: { ...process.env, LD_PRELOAD: shim, HTTP_WRITE_COUNT_FILE: countFile },
    });
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean)).toHaveLength(7);
    const writes = readFileSync(countFile, "utf8").split("\n").filter(Boolean).map(Number);
    // same-tick, await, reader, end-data, two-writes, trailers, HEAD
    expect(writes).toEqual([1, 2, 1, 1, 1, 1, 1]);
  });
});
