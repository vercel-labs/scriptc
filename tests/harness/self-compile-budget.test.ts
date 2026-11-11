import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BUDGET_FILE,
  budgetVerdict,
  dynamicClassesEnv,
  dynamicClassReport,
  heapLimitMb,
  HEAP_LIMIT_SHARE,
  HEAP_PROBE_FLAGS,
  judgesSelfCompile,
  readBudget,
  llvmFacts,
  outputGrowthAllowance,
  outputGrowthVerdict,
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

test("an LLVM text is measured by its bytes, its functions and its dynamic-tier functions", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-llvm-facts-"));
  try {
    const file = join(dir, "program.ll");
    const text = [
      "; ModuleID = 'program'",
      "declare void @scr_runtime_abi_v1()",
      'define internal fastcc double @"sc_f_%m1.area"(ptr %0) {',
      "  ret double 0.0",
      "}",
      "define internal ptr @sc_dc_12(ptr %d, ptr %path) {",
      "  ret ptr null",
      "}",
      "define internal i1 @sc_dm_3(ptr %d) {",
      "  ret i1 true",
      "}",
      "define internal ptr @sc_bf__x25_dyn_class_keys_55aface2a090(ptr %0) {",
      "  ; a line that only mentions define @sc_dc_99 does not define it",
      "  ret ptr null",
      "}",
      "define i32 @main() {",
      "  ret i32 0",
      "}",
      "",
    ].join("\n");
    writeFileSync(file, text);
    expect(llvmFacts(file)).toEqual({ bytes: text.length, functions: 5, dynamicTier: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the compiler's own LLVM may not grow far beyond its source", () => {
  // Main at 2ac6be38c and at the next commit, aa86134742 (#2878), as llvmFacts reads the two
  // builds: one memo added 428 lines and made the Lowerer a dynamic value.
  const before = { bytes: 1_026_915_457, functions: 147_639, dynamicTier: 11_472 };
  const after = { bytes: 1_053_426_853, functions: 157_103, dynamicTier: 16_043 };
  const sourceRatio = 22_320_000 / 22_310_000;
  const grown = outputGrowthVerdict({ candidate: after, baseline: before, sourceRatio });
  expect(grown.lines).toEqual([
    "its own source compiles to 1053426853 LLVM bytes, +2.6% over the baseline's source (+0.0% source bytes): OVER the 1% tolerance",
    "its own source compiles to 157103 functions, +6.4% over the baseline's source (+0.0% source bytes): OVER the 1% tolerance",
    "16043 of its functions belong to the dynamic tier (+4571 against the baseline's source): OVER the 5% tolerance",
  ]);
  expect(grown.failures).toHaveLength(3);
  expect(grown.failures[1]).toMatch(
    /\+6\.4% more functions than the baseline's \(147639 to 157103\)/,
  );
  expect(grown.failures[1]).toMatch(
    /coverage packages\/compiler\/src\/native\/cli\.ts --explain-dynamic/,
  );
  expect(grown.failures[2]).toMatch(/from 11472 to 16043 functions \(\+39\.8%\)/);

  // The most any ten commits of main added beyond their source in that fortnight: 0.79% of
  // the functions.
  const ordinary = outputGrowthVerdict({
    candidate: { bytes: 1_003_000_000, functions: 150_790, dynamicTier: 10_040 },
    baseline: { bytes: 1_000_000_000, functions: 150_000, dynamicTier: 10_000 },
    sourceRatio: 1.004,
  });
  expect(ordinary.failures).toEqual([]);
  // A change that adds 2% of source may add its 2% of functions.
  expect(
    outputGrowthVerdict({
      candidate: { bytes: 1_020_000_000, functions: 153_000, dynamicTier: 10_000 },
      baseline: { bytes: 1_000_000_000, functions: 150_000, dynamicTier: 10_000 },
      sourceRatio: 1.02,
    }).failures,
  ).toEqual([]);
  // A handful of new converters is not a finding, whatever share of a small tier they are.
  expect(
    outputGrowthVerdict({
      candidate: { bytes: 1_000_000, functions: 1_000, dynamicTier: 90 },
      baseline: { bytes: 1_000_000, functions: 1_000, dynamicTier: 10 },
      sourceRatio: 1,
    }).failures,
  ).toEqual([]);
  // A change that removes functions passes.
  expect(
    outputGrowthVerdict({ candidate: before, baseline: after, sourceRatio: 1 }).failures,
  ).toEqual([]);

  // The allowance belongs to the change that sets it and needs a reason.
  const allowing = budget({
    outputGrowthAllowance: { value: 40, reason: "the lowerer's context" },
  });
  expect(outputGrowthAllowance(allowing, budget())).toBe(0.4);
  expect(outputGrowthAllowance(allowing, allowing)).toBe(0);
  expect(
    outputGrowthVerdict({ candidate: after, baseline: before, sourceRatio, allowance: 0.4 })
      .failures,
  ).toEqual([]);
  const unexplained = budget({ outputGrowthAllowance: { value: 40, reason: "" } });
  const trace = selfCompileTrace(
    [lowering("reachable-emit"), heap("reachable-emit", 100)].join("\n"),
  );
  expect(
    budgetVerdict({ budget: unexplained, previous: budget(), trace, bytes: 1_000_000 }).failures,
  ).toContain(
    "self-compile budget: outputGrowthAllowance needs a reason (scripts/self-compile-budget.json)",
  );
});

const dynamicClass = (site: object) => `scriptc dynamic-class ${JSON.stringify(site)}`;
const dynamicClasses = (names: string[], sites: number) =>
  `scriptc dynamic-classes ${JSON.stringify({ names, sites })}`;
const handedOver = {
  name: "Lowerer",
  class: "m7.Lowerer",
  kind: "dynamic",
  function: "m7.Lowerer.unitOf",
  file: "/checkout/packages/compiler/src/frontend/lowering/lowerer.ts",
  line: 16481,
  column: 44,
  text: "if (!allConst && !bindingNeverReassigned(this, sym, firstDecl!)) return null;",
};

test("a self-compile's output names the places that make a listed class a dynamic value", () => {
  // A build that was not asked, or took its frontend from a cache, reports nothing.
  expect(dynamicClassReport(lowering("reachable-emit"))).toBeNull();
  expect(dynamicClassReport(dynamicClasses(["Lowerer"], 0))).toEqual({
    names: ["Lowerer"],
    sites: [],
  });
  // Every pass that runs to its end reports; the last report is the program's.
  const stderr = [
    lowering("reachable-emit", { reachable: 3 }),
    dynamicClass({ ...handedOver, line: 1 }),
    dynamicClasses(["Lowerer"], 1),
    lowering("general-streams-relower", { reachable: 3 }),
    dynamicClass(handedOver),
    dynamicClass({ name: "Lowerer", class: "m7.Lowerer", kind: "boxed" }),
    dynamicClasses(["Lowerer"], 2),
  ].join("\n");
  expect(dynamicClassReport(stderr)).toEqual({
    names: ["Lowerer"],
    sites: [handedOver, { name: "Lowerer", class: "m7.Lowerer", kind: "boxed" }],
  });
  // The lines of the other reports are left where they are.
  expect(selfCompileTrace(stderr).passes).toEqual(["reachable-emit", "general-streams-relower"]);
});

test("a listed class that becomes a dynamic value fails the budget, with the place", () => {
  const keeping = budget({
    neverDynamicClasses: { value: ["Lowerer", "LlEmitter"], reason: "the two receivers" },
  });
  const trace = { passes: ["reachable-emit"], liveHeapMb: 5000 };
  const bytes = 25 * 2 ** 20;
  expect(dynamicClassesEnv(keeping)).toEqual({ SCRIPTC_DYNAMIC_CLASSES: "Lowerer,LlEmitter" });
  expect(dynamicClassesEnv(budget())).toEqual({});
  expect(dynamicClassesEnv(null)).toEqual({});

  const clean = budgetVerdict({
    budget: keeping,
    trace,
    bytes,
    dynamicClasses: { names: ["Lowerer", "LlEmitter"], sites: [] },
  });
  expect(clean.failures).toEqual([]);
  expect(clean.lines.at(-1)).toBe(
    "keeps Lowerer, LlEmitter out of the dynamic tier: no instance becomes a dynamic value",
  );

  const dynamic = budgetVerdict({
    budget: keeping,
    trace,
    bytes,
    root: "/checkout/",
    dynamicClasses: {
      names: ["Lowerer", "LlEmitter"],
      sites: [
        handedOver,
        { ...handedOver, kind: "cast", line: 20, column: 3, text: "return value as Lowerer;" },
        { name: "Lowerer", class: "m7.Lowerer", kind: "boxed" },
      ],
    },
  });
  expect(dynamic.lines.at(-1)).toBe(
    "Lowerer becomes a dynamic value in 3 places of its own source",
  );
  expect(dynamic.failures).toHaveLength(1);
  expect(dynamic.failures[0]).toContain(
    "self-compile budget: Lowerer must not be a dynamic value in the compiler's own build " +
      "(neverDynamicClasses, scripts/self-compile-budget.json), and 3 places make it one:\n" +
      "  packages/compiler/src/frontend/lowering/lowerer.ts:16481:44: a Lowerer becomes a dynamic value  |  " +
      "if (!allConst && !bindingNeverReassigned(this, sym, firstDecl!)) return null;\n" +
      "  packages/compiler/src/frontend/lowering/lowerer.ts:20:3: a dynamic value is checked into Lowerer  |  " +
      "return value as Lowerer;\n" +
      "  (no position): Lowerer is among the classes whose instances are dynamic values, with no place listed\n",
  );

  // A value that crosses inside another type names that type.
  const inside = budgetVerdict({
    budget: keeping,
    trace,
    bytes,
    dynamicClasses: {
      names: ["Lowerer", "LlEmitter"],
      sites: [{ ...handedOver, name: "LlEmitter", through: "LlEmitter[]", file: "/else/emit.ts" }],
    },
  });
  expect(inside.failures[0]).toContain(
    "  /else/emit.ts:16481:44: a LlEmitter inside LlEmitter[] becomes a dynamic value  |  ",
  );

  // A build that printed no report, or answered for other classes, is not judged here: the
  // command line, which asks for the report, fails it.
  for (const report of [null, { names: ["Lowerer"], sites: [] }]) {
    const silent = budgetVerdict({ budget: keeping, trace, bytes, dynamicClasses: report });
    expect(silent.failures).toEqual([]);
    expect(silent.lines.at(-1)).toMatch(/^dynamic classes: not reported for Lowerer, LlEmitter /);
  }
  // A budget that lists none says nothing about them.
  expect(budgetVerdict({ budget: budget(), trace, bytes }).lines).toHaveLength(2);
});

test("the list of classes kept out of the dynamic tier changes with a reason and does not go away", () => {
  const trace = { passes: ["reachable-emit"], liveHeapMb: 5000 };
  const bytes = 25 * 2 ** 20;
  const report = { names: ["Lowerer", "LlEmitter"], sites: [] };
  const judge = (now: object, before: object) =>
    budgetVerdict({ budget: now, previous: before, trace, bytes, dynamicClasses: report }).failures;
  const one = budget({ neverDynamicClasses: { value: ["Lowerer"], reason: "the frontend" } });
  const two = budget({
    neverDynamicClasses: { value: ["Lowerer", "LlEmitter"], reason: "and the emitter" },
  });
  expect(judge(two, one)).toEqual([]);
  expect(judge(one, one)).toEqual([]);
  expect(
    judge(budget({ neverDynamicClasses: { value: [], reason: "the frontend" } }), one),
  ).toEqual([
    'self-compile budget: neverDynamicClasses changed from ["Lowerer"] to [] with the old reason; say why in its reason (scripts/self-compile-budget.json)',
  ]);
  expect(judge(budget(), one)).toEqual([
    'self-compile budget: neverDynamicClasses was removed; the baseline lists ["Lowerer"] (scripts/self-compile-budget.json)',
  ]);
  expect(
    judge(budget({ neverDynamicClasses: { value: ["Lowerer"], reason: " " } }), budget()),
  ).toEqual([
    "self-compile budget: neverDynamicClasses needs a list of class names and a reason (scripts/self-compile-budget.json)",
  ]);
});

test("the committed budget keeps the Lowerer out of the dynamic tier", () => {
  const committed = readBudget(root);
  expect(committed.neverDynamicClasses.value).toContain("Lowerer");
  expect(committed.neverDynamicClasses.reason).not.toBe("");
  // The check command asks its build for the report on them.
  const script = readFileSync(join(root, "scripts/self-compile-budget.mjs"), "utf8");
  expect(script).toContain('SCRIPTC_TIMING: "1", ...dynamicClassesEnv(budget)');
});
