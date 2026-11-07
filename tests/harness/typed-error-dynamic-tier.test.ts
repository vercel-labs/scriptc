/* Typed code that constructs, throws, catches and reads the builtin error
 * classes links no dynamic-tier runtime symbol (DYNAMIC_TIER_PREFIXES):
 * `new Error(message)` with a string message, or none, takes the typed
 * constructor. A program class that extends Error still links them, through
 * the dynamic view registered for it at start-up. The contract is the Linux
 * release binary the zero-cost gate measures, so other hosts and the
 * sanitized lane skip the build. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { definedFunctionNames, dynamicTierSymbols } from "../../scripts/zero-cost-compare.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/typed-error-dynamic-tier");
const skip = process.platform !== "linux" || process.env["SCRIPTC_SAN"] === "1";

test.skipIf(skip)("typed error construction links no dynamic-tier symbol", async () => {
  mkdirSync(cacheDir, { recursive: true });
  const result = await compile(join(repoRoot, "tests/corpus/8888-typed-error-plain.ts"), {
    outPath: join(cacheDir, "program"),
    outDir: cacheDir,
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const { stdout } = await execFileAsync("nm", [result.binaryPath], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  expect(dynamicTierSymbols(definedFunctionNames(stdout))).toEqual([]);
});
