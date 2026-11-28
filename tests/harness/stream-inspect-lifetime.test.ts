/* Inspecting a stream builds its view and the state strings in it; the
 * inspection must release them with the view. The fixture inspects a
 * readable, a writable, a transform, a strategy and a text stream half a
 * million times and prints the resident-set growth. Plain lane only: the
 * sanitizer's allocator quarantine holds freed memory, so resident size
 * says nothing there. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/stream-inspect-lifetime");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(sanitize)(
  "inspecting streams repeatedly does not grow the resident set",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(
      join(repoRoot, "tests/fixtures/webstream-inspect-lifetime/main.mjs"),
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
    expect(Number(run.stdout.trim()), "growth in MiB").toBeLessThan(8);
  },
);
