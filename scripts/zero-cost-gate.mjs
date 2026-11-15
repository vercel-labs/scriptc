/* Zero-cost gate: prove that a compiler change leaves good code untouched.
 *
 * Compiles a fixed good-code set with a baseline and a candidate checkout and
 * compares IR, LLVM and release executables byte for byte, plus compile time
 * and binary size, and optionally per-function cachegrind instruction counts.
 * Both checkouts compile the same program files (from --programs, default the
 * baseline), so program paths embedded in artifacts match; checkout paths and
 * timestamps do not reach the artifacts. Builds bypass the native cache. A
 * program whose source the change itself rewrites (or adds, or deletes) is
 * built from the candidate checkout's copy with both compilers instead: when
 * the baseline compiler cannot build the new source, or the program is gone,
 * the row is listed as "changed-by-pr" or "removed-by-pr" and does not fail
 * the gate. Any other build error still does.
 *
 * The good-code set: the runtime benchmark workloads (and benchmarks/builds
 * applications), the self-hosted compiler (IR and LLVM), and the TypeScript
 * corpus programs. A program whose sources match --allow (the change's
 * pattern signature) or that --allow-programs lists by id may differ. A
 * program whose IR and LLVM are identical and whose executable differs only
 * through changed runtime objects is "runtime-only", and a difference the
 * baseline reproduces against itself is "nondeterministic": both pass with a
 * note unless --strict. Any other difference fails the gate. */
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
  allowProgramsLines,
  allowProgramsSummary,
  artifactHash,
  cachedComparison,
  cachegrindCounts,
  changedFunctions,
  compareArtifact,
  compareCounts,
  compareExecutables,
  confinedToRuntime,
  DYNAMIC_WORKLOADS,
  definedFunctionNames,
  elfPrivateConstants,
  linkedRuntimeFiles,
  objectFunctionHashes,
  median,
  nmOutput,
  pairPrograms,
  parseAllowPrograms,
  parseNm,
  changedProgram,
  programChange,
  programInputsHash,
  programLines,
  programVerdict,
  recordedBaseline,
  runtimePackDiff,
  symbolCheck,
  timingGroups,
  timingVerdict,
} from "./zero-cost-compare.mjs";
import {
  budgetVerdict,
  dynamicClassesEnv,
  dynamicClassReport,
  HEAP_PROBE_FLAGS,
  heapLimitMb,
  judgesSelfCompile,
  llvmFacts,
  outputGrowthAllowance,
  outputGrowthVerdict,
  programInputs,
  readBudget,
  SELF_ENTRY,
  selfCompileTrace,
  sourceBytes,
  sourceCostAllowance,
  sourceCostVerdict,
} from "./self-compile-budget.mjs";

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
    "allow-programs": { type: "string" },
    list: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    "timing-runs": { type: "string" },
    "self-timing-runs": { type: "string", default: "0" },
    "fixture-timing-runs": { type: "string", default: "1" },
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
       [--allow-programs=<file>] [--list] [--strict] [--timing-runs=N]
       [--self-timing-runs=N]
       [--fixture-timing-runs=N] [--max-time-growth=2] [--max-size-growth=0]
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
files match it may differ (reported as "allowed").
--allow-programs=<file> names the programs that may differ by id instead:
one id per line as the gate prints it (corpus/..., bench/..., self/cli,
fixture/...); blank lines and lines that start with # are skipped. A listed
program is allowed as if --allow matched it, and both options may be given.
An id that names no program of the good-code set (of any --set and --corpus,
before --only and --shard) is an error, so a stale list fails instead of
passing. The summary counts the listed programs that differ and names the
ones that are identical, which the list need not name.
--list prints the ids of the programs the run would compare, one per line,
and exits without building; with --allow-programs it checks the list first.

A corpus or benchmark program the change itself rewrites or deletes is built
from the candidate checkout's copy by both compilers, so a PR that replaces a
program is not judged against the baseline's old copy. A program the baseline
compiler cannot build, or one that only the baseline has, is reported as
"changed-by-pr" or "removed-by-pr" and does not fail the gate; so is a program
only the candidate adds, when the baseline compiler cannot build it. Other
build errors still fail.

Other differences are classified:
  runtime-only      IR and LLVM identical; the executable differs only
                    through runtime objects that differ between the two
                    checkouts' runtime packs (every symbol the executable
                    gains, loses or resizes is defined by one of them), with
                    the same LLVM helper. Reported with the changed runtime
                    functions it links and its size change.
  nondeterministic  the baseline, building the program a second time,
                    differs from its own first build in the same artifacts.
  differs           anything else, in IR, LLVM or the executable.
"differs" fails the gate. runtime-only and nondeterministic pass with a
note; --strict fails them too, so any difference fails as before.

--timing-runs=N (default 5) times N paired --emit=llvm builds per bench
program, baseline and candidate side by side. The self-hosted compiler's
and the self-hosting fixtures' comparison builds are their first pairs;
--self-timing-runs and --fixture-timing-runs add more. The gate fails when
the 95% bootstrap interval of the bench geomean ratio, of the self-hosted
ratio, or of the fixture ratio lies entirely above --max-time-growth
percent; an interval that straddles it is reported as inconclusive.

The fixtures are the largest modules the compiler lowers: the complete LLVM
emitter and the complete layout emitter, each importing most of the backend.
A pass whose cost follows the module's node count rather than the program's
own work shows up there at a size the bench and corpus programs never reach.
--max-size-growth bounds executable growth (percent) of allowed programs.

The self-compile budget: the compared builds compile the baseline's compiler
source, so they cannot see what a change's own source costs. The candidate's
source built with the candidate is judged against the candidate's
scripts/self-compile-budget.json: the whole-program lowering passes it takes
(exact), the heap it holds at the end of a pass per source byte and the share
of the heap limit that fills, and its compile time against the same
compiler's build of the baseline's source in this run, beyond the growth of
the source. A change that means to move one of them edits the budget file
and states the reason there (scripts/self-compile-budget.mjs describes each
entry).

Dynamic-tier symbols (two-tier invariant I3): no executable may gain
symbols under DYNAMIC_TIER_PREFIXES (scripts/zero-cost-compare.mjs) unless
it is allowed, and fully typed bench workloads (all but
DYNAMIC_WORKLOADS in scripts/zero-cost-compare.mjs) may define none.
Likewise no executable may gain Node island symbols or symbols of the ICU
archive unless it is allowed; a program that links them on both sides
gained nothing.

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

Exit status: 0 when the gate passes, 1 when it fails, 2 when the arguments
are wrong, which includes an --allow-programs id that names no program.`);
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
const fixtureTimingRuns = Number(values["fixture-timing-runs"]);
const maxTimeGrowth = Number(values["max-time-growth"]) / 100;
const maxSizeGrowth = Number(values["max-size-growth"]) / 100;
const jobs = Number(values.jobs);
assert.ok(Number.isInteger(timingRuns) && timingRuns >= 0, "--timing-runs must be >= 0");
assert.ok(Number.isInteger(jobs) && jobs >= 1, "--jobs must be >= 1");
assert.ok(["ts", "all"].includes(values.corpus), "--corpus must be ts or all");
const only = values.only ? new RegExp(values.only) : null;
const allow = values.allow ? new RegExp(values.allow, "m") : null;
const allowPrograms =
  values["allow-programs"] === undefined
    ? null
    : parseAllowPrograms(readFileSync(values["allow-programs"], "utf8"));
if (values.cachegrind)
  assert.equal(
    spawnSync("valgrind", ["--version"]).status,
    0,
    "--cachegrind needs valgrind on PATH",
  );

const work = mkdtempSync("/tmp/scriptc-zero-cost-");

/* ── the good-code set ─────────────────────────────────────────────────── */

/** The self-hosting emitter fixtures under tests/fixtures/self-hosting,
 * compiled and timed beside the self-hosted compiler. Each is a complete
 * emitter over most of the compiler, so a compile costs a minute or more:
 * the gate times its comparison build plus --fixture-timing-runs more pairs. */
const FIXTURE_PROGRAMS = ["llvm-emitter", "llvm-layouts"];

/** Whether a bench workload is a program with Node islands. */
const islandWorkload = (w) => (w?.requires ?? []).includes("libnode");

/** Every program of the good-code set of the checkout `root`: all three
 * sets, and every corpus entry whatever its language. `--set`, `--corpus`,
 * `--only` and `--shard` select from it (`selectedPrograms`);
 * --allow-programs may name any of it. A --programs directory need only hold
 * the sets the run selects (`selected`); the other compared checkout
 * contributes what it has. */
function programSet(root, selected = true) {
  const programs = [];
  const suite = join(root, "benchmarks/runtime");
  const seen = new Set();
  for (const w of (selected && sets.has("bench")) || existsSync(suite)
    ? readWorkloads(suite)
    : []) {
    const entry = join(suite, w.entry);
    if (seen.has(entry)) continue;
    seen.add(entry);
    programs.push({ id: `bench/${w.name}`, set: "bench", entry, kind: "exe", workload: w });
  }
  programs.push({
    id: "self/cli",
    set: "self",
    entry: join(root, SELF_ENTRY),
    kind: "source",
  });
  // The self-hosting emitter fixtures lower the whole emitter over the
  // compiler's complete IR surface. They are the timed programs that show a
  // pass whose cost follows the module's size (the fs Buffer brand scan of
  // #2636 spent most of a compile in one walk and left the IR unchanged).
  for (const name of FIXTURE_PROGRAMS)
    programs.push({
      id: `fixture/${name}`,
      set: "self",
      entry: join(root, "tests/fixtures/self-hosting", `${name}.ts`),
      kind: "fixture",
    });
  const corpus = join(root, "tests/corpus");
  // A directory's entry is its main.ts, or without one its first JavaScript
  // main; --corpus=ts keeps the TypeScript entries.
  const exts = ["ts", "js", "mjs", "cjs"];
  const listed = (selected && sets.has("corpus")) || existsSync(corpus);
  for (const name of listed ? readdirSync(corpus).sort() : []) {
    const path = join(corpus, name);
    let entry = null;
    if (statSync(path).isDirectory())
      entry = exts.map((ext) => join(path, `main.${ext}`)).find((p) => existsSync(p)) ?? null;
    else if (exts.some((ext) => name.endsWith(`.${ext}`))) entry = path;
    if (entry !== null)
      programs.push({ id: `corpus/${relative(corpus, entry)}`, set: "corpus", entry, kind: "exe" });
  }
  return programs;
}

/** The whole good-code set. A program the other compared checkout alone has
 * is added, so a change that adds a corpus program compares it too, and an
 * --allow-programs list may name it. Each program carries what either
 * compared checkout holds under its id (`sides`), which changeOf reads. */
function goodCodeSet() {
  const own = programSet(programsRoot);
  if (counterpartRoot === null) return own;
  return pairPrograms(own, programSet(counterpartRoot, false)).map(({ own, counterpart }) => ({
    ...(own ?? counterpart),
    sides:
      programsRoot === trees.baseline
        ? { baseline: own, candidate: counterpart }
        : { baseline: counterpart, candidate: own },
  }));
}

/** The optimization level a program's source names: a corpus entry's head
 * may ask for speed; every other program builds at release. */
function optimizationOf(program) {
  if (program.set !== "corpus") return program.optimization;
  const head = readFileSync(program.entry, "utf8").split("\n", 2);
  const speed = head.some((line) => /^\/\/ @optimization:\s*speed\s*$/.test(line));
  return speed ? "speed" : "release";
}

/** The programs this run compares. A workload with Node islands builds only
 * where a libnode pack is (benchmarks/runtime/README.md, "requires"); without
 * one it is left out on both sides, as the island programs of the corpus
 * are. */
function selectedPrograms(all) {
  const selected = all
    .filter((p) => sets.has(p.set))
    .filter((p) => !islandWorkload(p.workload) || Boolean(process.env.SCRIPTC_LIBNODE))
    .filter((p) => p.set !== "corpus" || values.corpus === "all" || p.entry.endsWith(".ts"))
    .filter((p) => only === null || only.test(p.id));
  for (const program of selected) program.optimization = optimizationOf(program);
  if (!values.shard) return selected;
  const [index, count] = values.shard.split("/").map(Number);
  assert.ok(
    Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count,
    "--shard must be i/n with 1 <= i <= n",
  );
  // The self program and the fixtures take minutes and pair their own
  // timing: shard 1 owns them.
  const heavy = selected.filter((p) => p.kind !== "exe");
  const rest = selected.filter((p) => p.kind === "exe");
  return [...(index === 1 ? heavy : []), ...rest.filter((_, k) => k % count === index - 1)];
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

/** Every build runs with the heap limit of the gate's own checkout (the self-compile budget's).
 * `trace` adds what the budget reads: the phase timing lines, the heap at each pass's end, and
 * the report on the classes the built checkout's budget keeps out of the dynamic tier. */
const heapLimit = heapLimitMb(readBudget(repoRoot));
function compile(tree, args, trace = false) {
  return exec(
    process.execPath,
    [
      `--max-old-space-size=${heapLimit}`,
      ...(trace ? HEAP_PROBE_FLAGS : []),
      join(tree, "packages/cli/dist/bootstrap.js"),
      "build",
      ...args,
    ],
    {
      cwd: programsRoot,
      env: trace
        ? { ...buildEnv(), SCRIPTC_TIMING: "1", ...dynamicClassesEnv(readBudget(tree)) }
        : buildEnv(),
    },
  );
}

/** Build one program with one checkout. Executable programs build once,
 * keeping the LLVM and IR beside the release executable. The self-hosted
 * compiler and the self-hosting fixtures emit LLVM only: each of their
 * frontend runs takes minutes, and their LLVM names the first differing
 * function as well as their IR would. */
async function buildProgram(program, label, tree = trees[label], trace = false) {
  const dir = join(work, label, program.id.replace(/[^\w.-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const failure = (result) => ({
    ok: false,
    error: (result.stderr || result.stdout || `exit ${result.status ?? result.signal}`)
      .replaceAll(dir, "<out>")
      .trim()
      .slice(0, 4000),
  });
  if (program.kind === "source" || program.kind === "fixture") {
    const llvm = join(dir, "program.ll");
    const result = await compile(tree, [program.entry, "--emit=llvm", "-o", llvm], trace);
    if (result.status !== 0) return failure(result);
    return {
      ok: true,
      dir,
      llvm,
      ms: result.ms,
      ...(trace
        ? {
            trace: selfCompileTrace(result.stderr),
            dynamicClasses: dynamicClassReport(result.stderr),
          }
        : {}),
    };
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

/** The symbol check (two-tier invariant I3, the Node island runtime and the
 * ICU archive). No executable may gain dynamic-tier, Node island or ICU
 * symbols over the baseline (unless the program is allowed); a fully typed
 * bench workload may contain no dynamic-tier symbol at all. The island
 * workloads are the programs that call into Node.js, so the Node island rule
 * does not apply to them. An identical executable gained nothing, so only a
 * typed one is read. */
function dynamicTierCheck(program, baseline, candidate, artifacts, allowed) {
  if (!baseline.exe || !artifacts.exe) return null;
  const island = islandWorkload(program.workload);
  const typed = program.id.startsWith("bench/") && !DYNAMIC_WORKLOADS.has(program.id) && !island;
  if (artifacts.exe.identical && !typed) return null;
  const after = definedFunctions(candidate.exe);
  return symbolCheck({
    typed,
    allowed,
    island,
    baseline: artifacts.exe.identical ? after : definedFunctions(baseline.exe),
    candidate: after,
  });
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

/* ── runtime changes ───────────────────────────────────────────────────── */

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** llvm-objdump from PATH or the pinned LLVM install, or null. */
function llvmObjdump() {
  for (const candidate of ["llvm-objdump", "llvm-objdump-22", "/usr/lib/llvm-22/bin/llvm-objdump"])
    if (spawnSync(candidate, ["--version"]).status === 0) return candidate;
  const config = spawnSync("llvm-config", ["--bindir"], { encoding: "utf8" });
  const fromConfig = config.status === 0 ? join(config.stdout.trim(), "llvm-objdump") : null;
  return fromConfig !== null && existsSync(fromConfig) ? fromConfig : null;
}

/** What differs between the two checkouts' runtime packs for this host, or
 * null when no object or archive does: the changed pack files, whether the
 * LLVM helper is the same, the symbols the changed objects define (on either
 * side), and the functions whose code changed in the changed release and
 * speed objects (their instructions, the symbols those name, or the private
 * constants they read). Bitcode, which packs built before 0.4.7 also list,
 * is not a change: it records the checkout's source path, so it differs
 * between any two checkouts. */
function runtimeChanges() {
  const pack = (root) =>
    readdirSync(join(root, "packages"))
      .filter((name) => name.startsWith("runtime-"))
      .filter((name) => existsSync(join(root, "packages", name, "runtime-pack.json")));
  const shared = pack(trees.candidate).filter((name) => pack(trees.baseline).includes(name));
  if (shared.length !== 1) return null;
  const packDir = (root) => join(root, "packages", shared[0]);
  const manifest = (root) =>
    JSON.parse(readFileSync(join(packDir(root), "runtime-pack.json"), "utf8"));
  const linked = (paths) => paths.filter((path) => !path.endsWith(".bc"));
  const all = runtimePackDiff(manifest(trees.baseline), manifest(trees.candidate));
  const diff = {
    changed: linked(all.changed),
    added: linked(all.added),
    removed: linked(all.removed),
  };
  if (diff.changed.length + diff.added.length + diff.removed.length === 0) return null;
  const helper = (root) => {
    const file = join(
      root,
      "packages",
      shared[0].replace(/^runtime-/, "llvm-"),
      "bin/scriptc-llvm-codegen",
    );
    return existsSync(file) ? sha256(file) : null;
  };
  const helperSame =
    helper(trees.baseline) !== null && helper(trees.baseline) === helper(trees.candidate);
  const symbols = new Set();
  const objects = [...diff.changed, ...diff.added, ...diff.removed].filter((path) =>
    path.endsWith(".o"),
  );
  for (const path of linkedRuntimeFiles(diff))
    for (const root of [trees.baseline, trees.candidate]) {
      const file = join(packDir(root), path);
      if (!existsSync(file)) continue;
      const listed = spawnSync("nm", ["--defined-only", file], {
        encoding: "utf8",
        maxBuffer: 1 << 28,
      });
      for (const symbol of parseNm(listed.stdout ?? "")) symbols.add(symbol.name);
    }
  // Changed functions, by unit, from the disassembly of the release and
  // speed flavors' objects (the ones the gate builds with).
  const dis = llvmObjdump();
  const functions = { changed: new Set(), added: new Set(), removed: new Set(), units: new Set() };
  for (const object of objects)
    functions.units.add(object.replace(/^.*\//, "").replace(/\.o$/, ".c"));
  for (const path of objects.filter((path) => /^artifacts\/(release|speed)\//.test(path))) {
    if (dis === null) continue;
    const text = (root) => {
      const file = join(packDir(root), path);
      if (!existsSync(file)) return new Map();
      const out = spawnSync(dis, ["-d", "-r", "--no-show-raw-insn", "--no-leading-addr", file], {
        encoding: "utf8",
        maxBuffer: 1 << 30,
      });
      return objectFunctionHashes(out.stdout ?? "", elfPrivateConstants(readFileSync(file)));
    };
    const delta = changedFunctions(text(trees.baseline), text(trees.candidate));
    for (const kind of ["changed", "added", "removed"])
      for (const name of delta[kind]) functions[kind].add(name);
  }
  return {
    pack: shared[0],
    diff,
    helperSame,
    symbols,
    disassembler: dis,
    functions: Object.fromEntries(
      Object.entries(functions).map(([kind, names]) => [kind, [...names].sort()]),
    ),
  };
}

/** The changed runtime functions an executable defines. */
function linkedRuntimeChanges(runtime, binary) {
  const defined = new Set(definedFunctions(binary));
  const pick = (names) => names.filter((name) => defined.has(name));
  return {
    changed: pick(runtime.functions.changed),
    added: pick(runtime.functions.added),
  };
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
    program.kind === "exe" ? (program.optimization ?? "release") : "source",
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

/* ── programs the change rewrites or deletes ───────────────────────────── */

/** The checkout whose copy of a program the change rewrites, or null when
 * --programs is not one of the compared checkouts. A baseline record is made
 * from one checkout's own programs, so it takes no part. */
const counterpartRoot =
  recordPath !== undefined
    ? null
    : programsRoot === trees.baseline
      ? trees.candidate
      : programsRoot === trees.candidate
        ? trees.baseline
        : null;

/** The files the checkout `root`'s `program` reads, keyed by their path
 * relative to `root` and hashed, or null when the checkout has no such
 * program or its entry is absent. */
function sourceSet(root, program) {
  if (program === null || !existsSync(program.entry)) return null;
  const files = new Map();
  for (const file of programInputs(program.entry))
    files.set(relative(root, file), createHash("sha1").update(readFileSync(file)).digest("hex"));
  return { entry: relative(root, program.entry), files };
}

/** What the change does to a program, from what each checkout holds under
 * its id (programChange). Only executable programs take part: the self
 * program and the emitter fixtures ARE the baseline compiler's own source,
 * which every compiler change edits by design. */
function changeOf({ baseline, candidate }) {
  return programChange(sourceSet(trees.baseline, baseline), sourceSet(trees.candidate, candidate));
}

/** Write `text` to `stream` and exit with `status` once it is written. A pipe
 * can take a write asynchronously, and `process.exit` drops what is still
 * queued, so a driver that captures the output would read part of it. The
 * promise never settles: awaiting it holds the script here until the exit. */
const writeAndExit = (stream, text, status) =>
  new Promise(() => stream.write(text, () => process.exit(status)));

const goodCode = goodCodeSet();
if (allowPrograms !== null) {
  // A list that names a program the good-code set does not have is stale:
  // the program was renamed or removed, or the id is misspelled.
  const known = new Set(goodCode.map((p) => p.id));
  const unknown = allowPrograms.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    rmSync(work, { recursive: true, force: true });
    await writeAndExit(
      process.stderr,
      `--allow-programs ${values["allow-programs"]}: ${unknown.length} of ${allowPrograms.length} ` +
        `listed ids name no program of the good-code set in ${programsRoot}:\n` +
        unknown.map((id) => `  ${id}\n`).join(""),
      2,
    );
  }
}
const listedPrograms = new Set(allowPrograms ?? []);
const programs = selectedPrograms(goodCode).filter(
  (p) => recordPath === undefined || p.kind === "exe",
);
assert.ok(programs.length > 0, "the selected good-code set is empty");
if (values.list) {
  rmSync(work, { recursive: true, force: true });
  await writeAndExit(process.stdout, programs.map((program) => `${program.id}\n`).join(""), 0);
}
if (recordPath === undefined)
  for (const program of programs) {
    if (program.kind !== "exe" || program.sides === undefined) continue;
    const change = changeOf(program.sides);
    if (change === undefined) continue;
    program.pr = change;
    // Both compilers build the program the change provides: its source, at
    // the optimization level that source names, run with its arguments.
    if (change !== "removed") {
      const candidate = program.sides.candidate;
      Object.assign(
        program,
        changedProgram({ ...candidate, optimization: optimizationOf(candidate) }),
      );
    }
  }
const runtime = recordPath === undefined ? runtimeChanges() : null;
const report = {
  schema: 1,
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  trees: Object.fromEntries(
    Object.entries(trees).map(([label, root]) => [label, { root, revision: revision(root) }]),
  ),
  programsRoot,
  allow: values.allow ?? null,
  allowPrograms:
    allowPrograms === null ? null : { file: values["allow-programs"], ids: allowPrograms },
  strict: values.strict,
  runtime:
    runtime === null
      ? null
      : {
          pack: runtime.pack,
          ...runtime.diff,
          helperSame: runtime.helperSame,
          functions: runtime.functions,
        },
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
if (runtime !== null) {
  const { changed, added, removed } = runtime.diff;
  console.log(
    `runtime pack ${runtime.pack} differs: ${changed.length} changed, ${added.length} added, ` +
      `${removed.length} removed files; units ${runtime.functions.units.join(", ") || "none"}` +
      (runtime.helperSame ? "" : "; the LLVM helper differs too, so nothing is runtime-only"),
  );
  if (runtime.disassembler === null)
    console.log("runtime functions: llvm-objdump not found, so changed functions are not listed");
  else
    console.log(
      `runtime functions: ${runtime.functions.changed.length} changed` +
        (runtime.functions.changed.length
          ? ` (${runtime.functions.changed.slice(0, 20).join(", ")})`
          : "") +
        `, ${runtime.functions.added.length} added, ${runtime.functions.removed.length} removed`,
    );
}

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
const checkCandidateSelf = judgesSelfCompile(sets, programs);
/** llvmFacts of the baseline's compiler source built by the candidate, once that build is in. */
let pairedSelfLlvm = null;
const candidateSelfProgram = {
  id: "self/candidate-source",
  entry: join(trees.candidate, SELF_ENTRY),
  kind: "source",
};
const buildCandidateSelf = () =>
  buildProgram(candidateSelfProgram, "candidate", trees.candidate, true);
const earlyCandidateSelf =
  checkCandidateSelf && totalmem() >= 40 * 1024 ** 3 ? buildCandidateSelf() : null;

await pool(
  programs.map((program) => ({
    heavy: program.kind !== "exe",
    run: async () => {
      if (program.pr === "removed") {
        const entry = { id: program.id, verdict: "removed-by-pr", allowed: false, artifacts: {} };
        printProgram(entry);
        report.programs.push(entry);
        return;
      }
      const recorded =
        // A program the change rewrites has no recorded baseline: the record
        // holds the old source's artifacts.
        program.pr !== undefined || program.kind !== "exe" || baselineCache === null
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
        listedPrograms.has(program.id) ||
        (allow !== null &&
          programInputs(program.entry).some((f) => allow.test(readFileSync(f, "utf8"))));
      const artifacts =
        settled?.artifacts ??
        (baseline.ok && candidate.ok ? compareBuilds(baseline, candidate) : {});
      // The benchmark workloads and the self-hosted compiler always build.
      const required = !program.id.startsWith("corpus/");
      const runtimeOnly =
        runtime !== null &&
        runtime.helperSame &&
        artifacts.exe !== undefined &&
        !artifacts.exe.identical &&
        confinedToRuntime(artifacts.exe, runtime.symbols);
      const judge = (nondeterministic) =>
        programVerdict({
          baseline,
          candidate,
          artifacts,
          allowed,
          required,
          runtimeOnly,
          nondeterministic,
          strict: values.strict,
          // Both compilers built the change's own source.
          changedSource: program.pr !== undefined,
        });
      let { verdict, fails } = judge([]);
      // Build a difference the change cannot explain once more with the
      // baseline: when the baseline's two builds differ in the same
      // artifacts, the difference is the build's, not the change's.
      let recheck = null;
      if (verdict === "differs") {
        const again = await buildProgram(program, "recheck", trees.baseline);
        if (again.ok) {
          const self = compareBuilds(baseline, again);
          recheck = Object.keys(artifacts).filter(
            (kind) => !artifacts[kind].identical && !self[kind]?.identical,
          );
          if (again.dir && !values.keep) rmSync(again.dir, { recursive: true, force: true });
        }
        if (recheck?.length) ({ verdict, fails } = judge(recheck));
      }
      const entry = {
        id: program.id,
        verdict,
        allowed,
        buildMs: { baseline: baseline.ms ?? null, candidate: candidate.ms ?? null },
        artifacts,
      };
      if (program.pr !== undefined) entry.pr = program.pr;
      if (verdict === "runtime-only") entry.runtime = linkedRuntimeChanges(runtime, candidate.exe);
      if (verdict === "nondeterministic") entry.nondeterministic = recheck;
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
      // The candidate's build of the baseline's compiler source is what the self-compile
      // budget compares the candidate's own source with; its LLVM is deleted just below.
      if (program.id === "self/cli" && checkCandidateSelf && candidate.llvm)
        pairedSelfLlvm = llvmFacts(candidate.llvm);
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
    if (program.id.startsWith("corpus/") || program.pr === "removed") continue;
    const row = { id: program.id, baselineMs: [], candidateMs: [], ratios: [] };
    const add = (sample) => {
      if (sample === null) return;
      row.baselineMs.push(Math.round(sample[0]));
      row.candidateMs.push(Math.round(sample[1]));
      row.ratios.push(sample[1] / sample[0]);
    };
    const runs =
      program.kind === "source"
        ? selfTimingRuns
        : program.kind === "fixture"
          ? fixtureTimingRuns
          : timingRuns;
    if (program.kind === "source" || program.kind === "fixture") {
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
// source must still build with the candidate (LLVM only; its artifacts are
// not compared, its cost is: the self-compile budget below). With
// --programs=candidate the compared builds compile that source already;
// this build is still made, because it is the one that is traced and held
// to the budget.
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
  } else {
    const budget = await selfCompileBudget(result);
    report.candidateSelf.budget = budget;
    for (const line of budget.lines) console.log(`self       ${line}`);
    if (budget.failures.length > 0) {
      failed = true;
      report.failures.push(...budget.failures);
    }
  }
}

/* The self-compile budget (scripts/self-compile-budget.mjs). The compared
 * builds above compile the baseline's compiler source with both compilers,
 * so they show what a change does to the compiler and are blind to what its
 * own source costs to compile. This judges the third build, the candidate's
 * source with the candidate:
 *   - the whole-program lowering passes it took and its live heap, against
 *     the candidate's scripts/self-compile-budget.json;
 *   - its compile time against the same compiler's build of the baseline's
 *     source in this run, beyond the growth of the source itself. Both ran
 *     on this host, so the host's speed cancels. When the first pair is over
 *     the tolerance the two sources build once more, side by side with
 *     nothing else running, and the smaller ratio is judged. */
async function selfCompileBudget(build) {
  const budget = readBudget(trees.candidate);
  const previous = readBudget(trees.baseline);
  // A candidate without a budget file has nothing judged, so its source is
  // not measured either: the gate also runs over checkouts that hold a
  // compiler and no source (tests/harness/zero-cost-gate.test.ts).
  const bytes = budget === null ? null : sourceBytes(candidateSelfProgram.entry);
  const verdict = budgetVerdict({
    budget,
    previous,
    trace: build.trace,
    bytes,
    dynamicClasses: build.dynamicClasses,
    root: trees.candidate,
  });
  const result = {
    passes: build.trace.passes,
    liveHeapMb: build.trace.liveHeapMb,
    sourceBytes: bytes,
    lines: verdict.lines,
    failures: verdict.failures,
  };
  // The compile-time comparison pairs this build with the same compiler's
  // build of the baseline's source. A run whose programs come from the
  // candidate checkout never builds that source: it judges the passes and
  // the heap, and says that the time was not compared.
  if (programsRoot === trees.candidate) {
    result.lines.push(
      "compile time against the baseline's source: not compared (--programs=candidate builds only the candidate's source)",
    );
    return result;
  }
  const baselineSource = programs.find((p) => p.id === "self/cli");
  const paired = report.programs.find((p) => p.id === "self/cli")?.buildMs.candidate;
  if (budget === null || baselineSource === undefined || !paired) return result;
  const sourceRatio = bytes / sourceBytes(baselineSource.entry);
  // What the two sources compile to, with the candidate compiler: the LLVM of this build and
  // of the compared build of the baseline's source. Exact numbers, so one pair decides.
  if (pairedSelfLlvm !== null) {
    const growth = outputGrowthVerdict({
      candidate: llvmFacts(build.llvm),
      baseline: pairedSelfLlvm,
      sourceRatio,
      allowance: outputGrowthAllowance(budget, previous),
    });
    result.outputGrowth = { worst: growth.worst };
    result.lines.push(...growth.lines);
    result.failures.push(...growth.failures);
  }
  const allowance = sourceCostAllowance(budget, previous);
  const ratios = [build.ms / paired];
  let cost = sourceCostVerdict({ ratios, sourceRatio, allowance });
  if (cost.fails) {
    const again = await Promise.all([
      compile(trees.candidate, [
        baselineSource.entry,
        "--emit=llvm",
        "-o",
        join(work, "source-cost-baseline.ll"),
      ]),
      compile(trees.candidate, [
        candidateSelfProgram.entry,
        "--emit=llvm",
        "-o",
        join(work, "source-cost-candidate.ll"),
      ]),
    ]);
    if (again.every((run) => run.status === 0)) {
      ratios.push(again[1].ms / again[0].ms);
      cost = sourceCostVerdict({ ratios, sourceRatio, allowance });
    }
  }
  result.sourceCost = { ratios, sourceRatio, allowance, ratio: cost.ratio };
  result.lines.push(cost.line);
  if (cost.failure !== null) result.failures.push(cost.failure);
  return result;
}

const counts = {};
for (const p of report.programs) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
const compared = ["identical", "allowed", "runtime-only", "nondeterministic", "differs"];
if (!report.programs.some((p) => compared.includes(p.verdict))) {
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
const noted = report.programs.filter((p) =>
  ["runtime-only", "nondeterministic", "changed-by-pr", "removed-by-pr"].includes(p.verdict),
);
if (allowPrograms !== null)
  for (const line of allowProgramsLines(allowProgramsSummary(allowPrograms, report.programs)))
    console.log(line);
console.log(
  `zero-cost gate: ${failed ? "FAIL" : noted.length ? "PASS with notes" : "PASS"} — ${Object.entries(
    counts,
  )
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")} in ${fmtMs(report.elapsedMs)}` +
    (report.baselineCache ? ` (${report.baselineCache.used} baselines from the cache)` : ""),
);
const runtimeOnlyPrograms = report.programs.filter((p) => p.verdict === "runtime-only");
if (runtimeOnlyPrograms.length > 0) {
  const deltas = runtimeOnlyPrograms.map(
    (p) => p.artifacts.exe.bytes.candidate - p.artifacts.exe.bytes.baseline,
  );
  const signed = (n) => `${n > 0 ? "+" : ""}${n}`;
  const linked = new Set(
    runtimeOnlyPrograms.flatMap((p) => [...p.runtime.changed, ...p.runtime.added]),
  );
  console.log(
    `  note: ${runtimeOnlyPrograms.length} runtime-only programs (IR and LLVM identical); ` +
      `executable size ${signed(Math.min(...deltas))} to ${signed(Math.max(...deltas))} bytes; ` +
      `changed runtime functions linked: ${[...linked].sort().join(", ") || "none listed"}` +
      (values.strict ? "" : " (--strict fails these)"),
  );
}
const nondeterministicPrograms = report.programs.filter((p) => p.verdict === "nondeterministic");
if (nondeterministicPrograms.length > 0)
  console.log(
    `  note: ${nondeterministicPrograms.length} nondeterministic programs, whose baseline rebuild differs too: ` +
      nondeterministicPrograms.map((p) => p.id).join(", "),
  );
const prPrograms = report.programs.filter((p) =>
  ["changed-by-pr", "removed-by-pr"].includes(p.verdict),
);
if (prPrograms.length > 0)
  console.log(
    `  note: ${prPrograms.length} program${prPrograms.length === 1 ? "" : "s"} changed or removed by the PR, ` +
      `judged from the candidate checkout's copy: ` +
      prPrograms
        .map((p) => `${p.id} (${p.verdict === "removed-by-pr" ? "removed" : "changed"})`)
        .join(", "),
  );
await writeAndExit(
  process.stdout,
  report.failures.map((failure) => `  ${failure}\n`).join(""),
  failed ? 1 : 0,
);
