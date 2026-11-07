import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BUDGET_FILE,
  budgetVerdict,
  heapLimitMb,
  HEAP_LIMIT_SHARE,
  HEAP_PROBE_FLAGS,
  judgesSelfCompile,
  readBudget,
  selfCompileTrace,
  sourceCostAllowance,
  sourceCostVerdict,
} from "../../scripts/self-compile-budget.mjs";

const root = join(import.meta.dirname, "../..");

const lowering = (phase: string, extra: object = {}) =>
  `scriptc lowering ${JSON.stringify({ phase, phase_ms: 1, total_ms: 1, ...extra })}`;
const heap = (phase: string, live_mb: number) =>
  `scriptc heap ${JSON.stringify({ phase, live_mb })}`;

const budget = (overrides: object = {}) => ({
  schema: 1,
  heapLimitMb: { value: 8192, reason: "the limit" },
  loweringPasses: { value: ["reachable-emit"], reason: "one pass" },
  liveHeapBytesPerSourceByte: { value: 200, reason: "recorded" },
  sourceCostAllowance: { value: 0, reason: "" },
  ...overrides,
});

test("a self-compile's output names its lowering passes and its live heap", () => {
  const stderr = [
    'scriptc timing {"phase":"frontend-load","phase_ms":48358.4,"total_ms":48362.2}',
    lowering("ffi-validate"),
    lowering("reachable-emit", { reachable: 11428 }),
    heap("reachable-emit", 3141),
    lowering("whole-slot-relower", { reachable: 11428 }),
    heap("whole-slot-relower", 4200),
    lowering("general-streams-relower", { reachable: 11428 }),
    heap("general-streams-relower", 4595),
    lowering("divergence-scan", { found: 0 }),
    'scriptc timing {"phase":"lower","phase_ms":580783.2,"total_ms":630288.4}',
  ].join("\n");
  expect(selfCompileTrace(stderr)).toEqual({
    passes: ["reachable-emit", "whole-slot-relower", "general-streams-relower"],
    liveHeapMb: 4595,
  });
  // A pass that ended early is not the pass that ran to its end.
  // And a build without the heap probe reports no heap.
  expect(
    selfCompileTrace(
      [
        lowering("reachable-emit", { reachable: 0, aborted: "stream-flags" }),
        lowering("general-streams-relower", { reachable: 11564 }),
      ].join("\n"),
    ),
  ).toEqual({
    passes: ["reachable-emit(aborted)", "general-streams-relower"],
    liveHeapMb: null,
  });
});

test("the heap probe reports the reachable heap at the end of each lowering pass", () => {
  const program = `
    const kept = [];
    for (let i = 0; i < 200000; i++) kept.push({ i });
    process.stderr.write('scriptc lowering {"phase":"ffi-validate","phase_ms":1,"total_ms":1}\\n');
    process.stderr.write('scriptc lowering {"phase":"reachable-emit","phase_ms":1,"total_ms":2,"reachable":3}\\n');
    kept.length = 0;
    process.stderr.write('scriptc lowering {"phase":"general-streams-relower","phase_ms":1,"total_ms":3,"reachable":3}\\n');
  `;
  const run = (env: Record<string, string>, flags: readonly string[]) =>
    spawnSync(process.execPath, [...flags, "-e", program], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  const probed = run({ SCRIPTC_TIMING: "1" }, HEAP_PROBE_FLAGS);
  expect(probed.status).toBe(0);
  const lines = probed.stderr.trim().split("\n");
  expect(lines.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
    "scriptc lowering",
    "scriptc lowering",
    "scriptc heap",
    "scriptc lowering",
    "scriptc heap",
  ]);
  const trace = selfCompileTrace(probed.stderr);
  expect(trace.passes).toEqual(["reachable-emit", "general-streams-relower"]);
  expect(trace.liveHeapMb).toBeGreaterThan(0);
  // Without the timing lines' switch, or without the collector exposed, a build is left alone.
  expect(run({ SCRIPTC_TIMING: "0" }, HEAP_PROBE_FLAGS).stderr).not.toContain("scriptc heap");
  expect(run({ SCRIPTC_TIMING: "1" }, HEAP_PROBE_FLAGS.slice(1)).stderr).not.toContain(
    "scriptc heap",
  );
});

test("an extra whole-program lowering pass fails the budget, and so does a stale list", () => {
  const bytes = 25 * 2 ** 20;
  const within = budgetVerdict({
    budget: budget(),
    trace: { passes: ["reachable-emit"], liveHeapMb: 5000 },
    bytes,
  });
  expect(within.failures).toEqual([]);
  expect(within.lines).toEqual([
    "lowers its own source in 1 pass: reachable-emit",
    "holds 5000 MB at the end of a lowering pass: 200 bytes per source byte (budget 200, +0.0%), 61% of the 8192 MB limit (at most 65%)",
  ]);
  expect(within.measured).toEqual({
    loweringPasses: ["reachable-emit"],
    liveHeapBytesPerSourceByte: 200,
  });

  // #2918: one Readable.pause() on a child pipe made the compiler lower itself three times.
  const extra = budgetVerdict({
    budget: budget(),
    trace: {
      passes: ["reachable-emit", "whole-slot-relower", "general-streams-relower"],
      liveHeapMb: 5000,
    },
    bytes,
  });
  expect(extra.failures).toHaveLength(1);
  expect(extra.failures[0]).toMatch(
    /^self-compile budget: the compiler's own source lowers in passes \[reachable-emit, whole-slot-relower, general-streams-relower\], the budget lists \[reachable-emit\]\. .*Find the construct that asks for the extra pass/,
  );
  // The fix that removes a pass records it, so the pass cannot return unnoticed.
  const fewer = budgetVerdict({
    budget: budget({
      loweringPasses: { value: ["reachable-emit", "general-streams-relower"], reason: "two" },
    }),
    trace: { passes: ["reachable-emit"], liveHeapMb: 5000 },
    bytes,
  });
  expect(fewer.failures).toHaveLength(1);
  expect(fewer.failures[0]).toMatch(
    /Record the improvement: set loweringPasses\.value to \["reachable-emit"\]/,
  );
});

test("the live heap is budgeted per source byte and against the heap limit", () => {
  const bytes = 20 * 2 ** 20;
  const trace = (liveHeapMb: number) => ({ passes: ["reachable-emit"], liveHeapMb });
  // Within the tolerance.
  expect(budgetVerdict({ budget: budget(), trace: trace(4160), bytes }).failures).toEqual([]);
  // Something kept reachable through lowering, such as a pass that has been replaced.
  const over = budgetVerdict({ budget: budget(), trace: trace(4480), bytes });
  expect(over.failures).toHaveLength(1);
  expect(over.failures[0]).toMatch(
    /^self-compile budget: the live heap is 224 bytes per source byte, \+12\.0% over the budget of 200 /,
  );
  // More source at the same heap per byte is within the budget until it nears the heap limit.
  const grown = budgetVerdict({ budget: budget(), trace: trace(5600), bytes: 28 * 2 ** 20 });
  expect(grown.failures).toHaveLength(1);
  expect(grown.failures[0]).toMatch(
    /^self-compile budget: the heap at the end of a lowering pass \(5600 MB\) fills 68% of the 8192 MB heap limit, above 65%/,
  );
  expect(
    budgetVerdict({
      budget: budget({ heapLimitMb: { value: 12288, reason: "the source grew" } }),
      trace: trace(5600),
      bytes: 28 * 2 ** 20,
    }).failures,
  ).toEqual([]);
  // A gain is reported, so the budget can follow it down.
  expect(budgetVerdict({ budget: budget(), trace: trace(3200), bytes }).lines.at(-1)).toMatch(
    /lower liveHeapBytesPerSourceByte\.value to 160 to keep the gain$/,
  );
  // A checkout without a budget is not judged; a build without the traces reports that.
  expect(budgetVerdict({ budget: null, trace: trace(9000), bytes }).failures).toEqual([]);
  expect(
    budgetVerdict({ budget: budget(), trace: { passes: [], liveHeapMb: null }, bytes }),
  ).toMatchObject({ failures: [], measured: {} });
});

test("a budget value that moves states its reason", () => {
  const bytes = 20 * 2 ** 20;
  const trace = { passes: ["reachable-emit"], liveHeapMb: 4480 };
  const raised = (reason: string) => budget({ liveHeapBytesPerSourceByte: { value: 224, reason } });
  expect(
    budgetVerdict({ budget: raised("recorded"), previous: budget(), trace, bytes }).failures,
  ).toEqual([
    `self-compile budget: liveHeapBytesPerSourceByte changed from 200 to 224 with the old reason; say why in its reason (${BUDGET_FILE})`,
  ]);
  expect(
    budgetVerdict({
      budget: raised("the checker keeps one more table per symbol"),
      previous: budget(),
      trace,
      bytes,
    }).failures,
  ).toEqual([]);
  expect(budgetVerdict({ budget: raised(" "), previous: null, trace, bytes }).failures[0]).toMatch(
    /liveHeapBytesPerSourceByte needs a value and a reason/,
  );
});

test("a change's own source may not cost more compile time than its share of source", () => {
  // The spread of one unchanged build pair across recorded gate rounds.
  expect(sourceCostVerdict({ ratios: [1.03], sourceRatio: 1.001 })).toMatchObject({
    fails: false,
    failure: null,
  });
  // More source costs more time in proportion.
  expect(sourceCostVerdict({ ratios: [1.14], sourceRatio: 1.06 }).fails).toBe(false);
  // #2918 against its parent: 855.6 s over 518.1 s for 0.4% more source.
  const cliff = sourceCostVerdict({ ratios: [855.6 / 518.1, 860.6 / 526.7], sourceRatio: 1.004 });
  expect(cliff.fails).toBe(true);
  expect(cliff.line).toBe(
    "its own source costs +63.4% compile time over the baseline's source (+0.4% source bytes, 2 pairs): OVER the 10% tolerance",
  );
  expect(cliff.failure).toMatch(/set sourceCostAllowance to \{ "value": 54, "reason": "<why>" \}/);
  // One slow pair on a busy host is not a regression: the repeat decides.
  expect(sourceCostVerdict({ ratios: [1.16, 1.01], sourceRatio: 1 }).fails).toBe(false);

  // The allowance belongs to the change that sets it.
  const allowing = budget({ sourceCostAllowance: { value: 54, reason: "a second pass, for now" } });
  expect(sourceCostAllowance(allowing, budget())).toBe(0.54);
  expect(sourceCostAllowance(allowing, allowing)).toBe(0);
  expect(sourceCostAllowance(budget(), null)).toBe(0);
  expect(sourceCostVerdict({ ratios: [1.63], sourceRatio: 1.004, allowance: 0.54 }).fails).toBe(
    false,
  );
  // And it says why.
  expect(
    budgetVerdict({
      budget: budget({ sourceCostAllowance: { value: 54, reason: "" } }),
      previous: budget(),
      trace: { passes: ["reachable-emit"], liveHeapMb: 5000 },
      bytes: 25 * 2 ** 20,
    }).failures,
  ).toEqual([`self-compile budget: sourceCostAllowance needs a reason (${BUDGET_FILE})`]);
});

test("the committed budget is complete and leaves room under the heap limit", () => {
  const committed = readBudget(root);
  expect(committed).not.toBeNull();
  for (const key of ["heapLimitMb", "loweringPasses", "liveHeapBytesPerSourceByte"])
    expect(committed[key].reason, key).toMatch(/\S/);
  expect(committed.loweringPasses.value[0]).toMatch(/^reachable-emit/);
  expect(HEAP_LIMIT_SHARE).toBeLessThan(1);
});

/** Every place a Node-hosted self-compile gets its heap limit. The gate and
 * scripts/self-compile-budget.mjs read the budget; these pass a literal. */
function selfCompileHeapLiterals(): { file: string; limit: number }[] {
  const files = [
    "package.json",
    "scripts/bootstrap-seed.mjs",
    "scripts/refresh-cli-profile.mjs",
    "scripts/refresh-cli-layout.mjs",
    "tests/harness/self-hosting-native-driver.test.ts",
    ...readdirSync(join(root, "packages"))
      .filter((name) => name.startsWith("cli-"))
      .map((name) => `packages/${name}/package.json`),
  ];
  const found: { file: string; limit: number }[] = [];
  for (const file of files)
    for (const match of readFileSync(join(root, file), "utf8").matchAll(
      /--max-old-space-size=(\d+)/g,
    ))
      found.push({ file, limit: Number(match[1]) });
  return found;
}

test("every self-compile entry point runs with the budget's heap limit", () => {
  const limit = heapLimitMb(readBudget(root));
  const literals = selfCompileHeapLiterals();
  // The root build script, the seed, the two profile refreshes, the bootstrap contracts' seed
  // builds and the platform packages.
  expect(literals.length).toBeGreaterThanOrEqual(7);
  expect(literals.filter((entry) => entry.limit !== limit)).toEqual([]);
});

test("every gate run that holds the self program judges the self-compile", () => {
  const self = { id: "self/cli", kind: "source" };
  const exe = { id: "bench/n-body", kind: "exe" };
  // Which checkout the programs come from is not asked: a run with
  // --programs=candidate budgets the candidate's compile like any other.
  expect(judgesSelfCompile(new Set(["bench", "self", "corpus"]), [exe, self])).toBe(true);
  // A shard without the self program, and a run without the self set.
  expect(judgesSelfCompile(new Set(["bench", "self", "corpus"]), [exe])).toBe(false);
  expect(judgesSelfCompile(new Set(["bench"]), [exe, self])).toBe(false);
  // The gate takes the decision from here, with no condition of its own.
  const gate = readFileSync(join(root, "scripts/zero-cost-gate.mjs"), "utf8");
  expect(gate).toContain("const checkCandidateSelf = judgesSelfCompile(sets, programs);");
});
