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
 *   outputGrowthAllowance       Percent the compiler's own LLVM may grow beyond its share of
 *                               source bytes, for the change that sets it: the gate compares the
 *                               candidate's compiler source with the baseline's, both built by
 *                               the candidate, by LLVM bytes, by functions and by the functions
 *                               of the dynamic tier. The three are exact for a source, so the
 *                               bound is tight. One untyped view of a compiler type is enough
 *                               to move them: #2878 added 6.4% of the compiler's functions with
 *                               0.2% more source, and nothing reported it for five days.
 *   neverDynamicClasses         The compiler's classes whose instances must not become dynamic
 *                               values in its own build, by name. Exact, and a state, not a
 *                               growth: the build reports every place that makes an instance of
 *                               one a dynamic value (SCRIPTC_DYNAMIC_CLASSES,
 *                               frontend/lowering/dynamic-class-report.ts), and one place fails
 *                               the budget, with the place. The output-growth rule above sees
 *                               the first such place and not a second one that lands while the
 *                               first is in; the Lowerer became a dynamic value three times in
 *                               five days (#2878, #3192, #2567), each through one helper whose
 *                               parameter was an interface the class satisfies.
 *
 * Why the live heap is the number to watch: lowering holds the whole lowered program, so the heap
 * follows the program's size (about 5 MB live per MB of LLVM emitted), and the compiler is the
 * largest program it compiles.
 *
 * Every entry is { value, reason }. A change that moves a value states why in its reason: the gate
 * fails a value that differs from the baseline checkout's with an unchanged reason. */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** How far the compiler's own LLVM may grow beyond the growth of its source in one change: its
 * bytes and its functions. Both are exact for a source and a compiler. Between 102 pairs of
 * commits of main from 2026-10-26 to 2026-11-07 (ten commits apart, 36 of them adjacent), the
 * functions grew beyond the source by -0.02% at the median, 0.51% at the 95th percentile and
 * 0.79% at most, and the bytes by 0.54% at the 95th percentile, except for #2878 (6.36% and
 * 2.49% in one commit, an untyped view that made the Lowerer a dynamic value) and #3190 (the
 * LLVM doubled, the same way). */
export const OUTPUT_GROWTH_TOLERANCE = 0.01;
/** How far the dynamic tier's functions in the compiler's own LLVM may grow in one change, and
 * the count below which a change in them is not judged. The compiler is typed code: these are
 * the converters, matchers, function boxes and keyed class helpers of the places where it
 * handles untyped data (JSON, a package manifest), and they move when a compiler type becomes
 * reachable from one. #2878 added 52% of them. */
export const DYNAMIC_TIER_GROWTH_TOLERANCE = 0.05;
export const DYNAMIC_TIER_GROWTH_FLOOR = 100;
/** How many places of a class that became a dynamic value a failure lists. One helper's
 * parameter type is usually behind all of them (27 callers of one function, for #2567). */
export const DYNAMIC_CLASS_SITES_SHOWN = 40;

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

/** The classes a budget keeps out of the dynamic tier of the compiler's own build. */
export function neverDynamicClasses(budget) {
  const value = budget?.neverDynamicClasses?.value;
  return Array.isArray(value) ? value : [];
}

/** The environment that makes a self-compile report on the budget's classes: empty when the
 * budget names none. */
export function dynamicClassesEnv(budget) {
  const names = neverDynamicClasses(budget);
  return names.length === 0 ? {} : { SCRIPTC_DYNAMIC_CLASSES: names.join(",") };
}

/** What a self-compile's stderr says about the classes it was asked about
 * (SCRIPTC_DYNAMIC_CLASSES): the names it answered for and the places that make an instance of
 * one a dynamic value, or null when the build printed no report. Every lowering pass that runs
 * to its end closes a report with a `scriptc dynamic-classes` line; the last one is the
 * program's, and the `scriptc dynamic-class` lines before it are its places. */
export function dynamicClassReport(stderr) {
  let report = null;
  let pending = [];
  for (const match of stderr.matchAll(/^scriptc (dynamic-class|dynamic-classes) (\{.*\})$/gm)) {
    let event;
    try {
      event = JSON.parse(match[2]);
    } catch {
      continue;
    }
    if (match[1] === "dynamic-class") pending.push(event);
    else if (Array.isArray(event.names)) {
      report = { names: event.names, sites: pending };
      pending = [];
    }
  }
  return report;
}

/** One reported place, as a line: where, what happens there, and the source line. */
function dynamicClassSiteLine(site, root) {
  const file =
    typeof site.file !== "string"
      ? null
      : root !== undefined && site.file.startsWith(root)
        ? site.file.slice(root.length).replace(/^\/+/, "")
        : site.file;
  const where =
    file === null
      ? "(no position)"
      : `${file}${site.line === undefined ? "" : `:${site.line}:${site.column}`}`;
  const what =
    site.kind === "dynamic"
      ? `a ${site.name}${site.through === undefined ? "" : ` inside ${site.through}`} becomes a dynamic value`
      : site.kind === "argument"
        ? `a dynamic function is called with a ${site.name}${site.through === undefined ? "" : ` inside ${site.through}`}`
        : site.kind === "cast"
          ? `a dynamic value is checked into ${site.name}`
          : `${site.name} is among the classes whose instances are dynamic values, with no place listed`;
  return `${where}: ${what}${typeof site.text === "string" && site.text !== "" ? `  |  ${site.text}` : ""}`;
}

const percent = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Judge one self-compile against the budget of the checkout whose source it compiled.
 * `trace` is selfCompileTrace's result, `bytes` the program's source bytes, `previous` the
 * baseline checkout's budget (null without one), `dynamicClasses` dynamicClassReport's result
 * (null or absent when the build printed none) and `root` the checkout its places are named
 * against. Returns the report lines, the failures, and `measured`: the values the run would
 * record. */
export function budgetVerdict({
  budget,
  previous = null,
  trace,
  bytes,
  dynamicClasses = null,
  root,
}) {
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

  // The classes kept typed: a list that changed says why, and the list does not go away.
  const kept = budget.neverDynamicClasses;
  if (kept === undefined) {
    if (previous?.neverDynamicClasses !== undefined)
      failures.push(
        `self-compile budget: neverDynamicClasses was removed; the baseline lists ` +
          `${JSON.stringify(previous.neverDynamicClasses.value)} (${BUDGET_FILE})`,
      );
  } else if (
    !Array.isArray(kept.value) ||
    kept.value.some((name) => typeof name !== "string" || name === "") ||
    typeof kept.reason !== "string" ||
    kept.reason.trim() === ""
  )
    failures.push(
      `self-compile budget: neverDynamicClasses needs a list of class names and a reason (${BUDGET_FILE})`,
    );
  else if (
    previous?.neverDynamicClasses !== undefined &&
    !same(previous.neverDynamicClasses.value, kept.value) &&
    previous.neverDynamicClasses.reason === kept.reason
  )
    failures.push(
      `self-compile budget: neverDynamicClasses changed from ${JSON.stringify(previous.neverDynamicClasses.value)} to ` +
        `${JSON.stringify(kept.value)} with the old reason; say why in its reason (${BUDGET_FILE})`,
    );

  const granted = budget.sourceCostAllowance;
  if (
    granted !== undefined &&
    granted.value > 0 &&
    !same(granted, previous?.sourceCostAllowance) &&
    (typeof granted.reason !== "string" || granted.reason.trim() === "")
  )
    failures.push(`self-compile budget: sourceCostAllowance needs a reason (${BUDGET_FILE})`);

  const growth = budget.outputGrowthAllowance;
  if (
    growth !== undefined &&
    growth.value > 0 &&
    !same(growth, previous?.outputGrowthAllowance) &&
    (typeof growth.reason !== "string" || growth.reason.trim() === "")
  )
    failures.push(`self-compile budget: outputGrowthAllowance needs a reason (${BUDGET_FILE})`);

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

  const names = neverDynamicClasses(budget);
  if (names.length > 0) {
    const listed = names.join(", ");
    const answered =
      dynamicClasses !== null && names.every((name) => dynamicClasses.names.includes(name));
    if (!answered)
      lines.push(
        `dynamic classes: not reported for ${listed} (the build ran without SCRIPTC_DYNAMIC_CLASSES, or did not lower)`,
      );
    else {
      const sites = dynamicClasses.sites.filter((site) => names.includes(site.name));
      if (sites.length === 0)
        lines.push(`keeps ${listed} out of the dynamic tier: no instance becomes a dynamic value`);
      else {
        const classes = [...new Set(sites.map((site) => site.name))].join(", ");
        const shown = sites.slice(0, DYNAMIC_CLASS_SITES_SHOWN);
        const places = shown.map((site) => `  ${dynamicClassSiteLine(site, root)}`);
        if (sites.length > shown.length)
          places.push(`  and ${sites.length - shown.length} more (the build's stderr lists them)`);
        lines.push(
          `${classes} ${sites.length === 1 ? "becomes a dynamic value in 1 place" : `becomes a dynamic value in ${sites.length} places`} of its own source`,
        );
        failures.push(
          `self-compile budget: ${classes} must not be a dynamic value in the compiler's own build ` +
            `(neverDynamicClasses, ${BUDGET_FILE}), and ${sites.length === 1 ? "1 place makes" : `${sites.length} places make`} it one:\n` +
            `${places.join("\n")}\n` +
            `A class instance handed over where an interface or a record type with a method is declared, or ` +
            `where \`unknown\`, \`any\` or a type parameter is, is converted to a dynamic value, and the class and ` +
            `every class its fields reach are then compiled for untyped code as well (the Lowerer: 6% of the ` +
            `compiler's functions). Hand over what the callee reads instead: a record built once, a function, ` +
            `or the class itself as the parameter's type.`,
        );
      }
    }
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

/** The output-growth allowance a change grants itself, as sourceCostAllowance does for time. */
export function outputGrowthAllowance(budget, previous) {
  const entry = budget?.outputGrowthAllowance;
  if (entry === undefined || same(entry, previous?.outputGrowthAllowance)) return 0;
  return typeof entry.value === "number" && entry.value > 0 ? entry.value / 100 : 0;
}

/** A function of the dynamic tier, by the name the emitter gives it: a converter between a typed
 * value and a dynamic one (sc_dc_, sc_dm_, sc_td_), a function box or thunk (sc_dfb_, sc_dfk_,
 * sc_dfa_, sc_dfu_), a live reference adapter (sc_ldr_, sc_ldu_), or a lifted `%dyn.` helper
 * such as the keyed tables of a class whose instances can be dynamic values. */
const DYNAMIC_TIER_FUNCTION = /^"?(?:sc_(?:dc|dm|td|dfb|dfk|dfa|dfu|ldr|ldu)_\d|sc_b?f__x25_dyn_)/;

/** What an LLVM text says about its size: its bytes, the functions it defines, and how many of
 * them belong to the dynamic tier. Reads the file in pieces: the compiler's own is a gigabyte. */
export function llvmFacts(file) {
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1 << 22);
  let bytes = 0;
  let functions = 0;
  let dynamicTier = 0;
  let rest = "";
  const line = (text) => {
    if (!text.startsWith("define ")) return;
    functions++;
    const at = text.indexOf("@");
    if (at >= 0 && DYNAMIC_TIER_FUNCTION.test(text.slice(at + 1, at + 64))) dynamicTier++;
  };
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      // Function names are ASCII, and a multi-byte character cut by a piece's end can only
      // sit inside a line that is not a definition's first 64 characters.
      const text = rest + buffer.latin1Slice(0, read);
      let from = 0;
      for (;;) {
        const end = text.indexOf("\n", from);
        if (end < 0) break;
        line(text.slice(from, Math.min(end, from + 512)));
        from = end + 1;
      }
      rest = text.slice(from);
    }
    if (rest !== "") line(rest);
  } finally {
    closeSync(fd);
  }
  return { bytes, functions, dynamicTier };
}

/** Judge how the compiler's own LLVM grew with a change. `candidate` and `baseline` are
 * llvmFacts of the candidate's and the baseline's compiler source, both built by the candidate
 * compiler; `sourceRatio` is the candidate's source bytes over the baseline's. */
export function outputGrowthVerdict({ candidate, baseline, sourceRatio, allowance = 0 }) {
  const lines = [];
  const failures = [];
  const allowed = 1 + OUTPUT_GROWTH_TOLERANCE + allowance;
  const measures = [
    ["LLVM bytes", candidate.bytes, baseline.bytes],
    ["functions", candidate.functions, baseline.functions],
  ];
  let worst = 1;
  for (const [what, now, before] of measures) {
    const excess = now / before / sourceRatio;
    worst = Math.max(worst, excess);
    lines.push(
      `its own source compiles to ${now} ${what}, ${percent(now / before)} over the baseline's source ` +
        `(${percent(sourceRatio)} source bytes): ${excess > allowed ? "OVER" : "within"} the ` +
        `${((allowed - 1) * 100).toFixed(0)}% tolerance`,
    );
    if (excess > allowed)
      failures.push(
        `self-compile budget: the candidate's compiler source compiles to ${percent(now / before)} more ${what} than ` +
          `the baseline's (${before} to ${now}) for ${percent(sourceRatio)} more source. A change this size adds its ` +
          `share; several times that usually means a compiler type became a dynamic value (an \`any\` or ` +
          `Record<string, unknown> view of it, a class instance passed where a record type with other members ` +
          `is expected). \`scriptc coverage ${SELF_ENTRY} --explain-dynamic\` on both checkouts lists the ` +
          `functions that became dynamic. To accept it, set outputGrowthAllowance to ` +
          `{ "value": ${Math.ceil((excess - 1 - OUTPUT_GROWTH_TOLERANCE) * 100) + 1}, "reason": "<why>" } in ${BUDGET_FILE}`,
      );
  }
  const grown = candidate.dynamicTier - baseline.dynamicTier;
  const dynamicAllowed = 1 + DYNAMIC_TIER_GROWTH_TOLERANCE + allowance;
  const dynamicOver =
    grown > DYNAMIC_TIER_GROWTH_FLOOR &&
    candidate.dynamicTier / Math.max(1, baseline.dynamicTier) > dynamicAllowed;
  lines.push(
    `${candidate.dynamicTier} of its functions belong to the dynamic tier (${grown >= 0 ? "+" : ""}${grown} against the ` +
      `baseline's source): ${dynamicOver ? "OVER" : "within"} the ${((dynamicAllowed - 1) * 100).toFixed(0)}% tolerance`,
  );
  if (dynamicOver) {
    const ratio = candidate.dynamicTier / Math.max(1, baseline.dynamicTier);
    worst = Math.max(worst, ratio);
    failures.push(
      `self-compile budget: the dynamic tier of the compiler's own build grew from ${baseline.dynamicTier} to ` +
        `${candidate.dynamicTier} functions (${percent(ratio)}). The compiler handles untyped data in a few places; ` +
        `this many new converters and keyed helpers mean one of its own types now reaches them. ` +
        `\`scriptc coverage ${SELF_ENTRY} --explain-dynamic\` on both checkouts lists what became dynamic. ` +
        `To accept it, set outputGrowthAllowance to { "value": ${Math.ceil((ratio - 1 - DYNAMIC_TIER_GROWTH_TOLERANCE) * 100) + 1}, "reason": "<why>" } in ${BUDGET_FILE}`,
    );
  }
  return { lines, failures, worst };
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
source byte, the share of the heap limit that heap fills, and that no instance of a class the
budget lists becomes a dynamic value. --native-build runs scripts/build-native-cli.mts
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
  const env = { ...process.env, SCRIPTC_TIMING: "1", ...dynamicClassesEnv(budget) };
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
  const dynamicClasses = dynamicClassReport(result.stderr);
  const verdict = budgetVerdict({
    budget,
    trace,
    bytes: sourceBytes(join(root, SELF_ENTRY)),
    dynamicClasses,
    root,
  });
  // This build was asked for the report, so a build without one was not judged: a frontend
  // that did not run (a cached build), or a compiler that does not know the variable.
  const names = neverDynamicClasses(budget);
  if (
    names.length > 0 &&
    (dynamicClasses === null || !names.every((name) => dynamicClasses.names.includes(name)))
  )
    verdict.failures.push(
      `self-compile budget: the build did not report on ${names.join(", ")} (neverDynamicClasses, ${BUDGET_FILE}), ` +
        `so they were not checked. The report is printed when the frontend lowers the compiler's source with ` +
        `SCRIPTC_DYNAMIC_CLASSES set; a build that takes its frontend from a cache prints none`,
    );
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
