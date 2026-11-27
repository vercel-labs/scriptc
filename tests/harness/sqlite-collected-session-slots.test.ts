/* Session wrappers collected in a cycle while the database stays open must
 * not leave their registry entries behind: a collected wrapper only clears
 * what its entry names (the collector frees a database and its sessions in
 * no particular order), so the database reuses those entries. The fixture
 * runs 500k such sessions on one open database and prints the resident-set
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
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/sqlite-collected-session-slots");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(sanitize)(
  "sessions collected in a cycle leave no registry entries on an open database",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(
      join(repoRoot, "tests/fixtures/sqlite-collected-session-slots/main.ts"),
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
