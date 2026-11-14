/* setHeader/appendHeader over an array argument. The value's elements have
 * their toString run during validation and again during conversion, and that
 * hook is program code: one element's toString can empty the array or replace
 * a later element. Each call retains a snapshot of the elements and reads only
 * that snapshot, so the header is what the call started with — and no
 * iteration dereferences a value the hook released. Without the snapshot the
 * conversion reads the mutated array and the header carries the replacement.
 *
 * The expectation is this runtime's own: Node stores the raw array and
 * converts at write time, the eager-vs-lazy difference the header store
 * already documents elsewhere. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe("header array arguments under a reentrant conversion", () => {
  test("the call converts the elements it started with", { timeout: 300_000 }, async () => {
    const file = join(repoRoot, "tests/fixtures/http-header-array-snapshot/main.mjs");
    const key = createHash("sha256")
      .update(file)
      .update(readFileSync(file))
      .update(sanitize ? "san" : "plain")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `http-header-array-snapshot-${key}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(file, {
      outPath: join(outDir, "program"),
      outDir,
      sanitize,
      backend: "llvm",
    });
    if (!result.ok) {
      throw new Error(
        "program failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    }
    const run = await execFileAsync(result.binaryPath, [], {
      env: sanitize ? { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } : process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      'set ["head","second","third","head","second","third"]\nnew ["head","second","third"]\n',
    );
  });
});
