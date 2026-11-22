/* A database, its statements, sessions, tag stores and limits object are
 * nodes of the cycle collector: a property that refers back at the object
 * (a cached tag store, a closure over the connection, metadata on a
 * statement) is reclaimed with the group instead of pinning it forever.
 * The fixture builds 400 such groups and prints the resident-set growth;
 * before the group took part in collection the growth tracked the retained
 * payloads (over a hundred MiB). Plain lane only: the sanitizer's allocator
 * quarantine holds freed memory, so resident size says nothing there. */
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

describe.skipIf(sanitize)("sqlite cycle collection", () => {
  test(
    "a database that owns its cache and metadata is reclaimed",
    { timeout: 300_000 },
    async () => {
      mkdirSync(outDir, { recursive: true });
      const result = await compile(join(repoRoot, "tests/fixtures/sqlite-cycles/main.ts"), {
        outPath: join(outDir, "sqlite-cycles"),
        outDir,
        backend: "llvm",
      });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      const run = await execFileAsync(result.binaryPath);
      expect(run.stderr).toBe("");
      expect(Number(run.stdout.trim()), "growth in MiB").toBeLessThan(20);
    },
  );
});
