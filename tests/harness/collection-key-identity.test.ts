/* A dynamic collection key is adopted as a live capsule of the key built
 * from it, so the program's other name and the collection hold one object. A
 * value the adoption cannot take (a frozen dynamic object) would silently
 * leave a copy, so the key conversion refuses it with a named runtime error
 * (SC2020) instead of storing a key a later lookup would miss. Node accepts
 * the insertion, so the fixture pins the compiler's defined answer. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/collection-key-identity");

test(
  "a dynamic collection key that cannot keep its identity is refused",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/collection-key-identity/main.ts"), {
      outPath: join(outDir, "main"),
      outDir,
      backend: "llvm",
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const run = await execFileAsync(result.binaryPath);
    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")).toEqual([
      "refused Error SC2020 a dynamic collection key whose value cannot be adopted as the key type is not supported yet",
      // The conversion's own error survives the identity check.
      "refused Error undefined getter boom",
      "stored 1 true",
    ]);
  },
);
