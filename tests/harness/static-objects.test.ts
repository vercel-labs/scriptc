/* Static-object specialization, stage 2b (shape-inference/static-objects.ts):
 * with the shape overlay on, the npm case static-objects (through its JavaScript consumer, js-main.cjs) compiles its one
 * indistinguishable constructor function as a class and its `this`-free
 * namespace function as a direct function, keeps every observably
 * different form as written, and prints what Node prints. npm.test.ts runs
 * the same case without the overlay. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/static-objects/js-main.cjs");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/static-objects");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "constructor functions and namespace functions compile as classes and direct functions",
  { timeout: 600_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const saved = process.env["SCRIPTC_SHAPE_OVERLAY"];
    process.env["SCRIPTC_SHAPE_OVERLAY"] = "1";
    let result;
    try {
      result = await compile(entry, { outPath: join(outDir, "main"), outDir, sanitize });
    } finally {
      if (saved === undefined) delete process.env["SCRIPTC_SHAPE_OVERLAY"];
      else process.env["SCRIPTC_SHAPE_OVERLAY"] = saved;
    }
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const report = (result.warnings ?? []).find((w) => w.code === "SC6103");
    expect(report?.message).toMatch(
      /compiled 2 constructor functions as classes and 3 namespace functions as direct functions/,
    );
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
