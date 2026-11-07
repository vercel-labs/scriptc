/* Two-tier invariant I3 for typed programs that use the runtime's handle
 * units: a fully typed net server, HTTP server or child-process program
 * defines no dynamic-tier runtime symbol (DYNAMIC_TIER_PREFIXES). Those
 * units keep their checked-dynamic members behind references only a
 * program that boxes a handle makes (a unit's scr_*_to_dyn, the emitted
 * main of a program that reads the dynamic receiver), and an error keeps
 * the properties a throw site attaches until dynamic code asks for its
 * node. tests/harness/bench-dynamic-tier.test.ts holds the benchmark
 * workloads to the same contract. The contract is the Linux release
 * binary, so other hosts and the sanitized lane skip the builds. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { definedFunctionNames, dynamicTierSymbols } from "../../scripts/zero-cost-compare.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpus = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/corpus-dynamic-tier");
const skip = process.platform !== "linux" || process.env["SCRIPTC_SAN"] === "1";

/** Fully typed corpus programs, one per handle unit. */
const TYPED_PROGRAMS = [
  "8885-net-typed-server-echo.ts",
  "8886-http-typed-server.ts",
  "8898-child-typed-exec.ts",
];

test.skipIf(skip).each(TYPED_PROGRAMS)(
  "fully typed %s links no dynamic-tier symbol",
  async (name) => {
    const outDir = join(cacheDir, name);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(corpus, name), { outPath: join(outDir, "program"), outDir });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync("nm", [result.binaryPath], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    expect(
      dynamicTierSymbols(definedFunctionNames(stdout)),
      `${name} links dynamic-tier symbols`,
    ).toEqual([]);
  },
);
