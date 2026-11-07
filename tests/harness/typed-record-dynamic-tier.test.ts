/* Typed code that reads closed records through their reflective surfaces
 * (Object.keys, values and entries, for...in, `in`, the own-key tests,
 * JSON.stringify, string conversion, inspection) links no dynamic-tier
 * runtime symbol (DYNAMIC_TIER_PREFIXES). Each surface can answer from a
 * record's kept source, through a checked view of the record; a program in
 * which no record can keep a source has no such view
 * (frontend/lowering/record-sources.ts), and a helper that only a removed
 * view referred to does not survive the link of a divided program
 * (native/llvm-codegen/src/emit.cpp). The contract is the Linux release
 * binary the zero-cost gate measures, so other hosts and the sanitized lane
 * skip the builds. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { definedFunctionNames, dynamicTierSymbols } from "../../scripts/zero-cost-compare.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/typed-record-dynamic-tier");
const skip = process.platform !== "linux" || process.env["SCRIPTC_SAN"] === "1";

test.skipIf(skip).each([
  // Several modules: large enough that the program is compiled in
  // partitions, with the view's helpers and their one user in different ones.
  ["9063-typed-record-keys-modules/main.ts"],
  // Every surface, over records whose values are records too.
  ["9064-typed-record-surfaces.ts"],
])("%s links no dynamic-tier symbol", async (program) => {
  const outDir = join(cacheDir, program.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(outDir, { recursive: true });
  const result = await compile(join(repoRoot, "tests/corpus", program), {
    outPath: join(outDir, "program"),
    outDir,
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const { stdout } = await execFileAsync("nm", [result.binaryPath], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  expect(dynamicTierSymbols(definedFunctionNames(stdout))).toEqual([]);
});
