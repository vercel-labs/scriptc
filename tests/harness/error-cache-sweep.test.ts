/* Errors that cross into checked-dynamic code stay in the runtime's error
 * identity cache only while something references them: a retry loop that
 * reads 100,000 caught errors through a cast keeps the resident set flat,
 * on the main thread and in a worker (each thread sweeps its own cache).
 * Plain lane only: the sanitizer's allocator quarantine holds freed
 * memory, so resident size says nothing there. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/error-cache-sweep");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(sanitize)("error identity cache", () => {
  test("a retry loop of crossing errors keeps memory flat", { timeout: 300_000 }, async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/error-cache-sweep/retry-loop.ts"), {
      outPath: join(outDir, "retry-loop"),
      outDir,
      backend: "llvm",
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    for (const args of [[], ["worker"]]) {
      const run = await execFileAsync(result.binaryPath, args);
      expect(run.stderr).toBe("");
      expect(Number(run.stdout.trim()), `growth in MiB (${args.join(" ") || "main"})`).toBeLessThan(
        16,
      );
    }
  });
});
