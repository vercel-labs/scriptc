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
import { createHash } from "node:crypto";
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
import { availableParallelism, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readWorkloads } from "../benchmarks/runtime/workloads.mjs";
import {
  artifactHash,
  cachedComparison,
  cachegrindCounts,
  compareArtifact,
  compareCounts,
  compareExecutables,
  DYNAMIC_WORKLOADS,
  definedFunctionNames,
  dynamicTierSymbols,
  median,
  nmOutput,
  programInputsHash,
  programLines,
  programVerdict,
  recordedBaseline,
  timingGroups,
  timingVerdict,
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
    "baseline-cache": { type: "string" },
    "record-baseline-cache": { type: "string" },
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
       [--baseline-cache=<file>] [--record-baseline-cache=<file>]

Each checkout must be built (packages/cli/dist/bootstrap.js and this host's
runtime pack). Both compile the same program files, taken from --programs
(default: the baseline checkout).

--set picks the good-code set: bench (benchmarks/runtime workloads and the
benchmarks/builds applications), self (packages/compiler/src/native/cli.ts,
LLVM only; the candidate's own compiler source must also build with the
candidate), corpus (tests/corpus TypeScript programs; --corpus=all adds
JavaScript entries). --quick is --set=bench --timing-runs=0, for CI.
--shard=i/n keeps every n-th bench and corpus program; the self program runs
in shard 1. scripts/zero-cost-merge.mjs merges the shards' --json reports
into one verdict. --only filters program ids.

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

--record-baseline-cache=<file> builds only the baseline and records each
program's artifact hashes (or build error) in <file>, with a hash of the
program's inputs (its entry, its relative imports and its optimization
level), then exits.
--baseline-cache=<file> reads such a record: a program whose candidate
artifacts hash the same as the recorded baseline's is identical without a
baseline build, and the same build error on both sides is both-fail; any
other program builds the baseline as usual, and so does a program whose
inputs changed since the record. The record applies only to the
baseline revision and toolchain it was made with; otherwise it is ignored.
The self program always builds both sides, since its builds are timed.

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
    for (const entry of entries) {
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
  const selected = programs.filter((p) => only === null || only.test(p.id));
  if (!values.shard) return selected;
  const [index, count] = values.shard.split("/").map(Number);
  assert.ok(
    Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count,
    "--shard must be i/n with 1 <= i <= n",
  );
  // The self program takes minutes and pairs its own timing: shard 1 owns it.
  const self = selected.filter((p) => p.kind === "source");
  const rest = selected.filter((p) => p.kind !== "source");
  return [...(index === 1 ? self : []), ...rest.filter((_, k) => k % count === index - 1)];
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

/* ── baseline cache ────────────────────────────────────────────────────── */

/** Every file under `dir`, recursively, in a stable order. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/** What a baseline build depends on besides the program: the checkout's
 * built compiler and CLI, its runtime packs and LLVM helpers, Node, the
 * host and the program and checkout paths that reach the artifacts. */
function toolchainFingerprint(root) {
  const h = createHash("sha1");
  h.update(JSON.stringify([process.platform, process.arch, process.version, root, programsRoot]));
  const clang = spawnSync("clang", ["--version"], { encoding: "utf8" });
  h.update(clang.stdout ?? "");
  // Linux links use ld.lld when the driver finds it, else the system linker.
  const lld = spawnSync("clang", ["-print-prog-name=ld.lld"], { encoding: "utf8" });
  const lldPath = (lld.stdout ?? "").trim();
  h.update(lldPath);
  if (lldPath.startsWith("/") && existsSync(lldPath))
    h.update(spawnSync(lldPath, ["--version"], { encoding: "utf8" }).stdout ?? "");
  const packages = join(root, "packages");
  for (const name of readdirSync(packages).sort()) {
    const dir = join(packages, name);
    const files = [
      ...filesUnder(join(dir, "dist")),
      ...(name.startsWith("runtime-")
        ? [join(dir, "runtime-pack.json"), ...filesUnder(join(dir, "artifacts"))]
        : []),
      ...(name.startsWith("llvm-") ? filesUnder(join(dir, "bin")) : []),
    ];
    for (const file of files)
      if (existsSync(file)) h.update(relative(root, file)).update(readFileSync(file));
  }
  return h.digest("hex");
}

/** The hash of `program`'s inputs, which its baseline cache entry records. */
function inputsHash(program) {
  return programInputsHash(
    programsRoot,
    programInputs(program.entry),
    program.kind === "source" ? "source" : (program.optimization ?? "release"),
    (file) => readFileSync(file),
  );
}

/** The content hashes of one build's artifacts (null for a missing one). */
function buildHashes(build) {
  const hashes = {};
  for (const kind of ["ir", "llvm", "exe"])
    if (kind in build)
      hashes[kind] = build[kind] === null ? null : artifactHash(readFileSync(build[kind]));
  return hashes;
}

const recordPath = values["record-baseline-cache"];
let baselineCache = null;
if (recordPath === undefined && values["baseline-cache"] !== undefined) {
  const file = resolve(values["baseline-cache"]);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const fingerprint = cache === null ? null : toolchainFingerprint(trees.baseline);
  if (cache?.schema === 2 && cache.fingerprint === fingerprint) baselineCache = cache;
  else
    console.log(
      `baseline cache ${file} ${cache === null ? "is missing" : "was made with another baseline or toolchain"}; building every baseline`,
    );
}

const programs = goodCodeSet().filter((p) => recordPath === undefined || p.kind !== "source");
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
  // Failures judged over the whole good-code set (compile time, nothing
  // compared); scripts/zero-cost-merge.mjs recomputes them across shards.
  globalFailures: [],
  baselineCache:
    baselineCache === null
      ? null
      : { programs: Object.keys(baselineCache.programs).length, used: 0 },
};
console.log(
  `zero-cost gate: ${programs.length} programs (${[...sets].join(", ")}), ` +
    `baseline ${trees.baseline}, candidate ${trees.candidate}, programs from ${programsRoot}`,
);

let failed = false;
const started = Date.now();

if (recordPath !== undefined) {
  const record = {
    schema: 2,
    date: report.date,
    fingerprint: toolchainFingerprint(trees.baseline),
    baseline: report.trees.baseline,
    programs: {},
  };
  await pool(
    programs.map((program) => ({
      run: async () => {
        const build = await buildProgram(program, "baseline");
        const inputs = inputsHash(program);
        record.programs[program.id] = build.ok
          ? {
              inputs,
              ok: true,
              ms: build.ms,
              hashes: buildHashes(build),
              ...(build.exe ? { exeBytes: statSync(build.exe).size } : {}),
            }
          : { inputs, ok: false, ms: build.ms ?? null, error: build.error };
        if (build.dir) rmSync(build.dir, { recursive: true, force: true });
      },
    })),
  );
  mkdirSync(dirname(resolve(recordPath)), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record) + "\n");
  rmSync(work, { recursive: true, force: true });
  const failures = Object.values(record.programs).filter((p) => !p.ok).length;
  console.log(
    `zero-cost gate: recorded ${programs.length} baseline programs (${failures} build errors) ` +
      `in ${recordPath} in ${fmtMs(Date.now() - started)}`,
  );
  process.exit(0);
}

/** The candidate's own compiler source must still build with the candidate
 * (see below). On a host with room for a third self-hosted build it runs
 * alongside the comparison builds instead of after them. */
const checkCandidateSelf =
  sets.has("self") && programsRoot !== trees.candidate && programs.some((p) => p.kind === "source");
const buildCandidateSelf = () =>
  buildProgram(
    {
      id: "self/candidate-source",
      entry: join(trees.candidate, "packages/compiler/src/native/cli.ts"),
      kind: "source",
    },
    "candidate",
  );
const earlyCandidateSelf =
  checkCandidateSelf && totalmem() >= 40 * 1024 ** 3 ? buildCandidateSelf() : null;

await pool(
  programs.map((program) => ({
    heavy: program.kind === "source",
    run: async () => {
      const recorded =
        program.kind === "source" || baselineCache === null
          ? undefined
          : recordedBaseline(baselineCache, program.id, inputsHash(program));
      let baseline;
      let candidate;
      let settled = null;
      if (recorded === undefined)
        [baseline, candidate] = await Promise.all([
          buildProgram(program, "baseline"),
          buildProgram(program, "candidate"),
        ]);
      else {
        candidate = await buildProgram(program, "candidate");
        settled = cachedComparison(recorded, candidate, candidate.ok ? buildHashes(candidate) : {});
        // A cached identical baseline has the candidate's artifacts.
        baseline =
          settled === null
            ? await buildProgram(program, "baseline")
            : settled.baseline.ok
              ? { ...candidate, ms: settled.baseline.ms, cached: true }
              : settled.baseline;
        if (settled !== null) report.baselineCache.used++;
      }
      const allowed =
        allow !== null &&
        programInputs(program.entry).some((f) => allow.test(readFileSync(f, "utf8")));
      const artifacts =
        settled?.artifacts ??
        (baseline.ok && candidate.ok ? compareBuilds(baseline, candidate) : {});
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
      if (settled !== null) entry.cachedBaseline = true;
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
        if (baseline.dir && !baseline.cached)
          rmSync(baseline.dir, { recursive: true, force: true });
        if (candidate.dir) rmSync(candidate.dir, { recursive: true, force: true });
      }
    },
  })),
);

function printProgram(entry) {
  for (const line of programLines(entry)) console.log(line);
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
  for (const [name, group] of Object.entries(timingGroups(rows))) {
    if (group.length === 0) continue;
    const { result, line, failure } = timingVerdict(name, group, maxTimeGrowth);
    report.timing.groups[name] = result;
    console.log(line);
    if (failure !== null) {
      failed = true;
      report.failures.push(failure);
      report.globalFailures.push(failure);
    }
  }
}

// The self program is the baseline's compiler source (the programs come
// from one checkout), so a change that adds compiler code the self-hosted
// frontend cannot lower would pass unnoticed. The candidate's own compiler
// source must still build with the candidate (LLVM only, not compared).
if (checkCandidateSelf) {
  const result = await (earlyCandidateSelf ?? buildCandidateSelf());
  report.candidateSelf = result.ok
    ? { ok: true, buildMs: result.ms }
    : { ok: false, error: result.error };
  console.log(
    result.ok
      ? `self       candidate compiler source builds with the candidate (${fmtMs(result.ms)})`
      : `self       candidate compiler source FAILS to build with the candidate`,
  );
  if (!result.ok) {
    failed = true;
    report.failures.push(`self/candidate-source: ${result.error.split("\n")[0]}`);
  }
}

const counts = {};
for (const p of report.programs) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
if (!report.programs.some((p) => ["identical", "allowed", "differs"].includes(p.verdict))) {
  failed = true;
  const failure = "no program built with both checkouts, so nothing was compared";
  report.failures.push(failure);
  report.globalFailures.push(failure);
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
    .join(", ")} in ${fmtMs(report.elapsedMs)}` +
    (report.baselineCache ? ` (${report.baselineCache.used} baselines from the cache)` : ""),
);
for (const failure of report.failures) console.log(`  ${failure}`);
process.exit(failed ? 1 : 0);
