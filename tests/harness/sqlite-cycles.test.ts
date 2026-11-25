/* SQLite objects are nodes of the cycle collector and finalize what nothing
 * can reach: a database whose cache, closure or statement metadata points
 * back at it is reclaimed with the group; statements a program drops are
 * finalized at once instead of accumulating on a long-lived connection; and
 * a session's SQLite object is deleted before its connection can close,
 * whatever order the collector frees a dead group in. Each fixture prints
 * the resident-set growth in MiB. Plain lane only: the sanitizer's
 * allocator quarantine holds freed memory, so resident size says nothing
 * there. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/sqlite-cycles");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const cases = [
  {
    name: "a database that owns its cache and metadata is reclaimed",
    fixture: "sqlite-cycles/main.ts",
    bound: 20,
  },
  {
    name: "dropped statements do not accumulate on a long-lived connection",
    fixture: "sqlite-statement-lifetime/main.ts",
    bound: 8,
  },
  {
    name: "a database and its session are reclaimed together, session first",
    fixture: "sqlite-session-teardown/main.ts",
    bound: 40,
  },
  {
    name: "dropped sessions do not accumulate on a long-lived database",
    fixture: "sqlite-session-lifetime/main.ts",
    bound: 12,
  },
];

describe.skipIf(sanitize)("sqlite object lifetimes", () => {
  for (const entry of cases) {
    test(entry.name, { timeout: 300_000 }, async () => {
      mkdirSync(outDir, { recursive: true });
      const binary = join(outDir, entry.fixture.replace(/[/.]/g, "-"));
      const result = await compile(join(repoRoot, "tests/fixtures", entry.fixture), {
        outPath: binary,
        outDir,
        backend: "llvm",
      });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      const run = await execFileAsync(result.binaryPath);
      expect(run.stderr).toBe("");
      expect(Number(run.stdout.trim()), "growth in MiB").toBeLessThan(entry.bound);
    });
  }
});
