/* Static-object specialization (shape-inference/static-objects.ts): with the
 * shape overlay on, the npm case static-tables (through its JavaScript
 * consumer, js-main.cjs) calls its constant function table directly, reads
 * constant primitive members as literals, refers to namespace members of
 * another module through that module's exports, keeps every form whose
 * dynamic read is observable, keeps the TypeError of a receiver that may
 * be undefined, and prints what Node prints. The npm suites
 * run the TypeScript consumer with and without the overlay. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/static-tables/js-main.cjs");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/static-tables");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "constant function tables, primitive members and cross-module members compile directly",
  { timeout: 600_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, {
      outPath: join(outDir, "main"),
      outDir,
      sanitize,
      shapeOverlay: true,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const report = (result.warnings ?? []).find((w) => w.code === "SC6103");
    expect(report?.message).toMatch(/2 function table calls, 9 constant reads\)/);
    const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(entry), encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const node = await execFileAsync(process.execPath, [entry], {
      cwd: dirname(entry),
      encoding: "utf8",
    });
    expect(stdout).toBe(node.stdout);
  },
);
