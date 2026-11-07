/* The self-compile budget: what the compiler may cost when it compiles its own source.
 *
 * scripts/self-compile-budget.json records the budget; this module reads a self-compile's output
 * and judges it. scripts/zero-cost-gate.mjs applies it to the candidate's own compiler source
 * (see "The self-compile budget" there), and this script applies it to one checkout on its own:
 *
 *   node scripts/self-compile-budget.mjs --check            compile packages/compiler/src/native/cli.ts
 *                                                           to LLVM with this checkout and judge it
 *   node scripts/self-compile-budget.mjs --native-build ... run scripts/build-native-cli.mts with the
 *                                                           budget's heap limit and judge its frontend
 *   ... --record --reason="<why>"                           write what the run measured into the budget
 *
 * What is budgeted, and why in these units:
 *
 *   loweringPasses              The whole-program lowering passes the self-compile takes, by name.
 *                               Exact. One construct can make the frontend lower the whole program
 *                               again (#2918: Readable.pause() on a child pipe cost two more passes,
 *                               +65% wall time for +0.3% of output).
 *   liveHeapBytesPerSourceByte  The heap still reachable at the end of a lowering pass (the
 *                               largest over the passes), over the bytes of the program's source
 *                               files. scripts/self-compile-heap-probe.mjs collects garbage at
 *                               each pass's end and reports it, so two builds of one tree agree
 *                               to the megabyte; fails HEAP_TOLERANCE above the budget. The ratio
 *                               stays put while the source grows.
 *   heapLimitMb                 The --max-old-space-size of every Node-hosted self-compile. That
 *                               heap may fill at most HEAP_LIMIT_SHARE of it, so the limit is
 *                               raised on purpose, before builds start to fail on it.
 *   sourceCostAllowance         Percent of compile time a change's own source may add beyond its
 *                               share of source bytes, for the change that sets it (the gate's
 *                               paired check; seconds are not budgeted, since the same build
 *                               differs by a third between two hosts of one machine type).
 *
 * Why the live heap is the number to watch: lowering holds the whole lowered program, so the heap
 * follows the program's size (about 5 MB live per MB of LLVM emitted), and the compiler is the
 * largest program it compiles.
 *
 * Every entry is { value, reason }. A change that moves a value states why in its reason: the gate
 * fails a value that differs from the baseline checkout's with an unchanged reason. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BUDGET_FILE = "scripts/self-compile-budget.json";
/** The self-hosted compiler's entry, relative to a checkout. */
export const SELF_ENTRY = "packages/compiler/src/native/cli.ts";
/** The heap limit of a checkout without a budget file. */
export const DEFAULT_HEAP_LIMIT_MB = 8192;
/** How far the live heap per source byte may exceed the budget. The measurement repeats exactly;
 * the tolerance is room for ordinary changes to move the ratio a little either way. */
export const HEAP_TOLERANCE = 0.05;
/** The share of the heap limit the heap at a pass's end may fill. Inside a pass the heap runs
 * about 1.4 times higher (6.4 GB sampled against 4.6 GB at the end of the same pass), so this is
 * about 90% of the limit at the peak. A build that reaches its limit dies, and every self-compile
 * shares the limit, so they would all die on the same day. */
export const HEAP_LIMIT_SHARE = 0.65;
/** The Node options of a budgeted self-compile, beside its heap limit and SCRIPTC_TIMING=1. */
export const HEAP_PROBE_FLAGS = [
  "--expose-gc",
  "--import",
  new URL("./self-compile-heap-probe.mjs", import.meta.url).href,
];
/** How far the candidate source's compile time may exceed the baseline source's, with the same
 * compiler in the same run, beyond the growth of the source itself. Over 700 recorded gate rounds
 * of four such pairs each, a round's median ratio was at most 1.06 in 678 and at least 1.27 in the
 * other 22; in the 678, one pair in 700 read above 1.10, which is what the repeat is for. The
 * same build's seconds, by contrast, differed by a median 35% between the four hosts of a round. */
export const SOURCE_COST_TOLERANCE = 0.1;

/** The budget of the checkout at `root`, or null when it has none. */
export function readBudget(root) {
  const file = join(root, BUDGET_FILE);
  if (!existsSync(file)) return null;
  const budget = JSON.parse(readFileSync(file, "utf8"));
  if (budget.schema !== 1) throw new Error(`${file}: unknown schema ${budget.schema}`);
  return budget;
}

/** The --max-old-space-size of a checkout's Node-hosted self-compiles. */
export function heapLimitMb(budget) {
  return budget?.heapLimitMb?.value ?? DEFAULT_HEAP_LIMIT_MB;
}

/** Every file a program reads: the entry and its relative imports. */
export function programInputs(entry) {
  const files = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      const base = resolve(dirname(file), match[1]);
      const stem = base.replace(/\.(m|c)?js$/, "");
      const found = [
        base,
        `${stem}.ts`,
        `${stem}.mts`,
        `${stem}.cts`,
        `${base}.ts`,
        join(base, "index.ts"),
      ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (found !== undefined) pending.push(found);
    }
  }
  return [...files];
}

/** The bytes of a program's source files. */
export function sourceBytes(entry) {
  let bytes = 0;
  for (const file of programInputs(entry)) bytes += statSync(file).size;
  return bytes;
}

/** What a self-compile's stderr says about its cost. With SCRIPTC_TIMING=1 each whole-program
 * lowering pass ends with a `scriptc lowering` line, `reachable-emit` for the first and
 * `<kind>-relower` for each repeat, marked `aborted` when it ended early. Under HEAP_PROBE_FLAGS
 * each is followed by a `scriptc heap` line with the heap still reachable there; `liveHeapMb` is
 * the largest of them, null when the build ran without the probe. */
export function selfCompileTrace(stderr) {
  const passes = [];
  let liveHeapMb = null;
  for (const match of stderr.matchAll(/^scriptc (lowering|heap) (\{.*\})$/gm)) {
    let event;
    try {
      event = JSON.parse(match[2]);
    } catch {
      continue;
    }
    if (typeof event.phase !== "string") continue;
    if (match[1] === "heap") {
      if (typeof event.live_mb === "number") liveHeapMb = Math.max(liveHeapMb ?? 0, event.live_mb);
    } else if (event.phase === "reachable-emit" || event.phase.endsWith("-relower"))
      passes.push(event.aborted === undefined ? event.phase : `${event.phase}(aborted)`);
  }
  return { passes, liveHeapMb };
}

const percent = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Judge one self-compile against the budget of the checkout whose source it compiled.
 * `trace` is selfCompileTrace's result, `bytes` the program's source bytes, `previous` the
 * baseline checkout's budget (null without one). Returns the report lines, the failures, and
 * `measured`: the values the run would record. */
export function budgetVerdict({ budget, previous = null, trace, bytes }) {
  const lines = [];
  const failures = [];
  const measured = {};
  if (budget === null)
    return {
      lines: [`no ${BUDGET_FILE} in the candidate, so nothing is budgeted`],
      failures,
      measured,
    };

  // A value that moved says why.
  for (const key of ["heapLimitMb", "loweringPasses", "liveHeapBytesPerSourceByte"]) {
    const entry = budget[key];
    if (entry === undefined || typeof entry.reason !== "string" || entry.reason.trim() === "")
      failures.push(`self-compile budget: ${key} needs a value and a reason (${BUDGET_FILE})`);
    else if (
      previous?.[key] !== undefined &&
      !same(previous[key].value, entry.value) &&
      previous[key].reason === entry.reason
    )
      failures.push(
        `self-compile budget: ${key} changed from ${JSON.stringify(previous[key].value)} to ` +
          `${JSON.stringify(entry.value)} with the old reason; say why in its reason (${BUDGET_FILE})`,
      );
  }

  const granted = budget.sourceCostAllowance;
  if (
    granted !== undefined &&
    granted.value > 0 &&
    !same(granted, previous?.sourceCostAllowance) &&
    (typeof granted.reason !== "string" || granted.reason.trim() === "")
  )
    failures.push(`self-compile budget: sourceCostAllowance needs a reason (${BUDGET_FILE})`);

  const budgetPasses = budget.loweringPasses?.value;
  if (trace.passes.length === 0)
    lines.push("lowering passes: none reported (the build printed no SCRIPTC_TIMING lines)");
  else {
    measured.loweringPasses = trace.passes;
    const listed = trace.passes.join(", ");
    if (budgetPasses === undefined || same(budgetPasses, trace.passes))
      lines.push(
        `lowers its own source in ${trace.passes.length} pass${trace.passes.length === 1 ? "" : "es"}: ${listed}`,
      );
    else {
      lines.push(
        `lowers its own source in passes ${listed}; the budget lists ${budgetPasses.join(", ")}`,
      );
      failures.push(
        `self-compile budget: the compiler's own source lowers in passes [${listed}], the budget lists ` +
          `[${budgetPasses.join(", ")}]. Each pass lowers the whole program again. ` +
          (trace.passes.length > budgetPasses.length
            ? "Find the construct that asks for the extra pass (SCRIPTC_TIMING=1 names the pass), or accept it: "
            : "Record the improvement: ") +
          `set loweringPasses.value to ${JSON.stringify(trace.passes)} with a reason in ${BUDGET_FILE}`,
      );
    }
  }

  const limit = heapLimitMb(budget);
  if (trace.liveHeapMb === null)
    lines.push(
      "live heap: not reported (the build ran without scripts/self-compile-heap-probe.mjs)",
    );
  else {
    const perByte = (trace.liveHeapMb * 2 ** 20) / bytes;
    measured.liveHeapBytesPerSourceByte = Math.round(perByte);
    const allowed = budget.liveHeapBytesPerSourceByte?.value;
    const share = trace.liveHeapMb / limit;
    lines.push(
      `holds ${trace.liveHeapMb} MB at the end of a lowering pass: ${Math.round(perByte)} bytes per source byte` +
        (allowed === undefined ? "" : ` (budget ${allowed}, ${percent(perByte / allowed)})`) +
        `, ${(share * 100).toFixed(0)}% of the ${limit} MB limit (at most ${HEAP_LIMIT_SHARE * 100}%)`,
    );
    if (allowed !== undefined && perByte > allowed * (1 + HEAP_TOLERANCE))
      failures.push(
        `self-compile budget: the live heap is ${Math.round(perByte)} bytes per source byte, ` +
          `${percent(perByte / allowed)} over the budget of ${allowed} (tolerance ${HEAP_TOLERANCE * 100}%). ` +
          `Something stays reachable through lowering that did not before; free it, or set ` +
          `liveHeapBytesPerSourceByte.value to ${Math.round(perByte)} with a reason in ${BUDGET_FILE}`,
      );
    else if (allowed !== undefined && perByte < allowed * (1 - HEAP_TOLERANCE))
      lines.push(
        `the live heap is ${percent(perByte / allowed)} under its budget: lower liveHeapBytesPerSourceByte.value to ${Math.round(perByte)} to keep the gain`,
      );
    if (share > HEAP_LIMIT_SHARE)
      failures.push(
        `self-compile budget: the heap at the end of a lowering pass (${trace.liveHeapMb} MB) fills ${(share * 100).toFixed(0)}% of the ` +
          `${limit} MB heap limit, above ${HEAP_LIMIT_SHARE * 100}%, and runs higher inside the pass; the next growth fails ` +
          `every self-compile with an out-of-memory error. Reduce the heap, or raise heapLimitMb.value in ${BUDGET_FILE} and the ` +
          `--max-old-space-size the self-compile entry points pass (tests/harness/self-compile-budget.test.ts lists them)`,
      );
  }
  return { lines, failures, measured };
}

/** The source-cost allowance a change grants itself: the candidate budget's entry, when it differs
 * from the baseline's. An entry both checkouts share was granted to an earlier change. */
export function sourceCostAllowance(budget, previous) {
  const entry = budget?.sourceCostAllowance;
  if (entry === undefined || same(entry, previous?.sourceCostAllowance)) return 0;
  return typeof entry.value === "number" && entry.value > 0 ? entry.value / 100 : 0;
}

/** Whether a gate run holds the candidate's own compile to the budget: every run whose set has
 * the self program, whichever checkout its programs come from. A run with --programs=candidate
 * already compiles the candidate's source in its compared builds, but those are neither traced
 * nor judged, so the budgeted build is made there too. */
export function judgesSelfCompile(sets, programs) {
  return sets.has("self") && programs.some((program) => program.kind === "source");
}

/** Judge what a change's own source costs to compile. `ratios` are compile times of the
 * candidate's compiler source over the baseline's, both with the candidate compiler in one run;
 * `sourceRatio` is the candidate's source bytes over the baseline's. The smallest ratio is judged:
 * a pass that the source adds shows in every run, a busy host in one. */
export function sourceCostVerdict({ ratios, sourceRatio, allowance = 0 }) {
  const ratio = Math.min(...ratios);
  const excess = ratio / sourceRatio;
  const allowed = 1 + SOURCE_COST_TOLERANCE + allowance;
  const fails = excess > allowed;
  const line =
    `its own source costs ${percent(ratio)} compile time over the baseline's source ` +
    `(${percent(sourceRatio)} source bytes, ${ratios.length} ${ratios.length === 1 ? "pair" : "pairs"}): ` +
    (fails ? "OVER" : "within") +
    ` the ${((allowed - 1) * 100).toFixed(0)}% tolerance`;
  return {
    ratio,
    excess,
    fails,
    line,
    failure: fails
      ? `self-compile budget: the candidate's compiler source takes ${percent(ratio)} longer to compile than the ` +
        `baseline's with the same compiler, for ${percent(sourceRatio)} more source. Something in the new source ` +
        `is expensive to compile (compare SCRIPTC_TIMING=1 phases of the two builds). To accept it, set ` +
        `sourceCostAllowance to { "value": ${Math.ceil((excess - 1 - SOURCE_COST_TOLERANCE) * 100) + 1}, "reason": "<why>" } in ${BUDGET_FILE}`
      : null,
  };
}

/* ── command line ──────────────────────────────────────────────────────── */

/** Run a command, passing its output through, and resolve with the exit status and what it wrote
 * to stderr. */
function run(command, args, options) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["inherit", "inherit", "pipe"], ...options });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (status, signal) => done({ status, signal, stderr }));
  });
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      "native-build": { type: "boolean", default: false },
      record: { type: "boolean", default: false },
      reason: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || values.check === values["native-build"]) {
    console.log(`Usage: node scripts/self-compile-budget.mjs --check [--record --reason=<why>]
       node scripts/self-compile-budget.mjs --native-build [--record --reason=<why>] [-- <build-native-cli arguments>]

--check compiles ${SELF_ENTRY} to LLVM with this checkout's built compiler
(packages/cli/dist/bootstrap.js) and judges the build against ${BUDGET_FILE}:
the whole-program lowering passes it takes, the heap it holds at the end of a pass per
source byte, and the share of the heap limit that heap fills. --native-build runs scripts/build-native-cli.mts
(pnpm build:native-compiler) with the budget's heap limit and judges that build's frontend
the same way; its arguments follow --. Compile time is judged by scripts/zero-cost-gate.mjs,
which has a baseline to pair it with.

--record writes what the run measured into the budget file, with --reason as the reason
of every value it changes. The heap limit and the source-cost allowance are edited by hand.

Exit status: 0 within the budget, 1 over it, the build's own status when it fails.`);
    process.exit(values.help ? 0 : 2);
  }
  const budget = readBudget(root);
  const flags = [`--max-old-space-size=${heapLimitMb(budget)}`, ...HEAP_PROBE_FLAGS];
  const env = { ...process.env, SCRIPTC_TIMING: "1" };
  let result;
  if (values.check) {
    const out = mkdtempSync(join(tmpdir(), "scriptc-self-compile-"));
    try {
      result = await run(
        process.execPath,
        [
          ...flags,
          join(root, "packages/cli/dist/bootstrap.js"),
          "build",
          join(root, SELF_ENTRY),
          "--emit=llvm",
          "-o",
          join(out, "cli.ll"),
        ],
        { cwd: root, env: { ...env, SCRIPTC_NO_CACHE: "1" } },
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  } else
    result = await run(
      process.execPath,
      [...flags, "--import", "tsx", join(root, "scripts/build-native-cli.mts"), ...positionals],
      { cwd: root, env },
    );
  if (result.status !== 0) {
    console.error(`self-compile budget: the build failed (${result.status ?? result.signal})`);
    process.exit(result.status ?? 1);
  }
  const trace = selfCompileTrace(result.stderr);
  const verdict = budgetVerdict({ budget, trace, bytes: sourceBytes(join(root, SELF_ENTRY)) });
  for (const line of verdict.lines) console.log(`self-compile: ${line}`);
  if (values.record) {
    if (budget === null)
      throw new Error(`${BUDGET_FILE} is missing; --record updates an existing budget`);
    if (values.reason === undefined || values.reason.trim() === "")
      throw new Error("--record needs --reason=<why the budget moves>");
    for (const [key, value] of Object.entries(verdict.measured))
      if (!same(budget[key]?.value, value)) budget[key] = { value, reason: values.reason };
    writeFileSync(join(root, BUDGET_FILE), JSON.stringify(budget, null, 2) + "\n");
    console.log(`self-compile: recorded in ${BUDGET_FILE}`);
    process.exit(0);
  }
  for (const failure of verdict.failures) console.error(failure);
  process.exit(verdict.failures.length > 0 ? 1 : 0);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
