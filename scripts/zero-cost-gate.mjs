/* Zero-cost gate: prove that a compiler change leaves good code untouched.
 *
 * Compiles a fixed good-code set with a baseline and a candidate checkout and
 * compares IR, LLVM and release executables byte for byte, plus compile time
 * and binary size, and optionally per-function cachegrind instruction counts.
 * Both checkouts compile the same program files (from --programs, default the
 * baseline), so program paths embedded in artifacts match; checkout paths and
 * timestamps do not reach the artifacts. Builds bypass the native cache.
 *
 * The good-code set: the runtime benchmark workloads (and benchmarks/builds
 * applications), the self-hosted compiler (IR and LLVM), and the TypeScript
 * corpus programs. A program whose sources match --allow (the change's
 * pattern signature) may differ; any other difference fails the gate. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readWorkloads } from "../benchmarks/runtime/workloads.mjs";
import {
  cachegrindCounts,
  compareArtifact,
  compareCounts,
  compareExecutables,
  DYNAMIC_WORKLOADS,
  definedFunctionNames,
  dynamicTierSymbols,
  median,
  nodeIslandSymbols,
  nmOutput,
  programVerdict,
  timeRatio,
} from "./zero-cost-compare.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string", default: repoRoot },
    programs: { type: "string", default: "baseline" },
    set: { type: "string", default: "bench,self,corpus" },
    quick: { type: "boolean", default: false },
    corpus: { type: "string", default: "ts" },
    shard: { type: "string" },
    only: { type: "string" },
    allow: { type: "string" },
    "timing-runs": { type: "string" },
    "self-timing-runs": { type: "string", default: "0" },
    "max-time-growth": { type: "string", default: "2" },
    "max-size-growth": { type: "string", default: "0" },
    cachegrind: { type: "boolean", default: false },
    jobs: { type: "string", default: String(Math.max(1, availableParallelism())) },
    json: { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || values.baseline === undefined) {
  console.log(`Usage: node scripts/zero-cost-gate.mjs --baseline=<checkout> [--candidate=<checkout>]
       [--programs=baseline|candidate|<dir>] [--set=bench,self,corpus] [--quick]
       [--corpus=ts|all] [--shard=i/n] [--only=<regex>] [--allow=<regex>]
       [--timing-runs=N] [--self-timing-runs=N] [--max-time-growth=2]
       [--max-size-growth=0]
       [--cachegrind] [--jobs=N] [--json=<file>] [--keep]

Each checkout must be built (packages/cli/dist/bootstrap.js and this host's
runtime pack). Both compile the same program files, taken from --programs
(default: the baseline checkout).

--set picks the good-code set: bench (benchmarks/runtime workloads and the
benchmarks/builds applications), self (packages/compiler/src/native/cli.ts,
LLVM only), corpus (tests/corpus TypeScript programs; --corpus=all adds
JavaScript entries). --quick is --set=bench --timing-runs=0, for CI.
--shard=i/n keeps every n-th corpus program; --only filters program ids.

--allow=<regex> is the change's pattern signature: programs whose source
files match it may differ (reported as "allowed"). Any other difference in
IR, LLVM or the release executable fails the gate.

--timing-runs=N (default 5) times N paired --emit=llvm builds per bench
program, baseline and candidate side by side. The self-hosted compiler's
comparison build is its first pair; --self-timing-runs adds more. The gate
fails when the 95% bootstrap interval of the bench geomean ratio, or of the
self-hosted ratio, lies entirely above --max-time-growth percent; an interval
that straddles it is reported as inconclusive.
--max-size-growth bounds executable growth (percent) of allowed programs.

Dynamic-tier symbols (two-tier invariant I3): no executable may gain
symbols under DYNAMIC_TIER_PREFIXES (scripts/zero-cost-compare.mjs) unless
it matches --allow, and fully typed bench workloads (all but
DYNAMIC_WORKLOADS in scripts/zero-cost-compare.mjs) may define none.

--cachegrind (Linux, valgrind on PATH) runs differing executables under
cachegrind (bench workloads with their arguments, corpus programs without)
and compares instruction counts per function of the executable's own
symbols, excluding the allocator's prefault thread.

Exit status: 0 when the gate passes, 1 when it fails.`);
  process.exit(values.help ? 0 : 2);
}

const trees = { baseline: resolve(values.baseline), candidate: resolve(values.candidate) };
for (const [label, root] of Object.entries(trees))
  assert.ok(
    existsSync(join(root, "packages/cli/dist/bootstrap.js")),
    `${label} checkout ${root} has no built CLI (packages/cli/dist/bootstrap.js)`,
  );
const programsRoot =
  values.programs === "baseline" || values.programs === "candidate"
    ? trees[values.programs]
    : resolve(values.programs);
const sets = new Set((values.quick ? "bench" : values.set).split(","));
for (const set of sets) assert.ok(["bench", "self", "corpus"].includes(set), `unknown set ${set}`);
const timingRuns = Number(values["timing-runs"] ?? (values.quick ? 0 : 5));
const selfTimingRuns = Number(values["self-timing-runs"]);
const maxTimeGrowth = Number(values["max-time-growth"]) / 100;
const maxSizeGrowth = Number(values["max-size-growth"]) / 100;
const jobs = Number(values.jobs);
assert.ok(Number.isInteger(timingRuns) && timingRuns >= 0, "--timing-runs must be >= 0");
assert.ok(Number.isInteger(jobs) && jobs >= 1, "--jobs must be >= 1");
assert.ok(["ts", "all"].includes(values.corpus), "--corpus must be ts or all");
const only = values.only ? new RegExp(values.only) : null;
const allow = values.allow ? new RegExp(values.allow, "m") : null;
if (values.cachegrind)
  assert.equal(
    spawnSync("valgrind", ["--version"]).status,
    0,
    "--cachegrind needs valgrind on PATH",
  );

const work = mkdtempSync("/tmp/scriptc-zero-cost-");

/* ── the good-code set ─────────────────────────────────────────────────── */

/** Every file a program reads: the entry and its relative imports. */
function programInputs(entry) {
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

function goodCodeSet() {
  const programs = [];
  if (sets.has("bench")) {
    const suite = join(programsRoot, "benchmarks/runtime");
    const seen = new Set();
    for (const w of readWorkloads(suite)) {
      const entry = join(suite, w.entry);
      if (seen.has(entry)) continue;
      seen.add(entry);
      programs.push({ id: `bench/${w.name}`, entry, kind: "exe", workload: w });
    }
  }
  if (sets.has("self"))
    programs.push({
      id: "self/cli",
      entry: join(programsRoot, "packages/compiler/src/native/cli.ts"),
      kind: "source",
    });
  if (sets.has("corpus")) {
    const corpus = join(programsRoot, "tests/corpus");
    const exts = values.corpus === "all" ? ["ts", "js", "mjs", "cjs"] : ["ts"];
    const entries = [];
    for (const name of readdirSync(corpus).sort()) {
      const path = join(corpus, name);
      if (statSync(path).isDirectory()) {
        const main = exts.map((ext) => join(path, `main.${ext}`)).find((p) => existsSync(p));
        if (main !== undefined) entries.push(main);
      } else if (exts.some((ext) => name.endsWith(`.${ext}`))) entries.push(path);
    }
    let selected = entries;
    if (values.shard) {
      const [index, count] = values.shard.split("/").map(Number);
      assert.ok(index >= 1 && index <= count, "--shard must be i/n with 1 <= i <= n");
      selected = entries.filter((_, k) => k % count === index - 1);
    }
    for (const entry of selected) {
      const head = readFileSync(entry, "utf8").split("\n", 2);
      const speed = head.some((line) => /^\/\/ @optimization:\s*speed\s*$/.test(line));
      programs.push({
        id: `corpus/${relative(corpus, entry)}`,
        entry,
        kind: "exe",
        optimization: speed ? "speed" : "release",
      });
    }
  }
  return programs.filter((p) => only === null || only.test(p.id));
}

/* ── builds ────────────────────────────────────────────────────────────── */

function exec(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("close", (status, signal) =>
      resolvePromise({
        status,
        signal,
        stdout,
        stderr,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      }),
    );
  });
}

function buildEnv() {
  const env = { ...process.env, SCRIPTC_NO_CACHE: "1" };
  delete env.SCRIPTC_TIMING;
  delete env.SCRIPTC_CACHE_DIR;
  return env;
}

function compile(tree, args) {
  return exec(
    process.execPath,
    ["--max-old-space-size=8192", join(tree, "packages/cli/dist/bootstrap.js"), "build", ...args],
    { cwd: programsRoot, env: buildEnv() },
  );
}

/** Build one program with one checkout. Executable programs build once,
 * keeping the LLVM and IR beside the release executable. The self-hosted
 * compiler emits LLVM only: each of its frontend runs takes minutes, and its
 * LLVM names the first differing function as well as its IR would. */
async function buildProgram(program, label) {
  const dir = join(work, label, program.id.replace(/[^\w.-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const tree = trees[label];
  const failure = (result) => ({
    ok: false,
    error: (result.stderr || result.stdout || `exit ${result.status ?? result.signal}`)
      .replaceAll(dir, "<out>")
      .trim()
      .slice(0, 4000),
  });
  if (program.kind === "source") {
    const llvm = join(dir, "program.ll");
    const result = await compile(tree, [program.entry, "--emit=llvm", "-o", llvm]);
    if (result.status !== 0) return failure(result);
    return { ok: true, dir, llvm, ms: result.ms };
  }
  const exe = join(dir, "program");
  const result = await compile(tree, [
    program.entry,
    `--optimization=${program.optimization ?? "release"}`,
    "--keep-llvm",
    "--emit-ir",
    "-o",
    exe,
  ]);
  if (result.status !== 0) return failure(result);
  const files = readdirSync(dir);
  const pick = (suffix) => {
    const name = files.find((f) => f.endsWith(suffix));
    return name === undefined ? null : join(dir, name);
  };
  return { ok: true, dir, exe, ir: pick(".ir.json"), llvm: pick(".ll"), ms: result.ms };
}

const nmCache = new Map();
function nm(binary) {
  if (nmCache.has(binary)) return nmCache.get(binary);
  const result = spawnSync("nm", process.platform === "darwin" ? [binary] : ["-S", binary], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const text = nmOutput(binary, result);
  nmCache.set(binary, text);
  return text;
}

/** Names of the functions an executable defines. */
const definedFunctions = (binary) => definedFunctionNames(nm(binary));

/** The I3 symbol check. Every executable may not gain dynamic-tier symbols
 * over the baseline (unless the program matches --allow); a fully typed
 * bench workload may contain none at all. */
function dynamicTierCheck(program, baseline, candidate, artifacts, allowed) {
  if (!baseline.exe || !artifacts.exe) return null;
  const typed = program.id.startsWith("bench/") && !DYNAMIC_WORKLOADS.has(program.id);
  if (artifacts.exe.identical && !typed) return null;
  const after = dynamicTierSymbols(definedFunctions(candidate.exe));
  const before = artifacts.exe.identical
    ? after
    : dynamicTierSymbols(definedFunctions(baseline.exe));
  const added = after.filter((name) => !before.includes(name));
  const failures = [];
  // No good-code program calls into Node.js, so none may link its runtime.
  const nodeIsland = nodeIslandSymbols(definedFunctions(candidate.exe));
  if (nodeIsland.length > 0 && !allowed)
    failures.push(`links Node island symbols: ${nodeIsland.slice(0, 5).join(", ")}`);
  if (typed && after.length > 0)
    failures.push(
      `fully typed program links dynamic-tier symbols: ${after.slice(0, 5).join(", ")}`,
    );
  if (added.length > 0 && !allowed)
    failures.push(`gained dynamic-tier symbols: ${added.slice(0, 5).join(", ")}`);
  return { typed, count: after.length, added, failures };
}

function compareBuilds(baseline, candidate) {
  const artifacts = {};
  for (const kind of ["ir", "llvm"]) {
    if (!(kind in baseline)) continue;
    if (baseline[kind] === null || candidate[kind] === null) {
      artifacts[kind] = { identical: false, first: `missing ${kind} artifact` };
      continue;
    }
    artifacts[kind] = compareArtifact(
      kind,
      readFileSync(baseline[kind]),
      readFileSync(candidate[kind]),
    );
  }
  if (baseline.exe) {
    const a = readFileSync(baseline.exe);
    const b = readFileSync(candidate.exe);
    artifacts.exe = a.equals(b)
      ? { identical: true }
      : compareExecutables(a, b, nm(baseline.exe), nm(candidate.exe));
    artifacts.exe.bytes = { baseline: a.length, candidate: b.length };
  }
  return artifacts;
}

/** Run tasks with at most `jobs` at a time; heavy tasks run alone. */
async function pool(tasks) {
  const results = new Array(tasks.length);
  let next = 0;
  let running = 0;
  let heavy = false;
  await new Promise((done) => {
    const pump = () => {
      if (next === tasks.length && running === 0) return done();
      while (next < tasks.length && running < jobs && !heavy) {
        const task = tasks[next];
        if (task.heavy && running > 0) break;
        const index = next++;
        running++;
        if (task.heavy) heavy = true;
        task.run().then((value) => {
          results[index] = value;
          running--;
          if (task.heavy) heavy = false;
          pump();
        });
      }
    };
    pump();
  });
  return results;
}

/* ── cachegrind ────────────────────────────────────────────────────────── */

async function instructionCounts(binary, args, out) {
  const result = await exec("valgrind", [
    "--tool=cachegrind",
    "--cache-sim=no",
    `--cachegrind-out-file=${out}`,
    binary,
    ...args,
  ]);
  // Corpus programs may exit non-zero on purpose (`// @exit: 1`).
  if (result.signal !== null || !existsSync(out)) return null;
  return cachegrindCounts(readFileSync(out, "utf8"), new Set(definedFunctions(binary)));
}

/* ── main ──────────────────────────────────────────────────────────────── */

function revision(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const dirty = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  });
  return r.stdout.trim() + (dirty.stdout.trim() ? "+dirty" : "");
}

const fmtMs = (ms) => `${(ms / 1000).toFixed(2)}s`;
const pct = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}%`;

const programs = goodCodeSet();
assert.ok(programs.length > 0, "the selected good-code set is empty");
const report = {
  schema: 1,
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  trees: Object.fromEntries(
    Object.entries(trees).map(([label, root]) => [label, { root, revision: revision(root) }]),
  ),
  programsRoot,
  allow: values.allow ?? null,
  programs: [],
  timing: null,
  failures: [],
};
console.log(
  `zero-cost gate: ${programs.length} programs (${[...sets].join(", ")}), ` +
    `baseline ${trees.baseline}, candidate ${trees.candidate}, programs from ${programsRoot}`,
);

let failed = false;
const started = Date.now();
await pool(
  programs.map((program) => ({
    heavy: program.kind === "source",
    run: async () => {
      const [baseline, candidate] = await Promise.all([
        buildProgram(program, "baseline"),
        buildProgram(program, "candidate"),
      ]);
      const allowed =
        allow !== null &&
        programInputs(program.entry).some((f) => allow.test(readFileSync(f, "utf8")));
      const artifacts = baseline.ok && candidate.ok ? compareBuilds(baseline, candidate) : {};
      // The benchmark workloads and the self-hosted compiler always build.
      const required = !program.id.startsWith("corpus/");
      const { verdict, fails } = programVerdict({
        baseline,
        candidate,
        artifacts,
        allowed,
        required,
      });
      const entry = {
        id: program.id,
        verdict,
        allowed,
        buildMs: { baseline: baseline.ms ?? null, candidate: candidate.ms ?? null },
        artifacts,
      };
      if (!baseline.ok) entry.baselineError = baseline.error;
      if (!candidate.ok) entry.candidateError = candidate.error;
      const size = artifacts.exe?.bytes;
      if (verdict === "allowed" && size && size.candidate > size.baseline * (1 + maxSizeGrowth)) {
        entry.sizeFailure = true;
        report.failures.push(
          `${program.id}: executable grew ${size.baseline} -> ${size.candidate} bytes`,
        );
      }
      if (fails) report.failures.push(`${program.id}: ${verdict}`);
      const symbols =
        baseline.ok && candidate.ok
          ? dynamicTierCheck(program, baseline, candidate, artifacts, allowed)
          : null;
      if (symbols !== null) entry.dynamicTier = symbols;
      for (const failure of symbols?.failures ?? [])
        report.failures.push(`${program.id}: ${failure}`);
      if (fails || entry.sizeFailure || symbols?.failures.length) failed = true;
      if (values.cachegrind && artifacts.exe && !artifacts.exe.identical) {
        // Bench workloads run with their benchmark arguments; corpus
        // programs take none.
        const w = program.workload ?? { args: [] };
        if (w.kind === "server" || w.args.includes("{input}"))
          entry.cachegrind = { skipped: "needs a server client or generated input" };
        else {
          const counts = await Promise.all([
            instructionCounts(baseline.exe, w.args, join(baseline.dir, "cg.out")),
            instructionCounts(candidate.exe, w.args, join(candidate.dir, "cg.out")),
          ]);
          entry.cachegrind = counts.includes(null)
            ? { skipped: "valgrind run failed" }
            : (({ deltas, ...rest }) => ({ ...rest, deltas: deltas.slice(0, 20) }))(
                compareCounts(counts[0], counts[1]),
              );
        }
      }
      printProgram(entry);
      report.programs.push(entry);
      nmCache.delete(baseline.exe);
      nmCache.delete(candidate.exe);
      if (!values.keep) {
        if (baseline.dir) rmSync(baseline.dir, { recursive: true, force: true });
        if (candidate.dir) rmSync(candidate.dir, { recursive: true, force: true });
      }
    },
  })),
);

function printProgram(entry) {
  const label = {
    identical: "identical",
    allowed: "allowed  ",
    differs: "DIFFERS  ",
    "build-error": "ERROR    ",
    "both-fail": "both-fail",
  }[entry.verdict];
  const notes = [];
  for (const [kind, result] of Object.entries(entry.artifacts))
    if (!result.identical) {
      const counts = result.changed
        ? ` (${result.changed.length} changed, ${result.added.length} added, ${result.removed.length} removed)`
        : "";
      notes.push(`${kind}: ${result.first}${counts}`);
    }
  const size = entry.artifacts.exe?.bytes;
  if (size && size.baseline !== size.candidate)
    notes.push(
      `size ${size.baseline} -> ${size.candidate} B (${pct(size.candidate / size.baseline)})`,
    );
  if (entry.cachegrind?.total) {
    const { total, deltas } = entry.cachegrind;
    notes.push(
      `Ir ${total.baseline} -> ${total.candidate} (${pct(total.candidate / Math.max(1, total.baseline))})` +
        (deltas[0]
          ? `, largest ${deltas[0].name} ${deltas[0].delta > 0 ? "+" : ""}${deltas[0].delta}`
          : ""),
    );
  } else if (entry.cachegrind?.skipped)
    notes.push(`cachegrind skipped: ${entry.cachegrind.skipped}`);
  for (const failure of entry.dynamicTier?.failures ?? []) notes.push(`SYMBOLS: ${failure}`);
  console.log(`${label}  ${entry.id}${notes.length ? `  ${notes.join("; ")}` : ""}`);
  // A build error's first line is often a warning; print all of it.
  const errors =
    entry.baselineError !== undefined && entry.baselineError === entry.candidateError
      ? [["baseline and candidate", entry.baselineError]]
      : [
          ["baseline", entry.baselineError],
          ["candidate", entry.candidateError],
        ].filter(([, error]) => error !== undefined);
  for (const [side, error] of errors) {
    console.log(`           ${side}:`);
    for (const line of error.split("\n")) console.log(`             ${line}`);
  }
}

/* Compile time: paired --emit=llvm builds, the baseline and the candidate
 * side by side, one program at a time. Identical LLVM means everything after
 * emission (LLVM optimization, linking) costs the same, so the timed part is
 * the compiler's own work. The self-hosted compiler takes minutes per build;
 * its main comparison build is its first pair. */
if (timingRuns > 0) {
  const rows = [];
  const pair = async (program) => {
    const [baseline, candidate] = await Promise.all(
      ["baseline", "candidate"].map((label) =>
        compile(trees[label], [
          program.entry,
          "--emit=llvm",
          "-o",
          join(work, `timing-${label}.ll`),
        ]),
      ),
    );
    return baseline.status === 0 && candidate.status === 0 ? [baseline.ms, candidate.ms] : null;
  };
  for (const program of programs) {
    if (program.id.startsWith("corpus/")) continue;
    const row = { id: program.id, baselineMs: [], candidateMs: [], ratios: [] };
    const add = (sample) => {
      if (sample === null) return;
      row.baselineMs.push(Math.round(sample[0]));
      row.candidateMs.push(Math.round(sample[1]));
      row.ratios.push(sample[1] / sample[0]);
    };
    const runs = program.kind === "source" ? selfTimingRuns : timingRuns;
    if (program.kind === "source") {
      const built = report.programs.find((p) => p.id === program.id)?.buildMs;
      if (built?.baseline && built?.candidate) add([built.baseline, built.candidate]);
    }
    for (let run = 0; run < runs; run++) add(await pair(program));
    if (row.ratios.length === 0) continue;
    rows.push(row);
    console.log(
      `time       ${program.id}  ${fmtMs(median(row.baselineMs))} -> ${fmtMs(median(row.candidateMs))} ` +
        `(${pct(median(row.ratios))}, ${row.ratios.length} pairs)`,
    );
  }
  report.timing = { runs: timingRuns, maxGrowth: maxTimeGrowth, rows, groups: {} };
  const groups = {
    bench: rows.filter((r) => r.id.startsWith("bench/")),
    self: rows.filter((r) => r.id === "self/cli"),
  };
  for (const [name, group] of Object.entries(groups)) {
    if (group.length === 0) continue;
    const result = timeRatio(group);
    report.timing.groups[name] = result;
    const verdict =
      result.low > 1 + maxTimeGrowth
        ? "SLOWER"
        : result.high > 1 + maxTimeGrowth
          ? "inconclusive (rerun with more runs)"
          : "within tolerance";
    console.log(
      `time       ${name} ${group.length > 1 ? "geomean " : ""}${pct(result.ratio)} ` +
        `[95% CI ${pct(result.low)}, ${pct(result.high)}]: ${verdict}`,
    );
    if (result.low > 1 + maxTimeGrowth) {
      failed = true;
      report.failures.push(
        `${name} compile time grew ${pct(result.ratio)} (CI low ${pct(result.low)})`,
      );
    }
  }
}

const counts = {};
for (const p of report.programs) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
if (!report.programs.some((p) => ["identical", "allowed", "differs"].includes(p.verdict))) {
  failed = true;
  report.failures.push("no program built with both checkouts, so nothing was compared");
}
report.counts = counts;
report.verdict = failed ? "fail" : "pass";
report.elapsedMs = Date.now() - started;
if (values.json) {
  mkdirSync(dirname(resolve(values.json)), { recursive: true });
  writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n");
}
if (!values.keep) rmSync(work, { recursive: true, force: true });
else console.log(`artifacts kept in ${work}`);
console.log(
  `zero-cost gate: ${failed ? "FAIL" : "PASS"} — ${Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")} in ${fmtMs(report.elapsedMs)}`,
);
for (const failure of report.failures) console.log(`  ${failure}`);
process.exit(failed ? 1 : 0);
