/* Static-object specialization (shape-inference/static-objects.ts): with the
 * shape overlay on, the npm case static-stores (through its JavaScript
 * consumer, js-main.cjs) reads primitive members stored after their
 * namespace object was created as literals where the read provably runs
 * after the store, keeps the reads that can run before it, and prints what
 * Node prints. Its functions with and without a receiver read `this` as
 * Node does. The npm suites run the TypeScript consumer with and without
 * the overlay. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/static-stores/js-main.cjs");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/static-stores");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "members stored after their namespace was created read as literals after the store",
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
    expect(report?.message).toMatch(/2 function table calls, 4 constant reads\)/);
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
