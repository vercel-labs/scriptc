/* Sessions held across a database's close must not leave their registry
 * entries behind: the close releases both references on each live session's
 * entry. The fixture runs 500k such sessions and prints the resident-set
 * growth. Plain lane only: the sanitizer's allocator quarantine holds freed
 * memory, so resident size says nothing there. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/sqlite-session-slot-lifetime");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(sanitize)(
  "sessions held across a close do not leave registry entries behind",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(
      join(repoRoot, "tests/fixtures/sqlite-session-slot-lifetime/main.ts"),
      { outPath: join(outDir, "main"), outDir, backend: "llvm" },
    );
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const run = await execFileAsync(result.binaryPath);
    expect(run.stderr).toBe("");
    expect(Number(run.stdout.trim()), "growth in MiB").toBeLessThan(8);
  },
);
