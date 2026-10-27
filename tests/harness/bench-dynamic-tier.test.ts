/* Two-tier invariant I3 for the runtime benchmark workloads, in CI: the
 * release executable of a fully typed workload defines no dynamic-tier
 * runtime symbol (DYNAMIC_TIER_PREFIXES), and every workload the zero-cost
 * gate lists as dynamic (DYNAMIC_WORKLOADS) still defines one, so the list
 * shrinks as leaks close. The gate (scripts/zero-cost-gate.mjs) checks the
 * same contract, but only when someone runs it. The contract is the Linux
 * release binary the gate measures, so other hosts and the sanitized lane
 * skip the builds. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import {
  DYNAMIC_WORKLOADS,
  definedFunctionNames,
  dynamicTierSymbols,
} from "../../scripts/zero-cost-compare.mjs";
import { readWorkloads } from "../../benchmarks/runtime/workloads.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const suite = join(repoRoot, "benchmarks/runtime");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/bench-dynamic-tier");
const skip = process.platform !== "linux" || process.env["SCRIPTC_SAN"] === "1";

interface Workload {
  name: string;
  entry: string;
}

// One program per entry file, named after its first workload, as the gate
// names them.
const programs = new Map<string, string>();
for (const w of readWorkloads(suite) as Workload[])
  if (![...programs.values()].includes(w.entry)) programs.set(`bench/${w.name}`, w.entry);

test("every workload the gate lists as dynamic is a bench program", () => {
  for (const id of DYNAMIC_WORKLOADS) expect(programs.has(id), id).toBe(true);
});

test.skipIf(skip).each([...programs])(
  "%s links the dynamic tier only if listed",
  async (id, entry) => {
    const outDir = join(cacheDir, id.slice("bench/".length));
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(suite, entry), { outPath: join(outDir, "program"), outDir });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync("nm", [result.binaryPath], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const linked = dynamicTierSymbols(definedFunctionNames(stdout));
    if (DYNAMIC_WORKLOADS.has(id))
      expect(
        linked.length,
        `${id} links no dynamic-tier symbol: drop it from DYNAMIC_WORKLOADS`,
      ).toBeGreaterThan(0);
    else expect(linked, `fully typed ${id} links dynamic-tier symbols`).toEqual([]);
  },
);
