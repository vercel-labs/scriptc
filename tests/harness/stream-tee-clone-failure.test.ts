/* ReadableStreamTee(stream, true) clones each chunk before either branch
 * sees it; a chunk structuredClone refuses errors both branches with the
 * DataCloneError and cancels the source instead of handing the producer's
 * object to both branches. Node's own tee throws the error out of its
 * microtask (an uncaught exception), so the fixture pins the defined
 * behavior here rather than against Node. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/stream-tee-clone-failure");

test(
  "a chunk the tee cannot clone errors both branches and cancels the source",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(
      join(repoRoot, "tests/fixtures/stream-tee-clone-failure/main.mjs"),
      {
        outPath: join(outDir, "main"),
        outDir,
        backend: "llvm",
      },
    );
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const run = await execFileAsync(result.binaryPath);
    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")).toEqual([
      "first err DataCloneError",
      "second err DataCloneError",
      "canceled true",
      'cloned false {"n":1}',
    ]);
  },
);
